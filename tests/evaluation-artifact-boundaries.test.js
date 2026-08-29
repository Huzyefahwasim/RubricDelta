import assert from "node:assert/strict";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";
import { createEvaluationArtifacts } from "../scripts/evaluation-artifacts.js";
import { createAdvancedPredictions, createBaselinePredictions, evaluatePredictions, loadBenchmark } from "../src/evaluation/index.js";

function temporaryDirectory(t, prefix) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

test("unsafe benchmark case IDs cannot escape the trajectory directory", (t) => {
  const outputDir = temporaryDirectory(t, "rubricdelta-case-path-");
  const benchmark = structuredClone(loadBenchmark());
  const escapedName = `${basename(outputDir)}-escaped-task7-review`;
  benchmark.cases[0].id = `../../${escapedName}`;
  const escapedPath = resolve(outputDir, "trajectories", `${benchmark.cases[0].id}.jsonl`);
  t.after(() => rmSync(escapedPath, { force: true }));

  assert.throws(() => createEvaluationArtifacts({
    benchmark,
    mode: "advanced",
    outputDir,
    provider: "deterministic",
    model: null,
    repeats: 1,
    createBaseline: null,
    createAdvanced: createAdvancedPredictions,
    score: evaluatePredictions,
  }), /unsafe benchmark case ID/i);

  assert.equal(existsSync(escapedPath), false);
  assert.equal(existsSync(join(outputDir, "advanced-predictions.json")), false);
});

test("reusing an output directory publishes only the selected mode without deleting unrelated files", (t) => {
  const outputDir = temporaryDirectory(t, "rubricdelta-mode-prune-");
  const benchmark = loadBenchmark();
  const run = (mode) => createEvaluationArtifacts({
    benchmark,
    mode,
    outputDir,
    provider: "deterministic",
    model: null,
    repeats: 1,
    createBaseline: createBaselinePredictions,
    createAdvanced: createAdvancedPredictions,
    score: evaluatePredictions,
  });

  run("both");
  assert.equal(existsSync(join(outputDir, "advanced-predictions.json")), true);
  assert.equal(existsSync(join(outputDir, "trajectories")), true);
  const unrelated = join(outputDir, "reviewer-notes", "keep.txt");
  mkdirSync(resolve(unrelated, ".."), { recursive: true });
  writeFileSync(unrelated, "keep this unrelated file\n", "utf8");

  run("baseline");
  assert.equal(existsSync(join(outputDir, "baseline-predictions.json")), true);
  assert.equal(existsSync(join(outputDir, "advanced-predictions.json")), false);
  assert.equal(existsSync(join(outputDir, "trajectories")), false);
  assert.equal(readFileSync(unrelated, "utf8"), "keep this unrelated file\n");
  const comparison = JSON.parse(readFileSync(join(outputDir, "comparison.json"), "utf8"));
  assert.equal(Object.hasOwn(comparison, "baseline"), true);
  assert.equal(Object.hasOwn(comparison, "advanced"), false);
  assert.equal(Object.hasOwn(comparison, "improvement"), false);
});

test("a scoring failure keeps new raw predictions but cannot leave stale success artifacts", (t) => {
  const outputDir = temporaryDirectory(t, "rubricdelta-score-failure-");
  const benchmark = loadBenchmark();
  const options = {
    benchmark,
    mode: "both",
    outputDir,
    provider: "deterministic",
    model: null,
    repeats: 1,
    createBaseline: createBaselinePredictions,
    createAdvanced: createAdvancedPredictions,
  };
  createEvaluationArtifacts({ ...options, score: evaluatePredictions });
  const unrelated = join(outputDir, "reviewer-notes.txt");
  writeFileSync(unrelated, "preserve unrelated review notes\n", "utf8");

  assert.throws(() => createEvaluationArtifacts({
    ...options,
    score() {
      assert.equal(existsSync(join(outputDir, "baseline-predictions.json")), true);
      assert.equal(existsSync(join(outputDir, "advanced-predictions.json")), true);
      throw new Error("sensitive evaluator internals");
    },
  }), /scoring failed.*incomplete/i);

  assert.equal(existsSync(join(outputDir, "baseline-predictions.json")), true);
  assert.equal(existsSync(join(outputDir, "advanced-predictions.json")), true);
  assert.equal(existsSync(join(outputDir, "comparison.json")), false);
  assert.equal(existsSync(join(outputDir, "report.md")), false);
  assert.equal(existsSync(join(outputDir, "trajectories")), false);
  assert.equal(readFileSync(unrelated, "utf8"), "preserve unrelated review notes\n");
  const manifest = JSON.parse(readFileSync(join(outputDir, "manifest.json"), "utf8"));
  assert.equal(manifest.execution.status, "incomplete");
  assert.deepEqual(manifest.execution.failure, { stage: "scoring", code: "SCORING_FAILED" });
  assert.doesNotMatch(JSON.stringify(manifest), /sensitive evaluator internals/i);
});

test("managed file publication replaces hard links and never follows a trajectory directory link", (t) => {
  const parent = temporaryDirectory(t, "rubricdelta-linked-output-");
  const outputDir = join(parent, "evaluation");
  const benchmark = loadBenchmark();
  const run = () => createEvaluationArtifacts({
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
  run();

  const managedTargets = [
    "baseline-predictions.json",
    "advanced-predictions.json",
    "manifest.json",
    "comparison.json",
    "report.md",
    join("trajectories", `${benchmark.cases[0].id}.jsonl`),
  ];
  const sentinels = managedTargets.map((target, index) => {
    const sentinel = join(parent, `outside-sentinel-${index}.txt`);
    const contents = `outside sentinel ${index}\n`;
    writeFileSync(sentinel, contents, "utf8");
    const managed = join(outputDir, target);
    rmSync(managed, { force: true });
    linkSync(sentinel, managed);
    return { sentinel, contents };
  });

  run();
  for (const { sentinel, contents } of sentinels) assert.equal(readFileSync(sentinel, "utf8"), contents);

  const externalDirectory = join(parent, "outside-trajectories");
  mkdirSync(externalDirectory);
  const externalSentinel = join(externalDirectory, "keep.txt");
  writeFileSync(externalSentinel, "outside directory remains intact\n", "utf8");
  const trajectoryRoot = join(outputDir, "trajectories");
  rmSync(trajectoryRoot, { recursive: true, force: true });
  let directoryLinkCreated = false;
  try {
    symlinkSync(externalDirectory, trajectoryRoot, process.platform === "win32" ? "junction" : "dir");
    directoryLinkCreated = true;
  } catch (error) {
    if (!["EPERM", "EACCES", "UNKNOWN"].includes(error.code)) throw error;
  }
  if (directoryLinkCreated) {
    run();
    assert.equal(readFileSync(externalSentinel, "utf8"), "outside directory remains intact\n");
  }
});

test("managed-file pruning refuses to delete a real directory at a file path", (t) => {
  const outputDir = temporaryDirectory(t, "rubricdelta-managed-directory-");
  const protectedDirectory = join(outputDir, "comparison.json");
  mkdirSync(protectedDirectory);
  const sentinel = join(protectedDirectory, "keep.txt");
  writeFileSync(sentinel, "unrelated directory content\n", "utf8");
  assert.throws(() => createEvaluationArtifacts({
    benchmark: loadBenchmark(),
    mode: "both",
    outputDir,
    provider: "deterministic",
    model: null,
    repeats: 1,
    createBaseline: createBaselinePredictions,
    createAdvanced: createAdvancedPredictions,
    score: evaluatePredictions,
  }), /managed artifact target is a directory.*comparison\.json/i);
  assert.equal(readFileSync(sentinel, "utf8"), "unrelated directory content\n");
});
