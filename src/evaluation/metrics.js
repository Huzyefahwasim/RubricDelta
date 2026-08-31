import { reviewBudgetForCase } from "./benchmark.js";

const SUPPORT_CONTRACTS = new Set(["matched-terms-v1", "verifier-support-v1"]);

function divide(numerator, denominator) {
  return denominator === 0 ? 0 : numerator / denominator;
}

function round(value) {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function harmonicMean(precision, recall) {
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
}

function optionalNonNegativeNumber(value, fieldName) {
  if (value === undefined || value === null) return null;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative finite number or null`);
  }
  return value;
}

function optionalNonNegativeInteger(value, fieldName) {
  const number = optionalNonNegativeNumber(value, fieldName);
  if (number !== null && !Number.isInteger(number)) {
    throw new Error(`${fieldName} must be a non-negative integer or null`);
  }
  return number;
}

function validatePredictionCases(benchmark, predictions) {
  if (!predictions || !Array.isArray(predictions.cases)) {
    throw new Error("Predictions must contain a cases array");
  }
  const benchmarkIds = new Set(benchmark.cases.map((testCase) => testCase.id));
  const predictionIds = new Set();
  for (const prediction of predictions.cases) {
    if (typeof prediction?.caseId !== "string") throw new Error("Every prediction case must include caseId");
    if (!benchmarkIds.has(prediction.caseId)) throw new Error(`Predictions contain unknown case ${prediction.caseId}`);
    if (predictionIds.has(prediction.caseId)) throw new Error(`Predictions contain duplicate case ${prediction.caseId}`);
    predictionIds.add(prediction.caseId);
    if (!Array.isArray(prediction.rankedRecordIds)) throw new Error(`Prediction ${prediction.caseId} must include rankedRecordIds`);
  }
}

function evidenceByRecordId(prediction) {
  const byId = new Map();
  if (!Array.isArray(prediction?.rankingEvidence)) return byId;
  for (const item of prediction.rankingEvidence) {
    if (item && typeof item === "object" && !Array.isArray(item)
      && typeof item.recordId === "string" && !byId.has(item.recordId)) byId.set(item.recordId, item);
  }
  return byId;
}

function claimDiagnostic(contract, evidence) {
  if (contract === "matched-terms-v1") {
    const complete = Boolean(evidence && Array.isArray(evidence.matchedTerms));
    return { supported: complete && evidence.matchedTerms.length > 0, escalated: false, incomplete: !complete };
  }
  if (contract === "verifier-support-v1") {
    const verifier = evidence?.verifier;
    const valid = Boolean(verifier && typeof verifier === "object" && !Array.isArray(verifier)
      && ["support", "reject", "uncertain"].includes(verifier.verdict)
      && typeof verifier.evidenceComplete === "boolean" && typeof verifier.precedenceChecked === "boolean");
    const deltaIds = new Set(Array.isArray(evidence?.ruleDeltaIds) ? evidence.ruleDeltaIds : []);
    const alignedRecordEvidence = Array.isArray(evidence?.evidence)
      && evidence.evidence.some((item) => item?.type === "record-evidence" && item.recordId === evidence.recordId);
    const alignedRuleCitation = Array.isArray(evidence?.evidence)
      && evidence.evidence.some((item) => item?.type === "changed-rule-citation" && deltaIds.has(item.deltaId));
    return {
      supported: valid && verifier.verdict === "support" && verifier.evidenceComplete === true
        && verifier.precedenceChecked === true && alignedRecordEvidence && alignedRuleCitation,
      escalated: valid && verifier.verdict === "uncertain",
      incomplete: !valid,
    };
  }
  return { supported: false, escalated: false, incomplete: true };
}

function caseResources(prediction, caseId) {
  const traceResources = Array.isArray(prediction?.trajectory) ? resourcesFromTrajectory(prediction.trajectory) : null;
  const resources = prediction?.resources ?? traceResources;
  const usage = resources?.usage;
  const runtime = resources && Object.hasOwn(resources, "runtimeMs") ? resources.runtimeMs : prediction?.runtimeMs;
  const cost = resources && Object.hasOwn(resources, "estimatedCostUsd") ? resources.estimatedCostUsd : prediction?.estimatedCostUsd;
  return {
    providerCalls: optionalNonNegativeInteger(resources?.providerCalls, `${caseId}.resources.providerCalls`),
    providerAttempts: optionalNonNegativeInteger(resources?.providerAttempts, `${caseId}.resources.providerAttempts`),
    inputTokens: optionalNonNegativeInteger(usage?.inputTokens, `${caseId}.resources.usage.inputTokens`),
    outputTokens: optionalNonNegativeInteger(usage?.outputTokens, `${caseId}.resources.usage.outputTokens`),
    totalTokens: optionalNonNegativeInteger(usage?.totalTokens, `${caseId}.resources.usage.totalTokens`),
    providerLatencyMs: optionalNonNegativeNumber(resources?.providerLatencyMs, `${caseId}.resources.providerLatencyMs`),
    runtimeMs: optionalNonNegativeNumber(runtime, `${caseId}.runtimeMs`),
    estimatedCostUsd: optionalNonNegativeNumber(cost, `${caseId}.estimatedCostUsd`),
  };
}

function resourcesFromTrajectory(trajectory) {
  const resultEvents = trajectory.filter((event) => event?.type === "provider-result");
  const usageKnown = resultEvents.every((event) => event.usage
    && Number.isInteger(event.usage.inputTokens) && event.usage.inputTokens >= 0
    && Number.isInteger(event.usage.outputTokens) && event.usage.outputTokens >= 0
    && Number.isInteger(event.usage.totalTokens) && event.usage.totalTokens >= 0);
  const latencyKnown = resultEvents.every((event) => Number.isFinite(event.latencyMs) && event.latencyMs >= 0);
  const costKnown = resultEvents.every((event) => Number.isFinite(event.payload?.estimatedCostUsd) && event.payload.estimatedCostUsd >= 0);
  const attemptsKnown = resultEvents.every((event) => Number.isInteger(event.retry?.transportAttempts) && event.retry.transportAttempts >= 0);
  return {
    providerCalls: resultEvents.length,
    providerAttempts: attemptsKnown ? resultEvents.reduce((sum, event) => sum + event.retry.transportAttempts, 0) : null,
    usage: usageKnown ? resultEvents.reduce((sum, event) => ({
      inputTokens: sum.inputTokens + event.usage.inputTokens,
      outputTokens: sum.outputTokens + event.usage.outputTokens,
      totalTokens: sum.totalTokens + event.usage.totalTokens,
    }), { inputTokens: 0, outputTokens: 0, totalTokens: 0 }) : null,
    providerLatencyMs: latencyKnown ? resultEvents.reduce((sum, event) => sum + event.latencyMs, 0) : null,
    estimatedCostUsd: costKnown ? resultEvents.reduce((sum, event) => sum + event.payload.estimatedCostUsd, 0) : null,
  };
}

function aggregateResource(perCase, key) {
  const values = perCase.map((item) => item.resourceUse[key]);
  if (values.some((value) => value === null)) return null;
  return values.reduce((sum, value) => sum + value, 0);
}

function assertMetadataResources(predictions, resourceUse) {
  const declared = predictions.metadata?.resources;
  if (declared === undefined) return;
  if (!declared || typeof declared !== "object" || Array.isArray(declared)) {
    throw new Error("metadata.resources must agree with recomputed per-case resources");
  }
  if (!Object.hasOwn(declared, "providerLatencyMs")) return;
  const expected = {
    providerCalls: resourceUse.providerCalls,
    providerAttempts: resourceUse.providerAttempts,
    inputTokens: resourceUse.inputTokens,
    outputTokens: resourceUse.outputTokens,
    totalTokens: resourceUse.totalTokens,
    providerLatencyMs: resourceUse.providerLatencyMs,
    estimatedCostUsd: resourceUse.estimatedCostUsd,
  };
  const actual = {
    providerCalls: declared.providerCalls,
    providerAttempts: declared.providerAttempts,
    inputTokens: declared.usage?.inputTokens ?? null,
    outputTokens: declared.usage?.outputTokens ?? null,
    totalTokens: declared.usage?.totalTokens ?? null,
    providerLatencyMs: declared.providerLatencyMs ?? null,
    estimatedCostUsd: declared.estimatedCostUsd ?? null,
  };
  if (Object.keys(expected).some((key) => !Object.is(actual[key], expected[key]))) {
    throw new Error("metadata.resources must agree with recomputed per-case resources");
  }
}

export function evaluateCase(testCase, prediction, reviewBudgetFraction, options = {}) {
  const budget = reviewBudgetForCase(testCase, reviewBudgetFraction);
  const rankedRecordIds = prediction?.rankedRecordIds ?? [];
  const knownIds = new Set(testCase.records.map((record) => record.id));
  const seenIds = new Set();
  for (const recordId of rankedRecordIds) {
    if (typeof recordId !== "string") throw new Error(`Prediction ${testCase.id} contains a non-string record ID`);
    if (!knownIds.has(recordId)) throw new Error(`Prediction ${testCase.id} contains unknown record ${recordId}`);
    if (seenIds.has(recordId)) throw new Error(`Prediction ${testCase.id} contains duplicate record ${recordId}`);
    seenIds.add(recordId);
  }

  const selectedIds = rankedRecordIds.slice(0, budget);
  const selectedSet = new Set(selectedIds);
  const affectedIds = testCase.groundTruth.affectedRecordIds;
  const affectedSet = new Set(affectedIds);
  const truePositives = selectedIds.filter((recordId) => affectedSet.has(recordId));
  const falsePositives = selectedIds.filter((recordId) => !affectedSet.has(recordId));
  const falseNegatives = affectedIds.filter((recordId) => !selectedSet.has(recordId));
  const recall = divide(truePositives.length, affectedIds.length);
  const precision = divide(truePositives.length, budget);
  const f1 = harmonicMean(precision, recall);
  const firstAffectedRank = rankedRecordIds.findIndex((recordId) => affectedSet.has(recordId));
  const reciprocalRank = firstAffectedRank === -1 ? 0 : 1 / (firstAffectedRank + 1);
  const recordsById = new Map(testCase.records.map((record) => [record.id, record]));
  const evidence = evidenceByRecordId(prediction);
  const supportContract = SUPPORT_CONTRACTS.has(options.claimSupportContract) ? options.claimSupportContract : null;
  const claimDiagnostics = selectedIds.map((recordId) => ({ recordId, ...claimDiagnostic(supportContract, evidence.get(recordId)) }));
  const unsupportedClaimIds = claimDiagnostics.filter((item) => !item.supported).map((item) => item.recordId);
  const escalatedRecordIds = claimDiagnostics.filter((item) => item.escalated).map((item) => item.recordId);
  const rawFailed = prediction === undefined || prediction?.status === "failed";
  const absentRankingIds = testCase.records.map((record) => record.id).filter((recordId) => !seenIds.has(recordId));
  const incompleteRecordIds = [...new Set(rawFailed
    ? testCase.records.map((record) => record.id)
    : [...absentRankingIds, ...claimDiagnostics.filter((item) => item.incomplete).map((item) => item.recordId)])];
  const evaluationStatus = rawFailed
    ? "failed"
    : incompleteRecordIds.length > 0 || prediction?.status === "partial"
      ? "partial"
      : "complete";

  return {
    caseId: testCase.id,
    title: testCase.title,
    difficulty: testCase.difficulty,
    changeType: testCase.changeType,
    reviewBudget: budget,
    submittedRankingSize: rankedRecordIds.length,
    selectedRecordIds: selectedIds,
    truePositiveIds: truePositives,
    falsePositiveIds: falsePositives,
    falseNegativeIds: falseNegatives,
    counts: {
      affected: affectedIds.length,
      reviewed: selectedIds.length,
      budgetSlots: budget,
      truePositives: truePositives.length,
      falsePositives: falsePositives.length,
      falseNegatives: falseNegatives.length,
      unsupportedClaims: unsupportedClaimIds.length,
      escalations: escalatedRecordIds.length,
    },
    metrics: {
      affectedRecallAtBudget: round(recall),
      precisionAtBudget: round(precision),
      f1AtBudget: round(f1),
      budgetUtilization: round(divide(selectedIds.length, budget)),
      reciprocalRankFirstAffected: round(reciprocalRank),
      unsupportedClaimRate: round(divide(unsupportedClaimIds.length, selectedIds.length)),
      escalationRate: round(divide(escalatedRecordIds.length, selectedIds.length)),
    },
    diagnostics: {
      status: evaluationStatus,
      failureCode: rawFailed ? prediction?.failure?.code ?? "MISSING_PREDICTION" : null,
      claimSupportContract: supportContract,
      structuralSupportComparableAcrossSystems: false,
      escalation: {
        applicable: supportContract === "verifier-support-v1",
        mechanism: supportContract === "verifier-support-v1" ? "verifier-uncertain" : "not-applicable",
      },
      unsupportedClaimIds,
      escalatedRecordIds,
      incompleteRecordIds,
      failedRecordIds: rawFailed ? testCase.records.map((record) => record.id) : [],
    },
    selectionDetails: selectedIds.map((recordId, index) => {
      const record = recordsById.get(recordId);
      const isAffected = affectedSet.has(recordId);
      return {
        rank: index + 1,
        recordId,
        text: record.text,
        existingLabel: record.existingLabel,
        isAffected,
        expectedLabel: isAffected ? testCase.groundTruth.expectedLabels[recordId] : null,
        rationale: isAffected ? testCase.groundTruth.rationales[recordId] : null,
      };
    }),
    groundTruth: affectedIds.map((recordId) => {
      const record = recordsById.get(recordId);
      return {
        recordId,
        text: record.text,
        existingLabel: record.existingLabel,
        expectedLabel: testCase.groundTruth.expectedLabels[recordId],
        rationale: testCase.groundTruth.rationales[recordId],
      };
    }),
    resourceUse: caseResources(prediction, testCase.id),
  };
}

function recordRefs(perCase, key) {
  return perCase.flatMap((item) => item.diagnostics[key].map((recordId) => ({ caseId: item.caseId, recordId })));
}

export function evaluatePredictions(benchmark, predictions) {
  validatePredictionCases(benchmark, predictions);
  const predictionsByCase = new Map(predictions.cases.map((prediction) => [prediction.caseId, prediction]));
  const missingCaseIds = benchmark.cases.filter((testCase) => !predictionsByCase.has(testCase.id)).map((testCase) => testCase.id);
  const claimSupportContract = predictions.metadata?.claimSupportContract;
  const perCase = benchmark.cases.map((testCase) => evaluateCase(
    testCase,
    predictionsByCase.get(testCase.id),
    benchmark.reviewBudgetFraction,
    { claimSupportContract },
  ));

  const totals = perCase.reduce((accumulator, result) => {
    accumulator.records += benchmark.cases.find((testCase) => testCase.id === result.caseId).records.length;
    for (const key of ["affected", "reviewed", "budgetSlots", "truePositives", "falsePositives", "falseNegatives", "unsupportedClaims", "escalations"]) {
      accumulator[key] += result.counts[key];
    }
    return accumulator;
  }, { records: 0, affected: 0, reviewed: 0, budgetSlots: 0, truePositives: 0, falsePositives: 0, falseNegatives: 0, unsupportedClaims: 0, escalations: 0 });

  const microRecall = divide(totals.truePositives, totals.affected);
  const microPrecision = divide(totals.truePositives, totals.budgetSlots);
  const microF1 = harmonicMean(microPrecision, microRecall);
  const macro = (name) => divide(perCase.reduce((sum, result) => sum + result.metrics[name], 0), perCase.length);
  const incompleteCaseIds = perCase.filter((item) => item.diagnostics.status !== "complete").map((item) => item.caseId);
  const failedCaseIds = perCase.filter((item) => item.diagnostics.status === "failed").map((item) => item.caseId);
  const resourceUse = {
    providerCalls: aggregateResource(perCase, "providerCalls"),
    providerAttempts: aggregateResource(perCase, "providerAttempts"),
    inputTokens: aggregateResource(perCase, "inputTokens"),
    outputTokens: aggregateResource(perCase, "outputTokens"),
    totalTokens: aggregateResource(perCase, "totalTokens"),
    providerLatencyMs: aggregateResource(perCase, "providerLatencyMs"),
    runtimeMs: aggregateResource(perCase, "runtimeMs"),
    estimatedCostUsd: aggregateResource(perCase, "estimatedCostUsd"),
    resourceNotes: predictions.metadata?.resourceNotes ?? "Not supplied; measure and report the complete run.",
  };
  assertMetadataResources(predictions, resourceUse);

  return {
    benchmarkId: benchmark.benchmarkId,
    system: predictions.metadata?.system ?? "unnamed-system",
    reviewBudgetFraction: benchmark.reviewBudgetFraction,
    caseCount: benchmark.cases.length,
    totals,
    primaryMetric: { name: "microAffectedRecallAtReviewBudget", value: round(microRecall), numerator: totals.truePositives, denominator: totals.affected },
    metrics: {
      micro: { affectedRecallAtBudget: round(microRecall), precisionAtBudget: round(microPrecision), f1AtBudget: round(microF1) },
      macro: { affectedRecallAtBudget: round(macro("affectedRecallAtBudget")), precisionAtBudget: round(macro("precisionAtBudget")), f1AtBudget: round(macro("f1AtBudget")) },
    },
    secondaryMetrics: {
      meanReciprocalRankFirstAffected: round(macro("reciprocalRankFirstAffected")),
      unsupportedClaimRate: { value: round(divide(totals.unsupportedClaims, totals.reviewed)), numerator: totals.unsupportedClaims, denominator: totals.reviewed },
      escalationRate: {
        value: round(divide(totals.escalations, totals.reviewed)),
        numerator: totals.escalations,
        denominator: totals.reviewed,
        applicable: claimSupportContract === "verifier-support-v1",
        mechanism: claimSupportContract === "verifier-support-v1" ? "verifier-uncertain" : "not-applicable",
      },
    },
    diagnostics: {
      unsupportedClaims: recordRefs(perCase, "unsupportedClaimIds"),
      escalations: recordRefs(perCase, "escalatedRecordIds"),
      incompleteCaseIds,
      failedCaseIds,
      incompleteRecords: recordRefs(perCase, "incompleteRecordIds"),
      failedRecords: recordRefs(perCase, "failedRecordIds"),
    },
    resourceUse,
    warnings: missingCaseIds.length > 0 ? [`Missing ${missingCaseIds.length} case(s); they receive zero credit: ${missingCaseIds.join(", ")}`] : [],
    perCase,
  };
}
