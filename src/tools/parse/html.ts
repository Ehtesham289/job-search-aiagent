import * as cheerio from "cheerio";

/** HTML to plain text, preserving the line structure ATS parsers rely on. */
export function htmlToText(html: string): string {
  if (!html) return "";
  const $ = cheerio.load(html);
  $("script, style, noscript, svg").remove();
  $("br").replaceWith("\n");
  $("li").each((_, el) => {
    $(el).prepend("• ");
  });
  $("p, div, li, tr, h1, h2, h3, h4, h5, h6").after("\n");
  return normalizeWhitespace($.root().text());
}

export function normalizeWhitespace(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface JsonLdJob {
  title?: string;
  description?: string;
  datePosted?: string;
  employmentType?: string | string[];
  hiringOrganization?: { name?: string } | string;
  jobLocation?: unknown;
  jobLocationType?: string;
  baseSalary?: unknown;
  validThrough?: string;
  url?: string;
}

/**
 * schema.org/JobPosting blocks. The generic fallback for company career pages
 * that run no ATS we recognise — still deterministic, still no model.
 */
export function extractJsonLdJobs(html: string): JsonLdJob[] {
  const $ = cheerio.load(html);
  const out: JsonLdJob[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text();
    if (!raw.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // A malformed block on a page is normal; skip it silently.
    }
    for (const node of flattenLd(parsed)) {
      const type = (node as { "@type"?: unknown })["@type"];
      const types = Array.isArray(type) ? type : [type];
      if (types.includes("JobPosting")) out.push(node as JsonLdJob);
    }
  });
  return out;
}

function flattenLd(node: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 6 || node === null || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap((n) => flattenLd(n, depth + 1));
  const obj = node as Record<string, unknown>;
  const out: Record<string, unknown>[] = [obj];
  if (Array.isArray(obj["@graph"])) out.push(...flattenLd(obj["@graph"], depth + 1));
  return out;
}

export function jsonLdLocation(loc: unknown): string | null {
  const nodes = Array.isArray(loc) ? loc : [loc];
  const parts: string[] = [];
  for (const n of nodes) {
    if (!n || typeof n !== "object") continue;
    const addr = (n as { address?: unknown }).address;
    if (addr && typeof addr === "object") {
      const a = addr as Record<string, unknown>;
      const seg = [a.addressLocality, a.addressRegion, a.addressCountry]
        .filter((x): x is string => typeof x === "string" && x.length > 0);
      if (seg.length) parts.push(seg.join(", "));
    }
  }
  return parts.length ? [...new Set(parts)].join(" | ") : null;
}

/** Career-page candidates on a company domain, ranked by how career-like they look. */
export function findCareerLinks(html: string, baseUrl: string): string[] {
  const $ = cheerio.load(html);
  const scored = new Map<string, number>();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    let abs: string;
    try {
      abs = new URL(href, baseUrl).toString();
    } catch {
      return;
    }
    const text = $(el).text().toLowerCase();
    const hay = `${abs.toLowerCase()} ${text}`;
    let score = 0;
    if (/\b(careers?|jobs?|join-?us|work-?with-?us|openings?|vacanc)/.test(hay)) score += 3;
    if (/(greenhouse|lever\.co|ashbyhq|workable|smartrecruiters|recruitee|myworkdayjobs)/.test(abs)) score += 5;
    if (/\b(blog|news|press|privacy|terms)\b/.test(hay)) score -= 4;
    if (score > 0) scored.set(abs.split("#")[0]!, Math.max(scored.get(abs) ?? 0, score));
  });
  return [...scored.entries()].sort((a, b) => b[1] - a[1]).map(([u]) => u).slice(0, 12);
}
