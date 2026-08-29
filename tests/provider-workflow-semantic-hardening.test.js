import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { rankImpactCandidates } from "../src/agents/impact-investigator.js";
import {
  analyzeRuleChanges,
  compilePolicyRules,
  EvidenceError,
  recoverRuleChanges,
} from "../src/agents/policy-analyst.js";
import { createTraceRecorder } from "../src/agents/trace.js";
import { validateVerifications } from "../src/agents/provider-validation.js";
import { analyzeScenarioWithProvider } from "../src/agents/provider-workflow.js";
import { verifyCandidate } from "../src/agents/verifier.js";
import { toPublicScenario } from "../src/domain/scenario.js";
import { createProviderAdvancedPredictions } from "../src/evaluation/provider-predictions.js";
import { loadBenchmark } from "../src/evaluation/index.js";
import { canonicalJson, ProviderError } from "../src/providers/contracts.js";

const MODEL = "deterministic-role-capture-v1";
const STATIC_TIME = "2026-08-29T00:00:00.000Z";

function trace(caseId) {
  return createTraceRecorder({ runId: `semantic-${caseId}`, scenarioId: caseId, now: () => STATIC_TIME });
}

function providerProjection(recovered) {
  return {
    deltas: recovered.deltas.map(({ ambiguity: _ambiguity, ...delta }) => delta),
    boundaryCases: recovered.boundaryCases,
  };
}

function normalizedEvidence(item) {
  return {
    type: String(item.type ?? "evidence"),
    deltaId: typeof item.deltaId === "string" ? item.deltaId : null,
    recordId: typeof item.recordId === "string" ? item.recordId : null,
    quote: typeof item.quote === "string" ? item.quote : null,
    citation: item.citation ?? null,
    detail: canonicalJson(item),
  };
}

function deterministicData(request) {
  const stageTrace = trace(request.caseId);
  if (request.role === "rule-compiler") return compilePolicyRules({ ...request.input, trace: stageTrace });
  if (request.role === "change-analyst") {
    try {
      return analyzeRuleChanges({ ...request.input, trace: stageTrace });
    } catch (error) {
      if (!(error instanceof EvidenceError)) throw error;
      return providerProjection(recoverRuleChanges(request.input));
    }
  }
  if (request.role === "impact-investigator") {
    return {
      candidates: rankImpactCandidates({ ...request.input, trace: stageTrace }).map(({ status: _status, evidence, ...candidate }) => ({
        ...candidate,
        evidence: evidence.map(normalizedEvidence),
      })),
    };
  }
  if (request.role === "independent-verifier") {
    return {
      verifications: request.input.candidates.map((candidate) => {
        const evidence = candidate.evidence.map((item) => JSON.parse(item.detail));
        return {
          recordId: candidate.recordId,
          ruleDeltaIds: [...candidate.ruleDeltaIds],
          citations: evidence
            .filter((item) => item.type === "changed-rule-citation" && item.citation)
            .map((item) => ({ deltaId: item.deltaId, citation: item.citation })),
          ...verifyCandidate({
            candidate: { ...candidate, evidence },
            scenario: request.input.scenario,
            analysis: request.input.analysis,
            trace: stageTrace,
          }),
        };
      }),
    };
  }
  throw new Error(`Unexpected role ${request.role}`);
}

function result(data, index) {
  return {
    data,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    responseId: `semantic-${String(index).padStart(4, "0")}`,
    model: MODEL,
    latencyMs: 0,
    transportAttempts: 1,
    attempts: [{ attempt: 1, outcome: "deterministic-capture" }],
    estimatedCostUsd: 0,
  };
}

function roleProvider({ transform, throwValue } = {}) {
  const requests = [];
  return {
    name: "semantic-capture",
    requests,
    async complete(request) {
      requests.push(structuredClone(request));
      if (throwValue !== undefined) throw throwValue;
      const original = deterministicData(request);
      const data = transform?.({ request, data: structuredClone(original), call: requests.length }) ?? original;
      return result(data, requests.length);
    },
  };
}

function scenario(id = "fraud-overrides-refunds") {
  return toPublicScenario(loadBenchmark().cases.find((item) => item.id === id));
}

function publicBenchmarkOne() {
  const benchmark = loadBenchmark();
  return {
    benchmarkId: benchmark.benchmarkId,
    reviewBudgetFraction: benchmark.reviewBudgetFraction,
    cases: [toPublicScenario(benchmark.cases[0])],
  };
}

function options(provider) {
  return {
    provider,
    benchmarkId: loadBenchmark().benchmarkId,
    model: MODEL,
    repetition: 1,
    now: () => STATIC_TIME,
  };
}

test("change analyst binds the full trusted semantic signature, not only relationship citations", async (t) => {
  const attacks = [
    ["wrong allowlisted delta type", (data) => { data.deltas[0].type = data.deltas[0].type === "scope-expanded" ? "scope-narrowed" : "scope-expanded"; }],
    ["grounded but incomplete scope and boundary meaning", (data) => {
      data.deltas[0].scopeTerms = [data.deltas[0].scopeTerms[0]];
      data.deltas[0].boundaryCases = [data.deltas[0].boundaryCases[0]];
      data.boundaryCases = [data.boundaryCases[0]];
    }],
  ];
  for (const [name, mutate] of attacks) {
    await t.test(name, async () => {
      const provider = roleProvider({ transform({ request, data }) {
        if (request.role === "change-analyst") mutate(data);
        return data;
      } });
      await assert.rejects(analyzeScenarioWithProvider(scenario(), options(provider)), /schema repair|invalid output/i);
      assert.equal(provider.requests.filter((item) => item.role === "change-analyst").length, 3);
    });
  }
});

test("investigator evidence and score are recomputed from public scenario semantics", async () => {
  const rejectedMarker = "forged-scope-detail-must-not-count";
  const provider = roleProvider({ transform({ request, data }) {
    if (request.role === "impact-investigator") {
      const candidate = data.candidates[0];
      const detail = {
        type: "scope-match",
        deltaId: candidate.ruleDeltaIds[0],
        scopeTerm: rejectedMarker,
        recordTerm: rejectedMarker,
        matchType: "exact",
        explanation: "Provider-declared evidence is not controller evidence.",
      };
      candidate.evidence.push(normalizedEvidence(detail));
      candidate.scoreBreakdown.exactChangedScopePhraseMatches += 1;
      candidate.score += 4;
    }
    return data;
  } });
  await assert.rejects(analyzeScenarioWithProvider(scenario(), options(provider)), /schema repair|invalid output/i);
  assert.equal(provider.requests.filter((item) => item.role === "impact-investigator").length, 3);
});

test("support verdict requires a nonblank resolving record quote", () => {
  const value = scenario();
  const compiled = compilePolicyRules({ ...value, trace: trace(value.id) });
  const changes = analyzeRuleChanges({ ...compiled, trace: trace(value.id) });
  const analysis = { ...compiled, ...changes };
  const candidates = rankImpactCandidates({ scenario: value, analysis, trace: trace(value.id) }).map(({ evidence, ...candidate }) => ({
    ...candidate,
    evidence: evidence.map(normalizedEvidence),
  }));
  const target = candidates.find((candidate) => candidate.evidence.some((item) => item.type === "record-evidence")
    && candidate.evidence.some((item) => item.type === "changed-rule-citation"));
  assert.ok(target);
  const recordEvidence = target.evidence.find((item) => item.type === "record-evidence");
  recordEvidence.quote = null;
  recordEvidence.detail = canonicalJson({ ...JSON.parse(recordEvidence.detail), quote: null });
  const verifications = candidates.map((candidate) => ({
    recordId: candidate.recordId,
    ruleDeltaIds: [...candidate.ruleDeltaIds],
    citations: candidate.evidence
      .filter((item) => item.type === "changed-rule-citation" && item.citation)
      .map((item) => ({ deltaId: item.deltaId, citation: item.citation })),
    verdict: candidate === target ? "support" : "uncertain",
    counterargument: "A bounded counterargument remains.",
    evidenceComplete: candidate === target,
    precedenceChecked: candidate === target,
  }));
  assert.throws(() => validateVerifications({ verifications }, candidates, value, analysis), /record|quote|evidence/i);
});

test("provider-thrown Proxy and accessor objects fail closed with a complete safe trace", async (t) => {
  const marker = "PRIVATE_MARKER_ESCAPED";
  const thrownValues = [
    ["proxy", new Proxy({}, { get() { throw new Error(marker); } })],
    ["accessor", Object.defineProperty({}, "telemetry", { enumerable: true, get() { throw new Error(marker); } })],
  ];
  for (const [name, thrown] of thrownValues) {
    await t.test(name, async () => {
      const provider = roleProvider({ throwValue: thrown });
      let error;
      try { await analyzeScenarioWithProvider(scenario(), options(provider)); } catch (caught) { error = caught; }
      assert.ok(error instanceof ProviderError);
      assert.equal(error.code, "PROVIDER_STAGE_FAILED");
      assert.ok(error.trace.some((event) => event.type === "provider-result" && event.status === "failed"));
      assert.equal(error.trace.at(-1).type, "terminal");
      assert.equal(error.trace.at(-1).terminalState, "failed");
      assert.doesNotMatch(`${error.message}\n${error.stack}\n${JSON.stringify(error)}`, new RegExp(marker));
      assert.doesNotMatch(JSON.stringify(error.trace), new RegExp(marker));
    });
  }
});

test("partial failure telemetry preserves known attempts and latency while usage stays unknown", async () => {
  const provider = roleProvider({
    throwValue: new ProviderError("Static transport failure", "OPENAI_RETRY_EXHAUSTED", {
      telemetry: {
        responseId: null,
        model: null,
        usage: null,
        transportAttempts: 1,
        attempts: [{ attempt: 1, outcome: "http-503" }],
        latencyMs: 19,
        estimatedCostUsd: null,
      },
    }),
  });
  const predictions = await createProviderAdvancedPredictions(publicBenchmarkOne(), options(provider));
  const failed = predictions.cases[0];
  const event = failed.trajectory.find((item) => item.type === "provider-result");
  assert.equal(event.retry.transportAttempts, 1);
  assert.deepEqual(event.payload.attempts, [{ attempt: 1, outcome: "http-503" }]);
  assert.equal(event.latencyMs, 19);
  assert.equal(event.usage, null);
  assert.equal(predictions.metadata.resources.usage, null);
  assert.equal(predictions.metadata.resources.latencyMs, 19);
});

test("unknown failure latency is not reported as measured zero", async () => {
  const provider = roleProvider({ throwValue: new ProviderError("Static preflight failure", "OPENAI_INVALID_REQUEST") });
  const predictions = await createProviderAdvancedPredictions(publicBenchmarkOne(), options(provider));
  assert.equal(predictions.metadata.resources.latencyMs, null);
  assert.equal(predictions.metadata.resources.usage, null);
});

test("prediction configuration rejects evaluator fields, secret-shaped identity, Proxy, and accessors before calls", async (t) => {
  const marker = "sk-private-provider-config-2026";
  const full = loadBenchmark();
  const cases = [
    ["full evaluator benchmark", full, { name: "capture", complete: async () => { throw new Error("called"); } }, MODEL],
    ["provider name secret", publicBenchmarkOne(), { name: marker, complete: async () => { throw new Error("called"); } }, MODEL],
    ["model secret", publicBenchmarkOne(), { name: "capture", complete: async () => { throw new Error("called"); } }, marker],
    ["provider Proxy", publicBenchmarkOne(), new Proxy({}, { get() { throw new Error(marker); } }), MODEL],
    ["provider accessor", publicBenchmarkOne(), Object.defineProperty({ complete: async () => {} }, "name", { get() { throw new Error(marker); } }), MODEL],
  ];
  for (const [name, benchmark, provider, model] of cases) {
    await t.test(name, async () => {
      let calls = 0;
      const complete = Object.getOwnPropertyDescriptor(provider, "complete");
      if (complete?.value) Object.defineProperty(provider, "complete", { ...complete, value: async () => { calls += 1; } });
      let error;
      try { await createProviderAdvancedPredictions(benchmark, { provider, model, repetition: 1 }); } catch (caught) { error = caught; }
      assert.ok(error instanceof ProviderError);
      assert.equal(calls, 0);
      assert.doesNotMatch(`${error.message}\n${error.stack}\n${JSON.stringify(error)}`, new RegExp(marker));
    });
  }
});

test("schema repairs use distinct hash-bound static directives without rejected output", async () => {
  const rejectedMarker = "REJECTED_OUTPUT_MUST_NOT_RETURN";
  let compilerCalls = 0;
  const provider = roleProvider({ transform({ request, data }) {
    if (request.role !== "rule-compiler") return data;
    compilerCalls += 1;
    if (compilerCalls < 3) return { oldRules: [], marker: rejectedMarker };
    return data;
  } });
  await analyzeScenarioWithProvider(scenario(), options(provider));
  const requests = provider.requests.filter((item) => item.role === "rule-compiler");
  assert.equal(requests.length, 3);
  assert.equal(new Set(requests.map((item) => canonicalJson(item))).size, 3);
  assert.equal("controllerRepair" in requests[0].input, false);
  assert.deepEqual(requests.slice(1).map((item) => item.input.controllerRepair), [
    { attempt: 1, reason: "json-schema-validation-failed", pathClass: "schema-shape", instruction: "Return a complete JSON value matching the supplied schema and public evidence constraints." },
    { attempt: 2, reason: "json-schema-validation-failed", pathClass: "schema-shape", instruction: "Return a complete JSON value matching the supplied schema and public evidence constraints." },
  ]);
  assert.doesNotMatch(JSON.stringify(requests.slice(1)), new RegExp(rejectedMarker));
});

test("Ruling 12 prompt contracts disclose semantic validation and flexible IDs/order", () => {
  const compiler = readFileSync(new URL("../prompts/rule-compiler.v1.md", import.meta.url), "utf8");
  const analyst = readFileSync(new URL("../prompts/change-analyst.v1.md", import.meta.url), "utf8");
  assert.match(compiler, /one-to-one.*citation/i);
  assert.match(compiler, /semantic token.*condition.*exception/i);
  assert.match(compiler, /IDs? and order may differ/i);
  assert.match(analyst, /added.*removed.*label-changed.*priority-changed.*scope-changed.*scope-expanded.*scope-narrowed.*exception-changed/i);
  assert.match(analyst, /full semantic signature/i);
  assert.match(analyst, /grounded scope.*boundary/i);
  assert.match(analyst, /IDs? and order may differ/i);
});
