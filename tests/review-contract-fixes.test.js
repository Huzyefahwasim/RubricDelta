import assert from "node:assert/strict";
import test from "node:test";

import { createTraceRecorder } from "../src/agents/trace.js";
import { evaluatePredictions } from "../src/evaluation/metrics.js";

function testCase(id) {
  return {
    id,
    title: id,
    difficulty: "test",
    changeType: "test",
    records: ["r1", "r2", "r3", "r4"].map((recordId) => ({
      id: `${id}-${recordId}`,
      text: recordId,
      existingLabel: "OLD",
    })),
    groundTruth: {
      affectedRecordIds: [`${id}-r3`],
      expectedLabels: { [`${id}-r3`]: "NEW" },
      rationales: { [`${id}-r3`]: "test" },
    },
  };
}

test("v3 diagnostics emit exact MRR, support, escalation, failure, and resource data without changing primary scoring", () => {
  const benchmark = {
    benchmarkId: "diagnostic-test",
    reviewBudgetFraction: 0.5,
    cases: [testCase("case-a"), testCase("case-b")],
  };
  const result = evaluatePredictions(benchmark, {
    metadata: { system: "advanced-test", claimSupportContract: "verifier-support-v1" },
    cases: [{
      caseId: "case-a",
      status: "complete",
      rankedRecordIds: ["case-a-r1", "case-a-r2", "case-a-r3", "case-a-r4"],
      rankingEvidence: [
        { recordId: "case-a-r1", ruleDeltaIds: ["delta-1"], evidence: [{ type: "changed-rule-citation", deltaId: "delta-1" }, { type: "record-evidence", recordId: "case-a-r1" }], verifier: { verdict: "support", evidenceComplete: true, precedenceChecked: true } },
        { recordId: "case-a-r2", ruleDeltaIds: ["delta-1"], evidence: [], verifier: { verdict: "uncertain", evidenceComplete: false, precedenceChecked: false } },
        { recordId: "case-a-r3", ruleDeltaIds: ["delta-1"], evidence: [], verifier: { verdict: "reject", evidenceComplete: false, precedenceChecked: false } },
        { recordId: "case-a-r4", ruleDeltaIds: ["delta-1"], evidence: [], verifier: { verdict: "reject", evidenceComplete: false, precedenceChecked: false } },
      ],
      resources: {
        providerCalls: 2,
        providerAttempts: 3,
        usage: { inputTokens: 5, outputTokens: 7, totalTokens: 12 },
        providerLatencyMs: 10,
        runtimeMs: null,
        estimatedCostUsd: 0.02,
      },
    }, {
      caseId: "case-b",
      status: "failed",
      rankedRecordIds: [],
      rankingEvidence: [],
      failure: { code: "TEST_FAILURE" },
      resources: {
        providerCalls: 0,
        providerAttempts: 0,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        providerLatencyMs: 0,
        runtimeMs: null,
        estimatedCostUsd: 0,
      },
    }],
  });

  assert.equal(result.primaryMetric.value, 0);
  assert.equal(result.perCase[0].metrics.reciprocalRankFirstAffected, 0.333333);
  assert.equal(result.perCase[0].metrics.unsupportedClaimRate, 0.5);
  assert.equal(result.perCase[0].metrics.escalationRate, 0.5);
  assert.deepEqual(result.perCase[0].diagnostics.unsupportedClaimIds, ["case-a-r2"]);
  assert.deepEqual(result.perCase[0].diagnostics.escalatedRecordIds, ["case-a-r2"]);
  assert.deepEqual(result.diagnostics.incompleteCaseIds, ["case-b"]);
  assert.deepEqual(result.diagnostics.failedCaseIds, ["case-b"]);
  assert.deepEqual(result.diagnostics.failedRecords, [
    { caseId: "case-b", recordId: "case-b-r1" },
    { caseId: "case-b", recordId: "case-b-r2" },
    { caseId: "case-b", recordId: "case-b-r3" },
    { caseId: "case-b", recordId: "case-b-r4" },
  ]);
  assert.deepEqual(result.secondaryMetrics, {
    meanReciprocalRankFirstAffected: 0.166667,
    unsupportedClaimRate: { value: 0.5, numerator: 1, denominator: 2 },
    escalationRate: { value: 0.5, numerator: 1, denominator: 2, applicable: true, mechanism: "verifier-uncertain" },
  });
  assert.deepEqual(result.resourceUse, {
    providerCalls: 2,
    providerAttempts: 3,
    inputTokens: 5,
    outputTokens: 7,
    totalTokens: 12,
    providerLatencyMs: 10,
    runtimeMs: null,
    estimatedCostUsd: 0.02,
    resourceNotes: "Not supplied; measure and report the complete run.",
  });
});

test("baseline claims are supported only by nonempty matchedTerms", () => {
  const benchmark = { benchmarkId: "baseline-support", reviewBudgetFraction: 0.5, cases: [testCase("case-a")] };
  const result = evaluatePredictions(benchmark, {
    metadata: { system: "baseline-test", claimSupportContract: "matched-terms-v1" },
    cases: [{
      caseId: "case-a",
      rankedRecordIds: ["case-a-r1", "case-a-r2", "case-a-r3", "case-a-r4"],
      rankingEvidence: [
        { recordId: "case-a-r1", matchedTerms: ["refund"] },
        { recordId: "case-a-r2", matchedTerms: [] },
      ],
    }],
  });
  assert.deepEqual(result.perCase[0].diagnostics.unsupportedClaimIds, ["case-a-r2"]);
  assert.equal(result.perCase[0].metrics.unsupportedClaimRate, 0.5);
  assert.equal(result.perCase[0].metrics.escalationRate, 0);
});

test("declared resource metadata must agree with recomputed per-case resources", () => {
  const benchmark = { benchmarkId: "resource-metadata", reviewBudgetFraction: 0.5, cases: [testCase("case-a")] };
  assert.throws(() => evaluatePredictions(benchmark, {
    metadata: {
      resources: {
        providerCalls: 1,
        providerAttempts: 0,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        providerLatencyMs: 0,
        estimatedCostUsd: 0,
      },
    },
    cases: [{
      caseId: "case-a",
      rankedRecordIds: ["case-a-r1", "case-a-r2", "case-a-r3", "case-a-r4"],
      resources: {
        providerCalls: 0,
        providerAttempts: 0,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        providerLatencyMs: 0,
        runtimeMs: null,
        estimatedCostUsd: 0,
      },
    }],
  }), /metadata\.resources must agree/);
});

test("deterministic trace v2 explicitly records identities, refs, retry feedback, usage, redaction, and human linkage", () => {
  const trace = createTraceRecorder({ runId: "run-1", scenarioId: "case-1", now: () => "now" });
  const event = trace.record({
    agent: "skeptical-verifier",
    phase: "verification",
    type: "retry",
    payload: {
      oldGuidelineVersion: "guideline-v1",
      newGuidelineVersion: "guideline-v2",
      recordId: "record-1",
      ruleIds: ["rule-1"],
      deltaIds: ["delta-1"],
      attempt: 2,
      errorCode: "INVALID_VERIFIER_OUTPUT",
      feedbackReason: "Citations did not resolve",
      apiKey: "secret",
    },
  });
  assert.equal(event.schemaVersion, "rubricdelta-deterministic-trace-v2");
  assert.deepEqual(event.operation, {
    id: "skeptical-verifier.verification",
    eventType: "retry",
    instruction: null,
    tool: null,
  });
  assert.deepEqual(event.inputRefs, [
    { kind: "scenario", id: "case-1" },
    { kind: "old-guideline", id: "guideline-v1" },
    { kind: "new-guideline", id: "guideline-v2" },
    { kind: "record", id: "record-1" },
    { kind: "rule", id: "rule-1" },
    { kind: "delta", id: "delta-1" },
  ]);
  assert.equal(event.retryReason, "INVALID_VERIFIER_OUTPUT");
  assert.equal(event.feedbackReason, "Citations did not resolve");
  assert.deepEqual(event.usage, { inputTokens: 0, outputTokens: 0, totalTokens: 0, providerCalls: 0, providerAttempts: 0 });
  assert.deepEqual(event.redaction, { applied: true, fields: ["payload.apiKey"] });
  assert.equal(event.payload.apiKey, "[REDACTED]");
  assert.equal(event.humanDecision, null);
  assert.throws(() => trace.record({ agent: "a", phase: "p", type: "t", payload: {}, durationMs: -1 }), /Invalid trace event/);
});
