import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { types as utilTypes } from "node:util";

import { EVALUATION_PROTOCOL } from "../src/evaluation/protocol.js";
import {
  assertNoCredentialValues,
  assertNoEvaluatorOnlyFields,
  canonicalJson,
  cloneJson,
} from "../src/providers/contracts.js";
import { canonicalTextSha256 } from "../src/evaluation/evidence-hash.js";
import {
  createGitState,
  createPublicBenchmarkProjection,
  managedArtifactRootsForOutput,
} from "./evaluation-artifacts.js";

const GOLD = /groundTruth|affectedRecordIds|expectedLabels|rationales/i;
const TRACE_TIME = "2000-01-01T00:00:00.000Z";

function round(value) {
  return Number(value.toFixed(6));
}

function json(value) {
  return JSON.stringify(value, null, 2) + "\n";
}

function contained(root, target) {
  const item = relative(root, target);
  return item !== "" && item !== ".." && !item.startsWith(".." + sep) && !isAbsolute(item);
}

function managedPath(root, name) {
  const target = resolve(root, name);
  if (!contained(root, target)) throw new Error("unsafe provider artifact path");
  return target;
}

function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

function removeManagedFile(path) {
  const existing = lstatOrNull(path);
  if (!existing) return;
  if (existing.isDirectory() && !existing.isSymbolicLink()) {
    throw new Error("managed provider artifact is a directory: " + basename(path));
  }
  unlinkSync(path);
}

export function writeDurableFile(path, source, write = writeFileSync) {
  write(path, source, { encoding: "utf8", flag: "wx", flush: true });
}

function safeWrite(path, source) {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true });
  const token = process.pid + "-" + randomUUID();
  const temporary = resolve(parent, "." + basename(path) + "." + token + ".tmp");
  const backup = resolve(parent, "." + basename(path) + "." + token + ".bak");
  if (!contained(parent, temporary) || !contained(parent, backup)) {
    throw new Error("unsafe provider artifact sibling path");
  }
  let backedUp = false;
  try {
    writeDurableFile(temporary, source);
    if (existsSync(path)) {
      const existing = lstatSync(path);
      if (existing.isDirectory() && !existing.isSymbolicLink()) {
        throw new Error("managed provider artifact target is a directory");
      }
      if (existing.isSymbolicLink()) unlinkSync(path);
      else {
        renameSync(path, backup);
        backedUp = true;
      }
    }
    renameSync(temporary, path);
    if (backedUp) unlinkSync(backup);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    if (backedUp && !existsSync(path) && existsSync(backup)) renameSync(backup, path);
    throw error;
  }
}

function safeWriteJson(path, value) {
  safeWrite(path, json(value));
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function rejectLinkedOutputAncestors(target) {
  let current = target;
  while (true) {
    const existing = lstatOrNull(current);
    if (existing?.isSymbolicLink()) {
      throw new Error("Provider output root or ancestor is a link, junction, or reparse point");
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function prepareOutput(outputDir) {
  const target = resolve(outputDir);
  rejectLinkedOutputAncestors(target);
  mkdirSync(target, { recursive: true });
  rejectLinkedOutputAncestors(target);
  const repetitions = managedPath(target, "repetitions");
  const existing = lstatOrNull(repetitions);
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new Error("managed repetitions target must be a directory");
    }
    rmSync(repetitions, { recursive: true, force: true });
  }
  for (const name of ["manifest.json", "summary.json", "comparison.json", "report.md"]) {
    removeManagedFile(managedPath(target, name));
  }
  mkdirSync(repetitions, { recursive: true });
  return {
    target,
    repetitions,
    manifest: managedPath(target, "manifest.json"),
    summary: managedPath(target, "summary.json"),
    comparison: managedPath(target, "comparison.json"),
    report: managedPath(target, "report.md"),
  };
}

function expectedFairnessManifest(publicBenchmark, providerName, model, repetition) {
  return {
    benchmarkId: publicBenchmark.benchmarkId,
    caseIds: publicBenchmark.cases.map((item) => item.id),
    orderedRecordIdsByCase: Object.fromEntries(
      publicBenchmark.cases.map((item) => [item.id, item.records.map((record) => record.id)]),
    ),
    reviewBudgetFraction: publicBenchmark.reviewBudgetFraction,
    provider: providerName,
    model,
    repetition,
  };
}

function assertProviderPrediction(
  publicBenchmark,
  predictions,
  name,
  { providerName, model, repetition },
) {
  try {
    assertNoEvaluatorOnlyFields(predictions);
    assertNoCredentialValues(predictions);
    if (!Array.isArray(predictions?.cases)) throw new Error("cases");
    const expectedCaseIds = publicBenchmark.cases.map((item) => item.id);
    const actualCaseIds = predictions.cases.map((item) => item?.caseId);
    if (canonicalJson(actualCaseIds) !== canonicalJson(expectedCaseIds)) throw new Error("case order");
    const expectedFairness = expectedFairnessManifest(
      publicBenchmark,
      providerName,
      model,
      repetition,
    );
    if (canonicalJson(predictions.metadata?.fairnessManifest) !== canonicalJson(expectedFairness)
      || predictions.metadata?.provider !== providerName
      || predictions.metadata?.model !== model
      || predictions.metadata?.repetition !== repetition) {
      throw new Error("fairness manifest");
    }
    for (let index = 0; index < publicBenchmark.cases.length; index += 1) {
      const testCase = publicBenchmark.cases[index];
      const prediction = predictions.cases[index];
      if (!prediction || !["complete", "failed"].includes(prediction.status)
        || prediction.substituted !== false || !Array.isArray(prediction.rankedRecordIds)) {
        throw new Error("terminal state");
      }
      if (prediction.status === "failed") {
        if (prediction.rankedRecordIds.length !== 0) throw new Error("failed ranking");
        continue;
      }
      const expected = testCase.records.map((record) => record.id);
      const ranking = prediction.rankedRecordIds;
      if (ranking.length !== expected.length || new Set(ranking).size !== expected.length
        || expected.some((id) => !ranking.includes(id))) {
        throw new Error("record ranking");
      }
    }
  } catch {
    throw new Error(name + " provider predictions failed safe public-only artifact validation");
  }
}

function predictionIdentity(predictions) {
  return JSON.stringify(predictions.cases.map((item) => ({
    caseId: item.caseId,
    status: item.status,
    rankedRecordIds: item.rankedRecordIds,
    rankingEvidence: item.rankingEvidence,
    substituted: item.substituted,
    failure: item.failure || null,
  })));
}

function normalizedIdentically(repetitions, systems) {
  for (const system of systems) {
    const identities = repetitions.map((item) => predictionIdentity(item[system]));
    if (identities.some((identity) => identity !== identities[0])) return false;
  }
  return true;
}

function emptyResource() {
  return {
    calls: 0,
    callsKnown: true,
    attempts: 0,
    attemptsKnown: true,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    usageKnown: true,
    providerLatencyMs: 0,
    latencyKnown: true,
    estimatedCostUsd: 0,
    costKnown: true,
  };
}

function predictionResources(predictions) {
  const value = emptyResource();
  for (const item of predictions.cases) {
    if (!Array.isArray(item.trajectory)) throw new Error("Provider trajectory is malformed");
    const results = item.trajectory.filter((event) => event?.type === "provider-result");
    if (results.length === 0 && item.status === "failed") {
      value.callsKnown = false;
      value.attemptsKnown = false;
      value.usageKnown = false;
      value.latencyKnown = false;
      value.costKnown = false;
      continue;
    }
    value.calls += results.length;
    for (const event of results) {
      const attempts = event?.retry?.transportAttempts;
      if (!Number.isInteger(attempts) || attempts < 0) {
        throw new Error("Provider result attempt telemetry is malformed");
      }
      value.attempts += attempts;
      if (event.usage === null) value.usageKnown = false;
      else if (event.usage && Number.isInteger(event.usage.inputTokens)
        && Number.isInteger(event.usage.outputTokens)
        && Number.isInteger(event.usage.totalTokens)
        && event.usage.inputTokens >= 0
        && event.usage.outputTokens >= 0
        && event.usage.totalTokens >= 0) {
        value.usage.inputTokens += event.usage.inputTokens;
        value.usage.outputTokens += event.usage.outputTokens;
        value.usage.totalTokens += event.usage.totalTokens;
      } else throw new Error("Provider result usage telemetry is malformed");
      if (event.latencyMs === null) value.latencyKnown = false;
      else if (Number.isFinite(event.latencyMs) && event.latencyMs >= 0) {
        value.providerLatencyMs += event.latencyMs;
      } else throw new Error("Provider result latency telemetry is malformed");
      const cost = event?.payload?.estimatedCostUsd;
      if (cost === null) value.costKnown = false;
      else if (Number.isFinite(cost) && cost >= 0) value.estimatedCostUsd += cost;
      else throw new Error("Provider result cost telemetry is malformed");
    }
  }
  return value;
}

function resourceSummary(repetitions, systems) {
  const bySystem = { baseline: emptyResource(), advanced: emptyResource() };
  for (const repetition of repetitions) {
    for (const system of systems) {
      const current = predictionResources(repetition[system]);
      const target = bySystem[system];
      target.calls += current.calls;
      target.callsKnown = target.callsKnown && current.callsKnown;
      target.attempts += current.attempts;
      target.attemptsKnown = target.attemptsKnown && current.attemptsKnown;
      target.usage.inputTokens += current.usage.inputTokens;
      target.usage.outputTokens += current.usage.outputTokens;
      target.usage.totalTokens += current.usage.totalTokens;
      target.usageKnown = target.usageKnown && current.usageKnown;
      target.providerLatencyMs += current.providerLatencyMs;
      target.latencyKnown = target.latencyKnown && current.latencyKnown;
      target.estimatedCostUsd += current.estimatedCostUsd;
      target.costKnown = target.costKnown && current.costKnown;
    }
  }
  const baseline = bySystem.baseline;
  const advanced = bySystem.advanced;
  const usageKnown = baseline.usageKnown && advanced.usageKnown;
  const callsKnown = baseline.callsKnown && advanced.callsKnown;
  const attemptsKnown = baseline.attemptsKnown && advanced.attemptsKnown;
  const latencyKnown = baseline.latencyKnown && advanced.latencyKnown;
  const costKnown = baseline.costKnown && advanced.costKnown;
  return {
    providerCalls: {
      baseline: baseline.callsKnown ? baseline.calls : null,
      advanced: advanced.callsKnown ? advanced.calls : null,
      total: callsKnown ? baseline.calls + advanced.calls : null,
    },
    providerAttempts: {
      baseline: baseline.attemptsKnown ? baseline.attempts : null,
      advanced: advanced.attemptsKnown ? advanced.attempts : null,
      total: attemptsKnown ? baseline.attempts + advanced.attempts : null,
    },
    inputTokens: usageKnown ? baseline.usage.inputTokens + advanced.usage.inputTokens : null,
    outputTokens: usageKnown ? baseline.usage.outputTokens + advanced.usage.outputTokens : null,
    totalTokens: usageKnown ? baseline.usage.totalTokens + advanced.usage.totalTokens : null,
    providerLatencyMs: latencyKnown ? baseline.providerLatencyMs + advanced.providerLatencyMs : null,
    estimatedCostUsd: costKnown
      ? round(baseline.estimatedCostUsd + advanced.estimatedCostUsd)
      : null,
    perSystemRuntimeMs: { baseline: null, advanced: null },
    runtimeClaim: "Provider telemetry is recomputed from durable result traces; unknown values remain null.",
  };
}

function metric(result) {
  return {
    numerator: result.primaryMetric.numerator,
    denominator: result.primaryMetric.denominator,
    value: result.primaryMetric.value,
  };
}

function meanRange(values) {
  return {
    mean: round(values.reduce((sum, value) => sum + value, 0) / values.length),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

function createSummary(repetitions, systems, providerName, model) {
  const value = {
    schemaVersion: 1,
    artifactKind: "rubricdelta-provider-evaluation-summary",
    benchmarkId: repetitions[0][systems[0]].metadata.fairnessManifest.benchmarkId,
    provider: providerName,
    model,
    repeats: repetitions.length,
  };
  for (const system of systems) {
    const values = repetitions.map((item) => item.scores[system].primaryMetric.value);
    const scores = repetitions.map((item) => item.scores[system]);
    value[system] = {
      primaryMetric: meanRange(values),
      repetitions: repetitions.map((item) => metric(item.scores[system])),
      secondaryMetrics: {
        meanReciprocalRankFirstAffected: meanRange(scores.map((item) => item.secondaryMetrics.meanReciprocalRankFirstAffected)),
        structuralUnsupportedClaimRate: meanRange(scores.map((item) => item.secondaryMetrics.unsupportedClaimRate.value)),
        escalationRate: meanRange(scores.map((item) => item.secondaryMetrics.escalationRate.value)),
        escalationApplicable: scores.every((item) => item.secondaryMetrics.escalationRate.applicable),
        escalationMechanism: scores[0].secondaryMetrics.escalationRate.mechanism,
        comparableAcrossSystems: false,
      },
      resourcesByRepetition: scores.map((item, index) => ({ repetition: index + 1, ...structuredClone(item.resourceUse) })),
      diagnosticsByRepetition: scores.map((item, index) => ({ repetition: index + 1, ...structuredClone(item.diagnostics) })),
      perCaseByRepetition: scores.map((item, index) => ({
        repetition: index + 1,
        cases: item.perCase.map((caseResult) => ({
          caseId: caseResult.caseId,
          metrics: structuredClone(caseResult.metrics),
          diagnostics: structuredClone(caseResult.diagnostics),
          resourceUse: structuredClone(caseResult.resourceUse),
          missedAffectedRecordIds: [...caseResult.falseNegativeIds],
          falsePositiveIds: [...caseResult.falsePositiveIds],
        })),
      })),
    };
  }
  if (systems.includes("baseline") && systems.includes("advanced")) {
    value.improvement = {
      absolute: round(value.advanced.primaryMetric.mean - value.baseline.primaryMetric.mean),
      baseline: value.baseline.primaryMetric,
      advanced: value.advanced.primaryMetric,
    };
  }
  return value;
}

function safeReplayMetadata(value) {
  if (value === null || value === undefined) return {};
  try {
    assertNoEvaluatorOnlyFields(value);
    assertNoCredentialValues(value);
    const cloned = cloneJson(value);
    const projected = {};
    for (const field of ["binding", "source", "fixture"]) {
      if (Object.hasOwn(cloned, field)) projected[field] = cloned[field];
    }
    return projected;
  } catch {
    throw new Error("Replay artifact metadata failed safe validation");
  }
}

function providerIdentity(provider, model) {
  try {
    if (!provider || typeof provider !== "object" || Array.isArray(provider)
      || utilTypes.isProxy(provider)) throw new Error("provider");
    const descriptors = Object.getOwnPropertyDescriptors(provider);
    const nameDescriptor = descriptors.name;
    const completeDescriptor = descriptors.complete;
    if (!nameDescriptor || nameDescriptor.get || nameDescriptor.set
      || typeof nameDescriptor.value !== "string" || nameDescriptor.value.trim().length === 0
      || !completeDescriptor || completeDescriptor.get || completeDescriptor.set
      || typeof completeDescriptor.value !== "function"
      || typeof model !== "string" || model.trim().length === 0) {
      throw new Error("provider");
    }
    assertNoCredentialValues({ provider: nameDescriptor.value, model });
    return nameDescriptor.value;
  } catch {
    throw new Error("Provider artifact configuration is invalid");
  }
}

function manifestBase(benchmark, benchmarkSource) {
  return {
    schemaVersion: 1,
    artifactKind: "rubricdelta-evaluation-manifest",
    evaluationProtocol: structuredClone(EVALUATION_PROTOCOL),
    benchmark: {
      id: benchmark.benchmarkId,
      schemaVersion: benchmark.schemaVersion,
      sha256: canonicalTextSha256(benchmarkSource || json(benchmark)),
      sha256Canonicalization: "utf8-lf",
      license: benchmark.license || null,
      orderedCaseIds: benchmark.cases.map((item) => item.id),
      orderedRecordIdsByCase: Object.fromEntries(
        benchmark.cases.map((item) => [item.id, item.records.map((record) => record.id)]),
      ),
      caseCount: benchmark.cases.length,
      recordCount: benchmark.cases.reduce((sum, item) => sum + item.records.length, 0),
      affectedRecordCount: benchmark.cases.reduce(
        (sum, item) => sum + item.groundTruth.affectedRecordIds.length,
        0,
      ),
    },
    reviewBudget: {
      fraction: benchmark.reviewBudgetFraction,
      calculation: EVALUATION_PROTOCOL.reviewBudget.calculation,
    },
    runtimeEnvironment: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      runtimeDependencies: 0,
      networkRequired: false,
    },
  };
}

function createManifest({
  benchmark,
  benchmarkSource,
  providerName,
  model,
  repeats,
  identical,
  resources,
  replay,
  hashes,
  execution,
  git,
}) {
  const suppliedReplay = providerName === "replay" ? safeReplayMetadata(replay) : {};
  const base = manifestBase(benchmark, benchmarkSource);
  base.runtimeEnvironment.networkRequired = providerName === "openai";
  const seed = ["deterministic", "capture"].includes(providerName) ? 0 : null;
  return {
    ...base,
    git,
    provider: { name: providerName, model, seed, status: "operational" },
    versions: {
      baselineAlgorithm: "direct-provider-baseline-v1",
      advancedAlgorithm: "four-stage-provider-advanced-v1",
      directBaselinePrompt: "direct-baseline.v1",
      roleInstructions: "provider-prompt-registry-v1",
    },
    repeats: { requested: repeats, normalizedIdentically: identical },
    resources,
    replay: {
      ...suppliedReplay,
      status: providerName === "replay" ? "operational" : "not-applicable",
      operational: providerName === "replay",
      substituted: false,
      rawPredictionSha256ByRepetition: hashes,
    },
    execution,
  };
}

function report(manifest, summary) {
  const lines = [
    "# RubricDelta provider evaluation",
    "",
    "- Benchmark: " + manifest.benchmark.id,
    "- Provider/model: " + manifest.provider.name + " / " + manifest.provider.model,
    "- Repetitions: " + manifest.repeats.requested,
    "- Replay substitution: " + manifest.replay.substituted,
    "",
    "## Primary metric",
    "",
  ];
  for (const system of ["baseline", "advanced"]) {
    if (!summary[system]) continue;
    const value = summary[system].primaryMetric;
    lines.push("- " + system + ": mean " + value.mean.toFixed(2)
      + " (min " + value.min.toFixed(2) + ", max " + value.max.toFixed(2) + ")");
  }
  lines.push("", "## Secondary diagnostics", "");
  for (const system of ["baseline", "advanced"]) {
    if (!summary[system]) continue;
    const secondary = summary[system].secondaryMetrics;
    lines.push("- " + system + " MRR: " + secondary.meanReciprocalRankFirstAffected.mean.toFixed(6));
    lines.push("- " + system + " structural unsupported-claim rate: " + secondary.structuralUnsupportedClaimRate.mean.toFixed(6));
    lines.push("- " + system + " escalation rate: " + secondary.escalationRate.mean.toFixed(6)
      + " (applicable: " + secondary.escalationApplicable + "; mechanism: " + secondary.escalationMechanism + ")");
  }
  lines.push("", "Structural support uses each system's native evidence contract and is not comparable across systems.", "", "## Per-case and resource disclosure", "");
  for (const system of ["baseline", "advanced"]) {
    if (!summary[system]) continue;
    const first = summary[system].perCaseByRepetition[0];
    const diagnostics = summary[system].diagnosticsByRepetition[0];
    const resources = summary[system].resourcesByRepetition[0];
    lines.push("- " + system + " incomplete cases: " + (diagnostics.incompleteCaseIds.join(", ") || "none")
      + "; failed cases: " + (diagnostics.failedCaseIds.join(", ") || "none"));
    lines.push("- " + system + " resources: calls=" + resources.providerCalls + ", attempts=" + resources.providerAttempts
      + ", input/output/total tokens=" + resources.inputTokens + "/" + resources.outputTokens + "/" + resources.totalTokens
      + ", provider latency ms=" + resources.providerLatencyMs + ", runtime ms=" + resources.runtimeMs
      + ", estimated cost USD=" + resources.estimatedCostUsd);
    for (const item of first.cases) {
      lines.push("  - " + item.caseId + ": MRR=" + item.metrics.reciprocalRankFirstAffected.toFixed(6)
        + ", unsupported=" + item.metrics.unsupportedClaimRate.toFixed(6)
        + ", escalation=" + item.metrics.escalationRate.toFixed(6)
        + ", status=" + item.diagnostics.status);
    }
  }
  lines.push(
    "",
    "Every repetition is stored before scoring. Provider failures receive zero credit and are never replaced.",
    "",
  );
  return lines.join("\n").trimEnd() + "\n";
}

function safeProviderName(repetitions, systems) {
  const manifests = repetitions.flatMap((item) => systems.map(
    (system) => item[system].metadata.fairnessManifest,
  ));
  const names = new Set(manifests.map((item) => item.provider));
  const models = new Set(manifests.map((item) => item.model));
  if (names.size !== 1 || models.size !== 1) throw new Error("Provider repetitions are not paired");
  return { name: manifests[0].provider, model: manifests[0].model };
}

function exhaustionMethod(provider) {
  const descriptor = Object.getOwnPropertyDescriptor(provider, "assertExhausted");
  if (!descriptor) return null;
  if (descriptor.get || descriptor.set || typeof descriptor.value !== "function") {
    throw new Error("Replay exhaustion checker is invalid");
  }
  return descriptor.value;
}

export async function createProviderEvaluationArtifacts({
  benchmark,
  benchmarkSource,
  mode,
  outputDir,
  provider,
  model,
  repeats,
  createBaseline,
  createAdvanced,
  score,
  replay = null,
}) {
  const startedAt = new Date().toISOString();
  const startedMs = performance.now();
  if (!["baseline", "advanced", "both"].includes(mode)) {
    throw new Error("mode must be baseline, advanced, or both");
  }
  if (!Number.isInteger(repeats) || repeats < 1) throw new Error("repeats must be a positive integer");
  const expectedProviderName = providerIdentity(provider, model);
  if (typeof score !== "function") throw new Error("score must be a function");
  const systems = mode === "baseline"
    ? ["baseline"]
    : mode === "advanced"
      ? ["advanced"]
      : ["baseline", "advanced"];
  if (systems.includes("baseline") && typeof createBaseline !== "function") {
    throw new Error("baseline provider factory is required");
  }
  if (systems.includes("advanced") && typeof createAdvanced !== "function") {
    throw new Error("advanced provider factory is required");
  }

  const paths = prepareOutput(outputDir);
  const publicBenchmark = createPublicBenchmarkProjection(benchmark);
  const repetitions = [];
  const hashes = {};
  for (let repetition = 1; repetition <= repeats; repetition += 1) {
    const item = { repetition };
    const repetitionRoot = managedPath(paths.repetitions, String(repetition));
    mkdirSync(repetitionRoot, { recursive: true });
    hashes[String(repetition)] = {};
    if (systems.includes("baseline")) {
      item.baseline = await createBaseline(publicBenchmark, {
        provider,
        model,
        repetition,
        now: () => TRACE_TIME,
      });
      assertProviderPrediction(publicBenchmark, item.baseline, "baseline", {
        providerName: expectedProviderName,
        model,
        repetition,
      });
      const path = managedPath(repetitionRoot, "baseline-predictions.json");
      safeWriteJson(path, item.baseline);
      hashes[String(repetition)].baseline = sha256File(path);
    }
    if (systems.includes("advanced")) {
      item.advanced = await createAdvanced(publicBenchmark, {
        provider,
        model,
        repetition,
        now: () => TRACE_TIME,
      });
      assertProviderPrediction(publicBenchmark, item.advanced, "advanced", {
        providerName: expectedProviderName,
        model,
        repetition,
      });
      const path = managedPath(repetitionRoot, "advanced-predictions.json");
      safeWriteJson(path, item.advanced);
      hashes[String(repetition)].advanced = sha256File(path);
    }
    repetitions.push(item);
  }

  const paired = safeProviderName(repetitions, systems);
  if (paired.name !== expectedProviderName || paired.model !== model) {
    throw new Error("Provider repetitions are not paired to the requested provider and model");
  }
  const identical = normalizedIdentically(repetitions, systems);
  const resources = resourceSummary(repetitions, systems);
  const git = createGitState(undefined, managedArtifactRootsForOutput(outputDir));
  const writeManifest = (execution) => safeWriteJson(paths.manifest, createManifest({
    benchmark,
    benchmarkSource,
    providerName: paired.name,
    model,
    repeats,
    identical,
    resources,
    replay,
    hashes,
    execution,
    git,
  }));
  writeManifest({
    status: "incomplete",
    phase: "scoring",
    startedAt,
    endedAt: null,
    runtimeMs: Number((performance.now() - startedMs).toFixed(3)),
  });

  const assertExhausted = exhaustionMethod(provider);
  if (assertExhausted) {
    try {
      assertExhausted.call(provider);
    } catch {
      writeManifest({
        status: "incomplete",
        phase: "replay-exhaustion",
        startedAt,
        endedAt: new Date().toISOString(),
        runtimeMs: Number((performance.now() - startedMs).toFixed(3)),
        failure: { code: "REPLAY_NOT_EXHAUSTED" },
      });
      throw new Error("Replay fixture was not exhausted; scoring was not started");
    }
  }

  try {
    for (const item of repetitions) {
      item.scores = {};
      for (const system of systems) item.scores[system] = score(benchmark, item[system]);
    }
  } catch {
    writeManifest({
      status: "incomplete",
      phase: "scoring",
      startedAt,
      endedAt: new Date().toISOString(),
      runtimeMs: Number((performance.now() - startedMs).toFixed(3)),
      failure: { code: "SCORING_FAILED" },
    });
    throw new Error("Provider evaluation scoring failed; incomplete manifest written");
  }

  const summary = createSummary(repetitions, systems, paired.name, model);
  const execution = {
    status: "complete",
    phase: "complete",
    startedAt,
    endedAt: new Date().toISOString(),
    runtimeMs: Number((performance.now() - startedMs).toFixed(3)),
  };
  const manifest = createManifest({
    benchmark,
    benchmarkSource,
    providerName: paired.name,
    model,
    repeats,
    identical,
    resources,
    replay,
    hashes,
    execution,
    git,
  });
  const comparison = {
    schemaVersion: 1,
    artifactKind: "rubricdelta-provider-paired-evaluation",
    benchmarkId: benchmark.benchmarkId,
    evaluationProtocol: structuredClone(EVALUATION_PROTOCOL),
    fairComparison: {
      provider: paired.name,
      model,
      seed: manifest.provider.seed,
      reviewBudgetFraction: benchmark.reviewBudgetFraction,
      orderedCaseIds: benchmark.cases.map((item) => item.id),
      repeats,
    },
    repetitions: repetitions.map((item) => ({
      repetition: item.repetition,
      scores: structuredClone(item.scores),
    })),
    summary: structuredClone(summary),
    ...(summary.improvement ? { improvement: structuredClone(summary.improvement) } : {}),
  };
  safeWriteJson(paths.summary, summary);
  safeWriteJson(paths.comparison, comparison);
  safeWrite(paths.report, report(manifest, summary));
  safeWriteJson(paths.manifest, manifest);
  return { manifest, repetitions, summary, comparison, outputDir: paths.target };
}
