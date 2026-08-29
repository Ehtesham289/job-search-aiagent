import fs from "node:fs/promises";
import { AlignmentType, BorderStyle, Document, HeadingLevel, Packer, Paragraph, TabStopType, TextRun } from "docx";
import { type Template, TEMPLATES, toBlocks } from "./layout.js";
import type { TailoredResume } from "../../schemas/tailoring.js";

/**
 * DOCX from the same resume JSON, down the same path as the PDF (§3). Never a
 * conversion of the rendered PDF — that is how documents lose their structure.
 */
export async function renderDocx(resume: TailoredResume, templateId: string, outPath: string): Promise<void> {
  const tpl = TEMPLATES[templateId] ?? TEMPLATES.modern!;
  const font = tpl.font === "Times-Roman" ? "Times New Roman" : "Arial";
  const half = (pt: number) => Math.round(pt * 2); // docx sizes are half-points

  const children: Paragraph[] = [];
  for (const block of toBlocks(resume)) {
    switch (block.type) {
      case "name":
        children.push(
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ text: block.text, bold: true, size: half(tpl.nameSize), font })],
          }),
        );
        break;
      case "contact":
        children.push(
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 160 },
            children: [new TextRun({ text: block.text, size: half(tpl.bodySize - 0.5), font })],
          }),
        );
        break;
      case "heading":
        children.push(
          new Paragraph({
            // A real heading style, so the outline survives the parse.
            heading: HeadingLevel.HEADING_2,
            spacing: { before: 220, after: 80 },
            border: tpl.headingRule
              ? { bottom: { style: BorderStyle.SINGLE, size: 4, color: "999999", space: 1 } }
              : undefined,
            children: [
              new TextRun({
                text: tpl.uppercaseHeadings ? block.text.toUpperCase() : block.text,
                bold: true,
                size: half(tpl.headingSize),
                font,
                color: "000000",
              }),
            ],
          }),
        );
        break;
      case "entry":
        children.push(
          new Paragraph({
            // A right tab stop, not a table cell.
            tabStops: [{ type: TabStopType.RIGHT, position: 9360 }],
            spacing: { before: 100 },
            children: [
              new TextRun({ text: block.left, bold: true, size: half(tpl.bodySize), font }),
              ...(block.right
                ? [new TextRun({ text: `\t${block.right}`, size: half(tpl.bodySize), font })]
                : []),
            ],
          }),
        );
        if (block.sub) {
          children.push(
            new Paragraph({
              children: [new TextRun({ text: block.sub, italics: true, size: half(tpl.bodySize - 0.5), font })],
            }),
          );
        }
        break;
      case "bullet":
        children.push(
          new Paragraph({
            bullet: { level: 0 },
            spacing: { after: 40 },
            children: [new TextRun({ text: block.text, size: half(tpl.bodySize), font })],
          }),
        );
        break;
      case "paragraph":
        children.push(
          new Paragraph({
            spacing: { after: 60 },
            children: [new TextRun({ text: block.text, size: half(tpl.bodySize), font })],
          }),
        );
        break;
    }
  }

  const twips = (pt: number) => Math.round(pt * 20);
  const doc = new Document({
    creator: "job-search-aiagent",
    title: `${resume.contact.name} — Resume`,
    // No headers, no footers, single column: the same constraints as the PDF.
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: twips(tpl.margin), bottom: twips(tpl.margin),
              left: twips(tpl.margin), right: twips(tpl.margin),
            },
          },
        },
        children,
      },
    ],
  });

  await fs.writeFile(outPath, await Packer.toBuffer(doc));
}

export type { Template };
