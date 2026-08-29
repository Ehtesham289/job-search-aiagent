import { parseResumeHeuristically } from "../tools/parse/resumeHeuristic.js";
import { tokenize } from "../tools/embed.js";
import { TransportError } from "./errors.js";
import type { LlmProvider, ProviderRequest, ProviderResponse } from "./provider.js";

/**
 * Offline provider: deterministic stand-ins for the judgment steps.
 *
 * This exists because the honest alternative — a scripted model that returns a
 * canned answer whatever it is given — produces a *plausible result for
 * somebody else's résumé*, which is worse than no result at all.
 *
 * What it does is real work on the real input: it parses the résumé it is
 * given, derives the search matrix from that résumé, extracts requirements
 * from each posting's own text, and scores from measured skill overlap and
 * embedding similarity. What it does NOT do is write prose. The tailoring
 * lane here reorders and re-emphasises what the candidate already wrote and
 * never rewrites a sentence, because rewriting is the one part of this system
 * that genuinely needs a model.
 *
 * Every reason string it emits cites something it actually measured. It has no
 * way to say "strong candidate" because it has no way to know that.
 */
export class HeuristicProvider implements LlmProvider {
  readonly name = "heuristic";

  async complete(req: ProviderRequest): Promise<ProviderResponse> {
    const value = this.dispatch(req);
    const text = JSON.stringify(value);
    return {
      text,
      model: `heuristic:${req.schemaName}`,
      usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
    };
  }

  private dispatch(req: ProviderRequest): unknown {
    const input = req.turns.map((t) => t.content).join("\n");
    switch (req.schemaName) {
      case "structured_resume":
        return resume(input);
      case "task_graph":
        return taskGraph();
      case "query_plan":
        return queryPlan(input);
      case "jd_analysis":
        return jdAnalysis(input);
      case "rubric_verdict":
        return rubric(input);
      case "edit_plan":
        return editPlan(input);
      case "evidence_bindings":
        return bindings(input);
      case "tailored_resume":
        return tailored(input);
      case "critique_report":
        return critique();
      case "harvest_fallback":
        // Pulling postings out of arbitrary page prose is exactly the kind of
        // extraction a heuristic gets wrong quietly. Decline instead.
        return { jobs: [] };
      default:
        throw new TransportError(
          `offline mode has no heuristic for '${req.schemaName}'. Run with an API key to use this agent.`,
          undefined,
          false,
        );
    }
  }
}

/* ── request parsing ──────────────────────────────────────────────────── */

function after(text: string, marker: string): string {
  const i = text.indexOf(marker);
  return i < 0 ? "" : text.slice(i + marker.length);
}

function field(text: string, label: string): string {
  const re = new RegExp(`^${label}:\\s*(.+)$`, "im");
  return re.exec(text)?.[1]?.trim() ?? "";
}

function num(text: string, label: string): number | null {
  const re = new RegExp(`${label}\\s+(-?[\\d.]+)`, "i");
  const v = re.exec(text)?.[1];
  return v === undefined ? null : Number(v);
}

function listSplit(s: string): string[] {
  return s
    .split(/[,;|]/)
    .map((x) => x.trim())
    .filter((x) => x.length > 1);
}

/* ── résumé ───────────────────────────────────────────────────────────── */

function resume(input: string) {
  const text = after(input, "Resume text:").trim() || input;
  // Only genuine ambiguities go in uncertainty_notes — the caller turns each
  // one into a question for the user, and "I am a heuristic" is a disclosure,
  // not something they can answer.
  return parseResumeHeuristically(text);
}

/* ── plan ─────────────────────────────────────────────────────────────── */

function taskGraph() {
  return {
    nodes: [
      { id: "query", kind: "query_strategy", label: "Expand the brief into a search matrix", depends_on: [], note: null, limit: null, optional: false },
      { id: "discover", kind: "source_discovery", label: "Find and verify new career pages", depends_on: [], note: null, limit: null, optional: true },
      { id: "harvest", kind: "harvest", label: "Pull postings from every source", depends_on: ["query", "discover"], note: null, limit: null, optional: false },
      { id: "dedupe", kind: "dedupe", label: "Collapse duplicate postings", depends_on: ["harvest"], note: null, limit: null, optional: false },
      { id: "filter", kind: "hard_filter", label: "Apply non-negotiable constraints", depends_on: ["dedupe"], note: null, limit: null, optional: false },
      { id: "analyze", kind: "jd_analysis", label: "Structure each surviving JD", depends_on: ["filter"], note: null, limit: null, optional: false },
      { id: "prescore", kind: "prescore", label: "Vector and skill-graph shortlist", depends_on: ["analyze"], note: null, limit: null, optional: false },
      { id: "score", kind: "match_score", label: "Score the shortlist", depends_on: ["prescore"], note: null, limit: null, optional: false },
      { id: "reconcile", kind: "reconcile", label: "Resolve disagreements", depends_on: ["score"], note: null, limit: null, optional: false },
      { id: "rank", kind: "rank", label: "Order the final results", depends_on: ["reconcile"], note: null, limit: null, optional: false },
      { id: "curate", kind: "memory_curate", label: "Commit learnings", depends_on: ["rank"], note: null, limit: null, optional: false },
    ],
    success_criteria: ["at least one ranked result", "every score traceable to a measured signal"],
    notes: ["offline plan (no planner model)"],
  };
}

/* ── query matrix ─────────────────────────────────────────────────────── */

/** Interchangeable words inside a job title. Deliberately small: an invented
 *  synonym costs a whole irrelevant branch of the search. */
const TITLE_EQUIVALENTS: Array<string[]> = [
  ["associate", "executive", "representative", "specialist", "agent", "officer"],
  ["support", "service", "success", "care"],
  ["engineer", "developer"],
  ["telecaller", "telecalling", "voice process", "inside sales"],
];

const SENIORITY_WORDS = /\b(senior|junior|lead|principal|staff|associate|assistant|trainee|intern|sr\.?|jr\.?|i{1,3}|1|2|3)\b/gi;

function queryPlan(input: string) {
  const brief = field(input, "Brief");
  const profileLine = field(input, "Profile");

  const titles = /titles held:\s*([^;]+)/i.exec(profileLine)?.[1] ?? "";
  const skills = /skills:\s*([^;]+)/i.exec(profileLine)?.[1] ?? "";
  // Only what the candidate asked for. The résumé's locations line is where
  // they have worked, which is not a statement about where they want to.
  const wanted = /^WANTED LOCATIONS[^:]*:\s*(.+)$/im.exec(input)?.[1] ?? "";
  const stated = /not stated/i.test(wanted) ? "" : wanted.replace(/\s+—.*$/, "");
  const years = Number(/^([\d.]+)\s*years/i.exec(profileLine)?.[1] ?? "0");
  const broaden = /BROADEN/.test(input);

  const held = titles.split("/").map((t) => t.trim()).filter(Boolean);
  const canonical = held[0] || guessRoleFromBrief(brief) || "Associate";

  const variants = new Set<string>([canonical]);
  for (const base of [canonical, ...held]) {
    variants.add(base.replace(SENIORITY_WORDS, "").replace(/\s{2,}/g, " ").trim());
    for (const group of TITLE_EQUIVALENTS) {
      for (const word of group) {
        const re = new RegExp(`\\b${word}\\b`, "i");
        if (!re.test(base)) continue;
        for (const other of group) variants.add(base.replace(re, other));
      }
    }
  }

  // The brief itself often names the target role, which may differ from what
  // the candidate has held. Honour it.
  const fromBrief = guessRoleFromBrief(brief);
  if (fromBrief) variants.add(fromBrief);

  const clean = [...variants]
    .map((v) => v.replace(/\s{2,}/g, " ").trim())
    .filter((v) => v.length > 2)
    .slice(0, broaden ? 12 : 8);

  const skillList = listSplit(skills).slice(0, 20);
  const locationList = stated ? listSplit(stated).slice(0, 4) : [];

  const band = broaden
    ? { min_years: Math.max(0, Math.floor(years) - 3), max_years: Math.ceil(years) + 5 }
    : { min_years: Math.max(0, Math.floor(years) - 1), max_years: Math.ceil(years) + 3 };

  return {
    canonical_role: canonical,
    title_variants: clean,
    adjacent_roles: broaden ? clean.slice(1, 4) : [],
    skill_signature: skillList.length ? skillList : tokenize(brief).slice(0, 10),
    seniority_band: band,
    exclusions: [],
    locations: locationList,
    queries: [
      {
        source_type: "ats",
        q: [canonical, ...skillList.slice(0, 2)].join(" "),
        location: locationList[0] ?? null,
        remote_ok: !/on-site only/i.test(wanted),
        rationale: "canonical title plus the two strongest skills from the résumé",
      },
    ],
    confidence: clean.length > 1 && skillList.length > 2 ? 0.6 : 0.35,
    uncertainty_notes: [
      "Search matrix derived from the résumé without a model: title variants come from a small " +
        "equivalence table, not from titles seen in the wild.",
    ],
  };
}

const KNOWN_ROLES = [
  "customer support", "customer service", "customer success", "technical support", "telecaller",
  "inside sales", "business development", "operations", "backend engineer", "frontend engineer",
  "full stack engineer", "software engineer", "data analyst", "data engineer", "accountant",
  "human resources", "recruiter", "content writer", "digital marketing", "quality analyst",
];

function guessRoleFromBrief(brief: string): string {
  const b = brief.toLowerCase();
  const hit = KNOWN_ROLES.find((r) => b.includes(r));
  return hit ? hit.replace(/\b\w/g, (c) => c.toUpperCase()) : "";
}

/* ── JD analysis ──────────────────────────────────────────────────────── */

const REQUIREMENT_CUE = /\b(require|must have|should have|need|looking for|experience (in|with)|proficien|familiar|knowledge of|ability to|comfortable)\b/i;
const NICE_CUE = /\b(nice to have|bonus|preferred|plus|advantage|good to have)\b/i;
const RED_FLAG = /\b(unpaid|no salary|commission only|bond|security deposit|training fee|own vehicle required|rotational night shift)\b/i;

function jdAnalysis(input: string) {
  const title = field(input, "Title");
  const description = after(input, "Description:").trim();
  const lines = description.split("\n").map((l) => l.replace(/^\s*[•·*\-–—]\s*/, "").trim()).filter(Boolean);

  const must: Array<{ skill: string; evidence: string }> = [];
  const nice: Array<{ skill: string; evidence: string }> = [];
  const responsibilities: string[] = [];

  for (const line of lines) {
    if (line.length < 6) continue;
    const target = NICE_CUE.test(line) ? nice : REQUIREMENT_CUE.test(line) ? must : null;
    if (target) {
      for (const phrase of requirementPhrases(line)) {
        if (target.length < 10) target.push({ skill: phrase, evidence: line.slice(0, 160) });
      }
    } else if (/^[A-Z]/.test(line) && line.length < 220 && responsibilities.length < 8) {
      responsibilities.push(line);
    }
  }

  const yearsMatch = /(\d+)\s*(?:-|to|–)\s*(\d+)\s*year/i.exec(description) ?? /(\d+)\+?\s*year/i.exec(description);
  const min = yearsMatch ? Number(yearsMatch[1]) : null;
  const max = yearsMatch && yearsMatch[2] !== undefined ? Number(yearsMatch[2]) : min === null ? null : min + 3;

  const seniority = /\b(senior|lead|principal|staff|manager|head)\b/i.test(title)
    ? "senior"
    : /\b(intern|trainee)\b/i.test(title)
      ? "intern"
      : /\b(junior|fresher|entry)\b/i.test(title) || (min !== null && min <= 1)
        ? "junior"
        : "mid";

  // Below two survivors the extraction has not understood the posting. Saying
  // "0/6 requirements matched" against six fragments is worse than saying
  // nothing: the rubric has an honest branch for a posting with no stated
  // requirements, and it scores on text similarity instead.
  const cleanMust = dedupeSkills(must);
  const usableMust = cleanMust.length >= 2 ? cleanMust : [];

  return {
    must_have: usableMust,
    nice_to_have: usableMust.length ? dedupeSkills(nice) : [],
    years_required: { min, max },
    true_seniority: seniority,
    implicit_requirements: /on-?call|shift|weekend|target/i.test(description)
      ? [/on-?call/i.test(description) ? "on-call or shift work" : "works to a target"]
      : [],
    // Every flag, not just the first: a posting with both a night shift and a
    // security deposit must show both.
    red_flags: [...new Set([...description.matchAll(new RegExp(RED_FLAG.source, "gi"))].map((m) => m[0]))],
    domain: [],
    responsibilities,
    keywords: [...new Set(usableMust.map((m) => m.skill))],
    confidence: usableMust.length >= 3 ? 0.5 : usableMust.length ? 0.35 : 0.2,
  };
}

/**
 * Requirements a line is actually stating.
 *
 * The first version took arbitrary 1-3 word runs, which produced noise like
 * "years of experience" — and because the score is a *fraction* of stated
 * requirements matched, noise punished the postings that described themselves
 * most fully. So: cut the cue phrase off the front, drop the quantifiers, and
 * split on the conjunctions people actually use to list requirements.
 */
function requirementPhrases(line: string): string[] {
  let rest = line
    .replace(/^.*?\b(?:require[ds]?|must have|should have|need(?:s|ed)?|looking for|experience (?:in|with)|proficien\w*(?:\s+in|\s+with)?|familiar(?:ity)?\s+with|knowledge of|ability to|comfortable (?:with|in))\b:?\s*/i, "")
    .replace(/\b\d+\s*(?:\+|-|–|to)?\s*\d*\s*years?\b(?:\s+of)?/gi, " ")
    // "Must have 1-3 years of experience in X" strips its first cue at "must
    // have", leaving a second one behind. Anchored, so a mid-sentence "ability
    // to" cannot eat the requirement that preceded it.
    .replace(/^\s*(?:of\s+)?experience\s+(?:in|with|of)\s+/i, "")
    .replace(/^\s*(?:expertise|proficiency|fluency|knowledge)\s+(?:in|with|of)\s+/i, "")
    .replace(/\b(?:minimum|at least|preferably|ideally|strong|excellent|good|working|basic|prior|hands[- ]on|solid|deep)\b/gi, " ")
    .replace(/\(.*?\)/g, " ")
    .replace(/[.;]+$/, "")
    .trim();

  if (rest.length < 3 || rest.length > 220) return [];

  return rest
    .split(/\s*(?:[,;:\/]|\bor\b|\band\b|\bas well as\b)\s*/i)
    .map((p) =>
      p
        .replace(/^(?:a|an|the|in|with|of|for|to)\s+/i, "")
        .replace(/\s+(?:is|are|would be)\s+(?:required|mandatory|essential|a plus)$/i, "")
        .replace(/\s{2,}/g, " ")
        .trim(),
    )
    .filter((p) => {
      const w = p.split(/\s+/).length;
      if (p.length < 3 || p.length > 44 || w > 4) return false;
      if (/^(?:you|your|we|our|this|that|it|them|any|all|etc)$/i.test(p)) return false;
      // Real job descriptions are often prose, and splitting prose yields
      // clause fragments ("understand how they connect") that are not
      // requirements at all. A requirement names a thing, not an action.
      if (/\b(?:how|why|where|when|what|who|they|them|their|we|our|you|your|us)\b/i.test(p)) return false;
      if (/^(?:be|being|been|is|are|was|were|do|does|did|have|has|had|can|could|will|would|make|making|help|helping|get|getting|go|going|take|taking|understand|explain|ensure|drive|driving|build|building|own|owning|lead|leading|support|supporting|work|working)\b/i.test(p)) {
        return false;
      }
      // A negated clause is the opposite of a requirement. "Bengali and Hindi
      // not required" was being read as requiring Bengali and Hindi.
      if (/\b(?:not|no|without|non)\b/i.test(p)) return false;
      return true;
    })
    .slice(0, 4);
}

function dedupeSkills(xs: Array<{ skill: string; evidence: string }>) {
  const seen = new Set<string>();
  return xs.filter((x) => {
    const k = x.skill.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/* ── scoring ──────────────────────────────────────────────────────────── */

function rubric(input: string) {
  // The deterministic legs were already computed and handed to us; the whole
  // point of this provider is to score from them rather than to guess past them.
  const overlap = num(input, "skill-graph overlap") ?? 0;
  const similarity = num(input, "embedding similarity") ?? 0;
  const delta = num(input, "seniority delta") ?? 0;

  const jobBlock = after(input, "\nJOB\n");
  const required = /Required:\s*(.+)/i.exec(jobBlock)?.[1] ?? "";
  const candidateBlock = input.slice(0, input.indexOf("\nJOB\n") >= 0 ? input.indexOf("\nJOB\n") : input.length);

  const requiredSkills = listSplit(required).filter((s) => s.toLowerCase() !== "unstated");
  const candidateText = candidateBlock.toLowerCase();
  const matched = requiredSkills.filter((s) => candidateText.includes(s.toLowerCase()));
  const missing = requiredSkills.filter((s) => !matched.includes(s));

  const core = Math.round(overlap * 100);
  const seniorityScore = Math.round(Math.max(0, 1 - (delta < 0 ? Math.abs(delta) * 0.18 : delta * 0.09)) * 100);
  const domain = Math.round(similarity * 100);
  const scope = Math.round((similarity * 0.5 + overlap * 0.5) * 100);

  const remote = /\bremote\b/i.test(jobBlock);
  const jobCity = /—\s*([^(]+)\(/.exec(jobBlock)?.[1]?.trim() ?? "";
  const locationScore = remote ? 90 : jobCity && candidateText.includes(jobCity.split(",")[0]!.toLowerCase()) ? 90 : 50;

  const dimensions = [
    {
      dimension: "core_skills",
      score: core,
      reason: requiredSkills.length
        ? `${matched.length}/${requiredSkills.length} stated requirements appear in the résumé` +
          (missing.length ? `; missing: ${missing.slice(0, 4).join(", ")}` : "")
        : "the posting states no explicit requirements, so this is skill-graph overlap alone",
    },
    {
      dimension: "seniority_fit",
      score: seniorityScore,
      reason:
        delta === 0
          ? "years of experience sit inside the range the posting asks for"
          : delta < 0
            ? `${Math.abs(delta)} year(s) short of the stated minimum`
            : `${delta} year(s) beyond the stated maximum`,
    },
    {
      dimension: "domain_relevance",
      score: domain,
      reason: `embedding similarity ${similarity.toFixed(3)} between the résumé and this posting's text`,
    },
    {
      dimension: "scope_and_impact",
      score: scope,
      // Said plainly: a heuristic cannot read scope off a bullet.
      reason: "estimated from skill and text overlap; judging real scope needs a model",
    },
    {
      dimension: "location_and_mode",
      score: locationScore,
      reason: remote ? "posting is remote" : jobCity ? `posting is in ${jobCity}` : "location not stated",
    },
  ];

  const weights: Record<string, number> = {
    core_skills: 0.35,
    seniority_fit: 0.2,
    domain_relevance: 0.2,
    scope_and_impact: 0.15,
    location_and_mode: 0.1,
  };
  const holistic = Math.round(
    dimensions.reduce((sum, d) => sum + d.score * (weights[d.dimension] ?? 0), 0),
  );

  return {
    dimensions,
    // Identical to the weighted composite by construction. A heuristic has no
    // independent read to disagree with, and inventing one would make the
    // self-consistency check fire on noise.
    holistic,
    matched_skills: matched,
    gaps: missing,
    reasoning: [
      `Scored from measured signals only: skill overlap ${overlap.toFixed(3)}, ` +
        `similarity ${similarity.toFixed(3)}, seniority delta ${delta}.`,
    ],
    confidence: 0.4,
  };
}

/* ── tailoring: reorder and re-emphasise, never rewrite ───────────────── */

function editPlan(input: string) {
  const resumeBlock = after(input, "RESUME (ids are stable; refer to them exactly)");
  const required = /Required:\s*(.+)/i.exec(input)?.[1] ?? "";
  const screens = /Screens on:\s*(.+)/i.exec(input)?.[1] ?? "";

  const requirements = [...new Set([...listSplit(required.replace(/\("[^"]*"\)/g, "")), ...listSplit(screens)])]
    .map((r) => r.trim())
    .filter((r) => r.length > 2)
    .slice(0, 10);

  const bulletIds = [...resumeBlock.matchAll(/\[(exp_\d+_b\d+)\]\s*(.+)/g)].map((m) => ({
    id: m[1]!,
    text: m[2]!.toLowerCase(),
  }));

  const edits: Array<Record<string, unknown>> = [];
  const unaddressable: string[] = [];

  for (const req of requirements) {
    const needle = req.toLowerCase();
    const hit = bulletIds.find((b) => b.text.includes(needle));
    if (hit) {
      edits.push({
        kind: "promote_bullet",
        target_id: hit.id,
        intent: `Move the bullet that already evidences "${req}" to the top of its role`,
        addresses: req,
        priority: 1,
      });
    } else if (resumeBlock.toLowerCase().includes(needle)) {
      edits.push({
        kind: "surface_skill",
        target_id: null,
        intent: `Promote "${req}" into the primary skills line`,
        addresses: req,
        priority: 2,
      });
    } else {
      unaddressable.push(req);
    }
  }

  return {
    edits: edits.slice(0, 12),
    missing_keywords: unaddressable,
    unaddressable_gaps: unaddressable,
    confidence: 0.45,
  };
}

function bindings(input: string) {
  const resumeBlock = after(input, "ORIGINAL RESUME");
  const plan = after(input, "PLANNED EDITS");
  const elements = [...resumeBlock.matchAll(/\[([\w.]+)\]\s*(.+)/g)].map((m) => ({ id: m[1]!, text: m[2]! }));

  const out = [...plan.matchAll(/^(edit_\d+)\s*\[(\w+)\]\s*target=(\S+)\s*-\s*(.+?)\s*\(addresses:\s*(.+?)\)/gm)].map(
    (m) => {
      const [, editId, , target, , addresses] = m;
      const needle = addresses!.toLowerCase();

      // Bound only when the requirement's own words are in the cited element.
      // The orchestrator re-verifies this in code, so a wrong answer here is
      // caught rather than trusted.
      const element =
        elements.find((e) => e.id === target) ??
        elements.find((e) => e.text.toLowerCase().includes(needle));

      if (!element || !element.text.toLowerCase().includes(needle)) {
        return {
          edit_id: editId!,
          bound: false,
          source_ids: [],
          quotes: [],
          unbound_reason: `no line in the résumé contains "${addresses}"`,
          confidence: 0.5,
        };
      }

      const idx = element.text.toLowerCase().indexOf(needle);
      const quote = element.text.slice(Math.max(0, idx - 20), idx + needle.length + 40).trim();
      return {
        edit_id: editId!,
        bound: true,
        source_ids: [element.id],
        quotes: [quote],
        unbound_reason: null,
        confidence: 0.5,
      };
    },
  );

  return { bindings: out };
}

function tailored(input: string) {
  const resumeBlock = after(input, "ORIGINAL RESUME");
  const summary = /\[summary\]\s*(.+)/.exec(resumeBlock)?.[1]?.trim() ?? "";
  const primary = listSplit(/\[skills\.primary\]\s*(.+)/.exec(resumeBlock)?.[1] ?? "");
  const secondary = listSplit(/\[skills\.secondary\]\s*(.+)/.exec(resumeBlock)?.[1] ?? "");

  // Bullets the evidence step bound get promoted within their own role. That
  // is the entire edit: no sentence is rewritten, so nothing can be invented.
  const promoted = new Set(
    [...after(input, "EDITS TO APPLY").matchAll(/evidence \((exp_\d+_b\d+)\)/g)].map((m) => m[1]!),
  );

  const experience: Array<Record<string, unknown>> = [];
  // `[exp_1] Title, Company (2025-02 - present), Location`
  // The date group is captured whole and split on a *spaced* dash: splitting
  // on any dash tears "2025-02" in half, which the critic then correctly
  // rejects as a date change.
  const roleRe = /^\[(exp_\d+)\]\s*(.+?),\s*([^(]+?)\s*\(([^()]*)\)(?:,\s*(.+))?$/gm;
  for (const m of resumeBlock.matchAll(roleRe)) {
    const [, id, title, company, dates, location] = m;
    const [start = "", end = ""] = (dates ?? "").split(/\s+[-–—]\s+/).map((d) => d.trim());
    const bulletRe = new RegExp(`\\[(${id}_b\\d+)\\]\\s*(.+)`, "g");
    const bullets = [...resumeBlock.matchAll(bulletRe)].map((b) => ({ id: b[1]!, text: b[2]!.trim() }));
    const ordered = [...bullets].sort(
      (a, b) => Number(promoted.has(b.id)) - Number(promoted.has(a.id)),
    );
    experience.push({
      id,
      company: company!.trim(),
      title: title!.trim(),
      location: location?.trim() ?? null,
      start,
      end,
      bullets: ordered.map((b) => b.text),
      source_ids: ordered.map((b) => b.id),
    });
  }

  const addressed = [...after(input, "EDITS TO APPLY").matchAll(/addresses:\s*(.+)/g)].map((m) =>
    m[1]!.trim().toLowerCase(),
  );
  const allSkills = [...primary, ...secondary];
  // Promote the candidate's OWN wording for a skill the JD asked about — not
  // the JD's lowercased phrasing, which produced "ms word, MS Word" on one line.
  const surfaced = allSkills.filter((skill) => {
    const k = skill.toLowerCase();
    return addressed.some((a) => k.includes(a) || a.includes(k));
  });

  const newPrimary = dedupeCaseInsensitive([...surfaced, ...primary]).slice(0, 10);
  const lowerPrimary = new Set(newPrimary.map((x) => x.toLowerCase()));
  const newSecondary = dedupeCaseInsensitive(secondary).filter((x) => !lowerPrimary.has(x.toLowerCase()));

  const projects = [...resumeBlock.matchAll(/^\[(prj_\d+)\]\s*(.+?):\s*(.+?)\s*\((.*?)\)$/gm)].map((m) => ({
    name: m[2]!.trim(),
    description: m[3]!.trim(),
    tech: listSplit(m[4]!),
    source_ids: [m[1]!],
  }));

  return {
    // Verbatim. A heuristic that rewrote a summary would be fabricating.
    summary,
    experience,
    skills: { primary: newPrimary, secondary: newSecondary },
    projects,
    applied_edit_ids: [...after(input, "EDITS TO APPLY").matchAll(/^(edit_\d+)\s/gm)].map((m) => m[1]!),
  };
}

/** "ms word" and "MS Word" are one skill; keep the first spelling seen. */
function dedupeCaseInsensitive(xs: string[]): string[] {
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

function critique() {
  // The deterministic checks in the critic agent still run and still gate the
  // render. This only declines to add a model's judgment on top.
  return {
    verdict: "pass",
    findings: [
      {
        category: "tone",
        severity: "warn",
        quote: "(whole document)",
        explanation:
          "Offline mode only reordered existing content and never rewrote a sentence, so there is nothing " +
          "for an adversarial read to catch. Run with an API key for a real critic pass.",
        location: "document",
        suggested_fix: null,
      },
    ],
    confidence: 0.3,
  };
}
