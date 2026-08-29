#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { env } from "../config/env.js";
import { extractText } from "../tools/parse/document.js";
import { SqliteStore } from "../state/sqlite.js";
import { JobSearchAgent } from "../orchestrator/run.js";
import { createConsoleSink, printTrace } from "./stream.js";
import { installFixtures, offlineProvider } from "./fixtures.js";
import type { RunResult } from "../orchestrator/graph.js";

const USAGE = `job-search-aiagent - layered multi-agent job discovery and resume tailoring

  search    --brief <text> [--resume <file>] [--location "Kolkata,Remote"]
            [--onsite-only] [--discover a,b] [--find-companies] [--budget 0.40]
            [--preset cheap|balanced|thorough]
            [--no-planner] [--offline] [--fixtures] [--verbose]
  tailor    <search-run-id> <job-id> [--offline] [--verbose]
  resume    <run-id> --answer <escalation-id>=<text> [...]
  discover  <company-or-domain> [...]
  runs      [--limit 20]
  results   <run-id> [--limit 20]
  trace     <run-id>
  ask       <run-id>                      list the open questions for a run
  feedback  <job-id> <edit-kind> accept|reject
  sources   [--status verified|unresolved|dead]
  enable    <company> [...]               include a company in future searches
  disable   <company> [...]               skip it, keeping its verified board
  forget    <company>                     drop a source that resolved wrongly

Presets (cost/quality; measured figures in the README):
  cheap                    every tier one step down, narrower funnel
  balanced                 default
  thorough                 same models, wider funnel (more jobs considered)

Modes:
  (default)                real job boards + Anthropic models. Needs a credential.
  --offline                real job boards, heuristics instead of a model. No key needed.
  --fixtures               local sample postings + heuristics. Implies --offline.

Without a credential, --offline is assumed. Harvesting and discovery are pure code,
so a real search against real ATS boards works with no API key at all.

Environment:
  ANTHROPIC_API_KEY        needed only for the model-backed agents
  JOBSEARCH_DB              sqlite path (default ./job-search-aiagent.sqlite)
  JOBSEARCH_MODEL_STRONG    override the strong tier (default claude-opus-5)
  JOBSEARCH_MODEL_MID       override the mid tier    (default claude-sonnet-5)
  JOBSEARCH_MODEL_FAST      override the fast tier   (default claude-haiku-4-5)
  JOBSEARCH_TEMPLATE        resume template: modern | classic | compact
`;

interface Args {
  _: string[];
  flags: Record<string, string | boolean>;
  repeated: Record<string, string[]>;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {}, repeated: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out.flags[key] = true;
    } else {
      out.flags[key] = next;
      (out.repeated[key] ??= []).push(next);
      i++;
    }
  }
  return out;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const args = parseArgs(argv.slice(1));

  if (!command || command === "help" || args.flags.help) {
    console.log(USAGE);
    return 0;
  }

  const preset = str(args.flags.preset);
  if (preset) process.env.JOBSEARCH_PRESET = preset;

  const verbose = Boolean(args.flags.verbose);
  // Two independent choices that used to be one flag: which *model* to use,
  // and which *jobs* to search. Wanting the first offline says nothing about
  // wanting the second faked.
  const useFixtures = Boolean(args.flags.fixtures);
  const offline = useFixtures || Boolean(args.flags.offline) || !env.hasApiKey;
  const emit = createConsoleSink({ verbose });

  // Harvesting and discovery are pure code — public ATS endpoints and one
  // verifying fetch. Refusing to run without a credential was blocking a real
  // search the system is perfectly capable of doing.
  if (offline && !env.hasApiKey && ["search", "tailor"].includes(command)) {
    console.error(
      "No Anthropic credential: running offline, with heuristics instead of a model.\n" +
        (useFixtures
          ? "Searching the local sample postings in fixtures/jobs.\n"
          : "Still searching real job boards — harvesting needs no API key.\n"),
    );
  }

  const store = new SqliteStore(env.dbPath);
  const system = new JobSearchAgent({
    store,
    emit,
    ...(offline ? { provider: offlineProvider() } : {}),
  });
  if (useFixtures) installFixtures(store);

  try {
    switch (command) {
      case "search": {
        const brief = str(args.flags.brief);
        if (!brief) {
          console.error("search needs --brief");
          return 2;
        }
        let resumeText: string | undefined;
        const resumePath = str(args.flags.resume);
        if (resumePath) {
          const { text, kind } = await extractText(path.resolve(resumePath));
          if (text.trim().length < 100) {
            console.error(`Could not read enough text out of ${resumePath} (detected ${kind}).`);
            return 2;
          }
          resumeText = text;
        }

        const result = await system.search({
          brief,
          resumeText,
          usePlanner: !args.flags["no-planner"],
          locations: str(args.flags.location)?.split(",").map((x) => x.trim()).filter(Boolean) ?? [],
          remoteOk: !args.flags["onsite-only"],
          ...(args.flags["find-companies"] ? { autoDiscover: true } : {}),
          discover: str(args.flags.discover)?.split(",").map((s) => s.trim()).filter(Boolean),
          budget: args.flags.budget ? { max_cost_usd: Number(args.flags.budget) } : undefined,
        });

        printResults(system, result, 20);
        printNextSteps(system, result);
        return result.status === "failed" ? 1 : 0;
      }

      case "tailor": {
        const [runId, jobId] = args._;
        if (!runId || !jobId) {
          console.error("tailor needs a search run id and a job id");
          return 2;
        }
        const result = await system.tailor({ searchRunId: runId, jobId });
        if (result.board.render) {
          const r = result.board.render;
          console.log(`\nPDF   ${r.pdf_path}`);
          console.log(`DOCX  ${r.docx_path}`);
          console.log(
            `ATS   ${r.ats_check.passed ? "round trip passed" : "ROUND TRIP FAILED"} ` +
              `(${r.ats_check.extracted_chars} chars extracted)`,
          );
        }
        printNextSteps(system, result);
        return result.status === "failed" ? 1 : 0;
      }

      case "resume": {
        const runId = args._[0];
        if (!runId) {
          console.error("resume needs a run id");
          return 2;
        }
        const answers: Record<string, string> = {};
        for (const pair of args.repeated.answer ?? []) {
          const eq = pair.indexOf("=");
          if (eq < 0) {
            console.error(`--answer expects <escalation-id>=<text>, got "${pair}"`);
            return 2;
          }
          answers[pair.slice(0, eq)] = pair.slice(eq + 1);
        }
        const result = await system.resume({ runId, answers });
        printNextSteps(system, result);
        return 0;
      }

      case "discover": {
        if (args._.length === 0) {
          console.error("discover needs at least one company or domain");
          return 2;
        }
        const { verified, unresolved } = await system.discover(args._);
        console.log(`\n${verified} verified, ${unresolved} unresolved. Registry now holds ${store.listSources({ status: "verified" }).length} verified sources.`);
        return 0;
      }

      case "runs": {
        for (const r of store.listRuns(Number(args.flags.limit ?? 20))) {
          console.log(`${r.id}  ${r.status.padEnd(14)} ${r.created_at}  ${r.brief.slice(0, 60)}`);
        }
        return 0;
      }

      case "results": {
        const runId = args._[0];
        if (!runId) {
          console.error("results needs a run id");
          return 2;
        }
        const run = store.getRun(runId);
        if (!run) {
          console.error(`run ${runId} not found`);
          return 1;
        }
        printResults(system, { board: run.blackboard } as unknown as RunResult, Number(args.flags.limit ?? 20));
        return 0;
      }

      case "trace": {
        const runId = args._[0];
        if (!runId) {
          console.error("trace needs a run id");
          return 2;
        }
        const trace = store.listTrace(runId);
        if (trace.length === 0) {
          console.error(`no trace for run '${runId}'. Run \`job-search-aiagent runs\` to list known runs.`);
          return 1;
        }
        printTrace(trace);
        return 0;
      }

      case "ask": {
        const runId = args._[0];
        if (!runId) {
          console.error("ask needs a run id");
          return 2;
        }
        const open = store.listEscalations(runId, true);
        if (open.length === 0) {
          console.log("No open questions for this run.");
          return 0;
        }
        for (const e of open) {
          console.log(`\n${e.id}  [${e.kind}${e.blocking ? ", blocking" : ""}]`);
          console.log(`  ${e.question}`);
          if (e.options.length) console.log(`  options: ${e.options.join(" | ")}`);
        }
        console.log(`\nAnswer with:  job-search-aiagent resume ${runId} --answer <id>="your answer"`);
        return 0;
      }

      case "feedback": {
        const [jobId, editKind, verdict] = args._;
        if (!jobId || !editKind || (verdict !== "accept" && verdict !== "reject")) {
          console.error("feedback needs <job-id> <edit-kind> accept|reject");
          return 2;
        }
        store.recordEditFeedback({
          id: `${jobId}:${editKind}:${Date.now()}`,
          job_id: jobId,
          edit_kind: editKind,
          accepted: verdict === "accept",
          note: null,
        });
        console.log("Recorded. The Memory Curator will fold this into the next run.");
        return 0;
      }

      case "forget": {
        const company = args._[0];
        if (!company) {
          console.error("forget needs a company name as shown by `job-search-aiagent sources`");
          return 2;
        }
        const removed = store.forgetSource(company);
        console.log(removed ? `Removed '${company}' from the registry.` : `No source named '${company}'.`);
        return removed ? 0 : 1;
      }

      case "sources": {
        const status = str(args.flags.status) as "verified" | "unresolved" | "dead" | undefined;
        const list = store.listSources(status ? { status } : {});
        for (const s of list) {
          const health = s.health.attempts
            ? `${s.health.attempts - s.health.failures}/${s.health.attempts} ok, ${Math.round(s.health.avg_latency_ms)}ms avg`
            : "never fetched";
          const flag = s.status === "verified" && s.confidence < 0.9 ? " ?" : "  ";
          const off = s.enabled ? "" : "  [off]";
          console.log(
            `${s.status.padEnd(11)}${flag}${s.ats_type.padEnd(16)} ${s.company.padEnd(26)} ${health}${off}` +
              (s.reason ? `\n              ${s.reason}` : ""),
          );
        }
        const off = list.filter((s) => !s.enabled).length;
        console.log(`\n${list.length} source(s)${off ? `, ${off} switched off and skipped when harvesting` : ""}`);
        return 0;
      }

      /* Switching a company off keeps its verified board and health history —
         unlike `forget`, which deletes it and costs a re-discovery to undo. */
      case "enable":
      case "disable": {
        const wanted = command === "enable";
        const names = argv.slice(1).filter((a) => !a.startsWith("--"));
        if (names.length === 0) {
          console.error(`${command} needs at least one company name`);
          return 2;
        }
        let changed = 0;
        for (const name of names) {
          const src = store.findSourceByCompany(name);
          if (!src) {
            console.error(`no source named '${name}'`);
            continue;
          }
          store.setSourceEnabled(src.id, wanted);
          changed++;
          console.log(`${src.company}: ${wanted ? "will be searched" : "switched off"}`);
        }
        const on = store.listSources({ status: "verified", enabled: true, limit: 10_000 }).length;
        console.log(`\n${changed} changed. ${on} verified source(s) will be searched.`);
        return changed > 0 ? 0 : 1;
      }

      default:
        console.error(`unknown command '${command}'\n`);
        console.log(USAGE);
        return 2;
    }
  } finally {
    system.close();
  }
}

function printResults(system: JobSearchAgent, result: RunResult, limit: number): void {
  const board = result.board;
  const ids = board.ranked_job_ids?.length ? board.ranked_job_ids : board.matches.map((m) => m.job_id);
  if (!ids?.length) {
    console.log("\nNo ranked results.");
    return;
  }
  console.log(`\n${ids.length} ranked result(s)\n`);
  for (const id of ids.slice(0, limit)) {
    const job = system.store.getJob(id);
    const m = board.matches.find((x) => x.job_id === id);
    if (!job || !m) continue;
    console.log(`${String(m.overall).padStart(3)}%  ${job.title} — ${job.company}  (${job.location ?? "location unstated"})`);
    for (const d of m.dimensions) console.log(`        ${d.dimension.padEnd(18)} ${String(d.score).padStart(3)}  ${d.reason}`);
    const flags = system.store.getAnalysis(id)?.red_flags ?? [];
    if (flags.length) console.log(`        BEFORE YOU APPLY: ${flags.join(" · ")}`);
    if (m.gaps.length) console.log(`        gaps: ${m.gaps.join(", ")}`);
    if (m.reconciliation) {
      console.log(
        `        reconciled: composite ${m.reconciliation.composite_before} vs holistic ` +
          `${m.reconciliation.holistic_before} -> ${m.reconciliation.resolved} (${m.reconciliation.note})`,
      );
    }
    console.log(`        ${job.url}`);
    console.log(`        job id: ${id}\n`);
  }
}

function printNextSteps(system: JobSearchAgent, result: RunResult): void {
  // From the store: the result carries every escalation the run raised,
  // answered or not, so counting those over-reports what is still open.
  const open = system.store.listEscalations(result.runId, true);
  if (open.length) {
    console.log(`\n${open.length} open question(s). See:  job-search-aiagent ask ${result.runId}`);
  }
  if (result.stopReason) console.log(`\nStopped early: ${result.stopReason}`);
  console.log(`\nTrace:  job-search-aiagent trace ${result.runId}`);
}

function str(v: string | boolean | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

main()
  .then((code) => process.exit(code))
  .catch(async (err) => {
    console.error(`\n${(err as Error).stack ?? String(err)}`);
    await fs.writeFile(path.join(env.outDir, "last-error.txt"), String((err as Error).stack ?? err)).catch(() => {});
    process.exit(1);
  });
