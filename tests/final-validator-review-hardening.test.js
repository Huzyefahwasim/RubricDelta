import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
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

function fixture(t) {
  const destination = join(mkdtempSync(join(tmpdir(), "rubricdelta-review-validator-")), "repo");
  t.after(() => rmSync(dirname(destination), { recursive: true, force: true }));
  cpSync(root, destination, {
    recursive: true,
    filter(source) {
      const relative = source.slice(root.length).replaceAll("\\", "/");
      return !relative.startsWith("/.git")
        && !relative.startsWith("/.superpowers")
        && !relative.startsWith("/tmp")
        && !relative.startsWith("/artifacts/runs");
    },
  });
  return destination;
}

function write(project, relativePath, value) {
  const path = join(project, ...relativePath.split("/"));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

function writeJson(project, relativePath, value) {
  write(project, relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function run(project) {
  return spawnSync(process.execPath, [validator, "--mode", "final-strict", "--root", project], {
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

function output(command) {
  return `${command.stdout ?? ""}\n${command.stderr ?? ""}`;
}

function failLines(command) {
  return output(command).split(/\r?\n/).filter((line) => line.startsWith("[FAIL]")).join("\n");
}

test("human undo restores the prior decision and exactly binds undo trajectory fields", (t) => {
  const project = fixture(t);
  const reviewer = "owner-reviewer";
  const ledger = [
    { sequence: 1, trajectorySequence: 1, timestamp: "2026-08-30T00:00:00.000Z", reviewer, recordId: "fraud-03", decision: "approve" },
    { sequence: 2, trajectorySequence: 2, timestamp: "2026-08-30T00:00:01.000Z", reviewer, recordId: "fraud-03", decision: "reject" },
    { sequence: 3, trajectorySequence: 3, timestamp: "2026-08-30T00:00:02.000Z", reviewer, recordId: "fraud-03", action: "undo", undoneSequence: 2, restoredDecision: "escalate", reason: "owner undo" },
    { sequence: 4, trajectorySequence: 4, timestamp: "2026-08-30T00:00:03.000Z", reviewer, recordId: "fraud-05", decision: "escalate" },
  ];
  const trajectory = ledger.map((item) => ({
    runId: "owner-review-run",
    scenarioId: "fraud-overrides-refunds",
    sequence: item.trajectorySequence,
    timestamp: item.timestamp,
    agent: "human-reviewer",
    phase: "human-checkpoint",
    type: item.action === "undo" ? "human-undo" : "human-decision",
    payload: {
      reviewer,
      recordId: item.recordId,
      timestamp: item.timestamp,
      ...(item.action === "undo"
        ? { type: "undo", undoneSequence: item.undoneSequence, restoredDecision: item.restoredDecision, reason: item.reason }
        : { type: "decision", decision: item.decision }),
    },
  }));
  const ledgerBytes = Buffer.from(`${ledger.map((item) => JSON.stringify(item)).join("\n")}\n`);
  const trajectoryBytes = Buffer.from(`${trajectory.map((item) => JSON.stringify(item)).join("\n")}\n`);
  const exportBytes = Buffer.from("recordId\n");
  write(project, "artifacts/qa/human-ledger.jsonl", ledgerBytes);
  write(project, "artifacts/qa/human-export.csv", exportBytes);
  write(project, "artifacts/representative-trajectories/human-checkpoint.jsonl", trajectoryBytes);
  writeJson(project, "artifacts/qa/human-review.json", {
    reviewer: { kind: "participant", id: reviewer },
    ledgerPath: "artifacts/qa/human-ledger.jsonl",
    ledgerSha256: sha256(ledgerBytes),
    exportPath: "artifacts/qa/human-export.csv",
    exportSha256: sha256(exportBytes),
    trajectoryPath: "artifacts/representative-trajectories/human-checkpoint.jsonl",
    trajectorySha256: sha256(trajectoryBytes),
  });

  const command = run(project);
  assert.notEqual(command.status, 0, output(command));
  assert.match(failLines(command), /HUMAN REVIEW.*(?:undo|replay|restor|trajectory)/i);
});

test("release commands reject duplicate command records even when the first record is valid", (t) => {
  const project = fixture(t);
  const revision = "a".repeat(40);
  write(project, "artifacts/qa/README.md", `# Release QA\n\n${"Browser keyboard accessibility responsive security and clean-checkout release coverage passed. ".repeat(8)}\n`);
  const startedAt = "2026-08-30T00:00:00.000Z";
  const endedAt = "2026-08-30T00:00:01.000Z";
  const records = ["npm-test", "npm-test-copy"].map((id) => {
    const evidence = {
      schemaVersion: 1,
      artifactKind: "rubricdelta-qa-command",
      revision,
      command: "npm test",
      status: "PASS",
      exitCode: 0,
      startedAt,
      endedAt,
      output: "all tests passed",
    };
    const bytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`);
    write(project, `artifacts/qa/commands/${id}.json`, bytes);
    return { id, revision, command: "npm test", status: "PASS", exitCode: 0, startedAt, endedAt, outputPath: `artifacts/qa/commands/${id}.json`, outputSha256: sha256(bytes) };
  });
  writeJson(project, "artifacts/qa/release.json", {
    schemaVersion: 1,
    artifactKind: "rubricdelta-release-qa",
    revision,
    categories: {},
    commands: records,
    decision: { value: "approve release", actor: "participant" },
  });

  const command = run(project);
  assert.notEqual(command.status, 0, output(command));
  assert.match(failLines(command), /RELEASE QA.*(?:duplicate command record|command multiset.*duplicate|commands must contain exactly one record per required command)/i);
});

test("development evidence rejects a structurally plausible manual fabrication", (t) => {
  const project = fixture(t);
  const payloads = [
    ["instruction", { instruction: "Implement the requested feature" }],
    ["tool-call", { tool: "shell", arguments: {} }],
    ["tool-result", { tool: "shell", status: "complete" }],
    ["feedback", { feedback: "Please verify the final behavior" }],
    ["verification", { command: "npm test", status: "PASS" }],
  ];
  const events = payloads.map(([type, payload], index) => ({
    schemaVersion: 1,
    sequence: index + 1,
    timestamp: `2026-08-30T00:00:0${index}.000Z`,
    source: "manual-fabrication",
    type,
    payload,
  }));
  const bytes = Buffer.from(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  write(project, "artifacts/development-agent/trajectory.jsonl", bytes);
  writeJson(project, "artifacts/development-agent/manifest.json", {
    schemaVersion: 1,
    artifactKind: "rubricdelta-development-agent-evidence",
    privacyReview: { status: "PASS" },
    trajectoryPath: "artifacts/development-agent/trajectory.jsonl",
    trajectorySha256: sha256(bytes),
  });

  const command = run(project);
  assert.notEqual(command.status, 0, output(command));
  assert.match(failLines(command), /DEVELOPMENT TRAJECTORY.*(?:codex-export|export source|event count|run identity|agent identity)/i);
});
