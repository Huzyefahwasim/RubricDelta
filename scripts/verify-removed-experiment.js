#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  evaluatePredictions,
  loadBenchmark,
  reviewBudgetForCase,
} from "../src/evaluation/index.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultArtifactDir = resolve(
  repositoryRoot,
  "artifacts/experiments/exp-002-unsupported-inference",
);
const MAX_FILE_BYTES = 1024 * 1024;
const BEFORE_REVISION = "21e5cc4b2dc2d1612b50e479e9639c9f0279e79e";
const AFTER_REVISION = "ba60a574ad3ec065039687651c808521ee420634";
const EXPECTED_FILES = Object.freeze({
  "before-predictions.json": Object.freeze({ sha256: "e2696b9ac7b8221c9a7b8ab553c88acd0568f85ba4873b990834ba1af40990ac", bytes: 8084 }),
  "after-predictions.json": Object.freeze({ sha256: "c0cfc16c1cdaa1c4ef73c727bcb6cbe013eac6438da7a209bc2ed60ec896bff9", bytes: 4883 }),
  "comparison.json": Object.freeze({ sha256: "cd8fb9a7348b6604f5836f40baf893655a5cb9d06f7d0592aad6e61ba76124a8", bytes: 3190 }),
  "tests.json": Object.freeze({ sha256: "3ee466f479fbc2815873706f07301838dd5b74489ab5319b76c3f6a99c5e5a01", bytes: 889 }),
  "README.md": Object.freeze({ sha256: "aa6be8d86b4e9d86a5edd5719f44a051ee642d75fdcc556ac3ce680857b39942", bytes: 2129 }),
});
const EXPECTED_DIRECTORY_ENTRIES = Object.freeze([
  "after-predictions.json",
  "before-predictions.json",
  "comparison.json",
  "manifest.json",
  "README.md",
  "tests.json",
]);
const SHARED_OBJECTS = Object.freeze({
  "data/benchmark/benchmark.json": "5dafb1adde80ffbc5598bbfa6a0ba36bd6c1030c",
  "src/evaluation/metrics.js": "ba90be783b4795a7511722b4eeb72daf108bce90",
  "src/evaluation/benchmark.js": "f97f206b694e7506df4cd42848d9c9b563a9b662",
  "src/evaluation/baseline.js": "37a573c9c6569596360929b0e638f57b15efce38",
});
const CHANGED_OBJECTS = Object.freeze({
  "src/agents/impact-investigator.js": Object.freeze({
    before: "c5b75b3624debdc1696dd04ded8e8fd422d4f7cd",
    after: "bd0e3b9746fb9d082aa329ae730d0b79cf9603fc",
  }),
  "src/evaluation/advanced.js": Object.freeze({
    before: "87ef2e5b388e89b887cdf5bff9b1b5367110227e",
    after: "78e738f29e691241f28cb08d8238e9eb13576b15",
  }),
});
const EXPECTED_MANIFEST = Object.freeze({
  schemaVersion: 1,
  artifactKind: "rubricdelta-removed-experiment-manifest",
  experimentId: "EXP-002",
  title: "Remove unsupported cross-delta label-transition inference",
  reconstruction: Object.freeze({
    type: "retrospective",
    method: "isolated-git-archives",
    node: "v24.19.0",
    legacyRuntimeExposed: false,
    perSystemRuntimeClaim: null,
  }),
  revisions: Object.freeze({
    before: BEFORE_REVISION,
    after: AFTER_REVISION,
  }),
  sharedGitObjects: SHARED_OBJECTS,
  changedGitObjects: CHANGED_OBJECTS,
  frozenEvaluation: Object.freeze({
    benchmarkId: "support-routing-drift-v1",
    caseCount: 10,
    recordCount: 100,
    affectedRecordCount: 20,
    reviewBudgetFraction: 0.2,
    reviewSlotsPerCase: 2,
    provider: "deterministic",
    seed: 0,
    protocolV1AndV2Equivalent: true,
  }),
  files: EXPECTED_FILES,
  fileHashing: Object.freeze({
    algorithm: "sha256",
    input: "raw-file-bytes",
    lineEndings: "lf-enforced-by-gitattributes",
  }),
});
const GOLD_KEYS = new Set([
  "affectedrecordids",
  "expectedlabels",
  "groundtruth",
  "isaffected",
  "oraclelabels",
  "rationales",
]);

class VerificationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "VerificationError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new VerificationError(code, message);
}

function object(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function same(left, right) {
  return isDeepStrictEqual(left, right);
}

function validateArtifactDirectory(artifactDir) {
  const root = lstatSync(artifactDir);
  if (!root.isDirectory() || root.isSymbolicLink()) {
    fail("INVALID_DIRECTORY", "artifact path must be a regular directory");
  }
  const entries = readdirSync(artifactDir, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  const names = entries.map((entry) => entry.name);
  if (!same(names, EXPECTED_DIRECTORY_ENTRIES)
    || entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
    fail("INVALID_DIRECTORY", "artifact directory must contain only the six expected regular files");
  }
}

function readBounded(artifactDir, name) {
  const path = resolve(artifactDir, name);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) fail("INVALID_FILE", `${name} must be a regular file`);
  if (stat.size > MAX_FILE_BYTES) fail("FILE_TOO_LARGE", `${name} exceeds one MiB`);
  return readFileSync(path);
}

function parseJson(buffer, name) {
  try {
    const value = JSON.parse(buffer.toString("utf8"));
    if (!object(value)) fail("INVALID_JSON", `${name} must contain a JSON object`);
    return value;
  } catch (error) {
    if (error instanceof VerificationError) throw error;
    fail("INVALID_JSON", `${name} is not valid JSON`);
  }
}

function scanForGold(value, path = "predictions") {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.normalize("NFKC").replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
    if (GOLD_KEYS.has(normalized)) fail("PREDICTIONS_CONTAIN_GOLD", `${path}.${key} is evaluator-only`);
    scanForGold(child, `${path}.${key}`);
  }
}

function validatePredictionSet(predictions, benchmark, name) {
  if (!object(predictions) || !object(predictions.metadata) || !Array.isArray(predictions.cases)) {
    fail("INVALID_PREDICTIONS", `${name} must contain metadata and cases`);
  }
  if (predictions.metadata.provider !== "deterministic" || predictions.metadata.seed !== 0) {
    fail("INVALID_PREDICTIONS", `${name} must use the deterministic provider and seed 0`);
  }
  const expectedCaseIds = benchmark.cases.map((testCase) => testCase.id);
  const actualCaseIds = predictions.cases.map((prediction) => prediction?.caseId);
  if (!same(actualCaseIds, expectedCaseIds)) {
    fail("INVALID_PREDICTIONS", `${name} must preserve frozen case order`);
  }
  for (let index = 0; index < benchmark.cases.length; index += 1) {
    const expectedRecordIds = benchmark.cases[index].records.map((record) => record.id);
    const ranking = predictions.cases[index]?.rankedRecordIds;
    if (!Array.isArray(ranking)
      || ranking.length !== expectedRecordIds.length
      || new Set(ranking).size !== expectedRecordIds.length
      || expectedRecordIds.some((recordId) => !ranking.includes(recordId))) {
      fail("INVALID_PREDICTIONS", `${name}.${expectedCaseIds[index]} must rank each record once`);
    }
  }
}

function score(result) {
  return {
    numerator: result.primaryMetric.numerator,
    denominator: result.primaryMetric.denominator,
    value: result.primaryMetric.value,
  };
}

function selectedDifference(beforeResult, afterResult) {
  const changes = [];
  for (const beforeCase of beforeResult.perCase) {
    const afterCase = afterResult.perCase.find((item) => item.caseId === beforeCase.caseId);
    if (!same(beforeCase.selectedRecordIds, afterCase.selectedRecordIds)) {
      changes.push({
        caseId: beforeCase.caseId,
        beforeSelectedRecordIds: beforeCase.selectedRecordIds,
        afterSelectedRecordIds: afterCase.selectedRecordIds,
        beforeTruePositiveIds: beforeCase.truePositiveIds,
        afterTruePositiveIds: afterCase.truePositiveIds,
      });
    }
  }
  return changes;
}

function validateManifest(manifest) {
  if (!same(manifest, EXPECTED_MANIFEST)) {
    fail("INVALID_MANIFEST", "manifest does not match the complete frozen EXP-002 contract");
  }
}

function validateFileHashes(files) {
  for (const [name, expected] of Object.entries(EXPECTED_FILES)) {
    const rawBytes = files[name];
    const actual = createHash("sha256").update(rawBytes).digest("hex");
    if (actual !== expected.sha256 || rawBytes.length !== expected.bytes) {
      fail("HASH_MISMATCH", `${name} does not match its frozen SHA-256 binding`);
    }
  }
}

function git(args) {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5000,
    windowsHide: true,
  }).trim();
}

function gitObjectsAvailable() {
  try {
    if (git(["rev-parse", "--is-inside-work-tree"]) !== "true") return false;
    git(["cat-file", "-e", `${BEFORE_REVISION}^{commit}`]);
    git(["cat-file", "-e", `${AFTER_REVISION}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function verifyGitObjects() {
  if (!gitObjectsAvailable()) {
    return { status: "unavailable", revisionsChecked: 0, pathObjectsChecked: 0 };
  }
  let pathObjectsChecked = 0;
  for (const [path, expected] of Object.entries(SHARED_OBJECTS)) {
    for (const revision of [BEFORE_REVISION, AFTER_REVISION]) {
      if (git(["rev-parse", `${revision}:${path}`]) !== expected) {
        fail("GIT_OBJECT_MISMATCH", `${path} differs at ${revision}`);
      }
      pathObjectsChecked += 1;
    }
  }
  for (const [path, expected] of Object.entries(CHANGED_OBJECTS)) {
    if (git(["rev-parse", `${BEFORE_REVISION}:${path}`]) !== expected.before
      || git(["rev-parse", `${AFTER_REVISION}:${path}`]) !== expected.after) {
      fail("GIT_OBJECT_MISMATCH", `${path} does not match the recorded before-and-after objects`);
    }
    pathObjectsChecked += 2;
  }
  return { status: "verified", revisionsChecked: 2, pathObjectsChecked };
}

function parseArguments(argv) {
  let artifactDir = defaultArtifactDir;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--artifact-dir" || !argv[index + 1]) {
      fail("INVALID_ARGUMENT", "usage: node scripts/verify-removed-experiment.js [--artifact-dir <path>]");
    }
    artifactDir = resolve(argv[index + 1]);
    index += 1;
  }
  return { artifactDir };
}

function validateDataFiles({ before, after, comparison, testObservations }) {
  if (before.artifactKind !== "rubricdelta-removed-experiment-predictions"
    || before.position !== "before"
    || before.sourceRevision !== BEFORE_REVISION
    || before.capture?.perSystemRuntimeMs !== null
    || after.artifactKind !== "rubricdelta-removed-experiment-predictions"
    || after.position !== "after"
    || after.sourceRevision !== AFTER_REVISION
    || after.capture?.perSystemRuntimeMs !== null) {
    fail("INVALID_PREDICTIONS", "prediction provenance does not match the frozen revisions");
  }
  if (comparison.artifactKind !== "rubricdelta-removed-experiment-comparison"
    || comparison.experimentId !== "EXP-002"
    || comparison.protocolEquivalence?.equivalentOnThisBenchmark !== true
    || comparison.perSystemRuntimeMs?.baseline !== null
    || comparison.perSystemRuntimeMs?.beforeAdvanced !== null
    || comparison.perSystemRuntimeMs?.afterAdvanced !== null) {
    fail("INVALID_COMPARISON", "comparison metadata does not match EXP-002");
  }
  if (testObservations.artifactKind !== "rubricdelta-retrospective-test-observations"
    || testObservations.node !== "v24.19.0"
    || testObservations.perSystemRuntimeMs !== null
    || !same(testObservations.runs?.map((run) => ({
      position: run.position,
      revision: run.sourceRevision,
      tests: run.tests,
      passed: run.passed,
      failed: run.failed,
    })), [
      { position: "before", revision: BEFORE_REVISION, tests: 35, passed: 35, failed: 0 },
      { position: "after", revision: AFTER_REVISION, tests: 46, passed: 46, failed: 0 },
    ])) {
    fail("INVALID_TEST_OBSERVATIONS", "historical test observations do not match the reconstruction record");
  }
}

export function verifyRemovedExperiment({ artifactDir = defaultArtifactDir } = {}) {
  validateArtifactDirectory(artifactDir);
  const files = Object.fromEntries(
    ["manifest.json", ...Object.keys(EXPECTED_FILES)].map((name) => [name, readBounded(artifactDir, name)]),
  );
  const manifest = parseJson(files["manifest.json"], "manifest.json");
  const before = parseJson(files["before-predictions.json"], "before-predictions.json");
  const after = parseJson(files["after-predictions.json"], "after-predictions.json");
  const comparison = parseJson(files["comparison.json"], "comparison.json");
  const testObservations = parseJson(files["tests.json"], "tests.json");
  const benchmark = loadBenchmark();

  scanForGold(before.systems);
  scanForGold(after.systems);
  validatePredictionSet(before.systems?.baseline, benchmark, "before.baseline");
  validatePredictionSet(before.systems?.advanced, benchmark, "before.advanced");
  validatePredictionSet(after.systems?.baseline, benchmark, "after.baseline");
  validatePredictionSet(after.systems?.advanced, benchmark, "after.advanced");
  validateManifest(manifest);
  validateDataFiles({ before, after, comparison, testObservations });
  validateFileHashes(files);

  if (!benchmark.cases.every((testCase) => testCase.records.length === 10)
    || !benchmark.cases.every((testCase) => reviewBudgetForCase(testCase, benchmark.reviewBudgetFraction) === 2)
    || Math.max(1, Math.ceil(10 * benchmark.reviewBudgetFraction)) !== 2) {
    fail("PROTOCOL_MISMATCH", "protocol v1 and v2 are not equivalent on the frozen cases");
  }

  const beforeBaselineResult = evaluatePredictions(benchmark, before.systems.baseline);
  const afterBaselineResult = evaluatePredictions(benchmark, after.systems.baseline);
  const beforeAdvancedResult = evaluatePredictions(benchmark, before.systems.advanced);
  const afterAdvancedResult = evaluatePredictions(benchmark, after.systems.advanced);
  const scores = {
    baseline: score(beforeBaselineResult),
    beforeAdvanced: score(beforeAdvancedResult),
    afterAdvanced: score(afterAdvancedResult),
  };
  const expectedScores = {
    baseline: { numerator: 16, denominator: 20, value: 0.8 },
    beforeAdvanced: { numerator: 19, denominator: 20, value: 0.95 },
    afterAdvanced: { numerator: 18, denominator: 20, value: 0.9 },
  };
  if (!same(scores, expectedScores)
    || !same(score(afterBaselineResult), expectedScores.baseline)
    || !same(before.systems.baseline, after.systems.baseline)) {
    fail("SCORE_MISMATCH", "current evaluator scores do not match the frozen retrospective");
  }

  const changedReviewQueues = selectedDifference(beforeAdvancedResult, afterAdvancedResult);
  const expectedChangedReviewQueues = comparison.selectedQueueDifferences.map((item) => ({
    caseId: item.caseId,
    beforeSelectedRecordIds: item.beforeSelectedRecordIds,
    afterSelectedRecordIds: item.afterSelectedRecordIds,
    beforeTruePositiveIds: item.beforeTruePositiveIds,
    afterTruePositiveIds: item.afterTruePositiveIds,
  }));
  if (!same(changedReviewQueues, expectedChangedReviewQueues)
    || !same(changedReviewQueues, [
      {
        caseId: "assistive-technology-blocker",
        beforeSelectedRecordIds: ["a11y-02", "a11y-04"],
        afterSelectedRecordIds: ["a11y-03", "a11y-07"],
        beforeTruePositiveIds: ["a11y-02", "a11y-04"],
        afterTruePositiveIds: [],
      },
      {
        caseId: "bank-chargeback-filed",
        beforeSelectedRecordIds: ["dispute-02", "dispute-04"],
        afterSelectedRecordIds: ["dispute-02", "dispute-07"],
        beforeTruePositiveIds: ["dispute-02"],
        afterTruePositiveIds: ["dispute-02", "dispute-07"],
      },
    ])) {
    fail("DIFFERENCE_MISMATCH", "selected review queues do not match the recorded two-case difference");
  }

  return {
    status: "verified",
    experimentId: "EXP-002",
    reconstruction: "retrospective",
    scores,
    changedReviewQueues,
    protocolEquivalence: {
      recordCountPerCase: 10,
      reviewBudgetFraction: 0.2,
      protocolV1Slots: 2,
      protocolV2Slots: 2,
    },
    git: verifyGitObjects(),
    perSystemRuntimeClaim: null,
  };
}

try {
  const options = parseArguments(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(verifyRemovedExperiment(options), null, 2)}\n`);
} catch (error) {
  const code = error instanceof VerificationError ? error.code : "VERIFICATION_FAILED";
  process.stderr.write(`${code}: ${error instanceof VerificationError ? error.message : "removed experiment verification failed"}\n`);
  process.exitCode = 1;
}
