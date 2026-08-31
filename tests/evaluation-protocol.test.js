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
  id: "rubricdelta-evaluation-v3",
  version: 3,
  supersedes: "rubricdelta-evaluation-v2",
  effectiveDate: "2026-08-31",
  primaryMetric: "microAffectedRecallAtReviewBudget",
  reviewBudget: {
    fractionSource: "benchmark.reviewBudgetFraction",
    calculation: "max(1, floor(recordCount * fraction))",
    rounding: "floor",
    minimumSlotsForNonemptyCase: 1,
  },
  secondaryDiagnostics: {
    rounding: "rates and reciprocal-rank values are rounded to six decimal places",
    reciprocalRankFirstAffected: {
      perCase: "1 / rank of the first affected record in the complete submitted ranking; 0 when absent",
      aggregate: "arithmetic mean across every benchmark case (MRR)",
    },
    unsupportedClaimRate: {
      denominator: "selected reviewed claims",
      baselineSupport: "nonempty matchedTerms under matched-terms-v1",
      advancedSupport: "support verdict, complete evidence, precedence checked, aligned record evidence, and changed-rule citation under verifier-support-v1",
      missingOrMalformedEvidence: "unsupported",
      zeroDenominator: 0,
      comparison: "system-native structural diagnostic; not comparable across support contracts",
    },
    escalationRate: {
      numerator: "selected reviewed advanced claims with verifier.verdict=\"uncertain\"",
      denominator: "selected reviewed claims",
      zeroDenominator: 0,
      applicability: "verifier-support-v1 only; other contracts report applicable=false",
    },
    resources: {
      fields: ["providerCalls", "providerAttempts", "inputTokens", "outputTokens", "totalTokens", "providerLatencyMs", "runtimeMs", "estimatedCostUsd"],
      unknown: null,
      aggregate: "sum only when every included per-case value is known; otherwise null",
    },
  },
};

test("evaluation protocol v3 has the exact public shape and cannot drift at runtime", () => {
  assert.deepEqual(EVALUATION_PROTOCOL, expectedProtocol);
  assert.equal(Object.isFrozen(EVALUATION_PROTOCOL), true);
  assert.equal(Object.isFrozen(EVALUATION_PROTOCOL.reviewBudget), true);
  assert.throws(() => {
    EVALUATION_PROTOCOL.reviewBudget.rounding = "ceil";
  }, TypeError);
});

test("deterministic manifests embed an exact protocol clone and matching budget calculation", (t) => {
  const outputDir = mkdtempSync(join(tmpdir(), "rubricdelta-protocol-v3-"));
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
