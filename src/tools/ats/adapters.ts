import pLimit from "p-limit";
import { fetchJson, fetchText } from "../http.js";
import { extractJsonLdJobs, htmlToText, jsonLdLocation } from "../parse/html.js";
import { makeJob } from "./normalize.js";
import { linkedin } from "./linkedin.js";
import type { AtsAdapter, HarvestContext, HarvestOutcome } from "./types.js";
import type { JobPosting } from "../../schemas/job.js";

/* Each adapter is pure deterministic code (§2.4): fetch the board's public
 * endpoint, map its shape onto JobPosting. No model is involved, and a source
 * that fails returns `ok:false` rather than throwing — one dead board must
 * never fail a run. */

function fail(err: string, latencyMs = 0): HarvestOutcome {
  return { jobs: [], ok: false, error: err, latencyMs };
}

export const greenhouse: AtsAdapter = {
  type: "greenhouse",
  matches(url) {
    const m =
      /(?:boards|job-boards)\.greenhouse\.io\/(?:embed\/job_board\?for=)?([a-z0-9_-]+)/i.exec(url) ??
      /boards-api\.greenhouse\.io\/v1\/boards\/([a-z0-9_-]+)/i.exec(url);
    return m?.[1] ? { slug: m[1] } : null;
  },
  async harvest(ctx: HarvestContext) {
    const slug = ctx.source.ats_slug;
    if (!slug) return fail("greenhouse source has no board token");
    const url = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`;
    const { ok, data, res } = await fetchJson<{ jobs: GhJob[] }>(url, { signal: ctx.signal });
    if (!ok || !data) return fail(res.error ?? `HTTP ${res.status}`, res.latencyMs);
    const jobs = (data.jobs ?? []).slice(0, ctx.limit).map((j) =>
      makeJob({
        externalId: String(j.id),
        sourceId: ctx.source.id,
        atsType: "greenhouse",
        company: ctx.source.company,
        title: j.title ?? "",
        location: j.location?.name ?? null,
        postedAt: j.updated_at ?? null,
        url: j.absolute_url ?? url,
        applyUrl: j.absolute_url ?? null,
        descriptionHtml: decodeEntities(j.content ?? ""),
        descriptionText: htmlToText(decodeEntities(j.content ?? "")),
        department: j.departments?.[0]?.name ?? null,
      }),
    );
    return { jobs, ok: true, latencyMs: res.latencyMs };
  },
};

export const lever: AtsAdapter = {
  type: "lever",
  matches(url) {
    const m = /jobs\.lever\.co\/([a-z0-9_-]+)/i.exec(url) ?? /api\.lever\.co\/v0\/postings\/([a-z0-9_-]+)/i.exec(url);
    return m?.[1] ? { slug: m[1] } : null;
  },
  async harvest(ctx) {
    const slug = ctx.source.ats_slug;
    if (!slug) return fail("lever source has no org slug");
    const url = `https://api.lever.co/v0/postings/${slug}?mode=json`;
    const { ok, data, res } = await fetchJson<LeverJob[]>(url, { signal: ctx.signal });
    if (!ok || !data) return fail(res.error ?? `HTTP ${res.status}`, res.latencyMs);
    const jobs = data.slice(0, ctx.limit).map((j) =>
      makeJob({
        externalId: j.id,
        sourceId: ctx.source.id,
        atsType: "lever",
        company: ctx.source.company,
        title: j.text ?? "",
        location: j.categories?.location ?? null,
        postedAt: j.createdAt ? new Date(j.createdAt).toISOString() : null,
        url: j.hostedUrl ?? url,
        applyUrl: j.applyUrl ?? j.hostedUrl ?? null,
        descriptionHtml: j.descriptionPlain ? null : (j.description ?? null),
        descriptionText: j.descriptionPlain ?? htmlToText(j.description ?? ""),
        department: j.categories?.team ?? null,
        employmentType: j.categories?.commitment ?? null,
      }),
    );
    return { jobs, ok: true, latencyMs: res.latencyMs };
  },
};

export const ashby: AtsAdapter = {
  type: "ashby",
  matches(url) {
    const m = /jobs\.ashbyhq\.com\/([a-z0-9_.-]+)/i.exec(url);
    return m?.[1] ? { slug: m[1] } : null;
  },
  async harvest(ctx) {
    const slug = ctx.source.ats_slug;
    if (!slug) return fail("ashby source has no board slug");
    const url = `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`;
    const { ok, data, res } = await fetchJson<{ jobs: AshbyJob[] }>(url, { signal: ctx.signal });
    if (!ok || !data) return fail(res.error ?? `HTTP ${res.status}`, res.latencyMs);
    const jobs = (data.jobs ?? []).slice(0, ctx.limit).map((j) =>
      makeJob({
        externalId: j.id,
        sourceId: ctx.source.id,
        atsType: "ashby",
        company: ctx.source.company,
        title: j.title ?? "",
        location: j.location ?? null,
        postedAt: j.publishedAt ?? null,
        url: j.jobUrl ?? url,
        applyUrl: j.applyUrl ?? j.jobUrl ?? null,
        descriptionHtml: j.descriptionHtml ?? null,
        descriptionText: j.descriptionPlain ?? htmlToText(j.descriptionHtml ?? ""),
        department: j.department ?? null,
        employmentType: j.employmentType ?? null,
      }),
    );
    return { jobs, ok: true, latencyMs: res.latencyMs };
  },
};

export const smartrecruiters: AtsAdapter = {
  type: "smartrecruiters",
  matches(url) {
    const m =
      /careers\.smartrecruiters\.com\/([A-Za-z0-9_-]+)/.exec(url) ??
      /api\.smartrecruiters\.com\/v1\/companies\/([A-Za-z0-9_-]+)/.exec(url);
    return m?.[1] ? { slug: m[1] } : null;
  },
  async harvest(ctx) {
    const slug = ctx.source.ats_slug;
    if (!slug) return fail("smartrecruiters source has no company id");
    const listUrl = `https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=${Math.min(ctx.limit, 100)}`;
    const { ok, data, res } = await fetchJson<{ content: SrPosting[] }>(listUrl, { signal: ctx.signal });
    if (!ok || !data) return fail(res.error ?? `HTTP ${res.status}`, res.latencyMs);
    const jobs: JobPosting[] = [];
    // The list endpoint carries no description; each posting needs one fetch.
    for (const p of (data.content ?? []).slice(0, ctx.limit)) {
      const detail = await fetchJson<SrPostingDetail>(
        `https://api.smartrecruiters.com/v1/companies/${slug}/postings/${p.id}`,
        { signal: ctx.signal, retries: 1 },
      );
      const sections = detail.data?.jobAd?.sections;
      const html = [sections?.companyDescription?.text, sections?.jobDescription?.text, sections?.qualifications?.text]
        .filter(Boolean)
        .join("\n");
      const loc = p.location ? [p.location.city, p.location.region, p.location.country].filter(Boolean).join(", ") : null;
      jobs.push(
        makeJob({
          externalId: p.id,
          sourceId: ctx.source.id,
          atsType: "smartrecruiters",
          company: ctx.source.company,
          title: p.name ?? "",
          location: loc,
          postedAt: p.releasedDate ?? null,
          url: `https://jobs.smartrecruiters.com/${slug}/${p.id}`,
          applyUrl: `https://jobs.smartrecruiters.com/${slug}/${p.id}`,
          descriptionHtml: html || null,
          descriptionText: htmlToText(html),
          department: p.department?.label ?? null,
        }),
      );
    }
    return { jobs, ok: true, latencyMs: res.latencyMs };
  },
};

export const recruitee: AtsAdapter = {
  type: "recruitee",
  matches(url) {
    const m = /([a-z0-9_-]+)\.recruitee\.com/i.exec(url);
    return m?.[1] ? { slug: m[1] } : null;
  },
  async harvest(ctx) {
    const slug = ctx.source.ats_slug;
    if (!slug) return fail("recruitee source has no company slug");
    const url = `https://${slug}.recruitee.com/api/offers/`;
    const { ok, data, res } = await fetchJson<{ offers: RecruiteeOffer[] }>(url, { signal: ctx.signal });
    if (!ok || !data) return fail(res.error ?? `HTTP ${res.status}`, res.latencyMs);
    const jobs = (data.offers ?? []).slice(0, ctx.limit).map((o) =>
      makeJob({
        externalId: String(o.id),
        sourceId: ctx.source.id,
        atsType: "recruitee",
        company: ctx.source.company,
        title: o.title ?? "",
        location: o.location ?? o.city ?? null,
        postedAt: o.published_at ?? null,
        url: o.careers_url ?? url,
        applyUrl: o.careers_apply_url ?? o.careers_url ?? null,
        descriptionHtml: `${o.description ?? ""}\n${o.requirements ?? ""}`,
        descriptionText: htmlToText(`${o.description ?? ""}\n${o.requirements ?? ""}`),
        department: o.department ?? null,
        employmentType: o.employment_type_code ?? null,
      }),
    );
    return { jobs, ok: true, latencyMs: res.latencyMs };
  },
};

export const workable: AtsAdapter = {
  type: "workable",
  matches(url) {
    const m = /apply\.workable\.com\/([a-z0-9_-]+)/i.exec(url) ?? /([a-z0-9_-]+)\.workable\.com/i.exec(url);
    return m?.[1] && m[1] !== "apply" ? { slug: m[1] } : null;
  },
  async harvest(ctx) {
    const slug = ctx.source.ats_slug;
    if (!slug) return fail("workable source has no account slug");
    const url = `https://apply.workable.com/api/v1/widget/accounts/${slug}?details=true`;
    const { ok, data, res } = await fetchJson<{ jobs: WorkableJob[]; name?: string }>(url, { signal: ctx.signal });
    if (!ok || !data) return fail(res.error ?? `HTTP ${res.status}`, res.latencyMs);
    const jobs = (data.jobs ?? []).slice(0, ctx.limit).map((j) =>
      makeJob({
        externalId: j.shortcode ?? j.id ?? "",
        sourceId: ctx.source.id,
        atsType: "workable",
        company: ctx.source.company || (data.name ?? ""),
        title: j.title ?? "",
        location: [j.city, j.country].filter(Boolean).join(", ") || null,
        postedAt: j.published_on ?? null,
        url: j.url ?? j.application_url ?? url,
        applyUrl: j.application_url ?? j.url ?? null,
        descriptionHtml: `${j.description ?? ""}\n${j.requirements ?? ""}`,
        descriptionText: htmlToText(`${j.description ?? ""}\n${j.requirements ?? ""}`),
        department: j.department ?? null,
        employmentType: j.employment_type ?? null,
      }),
    );
    return { jobs, ok: true, latencyMs: res.latencyMs };
  },
};

/**
 * Generic fallback for a company page running no ATS we recognise. Still
 * deterministic: schema.org markup, not a model. The LLM fallback sits one
 * level above this, in the harvester, and only fires when this finds nothing.
 */
export const jsonld: AtsAdapter = {
  type: "jsonld",
  matches() {
    return null; // never auto-detected; used as an explicit last resort
  },
  async harvest(ctx) {
    const url = ctx.source.career_url;
    if (!url) return fail("jsonld source has no career_url");
    const res = await fetchText(url, { signal: ctx.signal });
    if (!res.ok) return fail(res.error ?? `HTTP ${res.status}`, res.latencyMs);
    const found = extractJsonLdJobs(res.body);
    const jobs = found.slice(0, ctx.limit).map((j, i) => {
      const org = typeof j.hiringOrganization === "string" ? j.hiringOrganization : j.hiringOrganization?.name;
      const html = j.description ?? "";
      return makeJob({
        externalId: j.url ?? `${url}#${i}`,
        sourceId: ctx.source.id,
        atsType: "jsonld",
        company: ctx.source.company || org || "",
        title: j.title ?? "",
        location: j.jobLocationType === "TELECOMMUTE" ? "Remote" : jsonLdLocation(j.jobLocation),
        postedAt: j.datePosted ?? null,
        url: j.url ?? url,
        applyUrl: j.url ?? null,
        descriptionHtml: html,
        descriptionText: htmlToText(html),
        employmentType: Array.isArray(j.employmentType) ? (j.employmentType[0] ?? null) : (j.employmentType ?? null),
      });
    });
    return { jobs, ok: true, latencyMs: res.latencyMs };
  },
};

/** Greenhouse returns HTML-escaped content in a JSON string. */
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/* Board response shapes — narrow structural types, not full API models. */
interface GhJob { id: number; title?: string; content?: string; absolute_url?: string; updated_at?: string; location?: { name?: string }; departments?: Array<{ name?: string }> }
interface LeverJob { id: string; text?: string; description?: string; descriptionPlain?: string; hostedUrl?: string; applyUrl?: string; createdAt?: number; categories?: { location?: string; team?: string; commitment?: string } }
interface AshbyJob { id: string; title?: string; location?: string; publishedAt?: string; jobUrl?: string; applyUrl?: string; descriptionHtml?: string; descriptionPlain?: string; department?: string; employmentType?: string }
interface SrPosting { id: string; name?: string; releasedDate?: string; location?: { city?: string; region?: string; country?: string }; department?: { label?: string } }
interface SrPostingDetail { jobAd?: { sections?: { companyDescription?: { text?: string }; jobDescription?: { text?: string }; qualifications?: { text?: string } } } }
interface RecruiteeOffer { id: number; title?: string; location?: string; city?: string; published_at?: string; careers_url?: string; careers_apply_url?: string; description?: string; requirements?: string; department?: string; employment_type_code?: string }
interface WorkableJob { id?: string; shortcode?: string; title?: string; city?: string; country?: string; published_on?: string; url?: string; application_url?: string; description?: string; requirements?: string; department?: string; employment_type?: string }

/**
 * Local-disk adapter. `career_url` points at a directory of JobPosting-shaped
 * JSON files. It exists so the full pipeline — harvest, dedupe, filter,
 * analyse, score, rank — can run with no network and no API key, which is the
 * only way the test suite can assert on end-to-end behaviour.
 */
export const fixture: AtsAdapter = {
  type: "fixture",
  matches() {
    return null;
  },
  async harvest(ctx) {
    const dir = ctx.source.career_url;
    if (!dir) return fail("fixture source has no directory");
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    let entries: string[];
    try {
      entries = (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
    } catch (err) {
      return fail(`cannot read fixture directory: ${(err as Error).message}`);
    }
    const jobs: JobPosting[] = [];
    for (const name of entries.slice(0, ctx.limit)) {
      const raw = JSON.parse(await fs.readFile(path.join(dir, name), "utf8")) as Record<string, string>;
      jobs.push(
        makeJob({
          externalId: name,
          sourceId: ctx.source.id,
          atsType: "fixture",
          company: raw.company ?? ctx.source.company,
          title: raw.title ?? "",
          location: raw.location ?? null,
          postedAt: raw.posted_at ?? null,
          url: raw.url ?? `file://${path.join(dir, name)}`,
          applyUrl: raw.apply_url ?? null,
          descriptionHtml: null,
          descriptionText: raw.description ?? "",
          department: raw.department ?? null,
          employmentType: raw.employment_type ?? null,
        }),
      );
    }
    return { jobs, ok: true, latencyMs: 0 };
  },
};


/**
 * Workday. The single most common ATS among large employers, and the one that
 * matters most for India: the enterprises and BPO/CX firms that hire support
 * staff at volume run their careers sites on it.
 *
 * This calls the same unauthenticated endpoint the company's own public
 * careers page calls to render its listings — the employer publishing its
 * openings for candidates. `ats_slug` carries `tenant|host|site`, because a
 * Workday board is identified by all three.
 */
export const workday: AtsAdapter = {
  type: "workday",
  matches(url) {
    // https://acme.wd1.myworkdayjobs.com/en-US/AcmeCareers/job/...
    const m = /https?:\/\/([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([A-Za-z0-9_-]+)/i.exec(url);
    return m ? { slug: `${m[1]}|${m[2]}|${m[3]}` } : null;
  },
  async harvest(ctx) {
    const parts = (ctx.source.ats_slug ?? "").split("|");
    if (parts.length !== 3) return fail("workday source needs a tenant|host|site slug");
    const [tenant, host, site] = parts as [string, string, string];
    const base = `https://${tenant}.${host}.myworkdayjobs.com/wday/cxs/${tenant}/${site}`;

    // The list endpoint pages 20 at a time and carries no descriptions.
    const postings: WorkdayPosting[] = [];
    let latency = 0;
    for (let offset = 0; offset < Math.min(ctx.limit, 400); offset += 20) {
      const res = await fetchText(`${base}/jobs`, {
        signal: ctx.signal,
        retries: 1,
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ limit: 20, offset, searchText: "" }),
      });
      latency += res.latencyMs;
      if (!res.ok) {
        return postings.length ? { jobs: [], ok: false, error: res.error ?? `HTTP ${res.status}`, latencyMs: latency } : fail(res.error ?? `HTTP ${res.status}`, latency);
      }
      let page: { jobPostings?: WorkdayPosting[]; total?: number };
      try {
        page = JSON.parse(res.body);
      } catch {
        return fail("workday list response was not JSON", latency);
      }
      const batch = page.jobPostings ?? [];
      postings.push(...batch);
      if (batch.length < 20 || postings.length >= (page.total ?? 0)) break;
    }

    // Descriptions need one call each, so they are capped. Without a
    // description the JD analyst has nothing to read and the hard filters
    // drop the posting anyway.
    const wanted = postings.slice(0, Math.min(ctx.limit, 120));
    const limit = pLimit(6);
    const jobs: JobPosting[] = [];
    await Promise.all(
      wanted.map((p) =>
        limit(async () => {
          const path = p.externalPath ?? "";
          const detail = await fetchJson<WorkdayDetail>(`${base}${path}`, { signal: ctx.signal, retries: 0 });
          const info = detail.data?.jobPostingInfo;
          const html = info?.jobDescription ?? "";
          jobs.push(
            makeJob({
              externalId: p.bulletFields?.[0] ?? path,
              sourceId: ctx.source.id,
              atsType: "workday",
              company: ctx.source.company,
              title: p.title ?? info?.title ?? "",
              location: info?.location ?? p.locationsText ?? null,
              postedAt: info?.startDate ?? null,
              url: info?.externalUrl ?? `https://${tenant}.${host}.myworkdayjobs.com/${site}${path}`,
              applyUrl: info?.externalUrl ?? null,
              descriptionHtml: html || null,
              descriptionText: htmlToText(html),
              employmentType: info?.timeType ?? null,
            }),
          );
        }),
      ),
    );
    return { jobs, ok: true, latencyMs: latency };
  },
};

interface WorkdayPosting { title?: string; externalPath?: string; locationsText?: string; bulletFields?: string[] }
interface WorkdayDetail { jobPostingInfo?: { title?: string; jobDescription?: string; location?: string; startDate?: string; externalUrl?: string; timeType?: string } }

export const ADAPTERS: AtsAdapter[] = [
  greenhouse, lever, ashby, smartrecruiters, recruitee, workable, workday, linkedin, jsonld, fixture,
];

export function adapterFor(type: string): AtsAdapter | null {
  return ADAPTERS.find((a) => a.type === type) ?? null;
}

/** URL-pattern classification — the cheap half of §2.3's classify step. */
export function classifyUrl(url: string): { ats_type: AtsAdapter["type"]; slug: string } | null {
  for (const a of ADAPTERS) {
    const m = a.matches(url);
    if (m) return { ats_type: a.type, slug: m.slug };
  }
  return null;
}
