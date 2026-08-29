import { fetchText, sleep } from "../http.js";
import { htmlToText } from "../parse/html.js";
import { makeJob } from "./normalize.js";
import type { AtsAdapter, HarvestContext, HarvestOutcome, HarvestQuery } from "./types.js";
import type { JobPosting } from "../../schemas/job.js";

/**
 * LinkedIn, through the endpoint its own logged-out job page calls.
 *
 * Every other adapter here enumerates one employer's board. This one is a
 * different shape: LinkedIn has no board to enumerate, only a search to ask,
 * so it is the first adapter that needs the run's query. That is what
 * `HarvestQuery` exists for.
 *
 * ── What this is, precisely ────────────────────────────────────────────────
 * `/jobs-guest/jobs/api/seeMoreJobPostings/search` returns the same HTML job
 * cards a signed-out browser is served. No account, no cookie, no session, no
 * token, and nothing here defeats a bot check — if LinkedIn answers with a 429
 * or a challenge, this stops and reports it rather than working around it.
 *
 * ── What it costs the user ─────────────────────────────────────────────────
 * linkedin.com/robots.txt is `User-agent: *` / `Disallow: /`, with no carve-out
 * for this path. Reading it at personal scale is a terms-of-service breach even
 * though the data is public and unauthenticated. That is a real cost and it is
 * the user's to weigh, so this source is opt-in: it is never auto-discovered,
 * and it only harvests when someone has deliberately added it to the registry.
 *
 * ── Why it is careful ──────────────────────────────────────────────────────
 * Politeness is enforced centrally, by the ~2.6s host interval in http.ts, so
 * this file cannot accidentally hammer the host. On top of that:
 *   - requests are sequential, never fanned out;
 *   - a 429 stops the whole harvest immediately and is never retried, because
 *     there it means "stop", not "wait";
 *   - descriptions are fetched only for cards that already look relevant, so
 *     the expensive half of the work is bounded by the query, not the board;
 *   - the abort signal is honoured between every request, and whatever was
 *     collected up to that point is returned rather than thrown away.
 */

const SEARCH = "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search";

/** Cards per response, fixed by the endpoint. */
const PAGE = 10;

/**
 * A browser user-agent, because the endpoint serves a different (empty) page
 * without one. This is not an attempt to look like a person: the request rate
 * is the honest signal of what this is, and it is set to something no person
 * would object to.
 */
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const HEADERS = {
  "user-agent": UA,
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
};

export interface LinkedInCard {
  jobId: string;
  title: string;
  company: string;
  location: string | null;
  url: string;
  postedAt: string | null;
}

/* ── parsing ──────────────────────────────────────────────────────────────
 * The response is a bare list of <li> cards, not a document. Cheerio would
 * work, but the shape here is small and fixed enough that splitting on the
 * card boundary and reading four fields is clearer than a selector chain —
 * and it degrades to "skip this card" rather than throwing when LinkedIn
 * changes a class name.
 */

export function parseCards(html: string): LinkedInCard[] {
  const out: LinkedInCard[] = [];
  // Cards are delimited by the link that wraps each one.
  const chunks = html.split(/<div class="base-card/).slice(1);

  for (const chunk of chunks) {
    const url = first(chunk, /href="(https:\/\/[a-z.]*linkedin\.com\/jobs\/view\/[^"?]+)/i);
    if (!url) continue;
    // The numeric id is the last dash-separated segment of the slug.
    const jobId = /-(\d+)$/.exec(url)?.[1];
    if (!jobId) continue;

    // The visible title is in a <span class="sr-only"> inside the card; the
    // <h3> carries a truncated form.
    const title = decode(first(chunk, /<span class="sr-only">\s*([\s\S]*?)\s*<\/span>/));
    const company = decode(first(chunk, /hidden-nested-link[^>]*>\s*([\s\S]*?)\s*<\/a>/));
    const location = decode(first(chunk, /job-search-card__location">\s*([\s\S]*?)\s*<\/span>/));
    const postedAt = first(chunk, /datetime="(\d{4}-\d{2}-\d{2})"/);

    if (!title || !company) continue;
    out.push({
      jobId,
      title: strip(title),
      company: strip(company),
      location: location ? strip(location) : null,
      url,
      postedAt: postedAt ? `${postedAt}T00:00:00.000Z` : null,
    });
  }
  return out;
}

/** The description lives in one block on the public job page. */
export function parseDescription(html: string): string {
  const m = /show-more-less-html__markup[^>]*>([\s\S]*?)<\/div>/i.exec(html);
  return m?.[1] ? htmlToText(decode(m[1])) : "";
}

function first(s: string, re: RegExp): string {
  return re.exec(s)?.[1] ?? "";
}

function strip(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function decode(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/* ── relevance ────────────────────────────────────────────────────────────
 * A cheap title check, used only to decide which cards are worth a second
 * request. It is deliberately generous — the real filtering is the funnel in
 * §2.6, and being strict here would drop jobs before they were ever scored.
 */
export function looksRelevant(title: string, titles: string[]): boolean {
  if (titles.length === 0) return true;
  const t = title.toLowerCase();
  return titles.some((want) => {
    const words = want.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    if (words.length === 0) return t.includes(want.toLowerCase());
    // Any substantial word from the wanted title appearing in the posting's.
    return words.some((w) => t.includes(w));
  });
}

/** `Bengaluru, Karnataka, India` reads better to the endpoint than `Bengaluru`. */
function searchLocation(q: HarvestQuery | undefined): string {
  return q?.locations[0] ?? "";
}

export const linkedin: AtsAdapter = {
  type: "linkedin",
  matches(url) {
    // Any LinkedIn jobs URL resolves to the one search source; there is no
    // per-company slug to recover, so the slug is a fixed marker.
    return /linkedin\.com\/jobs/i.test(url) ? { slug: "search" } : null;
  },

  async harvest(ctx: HarvestContext): Promise<HarvestOutcome> {
    const started = Date.now();
    const q = ctx.query;
    if (!q || q.titles.length === 0) {
      return {
        jobs: [],
        ok: false,
        error: "linkedin is a search source and this run has no query plan",
        latencyMs: 0,
      };
    }

    const location = searchLocation(q);
    // Two title variants is the useful ceiling: the endpoint's own matching is
    // loose, so a third mostly returns what the first two already did, at the
    // cost of a third of the time budget.
    const terms = q.titles.slice(0, 2);

    const cards = new Map<string, LinkedInCard>();
    let stopped: string | null = null;
    let searches = 0;

    outer: for (const term of terms) {
      for (let start = 0; start < SEARCH_PAGES_PER_TERM * PAGE; start += PAGE) {
        if (ctx.signal?.aborted) {
          stopped = "run deadline reached";
          break outer;
        }
        // Searching is cheap in cards and expensive in clock. Every page spent
        // here is a description not fetched, and a card without a description
        // is worth nothing downstream — so the search phase is capped hard.
        if (searches >= SEARCH_BUDGET) break outer;
        searches++;

        const url =
          `${SEARCH}?keywords=${encodeURIComponent(term)}` +
          (location ? `&location=${encodeURIComponent(location)}` : "") +
          (q.remoteOk ? "&f_WT=2" : "") +
          `&start=${start}`;

        // retries:0 — a 429 here is a stop signal, and retrying it is exactly
        // the behaviour that turns a rate limit into a block.
        const res = await fetchText(url, { signal: ctx.signal, retries: 0, headers: HEADERS });

        if (res.status === 429) {
          stopped = "LinkedIn rate-limited the search (429); stopped rather than retrying";
          break outer;
        }
        if (!res.ok) {
          // 400 past the end of the result set is how this endpoint says
          // "no more", so it ends this term rather than the harvest.
          if (res.status === 400) break;
          stopped = res.error ?? `HTTP ${res.status}`;
          break outer;
        }

        const page = parseCards(res.body);
        if (page.length === 0) break;
        for (const c of page) if (!cards.has(c.jobId)) cards.set(c.jobId, c);
        // A short page is the last page.
        if (page.length < PAGE) break;
      }
    }

    if (cards.size === 0) {
      return {
        jobs: [],
        ok: stopped === null,
        error: stopped ?? "no cards returned for this query",
        latencyMs: Date.now() - started,
      };
    }

    // Only relevant cards earn a description fetch. Each one is a request, and
    // this is where the time goes.
    const relevant = [...cards.values()].filter((c) => looksRelevant(c.title, q.titles));
    const shortlist = (relevant.length > 0 ? relevant : [...cards.values()]).slice(0, DESCRIPTION_BUDGET);

    const jobs: JobPosting[] = [];
    for (const card of shortlist) {
      if (ctx.signal?.aborted) {
        stopped ??= "run deadline reached during description fetch";
        break;
      }
      const res = await fetchText(`https://www.linkedin.com/jobs/view/${card.jobId}`, {
        signal: ctx.signal,
        retries: 0,
        headers: HEADERS,
      });
      if (res.status === 429) {
        stopped = "LinkedIn rate-limited the description fetch (429); stopped rather than retrying";
        break;
      }
      const description = res.ok ? parseDescription(res.body) : "";
      // Only postings that actually carry text are emitted.
      //
      // The first version returned every card and let the funnel sort it out,
      // on the reasoning that title and location are enough for the hard
      // filter. They are not: the filter also drops anything under 200
      // characters of description, because a job with no text cannot be
      // scored honestly. So 225 LinkedIn cards became 225 drops, and the
      // source contributed nothing to a single result while looking perfectly
      // healthy in the registry.
      if (description.trim().length >= MIN_DESCRIPTION) jobs.push(toPosting(ctx, card, description));
    }

    const dropped = cards.size - jobs.length;
    const note =
      stopped ??
      (dropped > 0
        ? `${jobs.length} of ${cards.size} cards hydrated within the deadline; ` +
          `the rest carry no description and were not emitted`
        : undefined);

    return {
      jobs,
      ok: true,
      // `ok: true` with an error set is how a partial harvest reports itself:
      // the jobs are real, and the note says what was not finished.
      error: note,
      latencyMs: Date.now() - started,
    };
  },
};

/**
 * The clock, spent deliberately.
 *
 * Every request to LinkedIn waits out a ~2.6s host interval, and the
 * harvester abandons a source at its 45s fan-in deadline — so this adapter
 * gets roughly 16 requests per run, total, and how they are divided decides
 * how many usable jobs come back.
 *
 * Search pages are the cheap half and the tempting one: five pages returns
 * fifty cards. But a card without a description is dropped by the funnel, so
 * cards are not the unit that matters — hydrated postings are. Hence a small
 * search budget and everything else spent on descriptions.
 */
const SEARCH_BUDGET = 6;
const SEARCH_PAGES_PER_TERM = 3;
// Raised with the harvest deadline: 120s at a ~2.6s interval is roughly 45
// requests, so the description budget is what now decides the yield rather
// than the clock running out mid-fetch.
const DESCRIPTION_BUDGET = 32;

/** The hard filter's own floor; matching it here avoids emitting sure drops. */
const MIN_DESCRIPTION = 200;

function toPosting(ctx: HarvestContext, card: LinkedInCard, description: string): JobPosting {
  return makeJob({
    externalId: card.jobId,
    sourceId: ctx.source.id,
    atsType: "linkedin",
    // The employer is per-card here, not per-source: one LinkedIn source
    // yields postings from many companies.
    company: card.company,
    title: card.title,
    location: card.location,
    postedAt: card.postedAt,
    url: card.url,
    applyUrl: card.url,
    descriptionHtml: null,
    descriptionText: description,
  });
}
