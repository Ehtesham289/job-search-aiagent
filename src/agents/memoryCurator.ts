import { stripTitleNoise } from "../tools/ats/normalize.js";
import { tokenize } from "../tools/embed.js";
import { type AgentContext, type AgentInput, type AgentOutput, emptyOutput } from "./types.js";

/**
 * 2.9 Memory Curator. Runs at the end of a session and writes durable
 * learnings back to long-term memory: career pages found, title synonyms
 * confirmed, source health trends, which tailoring edits the user accepted.
 *
 * This is the difference between an agent system and a pipeline - the next run
 * starts from a better registry and a better synonym graph than this one did.
 * It is deliberately all code: the learnings are already structured, and
 * asking a model to summarise them would only add a way to be wrong.
 */
export async function memoryCurator(ctx: AgentContext, input: AgentInput): Promise<AgentOutput> {
  const out = emptyOutput();
  const learnings: string[] = [];

  // 1. Sources discovered this run are already committed; record the count so
  //    the trace shows the registry growing.
  if (input.board.discovered_source_ids.length) {
    learnings.push(`${input.board.discovered_source_ids.length} career pages added to the registry`);
  }

  // 2. Title synonyms, confirmed by evidence rather than by assertion. A
  //    variant that actually returned postings from a real board is worth more
  //    than one the strategist merely proposed.
  const plan = input.board.query_plan;
  let confirmedTitles = 0;
  if (plan) {
    const observedTitles = new Set(
      input.board.unique_job_ids
        .map((id) => ctx.store.getJob(id)?.title)
        .filter((t): t is string => Boolean(t))
        .map((t) => stripTitleNoise(t).toLowerCase()),
    );
    for (const variant of plan.title_variants) {
      const v = variant.toLowerCase();
      const seen = [...observedTitles].some((t) => t.includes(v) || v.includes(t));
      if (seen && v !== plan.canonical_role.toLowerCase()) {
        ctx.store.putTitleSynonym(variant, plan.canonical_role, 0.95, true);
        confirmedTitles++;
      }
    }
    if (confirmedTitles) learnings.push(`${confirmedTitles} title synonyms confirmed against real postings`);
  }

  // 3. Skill co-occurrence. Terms that keep appearing beside a canonical skill
  //    in postings for this role are candidate aliases; they enter with a low
  //    weight and are promoted only if they keep showing up.
  let skillEdges = 0;
  if (plan) {
    const canonical = new Set(plan.skill_signature.map((s) => s.toLowerCase()));
    const counts = new Map<string, number>();
    for (const id of input.board.analyzed_job_ids) {
      const analysis = ctx.store.getAnalysis(id);
      if (!analysis) continue;
      for (const kw of analysis.keywords) {
        const k = kw.toLowerCase().trim();
        if (!k || canonical.has(k)) continue;
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    }
    const threshold = Math.max(3, Math.ceil(input.board.analyzed_job_ids.length * 0.15));
    for (const [term, n] of counts) {
      if (n < threshold) continue;
      const nearest = nearestCanonical(term, plan.skill_signature);
      if (!nearest) continue;
      ctx.store.putSkillSynonym(term, nearest, 0.4);
      skillEdges++;
    }
    if (skillEdges) learnings.push(`${skillEdges} skill-graph edges proposed from co-occurrence`);
  }

  // 4. Source health trends. Already recorded per fetch; surfaced here so the
  //    trace says which sources are decaying before they go dead.
  const sources = ctx.store.listSources({ limit: 1000 });
  const failing = sources.filter((s) => s.health.attempts >= 3 && s.health.failures / s.health.attempts > 0.5);
  const dead = sources.filter((s) => s.status === "dead");
  if (failing.length) learnings.push(`${failing.length} sources failing more than half their fetches`);
  if (dead.length) learnings.push(`${dead.length} sources marked dead`);

  // 5. Which tailoring edits the user accepted or rejected. Recorded through
  //    `feedback` on the CLI; summarised here so the next gap analysis can be
  //    told which edit kinds this user actually keeps.
  const feedback = ctx.store.editFeedbackStats();
  if (feedback.length) {
    const worst = [...feedback].sort((a, b) => b.rejected - a.rejected)[0];
    if (worst && worst.rejected > 0) {
      learnings.push(`edit kind '${worst.edit_kind}' rejected ${worst.rejected}/${worst.accepted + worst.rejected} times`);
    }
  }

  out.summary = learnings.length ? learnings.join("; ") : "nothing new worth committing this run";
  return out;
}

/** Cheap lexical nearest-neighbour. A wrong edge at weight 0.4 costs little;
 *  a model call per candidate term would cost a great deal. */
function nearestCanonical(term: string, canonical: string[]): string | null {
  const t = new Set(tokenize(term));
  let best: string | null = null;
  let bestScore = 0;
  for (const c of canonical) {
    const cs = new Set(tokenize(c));
    let shared = 0;
    for (const x of t) if (cs.has(x)) shared++;
    const score = shared / Math.max(1, Math.min(t.size, cs.size));
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return bestScore >= 0.5 ? best : null;
}
