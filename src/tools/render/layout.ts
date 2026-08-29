import type { TailoredResume } from "../../schemas/tailoring.js";

/**
 * The single intermediate both renderers consume. PDF and DOCX are produced
 * from the same JSON down the same path — §3's "never convert PDF → DOCX".
 */
export type Block =
  | { type: "name"; text: string }
  | { type: "contact"; text: string }
  | { type: "heading"; text: string }
  | { type: "entry"; left: string; right: string; sub: string | null }
  | { type: "bullet"; text: string }
  | { type: "paragraph"; text: string };

export interface Template {
  id: string;
  label: string;
  /** Base font. Both are PDF base-14 — always extractable, never subsetted away. */
  font: "Helvetica" | "Times-Roman";
  bodySize: number;
  headingSize: number;
  nameSize: number;
  lineGap: number;
  sectionGap: number;
  margin: number;
  /** Heading rendering. A rule is a drawn line, not a table border. */
  headingRule: boolean;
  uppercaseHeadings: boolean;
}

export const TEMPLATES: Record<string, Template> = {
  classic: {
    id: "classic", label: "Classic serif", font: "Times-Roman",
    bodySize: 10.5, headingSize: 11.5, nameSize: 18, lineGap: 2.5, sectionGap: 11, margin: 54,
    headingRule: true, uppercaseHeadings: true,
  },
  modern: {
    id: "modern", label: "Modern sans", font: "Helvetica",
    bodySize: 10, headingSize: 11, nameSize: 17, lineGap: 3, sectionGap: 12, margin: 56,
    headingRule: true, uppercaseHeadings: true,
  },
  compact: {
    id: "compact", label: "Compact sans (two pages → one)", font: "Helvetica",
    bodySize: 9.5, headingSize: 10.5, nameSize: 15, lineGap: 1.8, sectionGap: 8, margin: 44,
    headingRule: false, uppercaseHeadings: true,
  },
};

/** Standard section headings — an ATS looks for exactly these words. */
export const SECTION_HEADINGS = {
  summary: "Summary",
  skills: "Skills",
  experience: "Experience",
  projects: "Projects",
  education: "Education",
  certifications: "Certifications",
} as const;

export function toBlocks(resume: TailoredResume): Block[] {
  const blocks: Block[] = [];
  const c = resume.contact;

  blocks.push({ type: "name", text: c.name });
  const contactBits = [c.email, c.phone, c.location, ...c.links.map((l) => l.url)].filter(
    (x): x is string => Boolean(x && x.trim()),
  );
  if (contactBits.length) blocks.push({ type: "contact", text: contactBits.join("  •  ") });

  if (resume.summary.trim()) {
    blocks.push({ type: "heading", text: SECTION_HEADINGS.summary });
    blocks.push({ type: "paragraph", text: resume.summary.trim() });
  }

  const skills = [...resume.skills.primary, ...resume.skills.secondary];
  if (skills.length) {
    blocks.push({ type: "heading", text: SECTION_HEADINGS.skills });
    // One flowing line, not a grid: columns become tables, and tables are the
    // single most common way a resume loses its skills in an ATS parse.
    if (resume.skills.primary.length) {
      blocks.push({ type: "paragraph", text: resume.skills.primary.join(", ") });
    }
    if (resume.skills.secondary.length) {
      blocks.push({ type: "paragraph", text: resume.skills.secondary.join(", ") });
    }
  }

  if (resume.experience.length) {
    blocks.push({ type: "heading", text: SECTION_HEADINGS.experience });
    for (const e of resume.experience) {
      blocks.push({
        type: "entry",
        left: `${e.title}, ${e.company}`,
        right: `${e.start} – ${e.end}`,
        sub: e.location,
      });
      for (const b of e.bullets) blocks.push({ type: "bullet", text: b });
    }
  }

  if (resume.projects.length) {
    blocks.push({ type: "heading", text: SECTION_HEADINGS.projects });
    for (const p of resume.projects) {
      blocks.push({ type: "entry", left: p.name, right: "", sub: p.tech.join(", ") || null });
      blocks.push({ type: "bullet", text: p.description });
    }
  }

  if (resume.certifications.length) {
    blocks.push({ type: "heading", text: SECTION_HEADINGS.certifications });
    for (const c of resume.certifications) {
      blocks.push({ type: "bullet", text: c.issuer ? `${c.name} — ${c.issuer}` : c.name });
    }
  }

  if (resume.education.length) {
    blocks.push({ type: "heading", text: SECTION_HEADINGS.education });
    for (const ed of resume.education) {
      blocks.push({
        type: "entry",
        left: [ed.degree, ed.field].filter(Boolean).join(", "),
        right: ed.end ?? "",
        sub: ed.institution,
      });
      if (ed.detail) blocks.push({ type: "paragraph", text: ed.detail });
    }
  }

  return blocks;
}
