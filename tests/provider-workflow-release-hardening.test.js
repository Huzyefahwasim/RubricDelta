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
import { verifyCandidate } from "../src/agents/verifier.js";
import { analyzeScenarioWithProvider } from "../src/agents/provider-workflow.js";
import { analyzeScenario } from "../src/agents/workflow.js";
import { toPublicScenario } from "../src/domain/scenario.js";
import { createProviderAdvancedPredictions } from "../src/evaluation/provider-predictions.js";
import { loadBenchmark } from "../src/evaluation/index.js";
import { canonicalJson, ProviderError } from "../src/providers/contracts.js";

const MODEL = "deterministic-role-capture-v1";

function trace(caseId) {
  return createTraceRecorder({ runId: `release-${caseId}`, scenarioId: caseId, now: () => "2026-08-29T00:00:00.000Z" });
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
          ...verifyCandidate({ candidate: { ...candidate, evidence }, scenario: request.input.scenario, analysis: request.input.analysis, trace: stageTrace }),
        };
      }),
    };
  }
  throw new Error("Unexpected provider role");
}

function roleProvider({ transform, failRole, failure, estimatedCostUsd = 0 } = {}) {
  const requests = [];
  return {
    name: "capture",
    model: MODEL,
    requests,
    async complete(request) {
      requests.push(structuredClone(request));
      if (request.role === failRole) throw failure();
      const original = deterministicData(request);
      const data = transform?.({ request, data: structuredClone(original) }) ?? original;
      return {
        data,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        responseId: `release-${String(requests.length).padStart(4, "0")}`,
        model: MODEL,
        latencyMs: 0,
        transportAttempts: 1,
        attempts: [{ attempt: 1, outcome: "deterministic-capture" }],
        estimatedCostUsd,
      };
    },
  };
}

function scenario(id = "fraud-overrides-refunds") {
  return toPublicScenario(loadBenchmark().cases.find((item) => item.id === id));
}

function options(provider) {
  return {
    provider,
    benchmarkId: loadBenchmark().benchmarkId,
    model: MODEL,
    repetition: 1,
    now: () => "2026-08-29T00:00:00.000Z",
  };
}

test("semantic compiler and change validation accepts alternate stable IDs and order", async () => {
  const provider = roleProvider({
    transform({ request, data }) {
      if (request.role === "rule-compiler") {
        for (const [kind, prefix] of [["oldRules", "old-alt"], ["newRules", "new-alt"]]) {
          data[kind] = data[kind].reverse().map((rule, index) => ({
            ...rule,
            id: `${prefix}-${index + 1}`,
            conditions: [...rule.conditions].reverse(),
            exceptions: [...rule.exceptions].reverse(),
          }));
        }
      }
      if (request.role === "change-analyst") {
        data.deltas = data.deltas.reverse().map((delta, index) => ({
          ...delta,
          id: `delta-alt-${index + 1}`,
          scopeTerms: [...delta.scopeTerms].reverse(),
          boundaryCases: [...delta.boundaryCases].reverse(),
          citations: [...delta.citations].reverse(),
        }));
        data.boundaryCases = [...data.boundaryCases].reverse();
      }
      return data;
    },
  });
  const run = await analyzeScenarioWithProvider(scenario(), options(provider));
  assert.equal(run.rankedCandidates.length, scenario().records.length);
  assert.equal(provider.requests.length, 4);
});

test("change validation rejects forged ungrounded scope and boundary terms through exactly two repairs", async () => {
  const provider = roleProvider({ transform({ request, data }) {
    if (request.role === "change-analyst") {
      data.deltas[0].scopeTerms.push("extraterrestrial-unguarded-token");
      data.deltas[0].boundaryCases.push("Cases mentioning extraterrestrial-unguarded-token");
    }
    return data;
  } });
  await assert.rejects(analyzeScenarioWithProvider(scenario(), options(provider)), /schema repair|invalid output/i);
  assert.equal(provider.requests.filter((item) => item.role === "change-analyst").length, 3);
});

test("strict changes stay strict while pure recovery preserves previous deterministic analysis", async () => {
  const value = scenario("perishable-delivery-quality");
  const compiled = compilePolicyRules({ ...value, trace: trace(value.id) });
  assert.throws(() => analyzeRuleChanges({ ...compiled, trace: trace(value.id) }), (error) => error instanceof EvidenceError);
  const recovered = recoverRuleChanges(compiled);
  assert.deepEqual({ ...compiled, ...recovered }, analyzeScenario(value).analysis);
  const provider = roleProvider();
  const run = await analyzeScenarioWithProvider(value, options(provider));
  assert.equal(run.analysis.recovered, true);
  assert.ok(run.trace.some((event) => event.payload?.code === "EVIDENCE_BOUND_RECOVERY"));
});

test("one-field recovered-output deviation exhausts repair without controller substitution", async () => {
  const provider = roleProvider({ transform({ request, data }) {
    if (request.role === "change-analyst") data.deltas[0].targetLabel = "forged-target";
    return data;
  } });
  await assert.rejects(analyzeScenarioWithProvider(scenario("perishable-delivery-quality"), options(provider)), /schema repair|invalid output/i);
  assert.equal(provider.requests.filter((item) => item.role === "change-analyst").length, 3);
});

test("provider outage never invokes recovery or schema repair", async () => {
  const provider = roleProvider({
    failRole: "change-analyst",
    failure: () => new ProviderError("private outage detail", "INJECTED_PROVIDER_OUTAGE"),
  });
  let error;
  try { await analyzeScenarioWithProvider(scenario("perishable-delivery-quality"), options(provider)); } catch (caught) { error = caught; }
  assert.ok(error instanceof ProviderError);
  assert.equal(provider.requests.filter((item) => item.role === "change-analyst").length, 1);
  assert.equal(error.trace.some((event) => event.payload?.code === "EVIDENCE_BOUND_RECOVERY"), false);
});

const investigatorAttacks = [
  ["evidence-derived score breakdown", (data) => {
    data.candidates[0].scoreBreakdown.exactChangedScopePhraseMatches += 1;
    data.candidates[0].score += 4;
  }],
  ["declared ranking order", (data) => {
    const last = data.candidates.length - 1;
    [data.candidates[0], data.candidates[last]] = [data.candidates[last], data.candidates[0]];
  }],
  ["score-blinded evidence detail", (data) => {
    const detail = JSON.parse(data.candidates[0].evidence[0].detail);
    detail.score = 999;
    data.candidates[0].evidence[0].detail = canonicalJson(detail);
  }],
];

for (const [name, mutate] of investigatorAttacks) {
  test(`investigator rejects malicious ${name}`, async () => {
    const provider = roleProvider({ transform({ request, data }) {
      if (request.role === "impact-investigator") mutate(data);
      return data;
    } });
    await assert.rejects(analyzeScenarioWithProvider(scenario(), options(provider)), /schema repair|invalid output/i);
    assert.equal(provider.requests.filter((item) => item.role === "impact-investigator").length, 3);
  });
}

test("verifier cannot support a candidate without exact changed-rule citation", async () => {
  const provider = roleProvider({ transform({ request, data }) {
    if (request.role === "independent-verifier") {
      const supported = data.verifications.find((item) => item.verdict === "support");
      assert.ok(supported);
      supported.citations = [];
    }
    return data;
  } });
  await assert.rejects(analyzeScenarioWithProvider(scenario(), options(provider)), /schema repair|invalid output/i);
  assert.equal(provider.requests.filter((item) => item.role === "independent-verifier").length, 3);
});

test("missing failure telemetry stays unknown and records static redaction", async () => {
  const provider = roleProvider({
    failRole: "rule-compiler",
    failure: () => new ProviderError("Authorization Bearer sk-private-provider-secret-2026", "INJECTED_FAILURE"),
  });
  let error;
  try { await analyzeScenarioWithProvider(scenario(), options(provider)); } catch (caught) { error = caught; }
  const event = error.trace.find((item) => item.type === "provider-result" && item.status === "failed");
  assert.equal(event.provider.actualModel, null);
  assert.equal(event.provider.responseId, null);
  assert.equal(event.retry.transportAttempts, 0);
  assert.deepEqual(event.payload.attempts, []);
  assert.deepEqual(event.redaction, { applied: true, fields: ["error.message", "error.stack", "error.cause"] });
  assert.doesNotMatch(JSON.stringify(error.trace), /sk-private-provider-secret|Authorization Bearer/i);
});

test("numeric provider costs including zero are preserved and unknown stays null", async () => {
  const loaded = loadBenchmark();
  const benchmark = {
    benchmarkId: loaded.benchmarkId,
    reviewBudgetFraction: loaded.reviewBudgetFraction,
    cases: [toPublicScenario(loaded.cases[0])],
  };
  const zero = await createProviderAdvancedPredictions(benchmark, options(roleProvider({ estimatedCostUsd: 0 })));
  assert.equal(zero.cases[0].estimatedCostUsd, 0);
  assert.equal(zero.metadata.resources.estimatedCostUsd, 0);
  assert.ok(zero.cases[0].trajectory.filter((event) => event.type === "provider-result").every((event) => event.payload.estimatedCostUsd === 0));
  const unknown = await createProviderAdvancedPredictions(benchmark, options(roleProvider({ estimatedCostUsd: null })));
  assert.equal(unknown.cases[0].estimatedCostUsd, null);
  assert.equal(unknown.metadata.resources.estimatedCostUsd, null);
});
