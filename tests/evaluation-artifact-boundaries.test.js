import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
