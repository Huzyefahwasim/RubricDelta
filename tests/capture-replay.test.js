import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  generateReplayFixture,
  publishReplayFixture,
} from "../scripts/capture-replay.js";
import { promptRegistryBinding } from "../src/agents/prompt-registry.js";
import { canonicalJson, hashProviderRequest } from "../src/providers/contracts.js";
import { loadBenchmark } from "../src/evaluation/index.js";
import { EVALUATION_PROTOCOL } from "../src/evaluation/protocol.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const captureScript = join(root, "scripts", "capture-replay.js");
const fixturePath = join(root, "data", "benchmark", "replay", "rubricdelta-deterministic-source.v1.json");
const ADVANCED_ROLES = [
  "rule-compiler",
  "change-analyst",
  "impact-investigator",
  "independent-verifier",
];
const REQUIRED_SOURCE_FILES = [
  "scripts/capture-replay.js",
  "src/agents/contracts.js",
  "src/agents/impact-investigator.js",
  "src/agents/policy-analyst.js",
  "src/agents/prompt-registry.js",
  "src/agents/provider-schemas.js",
  "src/agents/provider-trace.js",
  "src/agents/provider-validation.js",
  "src/agents/provider-workflow.js",
  "src/agents/verifier.js",
  "src/domain/rules.js",
  "src/domain/scenario.js",
  "src/domain/semantics.js",
  "src/domain/text.js",
  "src/domain/validation.js",
  "src/evaluation/baseline.js",
  "src/evaluation/benchmark.js",
  "src/evaluation/evidence-hash.js",
  "src/evaluation/protocol.js",
  "src/evaluation/provider-predictions.js",
  "src/providers/contracts.js",
].sort();

function temporary(t, prefix) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function run(args) {
  return spawnSync(process.execPath, [captureScript, ...args], {
    cwd: root,
    encoding: "utf8",
  });
}

function parse(path = fixturePath) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function canonicalLfSource(path) {
  return readFileSync(join(root, ...path.split("/")), "utf8")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n");
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

test("capture generator emits the exact 10 baseline then 40 case-major advanced calls", async () => {
  const fixture = await generateReplayFixture();
  const benchmark = loadBenchmark();
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.artifactKind, "rubricdelta-exact-provider-replay");
  assert.equal(fixture.binding.benchmark.id, benchmark.benchmarkId);
  assert.deepEqual(fixture.binding.benchmark.orderedCaseIds, benchmark.cases.map((item) => item.id));
  assert.deepEqual(
    fixture.binding.benchmark.orderedRecordIdsByCase,
    Object.fromEntries(benchmark.cases.map((item) => [item.id, item.records.map((record) => record.id)])),
  );
  assert.deepEqual(fixture.binding.prompts, promptRegistryBinding());
  assert.equal(fixture.binding.mode, "both");
  assert.equal(fixture.binding.repeats, 1);
  assert.equal(fixture.binding.model, "deterministic-role-capture-v1");
  assert.deepEqual(fixture.binding.protocol, structuredClone(EVALUATION_PROTOCOL));
  assert.equal(fixture.binding.source.kind, "deterministic-role-capture");
  assert.match(fixture.binding.source.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(fixture.binding.source.files.map((item) => item.path).sort(), REQUIRED_SOURCE_FILES);
  assert.equal(fixture.binding.source.sha256Canonicalization, "utf8-lf");
  const expectedSourceFiles = REQUIRED_SOURCE_FILES.map((path) => ({
    path,
    sha256: sha256(canonicalLfSource(path)),
  }));
  assert.deepEqual(fixture.binding.source.files, expectedSourceFiles);
  assert.equal(fixture.binding.source.sha256, sha256(canonicalJson(expectedSourceFiles)));
  assert.ok(fixture.binding.source.files.every((item) => !item.path.includes("\\") && /^[a-f0-9]{64}$/.test(item.sha256)));
  const attributes = readFileSync(join(root, ".gitattributes"), "utf8");
  assert.match(attributes, /\/prompts\/\*\.md\s+text\s+eol=lf/);
  assert.match(attributes, /\/data\/benchmark\/replay\/\*\.json\s+text\s+eol=lf/);

  assert.equal(fixture.entries.length, 50);
  assert.deepEqual(fixture.entries.map((entry) => entry.sequence), Array.from({ length: 50 }, (_, index) => index + 1));
  assert.deepEqual(
    fixture.entries.slice(0, 10).map((entry) => [entry.request.caseId, entry.request.role, entry.request.mode]),
    benchmark.cases.map((item) => [item.id, "direct-baseline", "baseline"]),
  );
  assert.deepEqual(
    fixture.entries.slice(10).map((entry) => [entry.request.caseId, entry.request.role, entry.request.mode]),
    benchmark.cases.flatMap((item) => ADVANCED_ROLES.map((role) => [item.id, role, "advanced"])),
  );

  for (const [index, entry] of fixture.entries.entries()) {
    assert.equal(entry.requestHash, hashProviderRequest(entry.request));
    assert.equal(entry.result.responseId, `deterministic-capture-${String(index + 1).padStart(4, "0")}`);
    assert.deepEqual(entry.result.usage, { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    assert.equal(entry.result.model, "deterministic-role-capture-v1");
    assert.equal(entry.result.latencyMs, 0);
    assert.equal(entry.result.transportAttempts, 1);
    assert.deepEqual(entry.result.attempts, [{ attempt: 1, outcome: "deterministic-capture" }]);
    assert.equal(entry.result.estimatedCostUsd, 0);
  }
  assert.equal(canonicalJson(fixture), canonicalJson(parse()));
});

test("capture --check regenerates in memory and never writes the committed fixture", () => {
  const before = readFileSync(fixturePath);
  const beforeStat = statSync(fixturePath);
  const command = run(["--check"]);
  assert.equal(command.status, 0, command.stderr);
  assert.deepEqual(readFileSync(fixturePath), before);
  assert.equal(statSync(fixturePath).mtimeMs, beforeStat.mtimeMs);
});

test("capture --check detects every bound mutation and byte-only drift", async (t) => {
  const mutations = [
    ["prompt", (value) => { value.binding.prompts["rule-compiler"].sha256 = "0".repeat(64); }],
    ["source", (value) => { value.binding.source.files[0].sha256 = "0".repeat(64); }],
    ["binding", (value) => { value.binding.model = "substituted-model"; }],
    ["request", (value) => { value.entries[0].request.inputRefs = ["mutated"]; }],
    ["result", (value) => { value.entries[0].result.data.ranking.reverse(); }],
    ["sequence", (value) => { value.entries[0].sequence = 2; }],
  ];

  for (const [name, mutate] of mutations) {
    const path = join(temporary(t, `rubricdelta-capture-${name}-`), "fixture.json");
    const value = structuredClone(await generateReplayFixture());
    mutate(value);
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    const command = run(["--check", "--fixture", path]);
    assert.notEqual(command.status, 0, name);
    assert.match(command.stderr, /capture|fixture|mismatch|binding|invalid|different/i, name);
  }

  const bytePath = join(temporary(t, "rubricdelta-capture-byte-"), "fixture.json");
  copyFileSync(fixturePath, bytePath);
  writeFileSync(bytePath, `${readFileSync(bytePath, "utf8")} \n`, "utf8");
  const byteCommand = run(["--check", "--fixture", bytePath]);
  assert.notEqual(byteCommand.status, 0);
  assert.match(byteCommand.stderr, /byte|different|mismatch/i);
});

test("capture --check detects drift in deep domain and split provider dependencies", (t) => {
  for (const relativePath of [
    ["src", "domain", "text.js"],
    ["src", "agents", "provider-validation.js"],
  ]) {
    const copyRoot = join(temporary(t, "rubricdelta-capture-closure-"), "repo");
    cpSync(root, copyRoot, {
      recursive: true,
      filter(path) {
        const relative = path.slice(root.length).replaceAll("\\", "/");
        return !relative.startsWith("/.git")
          && !relative.startsWith("/.superpowers")
          && !relative.startsWith("/tmp")
          && !relative.startsWith("/artifacts/tmp");
      },
    });
    appendFileSync(join(copyRoot, ...relativePath), "\n// deep dependency drift\n", "utf8");
    const command = spawnSync(process.execPath, [
      join(copyRoot, "scripts", "capture-replay.js"),
      "--check",
    ], {
      cwd: copyRoot,
      encoding: "utf8",
    });
    assert.notEqual(command.status, 0, relativePath.join("/"));
    assert.match(command.stderr, /source|hash|capture|fixture|different|mismatch/i);
  }
});

test("capture check bounds fixture bytes before parsing", (t) => {
  const path = join(temporary(t, "rubricdelta-capture-oversize-"), "fixture.json");
  writeFileSync(path, " ".repeat(8 * 1024 * 1024 + 1), "utf8");
  const command = run(["--check", "--fixture", path]);
  assert.notEqual(command.status, 0);
  assert.match(command.stderr, /byte|size|limit|large/i);
  assert.doesNotMatch(command.stderr, /Unexpected end of JSON input|position [0-9]+/i);
});

test("capture publication is flushed and atomic and preserves the old fixture on failure", (t) => {
  const directory = temporary(t, "rubricdelta-capture-publish-");
  const path = join(directory, "fixture.json");
  const oldBytes = Buffer.from("old-fixture-bytes\n", "utf8");
  const newBytes = Buffer.from("new-fixture-bytes\n", "utf8");
  writeFileSync(path, oldBytes);

  let observedWriteOptions = null;
  assert.throws(() => publishReplayFixture(path, newBytes, {
    randomId: () => "forced-write-failure",
    writeFileSync(tempPath, bytes, options) {
      observedWriteOptions = structuredClone(options);
      writeFileSync(tempPath, bytes, options);
      throw new Error("forced durable write failure");
    },
  }), /write|publication|failed/i);
  assert.deepEqual(readFileSync(path), oldBytes);
  assert.deepEqual(observedWriteOptions, { flag: "wx", flush: true });
  assert.deepEqual(readdirSync(directory), ["fixture.json"]);

  assert.throws(() => publishReplayFixture(path, newBytes, {
    randomId: () => "forced-rename-failure",
    renameSync() {
      throw new Error("forced atomic rename failure");
    },
  }), /rename|publication|failed/i);
  assert.deepEqual(readFileSync(path), oldBytes);
  assert.deepEqual(readdirSync(directory), ["fixture.json"]);

  publishReplayFixture(path, newBytes, { randomId: () => "success" });
  assert.deepEqual(readFileSync(path), newBytes);
  assert.deepEqual(readdirSync(directory), ["fixture.json"]);
});

test("capture publication rejects a linked fixture target before truncation", (t) => {
  const directory = temporary(t, "rubricdelta-capture-link-target-");
  const realDirectory = join(directory, "real-target");
  const linkedPath = join(directory, "fixture.json");
  const sentinelPath = join(realDirectory, "sentinel.json");
  const sentinel = Buffer.from("sentinel-target-bytes\n", "utf8");
  mkdirSync(realDirectory);
  writeFileSync(sentinelPath, sentinel);
  try {
    symlinkSync(realDirectory, linkedPath, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("Directory junctions are unavailable on this Windows host");
      return;
    }
    throw error;
  }

  assert.throws(
    () => publishReplayFixture(linkedPath, Buffer.from("attacker-bytes\n", "utf8")),
    /link|junction|reparse|unsafe/i,
  );
  assert.deepEqual(readFileSync(sentinelPath), sentinel);
});

test("capture publication rejects a linked ancestor before any write", (t) => {
  const directory = temporary(t, "rubricdelta-capture-link-ancestor-");
  const outside = join(directory, "outside");
  const linkedDirectory = join(directory, "linked");
  mkdirSync(outside);
  try {
    symlinkSync(outside, linkedDirectory, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("Directory junctions are unavailable on this Windows host");
      return;
    }
    throw error;
  }

  const escapedPath = join(linkedDirectory, "fixture.json");
  assert.throws(
    () => publishReplayFixture(escapedPath, Buffer.from("attacker-bytes\n", "utf8")),
    /link|junction|reparse|unsafe/i,
  );
  assert.equal(existsSync(join(outside, "fixture.json")), false);
});
