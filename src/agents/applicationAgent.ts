import { fetchText, resolveApplyUrl } from "../tools/http.js";
import { htmlToText } from "../tools/parse/html.js";
import { sha1 } from "../tools/embed.js";
import { classifyUrl } from "../tools/ats/adapters.js";
import { type AgentContext, type AgentInput, type AgentOutput, emptyOutput, escalation } from "./types.js";

/**
 * 2.8 Application Agent.
 *
 * Aggregator links are redirect chains that die. This resolves the true apply
 * URL, verifies it returns 200, snapshots the JD as it was on the day, records
 * exactly which resume version was sent, and advances the tracker.
 *
 * The snapshot matters more than it looks: postings are edited and pulled, and
 * six weeks later "what did the JD actually say when I applied" is the only way
 * to prepare for the interview.
 */
export async function applicationAgent(ctx: AgentContext, input: AgentInput): Promise<AgentOutput> {
  const out = emptyOutput();
  const jobId = input.params.note ?? input.board.selected_job_id;
  if (!jobId) {
    out.summary = "no job selected";
    out.degraded = "missing job";
    return out;
  }

  const job = ctx.store.getJob(jobId);
  if (!job) {
    out.summary = `job ${jobId} not in the store`;
    out.degraded = "missing job";
    return out;
  }

  // Deduped: a posting whose apply_url equals its url must not be reported
  // as two dead links.
  const candidates = [...new Set([job.apply_url, job.url].filter((u): u is string => Boolean(u)))];
  let resolved: { url: string; status: number; ok: boolean } | null = null;
  const attempts: string[] = [];

  for (const candidate of candidates) {
    const r = await resolveApplyUrl(candidate, { signal: ctx.signal });
    attempts.push(`${candidate} -> ${r.status}`);
    if (r.ok) {
      resolved = r;
      break;
    }
  }

  const render = input.board.render;
  const resumeSha = input.board.draft ? sha1(JSON.stringify(input.board.draft)) : null;

  if (!resolved) {
    ctx.store.upsertApplication({
      id: sha1(`${ctx.runId}|${jobId}`),
      run_id: ctx.runId,
      job_id: jobId,
      state: "apply_url_dead",
      apply_url: null,
      jd_snapshot: job.description_text,
      resume_sha: resumeSha,
      resume_path: render?.pdf_path ?? null,
    });
    out.escalations.push(
      escalation(input.node.id, "application_agent", {
        question:
          `Every apply link for "${job.title}" at ${job.company} is dead (${attempts.join("; ")}). ` +
          `The posting may have been pulled. Do you want me to look for it on the company's own careers page?`,
        kind: "source_unresolved",
        context: { job_id: jobId, attempts },
        options: ["Search the company page", "Skip this one"],
        blocking: false,
      }),
    );
    out.summary = `apply URL dead after ${attempts.length} attempt(s)`;
    out.degraded = "dead apply url";
    return out;
  }

  // Snapshot the JD from the resolved page when it reads as a real posting;
  // fall back to what we harvested rather than storing an error page.
  let snapshot = job.description_text;
  const page = await fetchText(resolved.url, { signal: ctx.signal, retries: 1 });
  if (page.ok) {
    const text = htmlToText(page.body);
    if (text.length > job.description_text.length * 0.5) snapshot = text;
  }

  const detected = classifyUrl(resolved.url);
  ctx.store.upsertApplication({
    id: sha1(`${ctx.runId}|${jobId}`),
    run_id: ctx.runId,
    job_id: jobId,
    state: render ? "ready_to_apply" : "url_verified",
    apply_url: resolved.url,
    jd_snapshot: snapshot,
    resume_sha: resumeSha,
    resume_path: render?.pdf_path ?? null,
  });

  out.summary =
    `apply URL verified (${resolved.status})${detected ? ` via ${detected.ats_type}` : ""}, ` +
    `JD snapshot ${snapshot.length} chars, resume ${resumeSha?.slice(0, 8) ?? "not rendered"}`;
  return out;
}
