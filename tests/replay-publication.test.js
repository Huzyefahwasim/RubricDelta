import assert from "node:assert/strict";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const operationalRelativePath = "artifacts/expected-replay-report/operational-replay";
const legacyRelativePath = "artifacts/runs/provider-replay";
const replayBundleFiles = [
  "manifest.json",
  "summary.json",
  "comparison.json",
  "report.md",
  "repetitions/1/baseline-predictions.json",
  "repetitions/1/advanced-predictions.json",
];

function run(command, args, cwd, timeout = 180_000) {
  return spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
}

function output(command) {
  return `${command.stdout ?? ""}\n${command.stderr ?? ""}`;
}

function git(project, args) {
  const command = run("git", args, project, 30_000);
  assert.equal(command.status, 0, output(command));
  return command.stdout.trim();
}

function fixture(t) {
  const destination = join(mkdtempSync(join(tmpdir(), "rubricdelta-replay-publication-")), "repo");
  t.after(() => rmSync(dirname(destination), { recursive: true, force: true }));
  cpSync(root, destination, {
    recursive: true,
    filter(source) {
      const relative = source.slice(root.length).replaceAll("\\", "/");
      return relative !== "/.git"
        && !relative.startsWith("/.git/")
        && !relative.startsWith("/.superpowers")
        && !relative.startsWith("/tmp")
        && !relative.startsWith("/artifacts/tmp")
        && !relative.startsWith("/artifacts/runs")
        && !relative.startsWith(`/${operationalRelativePath}`);
    },
  });
  git(destination, ["init", "--quiet"]);
  git(destination, ["config", "core.autocrlf", "false"]);
  git(destination, ["config", "user.email", "replay-publication@example.invalid"]);
  git(destination, ["config", "user.name", "Replay Publication Test"]);
  git(destination, ["add", "--all"]);
  git(destination, ["commit", "--quiet", "-m", "fixture"]);
  return destination;
}

function json(project, relativePath) {
  return JSON.parse(readFileSync(join(project, ...relativePath.split("/")), "utf8"));
}

function writeJson(project, relativePath, value) {
  writeFileSync(
    join(project, ...relativePath.split("/")),
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
}

function npmRun(project, script) {
  if (process.platform === "win32") {
    return run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "npm.cmd", "run", script], project);
  }
  return run("npm", ["run", script], project);
}

function evaluate(project, args) {
  return run(process.execPath, ["scripts/evaluate.js", ...args], project);
}

function validate(project) {
  return run(process.execPath, [
    "scripts/validate-submission.js",
    "--mode", "build",
    "--root", project,
  ], project, 240_000);
}

function bootstrapDeterministic(project) {
  const command = evaluate(project, ["--mode", "both", "--output-dir", "artifacts/evaluation"]);
  assert.equal(command.status, 0, output(command));
}

function generateOperational(project) {
  const command = evaluate(project, [
    "--provider", "replay",
    "--replay-fixture", "data/benchmark/replay/rubricdelta-deterministic-source.v1.json",
    "--mode", "both",
    "--repeats", "1",
    "--output-dir", operationalRelativePath,
  ]);
  assert.equal(command.status, 0, output(command));
}

test("eval:replay publishes the canonical operational bundle with narrow Git provenance", (t) => {
  const project = fixture(t);
  const sourceRevision = git(project, ["rev-parse", "HEAD"]);
  const referencePath = "artifacts/expected-replay-report/reference-comparison.json";
  const readmePath = "artifacts/expected-replay-report/README.md";
  const referenceBefore = readFileSync(join(project, ...referencePath.split("/")));
  const readmeBefore = readFileSync(join(project, ...readmePath.split("/")));

  const replay = npmRun(project, "eval:replay");
  assert.equal(replay.status, 0, output(replay));
  assert.equal(existsSync(join(project, ...legacyRelativePath.split("/"), "manifest.json")), true);
  assert.equal(existsSync(join(project, ...operationalRelativePath.split("/"), "manifest.json")), true);
  for (const path of replayBundleFiles) {
    assert.deepEqual(
      readFileSync(join(project, ...legacyRelativePath.split("/"), ...path.split("/"))),
      readFileSync(join(project, ...operationalRelativePath.split("/"), ...path.split("/"))),
      `${path} must be an exact compatibility mirror`,
    );
  }
  assert.deepEqual(readFileSync(join(project, ...referencePath.split("/"))), referenceBefore);
  assert.deepEqual(readFileSync(join(project, ...readmePath.split("/"))), readmeBefore);

  const manifest = json(project, `${operationalRelativePath}/manifest.json`);
  assert.equal(manifest.git.revision, sourceRevision);
  assert.equal(manifest.git.baseRevision, sourceRevision);
  assert.equal(manifest.git.sourceWorkingTreeDirty, false);
  assert.equal(manifest.git.sourceUntrackedWorkingTreeDirty, false);
  assert.equal(manifest.git.managedArtifactDirty, true);
  assert.equal(manifest.git.sourceState, "clean-source-managed-artifacts-dirty");
  assert.deepEqual(manifest.provider, {
    name: "replay",
    model: "deterministic-role-capture-v1",
    seed: null,
    status: "operational",
  });
  assert.deepEqual(manifest.resources.providerCalls, { baseline: 10, advanced: 40, total: 50 });
  assert.deepEqual(manifest.resources.providerAttempts, { baseline: 10, advanced: 40, total: 50 });
  assert.equal(manifest.runtimeEnvironment.networkRequired, false);
  assert.equal(manifest.resources.inputTokens, 0);
  assert.equal(manifest.resources.outputTokens, 0);
  assert.equal(manifest.resources.totalTokens, 0);
  assert.equal(manifest.resources.providerLatencyMs, 0);
  assert.equal(manifest.resources.estimatedCostUsd, 0);
  assert.equal(manifest.replay.operational, true);
  assert.equal(manifest.replay.substituted, false);
  for (const scoreField of ["baseline", "advanced", "improvement", "primaryMetric", "scores"]) {
    assert.equal(Object.hasOwn(manifest, scoreField), false, `manifest must not own ${scoreField}`);
  }

  const canonicalBytes = new Map(replayBundleFiles.map((path) => [
    path,
    readFileSync(join(project, ...operationalRelativePath.split("/"), ...path.split("/"))),
  ]));
  const customRelativePath = "artifacts/runs/custom-replay";
  const custom = evaluate(project, [
    "--provider", "replay",
    "--replay-fixture", "data/benchmark/replay/rubricdelta-deterministic-source.v1.json",
    "--mode", "both",
    "--repeats", "1",
    "--output-dir", customRelativePath,
    "--compact",
  ]);
  assert.equal(custom.status, 0, output(custom));
  assert.equal(existsSync(join(project, ...customRelativePath.split("/"), "manifest.json")), true);
  assert.equal(Object.hasOwn(JSON.parse(custom.stdout), "operationalPublicationDir"), false);
  for (const [path, bytes] of canonicalBytes) {
    assert.deepEqual(
      readFileSync(join(project, ...operationalRelativePath.split("/"), ...path.split("/"))),
      bytes,
      `${path} must not change for a custom replay output`,
    );
  }

  bootstrapDeterministic(project);
  let deterministic = json(project, "artifacts/evaluation/manifest.json");
  assert.equal(deterministic.git.revision, sourceRevision);
  assert.equal(deterministic.git.sourceWorkingTreeDirty, false);

  writeFileSync(
    join(project, "artifacts", "expected-replay-report", "untrusted-sibling.txt"),
    "unrelated generated-looking dirt\n",
    "utf8",
  );
  bootstrapDeterministic(project);
  deterministic = json(project, "artifacts/evaluation/manifest.json");
  assert.equal(deterministic.git.revision, null);
  assert.equal(deterministic.git.sourceWorkingTreeDirty, true);
  assert.equal(deterministic.git.sourceUntrackedWorkingTreeDirty, true);
});

test("build validation requires the canonical operational replay publication", (t) => {
  const project = fixture(t);
  bootstrapDeterministic(project);
  const command = validate(project);
  assert.notEqual(command.status, 0, output(command));
  assert.match(output(command), /\[FAIL\].*MISSING.*artifacts\/expected-replay-report\/operational-replay\/manifest\.json/i);
});

test("build validation rejects forged operational replay provenance and telemetry", (t) => {
  const project = fixture(t);
  bootstrapDeterministic(project);
  generateOperational(project);

  const manifestPath = `${operationalRelativePath}/manifest.json`;
  const manifest = json(project, manifestPath);
  manifest.git.revision = "0".repeat(40);
  manifest.provider.name = "deterministic";
  manifest.runtimeEnvironment.networkRequired = true;
  manifest.resources.providerCalls.total = 49;
  manifest.resources.providerAttempts.total = 49;
  manifest.resources.totalTokens = 1;
  manifest.resources.estimatedCostUsd = 1;
  manifest.replay.operational = false;
  manifest.replay.substituted = true;
  writeJson(project, manifestPath, manifest);
  appendFileSync(
    join(project, ...operationalRelativePath.split("/"), "report.md"),
    "forged publication bytes\n",
    "utf8",
  );

  const command = validate(project);
  const combined = output(command);
  assert.notEqual(command.status, 0, combined);
  assert.match(combined, /\[FAIL\].*REPLAY PUBLICATION.*operational-replay\/manifest\.json.*provider.*resource/i);
  assert.match(combined, /\[FAIL\].*REPLAY PUBLICATION.*operational-replay\/manifest\.replay.*binding/i);
  assert.match(combined, /\[FAIL\].*REPLAY PUBLICATION.*operational-replay\/manifest\.git.*revision/i);
  assert.match(combined, /\[FAIL\].*REPLAY PUBLICATION.*operational-replay\/report\.md.*isolated/i);
});

test("build validation rejects incomplete operational replay execution", (t) => {
  const project = fixture(t);
  bootstrapDeterministic(project);
  generateOperational(project);

  const manifestPath = `${operationalRelativePath}/manifest.json`;
  const manifest = json(project, manifestPath);
  manifest.execution.status = "incomplete";
  manifest.execution.phase = "scoring";
  manifest.execution.failure = { code: "FORGED_INCOMPLETE" };
  writeJson(project, manifestPath, manifest);

  const command = validate(project);
  const combined = output(command);
  assert.notEqual(command.status, 0, combined);
  assert.match(combined, /\[FAIL\].*REPLAY PUBLICATION.*operational-replay\/manifest\.json.*(?:complete|immutable)/i);
});

test("build validation rejects immutable operational replay manifest drift", (t) => {
  const project = fixture(t);
  bootstrapDeterministic(project);
  generateOperational(project);

  const manifestPath = `${operationalRelativePath}/manifest.json`;
  const manifest = json(project, manifestPath);
  manifest.schemaVersion = 2;
  manifest.artifactKind = "forged-replay-manifest";
  manifest.benchmark.id = "forged-benchmark";
  manifest.reviewBudget.fraction = 0.5;
  manifest.runtimeEnvironment.runtimeDependencies = 1;
  manifest.versions.baselineAlgorithm = "forged-baseline";
  manifest.repeats.requested = 2;
  manifest.unexpectedImmutableField = true;
  writeJson(project, manifestPath, manifest);

  const command = validate(project);
  const combined = output(command);
  assert.notEqual(command.status, 0, combined);
  assert.match(combined, /\[FAIL\].*REPLAY PUBLICATION.*operational-replay\/manifest\.json.*immutable/i);
});
