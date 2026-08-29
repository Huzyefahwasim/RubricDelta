const RUN_ID = /^run-[a-f0-9-]+$/;
const DECISIONS = new Set(["approve", "reject", "escalate"]);
const DOWNLOADS = Object.freeze({
  export: "export.csv",
  trajectory: "trajectory.jsonl",
});

function requireText(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${label} is required`);
  return value.trim();
}

function requireRunId(runId) {
  if (typeof runId !== "string" || !RUN_ID.test(runId)) throw new TypeError("Invalid server run ID");
  return runId;
}

function commandBody({ recordId, reviewer, reason }) {
  const body = {
    recordId: requireText(recordId, "Record ID"),
    reviewer: requireText(reviewer, "Reviewer"),
  };
  if (typeof reason === "string" && reason.trim().length > 0) body.reason = reason.trim();
  return body;
}

export function createDecisionRequest({ runId, recordId, decision, reviewer, reason }) {
  requireRunId(runId);
  if (!DECISIONS.has(decision)) throw new TypeError("Invalid human decision");
  return {
    url: `/api/runs/${runId}/decisions`,
    body: { ...commandBody({ recordId, reviewer, reason }), decision },
  };
}

export function createUndoRequest({ runId, recordId, reviewer, reason }) {
  requireRunId(runId);
  return {
    url: `/api/runs/${runId}/undo`,
    body: commandBody({ recordId, reviewer, reason }),
  };
}

export function safeDownloadHref(runId, kind) {
  requireRunId(runId);
  if (!Object.hasOwn(DOWNLOADS, kind)) throw new TypeError("Unknown download kind");
  return `/api/runs/${runId}/${DOWNLOADS[kind]}`;
}

export function selectCandidateIndex(currentIndex, offset, length) {
  if (!Number.isInteger(length) || length <= 0) return -1;
  const current = Number.isInteger(currentIndex) && currentIndex >= 0 && currentIndex < length ? currentIndex : 0;
  const step = Number.isFinite(offset) ? Math.trunc(offset) : 0;
  return ((current + step) % length + length) % length;
}

function isEditableTarget(target) {
  if (!target || typeof target !== "object") return false;
  if (target.isContentEditable) return true;
  const tag = String(target.tagName ?? "").toUpperCase();
  return ["INPUT", "TEXTAREA", "SELECT", "BUTTON", "OPTION"].includes(tag);
}

export function keyboardCommand(event) {
  if (!event || event.repeat || event.altKey || event.ctrlKey || event.metaKey || isEditableTarget(event.target)) return null;
  const key = String(event.key ?? "").toLowerCase();
  if (key === "a") return { type: "decision", decision: "approve" };
  if (key === "r") return { type: "decision", decision: "reject" };
  if (key === "e") return { type: "decision", decision: "escalate" };
  if (key === "j") return { type: "navigate", offset: 1 };
  if (key === "k") return { type: "navigate", offset: -1 };
  return null;
}

export function synchronizeReview(previous, authoritativeRun) {
  if (!authoritativeRun || !Array.isArray(authoritativeRun.recommendations)) throw new TypeError("Authoritative run is required");
  const priorRecommendations = previous?.run?.recommendations ?? [];
  const priorRecordId = priorRecommendations[previous?.selectedIndex]?.recordId;
  const matched = authoritativeRun.recommendations.findIndex((candidate) => candidate.recordId === priorRecordId);
  const selectedIndex = matched >= 0 ? matched : (authoritativeRun.recommendations.length > 0 ? 0 : -1);
  return { run: authoritativeRun, selectedIndex };
}

export function reviewStateAfterMutationFailure(previous, mutationAccepted) {
  return mutationAccepted ? { run: null, selectedIndex: -1 } : previous;
}

export function reviewProgress(totalRecords, recommendations, budgetFraction = 0.2) {
  const total = Number.isInteger(totalRecords) && totalRecords > 0 ? totalRecords : 0;
  const slots = total === 0 ? 0 : Math.max(1, Math.floor(total * budgetFraction));
  const decided = Array.isArray(recommendations)
    ? recommendations.filter((candidate) => candidate?.status && candidate.status !== "pending").length
    : 0;
  return {
    slots,
    decided,
    used: Math.min(slots, decided),
    remaining: Math.max(0, slots - decided),
    overBudget: Math.max(0, decided - slots),
  };
}

export function relativeConfidence(candidate, maximumScore) {
  const score = Number(candidate?.score);
  const maximum = Number(maximumScore);
  const value = Number.isFinite(score) && Number.isFinite(maximum) && maximum > 0
    ? Math.max(0, Math.min(100, Math.round((score / maximum) * 100)))
    : 0;
  return { value, label: value >= 75 ? "high" : value >= 40 ? "medium" : "low" };
}

function fixedMetric(value) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(2) : "—";
}

function sumCounts(cases, field) {
  return cases.reduce((total, item) => total + (Number(item?.counts?.[field]) || 0), 0);
}

function sameList(left, right) {
  return JSON.stringify(left ?? []) === JSON.stringify(right ?? []);
}

export function evaluationSummary(payload) {
  if (!payload?.baseline || !payload?.advanced || !payload?.manifest) throw new TypeError("Paired evaluation is required");
  const { baseline, advanced, manifest } = payload;
  const baselineCases = Array.isArray(baseline.perCase) ? baseline.perCase : [];
  const advancedCases = Array.isArray(advanced.perCase) ? advanced.perCase : [];
  const baselineById = new Map(baselineCases.map((item) => [item.caseId, item]));
  const perCase = advancedCases.map((item) => {
    const prior = baselineById.get(item.caseId);
    const advancedRecall = Number(item?.metrics?.affectedRecallAtBudget) || 0;
    return {
      caseId: item.caseId,
      title: item.title,
      difficulty: item.difficulty,
      changeType: item.changeType,
      reviewBudget: item.reviewBudget,
      baselineRecall: Number(prior?.metrics?.affectedRecallAtBudget) || 0,
      advancedRecall,
      falsePositives: Number(item?.counts?.falsePositives) || 0,
      misses: Number(item?.counts?.falseNegatives) || 0,
      hardStatus: item.difficulty === "hard" ? (advancedRecall === 1 ? "passed" : "needs attention") : "standard",
    };
  });
  const fairness = [
    { label: "Same benchmark", passed: baseline.benchmarkId === advanced.benchmarkId && advanced.benchmarkId === manifest.benchmarkId },
    { label: "Same case count", passed: baseline.caseCount === advanced.caseCount && advanced.caseCount === manifest.caseIds?.length },
    { label: "Same 20% review budget", passed: baseline.reviewBudgetFraction === advanced.reviewBudgetFraction && advanced.reviewBudgetFraction === manifest.reviewBudgetFraction },
    { label: "Same ordered cases", passed: sameList(baselineCases.map((item) => item.caseId), manifest.caseIds) && sameList(advancedCases.map((item) => item.caseId), manifest.caseIds) },
  ];
  return {
    baselineMetric: fixedMetric(baseline.primaryMetric?.value),
    advancedMetric: fixedMetric(advanced.primaryMetric?.value),
    budgetPercent: Math.round((Number(manifest.reviewBudgetFraction) || 0) * 100),
    falsePositives: { baseline: sumCounts(baselineCases, "falsePositives"), advanced: sumCounts(advancedCases, "falsePositives") },
    misses: { baseline: sumCounts(baselineCases, "falseNegatives"), advanced: sumCounts(advancedCases, "falseNegatives") },
    runtime: { baseline: baseline.resourceUse?.runtimeMs ?? null, advanced: advanced.resourceUse?.runtimeMs ?? null },
    provider: manifest.provider,
    seed: manifest.seed,
    fairness,
    perCase,
  };
}

export function classifyTraceEvent(event) {
  const type = String(event?.type ?? "").toLowerCase().replaceAll("_", "-");
  const agent = String(event?.agent ?? "").toLowerCase();
  const phase = String(event?.phase ?? "").toLowerCase();
  if (agent === "human-reviewer" || phase === "human-checkpoint" || type.startsWith("human-")) return "human-checkpoint";
  if (type === "final" || type === "final-evidence" || phase === "final" || type === "complete") return "final";
  if (type.includes("retry")) return "retry";
  if (type.includes("validat") || phase.includes("validat")) return "validation";
  if (type.includes("instruction")) return "instruction";
  if (agent.includes("verifier") || phase.includes("verification")) return "verifier-challenge";
  if (type === "action-result") return "action-result";
  if (type.includes("tool-call") || type === "action" || type === "tool") return "tool-call";
  if (type.includes("result")) return "result";
  return "result";
}
