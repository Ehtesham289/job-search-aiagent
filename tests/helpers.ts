import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemorySaver } from "@langchain/langgraph";
import { SqliteStore } from "../src/state/sqlite.js";
import { JobSearchAgent } from "../src/orchestrator/run.js";
import { fixtureProvider, installFixtures, offlineProvider } from "../src/interface/fixtures.js";
import type { ProgressEvent } from "../src/orchestrator/events.js";

export interface Harness {
  system: JobSearchAgent;
  store: SqliteStore;
  events: ProgressEvent[];
  cleanup(): void;
}

/**
 * A complete offline system: temp SQLite, local job fixtures, in-memory
 * checkpointer. Nothing here touches the network.
 *
 * `scripted` (default) replays canned model answers — deterministic, and able
 * to plant a specific fault to prove an agent catches it. `offline` runs the
 * real heuristic provider, which is what a user without an API key meets.
 */
export function harness(opts: { provider?: "scripted" | "offline" } = {}): Harness {
  // No test touches the network. The application agent will degrade and raise
  // its escalation, which is the behaviour under test anyway.
  process.env.JOBSEARCH_OFFLINE = "1";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "job-search-aiagent-test-"));
  const store = new SqliteStore(path.join(dir, "test.sqlite"));
  installFixtures(store);
  const events: ProgressEvent[] = [];
  const system = new JobSearchAgent({
    store,
    provider: opts.provider === "offline" ? offlineProvider() : fixtureProvider(),
    emit: (e) => events.push(e),
    checkpointer: new MemorySaver(),
  });
  return {
    system,
    store,
    events,
    cleanup() {
      system.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const BRIEF = "Backend engineer, 4 years, Node and Postgres, Bengaluru or remote";

export function resumeText(): string {
  return fs.readFileSync(path.resolve("fixtures/resume.txt"), "utf8");
}

export function finishedNodes(events: ProgressEvent[]): Array<Extract<ProgressEvent, { type: "node_finished" }>> {
  return events.filter((e): e is Extract<ProgressEvent, { type: "node_finished" }> => e.type === "node_finished");
}
