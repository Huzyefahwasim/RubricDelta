import test from "node:test";
import assert from "node:assert/strict";

import { toPublicScenario } from "../src/domain/scenario.js";
import { createTraceRecorder } from "../src/agents/trace.js";
import {
  analyzePolicy,
  analyzeRuleChanges,
  compilePolicyRules,
  EvidenceError,
  recoverRuleChanges,
} from "../src/agents/policy-analyst.js";
import { rankImpactCandidates } from "../src/agents/impact-investigator.js";
import { verifyCandidate } from "../src/agents/verifier.js";
import { analyzeScenarioWithProvider } from "../src/agents/provider-workflow.js";
import { canonicalJson, ProviderError } from "../src/providers/contracts.js";
import {
  createProviderAdvancedPredictions,
  createProviderBaselinePredictions,
} from "../src/evaluation/provider-predictions.js";
import {
  createAdvancedPredictions,
  createBaselinePredictions,
  evaluatePredictions,
  loadBenchmark,
  rankBaselineCase,
} from "../src/evaluation/index.js";
import { createPublicBenchmarkProjection } from "../scripts/evaluation-artifacts.js";

const MODEL = "deterministic-role-capture-v1";
const TRACE_FIELDS = [
  "schemaVersion", "runId", "sequence", "timestamp", "scenarioId", "agent", "providerRole", "phase", "type", "prompt",
  "inputRefs", "provider", "status", "usage", "latencyMs", "redaction", "retry", "verification", "terminalState", "payload",
];

function legacyTrace(scenarioId) {
  return createTraceRecorder({ runId: `capture-${scenarioId}`, scenarioId, now: () => "2026-08-29T00:00:00.000Z" });
}

function normalizeEvidence(item) {
  return {
    type: String(item.type ?? "evidence"),
    deltaId: typeof item.deltaId === "string" ? item.deltaId : null,
    recordId: typeof item.recordId === "string" ? item.recordId : null,
    quote: typeof item.quote === "string" ? item.quote : null,
    citation: item.citation ?? null,
    detail: canonicalJson(item),
  };
}

function result(data, index) {
  return {
    data,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    responseId: `deterministic-capture-${String(index).padStart(4, "0")}`,
    model: MODEL,
    latencyMs: 0,
    transportAttempts: 1,
    attempts: [{ attempt: 1, outcome: "completed" }],
    estimatedCostUsd: 0,
  };
}

function capturedChanges(input, trace) {
  try {
    return analyzeRuleChanges({ ...input, trace });
  } catch (error) {
    if (!(error instanceof EvidenceError)) throw error;
    const recovered = recoverRuleChanges(input);
    return {
      deltas: recovered.deltas.map(({ ambiguity: _ambiguity, ...delta }) => delta),
      boundaryCases: recovered.boundaryCases,
    };
  }
}

function createDeterministicRoleProvider({ transform } = {}) {
  const requests = [];
  const provider = {
    name: "capture",
    model: MODEL,
    requests,
    async complete(request) {
      requests.push(structuredClone(request));
      const trace = legacyTrace(request.caseId);
      let data;
      if (request.role === "rule-compiler") {
        data = compilePolicyRules({ ...request.input, trace });
      } else if (request.role === "change-analyst") {
        data = capturedChanges(request.input, trace);
      } else if (request.role === "impact-investigator") {
        const candidates = rankImpactCandidates({ ...request.input, trace }).map(({ status: _status, evidence, ...candidate }) => ({
          ...candidate,
          evidence: evidence.map(normalizeEvidence),
        }));
        data = { candidates };
      } else if (request.role === "independent-verifier") {
        data = {
          verifications: request.input.candidates.map((candidate) => {
            const evidence = candidate.evidence.map((item) => JSON.parse(item.detail));
            const verdict = verifyCandidate({ candidate: { ...candidate, evidence }, scenario: request.input.scenario, analysis: request.input.analysis, trace });
            return {
              recordId: candidate.recordId,
              ruleDeltaIds: [...candidate.ruleDeltaIds],
              citations: evidence
                .filter((item) => item.type === "changed-rule-citation" && item.citation)
                .map((item) => ({ deltaId: item.deltaId, citation: item.citation })),
              ...verdict,
            };
          }),
        };
      } else if (request.role === "direct-baseline") {
        data = { ranking: rankBaselineCase(request.input.scenario) };
      } else {
        throw new Error(`Unexpected role ${request.role}`);
      }
      const transformed = transform?.({ request, data, call: requests.length }) ?? data;
      return result(transformed, requests.length);
    },
  };
  return provider;
}

function publicBenchmark() {
  return createPublicBenchmarkProjection(loadBenchmark());
}

test("policy analysis exposes separate synchronous compiler and change stages without changing output", () => {
  const scenario = toPublicScenario(loadBenchmark().cases[0]);
  const composed = analyzePolicy({ ...scenario, trace: legacyTrace(scenario.id) });
  const compiled = compilePolicyRules({ ...scenario, trace: legacyTrace(scenario.id) });
  const changed = analyzeRuleChanges({ ...compiled, trace: legacyTrace(scenario.id) });
  assert.equal(compiled instanceof Promise, false);
  assert.equal(changed instanceof Promise, false);
  assert.deepEqual({ ...compiled, ...changed }, composed);
  const benchmark = loadBenchmark();
  assert.equal(evaluatePredictions(benchmark, createBaselinePredictions(benchmark)).primaryMetric.value, 0.8);
  assert.equal(evaluatePredictions(benchmark, createAdvancedPredictions(benchmark)).primaryMetric.value, 0.9);
});

test("provider workflow calls four roles in order, blinds batch verifier, and validates every verdict", async () => {
  const benchmark = loadBenchmark();
  const scenario = toPublicScenario(benchmark.cases[0]);
  const provider = createDeterministicRoleProvider();
  const analysis = await analyzeScenarioWithProvider(scenario, {
    provider, benchmarkId: benchmark.benchmarkId, model: MODEL, repetition: 1, runId: "provider-case-1", now: () => "2026-08-29T00:00:00.000Z",
  });
  assert.deepEqual(provider.requests.map((item) => item.role), ["rule-compiler", "change-analyst", "impact-investigator", "independent-verifier"]);
  assert.equal(analysis.rankedCandidates.length, scenario.records.length);
  assert.ok(analysis.rankedCandidates.every((item) => item.status === "pending" && item.verifier));
  const verifier = provider.requests[3];
  assert.equal(JSON.stringify(verifier.input).includes("score"), false);
  assert.equal(JSON.stringify(verifier.input).includes("scoreBreakdown"), false);
  assert.equal(JSON.stringify(verifier.input).includes("groundTruth"), false);
  assert.deepEqual(verifier.input.candidates.map((item) => item.recordId), scenario.records.map((item) => item.id));
});

test("provider trace v1 records inspectable prompts, calls, results, retries, verification, and terminal state", async () => {
  const benchmark = loadBenchmark();
  const scenario = toPublicScenario(benchmark.cases[0]);
  const provider = createDeterministicRoleProvider();
  const run = await analyzeScenarioWithProvider(scenario, {
    provider, benchmarkId: benchmark.benchmarkId, model: MODEL, repetition: 1, runId: "trace-v1-case", now: () => "2026-08-29T00:00:00.000Z",
  });
  for (const event of run.trace) {
    assert.deepEqual(Object.keys(event).sort(), [...TRACE_FIELDS].sort());
    assert.equal(event.schemaVersion, "rubricdelta-provider-trace-v1");
    assert.match(event.prompt.id, /^(rule-compiler|change-analyst|impact-investigator|independent-verifier)$/);
    assert.equal(event.prompt.version, "v1");
    assert.match(event.prompt.sha256, /^[a-f0-9]{64}$/);
    assert.ok(Array.isArray(event.inputRefs));
    assert.equal(event.provider.requestedModel, MODEL);
    assert.deepEqual(Object.keys(event.usage), ["inputTokens", "outputTokens", "totalTokens"]);
    assert.deepEqual(Object.keys(event.retry), ["schemaRepairAttempt", "transportAttempts"]);
    assert.deepEqual(Object.keys(event.redaction), ["applied", "fields"]);
    assert.ok(["running", "complete", "failed"].includes(event.terminalState));
  }
  for (const role of ["rule-compiler", "change-analyst", "impact-investigator", "independent-verifier"]) {
    const events = run.trace.filter((event) => event.providerRole === role);
    assert.ok(events.some((event) => event.type === "provider-call"));
    assert.ok(events.some((event) => event.type === "provider-result"));
  }
  assert.ok(run.trace.some((event) => event.type === "verification" && event.verification.outcome === "validated"));
  assert.equal(run.trace.at(-1).type, "terminal");
  assert.equal(run.trace.at(-1).terminalState, "complete");
  assert.equal(run.trace.filter((event) => event.providerRole === "independent-verifier").every((event) => event.agent === "skeptical-verifier"), true);
});

test("batch verifier rejects missing, duplicate, and unknown verdict record IDs", async (t) => {
  const benchmark = loadBenchmark();
  const scenario = toPublicScenario(benchmark.cases[0]);
  const cases = [
    ["missing", (data) => ({ verifications: data.verifications.slice(1) })],
    ["duplicate", (data) => ({ verifications: [data.verifications[0], ...data.verifications.slice(0, -1)] })],
    ["unknown", (data) => ({ verifications: [{ ...data.verifications[0], recordId: "unknown-record" }, ...data.verifications.slice(1)] })],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const provider = createDeterministicRoleProvider({ transform: ({ request, data }) => request.role === "independent-verifier" ? mutate(data) : data });
      await assert.rejects(analyzeScenarioWithProvider(scenario, {
        provider, benchmarkId: benchmark.benchmarkId, model: MODEL, repetition: 1,
      }), /verifier|verification|record IDs|schema repair/i);
      assert.equal(provider.requests.filter((item) => item.role === "independent-verifier").length, 3);
    });
  }
});

test("controller allows two schema-repair calls beyond the first and never a fourth", async (t) => {
  const benchmark = loadBenchmark();
  const scenario = toPublicScenario(benchmark.cases[0]);
  await t.test("third valid result succeeds", async () => {
    let compilerCalls = 0;
    const provider = createDeterministicRoleProvider({ transform: ({ request, data }) => {
      if (request.role !== "rule-compiler") return data;
      compilerCalls += 1;
      return compilerCalls < 3 ? { oldRules: [] } : data;
    } });
    const run = await analyzeScenarioWithProvider(scenario, { provider, benchmarkId: benchmark.benchmarkId, model: MODEL, repetition: 1 });
    assert.equal(compilerCalls, 3);
    assert.equal(run.trace.filter((event) => event.providerRole === "rule-compiler" && event.type === "retry").length, 2);
  });
  await t.test("third invalid result fails", async () => {
    let compilerCalls = 0;
    const provider = createDeterministicRoleProvider({ transform: ({ request, data }) => {
      if (request.role !== "rule-compiler") return data;
      compilerCalls += 1;
      return { oldRules: [] };
    } });
    await assert.rejects(analyzeScenarioWithProvider(scenario, { provider, benchmarkId: benchmark.benchmarkId, model: MODEL, repetition: 1 }), /schema repair|rule compiler|invalid/i);
    assert.equal(compilerCalls, 3);
  });
});

test("provider baseline and advanced receive only public cases and emit same trace-v1 contract", async () => {
  const benchmark = publicBenchmark();
  const provider = createDeterministicRoleProvider();
  const baseline = await createProviderBaselinePredictions(benchmark, { provider, model: MODEL, repetition: 1, now: () => "2026-08-29T00:00:00.000Z" });
  const advanced = await createProviderAdvancedPredictions(benchmark, { provider, model: MODEL, repetition: 1, now: () => "2026-08-29T00:00:00.000Z" });
  assert.equal(baseline.cases.length, 10);
  assert.equal(advanced.cases.length, 10);
  assert.ok(baseline.cases.every((item) => item.status === "complete" && item.trajectory.at(-1).terminalState === "complete"));
  assert.ok(advanced.cases.every((item) => item.status === "complete" && item.trajectory.at(-1).terminalState === "complete"));
  assert.equal(provider.requests.filter((item) => item.role === "direct-baseline").length, 10);
  assert.equal(provider.requests.filter((item) => item.role !== "direct-baseline").length, 40);
  assert.doesNotMatch(JSON.stringify(provider.requests), /groundTruth|affectedRecordIds|expectedLabels|rationales|reviewOutcomes|workerQuality/);
  for (const item of baseline.cases) {
    assert.ok(item.trajectory.every((event) => event.schemaVersion === "rubricdelta-provider-trace-v1" && event.providerRole === "direct-baseline"));
    assert.ok(item.trajectory.some((event) => event.type === "provider-call"));
    assert.ok(item.trajectory.some((event) => event.type === "provider-result"));
  }
});

test("provider case failure stays explicit, scores zero, and is never deterministic-filled", async () => {
  const full = loadBenchmark();
  const benchmark = createPublicBenchmarkProjection(full);
  const provider = createDeterministicRoleProvider();
  const original = provider.complete.bind(provider);
  let failed = false;
  provider.complete = async (request) => {
    if (!failed && request.role === "direct-baseline") {
      failed = true;
      provider.requests.push(structuredClone(request));
      throw new ProviderError("Injected provider outage", "INJECTED_OUTAGE");
    }
    return original(request);
  };
  const predictions = await createProviderBaselinePredictions(benchmark, { provider, model: MODEL, repetition: 1, now: () => "2026-08-29T00:00:00.000Z" });
  const failedCase = predictions.cases[0];
  assert.equal(failedCase.status, "failed");
  assert.deepEqual(failedCase.rankedRecordIds, []);
  assert.deepEqual(failedCase.rankingEvidence, []);
  assert.equal(failedCase.failure.code, "INJECTED_OUTAGE");
  assert.equal(failedCase.substituted, false);
  const scored = evaluatePredictions(full, predictions);
  assert.equal(scored.perCase[0].submittedRankingSize, 0);
  assert.equal(scored.perCase[0].metrics.affectedRecallAtBudget, 0);
  assert.equal(scored.perCase[0].counts.falseNegatives, full.cases[0].groundTruth.affectedRecordIds.length);
});

function deltaSemanticKey(delta) {
  return canonicalJson({
    citations: [...delta.citations].sort((left, right) => canonicalJson(left) < canonicalJson(right) ? -1 : 1),
    precedenceChanged: delta.precedenceChanged,
    scopeTerms: delta.scopeTerms,
    sourceLabels: [...delta.sourceLabels].sort(),
    targetLabel: delta.targetLabel,
    type: delta.type,
  });
}

function normalizeProviderCandidateIds(candidate, deltaById) {
  const mapId = (id) => deltaById.get(id) ?? id;
  const evidence = candidate.evidence.map((item) => {
    const detail = JSON.parse(item.detail);
    if (typeof detail.deltaId === "string") detail.deltaId = mapId(detail.deltaId);
    return {
      ...item,
      deltaId: item.deltaId === null ? null : mapId(item.deltaId),
      detail: canonicalJson(detail),
    };
  });
  return {
    ...candidate,
    ruleDeltaIds: candidate.ruleDeltaIds.map(mapId),
    evidence,
    verifier: {
      ...candidate.verifier,
      ruleDeltaIds: candidate.verifier.ruleDeltaIds.map(mapId),
      citations: candidate.verifier.citations.map((item) => ({ ...item, deltaId: mapId(item.deltaId) })),
    },
  };
}

test("provider delta order and adversarial IDs cannot change tied labels, citations, or evidence", async () => {
  const benchmark = loadBenchmark();
  const scenario = toPublicScenario(benchmark.cases.find((item) => item.id === "identity-check-login"));
  const cleanProvider = createDeterministicRoleProvider();
  const reversedProvider = createDeterministicRoleProvider({
    transform: ({ request, data }) => {
      if (request.role !== "change-analyst") return data;
      return {
        ...data,
        deltas: [...data.deltas].reverse().map((delta, index) => ({
          ...delta,
          id: index === 0 ? "a-adversarial-provider-delta" : "z-adversarial-provider-delta",
        })),
      };
    },
  });
  const options = {
    benchmarkId: benchmark.benchmarkId,
    model: MODEL,
    repetition: 1,
    now: () => "2026-08-29T00:00:00.000Z",
  };
  const clean = await analyzeScenarioWithProvider(scenario, {
    ...options,
    provider: cleanProvider,
    runId: "delta-order-clean",
  });
  const reversed = await analyzeScenarioWithProvider(scenario, {
    ...options,
    provider: reversedProvider,
    runId: "delta-order-reversed",
  });
  const cleanInvestigator = cleanProvider.requests.find((item) => item.role === "impact-investigator");
  const reversedInvestigator = reversedProvider.requests.find((item) => item.role === "impact-investigator");
  const cleanKeys = cleanInvestigator.input.analysis.deltas.map(deltaSemanticKey);
  const reversedKeys = reversedInvestigator.input.analysis.deltas.map(deltaSemanticKey);
  assert.deepEqual(reversedKeys, cleanKeys);
  const cleanIdMap = new Map(cleanInvestigator.input.analysis.deltas.map((delta) => [delta.id, deltaSemanticKey(delta)]));
  const reversedIdMap = new Map(reversedInvestigator.input.analysis.deltas.map((delta) => [delta.id, deltaSemanticKey(delta)]));
  assert.deepEqual(
    reversed.rankedCandidates.map((item) => normalizeProviderCandidateIds(item, reversedIdMap)),
    clean.rankedCandidates.map((item) => normalizeProviderCandidateIds(item, cleanIdMap)),
  );
});
