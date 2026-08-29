import { sha1 } from "../tools/embed.js";
import { fetchJson, fetchText } from "../tools/http.js";
import { findCareerLinks } from "../tools/parse/html.js";
import { webSearch } from "../tools/search.js";
import { adapterFor, classifyUrl } from "../tools/ats/adapters.js";
import { parseCards } from "../tools/ats/linkedin.js";
import { SourceRecord } from "../schemas/source.js";
import type { AtsType } from "../schemas/source.js";
import { type AgentContext, type AgentInput, type AgentOutput, emptyOutput, escalation } from "./types.js";

/**
 * §2.3 Source Discovery. Given a company name or domain, find the real career
 * page, classify which ATS runs it, verify by pulling one job, and commit to
 * the permanent registry — or mark `unresolved` with a reason, never a bare
 * failure.
 *
 * The registry is an asset that compounds, so this is written to run
 * standalone and continuously (see `bin: discover`), not only inside a search.
 */
/**
 * Board families worth searching, grouped so one query covers several. Each
 * group is one web search, so the grouping is a cost decision as much as a
 * coverage one.
 */
const BOARD_DOMAINS: string[][] = [
  ["boards.greenhouse.io", "job-boards.greenhouse.io"],
  ["jobs.lever.co", "jobs.ashbyhq.com"],
  ["careers.smartrecruiters.com", "apply.workable.com"],
  // Workday hosts most large employers — banks, consultancies, pharma — which
  // is exactly where a compliance or operations search needs to look, and it
  // sat in the third group where the default cap never reached it.
  ["myworkdayjobs.com", "recruitee.com"],
];

/**
 * Phrasings to search each board family with.
 *
 * One query per family found the same handful of employers every time. The
 * number of searches used to be `slice(0, maxSearches)` over the families, so
 * asking for more searches could never do more than walk further down a
 * four-item list — and with the default of 2, Workday was never searched at
 * all. Crossing families with phrasings makes "search harder" mean something.
 */
const QUERY_SHAPES: Array<(role: string, place: string) => string> = [
  (role, place) => `"${role}" jobs ${place}`,
  (role, place) => `${role} hiring ${place} apply`,
  (role, place) => `${role} careers ${place} open positions`,
];

/**
 * Finds employers by *role*, rather than requiring someone to name them.
 *
 * A registry you have to fill in by hand does not scale, and that is the honest
 * gap against an aggregator: they have every company, this had the ones you
 * remembered. Searching the open web for ATS board URLs matching the role and
 * place closes it — the boards are public, the search is a normal search, and
 * every hit is still verified by pulling a real posting before it is trusted.
 */
export async function discoverByRole(
  ctx: AgentContext,
  opts: { role: string; locations: string[]; maxSearches?: number; signal?: AbortSignal },
): Promise<{ added: SourceRecord[]; unresolved: number; searches: number }> {
  const added: SourceRecord[] = [];
  const place = opts.locations[0] ?? "";
  // Every family, then a second and third phrasing across them, so the budget
  // is spent widening coverage rather than repeating one query.
  const plan: Array<{ domains: string[]; shape: number }> = [];
  for (let shape = 0; shape < QUERY_SHAPES.length; shape++) {
    for (const domains of BOARD_DOMAINS) plan.push({ domains, shape });
  }
  const groups = plan.slice(0, opts.maxSearches ?? BOARD_DOMAINS.length);
  const seen = new Set<string>();
  let unresolved = 0;

  for (const { domains, shape } of groups) {
    const query =
      `${QUERY_SHAPES[shape]!(opts.role, place)} ` + domains.map((d) => `site:${d}`).join(" OR ");
    const hits = await webSearch(query, { maxUses: 3, signal: opts.signal });

    for (const hit of hits) {
      const cls = classifyUrl(hit.url);
      if (!cls) continue;
      const key = `${cls.ats_type}:${cls.slug}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // Already known — the registry compounds, so most hits are repeats
      // after a few runs, and re-verifying them would be pure cost.
      const id = sha1(`source|${cls.slug.split("|")[0]!.toLowerCase()}`);
      if (ctx.store.getSource(id)) continue;

      const verified = await verify(cls.ats_type, cls.slug, opts.signal);
      if (!verified.ok) {
        unresolved++;
        continue;
      }
      const rec: SourceRecord = {
        id,
        company: verified.company || cls.slug.split("|")[0]!,
        enabled: true,
        domain: null,
        career_url: hit.url.split("?")[0]!,
        ats_type: cls.ats_type,
        ats_slug: cls.slug,
        confidence: 0.8,
        status: "verified",
        reason: `found by searching for "${opts.role}" boards`,
        verified_at: new Date().toISOString(),
        health: { attempts: 0, failures: 0, last_ok_at: null, last_error: null, avg_latency_ms: 0 },
      };
      ctx.store.upsertSource(rec);
      added.push(rec);
    }
  }

  return { added, unresolved, searches: groups.length };
}

export async function sourceDiscovery(ctx: AgentContext, input: AgentInput): Promise<AgentOutput> {
  const out = emptyOutput();
  // From the blackboard, never from `params.note` — that field is the
  // planner's, and reading it here turned a planning hint into a company name.
  const targets = input.board.discover_targets;

  const discovered: string[] = [];
  const unresolved: string[] = [];

  // Role-driven discovery: find employers nobody named. Runs when the caller
  // asked for it, which the console defaults to whenever the registry is thin.
  if (input.board.auto_discover) {
    const role =
      input.board.profile?.canonical_titles[0] ?? input.board.brief.split(/[,.]/)[0]?.trim() ?? "";
    if (role) {
      const found = await discoverByRole(ctx, {
        role,
        locations: input.board.preferences.locations,
        // Undefined, not 2 — let discoverByRole's own default cover every
        // board family. A cap of 2 here silently undid the widening.
        maxSearches: input.params.limit ?? undefined,
        signal: ctx.signal,
      });
      for (const rec of found.added) {
        discovered.push(rec.id);
        ctx.emit({
          type: "node_progress",
          node_id: input.node.id,
          message: `found ${rec.company} (${rec.ats_type}) by searching for "${role}" boards`,
        });
      }
      if (found.added.length === 0 && targets.length === 0) {
        out.summary = `searched ${found.searches} board families for "${role}"; no new employers`;
      }
    }
  }

  if (targets.length === 0 && discovered.length === 0) {
    out.summary = out.summary || "no discovery targets in this run; registry unchanged";
    out.board = { discovered_source_ids: [], source_ids: [] };
    return out;
  }
  for (const target of targets.slice(0, input.params.limit ?? 10)) {
    const rec = await discoverOne(ctx, target);
    ctx.store.upsertSource(rec);
    if (rec.status === "verified") {
      discovered.push(rec.id);
      ctx.emit({ type: "node_progress", node_id: input.node.id, message: `registry += ${rec.company} (${rec.ats_type})` });
    } else {
      unresolved.push(`${rec.company}: ${rec.reason ?? "unresolved"}`);
    }
  }

  if (unresolved.length > 0 && discovered.length === 0) {
    out.escalations.push(
      escalation(input.node.id, "source_discovery", {
        question:
          `I could not find a verifiable careers page for ${targets.slice(0, 3).join(", ")}. ` +
          `Do you have the direct link, or should I skip these companies?`,
        kind: "source_unresolved",
        context: { unresolved },
        options: ["Skip these companies", "I'll paste the link"],
        blocking: false,
      }),
    );
  }

  out.board = { discovered_source_ids: discovered, source_ids: discovered };
  out.summary = `${discovered.length} career pages verified and committed, ${unresolved.length} unresolved`;
  return out;
}

export function parseTargets(note: string | null): string[] {
  if (!note) return [];
  return note
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The §2.3 loop, made explicit: candidates → classify → verify → commit. */
export async function discoverOne(ctx: AgentContext, target: string): Promise<SourceRecord> {
  const host = target.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
  const domain = /\./.test(host) ? host : null;
  // "acme.wd1.myworkdayjobs.com" is a board address, not a company name; the
  // company is the first label.
  const company = host.split(".")[0] ?? host;
  const base: SourceRecord = {
    id: sha1(`source|${company.toLowerCase()}`),
    company: domain ? domain.split(".")[0]! : target,
    enabled: true,
    domain,
    career_url: null,
    ats_type: "unknown",
    ats_slug: null,
    confidence: 0,
    status: "unresolved",
    reason: null,
    verified_at: null,
    health: { attempts: 0, failures: 0, last_ok_at: null, last_error: null, avg_latency_ms: 0 },
  };

  const candidates = await gatherCandidates(target, domain, ctx.signal);
  if (candidates.length === 0) {
    return { ...base, reason: "no candidate career URLs found (search, homepage crawl and slug probes all empty)" };
  }

  // A LinkedIn source is a deliberate choice with a terms-of-service cost
  // attached (see tools/ats/linkedin.ts), so it may only be added by naming it
  // outright. Without this, searching for any employer's careers page could
  // turn up a linkedin.com/jobs link and opt the user in on their behalf.
  const askedForLinkedIn = /linkedin\.com/i.test(target);

  for (const url of candidates) {
    const cls = classifyUrl(url);
    if (!cls) continue;
    if (cls.ats_type === "linkedin" && !askedForLinkedIn) continue;
    // Verification is the whole point: an ATS URL that yields no job is a
    // guess, and a guess in a permanent registry poisons every future run.
    const verified = await verify(cls.ats_type, cls.slug, ctx.signal);
    if (verified.ok) {
      // The board is real, but a slug probe cannot prove it is the *right*
      // company: the Workable account "zepto" belongs to ZeptoLab, a game
      // studio. Record the name the board reports and drop confidence when it
      // is not the name that was asked for, so a mismatch is visible rather
      // than silently trusted.
      const asked = base.company.toLowerCase().replace(/[^a-z0-9]/g, "");
      const got = (verified.company || base.company).toLowerCase().replace(/[^a-z0-9]/g, "");
      const namesAgree = got === asked || got.startsWith(asked) || asked.startsWith(got);
      return {
        ...base,
        company: verified.company || base.company,
        career_url: url,
        ats_type: cls.ats_type,
        ats_slug: cls.slug,
        confidence: namesAgree ? 0.95 : 0.5,
        status: "verified",
        reason: namesAgree
          ? null
          : `resolved to "${verified.company}" from the slug "${cls.slug}" — check this is the company you meant`,
        verified_at: new Date().toISOString(),
      };
    }
  }

  // Nothing classified; fall back to the generic schema.org path, still code.
  for (const url of candidates.slice(0, 3)) {
    const res = await fetchText(url, { signal: ctx.signal, retries: 1 });
    if (!res.ok) continue;
    if (/"@type"\s*:\s*"?JobPosting/.test(res.body)) {
      return {
        ...base,
        career_url: url,
        ats_type: "jsonld",
        ats_slug: null,
        confidence: 0.6,
        status: "verified",
        verified_at: new Date().toISOString(),
      };
    }
  }

  return {
    ...base,
    career_url: candidates[0] ?? null,
    reason: `found ${candidates.length} candidate URL(s) but none exposed a readable job listing`,
  };
}

async function gatherCandidates(target: string, domain: string | null, signal?: AbortSignal): Promise<string[]> {
  const urls = new Set<string>();

  // A URL the user pasted is the strongest candidate there is — they have
  // already done the finding. Without this, pasting a board's own address made
  // discovery go and look for it from scratch, and fail.
  if (/^https?:\/\//i.test(target) || /\/[a-z]/i.test(target)) {
    urls.add(target.startsWith("http") ? target : `https://${target}`);
  }

  // 1. Slug probes. Companies overwhelmingly use their own name as the board
  //    token, so this resolves most targets with no search at all.
  const slug = slugify(domain ? domain.split(".")[0]! : target);
  for (const u of [
    `https://boards.greenhouse.io/${slug}`,
    `https://jobs.lever.co/${slug}`,
    `https://jobs.ashbyhq.com/${slug}`,
    `https://apply.workable.com/${slug}`,
    `https://${slug}.recruitee.com`,
    `https://careers.smartrecruiters.com/${slug}`,
  ]) {
    urls.add(u);
  }

  // 2. Homepage crawl for career links.
  //
  // This used to run only when the caller supplied a domain, which meant
  // `discover browserstack` never crawled anything while
  // `discover browserstack.com` worked — and nobody types the second one.
  // Everything not reachable by a slug probe was therefore invisible when
  // named plainly, Workday most of all: its board address is
  // `tenant.wdN.myworkdayjobs.com/Site`, which cannot be guessed, only found
  // on the company's own careers page. BrowserStack links to a Workday board
  // with 31 live postings from a plain <a href> and still came back unresolved.
  //
  // A bare name gets a guessed homepage instead. The guess is never trusted:
  // whatever it yields is classified and verified against a real posting like
  // any other candidate, so a wrong guess costs one fetch.
  // Links the company itself publishes, as opposed to the guessed slug probes
  // above — a board address found on a company's own careers page is strong
  // evidence, where `boards.greenhouse.io/<slug>` is only a guess that happens
  // to match the URL pattern.
  const fromTheCompany: string[] = [];

  const homes = domain ? [domain] : [`${slug}.com`, `${slug}.in`, `${slug}.io`];
  for (const home of homes) {
    let reachable = false;
    for (const path of ["", "/careers", "/jobs", "/company/careers"]) {
      const res = await fetchText(`https://${home}${path}`, { signal, retries: 0 });
      if (!res.ok) continue;
      reachable = true;
      for (const link of findCareerLinks(res.body, res.url)) {
        urls.add(link);
        fromTheCompany.push(link);
      }
      if (urls.size > 20) break;
    }
    // Stop at the first domain that answers; trying `.in` after `.com` has
    // already resolved is three wasted requests per company.
    if (reachable || urls.size > 20) break;
  }

  // 3. Web search last, and only if needed: it is a billed model call. When the
  //    company's own site already links to a recognisable board there is
  //    nothing left to search for. Guessed slug probes do not count — they
  //    always match the URL pattern whether or not the board exists, so
  //    treating them as a hit would skip the search every time.
  if (!fromTheCompany.some((u) => classifyUrl(u))) {
    const hits = await webSearch(`${target} official careers page job openings`, { signal });
    for (const h of hits) urls.add(h.url);
  }

  // Rank so classified ATS URLs are verified before generic pages.
  return [...urls].sort((a, b) => Number(Boolean(classifyUrl(b))) - Number(Boolean(classifyUrl(a))));
}

/** Pull exactly one job. Cheaper than a full harvest and proves the same thing. */
async function verify(atsType: AtsType, slug: string, signal?: AbortSignal): Promise<{ ok: boolean; company: string }> {
  // Workday identifies a board by tenant, host and site, and lists over POST.
  if (atsType === "workday") {
    const [tenant, host, site] = slug.split("|");
    if (!tenant || !host || !site) return { ok: false, company: "" };
    const res = await fetchText(`https://${tenant}.${host}.myworkdayjobs.com/wday/cxs/${tenant}/${site}/jobs`, {
      signal,
      retries: 1,
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ limit: 1, offset: 0, searchText: "" }),
    });
    if (!res.ok) return { ok: false, company: "" };
    try {
      const data = JSON.parse(res.body) as { total?: number; jobPostings?: unknown[] };
      return { ok: (data.jobPostings?.length ?? 0) > 0, company: tenant };
    } catch {
      return { ok: false, company: "" };
    }
  }

  // LinkedIn has no board to probe, so verification asks it a throwaway
  // question and checks that real cards come back. One request, and it is the
  // same endpoint the adapter uses, so a pass here means the adapter works.
  if (atsType === "linkedin") {
    const res = await fetchText(
      "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=engineer&start=0",
      {
        signal,
        retries: 0,
        headers: {
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      },
    );
    if (!res.ok) return { ok: false, company: "" };
    return { ok: parseCards(res.body).length > 0, company: "LinkedIn" };
  }

  const probes: Partial<Record<AtsType, string>> = {
    greenhouse: `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`,
    lever: `https://api.lever.co/v0/postings/${slug}?mode=json&limit=1`,
    ashby: `https://api.ashbyhq.com/posting-api/job-board/${slug}`,
    workable: `https://apply.workable.com/api/v1/widget/accounts/${slug}`,
    recruitee: `https://${slug}.recruitee.com/api/offers/`,
    smartrecruiters: `https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=1`,
  };
  const url = probes[atsType];
  if (!url || !adapterFor(atsType)) return { ok: false, company: "" };

  const { ok, data } = await fetchJson<Record<string, unknown>>(url, { signal, retries: 1 });
  if (!ok || !data) return { ok: false, company: "" };

  const list = Array.isArray(data) ? data : (data.jobs ?? data.offers ?? data.content);
  const hasJobs = Array.isArray(list) && list.length > 0;
  const company = typeof data.name === "string" ? data.name : "";
  return { ok: hasJobs, company };
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}
