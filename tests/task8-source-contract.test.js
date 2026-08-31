import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const evaluate = join(root, "scripts", "evaluate.js");
const generateEvidence = join(root, "scripts", "generate-evidence.js");

function temporaryDirectory(t, prefix) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function run(script, args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

test("deterministic artifacts disclose a non-selected replay path, exact zero resources, and raw byte hashes", (t) => {
  const output = temporaryDirectory(t, "rubricdelta-task8-source-");
  const command = run(evaluate, ["--mode", "both", "--output-dir", output]);
  assert.equal(command.status, 0, command.stderr);

  const manifest = readJson(join(output, "manifest.json"));
  assert.deepEqual(manifest.replay, {
    status: "not-selected",
    operational: false,
    substituted: false,
  });
  assert.deepEqual(manifest.resources.providerCalls, { baseline: 0, advanced: 0, total: 0 });
  assert.deepEqual(manifest.resources.providerAttempts, { baseline: 0, advanced: 0, total: 0 });
  assert.equal(manifest.resources.inputTokens, 0);
  assert.equal(manifest.resources.outputTokens, 0);
  assert.equal(manifest.resources.totalTokens, 0);
  assert.equal(manifest.resources.providerLatencyMs, 0);
  assert.equal(manifest.resources.estimatedCostUsd, 0);
  assert.deepEqual(manifest.artifacts, {
    baselinePredictionsSha256: sha256File(join(output, "baseline-predictions.json")),
    advancedPredictionsSha256: sha256File(join(output, "advanced-predictions.json")),
  });
});

test("generated deterministic reference records the post-Task-8 non-selected state", (t) => {
  const evaluation = temporaryDirectory(t, "rubricdelta-task8-evaluation-");
  const trajectories = temporaryDirectory(t, "rubricdelta-task8-trajectories-");
  const referenceDirectory = temporaryDirectory(t, "rubricdelta-task8-reference-");
  const evaluationCommand = run(evaluate, ["--mode", "both", "--output-dir", evaluation]);
  assert.equal(evaluationCommand.status, 0, evaluationCommand.stderr);

  const evidenceCommand = run(generateEvidence, [
    "--evaluation-dir", evaluation,
    "--output-dir", trajectories,
    "--expected-replay-dir", referenceDirectory,
  ]);
  assert.equal(evidenceCommand.status, 0, evidenceCommand.stderr);

  const reference = readJson(join(referenceDirectory, "reference-comparison.json"));
  assert.equal(reference.status, "deterministic-reference-post-task-8");
  assert.equal(reference.provider, "deterministic");
  assert.equal(reference.replayOperational, false);
  assert.equal(reference.substituted, false);
  assert.equal(reference.artifacts.baselinePredictionsSha256, sha256File(join(evaluation, "baseline-predictions.json")));
  assert.equal(reference.artifacts.advancedPredictionsSha256, sha256File(join(evaluation, "advanced-predictions.json")));
});
