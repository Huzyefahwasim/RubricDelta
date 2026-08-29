import assert from "node:assert/strict";
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hashBoundPaths = [
  "data/benchmark/benchmark.json",
  "artifacts/evaluation/baseline-predictions.json",
  "artifacts/evaluation/advanced-predictions.json",
  "artifacts/evaluation/comparison.json",
  "artifacts/evaluation/manifest.json",
  "artifacts/evaluation/report.md",
  "artifacts/evaluation/trajectories/fraud-overrides-refunds.jsonl",
  "artifacts/representative-trajectories/natural-retry-recovery.jsonl",
  "artifacts/expected-replay-report/reference-comparison.json",
];

function command(cwd, executable, args, options = {}) {
  const encoding = Object.hasOwn(options, "encoding") ? options.encoding : "utf8";
  return spawnSync(executable, args, {
    cwd,
    encoding,
    windowsHide: true,
    timeout: options.timeout ?? 30_000,
    maxBuffer: 2 * 1024 * 1024,
  });
}

function git(cwd, args, options = {}) {
  const result = command(cwd, "git", args, options);
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  return result.stdout;
}

function autocrlfClone(t) {
  const temporary = mkdtempSync(join(tmpdir(), "rubricdelta-autocrlf-"));
  const seed = join(temporary, "seed");
  const clone = join(temporary, "clone");
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  cpSync(root, seed, {
    recursive: true,
    filter(source) {
      const item = source.slice(root.length).replaceAll("\\", "/");
      return item !== "/.git" && !item.startsWith("/.git/") && !item.startsWith("/.superpowers") && !item.startsWith("/tmp") && !item.startsWith("/artifacts/runs");
    },
  });
  const evaluation = evaluate(seed);
  assert.equal(evaluation.status, 0, `seed evaluation\n${evaluation.stdout}\n${evaluation.stderr}`);
  const evidence = command(seed, process.execPath, ["scripts/generate-evidence.js"], { timeout: 30_000 });
  assert.equal(evidence.status, 0, `seed evidence\n${evidence.stdout}\n${evidence.stderr}`);
  git(seed, ["init", "-b", "main"]);
  git(seed, ["config", "user.name", "RubricDelta Test"]);
  git(seed, ["config", "user.email", "test@rubricdelta.invalid"]);
  git(seed, ["config", "core.autocrlf", "true"]);
  git(seed, ["add", "."]);
  git(seed, ["commit", "-m", "portability fixture"]);
  git(temporary, ["-c", "core.autocrlf=true", "clone", "--no-hardlinks", seed, clone]);
  return clone;
}

function evaluate(clone) {
  return command(clone, process.execPath, ["scripts/evaluate.js", "--mode", "both"], { timeout: 30_000 });
}

function evaluateWithScoringFailure(clone) {
  return command(clone, process.execPath, ["--input-type=module", "--eval", `
    import { readFileSync } from "node:fs";
    import { createEvaluationArtifacts } from "./scripts/evaluation-artifacts.js";
    import { createAdvancedPredictions, createBaselinePredictions, loadBenchmark } from "./src/evaluation/index.js";
    const benchmark = loadBenchmark();
    try {
      createEvaluationArtifacts({
        benchmark,
        benchmarkSource: readFileSync("data/benchmark/benchmark.json", "utf8"),
        mode: "both",
        outputDir: "artifacts/evaluation",
        provider: "deterministic",
        model: null,
        repeats: 1,
        createBaseline: createBaselinePredictions,
        createAdvanced: createAdvancedPredictions,
        score() { throw new Error("intentional scoring failure"); },
      });
      throw new Error("scoring failure was not propagated");
    } catch (error) {
      if (!/scoring failed.*incomplete/i.test(error.message)) throw error;
    }
  `], { timeout: 30_000 });
}

function validate(clone) {
  return command(clone, process.execPath, ["scripts/validate-submission.js", "--mode", "build"], { timeout: 30_000 });
}

function manifest(clone) {
  return JSON.parse(readFileSync(join(clone, "artifacts", "evaluation", "manifest.json"), "utf8"));
}

test("hash-bound benchmark and evidence bytes remain LF in a core.autocrlf=true clone", (t) => {
  const clone = autocrlfClone(t);
  for (const path of hashBoundPaths) {
    const attribute = git(clone, ["check-attr", "eol", "--", path]);
    assert.match(attribute, /: eol: lf\s*$/, path);
    const blob = git(clone, ["show", `HEAD:${path}`], { encoding: null });
    assert.deepEqual(readFileSync(join(clone, ...path.split("/"))), blob, `${path} differs from its canonical Git blob`);
  }
});

test("one evaluation records post-publication managed dirtiness and rejects source dirtiness", (t) => {
  const clone = autocrlfClone(t);
  const revision = git(clone, ["rev-parse", "HEAD"]).trim();

  const firstEvaluation = evaluate(clone);
  assert.equal(firstEvaluation.status, 0, `first evaluation\n${firstEvaluation.stdout}\n${firstEvaluation.stderr}`);
  let state = manifest(clone).git;
  assert.equal(state.revision, revision);
  assert.equal(state.sourceWorkingTreeDirty, false);
  assert.equal(state.sourceTrackedWorkingTreeDirty, false);
  assert.equal(state.sourceUntrackedWorkingTreeDirty, false);
  assert.equal(state.trackedWorkingTreeDirty, true);
  assert.equal(state.managedArtifactDirty, true);
  assert.equal(state.wholeWorkingTreeDirty, true);
  assert.equal(state.sourceState, "clean-source-managed-artifacts-dirty");
  let validation = validate(clone);
  assert.equal(validation.status, 0, `first validation\n${validation.stdout}\n${validation.stderr}`);

  const scoringFailure = evaluateWithScoringFailure(clone);
  assert.equal(scoringFailure.status, 0, `scoring failure\n${scoringFailure.stdout}\n${scoringFailure.stderr}`);
  const incomplete = manifest(clone);
  state = incomplete.git;
  assert.deepEqual(incomplete.execution.failure, { stage: "scoring", code: "SCORING_FAILED" });
  assert.equal(incomplete.execution.status, "incomplete");
  assert.equal(state.revision, revision);
  assert.equal(state.sourceWorkingTreeDirty, false);
  assert.equal(state.sourceTrackedWorkingTreeDirty, false);
  assert.equal(state.sourceUntrackedWorkingTreeDirty, false);
  assert.equal(state.trackedWorkingTreeDirty, true);
  assert.equal(state.managedArtifactDirty, true);
  assert.equal(state.wholeWorkingTreeDirty, true);
  assert.equal(state.sourceState, "clean-source-managed-artifacts-dirty");
  validation = validate(clone);
  assert.notEqual(validation.status, 0);
  assert.match(`${validation.stdout}\n${validation.stderr}`, /manifest\.execution\.status.*complete/i);

  const untracked = join(clone, "untracked-source-task7.txt");
  writeFileSync(untracked, "untracked source change\n", "utf8");
  assert.equal(evaluate(clone).status, 0);
  state = manifest(clone).git;
  assert.equal(state.revision, null);
  assert.equal(state.sourceWorkingTreeDirty, true);
  assert.equal(state.sourceUntrackedWorkingTreeDirty, true);
  validation = validate(clone);
  assert.notEqual(validation.status, 0);
  assert.match(`${validation.stdout}\n${validation.stderr}`, /DIRTY SOURCE: repository.*outside the evidence-only boundary/i);

  rmSync(untracked, { force: true });
  appendFileSync(join(clone, "README.md"), "\ntracked source change\n", "utf8");
  assert.equal(evaluate(clone).status, 0);
  state = manifest(clone).git;
  assert.equal(state.revision, null);
  assert.equal(state.sourceWorkingTreeDirty, true);
  assert.equal(state.sourceTrackedWorkingTreeDirty, true);
  validation = validate(clone);
  assert.notEqual(validation.status, 0);
  assert.match(`${validation.stdout}\n${validation.stderr}`, /DIRTY SOURCE: repository.*outside the evidence-only boundary/i);
});

test("an arbitrary output directory cannot exclude source changes from provenance", (t) => {
  const clone = autocrlfClone(t);
  appendFileSync(join(clone, "src", "evaluation", "advanced.js"), "\n// tracked source change for provenance regression\n", "utf8");
  const evaluation = command(clone, process.execPath, [
    "scripts/evaluate.js",
    "--mode",
    "both",
    "--output-dir",
    "src",
  ], { timeout: 30_000 });
  assert.equal(evaluation.status, 0, `${evaluation.stdout}\n${evaluation.stderr}`);
  const state = JSON.parse(readFileSync(join(clone, "src", "manifest.json"), "utf8")).git;
  assert.equal(state.revision, null);
  assert.equal(state.sourceTrackedWorkingTreeDirty, true);
  assert.equal(state.sourceWorkingTreeDirty, true);
  assert.equal(state.managedArtifactDirty, false);
  assert.equal(state.sourceState, "source-working-tree-dirty");
});

test("validator rejects a forged 40-hex source revision that is not a Git commit", (t) => {
  const clone = autocrlfClone(t);
  const evaluation = evaluate(clone);
  assert.equal(evaluation.status, 0, `${evaluation.stdout}\n${evaluation.stderr}`);
  const manifestPath = join(clone, "artifacts", "evaluation", "manifest.json");
  const value = JSON.parse(readFileSync(manifestPath, "utf8"));
  value.git.revision = "f".repeat(40);
  value.git.baseRevision = value.git.revision;
  writeFileSync(manifestPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  const result = validate(clone);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /manifest\.git\.revision.*(?:resolve|commit|Git object)/i);
});

test("validator rejects a source commit added after the disclosed evidence revision", (t) => {
  const clone = autocrlfClone(t);
  const evaluation = evaluate(clone);
  assert.equal(evaluation.status, 0, `${evaluation.stdout}\n${evaluation.stderr}`);
  git(clone, ["config", "user.name", "RubricDelta Test"]);
  git(clone, ["config", "user.email", "test@rubricdelta.invalid"]);
  appendFileSync(join(clone, "src", "evaluation", "advanced.js"), "\n// committed after evidence source revision\n", "utf8");
  git(clone, ["add", "--", "src/evaluation/advanced.js"]);
  git(clone, ["commit", "-m", "source change after evidence"]);
  const result = validate(clone);
  assert.notEqual(result.status, 0);
  const diagnostic = result.stdout + "\n" + result.stderr;
  assert.match(diagnostic, /manifest\.git\.revision.*source-to-HEAD commits contain non-evidence changes/i);
  assert.doesNotMatch(diagnostic, /bounded fail-closed validator error/i);
});
