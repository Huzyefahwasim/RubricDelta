import test from "node:test";
import assert from "node:assert/strict";
import {
  createBaselinePredictions,
  evaluateCase,
  evaluatePredictions,
  loadBenchmark,
  rankBaselineCase,
  reviewBudgetForCase,
} from "../src/evaluation/index.js";

const benchmark = loadBenchmark();

function perfectPredictions() {
  return {
    metadata: { system: "oracle-for-test", runtimeMs: 1, estimatedCostUsd: 0 },
    cases: benchmark.cases.map((testCase) => ({
      caseId: testCase.id,
      rankedRecordIds: [
        ...testCase.groundTruth.affectedRecordIds,
        ...testCase.records
          .map((record) => record.id)
          .filter((recordId) => !testCase.groundTruth.affectedRecordIds.includes(recordId)),
      ],
    })),
  };
}

test("benchmark contains ten valid, synthetic fixed-budget cases", () => {
  assert.equal(benchmark.cases.length, 10);
  assert.equal(benchmark.reviewBudgetFraction, 0.2);
  assert.equal(benchmark.license, "CC0-1.0");
  assert.ok(benchmark.cases.some((item) => item.difficulty === "hard" && item.changeType === "precedence_exception"));

  for (const testCase of benchmark.cases) {
    assert.equal(testCase.records.length, 10);
    assert.equal(testCase.groundTruth.affectedRecordIds.length, 2);
    assert.equal(reviewBudgetForCase(testCase, benchmark.reviewBudgetFraction), 2);
  }
});

test("the release protocol floors variable-size review budgets", () => {
  const elevenRecordCase = {
    id: "variable-size-eleven",
    records: Array.from({ length: 11 }, (_, index) => ({ id: `record-${index + 1}` })),
  };

  assert.equal(reviewBudgetForCase(elevenRecordCase, 0.2), 2);
  assert.equal(reviewBudgetForCase({ ...elevenRecordCase, records: elevenRecordCase.records.slice(0, 4) }, 0.2), 1);
});

test("an oracle ranking receives perfect micro and per-case scores", () => {
  const result = evaluatePredictions(benchmark, perfectPredictions());
  assert.deepEqual(result.warnings, []);
  assert.equal(result.primaryMetric.value, 1);
  assert.deepEqual(result.metrics.micro, {
    affectedRecallAtBudget: 1,
    precisionAtBudget: 1,
    f1AtBudget: 1,
  });
  assert.equal(result.perCase.length, 10);
  assert.ok(result.perCase.every((item) => item.metrics.affectedRecallAtBudget === 1));
  assert.ok(result.perCase.every((item) => item.selectionDetails.length === 2));
  assert.ok(result.perCase.every((item) => item.groundTruth.length === 2));
});

test("one hit and one false positive produce recall, precision, and F1 of 0.5", () => {
  const testCase = benchmark.cases[0];
  const affected = testCase.groundTruth.affectedRecordIds[0];
  const unaffected = testCase.records.find((record) => !testCase.groundTruth.affectedRecordIds.includes(record.id)).id;
  const result = evaluateCase(testCase, {
    caseId: testCase.id,
    rankedRecordIds: [affected, unaffected],
  }, 0.2);

  assert.equal(result.metrics.affectedRecallAtBudget, 0.5);
  assert.equal(result.metrics.precisionAtBudget, 0.5);
  assert.equal(result.metrics.f1AtBudget, 0.5);
  assert.equal(result.falseNegativeIds.length, 1);
});

test("submitting fewer records cannot inflate fixed-budget precision", () => {
  const testCase = benchmark.cases[0];
  const result = evaluateCase(testCase, {
    caseId: testCase.id,
    rankedRecordIds: [testCase.groundTruth.affectedRecordIds[0]],
  }, 0.2);

  assert.equal(result.counts.reviewed, 1);
  assert.equal(result.counts.budgetSlots, 2);
  assert.equal(result.metrics.precisionAtBudget, 0.5);
  assert.equal(result.metrics.budgetUtilization, 0.5);
});

test("missing cases are included with zero credit and an explicit warning", () => {
  const firstCase = benchmark.cases[0];
  const result = evaluatePredictions(benchmark, {
    metadata: { system: "partial" },
    cases: [{
      caseId: firstCase.id,
      rankedRecordIds: firstCase.groundTruth.affectedRecordIds,
    }],
  });

  assert.equal(result.caseCount, 10);
  assert.equal(result.primaryMetric.value, 0.1);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /Missing 9 case/);
});

test("the lexical baseline is deterministic and emits a complete ranking", () => {
  const first = createBaselinePredictions(benchmark);
  const second = createBaselinePredictions(benchmark);
  assert.deepEqual(first, second);
  assert.equal(first.cases.length, 10);
  assert.ok(first.cases.every((item) => item.rankedRecordIds.length === 10));
  assert.deepEqual(rankBaselineCase(benchmark.cases[0]), rankBaselineCase(benchmark.cases[0]));

  const result = evaluatePredictions(benchmark, first);
  assert.equal(result.perCase.length, 10);
  assert.equal(result.resourceUse.estimatedCostUsd, 0);
});

test("invalid rankings fail loudly", () => {
  const testCase = benchmark.cases[0];
  assert.throws(() => evaluateCase(testCase, {
    caseId: testCase.id,
    rankedRecordIds: [testCase.records[0].id, testCase.records[0].id],
  }, 0.2), /duplicate record/);

  assert.throws(() => evaluatePredictions(benchmark, {
    cases: [{ caseId: "unknown-case", rankedRecordIds: [] }],
  }), /unknown case/);
});
