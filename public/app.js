import {
  classifyTraceEvent,
  createDecisionRequest,
  createUndoRequest,
  downloadLinkState,
  evaluationSummary,
  keyboardCommand,
  queueSelectionIntent,
  relativeConfidence,
  reviewProgress,
  reviewStateAfterMutationFailure,
  safeDownloadHref,
  synchronizeReview,
} from "./ui-model.js";

const state = {
  demo: null,
  run: null,
  comparison: null,
  trajectory: [],
  selectedIndex: -1,
  selectedDeltaIndex: 0,
  phase: "intake",
  busy: false,
};

const elements = {
  status: document.querySelector("#live-status"),
  systemState: document.querySelector("#system-state"),
  runCoordinate: document.querySelector("#run-coordinate"),
  intake: document.querySelector("#intake-content"),
  delta: document.querySelector("#delta-content"),
  queue: document.querySelector("#impact-queue"),
  detail: document.querySelector("#candidate-detail"),
  evaluation: document.querySelector("#evaluation-content"),
  trajectory: document.querySelector("#trajectory-content"),
  reviewCounter: document.querySelector("#review-counter"),
  selectedRecord: document.querySelector("#selected-record"),
  reviewer: document.querySelector("#reviewer"),
  approve: document.querySelector("#approve"),
  reject: document.querySelector("#reject"),
  escalate: document.querySelector("#escalate"),
  undo: document.querySelector("#undo"),
  exportLink: document.querySelector("#export-download"),
  trajectoryLink: document.querySelector("#trajectory-download"),
  reload: document.querySelector("#reload-demo"),
  tabs: [...document.querySelectorAll("[role='tab'][data-phase]")],
  views: [...document.querySelectorAll("[role='tabpanel'][data-view]")],
};

function make(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text);
  return element;
}

function setStatus(message, tone = "info") {
  elements.status.textContent = message;
  elements.status.dataset.tone = tone;
}

function cleanError(error) {
  if (error instanceof Error && error.message.trim()) return error.message;
  return "The request could not be completed.";
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`Server returned an unreadable response (${response.status}).`);
  }
  if (!response.ok) throw new Error(payload?.error?.message ?? `Request failed (${response.status}).`);
  return payload;
}

async function fetchTrajectory(runId) {
  const response = await fetch(safeDownloadHref(runId, "trajectory"));
  if (!response.ok) throw new Error(`Trajectory request failed (${response.status}).`);
  const jsonl = await response.text();
  if (!jsonl.trim()) return [];
  return jsonl.trim().split(/\r?\n/).map((line) => JSON.parse(line));
}

function activatePhase(phase, focus = false) {
  if (!elements.tabs.some((tab) => tab.dataset.phase === phase)) return;
  state.phase = phase;
  for (const tab of elements.tabs) {
    const selected = tab.dataset.phase === phase;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (selected && focus) tab.focus();
  }
  for (const view of elements.views) view.hidden = view.dataset.view !== phase;
}

function appendDefinitionGrid(parent, entries, className = "meta-grid") {
  const list = make("dl", className);
  for (const [term, description] of entries) {
    const group = make("div");
    group.append(make("dt", "", term), make("dd", "", description));
    list.append(group);
  }
  parent.append(list);
}

function statusClass(status) {
  return ["approved", "rejected", "escalated", "pending"].includes(status) ? `status-${status}` : "status-pending";
}

function verdictClass(verdict) {
  return ["support", "reject", "uncertain"].includes(verdict) ? `verdict-${verdict}` : "verdict-uncertain";
}

function statusLabel(status) {
  const label = make("span", `status-label ${statusClass(status)}`, `State: ${status || "pending"}`);
  return label;
}

function formatPercent(value) {
  return Number.isFinite(Number(value)) ? `${Math.round(Number(value) * 100)}%` : "—";
}

function recordMap() {
  return new Map((state.run?.scenario?.records ?? []).map((record) => [record.id, record]));
}

function renderIntake() {
  const run = state.run;
  if (!run) {
    elements.intake.className = "loading-sheet";
    elements.intake.setAttribute("aria-busy", String(state.busy));
    elements.intake.replaceChildren(
      make("p", "loading-kicker", state.busy ? "Compiling evidence" : "No active run"),
      make("p", "", state.busy ? "Retrieving the public scenario and creating a server-owned run." : "Load the benchmark example to begin."),
    );
    return;
  }

  const scenario = run.scenario;
  const shell = make("div", "dossier-grid");
  const dossier = make("article", "paper-sheet");
  dossier.dataset.coordinate = "DOSSIER / 01";
  dossier.append(
    make("p", "coordinate", `${scenario.difficulty} case / ${scenario.changeType}`),
    make("h3", "dossier-title", scenario.title),
  );
  appendDefinitionGrid(dossier, [
    ["Server run", run.runId],
    ["Run state", run.status],
    ["Old policy", scenario.oldGuideline.version],
    ["New policy", scenario.newGuideline.version],
    ["Source records", String(scenario.records.length)],
    ["Review budget", `${Math.max(1, Math.floor(scenario.records.length * 0.2))} slots / 20%`],
  ]);

  const pipeline = make("aside", "instrument-panel");
  pipeline.dataset.coordinate = "AGENTS / 04";
  pipeline.append(
    make("p", "coordinate", "Purposeful agent stages"),
    make("h3", "evaluation-subhead", "Evidence chain complete"),
  );
  const stages = make("ol", "pipeline-list");
  for (const label of ["Rule compiler", "Change analyst", "Impact investigator", "Skeptical verifier"]) {
    const item = make("li");
    item.append(make("strong", "", label), make("span", "stage-status", "Recorded"));
    stages.append(item);
  }
  pipeline.append(stages);
  const checkpoint = make("p", "view-note left-note", run.escalated
    ? "Verifier ambiguity is preserved for human escalation. The verifier cannot approve export."
    : "Verifier evidence is preserved for a human decision. The verifier cannot approve export.");
  pipeline.append(checkpoint);
  shell.append(dossier, pipeline);
  elements.intake.className = "";
  elements.intake.removeAttribute("aria-busy");
  elements.intake.replaceChildren(shell);
}

function policySheet(kind, guideline) {
  const article = make("article", "paper-sheet policy-sheet");
  article.dataset.coordinate = kind === "old" ? "SOURCE / BEFORE" : "SOURCE / AFTER";
  article.append(
    make("p", "policy-version", `${kind === "old" ? "OLD" : "NEW"} / ${guideline.version}`),
    make("h3", "", kind === "old" ? "Retired policy" : "Active policy"),
  );
  const quote = make(kind === "old" ? "del" : "ins", "policy-quote", guideline.text);
  quote.setAttribute("cite", guideline.version);
  article.append(quote);
  return article;
}

function citationText(citation) {
  if (!citation) return "Citation unavailable";
  return `${citation.documentId} / ${citation.section} / chars ${citation.start}–${citation.end}: “${citation.quote}”`;
}

function renderDeltas() {
  const run = state.run;
  const deltas = run?.analysis?.deltas ?? [];
  if (!run || deltas.length === 0) {
    elements.delta.className = "empty-sheet";
    elements.delta.replaceChildren(make("p", "", run ? "No semantic rule deltas were produced." : "Rule evidence will appear when the server run completes."));
    return;
  }
  if (state.selectedDeltaIndex >= deltas.length) state.selectedDeltaIndex = 0;
  const selected = deltas[state.selectedDeltaIndex];
  const wrapper = make("div", "rule-flow");
  const comparison = make("div", "policy-comparison");
  const seam = make("div", "seam-spine");
  seam.setAttribute("aria-hidden", "true");
  seam.append(make("span", "", "Rule seam"));
  comparison.append(policySheet("old", run.scenario.oldGuideline), seam, policySheet("new", run.scenario.newGuideline));
  wrapper.append(comparison);

  const station = make("section", "delta-station");
  station.setAttribute("aria-label", "Selected semantic delta");
  const toolbar = make("div", "delta-toolbar");
  toolbar.setAttribute("aria-label", "Rule deltas");
  for (const [index, delta] of deltas.entries()) {
    const button = make("button", "delta-button", `${String(index + 1).padStart(2, "0")} / ${delta.type}`);
    button.type = "button";
    button.setAttribute("aria-pressed", String(index === state.selectedDeltaIndex));
    button.addEventListener("click", () => {
      state.selectedDeltaIndex = index;
      renderDeltas();
    });
    toolbar.append(button);
  }
  station.append(
    make("p", "coordinate", `SELECTED DELTA / ${selected.id}`),
    toolbar,
    make("h3", "", selected.type.replaceAll("-", " ")),
  );
  appendDefinitionGrid(station, [
    ["Target label", selected.targetLabel],
    ["Precedence changed", selected.precedenceChanged ? "Yes — changed priority governs" : "No"],
    ["Old rule IDs", selected.oldRuleIds.join(", ")],
    ["New rule IDs", selected.newRuleIds.join(", ")],
    ["Scope terms", selected.scopeTerms.join(", ")],
    ["Boundary count", String(selected.boundaryCases.length)],
  ], "delta-grid");

  const citationHeading = make("h4", "", "Source citations");
  const citations = make("ol", "citation-list");
  for (const citation of selected.citations) citations.append(make("li", "", citationText(citation)));
  const boundaryHeading = make("h4", "", "Boundary hypotheses");
  const boundaries = make("ul", "boundary-list");
  for (const boundary of selected.boundaryCases) boundaries.append(make("li", "", boundary));
  station.append(citationHeading, citations, boundaryHeading, boundaries);
  wrapper.append(station);

  const records = recordMap();
  const impacted = run.recommendations.filter((candidate) => candidate.ruleDeltaIds.includes(selected.id));
  const branches = make("div", "impact-branches");
  branches.setAttribute("aria-label", `${impacted.length} candidates linked to the selected delta`);
  for (const candidate of impacted) {
    const card = make("button", "branch-card");
    card.type = "button";
    card.append(
      make("strong", "", candidate.recordId),
      make("span", "", `${candidate.existingLabel} → ${candidate.proposedLabel}`),
      make("p", "", records.get(candidate.recordId)?.text ?? "Record text unavailable"),
      statusLabel(candidate.status),
    );
    card.addEventListener("click", () => {
      state.selectedIndex = run.recommendations.findIndex((item) => item.recordId === candidate.recordId);
      renderImpact();
      renderDecisionBar();
      activatePhase("impact");
    });
    branches.append(card);
  }
  wrapper.append(branches);
  elements.delta.className = "";
  elements.delta.replaceChildren(wrapper);
}

function evidenceDescription(evidence) {
  if (!evidence || typeof evidence !== "object") return "Evidence item unavailable";
  if (evidence.type === "scope-match") return `${evidence.explanation} Match: ${evidence.scopeTerm} ↔ ${evidence.recordTerm} (${evidence.matchType}).`;
  if (evidence.type === "boundary-condition") return `Boundary hypothesis matched: ${evidence.boundaryCase}.`;
  if (evidence.type === "changed-rule-citation") return citationText(evidence.citation);
  if (evidence.type === "record-evidence") return `${evidence.recordId}: “${evidence.quote}”`;
  return `Evidence type: ${evidence.type ?? "unknown"}`;
}

function renderCandidateDetail(candidate, index) {
  if (!candidate) {
    elements.detail.className = "candidate-detail empty-sheet";
    elements.detail.replaceChildren(make("p", "", "No candidate is available for review."));
    return;
  }
  const record = recordMap().get(candidate.recordId);
  const scores = state.run.recommendations.map((item) => Number(item.score)).filter(Number.isFinite);
  const confidence = relativeConfidence(candidate, Math.max(0, ...scores));
  elements.detail.className = "candidate-detail paper-sheet";
  elements.detail.dataset.coordinate = `QUEUE / ${String(index + 1).padStart(2, "0")}`;
  elements.detail.replaceChildren();
  elements.detail.append(
    make("p", "coordinate", `RECORD / ${candidate.recordId}`),
    statusLabel(candidate.status),
    make("h3", "", `Candidate ${String(index + 1).padStart(2, "0")}`),
  );
  const quote = make("blockquote", "record-quote", record?.text ?? "Record text unavailable");
  elements.detail.append(quote);

  const transition = make("div", "label-transition");
  const existing = make("div", "label-cell");
  existing.append(make("small", "", "Existing source label"), make("strong", "", candidate.existingLabel));
  const proposed = make("div", "label-cell");
  proposed.append(make("small", "", "Proposed correction"), make("strong", "", candidate.proposedLabel));
  transition.append(existing, make("div", "transition-arrow", "→"), proposed);
  elements.detail.append(transition);

  const metrics = make("dl", "evidence-metrics");
  const metricEntries = [
    ["Rank score", String(candidate.score)],
    ["Relative confidence", `${confidence.value}% / ${confidence.label}`],
    ["Evidence items", String(candidate.evidence.length)],
  ];
  for (const [term, value] of metricEntries) {
    const group = make("div");
    group.append(make("dt", "", term), make("dd", "", value));
    if (term === "Relative confidence") {
      const meter = make("meter", "confidence-meter");
      meter.min = 0;
      meter.max = 100;
      meter.value = confidence.value;
      meter.textContent = `${confidence.value}%`;
      group.append(meter);
    }
    metrics.append(group);
  }
  elements.detail.append(metrics);

  const breakdownHeading = make("h4", "", "Numeric evidence breakdown");
  const breakdown = make("div", "score-breakdown");
  for (const [name, value] of Object.entries(candidate.scoreBreakdown ?? {})) {
    const row = make("div");
    row.append(make("span", "", name.replaceAll(/([A-Z])/g, " $1").trim()), make("strong", "", String(value)));
    breakdown.append(row);
  }
  elements.detail.append(breakdownHeading, breakdown);

  const evidenceHeading = make("h4", "", "Evidence chain");
  const evidenceList = make("ol", "evidence-list");
  for (const evidence of candidate.evidence) evidenceList.append(make("li", "", evidenceDescription(evidence)));
  if (candidate.evidence.length === 0) evidenceList.append(make("li", "", "No evidence returned — approval is not suggested."));
  elements.detail.append(evidenceHeading, evidenceList);

  const verifier = make("section", "verifier-box");
  verifier.append(
    make("span", `verdict-label ${verdictClass(candidate.verifier?.verdict)}`, `Verifier: ${candidate.verifier?.verdict ?? "uncertain"}`),
    make("h4", "", "Skeptical counterargument"),
    make("p", "", candidate.verifier?.counterargument ?? "No verifier counterargument was recorded."),
    make("p", "", `Evidence complete: ${candidate.verifier?.evidenceComplete ? "yes" : "no"}. Precedence checked: ${candidate.verifier?.precedenceChecked ? "yes" : "no"}.`),
  );
  elements.detail.append(verifier);
}

function renderImpact(focusTargetId = null) {
  const candidates = state.run?.recommendations ?? [];
  elements.queue.replaceChildren();
  if (candidates.length === 0) {
    elements.queue.append(make("p", "empty-sheet", state.run ? "The complete ranking is empty." : "The queue will appear when the server run completes."));
    renderCandidateDetail(null, -1);
    return;
  }
  if (state.selectedIndex < 0 || state.selectedIndex >= candidates.length) state.selectedIndex = 0;
  const records = recordMap();
  for (const [index, candidate] of candidates.entries()) {
    const item = make("li", "queue-item");
    const option = make("button", "queue-option");
    option.type = "button";
    option.id = `queue-option-${index}`;
    option.setAttribute("aria-pressed", String(index === state.selectedIndex));
    option.setAttribute("aria-controls", "candidate-detail");
    option.append(
      make("span", "queue-rank", String(index + 1).padStart(2, "0")),
    );
    const copy = make("span", "queue-copy");
    copy.append(
      make("strong", "", `${candidate.recordId} / score ${candidate.score}`),
      make("span", "", records.get(candidate.recordId)?.text ?? "Record text unavailable"),
    );
    option.append(copy, statusLabel(candidate.status));
    option.addEventListener("click", () => {
      const intent = queueSelectionIntent(index, 0, candidates.length);
      state.selectedIndex = intent.selectedIndex;
      renderImpact(intent.focusTargetId);
      renderDecisionBar();
      setStatus(`Selected ${candidate.recordId}, queue position ${index + 1} of ${candidates.length}.`);
    });
    item.append(option);
    elements.queue.append(item);
  }
  renderCandidateDetail(candidates[state.selectedIndex], state.selectedIndex);
  if (focusTargetId) document.getElementById(focusTargetId)?.focus();
}

function renderMetricCard(term, description) {
  const card = make("dl", "metric-card");
  card.append(make("dt", "", term), make("dd", "", description));
  return card;
}

function renderEvaluation() {
  if (!state.comparison) {
    elements.evaluation.className = "loading-sheet";
    elements.evaluation.setAttribute("aria-busy", String(state.busy));
    elements.evaluation.replaceChildren(make("p", "", state.busy ? "Loading the evaluator-owned comparison…" : "Evaluation is unavailable."));
    return;
  }
  const summary = evaluationSummary(state.comparison);
  const wrapper = make("div");
  const lead = make("section", "metric-lead");
  const baseline = make("div", "metric-result");
  baseline.append(make("small", "", "Simple baseline / affected recall"), make("strong", "", summary.baselineMetric));
  const advanced = make("div", "metric-result");
  advanced.append(make("small", "", "Four-stage system / affected recall"), make("strong", "", summary.advancedMetric));
  lead.append(baseline, make("div", "metric-arrow", "→"), advanced);
  wrapper.append(lead, make("p", "budget-stamp", `Primary metric / affected-record recall at a fixed ${summary.budgetPercent}% human-review budget`));

  const cards = make("div", "evaluation-grid");
  cards.append(
    renderMetricCard("False positives", `${summary.falsePositives.baseline} → ${summary.falsePositives.advanced}`),
    renderMetricCard("Missed affected records", `${summary.misses.baseline} → ${summary.misses.advanced}`),
    renderMetricCard("Baseline runtime", summary.runtime.baseline === null ? "Not claimed" : `${summary.runtime.baseline} ms`),
    renderMetricCard("Advanced runtime", summary.runtime.advanced === null ? "Not claimed" : `${summary.runtime.advanced} ms`),
  );
  wrapper.append(cards);

  const fairness = make("section", "fairness-panel");
  const fairnessCopy = make("div");
  fairnessCopy.append(make("p", "coordinate", "FAIR COMPARISON FLAGS"), make("h3", "evaluation-subhead", "Evaluation integrity"));
  const checks = make("ul", "fairness-list");
  for (const check of summary.fairness) {
    const item = make("li");
    item.append(make("span", `fairness-status ${check.passed ? "fairness-pass" : "fairness-fail"}`, `${check.passed ? "PASS" : "FAIL"} — ${check.label}`));
    checks.append(item);
  }
  fairnessCopy.append(checks);
  const meta = make("p", "fairness-meta", `Provider: ${summary.provider}\nSeed: ${summary.seed}\nCases: ${summary.perCase.length}`);
  fairness.append(fairnessCopy, meta);
  wrapper.append(fairness);

  const tableShell = make("div", "table-scroll");
  const table = make("table", "evaluation-table");
  table.append(make("caption", "", "Per-case result — complete fixed benchmark"));
  const head = make("thead");
  const headerRow = make("tr");
  for (const label of ["Case", "Difficulty", "Budget", "Baseline recall", "Advanced recall", "False positives", "Misses", "Hard-case status"]) headerRow.append(make("th", "", label));
  head.append(headerRow);
  const body = make("tbody");
  for (const item of summary.perCase) {
    const row = make("tr");
    row.dataset.hard = String(item.difficulty === "hard");
    for (const value of [
      `${item.caseId} — ${item.title}`,
      item.difficulty,
      `${item.reviewBudget} slots`,
      formatPercent(item.baselineRecall),
      formatPercent(item.advancedRecall),
      String(item.falsePositives),
      String(item.misses),
      item.hardStatus,
    ]) row.append(make("td", "", value));
    body.append(row);
  }
  table.append(head, body);
  tableShell.append(table);
  wrapper.append(tableShell);
  elements.evaluation.className = "";
  elements.evaluation.removeAttribute("aria-busy");
  elements.evaluation.replaceChildren(wrapper);
}

function eventSummary(event, kind) {
  if (kind === "human-checkpoint") {
    const action = event.payload?.decision ?? event.payload?.type ?? event.type;
    const record = event.payload?.recordId ? ` for ${event.payload.recordId}` : "";
    return `Attributed human ${action}${record}.`;
  }
  if (kind === "verifier-challenge") return "The skeptical verifier tested evidence completeness, precedence, and an alternative interpretation.";
  if (kind === "retry") return "A bounded retry was recorded; the original attempt remains in the trace.";
  return `${event.agent ?? "orchestrator"} recorded ${event.type ?? "result"} during ${event.phase ?? "workflow"}.`;
}

function renderTrajectory() {
  elements.trajectory.replaceChildren();
  if (state.trajectory.length === 0) {
    elements.trajectory.append(make("li", "empty-sheet", state.run ? "This run contains no trajectory events." : "Trajectory events will appear after the server run completes."));
    return;
  }
  for (const event of state.trajectory) {
    const kind = classifyTraceEvent(event);
    const item = make("li", "trajectory-event");
    item.dataset.kind = kind;
    const head = make("div", "event-head");
    head.append(
      make("span", "event-kind", kind.replaceAll("-", " ")),
      make("span", "event-coordinate", `SEQ ${String(event.sequence ?? "—").padStart(3, "0")} / ${event.agent ?? "unknown"} / ${event.phase ?? "unknown"}`),
    );
    const details = make("details", "event-details");
    details.append(make("summary", "", "Inspect structured event"), make("pre", "", JSON.stringify(event, null, 2)));
    item.append(head, make("p", "event-summary", eventSummary(event, kind)), details);
    elements.trajectory.append(item);
  }
}

function renderDecisionBar() {
  const run = state.run;
  const candidates = run?.recommendations ?? [];
  const selected = candidates[state.selectedIndex];
  const progress = reviewProgress(run?.scenario?.records?.length ?? 0, candidates);
  elements.reviewCounter.textContent = `${progress.used} / ${progress.slots} review slots used${progress.overBudget ? ` / ${progress.overBudget} over budget` : ""}`;
  elements.selectedRecord.textContent = selected ? `${selected.recordId} / server state: ${selected.status}` : "No candidate selected";
  const disableDecision = state.busy || !selected;
  for (const button of [elements.approve, elements.reject, elements.escalate]) button.disabled = disableDecision;
  elements.undo.disabled = disableDecision || selected.status === "pending";
  elements.reload.disabled = state.busy;

  for (const [link, kind] of [[elements.exportLink, "export"], [elements.trajectoryLink, "trajectory"]]) {
    const linkState = downloadLinkState(run?.runId ?? null, kind);
    if (linkState.href === null) link.removeAttribute("href");
    else link.setAttribute("href", linkState.href);
    link.setAttribute("aria-disabled", linkState.ariaDisabled);
    link.tabIndex = linkState.tabIndex;
  }
}

function renderAll() {
  renderIntake();
  renderDeltas();
  renderImpact();
  renderEvaluation();
  renderTrajectory();
  renderDecisionBar();
  elements.runCoordinate.textContent = state.run ? `RUN / ${state.run.runId}` : "RUN / INITIALIZING";
  elements.systemState.textContent = state.busy ? "Server operation in progress" : "Offline deterministic path";
}

async function loadWorkbench() {
  if (state.busy) return;
  state.busy = true;
  state.run = null;
  state.trajectory = [];
  state.selectedIndex = -1;
  state.selectedDeltaIndex = 0;
  setStatus("Loading the fixed benchmark and evaluator-owned comparison…");
  renderAll();
  try {
    const [demo, evaluation] = await Promise.all([
      requestJson("/api/demo"),
      requestJson("/api/evaluation"),
    ]);
    state.demo = demo;
    state.comparison = evaluation;
    renderEvaluation();
    setStatus("Public scenario loaded. Creating a server-owned analysis run…");
    const created = await requestJson("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scenario: demo.scenario }),
    });
    state.run = created.run;
    state.selectedIndex = created.run.recommendations.length > 0 ? 0 : -1;
    state.trajectory = await fetchTrajectory(created.runId);
    setStatus(`Run ${created.runId} compiled ${created.run.analysis.deltas.length} rule delta and ranked ${created.run.recommendations.length} candidates.`, "success");
  } catch (error) {
    setStatus(`Workbench error: ${cleanError(error)}`, "error");
  } finally {
    state.busy = false;
    renderAll();
  }
}

async function refreshAuthoritativeRun(runId) {
  const authoritative = await requestJson(`/api/runs/${runId}`);
  const synchronized = synchronizeReview({ run: state.run, selectedIndex: state.selectedIndex }, authoritative);
  state.run = synchronized.run;
  state.selectedIndex = synchronized.selectedIndex;
  state.trajectory = await fetchTrajectory(runId);
}

async function applyDecision(decision) {
  const selected = state.run?.recommendations?.[state.selectedIndex];
  if (!selected || state.busy) return;
  const recordId = selected.recordId;
  const runId = state.run.runId;
  let accepted = false;
  let request;
  try {
    request = createDecisionRequest({
      runId: state.run.runId,
      recordId,
      decision,
      reviewer: elements.reviewer.value,
    });
  } catch (error) {
    setStatus(`Decision blocked: ${cleanError(error)}`, "error");
    return;
  }
  state.busy = true;
  renderDecisionBar();
  setStatus(`Recording attributed ${decision} checkpoint for ${recordId}…`);
  try {
    await requestJson(request.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request.body),
    });
    accepted = true;
    await refreshAuthoritativeRun(runId);
    const serverStatus = state.run.recommendations.find((candidate) => candidate.recordId === recordId)?.status ?? "unknown";
    setStatus(`${decision} recorded for ${recordId}. Authoritative server state: ${serverStatus}.`, "success");
  } catch (error) {
    const safeState = reviewStateAfterMutationFailure({ run: state.run, selectedIndex: state.selectedIndex }, accepted);
    state.run = safeState.run;
    state.selectedIndex = safeState.selectedIndex;
    if (accepted) state.trajectory = [];
    setStatus(accepted
      ? `Decision was accepted, but authoritative refresh failed; stale browser state was cleared. ${cleanError(error)}`
      : `Decision failed; no browser status was applied. ${cleanError(error)}`, "error");
  } finally {
    state.busy = false;
    renderAll();
  }
}

async function undoDecision() {
  const selected = state.run?.recommendations?.[state.selectedIndex];
  if (!selected || selected.status === "pending" || state.busy) return;
  const recordId = selected.recordId;
  const runId = state.run.runId;
  let accepted = false;
  let request;
  try {
    request = createUndoRequest({
      runId: state.run.runId,
      recordId,
      reviewer: elements.reviewer.value,
      reason: "Workbench undo",
    });
  } catch (error) {
    setStatus(`Undo blocked: ${cleanError(error)}`, "error");
    return;
  }
  state.busy = true;
  renderDecisionBar();
  setStatus(`Recording attributed undo for ${recordId}…`);
  try {
    await requestJson(request.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request.body),
    });
    accepted = true;
    await refreshAuthoritativeRun(runId);
    const serverStatus = state.run.recommendations.find((candidate) => candidate.recordId === recordId)?.status ?? "unknown";
    setStatus(`Undo recorded for ${recordId}. Authoritative server state: ${serverStatus}.`, "success");
  } catch (error) {
    const safeState = reviewStateAfterMutationFailure({ run: state.run, selectedIndex: state.selectedIndex }, accepted);
    state.run = safeState.run;
    state.selectedIndex = safeState.selectedIndex;
    if (accepted) state.trajectory = [];
    setStatus(accepted
      ? `Undo was accepted, but authoritative refresh failed; stale browser state was cleared. ${cleanError(error)}`
      : `Undo failed; server state is unchanged. ${cleanError(error)}`, "error");
  } finally {
    state.busy = false;
    renderAll();
  }
}

for (const tab of elements.tabs) {
  tab.addEventListener("click", () => activatePhase(tab.dataset.phase));
  tab.addEventListener("keydown", (event) => {
    const current = elements.tabs.indexOf(tab);
    let next = current;
    if (event.key === "ArrowRight") next = (current + 1) % elements.tabs.length;
    else if (event.key === "ArrowLeft") next = (current - 1 + elements.tabs.length) % elements.tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = elements.tabs.length - 1;
    else return;
    event.preventDefault();
    activatePhase(elements.tabs[next].dataset.phase, true);
  });
}

elements.reload.addEventListener("click", loadWorkbench);
elements.approve.addEventListener("click", () => applyDecision("approve"));
elements.reject.addEventListener("click", () => applyDecision("reject"));
elements.escalate.addEventListener("click", () => applyDecision("escalate"));
elements.undo.addEventListener("click", undoDecision);

document.addEventListener("keydown", (event) => {
  const command = keyboardCommand(event);
  if (!command || state.busy) return;
  event.preventDefault();
  if (command.type === "decision") {
    applyDecision(command.decision);
    return;
  }
  const candidates = state.run?.recommendations ?? [];
  const intent = queueSelectionIntent(state.selectedIndex, command.offset, candidates.length);
  state.selectedIndex = intent.selectedIndex;
  if (state.selectedIndex < 0) return;
  activatePhase("impact");
  renderImpact(intent.focusTargetId);
  renderDecisionBar();
  const selected = candidates[state.selectedIndex];
  setStatus(`Selected ${selected.recordId}, queue position ${state.selectedIndex + 1} of ${candidates.length}.`);
});

activatePhase("intake");
renderDecisionBar();
loadWorkbench();
