import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { toPublicScenario } from "../src/domain/scenario.js";
import { reviewBudgetForCase } from "../src/evaluation/benchmark.js";
import { canonicalTextSha256 } from "../src/evaluation/evidence-hash.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const canonicalEvidenceRoot = resolve(repositoryRoot, "artifacts", "evaluation");
const GOLD = /groundTruth|affectedRecordIds|expectedLabels|rationales/i;
const TRACE_TIME = "2000-01-01T00:00:00.000Z";
const SAFE_CASE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const WINDOWS_RESERVED = /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\..*)?$/i;

function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function json(value) { return `${JSON.stringify(value, null, 2)}\n`; }
function round(value) { return Number(value.toFixed(6)); }
function list(values) { return values.length === 0 ? "none" : values.join(", "); }

function contained(root, target) {
  const item = relative(root, target);
  return item !== "" && item !== ".." && !item.startsWith(`..${sep}`) && !isAbsolute(item);
}

function trajectoryPath(root, caseId) {
  if (typeof caseId !== "string" || !SAFE_CASE_ID.test(caseId) || WINDOWS_RESERVED.test(caseId)) {
    throw new Error(`unsafe benchmark case ID: ${String(caseId)}`);
  }
  const target = resolve(root, `${caseId}.jsonl`);
  if (!contained(root, target)) throw new Error(`unsafe benchmark case ID: ${caseId}`);
  return target;
}

function managedArtifactPath(root, name) {
  const target = resolve(root, name);
  if (!contained(root, target)) throw new Error(`unsafe managed artifact path: ${name}`);
  return target;
}

function safeWrite(path, source) {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true });
  const token = `${process.pid}-${randomUUID()}`;
  const temporary = resolve(parent, `.${basename(path)}.${token}.tmp`);
  const backup = resolve(parent, `.${basename(path)}.${token}.bak`);
  if (!contained(parent, temporary) || !contained(parent, backup)) throw new Error("unsafe managed artifact sibling path");
  let backedUp = false;
  try {
    writeFileSync(temporary, source, { encoding: "utf8", flag: "wx" });
    if (existsSync(path)) {
      const existing = lstatSync(path);
      if (existing.isDirectory() && !existing.isSymbolicLink()) throw new Error(`managed artifact target is a directory: ${basename(path)}`);
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

function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function removeManagedFile(path) {
  const existing = lstatOrNull(path);
  if (!existing) return;
  if (existing.isDirectory() && !existing.isSymbolicLink()) {
    throw new Error(`managed artifact target is a directory: ${basename(path)}`);
  }
  unlinkSync(path);
}

function prepareModeArtifacts(target, mode) {
  const baselinePath = managedArtifactPath(target, "baseline-predictions.json");
  const advancedPath = managedArtifactPath(target, "advanced-predictions.json");
  const trajectoryRoot = managedArtifactPath(target, "trajectories");
  const manifestPath = managedArtifactPath(target, "manifest.json");
  const comparisonPath = managedArtifactPath(target, "comparison.json");
  const reportPath = managedArtifactPath(target, "report.md");
  const commonFiles = [manifestPath, comparisonPath, reportPath];
  const staleFiles = mode === "baseline"
    ? [...commonFiles, advancedPath]
    : mode === "advanced"
      ? [...commonFiles, baselinePath]
      : commonFiles;
  for (const path of new Set(staleFiles)) {
    if (!contained(target, path)) throw new Error("refusing to prune a managed artifact outside the output directory");
    removeManagedFile(path);
  }
  if (!contained(target, trajectoryRoot)) throw new Error("refusing to prune managed trajectories outside the output directory");
  if (lstatOrNull(trajectoryRoot)) rmSync(trajectoryRoot, { recursive: true, force: true });
  return { baselinePath, advancedPath, trajectoryRoot, manifestPath, comparisonPath, reportPath };
}

function git(args, fallback) {
  try { return execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return fallback; }
}

function dirtyStatus(status) {
  return status === "unknown" ? null : status.length > 0;
}

function managedGitPaths(paths) {
  return [...new Set(paths.map((path) => {
    const item = relative(repositoryRoot, resolve(path));
    if (item === "" || item === ".." || item.startsWith(`..${sep}`) || isAbsolute(item)) return null;
    return item.replaceAll("\\", "/");
  }).filter(Boolean))];
}

export function classifyGitState({
  baseRevision,
  branch,
  trackedStatus,
  wholeStatus,
  sourceTrackedStatus,
  sourceUntrackedStatus,
  managedStatus,
}) {
  const trackedWorkingTreeDirty = dirtyStatus(trackedStatus);
  const wholeWorkingTreeDirty = dirtyStatus(wholeStatus);
  const sourceTrackedWorkingTreeDirty = dirtyStatus(sourceTrackedStatus);
  const sourceUntrackedWorkingTreeDirty = dirtyStatus(sourceUntrackedStatus);
  const managedArtifactDirty = dirtyStatus(managedStatus);
  const sourceWorkingTreeDirty = sourceTrackedWorkingTreeDirty === true || sourceUntrackedWorkingTreeDirty === true
    ? true
    : sourceTrackedWorkingTreeDirty === false && sourceUntrackedWorkingTreeDirty === false
      ? false
      : null;
  let sourceState = "unknown";
  if (sourceWorkingTreeDirty === true) sourceState = "source-working-tree-dirty";
  else if (sourceWorkingTreeDirty === false && wholeWorkingTreeDirty === false && managedArtifactDirty === false) sourceState = "clean-commit";
  else if (sourceWorkingTreeDirty === false && wholeWorkingTreeDirty === true && managedArtifactDirty === true) sourceState = "clean-source-managed-artifacts-dirty";
  const revisionAvailable = typeof baseRevision === "string" && /^[a-f0-9]{40}$/.test(baseRevision);
  return {
    revision: revisionAvailable && sourceWorkingTreeDirty === false && sourceState !== "unknown" ? baseRevision : null,
    baseRevision,
    branch,
    trackedWorkingTreeDirty,
    wholeWorkingTreeDirty,
    sourceTrackedWorkingTreeDirty,
    sourceUntrackedWorkingTreeDirty,
    sourceWorkingTreeDirty,
    managedArtifactDirty,
    packagingCommit: null,
    provenanceNote: "revision identifies the clean source commit; generated evidence is added by the subsequent packaging commit",
    sourceState,
  };
}

export function createGitState(runGit = git, managedArtifactPaths = []) {
  const managed = managedGitPaths(managedArtifactPaths);
  const exclusions = managed.map((path) => `:(top,exclude,literal)${path}`);
  const managedIncludes = managed.map((path) => `:(top,literal)${path}`);
  return classifyGitState({
    baseRevision: runGit(["rev-parse", "HEAD"], "unavailable"),
    branch: runGit(["branch", "--show-current"], "unavailable"),
    trackedStatus: runGit(["status", "--porcelain=v1", "--untracked-files=no"], "unknown"),
    wholeStatus: runGit(["status", "--porcelain=v1", "--untracked-files=all"], "unknown"),
    sourceTrackedStatus: runGit(["status", "--porcelain=v1", "--untracked-files=no", "--", ".", ...exclusions], "unknown"),
    sourceUntrackedStatus: runGit(["ls-files", "--others", "--exclude-standard", "--", ".", ...exclusions], "unknown"),
    managedStatus: managed.length === 0
      ? ""
      : runGit(["status", "--porcelain=v1", "--untracked-files=all", "--", ...managedIncludes], "unknown"),
  });
}

export function createPublicBenchmarkProjection(benchmark) {
  return freeze({
    benchmarkId: benchmark.benchmarkId,
    reviewBudgetFraction: benchmark.reviewBudgetFraction,
    license: benchmark.license ?? null,
    cases: benchmark.cases.map(toPublicScenario),
  });
}

function assertComplete(publicBenchmark, predictions, name) {
  if (!Array.isArray(predictions?.cases)) throw new Error(`${name} predictions must contain a cases array`);
  if (JSON.stringify(predictions.cases.map((item) => item?.caseId)) !== JSON.stringify(publicBenchmark.cases.map((item) => item.id))) {
    throw new Error(`${name} predictions must preserve every benchmark case in frozen order`);
  }
  for (let index = 0; index < publicBenchmark.cases.length; index += 1) {
    const testCase = publicBenchmark.cases[index];
    const expected = testCase.records.map((record) => record.id);
    const ranking = predictions.cases[index]?.rankedRecordIds;
    if (!Array.isArray(ranking) || ranking.length !== expected.length || new Set(ranking).size !== expected.length || expected.some((id) => !ranking.includes(id))) {
      throw new Error(`${name} prediction ${testCase.id} must rank all ${expected.length} records exactly once`);
    }
  }
  if (GOLD.test(JSON.stringify(predictions))) throw new Error(`${name} raw predictions contain evaluator-only ground truth`);
}

function metadata(predictions, { name, version, provider, model }) {
  return {
    ...structuredClone(predictions),
    metadata: { ...structuredClone(predictions.metadata ?? {}), system: name, algorithmVersion: version, provider, model, seed: 0 },
  };
}

function identical(runs, name) {
  const expected = JSON.stringify(runs[0]);
  if (runs.some((run) => JSON.stringify(run) !== expected)) throw new Error(`${name} deterministic repetitions produced different raw predictions`);
  return runs[0];
}

function metric(result) {
  return { numerator: result.primaryMetric.numerator, denominator: result.primaryMetric.denominator, value: result.primaryMetric.value };
}

function manifest({ benchmark, benchmarkSource, provider, model, repeats, execution, gitState }) {
  const hard = benchmark.cases.find((item) => item.difficulty === "hard" && item.changeType === "precedence_exception");
  return {
    schemaVersion: 1,
    artifactKind: "rubricdelta-evaluation-manifest",
    git: gitState,
    benchmark: {
      id: benchmark.benchmarkId,
      schemaVersion: benchmark.schemaVersion,
      sha256: canonicalTextSha256(benchmarkSource ?? json(benchmark)),
      sha256Canonicalization: "utf8-lf",
      license: benchmark.license ?? null,
      orderedCaseIds: benchmark.cases.map((item) => item.id),
      orderedRecordIdsByCase: Object.fromEntries(benchmark.cases.map((item) => [item.id, item.records.map((record) => record.id)])),
      caseCount: benchmark.cases.length,
      recordCount: benchmark.cases.reduce((sum, item) => sum + item.records.length, 0),
      affectedRecordCount: benchmark.cases.reduce((sum, item) => sum + item.groundTruth.affectedRecordIds.length, 0),
      hardPrecedenceCaseId: hard?.id ?? null,
    },
    provider: { name: provider, model, seed: 0, status: "operational" },
    reviewBudget: {
      fraction: benchmark.reviewBudgetFraction,
      calculation: "max(1, ceil(recordCount * fraction))",
      slotsByCase: Object.fromEntries(benchmark.cases.map((item) => [item.id, reviewBudgetForCase(item, benchmark.reviewBudgetFraction)])),
    },
    versions: {
      baselineAlgorithm: "added-guideline-term-overlap-v1",
      advancedAlgorithm: "rubricdelta-four-stage-deterministic-v1",
      directBaselinePrompt: null,
      roleInstructions: "embedded-deterministic-v1",
    },
    repeats: { requested: repeats, normalizedIdentically: true },
    runtimeEnvironment: { node: process.version, platform: process.platform, architecture: process.arch, runtimeDependencies: 0, networkRequired: false },
    resources: {
      providerCalls: { baseline: 0, advanced: 0, total: 0 }, inputTokens: 0, outputTokens: 0, totalTokens: 0,
      estimatedCostUsd: 0, perSystemRuntimeMs: { baseline: null, advanced: null },
      runtimeClaim: "overall artifact wall time measured; per-system runtime comparison not claimed",
    },
    replay: { status: "deferred-task-8", operational: false, substituted: false, expectedReference: "../expected-replay-report/reference-comparison.json" },
    execution,
  };
}

function comparison(manifestValue, baseline, advanced, repeats) {
  const value = {
    schemaVersion: 1,
    artifactKind: "rubricdelta-paired-evaluation",
    benchmarkId: manifestValue.benchmark.id,
    primaryMetric: "microAffectedRecallAtReviewBudget",
    fairComparison: {
      provider: manifestValue.provider.name,
      model: manifestValue.provider.model,
      seed: manifestValue.provider.seed,
      reviewBudgetFraction: manifestValue.reviewBudget.fraction,
      orderedCaseIds: manifestValue.benchmark.orderedCaseIds,
      completeCasesRequired: true,
    },
    repeats: {
      baseline: baseline ? Array.from({ length: repeats }, () => metric(baseline)) : [],
      advanced: advanced ? Array.from({ length: repeats }, () => metric(advanced)) : [],
    },
  };
  if (baseline) value.baseline = baseline;
  if (advanced) value.advanced = advanced;
  if (baseline && advanced) {
    const before = metric(baseline); const after = metric(advanced);
    value.improvement = {
      metric: "microAffectedRecallAtReviewBudget", baseline: before, advanced: after,
      absolute: round(after.value - before.value), relative: before.value === 0 ? null : round((after.value - before.value) / before.value),
    };
    const caseId = manifestValue.benchmark.hardPrecedenceCaseId;
    value.hardCase = {
      caseId,
      baseline: baseline.perCase.find((item) => item.caseId === caseId),
      advanced: advanced.perCase.find((item) => item.caseId === caseId),
    };
  }
  return value;
}

function report(manifestValue, result) {
  const lines = [
    "# RubricDelta paired evaluation", "",
    `- Benchmark: \`${manifestValue.benchmark.id}\``,
    `- Provider/model: \`${manifestValue.provider.name}\` / \`${manifestValue.provider.model ?? "none"}\``,
    `- Review budget: ${(manifestValue.reviewBudget.fraction * 100).toFixed(0)}% (${Object.values(manifestValue.reviewBudget.slotsByCase)[0]} records per included case)`,
    `- Repetitions: ${manifestValue.repeats.requested} (normalized identically: true)`,
    `- Started: ${manifestValue.execution.startedAt}`,
    `- Ended: ${manifestValue.execution.endedAt}`,
    `- Wall-clock artifact run: ${manifestValue.execution.runtimeMs} ms`, "", "## Primary result", "",
  ];
  if (result.baseline) lines.push(`- Baseline: ${result.baseline.primaryMetric.numerator}/${result.baseline.primaryMetric.denominator} = ${result.baseline.primaryMetric.value.toFixed(2)}`);
  if (result.advanced) lines.push(`- Advanced: ${result.advanced.primaryMetric.numerator}/${result.advanced.primaryMetric.denominator} = ${result.advanced.primaryMetric.value.toFixed(2)}`);
  if (result.improvement) lines.push(`- Absolute improvement: +${result.improvement.absolute.toFixed(2)}; relative improvement: ${(result.improvement.relative * 100).toFixed(1)}%`);
  lines.push("", "## Every benchmark case", "");
  for (const caseId of manifestValue.benchmark.orderedCaseIds) {
    const before = result.baseline?.perCase.find((item) => item.caseId === caseId);
    const after = result.advanced?.perCase.find((item) => item.caseId === caseId);
    lines.push(`### ${caseId}`, "");
    if (before) lines.push(`- Baseline — selected: ${list(before.selectedRecordIds)}; missed: ${list(before.falseNegativeIds)}; false positives: ${list(before.falsePositiveIds)}; recall: ${before.metrics.affectedRecallAtBudget.toFixed(2)}`);
    if (after) lines.push(`- Advanced — selected: ${list(after.selectedRecordIds)}; missed: ${list(after.falseNegativeIds)}; false positives: ${list(after.falsePositiveIds)}; recall: ${after.metrics.affectedRecallAtBudget.toFixed(2)}`);
    lines.push("");
  }
  if (result.hardCase) lines.push("## Hard precedence case", "", `\`${result.hardCase.caseId}\` requires the new high-priority rule to override the older general route.`, `Baseline selected ${list(result.hardCase.baseline.selectedRecordIds)}; advanced selected ${list(result.hardCase.advanced.selectedRecordIds)}.`, "");
  lines.push(
    "## Resource disclosure", "",
    "| System | Runtime | Provider calls | Tokens | Estimated cost |", "| --- | ---: | ---: | ---: | ---: |",
  );
  if (result.baseline) lines.push(`| Baseline | ${result.baseline.resourceUse.runtimeMs ?? "not measured"} | 0 | 0 | $${result.baseline.resourceUse.estimatedCostUsd ?? 0} |`);
  if (result.advanced) lines.push(`| Advanced | ${result.advanced.resourceUse.runtimeMs ?? "not measured"} | 0 | 0 | $${result.advanced.resourceUse.estimatedCostUsd ?? 0} |`);
  lines.push("", "The wall-clock artifact runtime is truthful execution metadata, not a speed comparison. Per-system runtime remains not measured; the deterministic systems make no provider calls, use no model tokens, and cost $0.", "", "## Raw artifacts", "", "- [Manifest](manifest.json)");
  if (result.baseline) lines.push("- [Baseline raw predictions](baseline-predictions.json)");
  if (result.advanced) lines.push("- [Advanced raw predictions](advanced-predictions.json)", "- [Per-case trajectories](trajectories/)");
  lines.push("- [Complete machine-readable comparison](comparison.json)");
  return `${lines.join("\n").trimEnd()}\n`;
}

export function createEvaluationArtifacts({ benchmark, benchmarkSource, mode, outputDir, provider, model, repeats, createBaseline, createAdvanced, score }) {
  const startedAt = new Date().toISOString(); const startedMs = performance.now();
  if (!["baseline", "advanced", "both"].includes(mode)) throw new Error("mode must be baseline, advanced, or both");
  if (provider !== "deterministic") throw new Error(`Provider ${provider} is unavailable in Task 7; Task 8 must install it before use`);
  if (model !== null) throw new Error("--model cannot be used with the deterministic provider");
  if (!Number.isInteger(repeats) || repeats < 1) throw new Error("repeats must be a positive integer");
  const target = resolve(outputDir);
  const trajectoryRoot = managedArtifactPath(target, "trajectories");
  for (const item of benchmark.cases) trajectoryPath(trajectoryRoot, item.id);
  const managedGitRoots = relative(canonicalEvidenceRoot, target) === "" ? [canonicalEvidenceRoot] : [];
  const gitState = createGitState(git, managedGitRoots);
  mkdirSync(target, { recursive: true });
  const publicBenchmark = createPublicBenchmarkProjection(benchmark); const baselineRuns = []; const advancedRuns = [];
  for (let repeat = 0; repeat < repeats; repeat += 1) {
    if (mode !== "advanced") {
      const run = metadata(createBaseline(createPublicBenchmarkProjection(benchmark), { provider, model, seed: 0 }), { name: "added-guideline-term-overlap-baseline", version: "added-guideline-term-overlap-v1", provider, model });
      assertComplete(publicBenchmark, run, "baseline"); baselineRuns.push(run);
    }
    if (mode !== "baseline") {
      const run = metadata(createAdvanced(createPublicBenchmarkProjection(benchmark), { provider, model, seed: 0, now: () => TRACE_TIME }), { name: "rubricdelta-four-stage-deterministic", version: "rubricdelta-four-stage-deterministic-v1", provider, model });
      assertComplete(publicBenchmark, run, "advanced"); advancedRuns.push(run);
    }
  }
  const baselinePredictions = baselineRuns.length ? identical(baselineRuns, "baseline") : null;
  const advancedPredictions = advancedRuns.length ? identical(advancedRuns, "advanced") : null;
  const artifactPaths = prepareModeArtifacts(target, mode);
  if (baselinePredictions) safeWriteJson(artifactPaths.baselinePath, baselinePredictions);
  if (advancedPredictions) safeWriteJson(artifactPaths.advancedPath, advancedPredictions);
  const inProgressExecution = {
    status: "incomplete",
    phase: "scoring",
    startedAt,
    endedAt: null,
    runtimeMs: Number((performance.now() - startedMs).toFixed(3)),
  };
  safeWriteJson(artifactPaths.manifestPath, manifest({
    benchmark,
    benchmarkSource,
    provider,
    model,
    repeats,
    execution: inProgressExecution,
    gitState,
  }));
  let baseline;
  let advanced;
  try {
    baseline = baselinePredictions ? score(benchmark, baselinePredictions) : null;
    advanced = advancedPredictions ? score(benchmark, advancedPredictions) : null;
  } catch {
    const execution = {
      status: "incomplete",
      startedAt,
      endedAt: new Date().toISOString(),
      runtimeMs: Number((performance.now() - startedMs).toFixed(3)),
      failure: { stage: "scoring", code: "SCORING_FAILED" },
    };
    safeWriteJson(artifactPaths.manifestPath, manifest({ benchmark, benchmarkSource, provider, model, repeats, execution, gitState }));
    throw new Error("Evaluation scoring failed; incomplete manifest written");
  }
  const execution = {
    status: "complete",
    startedAt,
    endedAt: new Date().toISOString(),
    runtimeMs: Number((performance.now() - startedMs).toFixed(3)),
  };
  const manifestValue = manifest({ benchmark, benchmarkSource, provider, model, repeats, execution, gitState });
  const comparisonValue = comparison(manifestValue, baseline, advanced, repeats);
  safeWriteJson(artifactPaths.comparisonPath, comparisonValue);
  safeWrite(artifactPaths.reportPath, report(manifestValue, comparisonValue));
  if (advancedPredictions) {
    mkdirSync(trajectoryRoot, { recursive: true });
    for (const item of advancedPredictions.cases) safeWrite(trajectoryPath(trajectoryRoot, item.caseId), `${item.trajectory.map(JSON.stringify).join("\n")}\n`);
  }
  safeWriteJson(artifactPaths.manifestPath, manifestValue);
  return { manifest: manifestValue, baselinePredictions, advancedPredictions, comparison: comparisonValue, outputDir: target };
}

export function benchmarkSourceAt(path) { return readFileSync(path, "utf8"); }
export function displayPath(path) { const item = relative(process.cwd(), path); return item && !item.startsWith("..") ? item.replaceAll("\\", "/") : path; }
