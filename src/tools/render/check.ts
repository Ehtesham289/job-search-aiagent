import { pdfToText } from "../parse/document.js";
import { SECTION_HEADINGS } from "./layout.js";
import type { RenderResult, TailoredResume } from "../../schemas/tailoring.js";

/**
 * §3 post-render ATS check. Re-extract text from the PDF we just produced and
 * confirm the round trip preserved it. If extraction loses content the render
 * failed, regardless of how it looks on screen.
 */
export async function atsCheck(pdfPath: string, resume: TailoredResume): Promise<RenderResult["ats_check"]> {
  let extracted = "";
  const notes: string[] = [];
  try {
    extracted = await pdfToText(pdfPath ? await readFile(pdfPath) : new Uint8Array());
  } catch (err) {
    return {
      passed: false,
      extracted_chars: 0,
      missing_sections: [],
      missing_skills: [],
      notes: [`text extraction threw: ${(err as Error).message}`],
    };
  }

  const hay = collapse(extracted);

  const expectedSections: string[] = [SECTION_HEADINGS.experience];
  if (resume.summary.trim()) expectedSections.push(SECTION_HEADINGS.summary);
  if (resume.skills.primary.length + resume.skills.secondary.length) expectedSections.push(SECTION_HEADINGS.skills);
  if (resume.education.length) expectedSections.push(SECTION_HEADINGS.education);
  if (resume.projects.length) expectedSections.push(SECTION_HEADINGS.projects);
  if (resume.certifications.length) expectedSections.push(SECTION_HEADINGS.certifications);

  const missing_sections = expectedSections.filter((s) => !hay.includes(collapse(s)));

  const skills = [...resume.skills.primary, ...resume.skills.secondary];
  const missing_skills = skills.filter((s) => !hay.includes(collapse(s)));

  if (!hay.includes(collapse(resume.contact.name))) notes.push("candidate name did not survive extraction");
  if (resume.contact.email && !hay.includes(collapse(resume.contact.email))) {
    notes.push("email did not survive extraction");
  }

  // Bullets are where kerning and ligature tricks usually break extraction.
  const allBullets = resume.experience.flatMap((e) => e.bullets);
  const lostBullets = allBullets.filter((b) => !hay.includes(collapse(firstWords(b, 6))));
  if (lostBullets.length) notes.push(`${lostBullets.length}/${allBullets.length} bullets did not round-trip`);

  const passed =
    missing_sections.length === 0 && missing_skills.length === 0 && lostBullets.length === 0 && notes.length === 0;

  return { passed, extracted_chars: extracted.length, missing_sections, missing_skills, notes };
}

async function readFile(p: string): Promise<Uint8Array> {
  const fs = await import("node:fs/promises");
  return new Uint8Array(await fs.readFile(p));
}

/** Compare on letters and digits only — whitespace and punctuation are exactly
 *  what a PDF text layer rearranges. */
function collapse(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function firstWords(s: string, n: number): string {
  return s.split(/\s+/).slice(0, n).join(" ");
}
