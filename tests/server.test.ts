import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

/**
 * The HTTP surface of L4. The console's behaviour lives here rather than in a
 * browser test: the page is a thin renderer over these routes and this event
 * stream, so this is where the contract is worth pinning down.
 */
let server: Server;
let base: string;
let dir: string;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "job-search-aiagent-web-"));
  // Read before the config module is first evaluated.
  process.env.JOBSEARCH_DB = path.join(dir, "web.sqlite");
  process.env.JOBSEARCH_OUT = path.join(dir, "out");
  process.env.JOBSEARCH_OFFLINE = "1";

  const { createServer } = await import("../src/interface/server.js");
  ({ server } = createServer({ fixtures: true }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Consumes an SSE stream to completion and returns the parsed events. */
async function drain(runId: string, timeoutMs = 60_000): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`${base}/api/events?run=${encodeURIComponent(runId)}`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: Array<Record<string, unknown>> = [];
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      if (frame.startsWith("event: end")) return events;
      const line = frame.split("\n").find((l) => l.startsWith("data:"));
      if (line) events.push(JSON.parse(line.slice(5)));
    }
  }
  return events;
}

/** The API returns plain JSON; these tests assert on shape, not on types. */
async function readJson(url: string): Promise<any> {
  const res = await fetch(url);
  return res.json();
}

async function postJson(url: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function startSearch(): Promise<string> {
  const res = await fetch(`${base}/api/search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      brief: "Backend engineer, 4 years, Node and Postgres, Bengaluru or remote",
      resumePath: path.resolve("fixtures/resume.txt"),
    }),
  });
  expect(res.status).toBe(202);
  return ((await res.json()) as { runId: string }).runId;
}

/** A minimal TailoredResume, enough to render a real PDF to upload back. */
function sampleResume(): any {
  return {
    contact: {
      name: "Ehtesham Alam",
      email: "ehtesham.alam@example.com",
      phone: "+91 98765 43210",
      location: "Bengaluru, India",
      links: [],
    },
    summary: "Backend engineer with four years building transactional services in Node.js and PostgreSQL.",
    experience: [
      {
        id: "exp_1",
        company: "Wexa Payments",
        title: "Software Development Engineer II",
        location: "Bengaluru",
        start: "2023-03",
        end: "present",
        bullets: ["Owned the settlements service, built on Node.js and TypeScript over PostgreSQL."],
        source_ids: ["exp_1_b1"],
      },
    ],
    skills: { primary: ["Node.js", "TypeScript", "PostgreSQL"], secondary: ["Redis"] },
    education: [],
    projects: [],
    certifications: [],
    applied_edit_ids: [],
  };
}

describe("console HTTP surface", () => {
  it("serves the page and its assets", async () => {
    for (const [route, type] of [
      ["/", "text/html"],
      ["/app.css", "text/css"],
      ["/app.js", "text/javascript"],
    ] as const) {
      const res = await fetch(base + route);
      expect(res.status, route).toBe(200);
      expect(res.headers.get("content-type"), route).toContain(type);
      expect((await res.text()).length).toBeGreaterThan(500);
    }
  });

  it("rejects a search with no brief", async () => {
    const res = await fetch(`${base}/api/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ brief: "  " }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toMatch(/brief/);
  });

  it("streams the run to completion over SSE", async () => {
    const runId = await startSearch();
    const events = await drain(runId);

    const types = events.map((e) => e.type);
    expect(types).toContain("plan");
    expect(types).toContain("graph");
    expect(types).toContain("node_finished");
    expect(types).toContain("run_finished");

    // The graph event must carry the shape a client needs to draw it.
    const graph = events.find((e) => e.type === "graph") as { nodes: unknown[]; layers: unknown[] };
    expect(graph.nodes.length).toBeGreaterThan(5);
    expect(graph.layers.length).toBeGreaterThan(1);

    const final = events.at(-1) as { type: string; status: string };
    expect(final.type).toBe("run_finished");
    expect(final.status).toBe("completed");
  });

  it("replays the buffer to a client that connects after the run ended", async () => {
    const runId = await startSearch();
    await drain(runId);
    // Second subscriber, well after the fact.
    const replayed = await drain(runId, 10_000);
    expect(replayed.length).toBeGreaterThan(5);
    expect((replayed.at(-1) as { type: string }).type).toBe("run_finished");
  });

  it("returns results ordered by score, with explanations attached", async () => {
    const runId = await startSearch();
    await drain(runId);

    const run = await readJson(`${base}/api/run?id=${runId}`);
    expect(run.status).toBe("completed");
    expect(run.results.length).toBeGreaterThan(2);

    const scores = run.results.map((r: { overall: number }) => r.overall);
    expect([...scores].sort((a: number, b: number) => b - a)).toEqual(scores);

    for (const r of run.results) {
      expect(r.job_id).toBeTruthy();
      expect(r.deterministic).toBeTruthy();
      if (r.scored_by !== "deterministic") expect(r.dimensions.length).toBeGreaterThan(0);
    }
  });

  it("runs the tailoring lane and exposes the artifacts", async () => {
    const searchId = await startSearch();
    await drain(searchId);
    const search = await readJson(`${base}/api/run?id=${searchId}`);
    const jobId = search.results[0].job_id;

    const res = await fetch(`${base}/api/tailor`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ searchRunId: searchId, jobId }),
    });
    expect(res.status).toBe(202);
    const { runId } = (await res.json()) as { runId: string };
    await drain(runId);

    const run = await readJson(`${base}/api/run?id=${runId}`);
    expect(run.render.ats_check.passed).toBe(true);
    expect(run.questions.length).toBeGreaterThan(0);
    expect(run.questions.every((q: { question: string }) => q.question.length > 20)).toBe(true);

    const name = run.render.pdf_path.split("/").pop();
    const pdf = await fetch(`${base}/api/file?run=${encodeURIComponent(runId)}&name=${encodeURIComponent(name)}`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(new Uint8Array(await pdf.arrayBuffer()).slice(0, 5)).toEqual(
      new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]), // %PDF-
    );
  });

  it("records an answer against a question", async () => {
    const searchId = await startSearch();
    await drain(searchId);
    const search = await readJson(`${base}/api/run?id=${searchId}`);

    const tailorRes = await fetch(`${base}/api/tailor`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ searchRunId: searchId, jobId: search.results[1].job_id }),
    });
    const { runId } = (await tailorRes.json()) as { runId: string };
    await drain(runId);

    const before = await readJson(`${base}/api/run?id=${runId}`);
    const q = before.questions.find((x: { answer: string | null }) => !x.answer);
    expect(q).toBeTruthy();

    const answered = await fetch(`${base}/api/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId, id: q.id, text: "No, leave it out." }),
    });
    expect(answered.status).toBe(200);

    const after = await readJson(`${base}/api/run?id=${runId}`);
    expect(after.questions.find((x: { id: string }) => x.id === q.id).answer).toBe("No, leave it out.");
  });

  it("extracts text from an uploaded PDF through the same path the CLI uses", async () => {
    // Render a real PDF with the project's own renderer, then upload it, so the
    // test exercises pdf.js rather than a text file wearing a .pdf extension.
    const { renderPdf } = await import("../src/tools/render/index.js");
    const pdfPath = path.join(dir, "uploaded.pdf");
    await renderPdf(sampleResume(), "classic", pdfPath, { createdAt: new Date(0) });

    const res = await fetch(`${base}/api/resume?name=uploaded.pdf`, {
      method: "POST",
      headers: { "content-type": "application/pdf" },
      body: fs.readFileSync(pdfPath),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.kind).toBe("pdf");
    expect(body.chars).toBeGreaterThan(300);
    expect(body.text).toContain("Ehtesham Alam");
    expect(body.text).toContain("PostgreSQL");
  });

  it("accepts plain text and reports the character count", async () => {
    const res = await fetch(`${base}/api/resume?name=resume.txt`, {
      method: "POST",
      body: fs.readFileSync(path.resolve("fixtures/resume.txt")),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.kind).toBe("text");
    expect(body.chars).toBeGreaterThan(1000);
  });

  it("rejects a file type it cannot read, naming what it accepts", async () => {
    const res = await fetch(`${base}/api/resume?name=payload.exe`, { method: "POST", body: "MZ" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toMatch(/PDF, DOCX, TXT or MD/);
  });

  it("refuses a file with too little text rather than letting the parser confabulate", async () => {
    const res = await fetch(`${base}/api/resume?name=scan.txt`, { method: "POST", body: "hello" });
    expect(res.status).toBe(422);
    expect(((await res.json()) as any).error).toMatch(/scanned image/);
  });

  it("reports what is in the source registry", async () => {
    const { sources } = await readJson(`${base}/api/sources`);
    expect(sources.length).toBeGreaterThan(0);
    expect(sources[0].status).toBe("verified");
  });

  it("refuses to serve a file outside the run's output directory", async () => {
    const res = await fetch(`${base}/api/file?run=abc&name=${encodeURIComponent("../../../../etc/passwd")}`);
    expect(res.status).toBe(404);
  });

  it("404s an unknown route rather than hanging", async () => {
    const res = await fetch(`${base}/api/nope`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).error).toContain("no route");
  });
});
