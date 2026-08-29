import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { normalizeWhitespace } from "./html.js";

/**
 * Text extraction from whatever the user actually has. Deterministic code —
 * the model's job starts at "turn this text into structure", not at "decode
 * this container".
 */
export async function extractText(filePath: string): Promise<{ text: string; kind: string }> {
  return extractFromBuffer(await fs.readFile(filePath), filePath);
}

/**
 * The same extraction, for bytes that never touched the disk — an upload
 * arriving over HTTP. Keeping one implementation means the console and the
 * CLI cannot disagree about what a résumé says.
 */
export async function extractFromBuffer(buf: Buffer, filename: string): Promise<{ text: string; kind: string }> {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case ".pdf":
      return { text: await pdfToText(buf), kind: "pdf" };
    case ".docx":
      return { text: docxToText(buf), kind: "docx" };
    case ".json": {
      // Already structured: pass through so a caller can skip the parse agent.
      return { text: buf.toString("utf8"), kind: "json" };
    }
    default:
      return { text: normalizeWhitespace(buf.toString("utf8")), kind: "text" };
  }
}

/** Also the post-render ATS check (§3): re-extract and confirm nothing was lost. */
export async function pdfToText(data: Buffer | Uint8Array): Promise<string> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const bytes = data instanceof Buffer ? new Uint8Array(data) : data;
  const doc = await getDocument({ data: bytes, useSystemFonts: true, isEvalSupported: false }).promise;
  const pages: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    let line = "";
    let lastY: number | null = null;
    const out: string[] = [];
    for (const item of content.items as Array<{ str?: string; transform?: number[]; hasEOL?: boolean }>) {
      if (typeof item.str !== "string") continue;
      const y = item.transform?.[5] ?? null;
      // A y-jump means a new line; PDF text items carry no line structure.
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) {
        out.push(line.trim());
        line = "";
      }
      line += item.str;
      if (item.hasEOL) {
        out.push(line.trim());
        line = "";
      }
      lastY = y;
    }
    if (line.trim()) out.push(line.trim());
    pages.push(out.join("\n"));
  }
  await doc.destroy();
  return normalizeWhitespace(pages.join("\n\n"));
}

/**
 * Minimal DOCX reader: a .docx is a ZIP whose `word/document.xml` holds the
 * text. Reading one central-directory entry is cheaper than another dependency.
 */
export function docxToText(buf: Buffer): string {
  const xml = readZipEntry(buf, "word/document.xml");
  if (!xml) return "";
  const text = xml
    .toString("utf8")
    .replace(/<w:p[ >][^>]*>|<w:p\/>|<w:p>/g, "\n")
    .replace(/<w:br\s*\/?>/g, "\n")
    .replace(/<w:tab\s*\/?>/g, "\t")
    .replace(/<[^>]+>/g, "");
  return normalizeWhitespace(decodeXmlEntities(text));
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, "&");
}

function readZipEntry(buf: Buffer, name: string): Buffer | null {
  // Locate End Of Central Directory, walk the central directory, inflate the
  // one entry we want.
  const eocdSig = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65_536; i--) {
    if (buf.readUInt32LE(i) === eocdSig) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOffset = buf.readUInt32LE(ptr + 42);
    const entryName = buf.subarray(ptr + 46, ptr + 46 + nameLen).toString("utf8");

    if (entryName === name) {
      const lhNameLen = buf.readUInt16LE(localOffset + 26);
      const lhExtraLen = buf.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + lhNameLen + lhExtraLen;
      const raw = buf.subarray(dataStart, dataStart + compSize);
      try {
        return method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw);
      } catch {
        return null;
      }
    }
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}
