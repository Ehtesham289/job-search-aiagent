import { describe, expect, it } from "vitest";
import { z } from "zod";
import { normalizeMonth } from "../src/schemas/common.js";
import { cityOf, dedupeJobs, dedupeKey, stripTitleNoise, inferWorkMode, makeJob } from "../src/tools/ats/normalize.js";
import { classifyUrl } from "../src/tools/ats/adapters.js";
import { parseAndValidate } from "../src/llm/client.js";

describe("date normalization", () => {
  it("accepts the shapes resumes actually use", () => {
    expect(normalizeMonth("Jan 2022")).toBe("2022-01");
    expect(normalizeMonth("March 2023")).toBe("2023-03");
    expect(normalizeMonth("2022-1")).toBe("2022-01");
    expect(normalizeMonth("2022-01-15")).toBe("2022-01");
    expect(normalizeMonth("3/2021")).toBe("2021-03");
    expect(normalizeMonth("2019")).toBe("2019-01");
    expect(normalizeMonth("Present")).toBe("present");
    expect(normalizeMonth("current")).toBe("present");
  });

  it("returns null rather than guessing", () => {
    expect(normalizeMonth("sometime last year")).toBeNull();
    expect(normalizeMonth("")).toBeNull();
    expect(normalizeMonth(null)).toBeNull();
  });
});

describe("dedupe key", () => {
  it("collapses the same job posted with different noise", () => {
    const a = dedupeKey("Zeta", "Backend Engineer", "Bengaluru, India");
    const b = dedupeKey("zeta", "Backend Engineer (Bengaluru)", "Bengaluru");
    const c = dedupeKey("Zeta", "Backend Engineer - Remote", "Bengaluru");
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it("keeps genuinely different roles apart", () => {
    expect(dedupeKey("Zeta", "Backend Engineer", "Bengaluru")).not.toBe(
      dedupeKey("Zeta", "Frontend Engineer", "Bengaluru"),
    );
    expect(dedupeKey("Zeta", "Backend Engineer", "Bengaluru")).not.toBe(
      dedupeKey("Zeta", "Backend Engineer", "Pune"),
    );
  });

  it("strips requisition ids that defeat naive matching", () => {
    expect(stripTitleNoise("Backend Engineer [REQ 44812]")).toBe("Backend Engineer");
    expect(stripTitleNoise("Backend Engineer — Full-time, Remote")).toBe("Backend Engineer");
    expect(cityOf("Bengaluru, Karnataka, India")).toBe("Bengaluru");
    expect(cityOf("Remote - Anywhere")).toBe("remote");
  });
});

describe("dedupeJobs", () => {
  const base = {
    sourceId: "s1", company: "Zeta", title: "Backend Engineer", location: "Bengaluru",
    postedAt: null, applyUrl: null, descriptionHtml: null,
  };

  it("keeps the richest record for a key, preferring a real ATS over an aggregator echo", () => {
    const ats = makeJob({ ...base, externalId: "1", atsType: "greenhouse", url: "https://gh/1", descriptionText: "short but from the board" });
    const echo = makeJob({ ...base, externalId: "2", atsType: "jsonld", url: "https://agg/2", descriptionText: "x".repeat(5000) });
    const kept = dedupeJobs([echo, ats]);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.ats_type).toBe("greenhouse");
  });
});

describe("work mode inference", () => {
  it("reads hybrid before remote, and treats a stated office as onsite", () => {
    expect(inferWorkMode("Bengaluru (Hybrid)", "")).toBe("hybrid");
    expect(inferWorkMode(null, "This role is fully remote.")).toBe("remote");
    expect(inferWorkMode("Bengaluru, India", "Office-based role.")).toBe("onsite");
    expect(inferWorkMode(null, "")).toBe("unknown");
  });
});

describe("ATS classification", () => {
  it("identifies boards from URL patterns without fetching anything", () => {
    expect(classifyUrl("https://boards.greenhouse.io/stripe")).toEqual({ ats_type: "greenhouse", slug: "stripe" });
    expect(classifyUrl("https://jobs.lever.co/hasura/3003")).toEqual({ ats_type: "lever", slug: "hasura" });
    expect(classifyUrl("https://jobs.ashbyhq.com/ramp")).toEqual({ ats_type: "ashby", slug: "ramp" });
    expect(classifyUrl("https://acme.recruitee.com/o/dev")).toEqual({ ats_type: "recruitee", slug: "acme" });
    expect(classifyUrl("https://example.com/careers")).toBeNull();
  });
});

describe("schema validation as control flow", () => {
  const Schema = z.object({ n: z.number().min(0).max(100), tag: z.enum(["a", "b"]) });

  it("reports the specific failing paths rather than a generic error", () => {
    const r = parseAndValidate(Schema, JSON.stringify({ n: 500, tag: "c" }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.issues.join(" ")).toContain("n:");
    expect(r.error.issues.join(" ")).toContain("tag:");
  });

  it("tolerates a fenced response", () => {
    const r = parseAndValidate(Schema, "```json\n{\"n\": 5, \"tag\": \"a\"}\n```");
    expect(r.ok).toBe(true);
  });

  it("treats unparseable output as a validation failure, not a crash", () => {
    const r = parseAndValidate(Schema, "I'm sorry, I can't do that.");
    expect(r.ok).toBe(false);
  });
});

describe("graduation dates", () => {
  it("keeps a bare year bare, so the résumé never shows a month the candidate did not write", async () => {
    const { normalizeGraduation } = await import("../src/schemas/common.js");
    expect(normalizeGraduation("2021")).toBe("2021");
    expect(normalizeGraduation(" 2021 ")).toBe("2021");
    // Anything with real month precision still normalises.
    expect(normalizeGraduation("Jun 2021")).toBe("2021-06");
    expect(normalizeGraduation("2021-06")).toBe("2021-06");
    expect(normalizeGraduation(null)).toBeNull();
  });
});

describe("Workday board addressing", () => {
  it("reads tenant, host and site out of a careers URL", async () => {
    const { classifyUrl } = await import("../src/tools/ats/adapters.js");
    // A Workday board needs all three to be addressable; a bare tenant is not enough.
    expect(classifyUrl("https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite")).toEqual({
      ats_type: "workday",
      slug: "nvidia|wd5|NVIDIAExternalCareerSite",
    });
    expect(classifyUrl("https://acme.wd1.myworkdayjobs.com/AcmeCareers/job/London/Engineer_R-1")).toEqual({
      ats_type: "workday",
      slug: "acme|wd1|AcmeCareers",
    });
    expect(classifyUrl("https://example.com/careers")).toBeNull();
  });
});
