import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { analyzeScenario } from "../src/agents/workflow.js";
import {
  analyzePolicy,
  analyzeRuleChanges,
  compilePolicyRules,
  EvidenceError,
  recoverRuleChanges,
} from "../src/agents/policy-analyst.js";
import { analyzeScenarioWithProvider } from "../src/agents/provider-workflow.js";
import { createTraceRecorder } from "../src/agents/trace.js";
import { rankImpactCandidates } from "../src/agents/impact-investigator.js";
import { verifyCandidate } from "../src/agents/verifier.js";
import { toPublicScenario } from "../src/domain/scenario.js";
import {
  createAdvancedPredictions,
  createBaselinePredictions,
  evaluatePredictions,
  loadBenchmark,
  rankBaselineCase,
} from "../src/evaluation/index.js";
import {
  createProviderAdvancedPredictions,
  createProviderBaselinePredictions,
} from "../src/evaluation/provider-predictions.js";
import { canonicalJson, ProviderError } from "../src/providers/contracts.js";
import {
  createEvaluationArtifacts,
  createProviderEvaluationArtifacts,
  createPublicBenchmarkProjection,
} from "../scripts/evaluation-artifacts.js";

const MODEL = "deterministic-role-capture-v1";
const GOLD = /ground[-_ ]?truth|affected[-_ ]?record[-_ ]?ids?|expected[-_ ]?labels?|rationales?|review[-_ ]?(?:outcomes?|decisions?)|worker[-_ ]?quality(?:[-_ ]?(?:fields?|scores?))?/i;

function temporary(t, prefix) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function legacyTrace(scenarioId) {
  return createTraceRecorder({
    runId: `task8-${scenarioId}`,
    scenarioId,
    now: () => "2026-08-29T00:00:00.000Z",
  });
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

function providerPublicInputs(predictions) {
  return predictions.cases.flatMap((item) => item.trajectory)
    .filter((event) => event.type === "provider-call")
    .map((event) => event.payload?.request?.input)
    .filter((value) => value !== undefined);
}

function providerResult(data, index) {
  return {
    data,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    responseId: `deterministic-capture-${String(index).padStart(4, "0")}`,
    model: MODEL,
    latencyMs: 0,
    transportAttempts: 1,
    attempts: [{ attempt: 1, outcome: "deterministic-capture" }],
    estimatedCostUsd: 0,
  };
}

function roleData(request) {
  const trace = legacyTrace(request.caseId);
  if (request.role === "rule-compiler") {
    return compilePolicyRules({ ...request.input, trace });
  }
  if (request.role === "change-analyst") {
    try {
      return analyzeRuleChanges({ ...request.input, trace });
    } catch (error) {
      if (!(error instanceof EvidenceError)) throw error;
      const { deltas, boundaryCases } = recoverRuleChanges(request.input);
      return { deltas, boundaryCases };
    }
  }
  if (request.role === "impact-investigator") {
    return {
      candidates: rankImpactCandidates({ ...request.input, trace }).map((candidate) => {
        const { status: _status, evidence, ...rest } = candidate;
        return { ...rest, evidence: evidence.map(normalizeEvidence) };
      }),
    };
  }
  if (request.role === "independent-verifier") {
    return {
      verifications: request.input.candidates.map((candidate) => {
        const evidence = candidate.evidence.map((item) => JSON.parse(item.detail));
        const verdict = verifyCandidate({
          candidate: { ...candidate, evidence },
          scenario: request.input.scenario,
          analysis: request.input.analysis,
          trace,
        });
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
  }
  if (request.role === "direct-baseline") {
    return { ranking: rankBaselineCase(request.input.scenario) };
  }
  throw new Error("Unexpected provider role");
}

function roleProvider({ transform, failRole, failureFactory } = {}) {
  const requests = [];
  return {
    name: "capture",
    model: MODEL,
    requests,
    async complete(request) {
      requests.push(structuredClone(request));
      if (request.role === failRole) throw failureFactory();
      const data = roleData(request);
      const transformed = transform?.({
        request,
        data: structuredClone(data),
        call: requests.length,
      }) ?? data;
      return providerResult(transformed, requests.length);
    },
  };
}

function oneCasePublicBenchmark() {
  const full = loadBenchmark();
  return {
    ...createPublicBenchmarkProjection(full),
    cases: [createPublicBenchmarkProjection(full).cases[0]],
  };
}

function safeFailure(code = "INJECTED_PROVIDER_FAILURE") {
  return new ProviderError("Authorization Bearer sk-provider-secret-must-not-escape", code, {
    telemetry: {
      responseId: "resp-safe",
      model: MODEL,
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
      transportAttempts: 2,
      attempts: [
        { attempt: 1, outcome: "http-503" },
        { attempt: 2, outcome: "failed" },
      ],
      latencyMs: 19,
    },
  });
}

test("Task 8 leaves every deterministic compatibility API synchronous and output-identical", (t) => {
  const benchmark = loadBenchmark();
  const scenario = toPublicScenario(benchmark.cases[0]);
  const workflow = analyzeScenario(scenario);
  const baseline = createBaselinePredictions(benchmark);
  const advanced = createAdvancedPredictions(benchmark);
  for (const value of [workflow, baseline, advanced]) assert.equal(value instanceof Promise, false);

  const outputDir = temporary(t, "rubricdelta-sync-task8-");
  const artifacts = createEvaluationArtifacts({
    benchmark,
    mode: "both",
    outputDir,
    provider: "deterministic",
    model: null,
    repeats: 1,
    createBaseline: createBaselinePredictions,
    createAdvanced: createAdvancedPredictions,
    score: evaluatePredictions,
  });
  assert.equal(artifacts instanceof Promise, false);
  assert.equal(artifacts.comparison.baseline.primaryMetric.value, 0.8);
  assert.equal(artifacts.comparison.advanced.primaryMetric.value, 0.9);
  assert.equal(evaluatePredictions(benchmark, baseline).primaryMetric.value, 0.8);
  assert.equal(evaluatePredictions(benchmark, advanced).primaryMetric.value, 0.9);
  assert.deepEqual(
    workflow.trace.map(({ agent, phase, type }) => ({ agent, phase, type })),
    analyzeScenario(scenario).trace.map(({ agent, phase, type }) => ({ agent, phase, type })),
  );
});

test("provider stages reject missing, duplicate, unknown, or forged semantic bindings", async (t) => {
  const benchmark = loadBenchmark();
  const scenario = toPublicScenario(benchmark.cases[0]);
  const cases = [
    {
      name: "compiler missing rule",
      role: "rule-compiler",
      mutate(data) { data.oldRules = []; },
    },
    {
      name: "compiler duplicate rule ID",
      role: "rule-compiler",
      mutate(data) { data.oldRules.push(structuredClone(data.oldRules[0])); },
    },
    {
      name: "compiler forged citation",
      role: "rule-compiler",
      mutate(data) { data.oldRules[0].citation.quote = "forged quote"; },
    },
    {
      name: "change analyst missing delta",
      role: "change-analyst",
      mutate(data) { data.deltas = []; },
    },
    {
      name: "change analyst duplicate delta ID",
      role: "change-analyst",
      mutate(data) { data.deltas.push(structuredClone(data.deltas[0])); },
    },
    {
      name: "change analyst unknown rule ID",
      role: "change-analyst",
      mutate(data) { data.deltas[0].oldRuleIds = ["unknown-rule"]; },
    },
    {
      name: "change analyst forged citation",
      role: "change-analyst",
      mutate(data) { data.deltas[0].citations[0].quote = "forged quote"; },
    },
    {
      name: "investigator missing candidate",
      role: "impact-investigator",
      mutate(data) { data.candidates = data.candidates.slice(1); },
    },
    {
      name: "investigator duplicate record ID",
      role: "impact-investigator",
      mutate(data) { data.candidates[1].recordId = data.candidates[0].recordId; },
    },
    {
      name: "investigator unknown delta ID",
      role: "impact-investigator",
      mutate(data) { data.candidates[0].ruleDeltaIds = ["unknown-delta"]; },
    },
    {
      name: "investigator forged record evidence",
      role: "impact-investigator",
      mutate(data) {
        const evidence = data.candidates.flatMap((item) => item.evidence)
          .find((item) => item.recordId !== null);
        assert.ok(evidence);
        evidence.quote = "not present in the record";
      },
    },
    {
      name: "provider cannot assign review status",
      role: "impact-investigator",
      mutate(data) { data.candidates[0].status = "approved"; },
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const provider = roleProvider({
        transform({ request, data }) {
          if (request.role === item.role) item.mutate(data);
          return data;
        },
      });
      await assert.rejects(
        analyzeScenarioWithProvider(scenario, {
          provider,
          benchmarkId: benchmark.benchmarkId,
          model: MODEL,
          repetition: 1,
        }),
        /schema repair|invalid|citation|binding|rule|delta|candidate|record/i,
      );
      assert.equal(provider.requests.filter((request) => request.role === item.role).length, 3);
    });
  }
});

test("batch verifier binds every verdict to exact delta IDs and changed-rule citations", async (t) => {
  const benchmark = loadBenchmark();
  const scenario = toPublicScenario(benchmark.cases[0]);
  const cases = [
    ["missing delta IDs", (item) => { delete item.ruleDeltaIds; }],
    ["unknown delta ID", (item) => { item.ruleDeltaIds = ["unknown-delta"]; }],
    ["duplicate delta ID", (item) => { item.ruleDeltaIds = [item.ruleDeltaIds[0], item.ruleDeltaIds[0]]; }],
    ["missing citation", (item) => { item.citations = []; }],
    ["unknown citation delta", (item) => { item.citations[0].deltaId = "unknown-delta"; }],
    ["forged citation quote", (item) => { item.citations[0].citation.quote = "forged changed-rule quote"; }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const provider = roleProvider({
        transform({ request, data }) {
          if (request.role === "independent-verifier") mutate(data.verifications[0]);
          return data;
        },
      });
      await assert.rejects(analyzeScenarioWithProvider(scenario, {
        provider,
        benchmarkId: benchmark.benchmarkId,
        model: MODEL,
        repetition: 1,
      }), /schema repair|verifier|verification|delta|citation|binding/i);
      assert.equal(provider.requests.filter((request) => request.role === "independent-verifier").length, 3);
    });
  }

  const provider = roleProvider();
  const run = await analyzeScenarioWithProvider(scenario, {
    provider,
    benchmarkId: benchmark.benchmarkId,
    model: MODEL,
    repetition: 1,
  });
  const verifierRequest = provider.requests.find((request) => request.role === "independent-verifier");
  assert.ok(verifierRequest.input.candidates.every((candidate) => candidate.ruleDeltaIds.every((id) => run.analysis.deltas.some((delta) => delta.id === id))));
  assert.ok(verifierRequest.input.candidates.some((candidate) => candidate.evidence.some((item) => item.citation !== null)));
  assert.ok(run.rankedCandidates.every((candidate) => candidate.verifier.ruleDeltaIds.every((id) => candidate.ruleDeltaIds.includes(id))));
});

test("trace v1 preserves exact success, repair, direct-baseline, and failure attempt telemetry", async () => {
  const benchmark = loadBenchmark();
  const scenario = toPublicScenario(benchmark.cases[0]);
  let compilerCalls = 0;
  const provider = roleProvider({
    transform({ request, data }) {
      if (request.role === "rule-compiler") {
        compilerCalls += 1;
        if (compilerCalls < 3) return { oldRules: [] };
      }
      return data;
    },
  });
  const run = await analyzeScenarioWithProvider(scenario, {
    provider,
    benchmarkId: benchmark.benchmarkId,
    model: MODEL,
    repetition: 1,
    now: () => "2026-08-29T00:00:00.000Z",
  });
  const results = run.trace.filter((event) => event.type === "provider-result");
  const completed = results.filter((event) => event.status === "completed");
  assert.equal(completed.length, 4);
  for (const event of completed) {
    assert.ok(event.inputRefs.length > 0);
    assert.deepEqual(event.provider, {
      name: "capture",
      requestedModel: MODEL,
      actualModel: MODEL,
      responseId: event.payload.responseId,
    });
    assert.deepEqual(event.usage, { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    assert.equal(event.latencyMs, 0);
    assert.equal(event.retry.transportAttempts, 1);
    assert.deepEqual(event.payload.attempts, [{ attempt: 1, outcome: "deterministic-capture" }]);
  }
  const retries = run.trace.filter((event) => event.type === "retry");
  assert.deepEqual(retries.map((event) => event.retry.schemaRepairAttempt), [1, 2]);
  assert.deepEqual(retries.map((event) => event.payload), [
    { estimatedCostUsd: 0, nextAttempt: 2, pathClass: "schema-shape", reason: "json-schema-validation-failed" },
    { estimatedCostUsd: 0, nextAttempt: 3, pathClass: "schema-shape", reason: "json-schema-validation-failed" },
  ]);
  assert.ok(run.trace.find((event) => event.providerRole === "rule-compiler" && event.type === "provider-call").inputRefs.includes(scenario.oldGuideline.version));
  assert.ok(run.trace.find((event) => event.providerRole === "independent-verifier" && event.type === "provider-call").inputRefs.includes(scenario.records[0].id));

  const baselineProvider = roleProvider();
  const baseline = await createProviderBaselinePredictions(oneCasePublicBenchmark(), {
    provider: baselineProvider,
    model: MODEL,
    repetition: 1,
    now: () => "2026-08-29T00:00:00.000Z",
  });
  const baselineResult = baseline.cases[0].trajectory.find((event) => event.type === "provider-result");
  assert.equal(baselineResult.providerRole, "direct-baseline");
  assert.equal(baselineResult.provider.actualModel, MODEL);
  assert.equal(baselineResult.provider.responseId, "deterministic-capture-0001");
  assert.deepEqual(baselineResult.payload.attempts, [{ attempt: 1, outcome: "deterministic-capture" }]);
  assert.ok(baselineResult.inputRefs.includes(scenario.records[0].id));
});

test("only malformed successful outputs consume schema-repair calls", async (t) => {
  const benchmark = loadBenchmark();
  const scenario = toPublicScenario(benchmark.cases[0]);
  const failures = [
    ["refusal", "OPENAI_REFUSAL"],
    ["incomplete", "OPENAI_INCOMPLETE"],
    ["caller abort", "CALLER_ABORTED"],
    ["timeout exhaustion", "OPENAI_TRANSIENT_EXHAUSTED"],
    ["transport failure", "OPENAI_FETCH_FAILED"],
    ["model mismatch", "OPENAI_MODEL_MISMATCH"],
    ["credential output", "OPENAI_CREDENTIAL_IN_OUTPUT"],
    ["replay mismatch", "REPLAY_REQUEST_MISMATCH"],
    ["replay exhaustion", "REPLAY_EXHAUSTED"],
    ["generic provider error", "INJECTED_PROVIDER_FAILURE"],
  ];
  for (const [name, code] of failures) {
    await t.test(name, async () => {
      const provider = roleProvider({
        failRole: "rule-compiler",
        failureFactory: () => safeFailure(code),
      });
      let error;
      try {
        await analyzeScenarioWithProvider(scenario, {
          provider,
          benchmarkId: benchmark.benchmarkId,
          model: MODEL,
          repetition: 1,
        });
      } catch (caught) {
        error = caught;
      }
      assert.ok(error instanceof ProviderError);
      assert.equal(provider.requests.length, 1);
      assert.ok(Array.isArray(error.trace));
      assert.equal(error.trace.filter((event) => event.type === "retry").length, 0);
      assert.equal(error.trace.at(-1).terminalState, "failed");
      assert.equal(error.trace.at(-1).type, "terminal");
    });
  }
});

test("success and every provider-stage failure retain complete safe trace-v1 telemetry", async (t) => {
  const publicBenchmark = oneCasePublicBenchmark();
  const roles = [
    ["direct-baseline", createProviderBaselinePredictions],
    ["rule-compiler", createProviderAdvancedPredictions],
    ["change-analyst", createProviderAdvancedPredictions],
    ["impact-investigator", createProviderAdvancedPredictions],
    ["independent-verifier", createProviderAdvancedPredictions],
  ];

  for (const [role, createPredictions] of roles) {
    await t.test(role, async () => {
      const provider = roleProvider({
        failRole: role,
        failureFactory: () => safeFailure(),
      });
      const predictions = await createPredictions(publicBenchmark, {
        provider,
        model: MODEL,
        repetition: 1,
        now: () => "2026-08-29T00:00:00.000Z",
      });
      const failed = predictions.cases[0];
      assert.equal(failed.status, "failed");
      assert.deepEqual(failed.rankedRecordIds, []);
      assert.deepEqual(failed.rankingEvidence, []);
      assert.equal(failed.substituted, false);
      assert.equal(failed.failure.code, "INJECTED_PROVIDER_FAILURE");
      assert.doesNotMatch(JSON.stringify(failed), /sk-provider-secret|Authorization Bearer/i);
      const event = failed.trajectory.find((item) => item.type === "provider-result" && item.status === "failed");
      assert.ok(event);
      assert.equal(event.provider.actualModel, MODEL);
      assert.equal(event.provider.responseId, "resp-safe");
      assert.deepEqual(event.usage, { inputTokens: 7, outputTokens: 3, totalTokens: 10 });
      assert.equal(event.latencyMs, 19);
      assert.equal(event.retry.transportAttempts, 2);
      assert.deepEqual(event.payload.attempts, [
        { attempt: 1, outcome: "http-503" },
        { attempt: 2, outcome: "failed" },
      ]);
      assert.equal(event.terminalState, "failed");
      assert.equal(failed.trajectory.at(-1).type, "terminal");
      assert.equal(failed.trajectory.at(-1).terminalState, "failed");
    });
  }
});

test("provider public-input guards reject traps and broad private aliases before any call", async (t) => {
  const benchmark = loadBenchmark();
  const scenario = structuredClone(toPublicScenario(benchmark.cases[0]));

  await t.test("top-level Proxy", async () => {
    let traps = 0;
    const trapped = new Proxy({}, {
      get() { traps += 1; throw new Error("PRIVATE_PROXY_MARKER"); },
      getPrototypeOf() { traps += 1; throw new Error("PRIVATE_PROXY_MARKER"); },
      ownKeys() { traps += 1; throw new Error("PRIVATE_PROXY_MARKER"); },
    });
    const provider = roleProvider();
    await assert.rejects(
      analyzeScenarioWithProvider(trapped, {
        provider,
        benchmarkId: benchmark.benchmarkId,
        model: MODEL,
        repetition: 1,
      }),
      (error) => {
        assert.ok(error instanceof ProviderError);
        assert.doesNotMatch(`${error.message}\n${error.stack}`, /PRIVATE_PROXY_MARKER/);
        return true;
      },
    );
    assert.equal(traps, 0);
    assert.equal(provider.requests.length, 0);
  });

  await t.test("nested accessor", async () => {
    let reads = 0;
    const value = structuredClone(scenario);
    Object.defineProperty(value.records[0], "reviewOutcome", {
      enumerable: true,
      get() { reads += 1; throw new Error("PRIVATE_ACCESSOR_MARKER"); },
    });
    const provider = roleProvider();
    await assert.rejects(
      analyzeScenarioWithProvider(value, {
        provider,
        benchmarkId: benchmark.benchmarkId,
        model: MODEL,
        repetition: 1,
      }),
      (error) => {
        assert.ok(error instanceof ProviderError);
        assert.doesNotMatch(`${error.message}\n${error.stack}`, /PRIVATE_ACCESSOR_MARKER/);
        return true;
      },
    );
    assert.equal(reads, 0);
    assert.equal(provider.requests.length, 0);
  });

  for (const alias of [
    "ground_truth",
    "affected-record-id",
    "expectedLabel",
    "rationale",
    "review_outcome",
    "reviewDecision",
    "worker-quality",
    "workerQualityScore",
  ]) {
    await t.test(alias, async () => {
      const value = structuredClone(scenario);
      value.records[0][alias] = "private";
      const provider = roleProvider();
      await assert.rejects(analyzeScenarioWithProvider(value, {
        provider,
        benchmarkId: benchmark.benchmarkId,
        model: MODEL,
        repetition: 1,
      }), /private|evaluator|provider input|validation/i);
      assert.equal(provider.requests.length, 0);
    });
  }

  const provider = roleProvider();
  await analyzeScenarioWithProvider(scenario, {
    provider,
    benchmarkId: benchmark.benchmarkId,
    model: MODEL,
    repetition: 1,
  });
  assert.doesNotMatch(JSON.stringify(provider.requests.map((request) => request.input)), GOLD);
  assert.ok(provider.requests.every((request) => /ground truth/i.test(request.prompt.instruction)));
  assert.ok(provider.requests.every((request) => /review(?:er)? outcomes?|review decisions?/i.test(request.prompt.instruction)));
});

test("partial provider rankings fail closed instead of receiving deterministic completion", async () => {
  const benchmark = oneCasePublicBenchmark();

  const baselineProvider = roleProvider({
    transform({ request, data }) {
      return request.role === "direct-baseline"
        ? { ranking: data.ranking.slice(1) }
        : data;
    },
  });
  const baseline = await createProviderBaselinePredictions(benchmark, {
    provider: baselineProvider,
    model: MODEL,
    repetition: 1,
  });
  assert.equal(baseline.cases[0].status, "failed");
  assert.deepEqual(baseline.cases[0].rankedRecordIds, []);
  assert.equal(baseline.cases[0].substituted, false);

  const advancedProvider = roleProvider({
    transform({ request, data }) {
      return request.role === "impact-investigator"
        ? { candidates: data.candidates.slice(1) }
        : data;
    },
  });
  const advanced = await createProviderAdvancedPredictions(benchmark, {
    provider: advancedProvider,
    model: MODEL,
    repetition: 1,
  });
  assert.equal(advanced.cases[0].status, "failed");
  assert.deepEqual(advanced.cases[0].rankedRecordIds, []);
  assert.equal(advanced.cases[0].substituted, false);
});

test("provider artifacts persist every raw repeat before gold scoring and report paired mean/min/max", async (t) => {
  const benchmark = loadBenchmark();
  const outputDir = temporary(t, "rubricdelta-provider-artifacts-");
  const provider = roleProvider({
    transform({ request, data }) {
      if (request.role === "direct-baseline" && request.repetition === 2) {
        return { ranking: [...data.ranking].reverse() };
      }
      return data;
    },
  });
  let scoreCalls = 0;
  const result = await createProviderEvaluationArtifacts({
    benchmark,
    mode: "both",
    outputDir,
    provider,
    model: MODEL,
    repeats: 2,
    createBaseline: createProviderBaselinePredictions,
    createAdvanced: createProviderAdvancedPredictions,
    score(gold, predictions) {
      assert.equal(gold, benchmark);
      for (const repetition of [1, 2]) {
        for (const system of ["baseline", "advanced"]) {
          const path = join(outputDir, "repetitions", String(repetition), `${system}-predictions.json`);
          assert.ok(existsSync(path), path);
          const persisted = JSON.parse(readFileSync(path, "utf8"));
          assert.doesNotMatch(JSON.stringify(providerPublicInputs(persisted)), GOLD);
        }
      }
      const fairness = predictions.metadata.fairnessManifest;
      const system = /baseline/.test(predictions.metadata.system) ? "baseline" : "advanced";
      const persisted = JSON.parse(readFileSync(
        join(outputDir, "repetitions", String(fairness.repetition), `${system}-predictions.json`),
        "utf8",
      ));
      assert.deepEqual(persisted, predictions);
      scoreCalls += 1;
      return evaluatePredictions(gold, predictions);
    },
  });

  assert.equal(scoreCalls, 4);
  assert.equal(provider.requests.length, 100);
  assert.equal(result.repetitions.length, 2);
  for (const repetition of result.repetitions) {
    assert.equal(repetition.baseline.metadata.fairnessManifest.benchmarkId, benchmark.benchmarkId);
    assert.deepEqual(
      repetition.baseline.metadata.fairnessManifest,
      repetition.advanced.metadata.fairnessManifest,
    );
    assert.equal(repetition.baseline.metadata.fairnessManifest.provider, "capture");
    assert.equal(repetition.baseline.metadata.fairnessManifest.model, MODEL);
    assert.equal(repetition.baseline.metadata.fairnessManifest.repetition, repetition.repetition);
    assert.equal(repetition.baseline.metadata.fairnessManifest.reviewBudgetFraction, benchmark.reviewBudgetFraction);
    for (const system of ["baseline", "advanced"]) {
      const persisted = JSON.parse(readFileSync(
        join(outputDir, "repetitions", String(repetition.repetition), `${system}-predictions.json`),
        "utf8",
      ));
      assert.deepEqual(persisted, repetition[system]);
      assert.deepEqual(evaluatePredictions(benchmark, persisted), repetition.scores[system]);
    }
  }
  for (const system of ["baseline", "advanced"]) {
    const values = result.repetitions.map((item) => item.scores[system].primaryMetric.value);
    assert.deepEqual(result.summary[system].primaryMetric, {
      mean: Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(6)),
      min: Math.min(...values),
      max: Math.max(...values),
    });
  }
  assert.ok(result.summary.baseline.primaryMetric.min < result.summary.baseline.primaryMetric.max);
  assert.equal(result.manifest.replay.substituted, false);
  assert.equal(result.manifest.repeats.requested, 2);
  assert.equal(result.manifest.repeats.normalizedIdentically, false);
});

test("provider scoring failure preserves raw repeats and an incomplete manifest", async (t) => {
  const benchmark = loadBenchmark();
  const outputDir = temporary(t, "rubricdelta-provider-score-failure-");
  const provider = roleProvider();
  await assert.rejects(createProviderEvaluationArtifacts({
    benchmark,
    mode: "both",
    outputDir,
    provider,
    model: MODEL,
    repeats: 1,
    createBaseline: createProviderBaselinePredictions,
    createAdvanced: createProviderAdvancedPredictions,
    score() {
      throw new Error("injected gold scorer failure");
    },
  }), /scoring|incomplete/i);
  for (const system of ["baseline", "advanced"]) {
    const path = join(outputDir, "repetitions", "1", `${system}-predictions.json`);
    assert.ok(existsSync(path));
    const persisted = JSON.parse(readFileSync(path, "utf8"));
    assert.doesNotMatch(JSON.stringify(providerPublicInputs(persisted)), GOLD);
  }
  const manifest = JSON.parse(readFileSync(join(outputDir, "manifest.json"), "utf8"));
  assert.equal(manifest.execution.status, "incomplete");
  assert.equal(manifest.execution.phase, "scoring");
  assert.equal(manifest.execution.failure.code, "SCORING_FAILED");
});

test("provider artifact boundary requires exact replay exhaustion before scoring", async (t) => {
  const benchmark = loadBenchmark();
  const provider = roleProvider();
  let exhaustionChecks = 0;
  provider.assertExhausted = () => {
    exhaustionChecks += 1;
    throw new ProviderError("Replay has one entry remaining", "REPLAY_NOT_EXHAUSTED");
  };
  let scoreCalls = 0;
  await assert.rejects(createProviderEvaluationArtifacts({
    benchmark,
    mode: "both",
    outputDir: temporary(t, "rubricdelta-provider-exhaustion-"),
    provider,
    model: MODEL,
    repeats: 1,
    createBaseline: createProviderBaselinePredictions,
    createAdvanced: createProviderAdvancedPredictions,
    score() { scoreCalls += 1; throw new Error("scorer must not run"); },
  }), /replay|exhaust/i);
  assert.equal(exhaustionChecks, 1);
  assert.equal(scoreCalls, 0);
  assert.equal(provider.requests.length, 50);
});
