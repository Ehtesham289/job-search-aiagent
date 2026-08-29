import { normalizeMonth } from "../../schemas/common.js";

/**
 * A deterministic résumé parser.
 *
 * The system's rule is that anything doable in code is done in code, and a
 * great deal of résumé structure is: section headings, bullet glyphs, date
 * ranges and contact details are all lexical. A model earns its cost on the
 * genuinely ambiguous residue — which employer a floating line belongs to, what
 * an oddly-worded bullet actually claims — not on finding the word EDUCATION.
 *
 * This is what runs in offline mode, and it is also the fallback when a model
 * parse fails. It is honest about its limits: it reports low confidence and
 * says what it was unsure about, and callers escalate on that.
 */

export interface HeuristicExperience {
  company: string;
  title: string;
  location: string | null;
  start: string;
  end: string;
  bullets: string[];
}

export interface HeuristicResume {
  contact: {
    name: string;
    email: string | null;
    phone: string | null;
    location: string | null;
    links: Array<{ label: string; url: string }>;
  };
  summary: string | null;
  experience: HeuristicExperience[];
  skills: { primary: string[]; secondary: string[] };
  education: Array<{
    institution: string;
    degree: string;
    field: string | null;
    start: string | null;
    end: string | null;
    detail: string | null;
  }>;
  projects: Array<{ name: string; description: string; tech: string[]; url: string | null }>;
  certifications: Array<{ name: string; issuer: string | null }>;
  confidence: number;
  uncertainty_notes: string[];
}

type SectionName = "summary" | "experience" | "skills" | "education" | "projects" | "certifications" | "languages" | "other";

const HEADINGS: Array<[RegExp, SectionName]> = [
  [/^(profile|summary|about|objective|professional summary|career objective)\b/i, "summary"],
  [/^(work experience|experience|employment|professional experience|work history|career history)\b/i, "experience"],
  [/^(key skills|skills|technical skills|core competencies|competencies|areas of expertise)\b/i, "skills"],
  [/^(education|academics|academic qualifications|qualifications)\b/i, "education"],
  [/^(projects|personal projects|selected projects)\b/i, "projects"],
  [/^(certifications?|licen[cs]es|courses|training)\b/i, "certifications"],
  [/^(languages?)\b/i, "languages"],
  [/^(interests|hobbies|references|awards|achievements|publications|volunteer)\b/i, "other"],
];

const BULLET = /^\s*[•·‣▪◦*\-–—]\s+/;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const PHONE = /(?:\+?\d{1,3}[\s-]?)?(?:\(?\d{3,5}\)?[\s-]?)?\d{3,5}[\s-]?\d{4,6}/;
const URL = /(?:https?:\/\/)?(?:www\.)?((?:linkedin\.com|github\.com|gitlab\.com|behance\.net|dribbble\.com|medium\.com)\/[\w\-./]+)/gi;

/** "February 2025 - July 2026", "Feb 2025 – Present", "2021-2024", "03/2023 to now". */
/**
 * Nouns that appear in job titles and essentially never in company names.
 * Used to tell the two apart when a résumé puts them on separate lines.
 */
const TITLE_WORDS =
  /\b(lead|engineer|analyst|manager|associate|specialist|director|consultant|developer|designer|executive|officer|head|intern|architect|scientist|coordinator|administrator|representative|president|founder|principal|staff|supervisor|strategist|advisor|recruiter|writer|editor|technician|operator|accountant|auditor|controller|partner|agent|assistant|apprentice|trainee|clerk|nurse|teacher|counsel|marketer|programmer|tester|researcher)\b/i;

const DATE_RANGE =
  /([A-Za-z]{3,9}\.?\s+\d{4}|\d{1,2}\/\d{4}|\d{4})\s*(?:[-–—]|to|until)\s*(present|current|now|ongoing|till date|[A-Za-z]{3,9}\.?\s+\d{4}|\d{1,2}\/\d{4}|\d{4})/i;

export function parseResumeHeuristically(raw: string): HeuristicResume {
  const lines = raw
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l, i, all) => l.trim().length > 0 || (all[i - 1]?.trim().length ?? 0) > 0);

  const notes: string[] = [];
  const sections = splitSections(lines);

  const header = sections.get("__header__") ?? lines.slice(0, 6);
  const contact = parseContact(header, notes);
  const summary = joinParagraph(sections.get("summary") ?? []);
  const experience = parseExperience(sections.get("experience") ?? [], notes);
  const skills = parseSkills(sections.get("skills") ?? []);
  const education = parseEducation(sections.get("education") ?? []);
  const certifications = parseCertifications(sections.get("certifications") ?? []);
  const projects = parseProjects(sections.get("projects") ?? []);

  // Languages are a real signal for support and sales roles, and there is
  // nowhere else in the contract to put them, so they join secondary skills.
  const languages = (sections.get("languages") ?? [])
    .flatMap((l) => l.replace(BULLET, "").split(/[|,;]/))
    .map((x) => x.replace(/\((native|fluent|basic|intermediate|professional)\)/i, "").trim())
    .filter((x) => x.length > 1 && x.length < 30);

  if (experience.length === 0) notes.push("no work experience entries could be identified");
  if (skills.primary.length + skills.secondary.length === 0) notes.push("no skills section was found");
  if (!contact.email) notes.push("no email address was found");

  // Confidence is a function of what was actually recovered, not a constant.
  let confidence = 0.9;
  if (experience.length === 0) confidence -= 0.35;
  if (experience.some((e) => e.bullets.length === 0)) confidence -= 0.1;
  if (skills.primary.length === 0) confidence -= 0.15;
  if (!contact.email) confidence -= 0.1;
  if (summary === null) confidence -= 0.05;

  return {
    contact,
    summary,
    experience,
    skills: {
      primary: skills.primary,
      secondary: [...new Set([...skills.secondary, ...languages])],
    },
    education,
    projects,
    certifications,
    confidence: Math.max(0.15, Math.min(0.9, Number(confidence.toFixed(2)))),
    uncertainty_notes: notes,
  };
}

/* ── sectioning ───────────────────────────────────────────────────────── */

function splitSections(lines: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current = "__header__";
  out.set(current, []);

  for (const line of lines) {
    const heading = matchHeading(line);
    if (heading) {
      current = heading;
      if (!out.has(current)) out.set(current, []);
      continue;
    }
    out.get(current)!.push(line);
  }
  return out;
}

function matchHeading(line: string): SectionName | null {
  const t = line.trim().replace(/[:\-–—]+$/, "").trim();
  // A heading is short and is not a bullet; anything else that merely starts
  // with the word "experience" is prose.
  if (t.length === 0 || t.length > 42 || BULLET.test(line)) return null;
  for (const [re, name] of HEADINGS) {
    if (re.test(t)) return name;
  }
  return null;
}

/* ── contact ──────────────────────────────────────────────────────────── */

function parseContact(header: string[], notes: string[]): HeuristicResume["contact"] {
  const text = header.join("\n");
  const email = EMAIL.exec(text)?.[0] ?? null;

  const links: Array<{ label: string; url: string }> = [];
  for (const m of text.matchAll(URL)) {
    const url = m[1]!;
    links.push({ label: url.split(".")[0]!.replace(/^\w/, (c) => c.toUpperCase()), url });
  }

  // Strip the email and URLs before looking for a phone number, or the digits
  // inside a linkedin slug get read as one.
  const phoneHay = text.replace(EMAIL, " ").replace(URL, " ");
  const phoneMatch = PHONE.exec(phoneHay);
  const phone = phoneMatch && phoneMatch[0].replace(/\D/g, "").length >= 8 ? phoneMatch[0].trim() : null;

  const nonEmpty = header.map((l) => l.trim()).filter(Boolean);
  const name = nonEmpty[0] ?? "";
  if (!name) notes.push("could not identify the candidate's name");

  // The location line is the one with a place-like shape that is not the name,
  // the email line, or the headline title.
  let location: string | null = null;
  for (const line of nonEmpty.slice(1)) {
    if (EMAIL.test(line)) {
      const tail = line.split("|").map((p) => p.trim()).find((p) => !EMAIL.test(p) && !PHONE.test(p));
      if (tail && /[a-z]/i.test(tail)) location = tail;
      continue;
    }
    if (/\b\d{5,6}\b/.test(line) || /,/.test(line)) {
      const candidate = line.split("|")[0]!.trim();
      if (candidate.length > 3 && candidate.length < 90 && !/@/.test(candidate)) {
        location = candidate;
        break;
      }
    }
  }

  return { name: titleish(name), email, phone, location, links };
}

/* ── experience ───────────────────────────────────────────────────────── */

function parseExperience(lines: string[], notes: string[]): HeuristicExperience[] {
  const entries: HeuristicExperience[] = [];
  let pending: string[] = [];

  const flush = () => {
    if (pending.length === 0) return;
    const entry = buildEntry(pending, notes);
    if (entry) entries.push(entry);
    pending = [];
  };

  for (const line of lines) {
    const isBullet = BULLET.test(line);
    const hasDates = DATE_RANGE.test(line);
    // A new entry begins at a non-bullet line once the current one already has
    // both a date range and at least one bullet.
    const started = pending.some((l) => DATE_RANGE.test(l));
    const hasBullets = pending.some((l) => BULLET.test(l));
    if (!isBullet && started && hasBullets && line.trim().length > 0 && !hasDates) {
      flush();
    } else if (!isBullet && hasDates && started && hasBullets) {
      flush();
    }
    pending.push(line);
  }
  flush();

  return entries;
}

function buildEntry(block: string[], notes: string[]): HeuristicExperience | null {
  const bullets = block
    .filter((l) => BULLET.test(l))
    .map((l) => l.replace(BULLET, "").trim())
    .filter((l) => l.length > 2);

  const headLines = block.filter((l) => !BULLET.test(l) && l.trim().length > 0);
  if (headLines.length === 0) return null;

  const dateLine = headLines.find((l) => DATE_RANGE.test(l));
  const m = dateLine ? DATE_RANGE.exec(dateLine) : null;
  const start = m ? (normalizeMonth(m[1]!) ?? m[1]!.trim()) : "";
  const end = m ? (/present|current|now|ongoing|till date/i.test(m[2]!) ? "present" : (normalizeMonth(m[2]!) ?? m[2]!.trim())) : "";

  if (!m) {
    // Without a date range this is almost certainly not an employment entry.
    return null;
  }

  // The remaining head lines carry title and company, in either order and
  // separated by |, -, — or a comma. The date line often carries the company.
  const withoutDates = dateLine!.replace(DATE_RANGE, "").replace(/[|·–—-]\s*$/, "").trim();
  const others = headLines.filter((l) => l !== dateLine).map((l) => l.trim());

  // Résumés separate title / employer / location with pipes, commas, or spaced
  // dashes, often several in one line ("Engineer II, Acme — Bengaluru"), so
  // split on all of them.
  const rawParts = [...others, withoutDates]
    .flatMap((l) => l.split(/\s*[|·]\s*|\s+[–—]\s+|\s+-\s+|,\s*/))
    .map((p) => p.replace(/^[,\-–—\s]+|[,\-–—\s]+$/g, ""))
    .filter((p) => p.length > 1);

  // Splitting on commas orphans corporate suffixes ("Acme, Inc." becomes two
  // parts); glue them back onto the name they belong to.
  const parts: string[] = [];
  for (const part of rawParts) {
    if (/^(?:inc|ltd|limited|llc|llp|pvt\.?(?:\s*ltd\.?)?|private limited|corp|corporation|co)\.?$/i.test(part) && parts.length) {
      parts[parts.length - 1] = `${parts[parts.length - 1]}, ${part}`;
    } else {
      parts.push(part);
    }
  }

  let title = "";
  let company = "";
  let location: string | null = null;

  const CORP = /\b(inc|ltd|limited|llp|llc|pvt|pte|private|gmbh|corp|corporation|technologies|solutions|systems|labs|foundation|university)\b/i;

  if (parts.length === 1) {
    title = parts[0]!;
    notes.push(`could not tell the employer apart from the job title in "${parts[0]!.slice(0, 48)}"`);
  } else {
    // Which part is the job title, decided by what a job title says rather
    // than by where it sits.
    //
    // Position alone was the bug. Two layouts are both common:
    //
    //   Title                      Jan 2026 - Present     ← dates on the title
    //   Deloitte USI - Bangalore
    //
    //   Title
    //   Deloitte USI | Jan 2026 - Present                 ← dates on the company
    //
    // The old rule assumed the second, so on the first it read "Deloitte USI"
    // as the job title, found one role out of four, and proposed a 0.6-year
    // brief for a five-year career. Role nouns appear in titles and almost
    // never in company names, which separates the two in either layout.
    const titleIdx = parts.findIndex((p) => TITLE_WORDS.test(p));
    const corpIdx = parts.findIndex((p, i) => i !== titleIdx && CORP.test(p));

    if (titleIdx >= 0) {
      title = parts[titleIdx]!;
      company = corpIdx >= 0 ? parts[corpIdx]! : (parts.find((_, i) => i !== titleIdx) ?? "");
    } else if (corpIdx > 0) {
      // No role noun anywhere: fall back to the old ordering assumption.
      company = parts[corpIdx]!;
      title = parts[0]!;
    } else {
      title = parts[0]!;
      company = parts[1]!;
    }
    const rest = parts.filter((p) => p !== title && p !== company);
    if (rest.length) location = rest[rest.length - 1]!;
  }

  return { company: company.trim(), title: title.trim(), location, start, end, bullets };
}

/* ── skills, education, the rest ──────────────────────────────────────── */

function parseSkills(lines: string[]): { primary: string[]; secondary: string[] } {
  const atoms = lines
    .flatMap((l) => l.replace(BULLET, "").split(/[|,;•·]|\s{3,}/))
    .map((s) => s.replace(/\(.*?\)/g, " ").replace(/\s{2,}/g, " ").trim())
    .map((s) => s.replace(/^and\s+/i, ""))
    .filter((s) => s.length > 1 && s.length < 60)
    // Drop the filler phrases résumés use as skills but nobody screens on.
    .filter((s) => !/^(etc|others?|and more|various)$/i.test(s));

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const a of atoms) {
    const k = a.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(a);
  }
  // The first line of a skills section is conventionally the headline set.
  const firstLineCount = (lines[0]?.replace(BULLET, "").split(/[|,;]/).length ?? 0) || 0;
  const cut = Math.max(4, Math.min(firstLineCount || 8, 10));
  return { primary: unique.slice(0, cut), secondary: unique.slice(cut) };
}

function parseEducation(lines: string[]): HeuristicResume["education"] {
  const out: HeuristicResume["education"] = [];
  for (const raw of lines) {
    const line = raw.replace(BULLET, "").trim();
    if (line.length < 4) continue;

    const year = /(19|20)\d{2}/.exec(line)?.[0] ?? null;
    // "B.A. English (Honours), University of Calcutta: 2024"
    const [left, right] = splitOnce(line, /[:,]\s*/);
    const degreePart = left ?? line;
    const institutionPart = (right ?? "").replace(/(19|20)\d{2}/, "").replace(/[:,\s]+$/, "").trim();

    const degreeMatch = /\b(b\.?[aes]\.?[a-z.]*|m\.?[aes]\.?[a-z.]*|ph\.?d|mba|bca|mca|b\.?tech|m\.?tech|diploma|higher secondary|secondary|class \d+)\b/i.exec(degreePart);
    // Keep an abbreviation's closing period: "B.A" reads as a typo, "B.A." does not.
    const degree = degreeMatch
      ? degreeMatch[0] + (degreePart[degreeMatch.index + degreeMatch[0].length] === "." ? "." : "")
      : degreePart.replace(/(19|20)\d{2}/, "").replace(/[:,\s]+$/, "").trim();
    const field = degreeMatch
      ? degreePart
          .slice(degreeMatch.index + degreeMatch[0].length)
          // Leading punctuation is the tail of an abbreviation the match
          // stopped short of ("B.A" leaving ". English").
          .replace(/^[\s.,;:-]+/, "")
          .replace(/\(.*?\)/g, "")
          .trim() || null
      : null;

    out.push({
      institution: institutionPart || degreePart,
      degree: degree || degreePart,
      field,
      start: null,
      end: year,
      detail: null,
    });
  }
  return out;
}

function parseCertifications(lines: string[]): HeuristicResume["certifications"] {
  return lines
    .map((l) => l.replace(BULLET, "").trim())
    .filter((l) => l.length > 3)
    .map((l) => {
      const [name, issuer] = splitOnce(l, /\s*[-–—|]\s*/);
      return { name: (name ?? l).trim(), issuer: issuer ? issuer.split("|")[0]!.trim() : null };
    });
}

function parseProjects(lines: string[]): HeuristicResume["projects"] {
  const out: HeuristicResume["projects"] = [];
  let name = "";
  let body: string[] = [];
  const flush = () => {
    if (!name) return;
    out.push({ name, description: body.join(" ").trim() || name, tech: [], url: null });
    name = "";
    body = [];
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (!BULLET.test(raw) && line.length < 70) {
      flush();
      name = line.replace(/[:—–-]\s*$/, "");
    } else {
      body.push(line.replace(BULLET, ""));
    }
  }
  flush();
  return out;
}

/* ── helpers ──────────────────────────────────────────────────────────── */

function joinParagraph(lines: string[]): string | null {
  const text = lines
    .map((l) => l.replace(BULLET, "").trim())
    .filter(Boolean)
    .join(" ")
    .trim();
  return text.length > 20 ? text : null;
}

function splitOnce(s: string, re: RegExp): [string, string | null] {
  const m = re.exec(s);
  if (!m) return [s, null];
  return [s.slice(0, m.index), s.slice(m.index + m[0].length)];
}

/** A name in shouting caps reads badly on a rendered résumé. */
function titleish(s: string): string {
  if (s !== s.toUpperCase() || s.length > 60) return s.trim();
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/^\p{L}/u, (c) => c.toUpperCase()))
    .join(" ")
    .trim();
}
