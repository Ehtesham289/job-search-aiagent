import { describe, expect, it } from "vitest";
import { buildIndex, verifyBinding } from "../src/agents/tailoring/evidenceBinding.js";
import { mechanicalFindings, revertRejected } from "../src/agents/tailoring/critic.js";
import type { StructuredResume } from "../src/schemas/profile.js";
import type { Finding, TailoredResume } from "../src/schemas/tailoring.js";

const original: StructuredResume = {
  contact: { name: "A Candidate", email: "a@example.com", phone: null, location: "Bengaluru", links: [] },
  summary: "Backend engineer with four years building transactional services.",
  experience: [
    {
      id: "exp_1", company: "Wexa", title: "Software Engineer II", location: "Bengaluru",
      start: "2023-03", end: "present",
      bullets: [
        { id: "exp_1_b1", text: "Owned the settlements service written in Node.js on PostgreSQL." },
        { id: "exp_1_b2", text: "Contributed to a migration from EC2 to ECS on AWS." },
      ],
    },
    {
      id: "exp_2", company: "Trellis", title: "Software Engineer", location: "Bengaluru",
      start: "2021-07", end: "2023-02",
      bullets: [{ id: "exp_2_b1", text: "Built the shipment tracking API in Node.js." }],
    },
  ],
  skills: { primary: ["node.js", "postgresql"], secondary: ["docker"] },
  education: [], projects: [], certifications: [],
};

const index = buildIndex(original);

function tailored(overrides: Partial<TailoredResume> = {}): TailoredResume {
  return {
    contact: original.contact,
    summary: original.summary!,
    experience: [
      {
        id: "exp_1", company: "Wexa", title: "Software Engineer II", location: "Bengaluru",
        start: "2023-03", end: "present",
        bullets: ["Owned the settlements service on Node.js and PostgreSQL."],
        source_ids: ["exp_1_b1"],
      },
      {
        id: "exp_2", company: "Trellis", title: "Software Engineer", location: "Bengaluru",
        start: "2021-07", end: "2023-02",
        bullets: ["Built the shipment tracking API in Node.js."],
        source_ids: ["exp_2_b1"],
      },
    ],
    skills: { primary: ["Node.js", "PostgreSQL"], secondary: ["Docker"] },
    education: [], projects: [], certifications: [], applied_edit_ids: [],
    ...overrides,
  };
}

describe("evidence binding is verified, not trusted", () => {
  it("accepts a binding whose quote really is in the cited element", () => {
    const r = verifyBinding(
      { edit_id: "e1", bound: true, source_ids: ["exp_1_b1"], quotes: ["Owned the settlements service"], unbound_reason: null, confidence: 0.9 },
      index,
    );
    expect(r.bound).toBe(true);
    expect(r.source_ids).toEqual(["exp_1_b1"]);
  });

  it("is fuzzy about punctuation and case, exact about words", () => {
    const r = verifyBinding(
      { edit_id: "e1", bound: true, source_ids: ["exp_1_b1"], quotes: ["owned  the SETTLEMENTS service,"], unbound_reason: null, confidence: 0.9 },
      index,
    );
    expect(r.bound).toBe(true);
  });

  it("rejects a binding that cites an id the resume does not contain", () => {
    const r = verifyBinding(
      { edit_id: "e1", bound: true, source_ids: ["exp_9_b7"], quotes: ["anything"], unbound_reason: null, confidence: 1 },
      index,
    );
    expect(r.bound).toBe(false);
    expect(r.unbound_reason).toContain("do not exist");
  });

  it("rejects a confidently hallucinated quote", () => {
    const r = verifyBinding(
      { edit_id: "e1", bound: true, source_ids: ["exp_1_b1"], quotes: ["Led a team of eight engineers"], unbound_reason: null, confidence: 0.99 },
      index,
    );
    expect(r.bound).toBe(false);
    expect(r.unbound_reason).toContain("no quoted evidence actually appears");
    expect(r.confidence).toBe(0);
  });

  it("rejects a quote too short to be evidence of anything", () => {
    const r = verifyBinding(
      { edit_id: "e1", bound: true, source_ids: ["exp_1_b1"], quotes: ["the"], unbound_reason: null, confidence: 1 },
      index,
    );
    expect(r.bound).toBe(false);
  });

  it("passes an honest unbound report through with its reason", () => {
    const r = verifyBinding(
      { edit_id: "e5", bound: false, source_ids: [], quotes: [], unbound_reason: "no Kubernetes anywhere", confidence: 0.95 },
      index,
    );
    expect(r.bound).toBe(false);
    expect(r.unbound_reason).toBe("no Kubernetes anywhere");
  });
});

describe("critic's deterministic checks", () => {
  it("passes a faithful draft", () => {
    expect(mechanicalFindings(original, tailored())).toEqual([]);
  });

  it("catches an invented metric", () => {
    const draft = tailored();
    draft.experience[0]!.bullets = ["Owned the settlements service, cutting latency by 40%."];
    const f = mechanicalFindings(original, draft);
    expect(f.some((x) => x.category === "invented_metric" && x.severity === "reject")).toBe(true);
  });

  it("allows a figure that was already in the original", () => {
    const withMetric: StructuredResume = structuredClone(original);
    withMetric.experience[0]!.bullets[0]!.text = "Cut settlement latency by 40% on Node.js.";
    const draft = tailored();
    draft.experience[0]!.bullets = ["Reduced settlement latency by 40% across the payouts path."];
    expect(mechanicalFindings(withMetric, draft).filter((x) => x.category === "invented_metric")).toEqual([]);
  });

  it("catches stretched dates", () => {
    const draft = tailored();
    draft.experience[0]!.start = "2021-03";
    const f = mechanicalFindings(original, draft);
    expect(f.some((x) => x.category === "stretched_dates" && x.severity === "reject")).toBe(true);
  });

  it("catches an inflated title", () => {
    const draft = tailored();
    draft.experience[0]!.title = "Senior Staff Engineer";
    const f = mechanicalFindings(original, draft);
    expect(f.some((x) => x.category === "inflated_seniority" && x.severity === "reject")).toBe(true);
  });

  it("catches a dropped role, because a silent gap is worse than a weak bullet", () => {
    const draft = tailored();
    draft.experience = [draft.experience[0]!];
    const f = mechanicalFindings(original, draft);
    expect(f.some((x) => x.category === "ats_structure" && x.severity === "reject")).toBe(true);
  });

  it("warns on a bullet that has become a keyword list", () => {
    const draft = tailored();
    draft.experience[0]!.bullets = ["Node.js, TypeScript, PostgreSQL, Redis, Docker, AWS, Terraform, Kafka, gRPC"];
    const f = mechanicalFindings(original, draft);
    expect(f.some((x) => x.category === "keyword_stuffing" && x.severity === "warn")).toBe(true);
  });
});

/**
 * The tailoring run that produced no document at all.
 *
 * The critic rejected findings on a handful of bullets, hit the revision cap,
 * and raised a *blocking* escalation — so render never ran and there was no
 * PDF to download, over objections to a few sentences in a whole résumé.
 *
 * The rule is that nothing the critic rejected may ship. That is not the same
 * as shipping nothing.
 */
describe("a draft the critic still rejects", () => {
  const original = {
    contact: { name: "A", email: null, phone: null, location: null, links: [] },
    summary: null,
    experience: [
      { id: "e0", company: "Acme", title: "Analyst", location: null, start: "2021-01", end: "2024-01",
        bullets: [{ id: "b1", text: "Reviewed transactions for fraud." }, { id: "b2", text: "Wrote SOPs." }] },
    ],
    skills: { primary: [], secondary: [] }, education: [], projects: [], certifications: [],
  } as unknown as StructuredResume;

  const draft = {
    contact: original.contact, summary: "s",
    experience: [
      { company: "Acme", title: "Analyst", location: null, start: "2021-01", end: "2024-01",
        bullets: ["Saved $2.2M in fraud losses.", "Wrote SOPs adopted company-wide."],
        source_ids: ["b1", "b2"] },
    ],
    skills: { primary: [], secondary: [] }, education: [], projects: [], certifications: [],
    applied_edit_ids: [],
  } as unknown as TailoredResume;

  const reject = (quote: string) =>
    ({ category: "invented_metric", severity: "reject", quote, explanation: "no evidence",
       location: "experience[0].bullets[0]", suggested_fix: null }) as Finding;

  it("drops the rejected sentence and keeps the rest", () => {
    const out = revertRejected(draft, original, [reject("Saved $2.2M in fraud losses.")]);
    expect(out.count).toBe(1);
    expect(out.draft!.experience[0]!.bullets).toEqual(["Wrote SOPs adopted company-wide."]);
  });

  it("never invents a replacement for what it removed", () => {
    const out = revertRejected(draft, original, [reject("Saved $2.2M in fraud losses.")]);
    expect(out.draft!.experience[0]!.bullets.join(" ")).not.toContain("2.2M");
  });

  it("restores the candidate's own words rather than emptying a role", () => {
    const out = revertRejected(draft, original, [
      reject("Saved $2.2M in fraud losses."),
      reject("Wrote SOPs adopted company-wide."),
    ]);
    // Both rewrites rejected — fall back to the original bullets verbatim.
    expect(out.draft!.experience[0]!.bullets).toEqual([
      "Reviewed transactions for fraud.",
      "Wrote SOPs.",
    ]);
  });

  it("leaves a clean draft untouched", () => {
    const out = revertRejected(draft, original, []);
    expect(out.count).toBe(0);
    expect(out.draft).toBe(draft);
  });
});
