import { reviewBudgetForCase } from "./benchmark.js";

function divide(numerator, denominator) {
  return denominator === 0 ? 0 : numerator / denominator;
}

function round(value) {
  return Number(value.toFixed(6));
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

function validatePredictionCases(benchmark, predictions) {
  if (!predictions || !Array.isArray(predictions.cases)) {
    throw new Error("Predictions must contain a cases array");
  }

  const benchmarkIds = new Set(benchmark.cases.map((testCase) => testCase.id));
  const predictionIds = new Set();
  for (const prediction of predictions.cases) {
    if (typeof prediction?.caseId !== "string") {
      throw new Error("Every prediction case must include caseId");
    }
    if (!benchmarkIds.has(prediction.caseId)) {
      throw new Error(`Predictions contain unknown case ${prediction.caseId}`);
    }
    if (predictionIds.has(prediction.caseId)) {
      throw new Error(`Predictions contain duplicate case ${prediction.caseId}`);
    }
    predictionIds.add(prediction.caseId);
    if (!Array.isArray(prediction.rankedRecordIds)) {
      throw new Error(`Prediction ${prediction.caseId} must include rankedRecordIds`);
    }
  }
}

export function evaluateCase(testCase, prediction, reviewBudgetFraction) {
  const budget = reviewBudgetForCase(testCase, reviewBudgetFraction);
  const rankedRecordIds = prediction?.rankedRecordIds ?? [];
  const knownIds = new Set(testCase.records.map((record) => record.id));
  const seenIds = new Set();

  for (const recordId of rankedRecordIds) {
    if (typeof recordId !== "string") {
      throw new Error(`Prediction ${testCase.id} contains a non-string record ID`);
    }
    if (!knownIds.has(recordId)) {
      throw new Error(`Prediction ${testCase.id} contains unknown record ${recordId}`);
    }
    if (seenIds.has(recordId)) {
      throw new Error(`Prediction ${testCase.id} contains duplicate record ${recordId}`);
    }
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

  // The denominator remains the full budget. Returning fewer records therefore
  // cannot game precision by abstaining on difficult cases.
  const precision = divide(truePositives.length, budget);
  const f1 = harmonicMean(precision, recall);
  const recordsById = new Map(testCase.records.map((record) => [record.id, record]));

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
    },
    metrics: {
      affectedRecallAtBudget: round(recall),
      precisionAtBudget: round(precision),
      f1AtBudget: round(f1),
      budgetUtilization: round(divide(selectedIds.length, budget)),
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
    resourceUse: {
      runtimeMs: optionalNonNegativeNumber(prediction?.runtimeMs, `${testCase.id}.runtimeMs`),
      estimatedCostUsd: optionalNonNegativeNumber(prediction?.estimatedCostUsd, `${testCase.id}.estimatedCostUsd`),
    },
  };
}

export function evaluatePredictions(benchmark, predictions) {
  validatePredictionCases(benchmark, predictions);
  const predictionsByCase = new Map(predictions.cases.map((prediction) => [prediction.caseId, prediction]));
  const missingCaseIds = benchmark.cases
    .filter((testCase) => !predictionsByCase.has(testCase.id))
    .map((testCase) => testCase.id);

  const perCase = benchmark.cases.map((testCase) => evaluateCase(
    testCase,
    predictionsByCase.get(testCase.id),
    benchmark.reviewBudgetFraction,
  ));

  const totals = perCase.reduce((accumulator, result) => {
    accumulator.records += benchmark.cases.find((testCase) => testCase.id === result.caseId).records.length;
    accumulator.affected += result.counts.affected;
    accumulator.reviewed += result.counts.reviewed;
    accumulator.budgetSlots += result.counts.budgetSlots;
    accumulator.truePositives += result.counts.truePositives;
    accumulator.falsePositives += result.counts.falsePositives;
    accumulator.falseNegatives += result.counts.falseNegatives;
    return accumulator;
  }, {
    records: 0,
    affected: 0,
    reviewed: 0,
    budgetSlots: 0,
    truePositives: 0,
    falsePositives: 0,
    falseNegatives: 0,
  });

  const microRecall = divide(totals.truePositives, totals.affected);
  const microPrecision = divide(totals.truePositives, totals.budgetSlots);
  const microF1 = harmonicMean(microPrecision, microRecall);
  const macroRecall = divide(
    perCase.reduce((sum, result) => sum + result.metrics.affectedRecallAtBudget, 0),
    perCase.length,
  );
  const macroPrecision = divide(
    perCase.reduce((sum, result) => sum + result.metrics.precisionAtBudget, 0),
    perCase.length,
  );
  const macroF1 = divide(
    perCase.reduce((sum, result) => sum + result.metrics.f1AtBudget, 0),
    perCase.length,
  );

  return {
    benchmarkId: benchmark.benchmarkId,
    system: predictions.metadata?.system ?? "unnamed-system",
    reviewBudgetFraction: benchmark.reviewBudgetFraction,
    caseCount: benchmark.cases.length,
    totals,
    primaryMetric: {
      name: "microAffectedRecallAtReviewBudget",
      value: round(microRecall),
      numerator: totals.truePositives,
      denominator: totals.affected,
    },
    metrics: {
      micro: {
        affectedRecallAtBudget: round(microRecall),
        precisionAtBudget: round(microPrecision),
        f1AtBudget: round(microF1),
      },
      macro: {
        affectedRecallAtBudget: round(macroRecall),
        precisionAtBudget: round(macroPrecision),
        f1AtBudget: round(macroF1),
      },
    },
    resourceUse: {
      runtimeMs: optionalNonNegativeNumber(predictions.metadata?.runtimeMs, "metadata.runtimeMs"),
      estimatedCostUsd: optionalNonNegativeNumber(predictions.metadata?.estimatedCostUsd, "metadata.estimatedCostUsd"),
      resourceNotes: predictions.metadata?.resourceNotes ?? "Not supplied; measure and report the complete run.",
    },
    warnings: missingCaseIds.length > 0
      ? [`Missing ${missingCaseIds.length} case(s); they receive zero credit: ${missingCaseIds.join(", ")}`]
      : [],
    perCase,
  };
}
