import { z } from "zod";
import { normalizeGraduation, normalizeMonth } from "../schemas/common.js";
import { ParsedResume, type ProfileSummary, type StructuredResume } from "../schemas/profile.js";
import { env } from "../config/env.js";
import { sha1 } from "../tools/embed.js";
import { type AgentContext, type AgentOutput, emptyOutput, escalation } from "./types.js";

/**
 * Not in the §2 roster, but everything downstream depends on it: the tailoring
 * lane's non-fabrication guarantee is only as good as the source ids assigned
 * here. Ids are minted deterministically in code, never by the model — a model
 * that invents its own ids can invent one for a claim it also invented.
 */
const SYSTEM = `You extract structure from resumes. You are an extractor, not an editor.

Rules:
- Copy text from the resume. Never improve, summarise, infer, or embellish it.
- Bullets keep their original wording verbatim, including any metrics.
- If a field is genuinely absent, use null or an empty array. Do not guess.
- Dates: emit exactly what the resume says (e.g. "Jan 2022", "2022-01", "present").
- skills.primary is what the resume itself emphasises; skills.secondary is the rest.
- Set confidence below 0.6 and list what was unclear in uncertainty_notes whenever
  the layout was ambiguous: merged columns, undated roles, or unclear employer names.
- Leave every id field as an empty string; ids are assigned downstream.`;

const ModelResume = z.object({
  contact: z.object({
    name: z.string(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    location: z.string().nullable(),
    links: z.array(z.object({ label: z.string(), url: z.string() })),
  }),
  summary: z.string().nullable(),
  experience: z.array(
    z.object({
      company: z.string(),
      title: z.string(),
      location: z.string().nullable(),
      start: z.string(),
      end: z.string(),
      bullets: z.array(z.string()),
    }),
  ),
  skills: z.object({ primary: z.array(z.string()), secondary: z.array(z.string()) }),
  education: z.array(
    z.object({
      institution: z.string(),
      degree: z.string(),
      field: z.string().nullable(),
      start: z.string().nullable(),
      end: z.string().nullable(),
      detail: z.string().nullable(),
    }),
  ),
  projects: z.array(
    z.object({ name: z.string(), description: z.string(), tech: z.array(z.string()), url: z.string().nullable() }),
  ),
  certifications: z.array(z.object({ name: z.string(), issuer: z.string().nullable() })),
  confidence: z.number().min(0).max(1),
  uncertainty_notes: z.array(z.string()),
});

export async function parseResume(ctx: AgentContext, rawText: string, nodeId = "resume_parse"): Promise<AgentOutput> {
  const out = emptyOutput();

  const res = await ctx.llm.structured({
    agent: "resume_parser",
    // Extraction, not reasoning — the cheap tier, as §4 prescribes.
    tier: "fast",
    systemPrompt: SYSTEM,
    input: `Resume text:\n\n${rawText.slice(0, 60_000)}`,
    schema: ModelResume,
    schemaName: "structured_resume",
    maxTokens: 8000,
    signal: ctx.signal,
  });
  out.usage = res.usage;
  out.model = res.model;
  out.llmCalls = 1;
  out.attempts = res.attempts;
  out.validationFailures = res.validationFailures;

  const m = res.value;

  // Ids, date normalization and skill canonicalization are all deterministic.
  const resume: StructuredResume = {
    contact: m.contact,
    summary: m.summary,
    experience: m.experience.map((e, i) => ({
      id: `exp_${i + 1}`,
      company: e.company,
      title: e.title,
      location: e.location,
      start: normalizeMonth(e.start) ?? e.start,
      end: normalizeMonth(e.end) ?? e.end,
      bullets: e.bullets.map((text, b) => ({ id: `exp_${i + 1}_b${b + 1}`, text })),
    })),
    // The candidate's own spelling is kept: this text is rendered onto their
    // résumé, and "ms word" is a typo there. Normalization happens at
    // comparison time inside `skillOverlap`, which canonicalises both sides.
    skills: {
      primary: dedupeSkillStrings(m.skills.primary),
      secondary: dedupeSkillStrings(m.skills.secondary).filter(
        (x) => !m.skills.primary.some((p) => p.toLowerCase() === x.toLowerCase()),
      ),
    },
    education: m.education.map((e, i) => ({
      id: `edu_${i + 1}`,
      institution: e.institution,
      degree: e.degree,
      field: e.field,
      start: normalizeGraduation(e.start),
      end: normalizeGraduation(e.end),
      detail: e.detail,
    })),
    projects: m.projects.map((p, i) => ({ id: `prj_${i + 1}`, ...p })),
    certifications: m.certifications.map((c, i) => ({ id: `cert_${i + 1}`, ...c })),
  };

  const parsed = ParsedResume.parse({ ...resume, confidence: m.confidence, uncertainty_notes: m.uncertainty_notes });

  // §4 confidence-gated escalation: below the threshold the agent asks rather
  // than guessing, and the question names the specific ambiguity.
  if (parsed.confidence < env.escalationConfidence || m.uncertainty_notes.length > 0) {
    for (const note of m.uncertainty_notes.slice(0, 3)) {
      out.escalations.push(
        escalation(nodeId, "resume_parser", {
          question: `Your resume was ambiguous here: ${note} Can you confirm what it should say?`,
          kind: "ambiguous_parse",
          context: { note, confidence: parsed.confidence },
          options: [],
          blocking: parsed.confidence < 0.4,
        }),
      );
    }
  }

  out.board = { resume, profile: summarize(resume) };
  out.summary = `parsed ${resume.experience.length} roles, ${resume.experience.reduce((n, e) => n + e.bullets.length, 0)} bullets, ${resume.skills.primary.length + resume.skills.secondary.length} skills (confidence ${parsed.confidence.toFixed(2)}, sha ${sha1(rawText).slice(0, 8)})`;
  return out;
}

/** One spelling per skill, the first one the résumé used. */
function dedupeSkillStrings(xs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    const k = x.trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(x.trim());
  }
  return out;
}

/** Compact view for agents that must not receive the whole resume. */
export function summarize(resume: StructuredResume): ProfileSummary {
  const years = totalYears(resume);
  return {
    canonical_titles: [...new Set(resume.experience.map((e) => e.title))].slice(0, 5),
    total_years: Math.round(years * 10) / 10,
    top_skills: [...resume.skills.primary, ...resume.skills.secondary].slice(0, 20),
    locations: [...new Set(resume.experience.map((e) => e.location).filter((l): l is string => Boolean(l)))],
    seniority_hint: years < 2 ? "junior" : years < 5 ? "mid" : years < 9 ? "senior" : "staff",
  };
}

/** Union of employment intervals, so overlapping roles are not double counted. */
export function totalYears(resume: StructuredResume): number {
  const intervals = resume.experience
    .map((e) => {
      const s = toMonths(e.start);
      const t = /present/i.test(e.end) ? nowMonths() : toMonths(e.end);
      return s !== null && t !== null && t >= s ? ([s, t] as const) : null;
    })
    .filter((x): x is readonly [number, number] => x !== null)
    .sort((a, b) => a[0] - b[0]);

  let months = 0;
  let cursor = -Infinity;
  for (const [s, t] of intervals) {
    const start = Math.max(s, cursor);
    if (t > start) {
      months += t - start;
      cursor = t;
    }
  }
  return months / 12;
}

function toMonths(v: string): number | null {
  const n = normalizeMonth(v);
  if (!n || n === "present") return null;
  const [y, m] = n.split("-");
  return Number(y) * 12 + Number(m) - 1;
}

function nowMonths(): number {
  const d = new Date();
  return d.getFullYear() * 12 + d.getMonth();
}
