import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parseResumeHeuristically } from "../src/tools/parse/resumeHeuristic.js";

/**
 * The offline path is what a user without an API key actually meets, so its
 * parser is held to the same standard as the model path: it must read a real
 * résumé correctly, and it must say so when it cannot.
 */
const PIPE_FORMAT = `FARHIN YASMIN
Customer Support Associate
7003283270 | yasminfarhin923@gmail.com
Kamdebpur, Sankrail, Howrah - 711309 | linkedin.com/in/farhin-yasmin-701279377
PROFILE
Customer Support Associate with 1.5 years of experience in outbound calling and appointment booking.
WORK EXPERIENCE
Customer Support Associate
Ryfs Heights Realtors Private Limited | February 2025 - July 2026
• Made outbound calls to inbound leads generated through Google Ads campaigns.
• Booked site visits against a daily target of a minimum of 10 visits.
KEY SKILLS
• Customer support and telephone handling | Outbound and follow-up calling
• MS Word, Excel, PowerPoint
LANGUAGES
Bengali (native) | Hindi (fluent) | English (fluent)
EDUCATION
B.A. English (Honours), University of Calcutta: 2024
CERTIFICATIONS
• Business Correspondent & Business Facilitator (BCBF) - Ambuja Foundation
`;

describe("heuristic résumé parser", () => {
  const r = parseResumeHeuristically(PIPE_FORMAT);

  it("recovers contact details without confusing a phone for a profile-url id", () => {
    expect(r.contact.name).toBe("Farhin Yasmin");
    expect(r.contact.email).toBe("yasminfarhin923@gmail.com");
    expect(r.contact.phone).toBe("7003283270");
    expect(r.contact.links[0]!.url).toContain("linkedin.com/in/farhin-yasmin");
  });

  it("separates title from employer and normalises the dates", () => {
    expect(r.experience).toHaveLength(1);
    const e = r.experience[0]!;
    expect(e.title).toBe("Customer Support Associate");
    expect(e.company).toBe("Ryfs Heights Realtors Private Limited");
    expect(e.start).toBe("2025-02");
    expect(e.end).toBe("2026-07");
    expect(e.bullets).toHaveLength(2);
  });

  it("keeps the candidate's own spelling of a skill", () => {
    const all = [...r.skills.primary, ...r.skills.secondary];
    expect(all).toContain("MS Word");
    expect(all).not.toContain("ms word");
  });

  it("folds languages into skills, since they are a real signal for these roles", () => {
    expect(r.skills.secondary).toContain("Bengali");
    expect(r.skills.secondary).toContain("Hindi");
  });

  it("keeps an abbreviated degree intact", () => {
    expect(r.education[0]!.degree).toBe("B.A.");
    expect(r.education[0]!.institution).toBe("University of Calcutta");
    expect(r.education[0]!.end).toBe("2024");
  });

  it("reads certifications and their issuer", () => {
    expect(r.certifications[0]!.name).toContain("Business Correspondent");
    expect(r.certifications[0]!.issuer).toBe("Ambuja Foundation");
  });

  it("handles the other common layout: title, employer and location on one line", () => {
    const parsed = parseResumeHeuristically(fs.readFileSync(path.resolve("fixtures/resume.txt"), "utf8"));
    expect(parsed.experience).toHaveLength(2);
    expect(parsed.experience[0]!.title).toBe("Software Development Engineer II");
    expect(parsed.experience[0]!.company).toBe("Wexa Payments");
    expect(parsed.experience[0]!.location).toBe("Bengaluru");
    expect(parsed.experience[0]!.end).toBe("present");
  });

  it("reports low confidence and says why, rather than inventing structure", () => {
    const junk = parseResumeHeuristically("Hi, I am looking for a job. Please call me.");
    expect(junk.confidence).toBeLessThan(0.5);
    expect(junk.uncertainty_notes.join(" ")).toMatch(/no work experience/);
  });
});

/**
 * The layout that produced "Deloitte USI, 0.6 years of experience" for someone
 * with a five-year career across four employers.
 *
 * Résumés put the date range on either of two lines, and the old rule assumed
 * one of them: it took the first head line as the job title, which on this
 * layout is the *company*. One role was recovered instead of four, so the
 * proposed brief named the employer as the role and counted only the months
 * since the current job began.
 */
describe("title and company on separate lines", () => {
  const dateOnTitleLine = `PROFESSIONAL EXPERIENCE

Business Solutions Analysis Lead (AML Operations Team Lead)      Jan 2026 - Present
Deloitte USI - Bangalore, India
- Own queue health, throughput and quality metrics for a team of analysts.

Fraud Prevention Analyst (Contractual)      Jun 2025 - Dec 2025
Linklogis (Singapore) Pte Ltd - Remote, India
- Assessed trade finance transactions with a focus on fraud prevention.

Risk Analyst      Mar 2023 - May 2025
American Express - Gurugram, India
- Investigated disputed transactions and chargebacks.
`;

  const parsed = parseResumeHeuristically(dateOnTitleLine);

  it("recovers every role, not just the first", () => {
    expect(parsed.experience).toHaveLength(3);
  });

  it("reads the job title as the title and the employer as the employer", () => {
    const first = parsed.experience[0]!;
    expect(first.title).toBe("Business Solutions Analysis Lead (AML Operations Team Lead)");
    expect(first.company).toBe("Deloitte USI");
  });

  it("keeps a corporate suffix with the employer it belongs to", () => {
    expect(parsed.experience[1]!.company).toBe("Linklogis (Singapore) Pte Ltd");
    expect(parsed.experience[1]!.title).toBe("Fraud Prevention Analyst (Contractual)");
  });

  it("does not regress the layout where the date sits on the company line", () => {
    const dateOnCompanyLine = `EXPERIENCE

Senior Backend Engineer
Acme Technologies Pvt Ltd | Mar 2021 - Present
- Built and ran the payments ledger.
`;
    const other = parseResumeHeuristically(dateOnCompanyLine);
    expect(other.experience[0]!.title).toBe("Senior Backend Engineer");
    expect(other.experience[0]!.company).toBe("Acme Technologies Pvt Ltd");
  });
});
