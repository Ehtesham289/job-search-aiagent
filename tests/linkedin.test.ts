import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { linkedin, looksRelevant, parseCards, parseDescription } from "../src/tools/ats/linkedin.js";
import { classifyUrl } from "../src/tools/ats/adapters.js";
import { findCareerLinks } from "../src/tools/parse/html.js";
import { applyHardFilters } from "../src/agents/filters.js";
import type { SourceRecord } from "../src/schemas/source.js";
import type { QueryPlan } from "../src/schemas/query.js";
import type { JobPosting } from "../src/schemas/job.js";

/**
 * Parsed against HTML captured from the live endpoint, so these assert what
 * LinkedIn actually served rather than what a hand-written fixture assumes.
 * When LinkedIn changes the markup these fail, which is the point.
 */
const fixture = (name: string) =>
  fs.readFileSync(path.join(import.meta.dirname, "fixtures", name), "utf8");

describe("linkedin card parsing", () => {
  const cards = parseCards(fixture("linkedin-search.html"));

  it("recovers every card on the page", () => {
    expect(cards).toHaveLength(10);
  });

  it("reads title, company and location off a card", () => {
    const c = cards[0]!;
    expect(c.title).toBe("Customer Contact Comms Analyst");
    expect(c.company).toBe("Accenture in India");
    expect(c.location).toBe("Bengaluru, Karnataka, India");
  });

  it("keeps the numeric job id, which is what the detail fetch needs", () => {
    expect(cards.every((c) => /^\d+$/.test(c.jobId))).toBe(true);
    expect(new Set(cards.map((c) => c.jobId)).size).toBe(10);
  });

  it("dates postings where a date is given", () => {
    const dated = cards.filter((c) => c.postedAt !== null);
    expect(dated.length).toBeGreaterThan(0);
    for (const c of dated) expect(() => new Date(c.postedAt!).toISOString()).not.toThrow();
  });

  it("returns nothing rather than throwing on markup it does not recognise", () => {
    expect(parseCards("<html><body><p>nope</p></body></html>")).toEqual([]);
    expect(parseCards("")).toEqual([]);
  });
});

describe("linkedin description parsing", () => {
  it("extracts the description body as text", () => {
    const text = parseDescription(fixture("linkedin-job.html"));
    expect(text.length).toBeGreaterThan(200);
    expect(text).not.toContain("<");
  });

  it("returns empty string when the block is absent", () => {
    expect(parseDescription("<html></html>")).toBe("");
  });
});

describe("relevance prefilter", () => {
  const titles = ["Customer Support Associate", "Customer Success Manager"];

  it("keeps a posting sharing a substantial word", () => {
    expect(looksRelevant("Senior Customer Support Specialist", titles)).toBe(true);
  });

  it("drops one that shares nothing", () => {
    expect(looksRelevant("Staff Backend Engineer", titles)).toBe(false);
  });

  it("keeps everything when no titles were given", () => {
    expect(looksRelevant("Anything At All", [])).toBe(true);
  });
});

describe("linkedin as a source", () => {
  it("classifies a jobs URL", () => {
    expect(classifyUrl("https://www.linkedin.com/jobs/search?keywords=support")?.ats_type).toBe("linkedin");
    expect(classifyUrl("https://in.linkedin.com/jobs/view/foo-123")?.ats_type).toBe("linkedin");
  });

  it("does not claim a non-jobs LinkedIn URL", () => {
    expect(linkedin.matches("https://www.linkedin.com/company/acme")).toBeNull();
  });

  const source = { id: "s_li", company: "LinkedIn", ats_type: "linkedin", ats_slug: "search" } as SourceRecord;

  it("declines when the run has no query, instead of guessing one", async () => {
    // A board adapter can enumerate. A search adapter without a question has
    // nothing to ask, and inventing a query would harvest noise.
    const out = await linkedin.harvest({ source, limit: 10 });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/no query plan/);
    expect(out.jobs).toEqual([]);
  });

  it("makes no request once the run deadline has passed", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const out = await linkedin.harvest({
      source,
      limit: 10,
      signal: ctrl.signal,
      query: { titles: ["Customer Support"], locations: ["Bengaluru"], remoteOk: true },
    });
    expect(out.jobs).toEqual([]);
  });
});

/**
 * `discover browserstack` came back unresolved while the company linked a
 * Workday board with 31 live postings from a plain anchor on its careers page.
 * Two things had to hold for that link to be found, and both are pure:
 * the crawler has to score the anchor, and the classifier has to recognise the
 * URL shape Workday actually publishes.
 */
describe("finding a board from a company's own careers page", () => {
  const page = `<html><body>
    <a href="/blog/hiring">Life at Acme</a>
    <a href="https://browserstack.wd3.myworkdayjobs.com/External" class="btn">View open positions</a>
    <a href="/privacy">Privacy</a>
  </body></html>`;

  it("ranks a board link above the rest of the page", () => {
    const links = findCareerLinks(page, "https://browserstack.com/careers");
    expect(links[0]).toBe("https://browserstack.wd3.myworkdayjobs.com/External");
  });

  it("does not surface blog or privacy links as career pages", () => {
    const links = findCareerLinks(page, "https://browserstack.com/careers");
    expect(links.some((l) => l.includes("/privacy"))).toBe(false);
  });

  it("classifies the site-only Workday URL a careers page actually links to", () => {
    // Not the deep `/en-US/Site/job/...` form — the bare landing URL.
    const cls = classifyUrl("https://browserstack.wd3.myworkdayjobs.com/External");
    expect(cls?.ats_type).toBe("workday");
    expect(cls?.slug).toBe("browserstack|wd3|External");
  });
});

/**
 * Why the adapter must not emit a card it could not hydrate.
 *
 * It used to return all ~225 search cards and leave the funnel to sort them
 * out, on the reasoning that title and location carry the hard filter. They do
 * not: the filter also requires 200 characters of description, because a job
 * with no text cannot be scored honestly. Every unhydrated card was therefore a
 * guaranteed drop, and LinkedIn contributed nothing to a single result while
 * reporting 225 postings and perfect health.
 */
describe("a posting with no description is always dropped", () => {
  const plan = {
    canonical_role: "Customer Support Associate",
    title_variants: ["Customer Support Associate"],
    adjacent_roles: [],
    skill_signature: ["zendesk"],
    seniority_band: { min: 0, max: 3 },
    exclusions: [],
    locations: [],
    queries: [{ source_type: "ats", q: "x", location: null, remote_ok: true, rationale: "r" }],
    confidence: 1,
    uncertainty_notes: [],
  } as unknown as QueryPlan;

  const card = (description: string) =>
    ({
      id: "j", dedupe_key: "k", source_id: "s_li", ats_type: "linkedin",
      company: "Acme", title: "Customer Support Associate", location: "Bengaluru, Karnataka, India",
      work_mode: "onsite", posted_at: new Date().toISOString(), url: "u", apply_url: null,
      description_text: description, description_html: null, compensation: null,
      department: null, employment_type: null, fetched_at: "",
    }) as unknown as JobPosting;

  it("drops a card that carries only title and location", () => {
    const v = applyHardFilters(card(""), plan);
    expect(v.keep).toBe(false);
    expect(v.reason).toMatch(/description too short/);
  });

  it("keeps the same card once its description is fetched", () => {
    expect(applyHardFilters(card("x".repeat(400)), plan).keep).toBe(true);
  });
});
