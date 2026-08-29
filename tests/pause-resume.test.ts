import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemorySaver } from "@langchain/langgraph";
import { SqliteStore } from "../src/state/sqlite.js";
import { JobSearchAgent } from "../src/orchestrator/run.js";
import { fixtureProvider, installFixtures } from "../src/interface/fixtures.js";
import { ScriptedProvider, type ProviderRequest } from "../src/llm/provider.js";
import type { ProgressEvent } from "../src/orchestrator/events.js";
import { BRIEF, resumeText } from "./helpers.js";

/**
 * A model that never accepts a draft. The tailoring loop must therefore hit
 * its hard cap, escalate with the unresolved items, and pause — never ship
 * silently and never loop forever.
 */
function stubbornCriticProvider(): ScriptedProvider {
  const base = fixtureProvider();
  const script = new Map<string, unknown[] | ((req: ProviderRequest) => unknown)>(
    (base as unknown as { script: Map<string, unknown[] | ((r: ProviderRequest) => unknown)> }).script,
  );
  script.set("critique_report", () => ({
    verdict: "reject",
    findings: [
      {
        category: "untraceable_claim",
        severity: "reject",
        quote: "owned from schema design through on-call",
        explanation: "the original does not say the candidate owned the schema design",
        location: "summary",
        suggested_fix: "say what the resume says",
      },
    ],
    confidence: 0.9,
  }));
  return new ScriptedProvider(script);
}

let dir: string;
let store: SqliteStore;
let events: ProgressEvent[];
let checkpointer: MemorySaver;

beforeEach(() => {
  process.env.JOBSEARCH_OFFLINE = "1";
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "job-search-aiagent-pause-"));
  store = new SqliteStore(path.join(dir, "t.sqlite"));
  installFixtures(store);
  events = [];
  checkpointer = new MemorySaver();
});
afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeSystem(provider: ScriptedProvider): JobSearchAgent {
  return new JobSearchAgent({ store, provider, emit: (e) => events.push(e), checkpointer });
}

describe("bounded reflection and human-in-the-loop pause", () => {
  it("caps the revision loop, escalates the unresolved items, and pauses the run", async () => {
    const search = await makeSystem(fixtureProvider()).search({
      brief: BRIEF, resumeText: resumeText(),    });
    const jobId = search.board.ranked_job_ids[0]!;

    const system = makeSystem(stubbornCriticProvider());
    const r = await system.tailor({ searchRunId: search.runId, jobId });

    // 1 draft + 2 revisions, then stop. Never unbounded.
    const drafts = r.trace.filter((t) => t.kind === "draft" && t.attempts > 0);
    expect(drafts.length).toBeLessThanOrEqual(3);
    expect(r.board.critiques.every((c) => c.verdict === "reject")).toBe(true);

    // The run pauses rather than shipping an unreviewed draft.
    expect(r.status).toBe("awaiting_user");

    const blocking = store.listEscalations(r.runId, true).filter((e) => e.blocking);
    expect(blocking.length).toBeGreaterThan(0);
    const q = blocking.find((e) => e.kind === "unresolved_critique")!;
    expect(q.question).toContain("revisions");
    // A specific answerable question, quoting the offending text.
    expect(q.question).toContain("owned from schema design");
    expect(q.options.length).toBeGreaterThan(0);

    // Nothing was rendered.
    expect(r.board.render).toBeNull();
  });

  it("resumes from the checkpoint and replays committed nodes instead of redoing them", async () => {
    const seedSystem = makeSystem(fixtureProvider());
    const search = await seedSystem.search({ brief: BRIEF, resumeText: resumeText() });
    const jobId = search.board.ranked_job_ids[0]!;

    const system = makeSystem(stubbornCriticProvider());
    const paused = await system.tailor({ searchRunId: search.runId, jobId });
    expect(paused.status).toBe("awaiting_user");

    const question = store.listEscalations(paused.runId, true).find((e) => e.blocking)!;
    const costBefore = paused.spent.cost_usd;
    const gapCallsBefore = paused.trace.filter((t) => t.kind === "gap_analysis" && t.usage.cost_usd > 0).length;
    expect(gapCallsBefore).toBe(1);

    events.length = 0;
    const resumed = await system.resume({
      runId: paused.runId,
      answers: { [question.id]: "Keep the original wording." },
    });

    // The answer was recorded against the escalation.
    expect(store.listEscalations(paused.runId, true).some((e) => e.id === question.id)).toBe(false);

    // Work already committed is replayed, not re-run: no second paid call to
    // gap analysis, and the resumed trace says so.
    const paidGapCalls = resumed.trace.filter((t) => t.kind === "gap_analysis" && t.usage.cost_usd > 0).length;
    expect(paidGapCalls).toBe(1);
    expect(resumed.trace.some((t) => t.output_summary.includes("replayed from checkpoint"))).toBe(true);
    expect(resumed.spent.cost_usd).toBeGreaterThanOrEqual(costBefore);
  });

  it("puts the answers on the board so the renderer honours them and a résumé comes out", async () => {
    const seedSystem = makeSystem(fixtureProvider());
    const search = await seedSystem.search({ brief: BRIEF, resumeText: resumeText() });
    const jobId = search.board.ranked_job_ids[0]!;

    const system = makeSystem(stubbornCriticProvider());
    const paused = await system.tailor({ searchRunId: search.runId, jobId });
    expect(paused.status).toBe("awaiting_user");
    // The critic held the draft back, so nothing was rendered before the answer.
    expect(paused.board.render ?? null).toBeNull();

    const question = store.listEscalations(paused.runId, true).find((e) => e.blocking)!;
    const resumed = await system.resume({
      runId: paused.runId,
      answers: { [question.id]: "Keep the original wording." },
    });

    // `Command({ resume })` reaches only the `interrupt` that paused the run,
    // and the node holding it is replayed rather than re-executed — so the
    // answers have to be written onto the board explicitly. Without that the
    // board stayed empty here and the renderer refused a second time, leaving
    // the run `partial` with no PDF however often it was resumed.
    expect(Object.values(resumed.board.answers ?? {})).toContain("Keep the original wording.");

    expect(resumed.board.render).toBeTruthy();
    expect(resumed.board.render!.pdf_path).toMatch(/\.pdf$/);
    expect(resumed.board.render!.docx_path).toMatch(/\.docx$/);
    expect(resumed.board.skipped ?? []).not.toContain(
      "render: draft still carries unresolved critic rejections",
    );
  });
});
