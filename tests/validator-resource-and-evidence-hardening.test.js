import assert from "node:assert/strict";
import {
  cpSync,
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
const validator = join(root, "scripts", "validate-submission.js");
const source = readFileSync(validator, "utf8");

function fixture(t) {
  const destination = join(mkdtempSync(join(tmpdir(), "rubricdelta-resource-validator-")), "repo");
  t.after(() => rmSync(dirname(destination), { recursive: true, force: true }));
  cpSync(root, destination, {
    recursive: true,
    filter(path) {
      const relative = path.slice(root.length).replaceAll("\\", "/");
      return !relative.startsWith("/.git")
        && !relative.startsWith("/.superpowers")
        && !relative.startsWith("/tmp")
        && !relative.startsWith("/artifacts/runs");
    },
  });
  return destination;
}

function run(project) {
  return spawnSync(process.execPath, [validator, "--mode", "build", "--root", project], {
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

test("deterministic evidence rejects any nonzero provider call, token, or cost claim", (t) => {
  const project = fixture(t);
  const path = join(project, "artifacts", "evaluation", "manifest.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  manifest.resources.providerCalls.total = 1;
  manifest.resources.providerAttempts = { baseline: 0, advanced: 1, total: 1 };
  manifest.resources.inputTokens = 1;
  manifest.resources.totalTokens = 1;
  manifest.resources.latencyMs = 1;
  manifest.resources.estimatedCostUsd = 0.01;
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const command = run(project);
  const combined = `${command.stdout ?? ""}\n${command.stderr ?? ""}`;
  assert.notEqual(command.status, 0, combined);
  assert.match(combined, /\[FAIL\].*manifest\.resources.*exact zero.*provider calls.*attempts.*tokens.*latency.*cost/i);
});

test("human undo and development exports carry structural identity contracts", () => {
  assert.match(source, /decisionStacks/);
  assert.match(source, /target\.sequence\s*!==\s*event\.undoneSequence/);
  assert.match(source, /event\.restoredDecision\s*!==\s*restoredDecision/);
  for (const contract of [
    /event\.schemaVersion\s*!==\s*1/,
    /event\.sequence\s*!==\s*index\s*\+\s*1/,
    /RFC3339_TIMESTAMP/,
    /event\?\.source|event\.source/,
    /developmentEventPayloadIsSubstantive/,
  ]) assert.match(source, contract);
});

test("successful scan and package diagnostics cannot mask secret or no-op failures", () => {
  assert.doesNotMatch(source, /isolated replay artifacts contain no credential-like values/i);
  assert.match(source, /must exactly equal the fixed offline replay checker/);
  assert.match(source, /must exactly equal the fixed offline replay evaluation command/);
  assert.match(source, /stale replay disclosure; regenerate exact not-selected/i);
});
