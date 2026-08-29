/* job-search-aiagent console — client
   ------------------------------------------------------------------
   Consumes the same ProgressEvent stream the terminal interface renders.
   No framework: the whole surface is one event feed, one lattice, and a
   handful of reads, and a framework would be more machinery than the app it
   drives.
   ------------------------------------------------------------------ */

const $ = (id) => document.getElementById(id);

const el = {
  form: $("search-form"),
  brief: $("brief"),
  resumePath: $("resume-path"),
  resumeText: $("resume-text"),
  resumeFile: $("resume-file"),
  resumeStatus: $("resume-status"),
  drop: $("drop"),
  discover: $("discover"),
  locations: $("locations"),
  remoteOk: $("remote-ok"),
  registryCount: $("registry-count"),
  registryHint: $("registry-hint"),
  registryDialog: $("registry-dialog"),
  registryList: $("registry-list"),
  registryFilter: $("registry-filter"),
  registrySummary: $("registry-summary"),
  registryClose: $("registry-close"),
  registryAll: $("registry-all"),
  registryNone: $("registry-none"),
  discoverBtn: $("discover-btn"),
  autoDiscover: $("auto-discover"),
  modeStrip: $("mode-strip"),
  budget: $("budget"),
  preset: $("preset"),
  presetHint: $("preset-hint"),
  launchBtn: $("launch-btn"),
  resetBtn: $("reset-btn"),
  moreBar: $("more-bar"),
  moreBtn: $("more-btn"),
  moreHint: $("more-hint"),
  stream: $("stream"),
  working: $("working"),
  workingWhat: $("working-what"),
  workingClock: $("working-clock"),
  streamMeta: $("stream-meta"),
  lattice: $("lattice"),
  latticeMeta: $("lattice-meta"),
  runs: $("runs"),
  results: $("results"),
  resultsPanel: $("results-panel"),
  resultsMeta: $("results-meta"),
  questions: $("questions"),
  questionsMeta: $("questions-meta"),
  artifacts: $("artifacts"),
  artifactsPanel: $("artifacts-panel"),
  dock: $("dock"),
  dockEyebrow: $("dock-eyebrow"),
  dockJob: $("dock-job"),
  dockCheck: $("dock-check"),
  dockPdf: $("dock-pdf"),
  dockDocx: $("dock-docx"),
  dockDismiss: $("dock-dismiss"),
  trace: $("trace"),
  tracePanel: $("trace-panel"),
  status: $("run-status"),
  modeBadge: $("mode-badge"),
  meterCost: $("meter-cost"),
  meterCalls: $("meter-calls"),
  meterClock: $("meter-clock"),
};

const state = {
  runId: null,
  source: null,
  step: 0,
  nodeState: new Map(),
  knownNodes: new Set(),
  budget: null,
  startedAt: null,
  clock: null,
  searchRunId: null,
  tailoringJobId: null,
  /** Run whose download dock the user closed, so it stays closed for that run. */
  dockDismissed: null,
  /** The last run payload rendered, so a handler can ask what a question was.  */
  lastRun: null,
  /** Text extracted from an uploaded file, server-side. */
  uploadedResume: null,
  /** The model's structured read of the uploaded résumé, reused by the run. */
  parsedResume: null,
  /** Which agent the working strip is currently narrating. */
  workingAgent: null,
  workingSince: null,
  workingClock: null,
  sources: [],
  fixtures: false,
  corpusSize: 0,
};

/* ── boot ─────────────────────────────────────────────────────────── */

init();

async function init() {
  const cfg = await getJson("/api/config").catch(() => ({ fixtures: false, hasApiKey: false }));
  el.modeBadge.textContent = cfg.fixtures ? "offline" : "live";
  el.modeBadge.dataset.mode = cfg.fixtures ? "fixtures" : "live";

  // Say plainly what is simulated, and — when there is no key — say what to do
  // about it first, before explaining anything else.
  //
  // A newcomer's first run without a key produces indicative scores and no
  // rewritten prose, which looks like the tool being broken rather than the
  // tool being honest. The fix is two lines in a file, so it belongs at the
  // top of the screen, phrased as an instruction rather than a footnote.
  el.modeStrip.hidden = false;
  el.modeStrip.dataset.mode = cfg.hasApiKey ? (cfg.fixtures ? "fixtures" : "live") : "nokey";

  if (!cfg.hasApiKey) {
    el.modeStrip.innerHTML =
      `<b>Add a Claude API key to unlock the full tool.</b> Right now the judgment steps run on ` +
      `<b>heuristics</b>, so scores are rough and the résumé tailoring reorders but never rewrites — ` +
      `that is a deliberate limit, not a failure. ` +
      `<span class="strip__how">` +
      `<b>1.</b> Get a key at <code>console.anthropic.com</code> &nbsp; ` +
      `<b>2.</b> <code>cp .env.example .env</code> &nbsp; ` +
      `<b>3.</b> put <code>ANTHROPIC_API_KEY=sk-ant-…</code> in it &nbsp; ` +
      `<b>4.</b> restart with <code>npm run web:live</code>` +
      `</span>` +
      (cfg.fixtures
        ? ` Postings are local samples from <code>fixtures/jobs/</code>; without the key you can still ` +
          `search real boards with <code>npm run web:offline</code>.`
        : ` Job boards are already real — harvesting needs no key. A search costs about $0.07–0.25 with one.`);
  } else {
    el.modeStrip.innerHTML = cfg.fixtures
      ? `<b>Sample postings.</b> Your résumé is really parsed, really scored and really rendered against ` +
        `local samples in <code>fixtures/jobs/</code>. For real openings, run <code>npm run web:live</code>.`
      : `<b>Live mode.</b> Real Anthropic calls, billed to your key, against real job boards. ` +
        `Results are bounded by the registry — add companies under “companies to search”.`;
  }

  el.resumePath.placeholder = cfg.fixtures ? "fixtures/resume.txt" : "/Users/you/resume.pdf";
  if (cfg.fixtures) el.resumePath.value = "fixtures/resume.txt";
  state.fixtures = Boolean(cfg.fixtures);

  await Promise.all([refreshRuns(), refreshRegistry()]);

  // A run id in the URL reopens that run. Reloading the page mid-search used
  // to lose the whole view, and a run worth reading is worth linking to.
  const wanted = new URLSearchParams(location.search).get("run");
  if (wanted) {
    const row = el.runs.querySelector(`li[data-id="${CSS.escape(wanted)}"]`);
    if (row) openPastRun({ id: wanted, kind: wanted.includes("_tailor_") ? "tailor" : "search" });
  }

  wireUpload();
  el.discoverBtn.addEventListener("click", addCompanies);
  el.resetBtn.addEventListener("click", clearConsole);
  el.moreBtn.addEventListener("click", findMore);
  el.dockDismiss.addEventListener("click", () => {
    state.dockDismissed = state.runId;
    hideDock();
  });
  wireRegistry();
  el.preset.addEventListener("change", describePreset);
  describePreset();

  el.form.addEventListener("submit", onSearch);
  // Cmd/Ctrl+Enter launches from anywhere in the form.
  el.form.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") el.form.requestSubmit();
  });

  wireScrollHints();
}

/* ── scroll affordance ────────────────────────────────────────────────
   The rails scroll, but nothing said so: the columns just looked cut off at
   the window edge. Each rail carries a "more below" marker, and this keeps
   it truthful — shown only while there is actually something further down.

   Content arrives asynchronously (run history, the cost table, a panel that
   unhides when results land), so a one-time measurement on load would be
   wrong within a second. A ResizeObserver re-checks whenever the column's
   contents change height. */

function wireScrollHints() {
  for (const rail of document.querySelectorAll(".rail")) {
    const update = () => {
      // 4px of slack: sub-pixel layout means scrollTop rarely lands exactly
      // on the maximum, and a hint that never quite disappears looks broken.
      const room = rail.scrollHeight - rail.clientHeight - rail.scrollTop;
      rail.dataset.more = String(room > 4);
    };

    rail.addEventListener("scroll", update, { passive: true });
    new ResizeObserver(update).observe(rail);
    for (const child of rail.children) new ResizeObserver(update).observe(child);
    update();
  }
}

/* ── résumé upload ────────────────────────────────────────────────── */

function wireUpload() {
  el.resumeFile.addEventListener("change", () => {
    if (el.resumeFile.files[0]) uploadResume(el.resumeFile.files[0]);
  });

  for (const type of ["dragenter", "dragover"]) {
    el.drop.addEventListener(type, (e) => {
      e.preventDefault();
      el.drop.dataset.over = "true";
    });
  }
  for (const type of ["dragleave", "drop"]) {
    el.drop.addEventListener(type, (e) => {
      e.preventDefault();
      el.drop.dataset.over = "false";
    });
  }
  el.drop.addEventListener("drop", (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (file) uploadResume(file);
  });
}

async function uploadResume(file) {
  setResumeStatus(`reading ${file.name}…`, null);
  try {
    // The bytes go to the server, which runs the same extractor the CLI uses —
    // PDF via pdf.js, DOCX by unzipping word/document.xml. Nothing is parsed
    // in the browser, so both interfaces read a résumé identically.
    const res = await fetch(`/api/resume?name=${encodeURIComponent(file.name)}`, {
      method: "POST",
      headers: { "content-type": file.type || "application/octet-stream" },
      body: file,
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `upload failed (${res.status})`);

    state.uploadedResume = body.text;
    // Keep the parse so the search can reuse it. Without this the run would
    // read the same résumé a second time — the same cost, and a second chance
    // for the two reads to disagree about the same document.
    state.parsedResume = body.parsed ?? null;
    // Fill the brief from the résumé, but never overwrite what the user typed.
    if (!el.brief.value.trim() && body.suggested_brief) {
      el.brief.value = body.suggested_brief;
      el.brief.classList.add("is-suggested");
      el.brief.addEventListener("input", () => el.brief.classList.remove("is-suggested"), { once: true });
    }
    el.drop.dataset.loaded = "true";
    el.drop.querySelector(".drop__main").textContent = body.name;
    el.drop.querySelector(".drop__sub").textContent = "click to replace";
    const extracted =
      `${body.chars.toLocaleString()} characters extracted from ${body.kind.toUpperCase()}` +
      (body.suggested_role ? ` · read as "${body.suggested_role}"` : "") +
      // Say which reader produced it: the heuristic goes by layout and can be
      // wrong on an unusual one, and the user is the only person who can tell.
      (body.read_by === "heuristic" ? " · read by layout, check it" : "");
    setResumeStatus(extracted, true);
  } catch (err) {
    state.uploadedResume = null;
    el.drop.dataset.loaded = "false";
    setResumeStatus(err.message, false);
  }
}

function setResumeStatus(text, ok) {
  el.resumeStatus.hidden = false;
  el.resumeStatus.textContent = text;
  if (ok === null) el.resumeStatus.removeAttribute("data-ok");
  else el.resumeStatus.dataset.ok = String(ok);
}

const PRESET_NOTES = {
  cheap:
    "Haiku for the search matrix and scoring, Sonnet for tailoring, and a narrower funnel. " +
    "The cheaper models reached the same verdicts — same blockers, same band — with terser reasoning.",
  balanced:
    "Sonnet for the search matrix and tailoring, Haiku for extraction and scoring. " +
    "Sonnet replaced Opus here: a measured search matrix cost $0.018 instead of $0.062 for the same jobs found.",
  thorough:
    "The one preset that still buys Opus for the search matrix and tailoring, and analyses twice as many jobs. " +
    "Widening the funnel is usually the better way to spend more; this does both.",
};

function describePreset() {
  el.presetHint.textContent = PRESET_NOTES[el.preset.value] ?? "";
  // A cheap run finishes inside a small budget; a thorough one needs room.
  const suggested = { cheap: "0.30", balanced: "0.75", thorough: "1.50" }[el.preset.value];
  if (suggested) el.budget.value = suggested;
}

async function refreshRegistry() {
  const { sources = [] } = await getJson("/api/sources").catch(() => ({ sources: [] }));
  state.sources = sources;
  const verified = sources.filter((s) => s.status === "verified");
  // What the next search will actually harvest — which is the number that
  // matters, and the one that was previously not shown anywhere.
  const active = verified.filter((s) => s.enabled);
  const off = verified.length - active.length;
  const real = active.filter((s) => s.ats_type !== "fixture");

  el.registryCount.textContent = verified.length
    ? `${active.length} of ${verified.length} on` + (off ? ` · ${off} off` : "")
    : "none yet";
  el.registryCount.dataset.off = String(off > 0);

  // Three distinct states, and they were being conflated: "no real boards"
  // is not the same as "everything switched off". In fixtures mode the only
  // source is the local corpus, so `real` is empty while the registry is
  // perfectly healthy — which produced "1 of 1 on" beside "every company is
  // switched off".
  el.registryHint.dataset.state = active.length ? "ok" : "empty";
  if (real.length) {
    el.registryHint.textContent =
      `Searching ${real.map((s) => s.company).slice(0, 6).join(", ")}` +
      (real.length > 6 ? ` and ${real.length - 6} more` : "") +
      ". Add more to widen the search — this is the main lever on how many results you get.";
  } else if (active.length) {
    el.registryHint.textContent =
      "Searching the local fixture corpus. Add a company above to search a real job board.";
  } else if (verified.length) {
    el.registryHint.textContent =
      `All ${verified.length} companies are switched off, so a search would harvest nothing. ` +
      `Turn some back on above.`;
  }
  if (el.registryDialog.open) renderRegistry();
}

/* ── choosing which companies to search ───────────────────────────────
   The registry is the main lever on what a search returns, so it has to be
   inspectable. Disabling is kept distinct from forgetting: a company you
   switch off keeps its verified board and its health history, and comes back
   without another round of discovery. */

function wireRegistry() {
  el.registryCount.addEventListener("click", () => {
    renderRegistry();
    el.registryDialog.showModal();
    el.registryFilter.focus();
  });
  el.registryClose.addEventListener("click", () => el.registryDialog.close());
  el.registryFilter.addEventListener("input", renderRegistry);
  el.registryAll.addEventListener("click", () => setEnabled(visibleIds(), true));
  el.registryNone.addEventListener("click", () => setEnabled(visibleIds(), false));

  el.registryList.addEventListener("change", (e) => {
    const box = e.target.closest("input[type=checkbox]");
    if (box) setEnabled([box.dataset.id], box.checked);
  });
}

/** Bulk actions apply to what the filter is showing, not the whole registry —
 *  "disable all" under a filter of "amazon" should not clear everything. */
function visibleIds() {
  // `:not(:disabled)` skips the unresolved rows: they cannot be searched
  // either way, so including them in a bulk action would report changes that
  // change nothing.
  return [...el.registryList.querySelectorAll("input[type=checkbox]:not(:disabled)")].map((b) => b.dataset.id);
}

async function setEnabled(ids, enabled) {
  if (ids.length === 0) return;
  // Optimistic: the list redraws immediately, then the server confirms.
  for (const s of state.sources) if (ids.includes(s.id)) s.enabled = enabled;
  renderRegistry();
  await postJson("/api/sources/enabled", { ids, enabled }).catch(() => null);
  await refreshRegistry();
}

function renderRegistry() {
  const q = el.registryFilter.value.trim().toLowerCase();
  const all = state.sources.filter((s) => s.status !== "dead");
  const shown = q
    ? all.filter((s) => `${s.company} ${s.ats_type}`.toLowerCase().includes(q))
    : all;

  // Only verified sources are ever harvested, so only they can be "searched".
  // Counting the unresolved ones here claimed 105 of 106 would be searched
  // when the real number was 81 — and contradicted the rail's own label.
  const verified = all.filter((s) => s.status === "verified");
  const on = verified.filter((s) => s.enabled).length;
  const unresolved = all.length - verified.length;

  el.registrySummary.textContent =
    `${on} of ${verified.length} verified companies will be searched` +
    (unresolved ? ` · ${unresolved} unresolved, never searched` : "") +
    (q ? ` · showing ${shown.length} matching “${el.registryFilter.value.trim()}”` : "");

  if (shown.length === 0) {
    el.registryList.innerHTML = '<li class="empty">Nothing matches that filter.</li>';
    return;
  }

  el.registryList.innerHTML = shown
    .slice()
    .sort((a, b) => a.company.localeCompare(b.company))
    .map((s) => {
      // An unresolved source has no working board, so there is nothing to
      // include or exclude. The checkbox is disabled rather than hidden, so
      // the row still explains why the company is not being searched.
      const dead = s.status !== "verified";
      // Surfacing failures here is the point: a board that has never answered
      // is exactly the one worth switching off.
      const health = dead
        ? `<span class="src__warn" title="${escape(s.reason ?? "no verifiable board found")}">unresolved</span>`
        : s.attempts > 0 && s.failures === s.attempts
          ? `<span class="src__warn" title="${escape(s.last_error ?? "")}">${s.failures}/${s.attempts} failed</span>`
          : s.attempts > 0
            ? `<span class="src__ok">${s.attempts - s.failures}/${s.attempts} ok</span>`
            : `<span class="src__ats">not yet fetched</span>`;
      return (
        `<li class="src" data-on="${s.enabled && !dead}" data-dead="${dead}">` +
        `<label class="src__row">` +
        `<input type="checkbox" data-id="${escape(s.id)}" ${s.enabled ? "checked" : ""} ${dead ? "disabled" : ""} />` +
        `<span class="src__name">${escape(s.company)}</span>` +
        `<span class="src__ats">${escape(s.ats_type)}</span>` +
        health +
        `</label></li>`
      );
    })
    .join("");
}

async function addCompanies() {
  const value = el.discover.value.trim();
  if (!value) return;
  el.discoverBtn.disabled = true;
  el.discoverBtn.textContent = "…";
  try {
    const res = await postJson("/api/discover", { companies: value });
    if (res.error) throw new Error(res.error);
    el.discover.value = "";
    await refreshRegistry();
    el.registryHint.textContent =
      `${res.verified} verified, ${res.unresolved} unresolved. ` + el.registryHint.textContent;
  } catch (err) {
    el.registryHint.dataset.state = "empty";
    el.registryHint.textContent = err.message;
  } finally {
    el.discoverBtn.disabled = false;
    el.discoverBtn.textContent = "add";
  }
}

/* ── launching ────────────────────────────────────────────────────── */

/* ── clearing, and continuing ─────────────────────────────────────────
   Two things a long session needs and did not have: a way to abandon the run
   on screen without reloading, and a way to ask for jobs beyond the ones
   already ranked. */

/**
 * Detaches from the current run and empties every panel.
 *
 * Deliberately does not delete anything: the run stays in the store and in
 * History. "Clear" here means the console stops showing it, which is what you
 * want mid-run when the search was wrong and you want the form back — not a
 * destructive action that throws away a search you paid for.
 */
function clearConsole() {
  if (state.source) state.source.close();
  stopClock();
  hideWorking();
  state.source = null;
  state.runId = null;
  state.searchRunId = null;
  state.tailoringJobId = null;
  state.dockDismissed = null;
  state.parsedResume = null;
  state.step = 0;
  state.nodeState = new Map();
  state.knownNodes = new Set();
  state.budget = null;
  state.corpusSize = 0;

  el.stream.innerHTML =
    '<li class="stream__idle"><p>Nothing running.</p>' +
    '<p class="dim">Every node writes one line here as it finishes: which agent, which model tier, ' +
    "what it decided, what it cost. Code nodes cost nothing and say so.</p></li>";
  el.lattice.innerHTML = '<p class="empty">The planner\'s graph appears here, and lights up as the scheduler dispatches each superstep.</p>';
  el.latticeMeta.textContent = "—";
  el.resultsPanel.hidden = true;
  el.artifactsPanel.hidden = true;
  el.tracePanel.hidden = true;
  el.moreBar.hidden = true;
  hideDock();
  el.questions.innerHTML = '<p class="empty">No questions raised yet.</p>';
  el.questionsMeta.textContent = "0 open";
  el.streamMeta.textContent = "waiting for a run";
  el.launchBtn.disabled = false;
  setStatus("idle");
  resetMeters();
  history.replaceState(null, "", location.pathname);
  markActiveRun(null);
}

/**
 * Runs the same search again, excluding everything already ranked.
 *
 * The server does the inheriting — brief, parsed résumé, locations — because
 * only it has the parent run's blackboard. The parsed résumé is carried over
 * rather than re-parsed, so both passes score against the identical candidate
 * and the second one does not pay for a second parse.
 */
async function findMore() {
  const parent = state.searchRunId;
  if (!parent) return;
  el.moreBtn.disabled = true;
  el.moreBtn.textContent = "starting…";
  try {
    const { runId, error } = await postJson("/api/search", {
      continueFrom: parent,
      preset: el.preset.value,
      budget: Number(el.budget.value) || undefined,
      autoDiscover: el.autoDiscover.checked,
    });
    if (error) throw new Error(error);
    follow(runId, { fresh: true });
  } catch (err) {
    el.moreHint.textContent = err.message;
  } finally {
    el.moreBtn.disabled = false;
    el.moreBtn.textContent = "find more jobs";
  }
}

async function onSearch(e) {
  e.preventDefault();
  el.launchBtn.disabled = true;
  try {
    const { runId, error } = await postJson("/api/search", {
      brief: el.brief.value,
      // An uploaded file wins over a pasted or path-supplied résumé.
      resumeText: state.uploadedResume ?? el.resumeText.value,
      resumePath: el.resumePath.value,
      parsedResume: state.parsedResume,
      locations: el.locations.value,
      remoteOk: el.remoteOk.checked,
      discover: el.discover.value,
      autoDiscover: el.autoDiscover.checked,
      preset: el.preset.value,
      budget: Number(el.budget.value) || undefined,
    });
    if (error) throw new Error(error);
    state.searchRunId = runId;
    follow(runId, { fresh: true });
  } catch (err) {
    pushRaw(`<span class="ev__summary" style="color:var(--red)">${escape(err.message)}</span>`, "ev--final");
    el.launchBtn.disabled = false;
  }
}

async function onTailor(jobId) {
  if (!state.searchRunId) return;
  state.tailoringJobId = jobId;
  const { runId, error } = await postJson("/api/tailor", { searchRunId: state.searchRunId, jobId });
  if (error && !runId) {
    alert(error);
    return;
  }
  follow(runId, { fresh: true, keepSearch: true });
}

/* ── the event stream ─────────────────────────────────────────────── */

function follow(runId, { fresh = false, keepSearch = false } = {}) {
  if (state.source) state.source.close();
  if (!keepSearch && !runId.includes("_tailor_")) state.searchRunId = runId;

  state.runId = runId;
  state.step = 0;
  state.nodeState = new Map();
  state.knownNodes = new Set();
  state.startedAt = Date.now();

  if (fresh) {
    el.stream.innerHTML = "";
    el.lattice.innerHTML = '<p class="empty">Waiting for the planner…</p>';
    el.resultsPanel.hidden = true;
    el.artifactsPanel.hidden = true;
    el.tracePanel.hidden = true;
    // A new run's résumé is not this run's résumé.
    state.dockDismissed = null;
    hideDock();
    el.questions.innerHTML = '<p class="empty">No questions raised yet.</p>';
    el.questionsMeta.textContent = "0 open";
  }

  setStatus("running");
  el.streamMeta.textContent = runId;
  startClock();
  markActiveRun(runId);

  const source = new EventSource(`/api/events?run=${encodeURIComponent(runId)}`);
  state.source = source;

  source.onmessage = (msg) => {
    let ev;
    try {
      ev = JSON.parse(msg.data);
    } catch {
      return;
    }
    handle(ev);
  };
  source.addEventListener("end", () => {
    source.close();
    stopClock();
    el.launchBtn.disabled = false;
    void loadRun(runId);
    void refreshRuns();
    void refreshRegistry();
  });
  source.onerror = () => {
    // The server closes the stream when a run ends; that surfaces here too.
    if (source.readyState === EventSource.CLOSED) {
      stopClock();
      el.launchBtn.disabled = false;
    }
  };
}

function handle(ev) {
  switch (ev.type) {
    case "plan":
      state.budget = parseBudget(ev.budget);
      el.latticeMeta.textContent = `${ev.nodes} nodes · ${ev.parallel_branches} wide`;
      break;

    case "graph":
      drawLattice(ev);
      break;

    case "node_started":
      setNode(ev.node_id, "running");
      // Name the step in plain words. `label` is written for a person;
      // `agent` is the fallback when a planner-authored node has none.
      showWorking(ev.label || ev.agent, ev.agent);
      break;

    case "node_progress":
      pushRaw(`<span class="ev__n">·</span><span class="ev__summary">${escape(ev.message)}</span>`, "ev--sub");
      // A harvest emits one of these per board. Echoing the latest into the
      // strip turns a three-minute silence into a visible count.
      if (state.workingAgent) showWorking(ev.message, state.workingAgent);
      break;

    case "node_finished": {
      setNode(ev.node_id, ev.status);
      if (ev.kind === "harvest") {
        const n = /^(\d+) raw postings/.exec(ev.summary);
        if (n) state.corpusSize = Math.max(state.corpusSize, Number(n[1]));
      }
      const isCode = !ev.model;
      const tier = isCode ? "code" : shortModel(ev.model);
      const cost = ev.usage.cost_usd > 0 ? `$${ev.usage.cost_usd.toFixed(4)}` : "";
      pushRaw(
        `<span class="ev__n">${++state.step}</span>` +
          `<span class="ev__agent">${escape(ev.agent)}</span>` +
          `<span class="ev__summary">${escape(ev.summary)}</span>` +
          `<span class="ev__tail">` +
          `<span class="ev__tier" data-code="${isCode}">${escape(tier)}</span>` +
          `<span class="ev__cost">${cost}</span>` +
          `<span>${Math.round(ev.duration_ms)}ms</span>` +
          `</span>`,
        "",
        { status: ev.status },
      );
      break;
    }

    case "replan":
      pushRaw(
        `<span class="ev__n">~</span>` +
          `<span class="ev__summary"><strong>replan</strong> — ${escape(ev.reason)} ` +
          `→ +${escape(ev.added_nodes.join(", "))}</span>`,
        "ev--replan",
      );
      break;

    case "escalation":
      pushRaw(
        `<span class="ev__n">?</span><span class="ev__summary">${escape(ev.escalation.question)}</span>`,
        "ev--ask",
      );
      break;

    case "budget":
      updateMeters(ev);
      break;

    case "partial_results":
      // The full ranked table arrives from /api/run when the stream ends; the
      // preview here is what makes the wait feel like progress.
      el.resultsMeta.textContent = `${ev.items.length} so far`;
      break;

    case "run_finished": {
      hideWorking();
      setStatus(ev.status, ev.skipped);
      const skipped = ev.skipped.length
        ? `<ul class="skipped-list">${ev.skipped.map((s) => `<li>${escape(s)}</li>`).join("")}</ul>`
        : "";
      pushRaw(
        `<span class="ev__n">■</span>` +
          `<span class="ev__summary"><strong>${escape(ev.status)}</strong> — ${escape(ev.summary)}` +
          (skipped ? `<br><em>not finished:</em>${skipped}` : "") +
          `</span>`,
        "ev--final",
        { status: ev.status },
      );
      break;
    }
  }
}

function pushRaw(html, extraClass = "", data = {}) {
  const idle = el.stream.querySelector(".stream__idle");
  if (idle) idle.remove();
  const li = document.createElement("li");
  li.className = `ev ${extraClass}`.trim();
  for (const [k, v] of Object.entries(data)) li.dataset[k] = v;
  li.innerHTML = html;
  el.stream.append(li);
  el.stream.scrollTop = el.stream.scrollHeight;
}

/* ── the working strip ────────────────────────────────────────────────
   Says three things while a run is live: that it is still going, which step
   it is on, and for how long. The harvest alone can hold one node for three
   minutes, and without this the console looks frozen. */

function showWorking(what, agent) {
  // The clock is per-step, not per-run: "harvester · 2m 14s" is the number
  // that tells you whether to keep waiting. The run total is already in the
  // topbar.
  if (agent !== state.workingAgent) {
    state.workingAgent = agent;
    state.workingSince = Date.now();
  }
  state.working = true;
  el.working.hidden = false;
  el.workingWhat.innerHTML = `<b>${escape(agent)}</b> · ${escape(String(what).slice(0, 90))}`;
  if (!state.workingClock) {
    state.workingClock = setInterval(tickWorking, 1000);
    tickWorking();
  }
}

function tickWorking() {
  if (!state.workingSince) return;
  const s = Math.round((Date.now() - state.workingSince) / 1000);
  el.workingClock.textContent = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

function hideWorking() {
  el.working.hidden = true;
  if (state.workingClock) clearInterval(state.workingClock);
  state.workingClock = null;
  state.workingAgent = null;
  state.workingSince = null;
}

/* ── the lattice ──────────────────────────────────────────────────── */

function drawLattice({ nodes, layers }) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const pos = new Map();

  const W = el.lattice.clientWidth || 280;
  const rowH = 30;
  const padX = 10;
  const usable = W - padX;

  // Columns, not a spread: each node owns the width up to the next one, which
  // is exactly the room its label has to live in.
  layers.forEach((layer, y) => {
    const colW = usable / layer.length;
    layer.forEach((id, i) => {
      pos.set(id, { x: padX + colW * i + 5, y: 16 + y * rowH, colW });
    });
  });

  const height = 24 + layers.length * rowH;
  const edges = [];
  for (const n of nodes) {
    const to = pos.get(n.id);
    if (!to) continue;
    for (const dep of n.depends_on) {
      const from = pos.get(dep);
      if (!from) continue;
      // A gentle S-curve reads as a wire; a straight line reads as a border.
      const midY = (from.y + to.y) / 2;
      edges.push(
        `<path class="edge" data-from="${dep}" data-to="${n.id}" ` +
          `d="M${from.x} ${from.y + 5} C${from.x} ${midY} ${to.x} ${midY} ${to.x} ${to.y - 5}"/>`,
      );
    }
  }

  const marks = nodes
    .map((n) => {
      const p = pos.get(n.id);
      if (!p) return "";
      const isNew = state.knownNodes.size > 0 && !state.knownNodes.has(n.id);
      const st = state.nodeState.get(n.id) ?? "pending";
      return (
        `<g class="node" data-id="${n.id}" data-state="${st}" data-added="${isNew}">` +
        `<title>${escape(n.label)} — ${escape(n.kind)}${n.optional ? " (optional)" : ""}</title>` +
        `<circle class="halo" cx="${p.x}" cy="${p.y}" r="6"/>` +
        `<rect x="${p.x - 4.5}" y="${p.y - 4.5}" width="9" height="9" rx="1"/>` +
        `<text x="${p.x + 9}" y="${p.y + 3}">${escape(fit(n.id, p.colW - 14))}</text>` +
        `</g>`
      );
    })
    .join("");

  el.lattice.innerHTML = `<svg viewBox="0 0 ${W} ${height}" height="${height}" role="img" aria-label="task graph">${edges.join("")}${marks}</svg>`;
  for (const n of nodes) state.knownNodes.add(n.id);
  el.latticeMeta.textContent = `${nodes.length} nodes · ${Math.max(...layers.map((l) => l.length))} wide`;
  void byId;
}

/** Truncates a label to the pixels actually available, with an ellipsis. */
function fit(text, px) {
  const max = Math.max(3, Math.floor(px / 5.15));
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function setNode(id, status) {
  state.nodeState.set(id, status);
  const g = el.lattice.querySelector(`.node[data-id="${CSS.escape(id)}"]`);
  if (g) g.dataset.state = status;
  for (const edge of el.lattice.querySelectorAll(`.edge[data-to="${CSS.escape(id)}"]`)) {
    edge.classList.toggle("is-live", status === "running");
  }
}

/* ── meters ───────────────────────────────────────────────────────── */

function parseBudget(text) {
  const m = /\$([\d.]+)\s*\/\s*(\d+)s\s*\/\s*(\d+)\s*calls/.exec(text ?? "");
  return m ? { cost: Number(m[1]), seconds: Number(m[2]), calls: Number(m[3]) } : null;
}

function updateMeters(ev) {
  const costPct = Math.min(100, (ev.spent_usd / (ev.limit_usd || 1)) * 100);
  setMeter(el.meterCost, costPct, `$${ev.spent_usd.toFixed(4)} / $${ev.limit_usd}`);
  if (state.budget) {
    const callPct = Math.min(100, (ev.llm_calls / state.budget.calls) * 100);
    setMeter(el.meterCalls, callPct, `${ev.llm_calls} / ${state.budget.calls}`);
  } else {
    setMeter(el.meterCalls, 0, String(ev.llm_calls));
  }
}

/** Back to the em-dash idle state, so a cleared console does not keep showing
 *  the spend of a run it is no longer following. */
function resetMeters() {
  for (const m of [el.meterCost, el.meterCalls]) {
    m.querySelector(".meter__fill").style.width = "0%";
    m.querySelector(".meter__value").textContent = "—";
    delete m.dataset.warn;
    delete m.dataset.over;
  }
  el.meterClock.querySelector(".meter__value").textContent = "—";
}

function setMeter(node, pct, label) {
  node.querySelector(".meter__fill").style.width = `${pct}%`;
  node.querySelector(".meter__value").textContent = label;
  node.dataset.warn = pct >= 90 ? "true" : "false";
}

function startClock() {
  stopClock();
  state.clock = setInterval(() => {
    const s = (Date.now() - state.startedAt) / 1000;
    el.meterClock.querySelector(".meter__value").textContent = `${s.toFixed(1)}s`;
  }, 100);
}
function stopClock() {
  if (state.clock) clearInterval(state.clock);
  state.clock = null;
}

/**
 * The badge was a bare word. "partial" beside a full list of results reads as
 * a failure, when it usually means the opposite: the results are complete and
 * real, and one *input* step did not get to finish. Say which.
 */
const STATUS_NOTE = {
  running: "The scheduler is still dispatching nodes.",
  completed: "Every step finished and nothing was skipped.",
  partial:
    "The results below are real and fully scored. Something upstream did not finish — " +
    "usually a slow job board abandoned at the harvest deadline, or the cost ceiling being " +
    "reached — so the search saw fewer postings than it could have.",
  awaiting_user: "An agent asked a question it will not guess the answer to. Answer it under Questions to continue.",
  failed: "The run stopped on an error.",
};

function setStatus(s, skipped = []) {
  el.status.textContent = s.replace(/_/g, " ");
  el.status.dataset.state = s;
  const note = STATUS_NOTE[s] ?? "";
  el.status.title = skipped.length ? `${note}\n\nNot finished:\n· ${skipped.join("\n· ")}` : note;
}

/* ── reads ────────────────────────────────────────────────────────── */

async function loadRun(runId) {
  const run = await getJson(`/api/run?id=${encodeURIComponent(runId)}`).catch(() => null);
  if (!run) return;

  state.lastRun = run;
  setStatus(run.status);
  renderResults(run);
  renderQuestions(run);
  renderArtifacts(run);
  renderTrace(run);
}

function renderResults(run) {
  if (!run.results.length) {
    el.resultsPanel.hidden = true;
    return;
  }
  el.resultsPanel.hidden = false;
  // Only for a search: a tailoring run shows the parent's matches, and "find
  // more" against it would mean nothing.
  el.moreBar.hidden = !state.searchRunId || state.runId !== state.searchRunId;
  // Say which question these numbers answer. Brief-relevance scores are a real
  // answer to a smaller question, and reading them as fit would be wrong.
  const briefOnly = run.results.every((r) => r.scored_by === "brief_relevance");
  el.resultsMeta.textContent =
    `${run.results.length} ranked` +
    (briefOnly ? " by brief relevance — add a résumé for fit scoring" : "") +
    (state.fixtures ? ` · from ${state.corpusSize || run.results.length} local fixture postings` : "");
  el.resultsMeta.dataset.hint = String(briefOnly);
  el.results.innerHTML = "";

  run.results.forEach((r, i) => {
    const li = document.createElement("li");
    li.className = "result";
    li.dataset.band = r.overall >= 80 ? "high" : r.overall >= 55 ? "mid" : "low";
    const isSelected = r.job_id === state.tailoringJobId;
    li.dataset.open = String(isSelected || (!state.tailoringJobId && i === 0));
    li.dataset.selected = String(isSelected);
    li.style.animationDelay = `${Math.min(i * 26, 300)}ms`;

    const tags = [];
    if (r.red_flags?.length) tags.push(`<span class="tag tag--flag">${r.red_flags.length} flag${r.red_flags.length > 1 ? "s" : ""}</span>`);
    if (r.reconciliation) tags.push('<span class="tag tag--reconciled">reconciled</span>');
    if (r.scored_by === "deterministic") tags.push('<span class="tag tag--deterministic">no rubric</span>');
    if (r.scored_by === "brief_relevance") tags.push('<span class="tag tag--deterministic" title="Matched against your brief. Upload a résumé to score your fit.">brief match</span>');
    if (r.work_mode && r.work_mode !== "unknown") tags.push(`<span class="tag">${escape(r.work_mode)}</span>`);

    const dims = r.dimensions
      .map(
        (d) =>
          `<div class="dim-row"><dt>${escape(d.dimension.replace(/_/g, " "))}</dt>` +
          `<dd class="bar"><i style="width:${d.score}%"></i></dd>` +
          `<dd>${d.score} · ${escape(d.reason)}</dd></div>`,
      )
      .join("");

    li.innerHTML =
      `<button class="result__head" type="button">` +
      `<span class="score">${r.overall}<small>%</small>` +
      `<span class="score__bar"><i style="width:${r.overall}%"></i></span></span>` +
      `<span><span class="result__title">${escape(r.title)}</span><br>` +
      `<span class="result__sub">${escape(r.company)} · ${escape(r.location ?? "location unstated")}</span></span>` +
      `<span class="result__tags">${tags.join("")}</span>` +
      `</button>` +
      `<div class="result__body">` +
      (r.red_flags?.length
        ? `<p class="note note--flag"><strong>Before you apply:</strong> ${escape(r.red_flags.join(" · "))}</p>`
        : "") +
      `<dl class="dims">${dims}</dl>` +
      (r.gaps.length ? `<p class="note note--gaps">gaps: ${escape(r.gaps.join(", "))}</p>` : "") +
      (r.matched_skills.length ? `<p class="note">matched: ${escape(r.matched_skills.join(", "))}</p>` : "") +
      (r.reconciliation
        ? `<p class="note note--reconciled">reconciled: composite ${r.reconciliation.composite_before} vs holistic ` +
          `${r.reconciliation.holistic_before} → <strong>${r.reconciliation.resolved}</strong> — ` +
          `${escape(r.reconciliation.note)}</p>`
        : "") +
      `<p class="note dim">signals: title ${r.deterministic.title_similarity ?? 0}, ` +
      `skill overlap ${r.deterministic.skill_overlap}, similarity ${r.deterministic.vector_similarity}, ` +
      `seniority delta ${r.deterministic.seniority_delta}y · confidence ${r.confidence}</p>` +
      `<div class="result__actions">` +
      `<button class="btn btn--small btn--primary" type="button" data-tailor="${escape(r.job_id)}">Tailor résumé</button>` +
      `<a href="${escape(r.url)}" target="_blank" rel="noopener">posting ↗</a>` +
      `</div></div>`;

    li.querySelector(".result__head").addEventListener("click", () => {
      li.dataset.open = li.dataset.open === "true" ? "false" : "true";
    });
    li.querySelector("[data-tailor]").addEventListener("click", (e) => {
      e.stopPropagation();
      onTailor(r.job_id);
    });
    el.results.append(li);
  });
}

function renderQuestions(run) {
  const open = run.questions.filter((q) => !q.answer);
  // A question only holds the graph open if it is blocking AND the run is
  // still going. Everything else is a note about what the résumé left out,
  // and saying "N open" on a finished run read as "still waiting on you".
  const waiting = run.status === "running" || run.status === "paused";
  const blocking = open.filter((q) => q.blocking);
  el.questionsMeta.textContent = !open.length
    ? "all answered"
    : waiting && blocking.length
      ? `${blocking.length} blocking`
      : `${open.length} unanswered`;

  if (!run.questions.length) {
    el.questions.innerHTML = '<p class="empty">No questions raised for this run.</p>';
    return;
  }

  el.questions.innerHTML = "";

  // A run parked at `awaiting_user` whose blocking questions are all answered
  // has nothing left to click, and nothing restarts it on its own. Without
  // this the run stays stopped for good, with no résumé rendered.
  if ((run.status === "awaiting_user" || run.status === "partial") && !blocking.length && open.length < run.questions.length) {
    const bar = document.createElement("div");
    bar.className = "q__continue";
    bar.innerHTML =
      `<p>Answered — the run stopped here and is waiting to be picked back up. ` +
      `It carries on from its last checkpoint; finished steps are not paid for twice.</p>` +
      `<button class="btn btn--small btn--primary" type="button">Continue the run</button>`;
    bar.querySelector("button").addEventListener("click", (e) => {
      e.target.disabled = true;
      e.target.textContent = "resuming…";
      continueRun(run.id);
    });
    el.questions.append(bar);
  }

  // On a finished run, say up front why these are still here: the résumé is
  // already rendered and simply left these claims out, because nothing in the
  // uploaded résumé backed them. An answer is recorded against the run for
  // your own reference — it does not re-render anything on its own.
  if (!waiting && open.length) {
    const note = document.createElement("p");
    note.className = "q__note";
    note.textContent =
      `This run is finished — it did not stop to wait for these. Each one is a claim the job ` +
      `wanted that your résumé did not back, so it was left out rather than invented. Answering ` +
      `records your answer against this run; it does not re-render the résumé.`;
    el.questions.append(note);
  }

  for (const q of run.questions) {
    const div = document.createElement("div");
    div.className = "q";
    div.dataset.answered = String(Boolean(q.answer));
    div.innerHTML =
      `<div class="q__kind">${escape(q.kind.replace(/_/g, " "))}${q.blocking ? " · <b>blocking</b>" : ""}</div>` +
      `<p class="q__text">${escape(q.question)}</p>` +
      (q.answer
        ? `<p class="q__answer">↳ ${escape(q.answer)}</p>`
        : `<div class="q__opts">${q.options
            .map((o) => `<button class="btn btn--small" type="button" data-opt="${escape(o)}">${escape(o)}</button>`)
            .join("")}</div>` +
          `<form class="q__form"><input type="text" placeholder="or type an answer…" /><button class="btn btn--small" type="submit">send</button></form>`);

    if (!q.answer) {
      for (const b of div.querySelectorAll("[data-opt]")) {
        b.addEventListener("click", () => answer(run.id, q.id, b.dataset.opt));
      }
      div.querySelector(".q__form").addEventListener("submit", (e) => {
        e.preventDefault();
        const value = e.target.querySelector("input").value.trim();
        if (value) answer(run.id, q.id, value);
      });
    }
    el.questions.append(div);
  }
}

/**
 * Records an answer, and continues the run if that was the last thing holding
 * it up.
 *
 * A blocking question parks the run at `awaiting_user` with its render and
 * apply nodes never dispatched. Recording the answer does not restart it — so
 * without the continue call the console answered the question and then sat
 * there forever, and no PDF was ever produced.
 */
async function answer(runId, id, text) {
  const q = state.lastRun?.questions.find((x) => x.id === id);
  await postJson("/api/answer", { runId, id, text });

  if (q?.blocking && (state.lastRun?.status === "awaiting_user" || state.lastRun?.status === "partial")) {
    const { runId: resumed, error } = await postJson("/api/continue", { runId });
    if (resumed) {
      // Re-attach to the stream: the resumed run emits into the same channel.
      follow(runId, { keepSearch: true });
      return;
    }
    // "still need an answer" is the normal case with more than one blocking
    // question outstanding, and is not worth an alert.
    if (error && !/still need an answer/.test(error)) alert(error);
  }

  await loadRun(runId);
}

/** Continues a paused run from the banner, without answering anything new. */
async function continueRun(runId) {
  const { runId: resumed, error } = await postJson("/api/continue", { runId });
  if (resumed) follow(runId, { keepSearch: true });
  else if (error) alert(error);
}

function renderArtifacts(run) {
  if (!run.render) {
    el.artifactsPanel.hidden = true;
    hideDock();
    return;
  }
  el.artifactsPanel.hidden = false;
  const c = run.render.ats_check;
  const file = (p) => `/api/file?run=${encodeURIComponent(run.id)}&name=${encodeURIComponent(p.split("/").pop())}`;
  const problems = [...c.missing_sections, ...c.missing_skills, ...c.notes];

  renderDock(run, file, problems);

  el.artifacts.innerHTML =
    `<div class="artifact">` +
    // The stylesheet keys the pass/fail colour off `data-ok`. This wrote
    // `data-pass`, so the line rendered grey either way.
    `<div class="artifact__check" data-ok="${c.passed}">` +
    `<span>${c.passed ? "◆" : "▲"}</span>` +
    `<span>post-render ATS check ${c.passed ? "passed" : "FAILED"} · ${c.extracted_chars} chars re-extracted</span>` +
    `</div>` +
    (problems.length ? `<p class="note note--gaps">${escape(problems.join("; "))}</p>` : "") +
    `<div class="artifact__links">` +
    `<a href="${file(run.render.pdf_path)}" target="_blank" rel="noopener">PDF</a>` +
    `<a href="${file(run.render.docx_path)}" target="_blank" rel="noopener">DOCX</a>` +
    `</div>` +
    `<iframe src="${file(run.render.pdf_path)}#toolbar=0&view=FitH" title="Tailored résumé preview" ` +
    `loading="lazy"></iframe>` +
    // The inline preview depends on the browser's own PDF viewer; the links
    // above are the path that always works.
    `<p class="note dim">Preview needs the browser's PDF viewer. Use the links above if it stays blank.</p>` +
    `</div>`;
}

/**
 * The floating "your résumé is ready" card.
 *
 * Named after the job rather than the run: `selected_job_id` is what the
 * tailoring actually ran against, and the parent search's rows carry the
 * title and company to print. A run whose parent rows are not loaded still
 * gets a card — it just says "your résumé" instead of naming the posting.
 */
function renderDock(run, file, problems) {
  if (state.dockDismissed === run.id) return;

  const c = run.render.ats_check;
  const job = run.selected_job_id ? run.results.find((r) => r.job_id === run.selected_job_id) : null;

  el.dock.dataset.ok = String(c.passed);
  el.dock.hidden = false;
  el.dockEyebrow.textContent = c.passed ? "Résumé ready" : "Résumé ready · needs review";
  el.dockJob.textContent = job ? `${job.title} — ${job.company}` : "Tailored résumé";
  el.dockCheck.textContent = c.passed
    ? `ATS check passed · ${c.extracted_chars} chars re-extracted`
    : problems.length
      ? `ATS check failed — ${problems.join("; ")}`
      : "ATS check failed — read it before sending";
  el.dockPdf.href = file(run.render.pdf_path);
  el.dockDocx.href = file(run.render.docx_path);
}

function hideDock() {
  el.dock.hidden = true;
}

function renderTrace(run) {
  if (!run.trace.length) {
    el.tracePanel.hidden = true;
    return;
  }
  el.tracePanel.hidden = false;

  const byAgent = new Map();
  let total = 0;
  for (const t of run.trace) {
    const a = byAgent.get(t.agent) ?? { calls: 0, cost: 0 };
    a.calls++;
    a.cost += t.usage.cost_usd;
    byAgent.set(t.agent, a);
    total += t.usage.cost_usd;
  }

  el.traceMeta = $("trace-meta");
  el.traceMeta.textContent = `$${total.toFixed(5)} · ${run.trace.length} nodes`;
  el.trace.innerHTML = [...byAgent]
    .sort((a, b) => b[1].cost - a[1].cost)
    .map(
      ([agent, a]) =>
        `<tr data-code="${a.cost === 0}"><td>${escape(agent)}</td>` +
        `<td>${a.calls}</td><td>$${a.cost.toFixed(5)}</td></tr>`,
    )
    .join("");
}

/* ── run history ──────────────────────────────────────────────────── */

async function refreshRuns() {
  const { runs = [] } = await getJson("/api/runs").catch(() => ({ runs: [] }));
  el.runs.innerHTML = "";
  for (const r of runs) {
    const li = document.createElement("li");
    li.dataset.active = String(r.id === state.runId);
    li.dataset.id = r.id;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.innerHTML =
      `<span class="run__kind" style="color:${r.kind === "tailor" ? "var(--cyan)" : "var(--ink-faint)"}">${r.kind}</span>` +
      `<span class="run__id">${escape(r.id)}</span>` +
      `<span class="run__brief">${escape(r.brief.slice(0, 52))}</span>`;
    btn.addEventListener("click", () => openPastRun(r));
    li.append(btn);
    el.runs.append(li);
  }
}

async function openPastRun(r) {
  if (state.source) state.source.close();
  stopClock();
  // A stored run is finished by definition; a live strip on it would lie.
  hideWorking();
  state.runId = r.id;
  // Keeps the address bar pointing at what is on screen, so a reload or a
  // shared link lands back here.
  history.replaceState(null, "", `?run=${encodeURIComponent(r.id)}`);
  if (r.kind === "search") state.searchRunId = r.id;
  el.streamMeta.textContent = `${r.id} · from the store`;
  el.stream.innerHTML = "";
  markActiveRun(r.id);

  const run = await getJson(`/api/run?id=${encodeURIComponent(r.id)}`).catch(() => null);
  if (!run) return;

  state.lastRun = run;
  // Reopening a run that stopped on a question must offer the way out of it,
  // not just show the question again.
  state.dockDismissed = null;

  // Replay the persisted trace, so a past run reads the same way a live one did.
  run.trace.forEach((t, i) => {
    const isCode = !t.model;
    pushRaw(
      `<span class="ev__n">${i + 1}</span>` +
        `<span class="ev__agent">${escape(t.agent)}</span>` +
        `<span class="ev__summary">${escape(t.output_summary)}</span>` +
        `<span class="ev__tail">` +
        `<span class="ev__tier" data-code="${isCode}">${escape(isCode ? "code" : shortModel(t.model))}</span>` +
        `<span class="ev__cost">${t.usage.cost_usd > 0 ? `$${t.usage.cost_usd.toFixed(4)}` : ""}</span>` +
        `<span>${Math.round(t.duration_ms)}ms</span></span>`,
      "",
      { status: t.status },
    );
  });

  el.lattice.innerHTML = '<p class="empty">The lattice is drawn live. Start a run to watch it.</p>';
  el.latticeMeta.textContent = "—";

  // The closing line, replayed. Without it a reopened run showed "partial"
  // with nothing anywhere on the page saying what had been skipped.
  const skipped = run.skipped ?? [];
  if (skipped.length) {
    pushRaw(
      `<span class="ev__summary"><strong>${escape(run.status)}</strong> — ` +
        `the results are complete; these steps did not finish:` +
        `<ul class="skipped-list">${skipped.map((x) => `<li>${escape(x)}</li>`).join("")}</ul>` +
        `</span>`,
      "ev--final",
      { status: run.status },
    );
  }
  setStatus(run.status, skipped);
  renderResults(run);
  renderQuestions(run);
  renderArtifacts(run);
  renderTrace(run);
}

function markActiveRun(runId) {
  for (const li of el.runs.querySelectorAll("li")) {
    li.dataset.active = String(li.dataset.id === runId);
  }
}

/* ── helpers ──────────────────────────────────────────────────────── */

async function getJson(url) {
  const res = await fetch(url);
  return res.json();
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

function shortModel(m) {
  return String(m).replace(/^scripted:/, "~").replace(/^claude-/, "");
}

function escape(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch],
  );
}
