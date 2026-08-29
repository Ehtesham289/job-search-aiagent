import type { ProgressEvent } from "../orchestrator/events.js";
import type { TraceEntry } from "../schemas/trace.js";

/**
 * L4. Streams progress, partial results and agent traces.
 *
 * Showing the system's work is what makes a multi-minute wait read as
 * competence rather than lag, so this deliberately prints per-node lines as
 * they land rather than a spinner and a final dump.
 */
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
  dim: (s: string) => (useColor ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s: string) => (useColor ? `\x1b[1m${s}\x1b[0m` : s),
  green: (s: string) => (useColor ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s: string) => (useColor ? `\x1b[33m${s}\x1b[0m` : s),
  red: (s: string) => (useColor ? `\x1b[31m${s}\x1b[0m` : s),
  cyan: (s: string) => (useColor ? `\x1b[36m${s}\x1b[0m` : s),
};

export function createConsoleSink(opts: { verbose?: boolean } = {}) {
  let step = 0;

  return (ev: ProgressEvent): void => {
    switch (ev.type) {
      case "run_started":
        console.log(`\n${c.bold("run")} ${ev.run_id}`);
        console.log(`${c.dim(ev.brief)}\n`);
        break;

      case "plan":
        // A detail of the node above it, not a step of its own.
        console.log(
          c.dim(`     · ${ev.nodes} nodes, ${ev.parallel_branches} max parallel, budget ${ev.budget}`),
        );
        break;

      case "graph":
        // The terminal already prints the plan summary; the lattice is a
        // web-client concern.
        break;

      case "node_started":
        if (opts.verbose) console.log(`${c.dim(`   ${ev.agent} starting…`)}`);
        break;

      case "node_progress":
        console.log(c.dim(`     · ${ev.message}`));
        break;

      case "node_finished": {
        const icon =
          ev.status === "done" ? c.green("ok") : ev.status === "skipped" ? c.yellow("skip") : c.red("fail");
        const cost = ev.usage.cost_usd > 0 ? c.dim(` $${ev.usage.cost_usd.toFixed(4)}`) : "";
        const model = ev.model ? c.dim(` ${shortModel(ev.model)}`) : c.dim(" code");
        console.log(
          `${pad(++step)} ${c.bold(padRight(ev.agent, 18))} ${c.dim("->")} ${ev.summary}  ` +
            `[${icon}${model}${cost} ${c.dim(`${ev.duration_ms}ms`)}]`,
        );
        break;
      }

      case "partial_results":
        console.log(`\n${c.bold(ev.label)}`);
        for (const item of ev.items) console.log(`   ${item}`);
        console.log("");
        break;

      case "escalation":
        console.log(
          `${c.yellow("   ? ")}${c.bold(ev.escalation.question)}` +
            (ev.escalation.options.length ? c.dim(`\n     options: ${ev.escalation.options.join(" | ")}`) : "") +
            c.dim(`\n     (id ${ev.escalation.id}${ev.escalation.blocking ? ", blocking" : ""})`),
        );
        break;

      case "replan":
        console.log(`${c.cyan("   ~ replan")} ${ev.reason} ${c.dim(`-> +${ev.added_nodes.join(", ")}`)}`);
        break;

      case "budget":
        if (opts.verbose) {
          console.log(
            c.dim(
              `     budget: $${ev.spent_usd.toFixed(4)}/$${ev.limit_usd}, ` +
                `${ev.llm_calls} calls, ${Math.round(ev.elapsed_ms / 1000)}s`,
            ),
          );
        }
        break;

      case "run_finished":
        console.log(`\n${c.bold(ev.status.toUpperCase())} — ${ev.summary}`);
        if (ev.skipped.length) {
          // Never silently truncate: what did not happen is part of the result.
          console.log(c.yellow(`\nNot finished:`));
          for (const s of ev.skipped) console.log(c.yellow(`   - ${s}`));
        }
        break;
    }
  };
}

/** The full trace, for debugging and for measuring which agents earn their cost. */
export function printTrace(trace: TraceEntry[]): void {
  const w = { agent: 20, kind: 16 };
  console.log(
    c.bold(
      `${padRight("#", 4)}${padRight("agent", w.agent)}${padRight("kind", w.kind)}` +
        `${padRight("model", 18)}${padRight("status", 10)}${padRight("ms", 8)}${padRight("$", 10)}summary`,
    ),
  );
  let total = 0;
  trace.forEach((t, i) => {
    total += t.usage.cost_usd;
    console.log(
      `${padRight(String(i + 1), 4)}${padRight(t.agent, w.agent)}${padRight(t.kind, w.kind)}` +
        `${padRight(t.model ? shortModel(t.model) : "-", 18)}${padRight(t.status, 10)}` +
        `${padRight(String(Math.round(t.duration_ms)), 8)}${padRight(t.usage.cost_usd.toFixed(5), 10)}${t.output_summary}` +
        (t.validation_failures ? c.yellow(`  [${t.validation_failures} schema repair(s)]`) : "") +
        (t.retries ? c.yellow(`  [${t.retries} retr${t.retries === 1 ? "y" : "ies"}]`) : "") +
        (t.error ? c.red(`  ERROR: ${t.error}`) : ""),
    );
  });
  console.log(c.bold(`\ntotal $${total.toFixed(5)} across ${trace.length} nodes`));

  // Which agents actually earn their cost.
  const byAgent = new Map<string, { calls: number; cost: number; ms: number }>();
  for (const t of trace) {
    const a = byAgent.get(t.agent) ?? { calls: 0, cost: 0, ms: 0 };
    a.calls++;
    a.cost += t.usage.cost_usd;
    a.ms += t.duration_ms;
    byAgent.set(t.agent, a);
  }
  console.log(c.bold(`\nby agent`));
  for (const [agent, a] of [...byAgent].sort((x, y) => y[1].cost - x[1].cost)) {
    console.log(`   ${padRight(agent, 22)} ${a.calls} node(s)  $${a.cost.toFixed(5)}  ${Math.round(a.ms)}ms`);
  }
}

function shortModel(m: string): string {
  return m.replace(/^scripted:/, "~").replace(/^claude-/, "");
}

function pad(n: number): string {
  return c.dim(String(n).padStart(2, " "));
}

function padRight(s: string, n: number): string {
  return s.length >= n ? `${s.slice(0, n - 1)} ` : s.padEnd(n, " ");
}
