import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createAdvancedPredictions, createBaselinePredictions, evaluatePredictions, loadBenchmark } from "../src/evaluation/index.js";
import { createEvaluationArtifacts, createPublicBenchmarkProjection } from "../scripts/evaluate.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scripts = Object.fromEntries(["evaluate", "generate-evidence", "validate-submission"].map((name) => [name, join(root, "scripts", `${name}.js`)]));
const forbiddenGold = /groundTruth|affectedRecordIds|expectedLabels|rationales/i;

function temp(t, prefix) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function run(script, args) {
  return spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8", env: { ...process.env } });
}

function json(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function jsonl(path) {
  const source = readFileSync(path, "utf8");
  assert.ok(source.endsWith("\n"), `${path} needs trailing newline`);
  return source.trimEnd().split("\n").map((line) => JSON.parse(line));
}

function complete(benchmark, predictions) {
  assert.deepEqual(predictions.cases.map((item) => item.caseId), benchmark.cases.map((item) => item.id));
  for (let index = 0; index < benchmark.cases.length; index += 1) {
    assert.deepEqual(
      [...predictions.cases[index].rankedRecordIds].sort(),
      benchmark.cases[index].records.map((record) => record.id).sort(),
    );
  }
}

function normalizedArtifact(file, source) {
  if (file === "manifest.json") {
    const value = JSON.parse(source);
    value.execution = { startedAt: "<volatile>", endedAt: "<volatile>", runtimeMs: "<volatile>" };
    value.git.revision = "<volatile>";
    value.git.baseRevision = "<volatile>";
    return JSON.stringify(value);
  }
  if (file === "report.md") {
    return source.replace(/^- Started: .*$/m, "- Started: <volatile>")
      .replace(/^- Ended: .*$/m, "- Ended: <volatile>")
      .replace(/^- Wall-clock artifact run: .*$/m, "- Wall-clock artifact run: <volatile>");
  }
  if (file === "advanced-predictions.json" || file.endsWith(".jsonl")) {
    return source.replace(/"timestamp":\s*"[^"]+"/g, '"timestamp":"<volatile>"');
  }
  return source;
}

function validationFixture(t) {
  const fixture = join(temp(t, "rubricdelta-validator-"), "repo");
  cpSync(root, fixture, {
    recursive: true,
    filter(source) {
      const item = source.slice(root.length).replaceAll("\\", "/");
      return !item.startsWith("/.git") && !item.startsWith("/.superpowers") && !item.startsWith("/tmp");
    },
  });
  return fixture;
}

test("raw gold-free predictions are durable before evaluator scoring", (t) => {
  const benchmark = loadBenchmark();
  const outputDir = temp(t, "rubricdelta-boundary-");
  const projection = createPublicBenchmarkProjection(benchmark);
  assert.ok(Object.isFrozen(projection));
  assert.ok(projection.cases.every((item) => Object.isFrozen(item)));
  assert.notEqual(projection.cases, benchmark.cases);
  assert.doesNotMatch(JSON.stringify(projection), forbiddenGold);
  const seen = [];
  let scoreCalls = 0;
  const result = createEvaluationArtifacts({
    benchmark, mode: "both", outputDir, provider: "deterministic", model: null, repeats: 1,
    createBaseline(input) { seen.push(input); return createBaselinePredictions(input); },
    createAdvanced(input, options) { seen.push(input); return createAdvancedPredictions(input, options); },
    score(gold, predictions) {
      assert.ok(existsSync(join(outputDir, "baseline-predictions.json")));
      assert.ok(existsSync(join(outputDir, "advanced-predictions.json")));
      scoreCalls += 1;
      return evaluatePredictions(gold, predictions);
    },
  });
  assert.equal(scoreCalls, 2);
  assert.ok(seen.every((input) => input !== benchmark && !forbiddenGold.test(JSON.stringify(input))));
  assert.equal(result.comparison.baseline.primaryMetric.value, 0.8);
  assert.equal(result.comparison.advanced.primaryMetric.value, 0.9);
});

test("paired CLI writes fair complete artifacts, exact improvement, hard case, and ten role-complete traces", (t) => {
  const output = temp(t, "rubricdelta-eval-");
  const command = run(scripts.evaluate, ["--mode", "both", "--output-dir", output]);
  assert.equal(command.status, 0, command.stderr);
  for (const file of ["manifest.json", "baseline-predictions.json", "advanced-predictions.json", "comparison.json", "report.md"]) assert.ok(existsSync(join(output, file)));
  const benchmark = loadBenchmark();
  const manifest = json(join(output, "manifest.json"));
  const baseline = json(join(output, "baseline-predictions.json"));
  const advanced = json(join(output, "advanced-predictions.json"));
  const comparison = json(join(output, "comparison.json"));
  assert.doesNotMatch(JSON.stringify(baseline), forbiddenGold);
  assert.doesNotMatch(JSON.stringify(advanced), forbiddenGold);
  complete(benchmark, baseline);
  complete(benchmark, advanced);
  assert.equal(manifest.benchmark.id, "rubricdelta-support-guideline-drift-v1");
  assert.equal(manifest.benchmark.schemaVersion, "1.0.0");
  assert.match(manifest.benchmark.sha256, /^[a-f0-9]{64}$/);
  assert.equal(manifest.benchmark.sha256Canonicalization, "utf8-lf");
  assert.deepEqual(manifest.benchmark.orderedCaseIds, benchmark.cases.map((item) => item.id));
  assert.deepEqual(manifest.benchmark.orderedRecordIdsByCase, Object.fromEntries(benchmark.cases.map((item) => [item.id, item.records.map((record) => record.id)])));
  assert.deepEqual(manifest.provider, { name: "deterministic", model: null, seed: 0, status: "operational" });
  assert.equal(manifest.reviewBudget.fraction, 0.2);
  assert.ok(Object.values(manifest.reviewBudget.slotsByCase).every((slots) => slots === 2));
  assert.deepEqual(manifest.resources.providerCalls, { baseline: 0, advanced: 0, total: 0 });
  assert.match(manifest.execution.startedAt, /^2026-/);
  assert.match(manifest.execution.endedAt, /^2026-/);
  assert.ok(manifest.execution.runtimeMs >= 0);
  assert.equal(manifest.execution.status, "complete");
  assert.equal(manifest.replay.status, "deferred-task-8");
  assert.equal(manifest.replay.substituted, false);
  assert.deepEqual(comparison.improvement, {
    metric: "microAffectedRecallAtReviewBudget",
    baseline: { numerator: 16, denominator: 20, value: 0.8 },
    advanced: { numerator: 18, denominator: 20, value: 0.9 },
    absolute: 0.1,
    relative: 0.125,
  });
  assert.equal(comparison.baseline.perCase.length, 10);
  assert.equal(comparison.advanced.perCase.length, 10);
  assert.equal(comparison.hardCase.caseId, "fraud-overrides-refunds");
  const report = readFileSync(join(output, "report.md"), "utf8");
  for (const item of benchmark.cases) assert.match(report, new RegExp(item.id));
  assert.match(report, /hard precedence case/i);
  assert.match(report, /baseline-predictions\.json/);
  assert.match(report, /advanced-predictions\.json/);
  assert.doesNotMatch(report, /[ \t]+$/m);
  assert.match(report, /[^\n]\n$/);
  const files = readdirSync(join(output, "trajectories")).sort();
  assert.deepEqual(files, benchmark.cases.map((item) => `${item.id}.jsonl`).sort());
  for (const item of benchmark.cases) {
    const events = jsonl(join(output, "trajectories", `${item.id}.jsonl`));
    assert.deepEqual(events.map((event) => event.sequence), events.map((_, index) => index + 1));
    const roles = new Set(events.map((event) => event.agent));
    for (const role of ["rule-compiler", "change-analyst", "impact-investigator", "skeptical-verifier", "orchestrator"]) assert.ok(roles.has(role), `${item.id}: ${role}`);
  }
});

test("only declared volatile fields differ across deterministic repeats; equals, spaced, legacy, and rejection paths are honest", (t) => {
  const first = temp(t, "rubricdelta-repeat-a-");
  const second = temp(t, "rubricdelta-repeat-b-");
  const spaced = run(scripts.evaluate, ["--mode", "both", "--output-dir", first, "--provider", "deterministic", "--repeats", "2"]);
  const equals = run(scripts.evaluate, [`--mode=both`, `--output-dir=${second}`, "--provider=deterministic", "--repeats=2"]);
  assert.equal(spaced.status, 0, spaced.stderr);
  assert.equal(equals.status, 0, equals.stderr);
  for (const file of ["manifest.json", "baseline-predictions.json", "advanced-predictions.json", "comparison.json", "report.md"]) {
    assert.equal(normalizedArtifact(file, readFileSync(join(first, file), "utf8")), normalizedArtifact(file, readFileSync(join(second, file), "utf8")), file);
  }
  for (const file of readdirSync(join(first, "trajectories"))) {
    assert.equal(normalizedArtifact(file, readFileSync(join(first, "trajectories", file), "utf8")), normalizedArtifact(file, readFileSync(join(second, "trajectories", file), "utf8")), file);
  }
  assert.deepEqual(json(join(first, "manifest.json")).repeats, { requested: 2, normalizedIdentically: true });
  assert.equal(run(scripts.evaluate, ["--mode=baseline", `--output-dir=${temp(t, "rubricdelta-base-")}`]).status, 0);
  assert.equal(run(scripts.evaluate, ["--mode", "advanced", "--output-dir", temp(t, "rubricdelta-advanced-")]).status, 0);
  const legacy = run(scripts.evaluate, ["--baseline", "--summary-only", "--compact"]);
  assert.equal(legacy.status, 0, legacy.stderr);
  assert.equal(JSON.parse(legacy.stdout).primaryMetric.value, 0.8);
  assert.equal(Object.hasOwn(JSON.parse(legacy.stdout), "perCase"), false);
  const predictions = run(scripts.evaluate, ["--predictions", join(first, "advanced-predictions.json"), "--compact"]);
  assert.equal(predictions.status, 0, predictions.stderr);
  assert.equal(JSON.parse(predictions.stdout).primaryMetric.value, 0.9);
  for (const [args, pattern] of [
    [["--mode", "bad"], /--mode.*baseline.*advanced.*both/i],
    [["--mode", "both", "--repeats", "0"], /--repeats.*positive integer/i],
    [["--baseline", "--mode", "baseline"], /conflict/i],
    [["--mode", "both", "--provider", "deterministic", "--model", "x"], /--model.*deterministic/i],
    [["--mode", "both", "--provider", "replay"], /replay.*unavailable.*Task 8/i],
    [["--mode", "both", "--provider", "openai", "--model", "pinned"], /openai.*unavailable.*Task 8/i],
  ]) {
    const failed = run(scripts.evaluate, args);
    assert.notEqual(failed.status, 0, args.join(" "));
    assert.match(failed.stderr, pattern);
    assert.doesNotMatch(failed.stderr, /falling back|substitut/i);
  }
});

test("evidence generator captures real workflow/server branches and a hash-bound replay reference", (t) => {
  const evaluation = temp(t, "rubricdelta-evidence-eval-");
  const representative = temp(t, "rubricdelta-evidence-traces-");
  const replay = temp(t, "rubricdelta-evidence-replay-");
  assert.equal(run(scripts.evaluate, ["--mode", "both", "--output-dir", evaluation]).status, 0);
  const command = run(scripts["generate-evidence"], ["--evaluation-dir", evaluation, "--output-dir", representative, "--expected-replay-dir", replay]);
  assert.equal(command.status, 0, command.stderr);
  const disagreement = jsonl(join(representative, "success-verifier-disagreement.jsonl"));
  assert.ok(disagreement.some((event) => event.agent === "skeptical-verifier" && event.payload?.verdict === "support"));
  assert.ok(disagreement.some((event) => event.agent === "skeptical-verifier" && event.payload?.verdict === "reject"));
  const retry = jsonl(join(representative, "natural-retry-recovery.jsonl"));
  assert.ok(retry.some((event) => event.type === "retry") && retry.some((event) => event.type === "escalation") && retry.some((event) => event.payload?.recovered === true));
  assert.ok(jsonl(join(representative, "uncertain-abstention.jsonl")).some((event) => event.agent === "skeptical-verifier" && event.payload?.verdict === "uncertain"));
  assert.ok(jsonl(join(representative, "human-checkpoint.jsonl")).some((event) => event.agent === "human-reviewer" && event.type === "human-decision" && event.payload?.reviewer === "hackathon-evidence-generator"));
  const reference = json(join(replay, "reference-comparison.json"));
  assert.equal(reference.status, "expected-reference-only-task-7");
  assert.equal(reference.replayOperational, false);
  assert.equal(reference.baseline.primaryMetric.value, 0.8);
  assert.equal(reference.advanced.primaryMetric.value, 0.9);
  assert.match(reference.artifacts.baselinePredictionsSha256, /^[a-f0-9]{64}$/);
  assert.match(reference.artifacts.advancedPredictionsSha256, /^[a-f0-9]{64}$/);
});

test("build validator is explicitly NON-FINAL/pass and final-strict fails on named Task 8/9 gates", () => {
  const build = run(scripts["validate-submission"], ["--mode", "build", "--root", root]);
  assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);
  assert.ok(build.stdout.startsWith("MODE: BUILD — NON-FINAL\n"));
  assert.match(build.stdout, /PASS: build validation/i);
  assert.match(build.stdout, /DEFERRED \(Task 8\)/);
  assert.match(build.stdout, /DEFERRED \(Task 9\)/);
  assert.doesNotMatch(build.stdout, /eligible|submission ready|fully ready/i);
  const strict = run(scripts["validate-submission"], ["--mode=final-strict", `--root=${root}`]);
  assert.notEqual(strict.status, 0);
  assert.ok(strict.stdout.startsWith("MODE: FINAL-STRICT\n"));
  assert.match(strict.stdout, /prompts\/rule-compiler\.v1\.md/);
  assert.match(strict.stdout, /docs\/MAIN_FAILURE_MODE\.md/);
  assert.match(strict.stdout, /video/i);
});

test("build validator rejects an incomplete evaluation manifest", (t) => {
  const fixture = validationFixture(t);
  const manifestPath = join(fixture, "artifacts", "evaluation", "manifest.json");
  const manifest = json(manifestPath);
  manifest.execution.status = "incomplete";
  manifest.execution.failure = { stage: "scoring", code: "SCORING_FAILED" };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const command = run(scripts["validate-submission"], ["--mode", "build", "--root", fixture]);
  assert.notEqual(command.status, 0);
  assert.match(`${command.stdout}\n${command.stderr}`, /manifest\.execution\.status.*complete/i);
});

test("validator reports missing, malformed JSON/JSONL, hash mismatch, and secret evidence without echoing it", (t) => {
  const fixture = validationFixture(t);
  unlinkSync(join(fixture, "artifacts", "evaluation", "manifest.json"));
  writeFileSync(join(fixture, "artifacts", "evaluation", "comparison.json"), "{not-json\n", "utf8");
  appendFileSync(join(fixture, "artifacts", "representative-trajectories", "natural-retry-recovery.jsonl"), "not-json\n", "utf8");
  appendFileSync(join(fixture, "artifacts", "representative-trajectories", "human-checkpoint.jsonl"), `${JSON.stringify({ apiKey: "sk-should-never-appear" })}\n`, "utf8");
  const replayPath = join(fixture, "artifacts", "expected-replay-report", "reference-comparison.json");
  const replay = json(replayPath);
  replay.artifacts.baselinePredictionsSha256 = "0".repeat(64);
  writeFileSync(replayPath, `${JSON.stringify(replay, null, 2)}\n`, "utf8");
  const command = run(scripts["validate-submission"], ["--mode", "build", "--root", fixture]);
  assert.notEqual(command.status, 0);
  const output = `${command.stdout}\n${command.stderr}`;
  assert.match(output, /MISSING.*artifacts\/evaluation\/manifest\.json/i);
  assert.match(output, /INVALID JSON.*comparison\.json/i);
  assert.match(output, /INVALID JSONL.*natural-retry-recovery\.jsonl/i);
  assert.match(output, /SECRET.*human-checkpoint\.jsonl/i);
  assert.match(output, /MISMATCH.*baselinePredictionsSha256/i);
  assert.doesNotMatch(output, /sk-should-never-appear/);
});
