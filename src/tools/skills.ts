import type { Store } from "../state/store.js";

/**
 * Skill graph with synonym resolution (§2.6 leg 3). Seeded with the aliases
 * that actually cost matches, then grown by the Memory Curator from what
 * co-occurs in real postings.
 */
const SEED_SKILL_SYNONYMS: Array<[string, string]> = [
  ["node", "node.js"], ["nodejs", "node.js"], ["node js", "node.js"],
  ["js", "javascript"], ["ts", "typescript"],
  ["postgres", "postgresql"], ["psql", "postgresql"], ["pg", "postgresql"],
  ["k8s", "kubernetes"], ["kube", "kubernetes"],
  ["gcp", "google cloud"], ["aws", "amazon web services"],
  ["rest", "rest api"], ["restful", "rest api"], ["http api", "rest api"],
  ["ci/cd", "ci cd"], ["cicd", "ci cd"],
  ["golang", "go"],
  ["reactjs", "react"], ["react.js", "react"],
  ["ml", "machine learning"], ["dl", "deep learning"],
  ["rdbms", "sql"], ["mysql", "sql"], ["sqlserver", "sql"],
  ["dynamo", "dynamodb"],
  ["tf", "terraform"],
  ["gh actions", "github actions"],
  ["msgq", "message queue"], ["kafka", "message queue"], ["rabbitmq", "message queue"],
  ["micro-services", "microservices"], ["micro services", "microservices"],
];

/**
 * India-specific title noise the spec calls out: "SDE" and "Member of
 * Technical Staff" describe the same job, and searching one misses the other.
 */
const SEED_TITLE_SYNONYMS: Array<[string, string]> = [
  ["sde", "software engineer"], ["sde i", "software engineer"], ["sde ii", "software engineer"],
  ["sde 2", "software engineer"], ["sde-2", "software engineer"],
  ["member of technical staff", "software engineer"], ["mts", "software engineer"],
  ["software development engineer", "software engineer"],
  ["swe", "software engineer"],
  ["backend developer", "backend engineer"], ["back-end engineer", "backend engineer"],
  ["server side engineer", "backend engineer"],
  ["api engineer", "backend engineer"], ["platform engineer", "backend engineer"],
  ["full stack developer", "full stack engineer"], ["fullstack engineer", "full stack engineer"],
  ["sre", "site reliability engineer"],
  ["devops engineer", "infrastructure engineer"],
  ["data engineer", "data engineer"],
];

export function seedMemory(store: Store): void {
  for (const [term, canonical] of SEED_SKILL_SYNONYMS) store.putSkillSynonym(term, canonical, 0.9);
  for (const [term, canonical] of SEED_TITLE_SYNONYMS) store.putTitleSynonym(term, canonical, 0.9, true);
}

export function normalizeSkill(store: Store, raw: string): string {
  const s = raw.trim().toLowerCase().replace(/\s+/g, " ");
  const hits = store.skillSynonyms(s);
  return hits.length > 0 && hits[0]!.weight >= 0.5 ? hits[0]!.canonical : s;
}

export function normalizeSkills(store: Store, raw: string[]): string[] {
  const out = new Set<string>();
  for (const r of raw) {
    const n = normalizeSkill(store, r);
    if (n) out.add(n);
  }
  return [...out];
}

/** Canonical form plus every alias, so one title expands into a search set. */
export function expandTitle(store: Store, title: string): string[] {
  const t = title.trim().toLowerCase();
  const out = new Set<string>([t]);
  for (const s of store.titleSynonyms(t)) out.add(s.canonical);
  return [...out];
}

export interface SkillOverlap {
  score: number;
  matched: string[];
  missing: string[];
}

/**
 * Weighted overlap: must-haves dominate, nice-to-haves contribute a fifth.
 * Returns the matched and missing sets too — the score alone is not
 * explainable, and §2.6 requires explainability.
 */
export function skillOverlap(
  store: Store,
  candidate: string[],
  mustHave: string[],
  niceToHave: string[] = [],
): SkillOverlap {
  const have = new Set(normalizeSkills(store, candidate));
  const must = normalizeSkills(store, mustHave);
  const nice = normalizeSkills(store, niceToHave);

  const matched: string[] = [];
  const missing: string[] = [];
  let earned = 0;
  let total = 0;

  for (const m of must) {
    total += 1;
    if (has(have, m)) { earned += 1; matched.push(m); } else { missing.push(m); }
  }
  for (const n of nice) {
    total += 0.2;
    if (has(have, n)) { earned += 0.2; matched.push(n); }
  }

  // Shrink toward a prior when there is little to measure. A raw fraction
  // treats "1 of 1 vague requirement" as a perfect match and "3 of 7 specific
  // ones" as mediocre, which inverts the truth: the second posting told us far
  // more about itself. k is the weight of the prior in requirement-equivalents.
  const K = 2;
  const PRIOR = 0.3;
  const score = total === 0 ? 0 : (earned + K * PRIOR) / (total + K);

  return { score, matched, missing };
}

/**
 * Containment on *word* boundaries, so "postgresql" still matches
 * "postgresql 14" but "excel" no longer matches "excellent communication" —
 * which was quietly matching almost every posting ever written.
 */
function has(set: Set<string>, needle: string): boolean {
  if (set.has(needle)) return true;
  for (const s of set) {
    if (containsWord(s, needle) || containsWord(needle, s)) return true;
  }
  return false;
}

function containsWord(haystack: string, needle: string): boolean {
  if (needle.length === 0) return false;
  const i = haystack.indexOf(needle);
  if (i < 0) return false;
  const before = i === 0 ? " " : haystack[i - 1]!;
  const after = i + needle.length >= haystack.length ? " " : haystack[i + needle.length]!;
  return !/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after);
}

const SENIORITY_YEARS: Record<string, number> = {
  intern: 0, junior: 1, mid: 4, senior: 7, staff: 10, lead: 9, principal: 12, manager: 9,
};

export function seniorityYears(band: string): number {
  return SENIORITY_YEARS[band] ?? 4;
}

/**
 * How close a posting's title is to the titles the candidate has actually
 * held, on synonym-expanded tokens.
 *
 * Nothing in the funnel rewarded this before: skill overlap and embedding
 * similarity both dilute it, so an exact-title match could rank below a
 * loosely-related role that happened to share vocabulary. For non-technical
 * roles, where the skills are phrases rather than tools, the title carries
 * most of the signal.
 */
export function titleSimilarity(store: Store, candidateTitles: string[], jobTitle: string): number {
  if (candidateTitles.length === 0 || !jobTitle.trim()) return 0;

  const jobForms = new Set(expandTitle(store, stripNoise(jobTitle)));
  const jobTokens = new Set([...jobForms].flatMap((f) => words(f)));

  let best = 0;
  for (const raw of candidateTitles) {
    const forms = new Set(expandTitle(store, stripNoise(raw)));
    // An exact match on any synonym-expanded form is the strongest signal
    // there is; do not let token maths dilute it.
    for (const f of forms) {
      if (jobForms.has(f)) return 1;
    }
    const tokens = new Set([...forms].flatMap((f) => words(f)));
    let shared = 0;
    for (const t of tokens) if (jobTokens.has(t)) shared++;
    const union = new Set([...tokens, ...jobTokens]).size;
    if (union > 0) best = Math.max(best, shared / union);
  }
  return best;
}

/** Seniority and bracketed noise are handled by the seniority leg, not here. */
function stripNoise(title: string): string {
  return title
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b(senior|junior|lead|principal|staff|sr\.?|jr\.?|i{1,3}|1|2|3)\b/g, " ")
    .replace(/[^a-z0-9+#.\s-]/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

const TITLE_STOP = new Set(["and", "the", "of", "for", "a", "an", "in", "at", "to", "with"]);

function words(s: string): string[] {
  return s.split(/[\s\-/]+/).filter((w) => w.length > 1 && !TITLE_STOP.has(w));
}
