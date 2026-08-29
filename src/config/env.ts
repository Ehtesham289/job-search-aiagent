import path from "node:path";
import { loadDotEnv } from "./dotenv.js";
import { currentPreset, PRESETS } from "./models.js";

// Before anything reads process.env. Importing this module is what activates
// .env, so every entry point picks it up by importing config.
loadDotEnv();

function num(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export const env = {
  dbPath: process.env.JOBSEARCH_DB ?? path.resolve("job-search-aiagent.sqlite"),
  outDir: process.env.JOBSEARCH_OUT ?? path.resolve("out"),
  /** Concurrent harvest workers; sources are network-bound, not CPU-bound. */
  harvestConcurrency: num("JOBSEARCH_HARVEST_CONCURRENCY", 8),
  /** §4 fan-in timeout — one slow source must not hold the run. */
  /**
   * Fan-in deadline for the harvest.
   *
   * Raised from 45s because essentially every real run was reporting
   * "fan-in timeout; slow sources abandoned" — a hundred boards, several of
   * them enormous Workday tenants, do not answer in 45 seconds, so runs were
   * routinely scoring a truncated slice of what was available. It also decides
   * how much LinkedIn can do: at a ~2.6s host interval, 45s bought about 16
   * requests and roughly a dozen usable postings.
   */
  harvestFanInMs: num("JOBSEARCH_HARVEST_FANIN_MS", 120_000),
  httpTimeoutMs: num("JOBSEARCH_HTTP_TIMEOUT_MS", 15_000),
  userAgent:
    process.env.JOBSEARCH_UA ??
    "job-search-aiagent/0.1 (job search agent; +https://example.invalid/job-search-aiagent)",
  /**
   * Jobs that survive prescore and get an LLM rubric pass.
   *
   * A getter, not a value: the console sets the preset per request, and these
   * were being frozen at module load — so the dropdown changed the models
   * (which resolve per call) but not the funnel caps.
   */
  get rubricTopK() {
    return num("JOBSEARCH_RUBRIC_TOP_K", PRESETS[currentPreset()].rubricTopK);
  },
  /**
   * Jobs that get a structured JD analysis. Wider than the rubric shortlist,
   * because analysis sharpens the ranking that chooses it — but bounded,
   * because it is the dominant cost of a search on a large registry.
   */
  get analysisTopK() {
    return num("JOBSEARCH_ANALYSIS_TOP_K", PRESETS[currentPreset()].analysisTopK);
  },
  /** §2.6 step 5 threshold: composite vs holistic disagreement, in points. */
  reconcileThreshold: num("JOBSEARCH_RECONCILE_THRESHOLD", 15),
  /** §2.7 hard cap on the critic loop. */
  maxRevisionCycles: num("JOBSEARCH_MAX_REVISIONS", 2),
  /** A filter pass leaving fewer than this triggers one broadening replan. */
  broadenThreshold: num("JOBSEARCH_BROADEN_THRESHOLD", 10),
  /** Below this, an agent asks instead of guessing. */
  escalationConfidence: num("JOBSEARCH_ESCALATION_CONFIDENCE", 0.55),
  /** Hard no-network switch. Fetches fail fast with a clear reason instead of
   *  waiting out DNS timeouts; agents that need the network degrade and say so. */
  get preset() {
    return currentPreset();
  },
  get offline() {
    return process.env.JOBSEARCH_OFFLINE === "1";
  },
  get hasApiKey() {
    return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  },
};
