import assert from "node:assert/strict";
import test from "node:test";

import { rankImpactCandidates } from "../src/agents/impact-investigator.js";
import {
  analyzeRuleChanges,
  compilePolicyRules,
  EvidenceError,
  recoverRuleChanges,
} from "../src/agents/policy-analyst.js";
import { createTraceRecorder } from "../src/agents/trace.js";
import {
  validateCandidates,
  validateRuleChanges,
} from "../src/agents/provider-validation.js";
import { analyzeScenarioWithProvider } from "../src/agents/provider-workflow.js";
import { verifyCandidate } from "../src/agents/verifier.js";
import { toPublicScenario } from "../src/domain/scenario.js";
import { loadBenchmark } from "../src/evaluation/index.js";
import { canonicalJson, ProviderError } from "../src/providers/contracts.js";

const MODEL = "deterministic-role-capture-v1";

function trace(caseId) {
  return createTraceRecorder({ runId: `review-${caseId}`, scenarioId: caseId, now: () => "2026-08-29T00:00:00.000Z" });
}

function scenario(id = "fraud-overrides-refunds") {
  return toPublicScenario(loadBenchmark().cases.find((item) => item.id === id));
}

function projection(recovery) {
  return {
    deltas: recovery.deltas.map(({ ambiguity: _ambiguity, ...delta }) => delta),
    boundaryCases: recovery.boundaryCases,
  };
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

function compiledAndChanges(value) {
  const compiled = compilePolicyRules({ ...value, trace: trace(value.id) });
  try {
    return { compiled, changes: analyzeRuleChanges({ ...compiled, trace: trace(value.id) }) };
  } catch (error) {
    if (!(error instanceof EvidenceError)) throw error;
    return { compiled, changes: projection(recoverRuleChanges(compiled)) };
  }
}

test("recovered change output must equal the full citation-mapped semantic projection", () => {
  const value = scenario("perishable-delivery-quality");
  const { compiled, changes } = compiledAndChanges(value);
  const accepted = validateRuleChanges(structuredClone(changes), value, compiled);
  assert.equal(accepted.recovered, true);
  assert.deepEqual(
    accepted.deltas.map(({ id: _id, ...delta }) => delta),
    changes.deltas.map(({ id: _id, ...delta }) => delta),
  );
  const attacks = [
    ["type", (data) => { data.deltas[0].type = "scope-expanded"; }],
    ["scope", (data) => { data.deltas[0].scopeTerms = [data.deltas[0].scopeTerms[0]]; }],
    ["boundary", (data) => {
      data.deltas[0].boundaryCases = [data.deltas[0].boundaryCases[0]];
      data.boundaryCases = [...new Set(data.deltas.flatMap((delta) => delta.boundaryCases))];
    }],
    ["citation", (data) => { data.deltas[0].citations = [data.deltas[0].citations[0], data.deltas[1].citations[1]]; }],
  ];
  for (const [name, mutate] of attacks) {
    const data = structuredClone(changes);
    mutate(data);
    assert.throws(() => validateRuleChanges(data, value, compiled), undefined, name);
  }
});

test("all six investigator counters are bound to controller-recomputed evidence", () => {
  const value = scenario();
  const { compiled, changes } = compiledAndChanges(value);
  const analysis = { ...compiled, ...changes };
  const base = rankImpactCandidates({ scenario: value, analysis, trace: trace(value.id) }).map(({ status: _status, evidence, ...candidate }) => ({
    ...candidate,
    evidence: evidence.map(normalizeEvidence),
  }));
  const attacks = [
    ["boundaryConditionMatch", 1, "boundary-condition", { boundaryCase: changes.boundaryCases[0] }],
    ["existingLabelTransitionMatch", 2, "label-transition", { from: "forged", to: "forged" }],
    ["explicitExclusionMatch", -2, "explicit-exclusion", { matches: ["refund"] }],
  ];
  const order = new Map(value.records.map((record, index) => [record.id, index]));
  for (const [counter, scoreDelta, type, fields] of attacks) {
    const candidates = structuredClone(base);
    const candidate = candidates.find((item) => item.scoreBreakdown[counter] === 0 && item.ruleDeltaIds.length > 0);
    assert.ok(candidate, counter);
    const detail = { type, deltaId: candidate.ruleDeltaIds[0], ...fields };
    candidate.evidence.push(normalizeEvidence(detail));
    candidate.scoreBreakdown[counter] += 1;
    candidate.score += scoreDelta;
    candidates.sort((left, right) => right.score - left.score
      || right.evidence.length - left.evidence.length
      || order.get(left.recordId) - order.get(right.recordId));
    assert.throws(() => validateCandidates({ candidates }, value, analysis), /evidence|score|semantic/i, counter);
  }
});

function providerData(request) {
  const stageTrace = trace(request.caseId);
  if (request.role === "rule-compiler") return compilePolicyRules({ ...request.input, trace: stageTrace });
  if (request.role === "change-analyst") {
    try { return analyzeRuleChanges({ ...request.input, trace: stageTrace }); }
    catch (error) {
      if (!(error instanceof EvidenceError)) throw error;
      return projection(recoverRuleChanges(request.input));
    }
  }
  if (request.role === "impact-investigator") {
    return { candidates: rankImpactCandidates({ ...request.input, trace: stageTrace }).map(({ status: _status, evidence, ...candidate }) => ({
      ...candidate, evidence: evidence.map(normalizeEvidence),
    })) };
  }
  if (request.role === "independent-verifier") {
    return { verifications: request.input.candidates.map((candidate) => {
      const evidence = candidate.evidence.map((item) => JSON.parse(item.detail));
      return {
        recordId: candidate.recordId,
        ruleDeltaIds: [...candidate.ruleDeltaIds],
        citations: evidence.filter((item) => item.type === "changed-rule-citation" && item.citation)
          .map((item) => ({ deltaId: item.deltaId, citation: item.citation })),
        ...verifyCandidate({ candidate: { ...candidate, evidence }, scenario: request.input.scenario, analysis: request.input.analysis, trace: stageTrace }),
      };
    }) };
  }
  throw new Error("unexpected role");
}

function result(data, index) {
  return {
    data,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    responseId: `review-${index}`,
    model: MODEL,
    latencyMs: 0,
    transportAttempts: 1,
    attempts: [{ attempt: 1, outcome: "deterministic-capture" }],
    estimatedCostUsd: 0,
  };
}

function provider(transform) {
  const requests = [];
  return {
    name: "review-capture",
    requests,
    async complete(request) {
      requests.push(structuredClone(request));
      const data = providerData(request);
      return result(transform?.(request, structuredClone(data), requests.length) ?? data, requests.length);
    },
  };
}

function workflowOptions(value) {
  return { provider: value, model: MODEL, benchmarkId: loadBenchmark().benchmarkId, repetition: 1 };
}

test("provider failure inspection never invokes telemetry, code, or retryable accessors", async () => {
  const marker = "PRIVATE_ACCESSOR_TRAP";
  let traps = 0;
  const thrown = {};
  for (const key of ["telemetry", "code", "retryable"]) {
    Object.defineProperty(thrown, key, { enumerable: true, get() { traps += 1; throw new Error(marker); } });
  }
  const value = { name: "throwing-provider", async complete() { throw thrown; } };
  let error;
  try { await analyzeScenarioWithProvider(scenario(), workflowOptions(value)); } catch (caught) { error = caught; }
  assert.ok(error instanceof ProviderError);
  assert.equal(traps, 0);
  assert.ok(error.trace.some((event) => event.type === "provider-result" && event.status === "failed"));
  assert.doesNotMatch(`${error.stack}\n${JSON.stringify(error)}\n${JSON.stringify(error.trace)}`, new RegExp(marker));
});

test("repair feedback distinguishes schema shape from semantic binding without rejected output", async (t) => {
  const marker = "REJECTED_VALUE_MUST_NOT_RETURN";
  const cases = [
    ["schema", (data) => ({ oldRules: data.oldRules, marker }), "json-schema-validation-failed", "schema-shape"],
    ["semantic", (data) => ({ ...data, oldRules: data.oldRules.map((rule, index) => index === 0 ? { ...rule, label: marker } : rule) }), "semantic-contract-validation-failed", "public-evidence-binding"],
  ];
  for (const [name, invalid, reason, pathClass] of cases) {
    await t.test(name, async () => {
      let compilerCalls = 0;
      const value = provider((request, data) => {
        if (request.role !== "rule-compiler") return data;
        compilerCalls += 1;
        return compilerCalls === 1 ? invalid(data) : data;
      });
      await analyzeScenarioWithProvider(scenario(), workflowOptions(value));
      const repairs = value.requests.filter((item) => item.role === "rule-compiler").slice(1);
      assert.equal(repairs.length, 1);
      assert.deepEqual(repairs[0].input.controllerRepair, {
        attempt: 1,
        reason,
        pathClass,
        instruction: "Return a complete JSON value matching the supplied schema and public evidence constraints.",
      });
      assert.doesNotMatch(JSON.stringify(repairs), new RegExp(marker));
    });
  }
});

test("verifier input removes score aliases and uses original scenario record order", async () => {
  const value = provider((request, data) => {
    if (request.role === "impact-investigator") {
      const detail = JSON.parse(data.candidates[0].evidence[0].detail);
      detail.investigatorScore = 999;
      detail.points = 999;
      data.candidates[0].evidence[0].detail = canonicalJson(detail);
    }
    return data;
  });
  await assert.rejects(analyzeScenarioWithProvider(scenario(), workflowOptions(value)), /schema repair|invalid output/i);

  const clean = provider();
  await analyzeScenarioWithProvider(scenario(), workflowOptions(clean));
  const verifierRequest = clean.requests.find((item) => item.role === "independent-verifier");
  assert.deepEqual(
    verifierRequest.input.candidates.map((candidate) => candidate.recordId),
    scenario().records.map((record) => record.id),
  );
  assert.doesNotMatch(JSON.stringify(verifierRequest.input.candidates), /investigatorScore|points|scoreBreakdown|"score"/i);
});
