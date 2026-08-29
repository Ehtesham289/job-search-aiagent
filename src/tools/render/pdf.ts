import fs from "node:fs";
import PDFDocument from "pdfkit";
import { type Block, type Template, toBlocks, TEMPLATES } from "./layout.js";
import type { TailoredResume } from "../../schemas/tailoring.js";

export interface RenderPdfOptions {
  /**
   * Stamped into the document metadata, from which pdfkit also derives the
   * file's /ID. Passing it makes the render bit-for-bit reproducible; it
   * defaults to now, which is what a real render wants.
   */
  createdAt?: Date;
}

/**
 * Pure code. Same input always yields the same PDF — no model, no sampling,
 * nothing non-deterministic in this file (the creation timestamp is an
 * explicit input, not an ambient one).
 *
 * ATS-safe by construction: single column, no tables, no text boxes, no
 * headers or footers, no images, base-14 fonts (selectable, extractable text).
 */
export async function renderPdf(
  resume: TailoredResume,
  templateId: string,
  outPath: string,
  opts: RenderPdfOptions = {},
): Promise<void> {
  const tpl = TEMPLATES[templateId] ?? TEMPLATES.modern!;
  const blocks = toBlocks(resume);

  await new Promise<void>((resolve, reject) => {
    const doc = new PDFDocument({
      size: "LETTER",
      margins: { top: tpl.margin, bottom: tpl.margin, left: tpl.margin, right: tpl.margin },
      // Metadata an ATS reads; also the only place the tool names itself.
      info: {
        Title: `${resume.contact.name} - Resume`,
        Author: resume.contact.name,
        Creator: "job-search-aiagent",
        CreationDate: opts.createdAt ?? new Date(),
      },
      autoFirstPage: true,
      // No compression keeps the text stream plainly extractable by weak parsers.
      compress: true,
    });
    const stream = fs.createWriteStream(outPath);
    doc.pipe(stream);
    stream.on("finish", () => resolve());
    stream.on("error", reject);

    drawBlocks(doc, blocks, tpl);
    doc.end();
  });
}

function drawBlocks(doc: PDFKit.PDFDocument, blocks: Block[], tpl: Template): void {
  const width = doc.page.width - tpl.margin * 2;
  const bold = tpl.font === "Times-Roman" ? "Times-Bold" : "Helvetica-Bold";
  const italic = tpl.font === "Times-Roman" ? "Times-Italic" : "Helvetica-Oblique";

  for (const block of blocks) {
    switch (block.type) {
      case "name":
        doc.font(bold).fontSize(tpl.nameSize).text(block.text, tpl.margin, doc.y, { width, align: "center" });
        doc.moveDown(0.2);
        break;

      case "contact":
        doc
          .font(tpl.font)
          .fontSize(tpl.bodySize - 0.5)
          .text(block.text, tpl.margin, doc.y, { width, align: "center" });
        doc.moveDown(0.6);
        break;

      case "heading": {
        ensureRoom(doc, tpl, 40);
        doc.moveDown(0.35);
        const text = tpl.uppercaseHeadings ? block.text.toUpperCase() : block.text;
        // x is passed explicitly: pdfkit carries the previous block's x
        // forward, so a heading after a bullet would inherit its indent.
        doc.font(bold).fontSize(tpl.headingSize).text(text, tpl.margin, doc.y, {
          width,
          characterSpacing: 0.6,
        });
        if (tpl.headingRule) {
          const y = doc.y + 1.5;
          doc.moveTo(tpl.margin, y).lineTo(tpl.margin + width, y).lineWidth(0.6).stroke();
          doc.y = y + 4;
        } else {
          doc.moveDown(0.15);
        }
        break;
      }

      case "entry": {
        ensureRoom(doc, tpl, 46);
        const y = doc.y;
        doc.font(bold).fontSize(tpl.bodySize).text(block.left, tpl.margin, y, { width: width * 0.72, lineGap: tpl.lineGap });
        const afterLeft = doc.y;
        if (block.right) {
          // Right-aligned on the same baseline. Two text runs, not a table.
          doc.font(tpl.font).fontSize(tpl.bodySize).text(block.right, tpl.margin + width * 0.72, y, {
            width: width * 0.28,
            align: "right",
          });
        }
        doc.y = Math.max(afterLeft, doc.y);
        if (block.sub) {
          doc.font(italic).fontSize(tpl.bodySize - 0.5).text(block.sub, tpl.margin, doc.y, { width });
        }
        doc.moveDown(0.15);
        break;
      }

      case "bullet":
        ensureRoom(doc, tpl, 28);
        doc.font(tpl.font).fontSize(tpl.bodySize).text(`• ${block.text}`, tpl.margin + 10, doc.y, {
          width: width - 10,
          lineGap: tpl.lineGap,
          align: "left",
        });
        break;

      case "paragraph":
        ensureRoom(doc, tpl, 28);
        doc.font(tpl.font).fontSize(tpl.bodySize).text(block.text, tpl.margin, doc.y, {
          width,
          lineGap: tpl.lineGap,
          align: "left",
        });
        break;
    }
  }
}

/** Keeps a heading from stranding itself at the foot of a page. */
function ensureRoom(doc: PDFKit.PDFDocument, tpl: Template, needed: number): void {
  if (doc.y + needed > doc.page.height - tpl.margin) doc.addPage();
}
