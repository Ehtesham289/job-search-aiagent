import { z } from "zod";
import { env } from "../../config/env.js";
import { CritiqueReport, type Finding } from "../../schemas/tailoring.js";
import type { StructuredResume } from "../../schemas/profile.js";
import type { TailoredResume } from "../../schemas/tailoring.js";
import { buildIndex } from "./evidenceBinding.js";
import { type AgentContext, type AgentInput, type AgentOutput, emptyOutput, escalation } from "../types.js";

/**
 * 2.7 Step 4 - Critic. A separate, adversarial agent.
 *
 * It receives the original resume and the tailored JSON, and NOT the tailoring
 * agent's reasoning. That exclusion is enforced by this function's inputs: the
 * drafter's rationale is never on the blackboard in a form the critic reads.
 * A critic that has been told why an edit is fine will find it fine.
 *
 * Deterministic checks run first and are not negotiable - date drift and
 * invented numerals are cheaper and more reliable to catch in code.
 */
const SYSTEM = `You are reviewing a tailored resume adversarially. Your job is to find
problems, not to be encouraging. A draft you pass will be sent to an employer.

You get the original resume and the tailored version. You do NOT get the
reasoning behind the changes, and you should not ask for it - if a claim needs
an explanation to look honest, it is not honest.

Reject on any of:
- untraceable_claim: anything in the tailored version that the original does not support
- inflated_seniority: "contributed to" became "led", "helped" became "owned", a
  team of 3 became "the team"
- invented_metric: any number, percentage, scale or duration not in the original
- stretched_dates: any date, tenure or overlap that differs from the original
- keyword_stuffing: terms inserted where they do not describe real work, or a
  bullet that reads as a list of technologies rather than a piece of work
- ats_structure: missing standard sections, a summary that is a wall of keywords,
  bullets that are paragraphs
- tone: register that does not match the original candidate's voice (warn, not reject)

For each finding give the offending quote verbatim, its location in the tailored
JSON (e.g. experience[1].bullets[0]), and what is wrong. severity "reject" blocks
the draft; "warn" does not.

verdict is "reject" if there is at least one reject-severity finding, otherwise "pass".
Passing a clean draft is correct. Do not invent findings to look thorough.`;

const ModelCritique = z.object({
  verdict: z.enum(["pass", "reject"]),
  findings: z.array(
    z.object({
      category: z.enum([
        "untraceable_claim",
        "inflated_seniority",
        "invented_metric",
        "stretched_dates",
        "keyword_stuffing",
        "ats_structure",
        "tone",
      ]),
      severity: z.enum(["reject", "warn"]),
      quote: z.string(),
      explanation: z.string(),
      location: z.string(),
      suggested_fix: z.string().nullable(),
    }),
  ),
  confidence: z.number().min(0).max(1),
});

export async function critic(ctx: AgentContext, input: AgentInput): Promise<AgentOutput> {
  const out = emptyOutput();
  const { resume, draft: tailored } = input.board;
  if (!resume || !tailored) {
    out.summary = "critic needs an original resume and a draft";
    out.degraded = "missing inputs";
    return out;
  }

  // Code-level checks first. These do not need a model and must not depend on
  // one agreeing with them.
  const mechanical = mechanicalFindings(resume, tailored);

  const res = await ctx.llm.structured({
    agent: "critic",
    tier: "strong",
    systemPrompt: SYSTEM,
    // Only the original and the draft. No edit plan, no bindings, no rationale.
    input: [
      "ORIGINAL RESUME",
      JSON.stringify(stripIds(resume), null, 1),
      "",
      "TAILORED RESUME",
      JSON.stringify(tailored, null, 1),
    ].join("\n"),
    schema: ModelCritique,
    schemaName: "critique_report",
    maxTokens: 6000,
    effort: "high",
    signal: ctx.signal,
  });
  out.usage = res.usage;
  out.model = res.model;
  out.llmCalls = 1;
  out.attempts = res.attempts;
  out.validationFailures = res.validationFailures;

  const findings: Finding[] = [...mechanical, ...res.value.findings];
  const rejected = findings.some((f) => f.severity === "reject");
  const report = CritiqueReport.parse({
    verdict: rejected ? "reject" : "pass",
    findings,
    confidence: res.value.confidence,
  });

  out.board = { critiques: [report] };

  const cycles = input.board.revision;
  if (report.verdict === "reject" && cycles >= env.maxRevisionCycles) {
    // Hard cap reached. Never ship an unreviewed draft, and never let the loop
    // run unbounded - escalate with the specific unresolved items.
    //
    // `revertRejected` below is the repair this question offers, applied when
    // the user answers "Keep the original wording". It is deliberately not
    // applied automatically: choosing to drop a claim from your own résumé is
    // the candidate's call, not the critic's.
    out.escalations.push(
      escalation(input.node.id, "critic", {
        question:
          `After ${cycles} revisions these problems are still in the draft:\n` +
          report.findings
            .filter((f) => f.severity === "reject")
            .map((f) => `  - ${f.location}: ${f.explanation} ("${f.quote}")`)
            .join("\n") +
          `\nShould I keep the original wording for these, or can you tell me what actually happened?`,
        kind: "unresolved_critique",
        context: { findings: report.findings.filter((f) => f.severity === "reject") },
        options: ["Keep the original wording", "I'll clarify"],
        blocking: true,
      }),
    );
  }

  out.summary =
    `${report.verdict}: ${findings.filter((f) => f.severity === "reject").length} rejections, ` +
    `${findings.filter((f) => f.severity === "warn").length} warnings` +
    (mechanical.length ? ` (${mechanical.length} caught deterministically)` : "");
  return out;
}

/**
 * Checks that do not need judgment. Numerals and dates are exactly where a
 * fabrication is both most damaging and most mechanically detectable.
 */
export function mechanicalFindings(original: StructuredResume, tailored: TailoredResume): Finding[] {
  const findings: Finding[] = [];
  const index = buildIndex(original);
  const originalText = [...index.byId.values()].join(" ");
  const originalNumbers = new Set(extractNumbers(originalText));

  tailored.experience.forEach((exp, i) => {
    const source = original.experience.find((e) => e.id === exp.id || e.company === exp.company);

    if (source) {
      if (normalizeDate(source.start) !== normalizeDate(exp.start) || normalizeDate(source.end) !== normalizeDate(exp.end)) {
        findings.push({
          category: "stretched_dates",
          severity: "reject",
          quote: `${exp.start} - ${exp.end}`,
          explanation: `dates differ from the original (${source.start} - ${source.end})`,
          location: `experience[${i}]`,
          suggested_fix: `restore ${source.start} - ${source.end}`,
        });
      }
      if (source.title !== exp.title) {
        findings.push({
          category: "inflated_seniority",
          severity: "reject",
          quote: exp.title,
          explanation: `job title changed from "${source.title}"`,
          location: `experience[${i}].title`,
          suggested_fix: `restore "${source.title}"`,
        });
      }
    }

    exp.bullets.forEach((bullet, b) => {
      for (const n of extractNumbers(bullet)) {
        if (!originalNumbers.has(n)) {
          findings.push({
            category: "invented_metric",
            severity: "reject",
            quote: bullet,
            explanation: `the figure "${n}" does not appear anywhere in the original resume`,
            location: `experience[${i}].bullets[${b}]`,
            suggested_fix: "remove the figure or restore the original phrasing",
          });
        }
      }
      // A bullet that is mostly comma-separated fragments is a keyword list.
      const commaRatio = (bullet.match(/,/g)?.length ?? 0) / Math.max(1, bullet.split(/\s+/).length);
      if (commaRatio > 0.25 && bullet.split(/\s+/).length > 8) {
        findings.push({
          category: "keyword_stuffing",
          severity: "warn",
          quote: bullet,
          explanation: "reads as a list of technologies rather than a piece of work",
          location: `experience[${i}].bullets[${b}]`,
          suggested_fix: "state what was built and name the tools inside the sentence",
        });
      }
    });
  });

  if (tailored.experience.length < original.experience.length) {
    findings.push({
      category: "ats_structure",
      severity: "reject",
      quote: `${tailored.experience.length} roles`,
      explanation: `the original has ${original.experience.length} roles; dropping employment history creates unexplained gaps`,
      location: "experience",
      suggested_fix: "restore the missing roles, shortened rather than removed",
    });
  }

  const summaryWords = tailored.summary.split(/\s+/).length;
  if (summaryWords > 90) {
    findings.push({
      category: "ats_structure",
      severity: "warn",
      quote: `${summaryWords} words`,
      explanation: "summary is long enough that a recruiter will skip it",
      location: "summary",
      suggested_fix: "cut to three or four sentences",
    });
  }

  return findings;
}

/**
 * Percentages, magnitudes and large counts - the shapes a fabricated metric
 * takes. Deliberately three narrow passes rather than one clever regex: a
 * single alternation with a trailing word boundary silently fails on "40%."
 * because neither side of the boundary is a word character.
 */
export function extractNumbers(text: string): string[] {
  const out = new Set<string>();

  for (const m of text.matchAll(/(\d[\d,._]*)\s*(?:%|\bpercent\b)/gi)) {
    out.add(`${clean(m[1]!)}%`);
  }
  for (const m of text.matchAll(/(\d[\d,._]*)\s*(k|m|bn|x|million|billion)\b/gi)) {
    out.add(`${clean(m[1]!)}${m[2]!.toLowerCase()}`);
  }
  // Bare numbers only from three digits up: "4 years" and "a team of 3" are
  // ordinary prose, and flagging them would bury the real findings.
  for (const m of text.matchAll(/\b(\d[\d,._]{2,})\b/g)) {
    out.add(clean(m[1]!));
  }

  return [...out];
}

function clean(n: string): string {
  return n.replace(/[,_]/g, "");
}

function normalizeDate(d: string): string {
  return d.trim().toLowerCase().replace(/\s+/g, "");
}

/** The critic compares content, not our internal identifiers. */
function stripIds(resume: StructuredResume) {
  return {
    summary: resume.summary,
    skills: resume.skills,
    experience: resume.experience.map((e) => ({
      company: e.company,
      title: e.title,
      location: e.location,
      start: e.start,
      end: e.end,
      bullets: e.bullets.map((b) => b.text),
    })),
    projects: resume.projects.map((p) => ({ name: p.name, description: p.description, tech: p.tech })),
    education: resume.education.map((e) => ({ institution: e.institution, degree: e.degree, field: e.field, end: e.end })),
  };
}

/**
 * Removes the rewrites the critic still rejects, and puts the candidate's own
 * words back where that would otherwise empty a role.
 *
 * A finding names the offending text. Tailored bullets are plain strings and
 * `source_ids` is recorded per *role*, not per bullet, so there is no 1:1 line
 * to restore — which is why the rejected bullet is dropped rather than
 * rewritten. Dropping is the safe direction: the claim the critic objected to
 * disappears, and nothing is invented to replace it. If that would leave a role
 * with no bullets at all, the role's original bullets are restored verbatim, so
 * the résumé never ends up with an empty job.
 */
export function revertRejected(
  draft: TailoredResume | null,
  original: StructuredResume | null,
  findings: Finding[],
): { draft: TailoredResume | null; count: number } {
  const rejects = findings.filter((f) => f.severity === "reject" && f.quote.trim().length > 0);
  if (!draft || rejects.length === 0) return { draft, count: 0 };

  const originalById = new Map<string, string>();
  for (const role of original?.experience ?? []) {
    for (const b of role.bullets) originalById.set(b.id, b.text);
  }

  let count = 0;
  const experience = draft.experience.map((role) => {
    const kept = role.bullets.filter((text) => {
      const hit = rejects.some((f) => text.includes(f.quote.trim()) || f.quote.includes(text));
      if (hit) count++;
      return !hit;
    });
    if (kept.length > 0) return { ...role, bullets: kept };
    // Everything in this role was rejected: fall back to what was written
    // originally rather than shipping a job with no content under it.
    const restored = role.source_ids
      .map((id) => originalById.get(id))
      .filter((t): t is string => Boolean(t));
    return { ...role, bullets: restored };
  });

  return { draft: { ...draft, experience }, count };
}
