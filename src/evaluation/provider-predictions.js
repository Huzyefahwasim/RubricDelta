import { types as utilTypes } from "node:util";

import {
  analyzeBaselineWithProvider,
  analyzeScenarioWithProvider,
} from "../agents/provider-workflow.js";
import { validateProviderOptions } from "../agents/provider-validation.js";
import { toPublicScenario } from "../domain/scenario.js";
import {
  assertNoCredentialValues,
  assertNoEvaluatorOnlyFields,
  cloneJson,
  ProviderError,
} from "../providers/contracts.js";

const ZERO_USAGE = Object.freeze({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });

function nonblank(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function ownData(descriptors, key, fallback) {
  const descriptor = descriptors[key];
  if (!descriptor) return fallback;
  if (descriptor.get || descriptor.set || !("value" in descriptor)) throw new Error("unsafe option descriptor");
  return descriptor.value;
}

function safeBenchmark(value) {
  try {
    assertNoEvaluatorOnlyFields(value);
    const benchmark = cloneJson(value);
    if (!nonblank(benchmark?.benchmarkId) || benchmark.benchmarkId.length > 256
      || !Number.isFinite(benchmark?.reviewBudgetFraction)
      || benchmark.reviewBudgetFraction <= 0
      || benchmark.reviewBudgetFraction > 1
      || !Array.isArray(benchmark?.cases)
      || benchmark.cases.length === 0) throw new Error("invalid benchmark");
    const projected = {
      benchmarkId: benchmark.benchmarkId,
      reviewBudgetFraction: benchmark.reviewBudgetFraction,
      cases: benchmark.cases.map((item) => toPublicScenario(item)),
    };
    const caseIds = projected.cases.map((item) => item.id);
    if (caseIds.some((id) => !nonblank(id)) || new Set(caseIds).size !== caseIds.length) throw new Error("invalid case IDs");
    assertNoCredentialValues(projected);
    return projected;
  } catch {
    throw new ProviderError("Provider benchmark failed safe public-only validation", "INVALID_PROVIDER_BENCHMARK");
  }
}

function predictionOptions(options, benchmarkId) {
  try {
    if (!options || typeof options !== "object" || Array.isArray(options) || utilTypes.isProxy(options)) throw new Error("unsafe options");
    const descriptors = Object.getOwnPropertyDescriptors(options);
    const provider = ownData(descriptors, "provider");
    const model = ownData(descriptors, "model");
    const repetition = ownData(descriptors, "repetition", 1);
    const now = ownData(descriptors, "now", undefined);
    if (now !== undefined && typeof now !== "function") throw new Error("invalid clock");
    return { ...validateProviderOptions({ provider, model, benchmarkId, repetition }), now };
  } catch (error) {
    if (error instanceof ProviderError && error.code === "INVALID_PROVIDER_CONFIGURATION") throw error;
    throw new ProviderError("Provider prediction configuration is invalid", "INVALID_PROVIDER_CONFIGURATION");
  }
}

function fairnessManifest(benchmark, provider, model, repetition) {
  return {
    benchmarkId: benchmark.benchmarkId,
    caseIds: benchmark.cases.map((item) => item.id),
    orderedRecordIdsByCase: Object.fromEntries(benchmark.cases.map((item) => [item.id, item.records.map((record) => record.id)])),
    reviewBudgetFraction: benchmark.reviewBudgetFraction,
    provider: provider.name,
    model,
    repetition,
  };
}

function errorData(error, key, fallback) {
  try {
    if (!error || typeof error !== "object" || utilTypes.isProxy(error)) return fallback;
    const descriptor = Object.getOwnPropertyDescriptor(error, key);
    return descriptor && !descriptor.get && !descriptor.set && "value" in descriptor ? descriptor.value : fallback;
  } catch { return fallback; }
}

function safeCode(value) {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(value) ? value : "PROVIDER_CASE_FAILED";
}

function failedCase(caseId, error) {
  let trajectory = [];
  try {
    const trace = errorData(error, "trace", []);
    if (Array.isArray(trace)) trajectory = cloneJson(trace);
  } catch { trajectory = []; }
  const resources = resourcesFromTrajectory(trajectory);
  return {
    caseId,
    status: "failed",
    rankedRecordIds: [],
    rankingEvidence: [],
    trajectory,
    failure: { code: safeCode(errorData(error, "code", null)) },
    substituted: false,
    runtimeMs: null,
    estimatedCostUsd: resources.estimatedCostUsd,
    resources: {
      providerCalls: resources.providerCalls,
      providerAttempts: resources.providerAttempts,
      usage: resources.usage,
      providerLatencyMs: resources.providerLatencyMs,
      runtimeMs: null,
      estimatedCostUsd: resources.estimatedCostUsd,
    },
  };
}

function completeCase(caseId, rankingEvidence, trace, estimatedCostUsd = null) {
  const resources = resourcesFromTrajectory(trace);
  return {
    caseId,
    status: "complete",
    rankedRecordIds: rankingEvidence.map((item) => item.recordId),
    rankingEvidence,
    trajectory: trace,
    substituted: false,
    runtimeMs: null,
    estimatedCostUsd,
    resources: {
      providerCalls: resources.providerCalls,
      providerAttempts: resources.providerAttempts,
      usage: resources.usage,
      providerLatencyMs: resources.providerLatencyMs,
      runtimeMs: null,
      estimatedCostUsd: resources.estimatedCostUsd,
    },
  };
}

function resourcesFromTrajectory(trajectory) {
  const resources = {
    providerCalls: 0,
    providerAttempts: 0,
    usage: { ...ZERO_USAGE },
    providerLatencyMs: 0,
    estimatedCostUsd: 0,
  };
  let usageKnown = true;
  let latencyKnown = true;
  let costKnown = true;
  const results = trajectory.filter((event) => event.type === "provider-result");
  resources.providerCalls += results.length;
  for (const event of results) {
      resources.providerAttempts += event.retry.transportAttempts;
      if (event.usage) {
        resources.usage.inputTokens += event.usage.inputTokens;
        resources.usage.outputTokens += event.usage.outputTokens;
        resources.usage.totalTokens += event.usage.totalTokens;
      } else usageKnown = false;
      if (Number.isFinite(event.latencyMs)) resources.providerLatencyMs += event.latencyMs;
      else latencyKnown = false;
      const cost = event.payload?.estimatedCostUsd;
      if (Number.isFinite(cost) && cost >= 0) resources.estimatedCostUsd += cost;
      else costKnown = false;
  }
  if (!usageKnown) resources.usage = null;
  if (!latencyKnown) resources.providerLatencyMs = null;
  if (!costKnown) resources.estimatedCostUsd = null;
  return resources;
}

function aggregateResources(cases) {
  const perCase = cases.map((item) => item.resources);
  const sum = (key) => perCase.some((item) => item[key] === null)
    ? null
    : perCase.reduce((total, item) => total + item[key], 0);
  const usage = perCase.some((item) => item.usage === null)
    ? null
    : perCase.reduce((total, item) => ({
      inputTokens: total.inputTokens + item.usage.inputTokens,
      outputTokens: total.outputTokens + item.usage.outputTokens,
      totalTokens: total.totalTokens + item.usage.totalTokens,
    }), { ...ZERO_USAGE });
  return {
    providerCalls: sum("providerCalls"),
    providerAttempts: sum("providerAttempts"),
    usage,
    providerLatencyMs: sum("providerLatencyMs"),
    estimatedCostUsd: sum("estimatedCostUsd"),
  };
}

function predictionMetadata({ system, claimSupportContract, resourceNotes, benchmark, provider, model, repetition, cases }) {
  const resources = aggregateResources(cases);
  return {
    system,
    claimSupportContract,
    provider: provider.name,
    model,
    repetition,
    runtimeMs: null,
    estimatedCostUsd: resources.estimatedCostUsd,
    resourceNotes,
    fairnessManifest: fairnessManifest(benchmark, provider, model, repetition),
    resources,
  };
}

export async function createProviderBaselinePredictions(benchmarkValue, options = {}) {
  const benchmark = safeBenchmark(benchmarkValue);
  const settings = predictionOptions(options, benchmark.benchmarkId);
  const cases = [];
  for (const testCase of benchmark.cases) {
    const scenario = testCase;
    try {
      const run = await analyzeBaselineWithProvider(scenario, {
        provider: settings.provider,
        model: settings.model,
        benchmarkId: benchmark.benchmarkId,
        repetition: settings.repetition,
        runId: `provider-baseline-${scenario.id}-r${settings.repetition}`,
        ...(typeof settings.now === "function" ? { now: settings.now } : {}),
      });
      cases.push(completeCase(scenario.id, run.ranking, run.trace, run.resources.estimatedCostUsd));
    } catch (error) { cases.push(failedCase(scenario.id, error)); }
  }
  return {
    metadata: predictionMetadata({
      system: "rubricdelta-direct-provider-baseline",
      claimSupportContract: "matched-terms-v1",
      resourceNotes: "One direct provider call per public case; failures remain explicit and receive no deterministic substitution.",
      benchmark,
      provider: settings.provider,
      model: settings.model,
      repetition: settings.repetition,
      cases,
    }),
    cases,
  };
}

export async function createProviderAdvancedPredictions(benchmarkValue, options = {}) {
  const benchmark = safeBenchmark(benchmarkValue);
  const settings = predictionOptions(options, benchmark.benchmarkId);
  const cases = [];
  for (const testCase of benchmark.cases) {
    const scenario = testCase;
    try {
      const run = await analyzeScenarioWithProvider(scenario, {
        provider: settings.provider,
        model: settings.model,
        benchmarkId: benchmark.benchmarkId,
        repetition: settings.repetition,
        runId: `provider-advanced-${scenario.id}-r${settings.repetition}`,
        ...(typeof settings.now === "function" ? { now: settings.now } : {}),
      });
      cases.push(completeCase(scenario.id, run.rankedCandidates, run.trace, run.resources.estimatedCostUsd));
    } catch (error) { cases.push(failedCase(scenario.id, error)); }
  }
  return {
    metadata: predictionMetadata({
      system: "rubricdelta-four-stage-provider-advanced",
      claimSupportContract: "verifier-support-v1",
      resourceNotes: "Compiler, analyst, investigator, and blind batch verifier provider calls; failures remain explicit with no fallback.",
      benchmark,
      provider: settings.provider,
      model: settings.model,
      repetition: settings.repetition,
      cases,
    }),
    cases,
  };
}
