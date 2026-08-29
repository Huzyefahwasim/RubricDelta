import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createEvaluationArtifacts } from "../scripts/evaluation-artifacts.js";
import {
  createAdvancedPredictions,
  createBaselinePredictions,
  DEFAULT_BENCHMARK_PATH,
  EVALUATION_PROTOCOL,
  evaluatePredictions,
  loadBenchmark,
} from "../src/evaluation/index.js";

const expectedProtocol = {
  id: "rubricdelta-evaluation-v2",
  version: 2,
  supersedes: "rubricdelta-evaluation-v1",
  effectiveDate: "2026-08-29",
  primaryMetric: "microAffectedRecallAtReviewBudget",
  reviewBudget: {
    fractionSource: "benchmark.reviewBudgetFraction",
    calculation: "max(1, floor(recordCount * fraction))",
    rounding: "floor",
    minimumSlotsForNonemptyCase: 1,
  },
};

test("evaluation protocol v2 has the exact public shape and cannot drift at runtime", () => {
  assert.deepEqual(EVALUATION_PROTOCOL, expectedProtocol);
  assert.equal(Object.isFrozen(EVALUATION_PROTOCOL), true);
  assert.equal(Object.isFrozen(EVALUATION_PROTOCOL.reviewBudget), true);
  assert.throws(() => {
    EVALUATION_PROTOCOL.reviewBudget.rounding = "ceil";
  }, TypeError);
});

test("deterministic manifests embed an exact protocol clone and matching budget calculation", (t) => {
  const outputDir = mkdtempSync(join(tmpdir(), "rubricdelta-protocol-v2-"));
  t.after(() => rmSync(outputDir, { recursive: true, force: true }));
  const benchmark = loadBenchmark();

  const result = createEvaluationArtifacts({
    benchmark,
    benchmarkSource: readFileSync(DEFAULT_BENCHMARK_PATH, "utf8"),
    mode: "both",
    outputDir,
    provider: "deterministic",
    model: null,
    repeats: 1,
    createBaseline: createBaselinePredictions,
    createAdvanced: createAdvancedPredictions,
    score: evaluatePredictions,
  });

  assert.deepEqual(result.manifest.evaluationProtocol, expectedProtocol);
  assert.notEqual(result.manifest.evaluationProtocol, EVALUATION_PROTOCOL);
  assert.notEqual(result.manifest.evaluationProtocol.reviewBudget, EVALUATION_PROTOCOL.reviewBudget);
  assert.equal(result.manifest.reviewBudget.calculation, expectedProtocol.reviewBudget.calculation);
  const persisted = JSON.parse(readFileSync(join(outputDir, "manifest.json"), "utf8"));
  assert.deepEqual(persisted.evaluationProtocol, expectedProtocol);
  assert.equal(result.comparison.baseline.primaryMetric.value, 0.8);
  assert.equal(result.comparison.advanced.primaryMetric.value, 0.9);
});
