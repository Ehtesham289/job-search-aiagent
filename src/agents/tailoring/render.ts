import fs from "node:fs/promises";
import path from "node:path";
import { env } from "../../config/env.js";
import { RenderResult } from "../../schemas/tailoring.js";
import { atsCheck, renderDocx, renderPdf, TEMPLATES } from "../../tools/render/index.js";
import { sha1 } from "../../tools/embed.js";
import { revertRejected } from "./critic.js";
import { type AgentContext, type AgentInput, type AgentOutput, emptyOutput, escalation } from "../types.js";

/**
 * 2.7 Step 5 / 3 - Render.
 *
 * Zero model involvement past this point. The agent owns the outcome end to
 * end; the last step is just deterministic. Same resume JSON in, byte-identical
 * PDF out.
 *
 * The render is not finished when the file exists - it is finished when the
 * text survives being extracted back out of it.
 */
export async function render(ctx: AgentContext, input: AgentInput): Promise<AgentOutput> {
  const out = emptyOutput();
  let tailored = input.board.draft;
  const jobId = input.params.note ?? input.board.selected_job_id;

  if (!tailored) {
    out.summary = "nothing to render";
    out.degraded = "missing draft";
    return out;
  }

  const lastCritique = input.board.critiques.at(-1);
  if (lastCritique && lastCritique.verdict === "reject") {
    // The critic hit its revision cap with objections outstanding, and asked
    // whether to keep the candidate's original wording for those lines.
    //
    // If that is what they answered, apply it: drop the sentences the critic
    // rejected, falling back to the original bullets where a role would
    // otherwise be left empty. Nothing the critic objected to reaches the page,
    // so the safety rule holds — and the candidate gets the document instead of
    // an apology.
    //
    // Answering used to change nothing at all: the question offered "Keep the
    // original wording", and the renderer refused anyway.
    const keepOriginal = Object.values(input.board.answers ?? {}).some((a) =>
      /keep the original|original wording|revert/i.test(a),
    );

    if (!keepOriginal) {
      // Never ship an unreviewed draft. The escalation was already raised by
      // the critic; this node refuses rather than quietly publishing.
      out.summary = "refused to render: the critic's rejections are unresolved";
      out.degraded = "unresolved critique";
      out.board = { skipped: ["render: draft still carries unresolved critic rejections"] };
      return out;
    }

    const repaired = revertRejected(tailored, input.board.resume, lastCritique.findings);
    if (!repaired.draft) {
      out.summary = "refused to render: nothing survived removing the rejected wording";
      out.degraded = "unresolved critique";
      out.board = { skipped: ["render: every edit was rejected"] };
      return out;
    }
    tailored = repaired.draft;
    out.degraded =
      `${repaired.count} rejected rewrite(s) removed at your request; ` +
      `the original wording stands for those lines`;
  }

  const templateId = process.env.JOBSEARCH_TEMPLATE ?? "modern";
  const dir = path.join(env.outDir, ctx.runId);
  await fs.mkdir(dir, { recursive: true });

  const stem = `${slug(tailored.contact.name)}-${slug(jobId ?? "resume").slice(0, 12)}`;
  const pdfPath = path.join(dir, `${stem}.pdf`);
  const docxPath = path.join(dir, `${stem}.docx`);
  const jsonPath = path.join(dir, `${stem}.json`);

  // Both formats come from the same JSON, down the same path.
  await fs.writeFile(jsonPath, JSON.stringify(tailored, null, 2));
  await renderPdf(tailored, templateId, pdfPath);
  await renderDocx(tailored, templateId, docxPath);

  const check = await atsCheck(pdfPath, tailored);

  const result = RenderResult.parse({
    pdf_path: pdfPath,
    docx_path: docxPath,
    template: templateId,
    ats_check: check,
  });

  if (!check.passed) {
    // A failed round trip is a failed render regardless of how it looks.
    out.escalations.push(
      escalation(input.node.id, "render", {
        question:
          `The rendered PDF did not survive text extraction cleanly: ` +
          [
            check.missing_sections.length ? `sections lost: ${check.missing_sections.join(", ")}` : "",
            check.missing_skills.length ? `skills lost: ${check.missing_skills.join(", ")}` : "",
            ...check.notes,
          ]
            .filter(Boolean)
            .join("; ") +
          `. Shall I re-render with the "compact" template, or send the DOCX instead?`,
        kind: "unresolved_critique",
        context: { ats_check: check, templates: Object.keys(TEMPLATES) },
        options: ["Re-render with compact", "Send the DOCX", "Ship it anyway"],
        blocking: false,
      }),
    );
    out.degraded = "post-render ATS check failed";
  }

  if (jobId) {
    ctx.store.upsertApplication({
      id: sha1(`${ctx.runId}|${jobId}`),
      run_id: ctx.runId,
      job_id: jobId,
      state: check.passed ? "resume_ready" : "resume_needs_review",
      apply_url: null,
      jd_snapshot: null,
      resume_sha: sha1(JSON.stringify(tailored)),
      resume_path: pdfPath,
    });
  }

  out.board = { render: result };
  out.summary =
    `${templateId}: PDF + DOCX written; ATS round trip ${check.passed ? "passed" : "FAILED"} ` +
    `(${check.extracted_chars} chars extracted)`;
  return out;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "resume";
}
