import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  main,
  readBoundedReplayBytes,
} from "../scripts/evaluate.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const evaluateScript = join(root, "scripts", "evaluate.js");
const replayFixture = join(root, "data", "benchmark", "replay", "rubricdelta-deterministic-source.v1.json");

function temporary(t, prefix) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function run(args, env = {}) {
  return spawnSync(process.execPath, [evaluateScript, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function json(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

test("OPENAI_API_KEY alone never changes the synchronous deterministic default", (t) => {
  const outputDir = temporary(t, "rubricdelta-task8-default-");
  const command = run(["--mode", "both", "--output-dir", outputDir], {
    OPENAI_API_KEY: "sk-key-must-not-select-a-provider",
  });
  assert.equal(command.status, 0, command.stderr);
  const manifest = json(join(outputDir, "manifest.json"));
  assert.equal(manifest.provider.name, "deterministic");
  assert.equal(manifest.provider.model, null);
  assert.equal(manifest.replay.operational, false);
  assert.equal(manifest.replay.substituted, false);
  assert.equal(json(join(outputDir, "comparison.json")).improvement.absolute, 0.1);
  assert.doesNotMatch(`${command.stdout}\n${command.stderr}`, /sk-key-must-not-select/);
});

test("provider CLI flags are explicit, pinned, and fail closed without required inputs", (t) => {
  const failures = [
    {
      name: "replay fixture required",
      args: ["--provider", "replay", "--mode", "both"],
      pattern: /--replay-fixture.*required|replay fixture.*required/i,
    },
    {
      name: "replay model cannot be substituted",
      args: ["--provider", "replay", "--replay-fixture", replayFixture, "--model", "different"],
      pattern: /--model.*replay|fixture.*model/i,
    },
    {
      name: "deterministic rejects replay fixture",
      args: ["--provider", "deterministic", "--replay-fixture", replayFixture],
      pattern: /--replay-fixture.*deterministic|conflict/i,
    },
    {
      name: "OpenAI rejects replay fixture",
      args: ["--provider", "openai", "--model", "pinned", "--replay-fixture", replayFixture],
      pattern: /--replay-fixture.*openai|conflict/i,
    },
    {
      name: "OpenAI model required",
      args: ["--provider", "openai"],
      pattern: /--model.*required/i,
    },
    {
      name: "OpenAI key required",
      args: ["--provider", "openai", "--model", "pinned", "--output-dir", temporary(t, "rubricdelta-task8-openai-")],
      env: { OPENAI_API_KEY: "" },
      pattern: /OPENAI_API_KEY.*required/i,
    },
    {
      name: "replay repeat binding is exact",
      args: ["--provider", "replay", "--replay-fixture", replayFixture, "--repeats", "2"],
      pattern: /repeat|binding|fixture/i,
    },
  ];

  for (const item of failures) {
    const command = run(item.args, item.env);
    assert.notEqual(command.status, 0, item.name);
    assert.match(command.stderr, item.pattern, item.name);
    if (item.args.includes("--replay-fixture")) {
      assert.doesNotMatch(command.stderr, /unknown argument/i, item.name);
    }
    assert.doesNotMatch(command.stderr, /falling back|substitut(?:e|ed|ion)/i);
  }
});

test("replay CLI derives expected source binding independently and rejects fixture-only hash mutation before scoring", (t) => {
  for (const field of ["aggregate", "per-file"]) {
    const directory = temporary(t, `rubricdelta-task8-binding-${field}-`);
    const mutatedFixture = join(directory, "fixture.json");
    copyFileSync(replayFixture, mutatedFixture);
    const value = json(mutatedFixture);
    if (field === "aggregate") value.binding.source.sha256 = "0".repeat(64);
    else value.binding.source.files[0].sha256 = "0".repeat(64);
    writeFileSync(mutatedFixture, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    const outputDir = join(directory, "output");
    const command = run([
      "--provider", "replay",
      "--replay-fixture", mutatedFixture,
      "--mode", "both",
      "--output-dir", outputDir,
    ]);
    assert.notEqual(command.status, 0, field);
    assert.match(command.stderr, /source.*(?:binding|hash|mismatch)|(?:binding|hash|mismatch).*source/i, field);
    assert.doesNotMatch(command.stderr, /unknown argument/i, field);
    assert.doesNotMatch(command.stderr, /falling back|substitut(?:e|ed|ion)/i);
    assert.equal(existsSync(join(outputDir, "summary.json")), false);
    assert.equal(existsSync(join(outputDir, "comparison.json")), false);
  }
});

test("explicit replay CLI consumes the exact fixture and publishes truthful provenance", (t) => {
  assert.ok(existsSync(replayFixture));
  const outputDir = temporary(t, "rubricdelta-task8-replay-");
  const command = run([
    "--provider", "replay",
    "--replay-fixture", replayFixture,
    "--mode", "both",
    "--repeats", "1",
    "--output-dir", outputDir,
    "--compact",
  ], {
    OPENAI_API_KEY: "sk-key-must-not-affect-replay",
  });
  assert.equal(command.status, 0, command.stderr);
  const summary = JSON.parse(command.stdout);
  const manifest = json(join(outputDir, "manifest.json"));
  const fixture = json(replayFixture);
  assert.equal(summary.provider, "replay");
  assert.equal(summary.model, "deterministic-role-capture-v1");
  assert.equal(summary.repeats, 1);
  assert.equal(summary.replayStatus, "operational");
  assert.deepEqual(manifest.provider, {
    name: "replay",
    model: "deterministic-role-capture-v1",
    seed: 0,
    status: "operational",
  });
  assert.equal(manifest.replay.operational, true);
  assert.equal(manifest.replay.substituted, false);
  assert.equal(manifest.replay.source.kind, "deterministic-role-capture");
  assert.match(manifest.replay.source.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(manifest.replay.binding, fixture.binding);
  assert.deepEqual(manifest.replay.source, fixture.binding.source);
  assert.equal(manifest.replay.fixture.sha256, sha256File(replayFixture));
  assert.equal(manifest.resources.inputTokens, 0);
  assert.equal(manifest.resources.outputTokens, 0);
  assert.equal(manifest.resources.totalTokens, 0);
  assert.equal(manifest.resources.latencyMs, 0);
  assert.equal(manifest.resources.estimatedCostUsd, 0);
  assert.deepEqual(manifest.resources.providerAttempts, { baseline: 10, advanced: 40, total: 50 });
  assert.equal(manifest.resources.providerCalls.total, 50);
  assert.equal(manifest.resources.providerCalls.baseline, 10);
  assert.equal(manifest.resources.providerCalls.advanced, 40);
  assert.equal(manifest.repeats.requested, 1);
  assert.deepEqual(manifest.replay.rawPredictionSha256ByRepetition, {
    "1": {
      baseline: sha256File(join(outputDir, "repetitions", "1", "baseline-predictions.json")),
      advanced: sha256File(join(outputDir, "repetitions", "1", "advanced-predictions.json")),
    },
  });
  assert.equal(json(join(outputDir, "summary.json")).advanced.primaryMetric.mean, 0.9);
  assert.equal(json(join(outputDir, "summary.json")).baseline.primaryMetric.mean, 0.8);
  assert.doesNotMatch(
    readFileSync(join(outputDir, "manifest.json"), "utf8"),
    /sk-key-must-not-affect-replay/,
  );
});

test("replay CLI requires an exact mode binding before any artifact write", (t) => {
  for (const mode of ["baseline", "advanced"]) {
    const outputDir = temporary(t, `rubricdelta-task8-mode-${mode}-`);
    const command = run([
      "--provider", "replay",
      "--replay-fixture", replayFixture,
      "--mode", mode,
      "--output-dir", outputDir,
    ]);
    assert.notEqual(command.status, 0, mode);
    assert.match(command.stderr, /mode.*(?:binding|match)|(?:binding|match).*mode/i, mode);
    assert.doesNotMatch(command.stderr, /unknown argument/i, mode);
    assert.equal(existsSync(join(outputDir, "summary.json")), false, mode);
    assert.equal(existsSync(join(outputDir, "comparison.json")), false, mode);
    assert.doesNotMatch(command.stderr, /falling back|substitut(?:e|ed|ion)/i);
  }
});

test("replay CLI bounds fixture bytes and rejects invalid encoding or JSON before parsing", (t) => {
  const cases = [
    {
      name: "oversize",
      bytes: Buffer.alloc(8 * 1024 * 1024 + 1, 0x20),
      pattern: /byte|size|limit|large/i,
    },
    {
      name: "invalid-utf8",
      bytes: Buffer.from([0xff, 0xfe, 0xfd]),
      pattern: /encoding|utf-?8|fixture|invalid/i,
    },
    {
      name: "invalid-json",
      bytes: Buffer.from('{"opaque-cli-marker-2026":', "utf8"),
      pattern: /json|fixture|invalid/i,
    },
  ];
  for (const item of cases) {
    const directory = temporary(t, `rubricdelta-task8-fixture-${item.name}-`);
    const fixturePath = join(directory, "fixture.json");
    const outputDir = join(directory, "output");
    writeFileSync(fixturePath, item.bytes);
    const command = run([
      "--provider", "replay",
      "--replay-fixture", fixturePath,
      "--mode", "both",
      "--output-dir", outputDir,
    ]);
    assert.notEqual(command.status, 0, item.name);
    assert.match(command.stderr, item.pattern, item.name);
    assert.doesNotMatch(command.stderr, /unknown argument/i, item.name);
    assert.doesNotMatch(command.stderr, /opaque-cli-marker-2026|Unexpected token|position [0-9]+/i, item.name);
    assert.equal(existsSync(join(outputDir, "summary.json")), false, item.name);
  }
});

test("provider CLI rejects duplicate and unknown provider flags", () => {
  const duplicate = run(["--provider", "replay", "--provider", "replay"]);
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /duplicate.*--provider/i);

  const unknown = run(["--providerish", "replay"]);
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /unknown.*--providerish/i);
});

test("package replay commands are fixed operational commands", () => {
  const packageJson = json(join(root, "package.json"));
  assert.equal(packageJson.scripts["replay:check"], "node scripts/capture-replay.js --check");
  assert.equal(
    packageJson.scripts["eval:replay"],
    "node scripts/evaluate.js --provider replay --replay-fixture data/benchmark/replay/rubricdelta-deterministic-source.v1.json --mode both --repeats 1 --output-dir artifacts/runs/provider-replay",
  );
});

test("main preserves synchronous deterministic and legacy behavior while explicit providers are async", async (t) => {
  t.mock.method(process.stdout, "write", () => true);

  const deterministicOutput = temporary(t, "rubricdelta-task8-main-deterministic-");
  const deterministic = main(["--mode", "both", "--output-dir", deterministicOutput]);
  assert.equal(deterministic, undefined);
  assert.equal(json(join(deterministicOutput, "comparison.json")).improvement.absolute, 0.1);

  const legacy = main(["--baseline", "--summary-only", "--compact"]);
  assert.equal(legacy, undefined);
  assert.throws(() => main(["--mode", "invalid"]), /--mode.*baseline.*advanced.*both/i);

  const replayOutput = temporary(t, "rubricdelta-task8-main-replay-");
  const replay = main([
    "--provider", "replay",
    "--replay-fixture", replayFixture,
    "--mode", "both",
    "--repeats", "1",
    "--output-dir", replayOutput,
  ]);
  assert.equal(typeof replay?.then, "function");
  await replay;
  assert.equal(json(join(replayOutput, "manifest.json")).provider.name, "replay");
});

test("replay fixture loader caps an after-stat growth race before allocation or parsing", () => {
  let remaining = 8 * 1024 * 1024 + 1;
  let largestRequestedRead = 0;
  let readCalls = 0;
  let closeCalls = 0;
  assert.throws(() => readBoundedReplayBytes("ignored-by-injected-io", {
    openSync: () => 42,
    fstatSync: () => ({ isFile: () => true, size: 1 }),
    readSync(_fd, buffer, offset, length) {
      readCalls += 1;
      largestRequestedRead = Math.max(largestRequestedRead, length);
      const amount = Math.min(length, remaining);
      buffer.fill(0x20, offset, offset + amount);
      remaining -= amount;
      return amount;
    },
    closeSync() {
      closeCalls += 1;
    },
  }), /byte|size|limit|large|8 MiB/i);
  assert.ok(readCalls > 0);
  assert.ok(largestRequestedRead <= 8 * 1024 * 1024 + 1);
  assert.equal(closeCalls, 1);

  const source = readFileSync(evaluateScript, "utf8");
  const start = source.indexOf("export function readBoundedReplayBytes");
  const end = source.indexOf("function readReplayFixture", start);
  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(source.slice(start, end), /readFileSync\s*\(/);
});
