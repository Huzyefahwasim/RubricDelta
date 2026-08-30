import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createArtifactStore } from "../src/artifacts/store.js";
import {
  QA_CATEGORIES,
  REQUIRED_RELEASE_COMMANDS,
  buildCategoryEvidence,
  buildCommandEvidence,
  buildDevelopmentManifest,
  buildHumanEvidence,
  buildReleaseEvidence,
  buildVideoEvidence,
  sha256Bytes,
} from "../src/release/evidence.js";
import {
  collectDevelopmentEvidence,
  collectHumanReview,
  composeRelease,
  inspectReleaseVideo,
  runCommandSuite,
} from "../scripts/release-evidence.js";
import { inspectMp4 } from "../scripts/validate-submission.js";
import { runValidation } from "../scripts/validate-submission.js";

const revision = "a".repeat(40);
const startedAt = "2026-08-30T12:00:00.000Z";
const endedAt = "2026-08-30T12:00:01.000Z";
const hash = "b".repeat(64);
const releaseCli = fileURLToPath(new URL("../scripts/release-evidence.js", import.meta.url));
const repositoryRoot = dirname(dirname(releaseCli));

function git(root, ...args) {
  const command = spawnSync("git", ["-c", `safe.directory=${root.replaceAll("\\", "/")}`, "-C", root, ...args], {
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
  });
  assert.equal(command.status, 0, `${command.stdout}\n${command.stderr}`);
  return command.stdout.trim();
}

async function temporaryRepository(t) {
  const root = await mkdtemp(join(tmpdir(), "rubricdelta-release-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, "init", "--quiet");
  git(root, "config", "user.email", "release-test@example.invalid");
  git(root, "config", "user.name", "Release Evidence Test");
  await writeFile(join(root, "package.json"), "{\"type\":\"module\"}\n");
  git(root, "add", "package.json");
  git(root, "commit", "--quiet", "-m", "fixture source");
  const revision = git(root, "rev-parse", "HEAD");
  await mkdir(join(root, "artifacts", "evaluation"), { recursive: true });
  await writeFile(join(root, "artifacts", "evaluation", "manifest.json"), `${JSON.stringify({
    schemaVersion: 1,
    artifactKind: "rubricdelta-evaluation-manifest",
    evaluationProtocol: { id: "rubricdelta-evaluation-v2" },
    git: { revision },
    benchmark: { id: "rubricdelta-support-guideline-drift-v1" },
    provider: { name: "deterministic", model: null, seed: 0 },
    reviewBudget: { fraction: 0.2, slotsByCase: Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`case-${index + 1}`, 2])) },
    resources: { providerCalls: { total: 0 }, providerAttempts: { total: 0 }, inputTokens: 0, outputTokens: 0, totalTokens: 0, latencyMs: 0, estimatedCostUsd: 0 },
  }, null, 2)}\n`);
  await writeFile(join(root, "artifacts", "evaluation", "comparison.json"), `${JSON.stringify({
    baseline: { primaryMetric: { numerator: 16, denominator: 20, value: 0.8 } },
    advanced: { primaryMetric: { numerator: 18, denominator: 20, value: 0.9 } },
    improvement: { absolute: 0.1 },
  }, null, 2)}\n`);
  return root;
}

function timestampSequence() {
  let offset = 0;
  return () => new Date(Date.parse(startedAt) + offset++ * 1_000).toISOString();
}

async function qaCommandFiles(root) {
  try {
    return (await readdir(join(root, "artifacts", "qa", "commands"))).sort();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function writeRelative(root, relativePath, value) {
  const path = join(root, ...relativePath.split("/"));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value);
}

async function writeJson(root, relativePath, value) {
  await writeRelative(root, relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeBoundJson(root, relativePath, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  await writeRelative(root, relativePath, bytes);
  return sha256Bytes(bytes);
}

async function readJson(root, relativePath) {
  return JSON.parse(await readFile(join(root, ...relativePath.split("/")), "utf8"));
}

function failingArtifactStore(root, failAt) {
  const backing = createArtifactStore(root);
  let writes = 0;
  return {
    async write(path, content) {
      writes += 1;
      if (writes === failAt) throw new Error(`forced generation write failure at ${path}`);
      return backing.write(path, content);
    },
  };
}

function humanSession(sourceRevision, reviewer = "owner-reviewer") {
  return {
    schemaVersion: 1,
    sourceRevision,
    humanReview: {
      runId: "run-participant-001",
      serverRevision: "rev-000005",
      reviewer: { kind: "participant", id: reviewer },
    },
  };
}

async function writeHumanFixture(root, reviewer = "owner-reviewer") {
  const sourceRevision = git(root, "rev-parse", "HEAD");
  const session = humanSession(sourceRevision, reviewer);
  const snapshot = "artifacts/runs/run-participant-001/revisions/rev-000005";
  const decisions = [
    { type: "decision", sequence: 1, timestamp: "2026-08-30T12:00:00.000Z", recordId: "record-A", decision: "approve", reviewer, reason: "Approved after inspection" },
    { type: "decision", sequence: 2, timestamp: "2026-08-30T12:00:01.000Z", recordId: "record-B", decision: "escalate", reviewer, reason: "Needs policy review" },
    { type: "undo", sequence: 3, timestamp: "2026-08-30T12:00:02.000Z", recordId: "record-B", reviewer, reason: "Undo escalation", undoneSequence: 2, restoredDecision: null },
    { type: "decision", sequence: 4, timestamp: "2026-08-30T12:00:03.000Z", recordId: "record-B", decision: "reject", reviewer, reason: "Evidence does not support correction" },
  ];
  const trajectory = decisions.map((decision, index) => ({
    runId: "run-participant-001",
    scenarioId: "case-001",
    sequence: index + 1,
    timestamp: decision.timestamp,
    agent: "human-reviewer",
    phase: "human-checkpoint",
    type: decision.type === "undo" ? "human-undo" : "human-decision",
    payload: decision.type === "undo"
      ? {
          type: "undo",
          reviewer,
          recordId: decision.recordId,
          timestamp: decision.timestamp,
          reason: decision.reason,
          undoneSequence: decision.undoneSequence,
          restoredDecision: decision.restoredDecision,
        }
      : {
          type: "decision",
          reviewer,
          recordId: decision.recordId,
          timestamp: decision.timestamp,
          reason: decision.reason,
          decision: decision.decision,
        },
  }));
  await writeJson(root, "artifacts/tmp/release-session.json", session);
  await writeJson(root, "artifacts/runs/run-participant-001/current.json", {
    schemaVersion: 1,
    runId: "run-participant-001",
    revision: "rev-000005",
  });
  await writeJson(root, `${snapshot}/manifest.json`, {
    schemaVersion: 1,
    runId: "run-participant-001",
    revision: "rev-000005",
    scenarioId: "case-001",
    provider: "deterministic",
    status: "complete",
  });
  await writeJson(root, `${snapshot}/decisions.json`, decisions);
  await writeRelative(root, `${snapshot}/export.csv`, "recordId,proposedLabel\nrecord-A,NEW_LABEL\n");
  await writeRelative(root, `${snapshot}/trajectory.jsonl`, `${trajectory.map((event) => JSON.stringify(event)).join("\n")}\n`);
  return { decisions, session, trajectory };
}

function developmentEvents() {
  const values = [
    ["instruction", { instruction: "Implement the fail-closed evidence collector from the approved Task 9 brief." }],
    ["tool-call", { tool: "apply_patch", arguments: { path: "src/release/evidence.js" } }],
    ["tool-result", { tool: "apply_patch", status: "completed", result: "Created the strict evidence builders." }],
    ["feedback", { feedback: "Keep managed evidence dirt admissible while rejecting source changes." }],
    ["verification", { command: "node --test tests/release-evidence.test.js", status: "PASS", exitCode: 0 }],
  ];
  return values.map(([type, payload], index) => ({
    schemaVersion: 1,
    runId: "codex-task-0001",
    sequence: index + 1,
    timestamp: `2026-08-30T12:01:0${index}.000Z`,
    source: "codex-export",
    agent: "codex",
    type,
    payload,
  }));
}

function isoBox(type, ...payloads) {
  const payload = Buffer.concat(payloads);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(header.length + payload.length, 0);
  header.write(type, 4, "ascii");
  return Buffer.concat([header, payload]);
}

function validAvcVideo() {
  const ftyp = isoBox("ftyp", Buffer.from("isom", "ascii"), Buffer.alloc(4));
  const mvhd = Buffer.alloc(20);
  mvhd.writeUInt32BE(1_000, 12);
  mvhd.writeUInt32BE(1_000, 16);
  const hdlr = Buffer.alloc(12);
  hdlr.write("vide", 8, "ascii");

  const avcPayload = Buffer.from([
    1, 66, 0, 30, 0xff, 0xe1,
    0, 2, 0x67, 0,
    1, 0, 2, 0x68, 0,
  ]);
  const config = isoBox("avcC", avcPayload);
  const sampleEntry = Buffer.alloc(86);
  sampleEntry.writeUInt32BE(sampleEntry.length + config.length, 0);
  sampleEntry.write("avc1", 4, "ascii");
  sampleEntry.writeUInt16BE(320, 32);
  sampleEntry.writeUInt16BE(180, 34);
  const stsdHeader = Buffer.alloc(8);
  stsdHeader.writeUInt32BE(1, 4);
  const stsd = isoBox("stsd", stsdHeader, sampleEntry, config);

  const sttsPayload = Buffer.alloc(16);
  sttsPayload.writeUInt32BE(1, 4);
  sttsPayload.writeUInt32BE(1, 8);
  sttsPayload.writeUInt32BE(1_000, 12);
  const stscPayload = Buffer.alloc(20);
  stscPayload.writeUInt32BE(1, 4);
  stscPayload.writeUInt32BE(1, 8);
  stscPayload.writeUInt32BE(1, 12);
  stscPayload.writeUInt32BE(1, 16);
  const stszPayload = Buffer.alloc(12);
  stszPayload.writeUInt32BE(1_024, 4);
  stszPayload.writeUInt32BE(1, 8);
  const stcoPayload = Buffer.alloc(12);
  stcoPayload.writeUInt32BE(1, 4);
  stcoPayload.writeUInt32BE(1, 8);
  const stbl = isoBox(
    "stbl",
    stsd,
    isoBox("stts", sttsPayload),
    isoBox("stsc", stscPayload),
    isoBox("stsz", stszPayload),
    isoBox("stco", stcoPayload),
  );
  const mdia = isoBox("mdia", isoBox("hdlr", hdlr), isoBox("minf", stbl));
  const moov = isoBox("moov", isoBox("mvhd", mvhd), isoBox("trak", isoBox("tkhd"), mdia));
  const sample = Buffer.alloc(1_024);
  sample.writeUInt32BE(1_020, 0);
  sample[4] = 0x65;
  const value = Buffer.concat([ftyp, moov, isoBox("mdat", sample)]);
  const stcoTypeOffset = value.indexOf(Buffer.from("stco", "ascii"));
  value.writeUInt32BE(ftyp.length + moov.length + 8, stcoTypeOffset + 12);
  return value;
}

function completeSession(sourceRevision, sourceSha256) {
  return {
    ...humanSession(sourceRevision),
    privacyReview: {
      status: "PASS",
      reviewer: { kind: "participant", id: "owner-reviewer" },
      reviewedAt: "2026-08-30T12:02:00.000Z",
      sourceSha256,
    },
    categories: Object.fromEntries(QA_CATEGORIES.map((category) => [category, {
      status: "PASS",
      timestamp: "2026-08-30T12:03:00.000Z",
      tool: category === "browser" ? "Codex in-app browser" : "Participant-reviewed release session",
      coverage: [`Verified ${category} release evidence at the frozen source revision.`],
    }])),
    video: {
      inspection: {
        sha256: sha256Bytes(validAvcVideo()),
        durationSeconds: 1,
        width: 320,
        height: 180,
        codec: "avc1",
        videoSampleCount: 1,
      },
      upload: { status: "accepted" },
      playback: {
        status: "PASS",
        testedAt: "2026-08-30T12:04:00.000Z",
        tool: "HackerEarth video player",
        renderedFrameObserved: true,
      },
    },
    eligibility: {
      status: "PASS",
      ageAndEligibilityConfirmed: true,
      individualEntryConfirmed: true,
      accurateRegistrationConfirmed: true,
      payoutEligibilityUnderstood: true,
    },
    rightsReview: {
      status: "PASS",
      originalityConfirmed: true,
      licenseComplianceConfirmed: true,
      dataRightsConfirmed: true,
      credentialsAndPrivateDataExcluded: true,
      preExistingWork: "Disclosed in the repository submission documentation.",
    },
    decision: { value: "approve release", actor: "participant" },
  };
}

async function completeReleaseFixture(t) {
  const root = await temporaryRepository(t);
  await runCommandSuite({
    root,
    run(command) { return { exitCode: 0, stdout: `passed ${command}`, stderr: "" }; },
    now: timestampSequence(),
  });
  const human = await writeHumanFixture(root);
  await collectHumanReview({ root, session: "artifacts/tmp/release-session.json" });
  const events = developmentEvents();
  const sourceBytes = Buffer.from(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  const session = completeSession(human.session.sourceRevision, sha256Bytes(sourceBytes));
  await writeJson(root, "artifacts/tmp/release-session.json", session);
  await writeRelative(root, "artifacts/tmp/codex-export.jsonl", sourceBytes);
  await collectDevelopmentEvidence({
    root,
    session: "artifacts/tmp/release-session.json",
    source: "artifacts/tmp/codex-export.jsonl",
  });
  await writeRelative(root, "artifacts/submission/demo.mp4", validAvcVideo());
  return { root, session };
}

function categoryRecords() {
  return Object.fromEntries(QA_CATEGORIES.map((category) => [category, {
    revision,
    status: "PASS",
    evidencePath: `artifacts/qa/categories/${category}.json`,
    evidenceSha256: hash,
  }]));
}

function commandRecords() {
  return REQUIRED_RELEASE_COMMANDS.map(({ id, command }) => ({
    id,
    revision,
    command,
    status: "PASS",
    exitCode: 0,
    startedAt,
    endedAt,
    outputPath: `artifacts/qa/commands/${id}.json`,
    outputSha256: hash,
  }));
}

function artifactRecords() {
  return {
    commandSuite: { path: "artifacts/qa/command-suite.json", sha256: hash },
    session: { path: "artifacts/qa/session.json", sha256: hash },
    participantAttestation: { path: "artifacts/qa/participant-attestation.json", sha256: hash },
    video: { path: "artifacts/qa/video.json", sha256: hash },
    humanReview: { path: "artifacts/qa/human-review.json", sha256: hash },
    developmentAgent: { path: "artifacts/development-agent/manifest.json", sha256: hash },
  };
}

test("release constants preserve the allowlisted command order and complete category inventory", () => {
  assert.deepEqual(REQUIRED_RELEASE_COMMANDS, [
    { id: "npm-test", command: "npm test" },
    { id: "npm-run-eval", command: "npm run eval" },
    { id: "npm-run-replay-check", command: "npm run replay:check" },
    { id: "npm-run-eval-replay", command: "npm run eval:replay" },
    { id: "npm-run-evidence", command: "npm run evidence" },
    { id: "npm-run-validate", command: "npm run validate" },
    { id: "git-diff-check", command: "git diff --check" },
  ]);
  assert.deepEqual(QA_CATEGORIES, [
    "automated", "browser", "keyboard", "accessibility", "responsive",
    "security", "cleanCheckout", "humanReview", "video",
    "developmentAgent", "release",
  ]);
});

test("byte hashing is deterministic for text and bytes", () => {
  assert.equal(sha256Bytes("RubricDelta"), "23ec52327cbef928509f7b4768dbf1fa2502b5af737a8bdc7cb83bfed3ebacc7");
  assert.equal(sha256Bytes(Buffer.from("RubricDelta")), "23ec52327cbef928509f7b4768dbf1fa2502b5af737a8bdc7cb83bfed3ebacc7");
  assert.throws(() => sha256Bytes({ value: "RubricDelta" }), /bytes|string/i);
});

test("command evidence accepts only a successful bounded result at one revision", () => {
  const evidence = buildCommandEvidence({
    revision,
    command: "npm test",
    startedAt,
    endedAt,
    exitCode: 0,
    output: "tests passed",
  });
  assert.deepEqual(evidence, {
    schemaVersion: 1,
    artifactKind: "rubricdelta-qa-command",
    revision,
    command: "npm test",
    status: "PASS",
    exitCode: 0,
    startedAt,
    endedAt,
    output: "tests passed",
  });
  assert.throws(() => buildCommandEvidence({
    revision, command: "npm test", startedAt, endedAt, exitCode: 1, output: "failed",
  }), /exitCode|PASS/i);
  assert.throws(() => buildCommandEvidence({
    revision, command: "npm test", startedAt: "today", endedAt, exitCode: 0, output: "tests passed",
  }), /timestamp|RFC3339/i);
  assert.throws(() => buildCommandEvidence({
    revision, command: "npm test", startedAt, endedAt, exitCode: 0, output: "tests passed", extra: true,
  }), /unknown field/i);
  assert.throws(() => buildCommandEvidence({
    revision, command: "npm test", startedAt, endedAt, exitCode: 0, output: "pending release evidence",
  }), /PENDING|PASS/i);
});

test("category evidence accepts only one final PASS revision", () => {
  const input = {
    revision,
    category: "browser",
    timestamp: "2026-08-30T12:00:00.000Z",
    tool: "Codex in-app browser",
    coverage: ["Loaded the fixed benchmark and inspected the Rule Seam."],
  };
  const evidence = buildCategoryEvidence(input);
  assert.equal(evidence.artifactKind, "rubricdelta-qa-category");
  assert.equal(evidence.status, "PASS");
  assert.throws(() => buildCategoryEvidence({ ...input, status: "PENDING" }), /PASS/);
  assert.throws(() => buildCategoryEvidence({ ...input, category: "unknown" }), /category/i);
  assert.throws(() => buildCategoryEvidence({ ...input, revision: "not-a-revision" }), /revision/i);
  assert.throws(() => buildCategoryEvidence({ ...input, coverage: ["   "] }), /coverage/i);
  assert.throws(() => buildCategoryEvidence({ ...input, coverage: ["PENDING browser verification."] }), /PENDING|PASS/i);
  assert.throws(() => buildCategoryEvidence({ ...input, extra: true }), /unknown field/i);
});

test("human evidence binds participant-reviewed ledger, export, and trajectory hashes", () => {
  const input = {
    revision,
    runId: "run-participant-001",
    serverRevision: "rev-000005",
    reviewer: { kind: "participant", id: "owner-reviewer" },
    ledgerPath: "artifacts/qa/human/ledger.jsonl",
    ledgerSha256: hash,
    exportPath: "artifacts/qa/human/export.csv",
    exportSha256: hash,
    trajectoryPath: "artifacts/representative-trajectories/human-checkpoint.jsonl",
    trajectorySha256: hash,
  };
  const evidence = buildHumanEvidence(input);
  assert.equal(evidence.artifactKind, "rubricdelta-human-review-evidence");
  assert.equal(evidence.runId, "run-participant-001");
  assert.equal(evidence.serverRevision, "rev-000005");
  for (const id of ["codex", "release-agent", "hackathon-evidence-generator"]) {
    assert.throws(() => buildHumanEvidence({ ...input, reviewer: { kind: "participant", id } }), /reviewer|participant/i);
  }
  assert.throws(() => buildHumanEvidence({ ...input, exportSha256: "" }), /hash|sha256/i);
  assert.throws(() => buildHumanEvidence({ ...input, unknown: true }), /unknown field/i);
});

test("development manifest requires a real privacy-reviewed Codex export", () => {
  const input = {
    revision,
    runId: "codex-task-0001",
    eventCount: 5,
    trajectoryPath: "artifacts/development-agent/trajectory.jsonl",
    trajectorySha256: hash,
    privacyReview: {
      status: "PASS",
      reviewer: { kind: "participant", id: "owner-reviewer" },
      reviewedAt: endedAt,
      sourceSha256: hash,
    },
  };
  const manifest = buildDevelopmentManifest(input);
  assert.equal(manifest.source, "codex-export");
  assert.equal(manifest.agent, "codex");
  assert.equal(manifest.privacyReview.sourceSha256, hash);
  assert.equal(manifest.trajectorySha256, manifest.privacyReview.sourceSha256);
  assert.throws(() => buildDevelopmentManifest({
    ...input,
    privacyReview: { ...input.privacyReview, status: "PENDING" },
  }), /privacy|PASS/i);
  assert.throws(() => buildDevelopmentManifest({
    ...input,
    privacyReview: {
      status: "PASS",
      reviewer: input.privacyReview.reviewer,
      reviewedAt: input.privacyReview.reviewedAt,
    },
  }), /sourceSha256|privacy|hash/i);
  assert.throws(() => buildDevelopmentManifest({ ...input, eventCount: 4 }), /eventCount/i);
  assert.throws(() => buildDevelopmentManifest({ ...input, extra: true }), /unknown field/i);
});

test("video evidence binds inspected media to participant upload and rendered playback proof", () => {
  const input = {
    revision,
    sha256: hash,
    durationSeconds: 280,
    width: 1920,
    height: 1080,
    codec: "avc1",
    videoSampleCount: 8400,
    upload: { status: "accepted" },
    playback: {
      status: "PASS",
      revision,
      testedAt: endedAt,
      tool: "HackerEarth video player",
      renderedFrameObserved: true,
      evidencePath: "artifacts/qa/categories/video.json",
      evidenceSha256: hash,
    },
  };
  assert.equal(buildVideoEvidence(input).artifactKind, "rubricdelta-video-evidence");
  assert.throws(() => buildVideoEvidence({ ...input, durationSeconds: 301 }), /duration|300/i);
  assert.throws(() => buildVideoEvidence({ ...input, upload: { status: "pending" } }), /upload|accepted/i);
  assert.throws(() => buildVideoEvidence({
    ...input,
    playback: { ...input.playback, renderedFrameObserved: false },
  }), /playback|rendered/i);
  assert.throws(() => buildVideoEvidence({ ...input, extra: true }), /unknown field/i);
});

test("release composition accepts exactly one complete participant-owned evidence set", () => {
  const evidence = buildReleaseEvidence({
    revision,
    categories: categoryRecords(),
    commands: commandRecords(),
    artifacts: artifactRecords(),
    decision: { value: "approve release", actor: "participant" },
  });
  assert.equal(evidence.artifactKind, "rubricdelta-release-qa");
  assert.equal(Object.keys(evidence.categories).length, 11);
  assert.equal(evidence.commands.length, 7);

  const duplicatePathCategories = categoryRecords();
  duplicatePathCategories.keyboard = {
    ...duplicatePathCategories.keyboard,
    evidencePath: duplicatePathCategories.browser.evidencePath,
  };
  assert.throws(() => buildReleaseEvidence({
    revision,
    categories: duplicatePathCategories,
    commands: commandRecords(),
    artifacts: artifactRecords(),
    decision: { value: "approve release", actor: "participant" },
  }), /duplicate|unique|path/i);
});

test("release composition rejects a missing category and agent-owned approval", () => {
  assert.throws(() => buildReleaseEvidence({
    revision,
    categories: {},
    commands: [],
    decision: { value: "approve release", actor: "codex" },
  }), /participant|category/i);
});

test("command collection rejects stale deterministic evidence with exact bootstrap remediation", async (t) => {
  const root = await temporaryRepository(t);
  const manifest = await readJson(root, "artifacts/evaluation/manifest.json");
  manifest.git.revision = "b".repeat(40);
  await writeJson(root, "artifacts/evaluation/manifest.json", manifest);
  let calls = 0;
  await assert.rejects(
    runCommandSuite({
      root,
      run() {
        calls += 1;
        return { exitCode: 0, stdout: "pass", stderr: "" };
      },
      now: timestampSequence(),
    }),
    {
      message: "Deterministic evaluation evidence is stale for HEAD; run `npm run eval` once after source freeze, then rerun `npm run release:commands`.",
    },
  );
  assert.equal(calls, 0);
  assert.deepEqual(await qaCommandFiles(root), []);
});

test("command collection publishes no PASS file when one command fails", async (t) => {
  const root = await temporaryRepository(t);
  const calls = [];
  await assert.rejects(runCommandSuite({
    root,
    run(command) {
      calls.push(command);
      return command === "npm run eval"
        ? { exitCode: 1, stdout: "", stderr: "forced failure" }
        : { exitCode: 0, stdout: "pass", stderr: "" };
    },
    now: timestampSequence(),
  }), /npm run eval/);
  assert.deepEqual(calls, ["npm test", "npm run eval"]);
  assert.deepEqual(await qaCommandFiles(root), []);
});

test("command collection runs the exact allowlist in order before publishing hash-bound PASS files", async (t) => {
  const root = await temporaryRepository(t);
  const calls = [];
  const records = await runCommandSuite({
    root,
    run(command) {
      calls.push(command);
      return { exitCode: 0, stdout: `passed ${command}; pending fixture text`, stderr: "" };
    },
    now: timestampSequence(),
  });
  assert.deepEqual(calls, REQUIRED_RELEASE_COMMANDS.map((item) => item.command));
  assert.deepEqual(await qaCommandFiles(root), REQUIRED_RELEASE_COMMANDS.map((item) => `${item.id}.json`).sort());
  assert.equal(records.length, 7);
  for (const [index, record] of records.entries()) {
    const bytes = await readFile(join(root, ...record.outputPath.split("/")));
    const evidence = JSON.parse(bytes);
    assert.equal(record.command, REQUIRED_RELEASE_COMMANDS[index].command);
    assert.equal(record.outputSha256, sha256Bytes(bytes));
    assert.equal(evidence.status, "PASS");
    assert.equal(typeof evidence.summary, "string");
    assert.equal(evidence.stdoutSha256, sha256Bytes(`passed ${record.command}; pending fixture text`));
    assert.equal(evidence.stdoutBytes, Buffer.byteLength(`passed ${record.command}; pending fixture text`));
    assert.doesNotMatch(bytes.toString("utf8"), /\bPENDING\b/i);
  }
});

test("command collection rejects dirty source before executing any command", async (t) => {
  const root = await temporaryRepository(t);
  await writeFile(join(root, "package.json"), "{\"type\":\"module\",\"dirty\":true}\n");
  let calls = 0;
  await assert.rejects(runCommandSuite({
    root,
    run() {
      calls += 1;
      return { exitCode: 0, stdout: "pass", stderr: "" };
    },
    now: timestampSequence(),
  }), /clean source/i);
  assert.equal(calls, 0);
  assert.deepEqual(await qaCommandFiles(root), []);
});

test("command collection permits dirty files only inside managed evidence roots", async (t) => {
  const root = await temporaryRepository(t);
  const existingEvidence = join(root, "artifacts", "qa", "preflight.json");
  await mkdir(dirname(existingEvidence), { recursive: true });
  await writeFile(existingEvidence, "{\"status\":\"PASS\"}\n");
  const records = await runCommandSuite({
    root,
    run(command) {
      return { exitCode: 0, stdout: `passed ${command}`, stderr: "" };
    },
    now: timestampSequence(),
  });
  assert.equal(records.length, 7);
});

test("human collection binds the exact final server revision and approved-only export", async (t) => {
  const root = await temporaryRepository(t);
  const fixture = await writeHumanFixture(root);
  const evidence = await collectHumanReview({
    root,
    session: "artifacts/tmp/release-session.json",
  });
  const ledgerSource = await readFile(join(root, "artifacts", "qa", "human", "ledger.jsonl"), "utf8");
  const ledger = ledgerSource.trimEnd().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(ledger.map((event) => event.decision ?? event.action), ["approve", "escalate", "undo", "reject"]);
  assert.deepEqual(ledger.map((event) => event.trajectorySequence), [1, 2, 3, 4]);
  assert.equal(await readFile(join(root, "artifacts", "qa", "human", "export.csv"), "utf8"), "recordId,proposedLabel\nrecord-A,NEW_LABEL\n");
  assert.equal(
    await readFile(join(root, "artifacts", "representative-trajectories", "human-checkpoint.jsonl"), "utf8"),
    `${fixture.trajectory.map((event) => JSON.stringify(event)).join("\n")}\n`,
  );
  assert.equal(evidence.reviewer.id, "owner-reviewer");
  assert.equal(evidence.revision, fixture.session.sourceRevision);
  assert.equal(evidence.ledgerSha256, sha256Bytes(Buffer.from(ledgerSource)));
  assert.equal(evidence.exportSha256, sha256Bytes(Buffer.from("recordId,proposedLabel\nrecord-A,NEW_LABEL\n")));
  assert.deepEqual((await readJson(root, "artifacts/qa/human-review.json")), evidence);
});

test("human collection rejects generated reviewer identifiers without publishing evidence", async (t) => {
  for (const reviewer of ["codex", "release-agent", "hackathon-evidence-generator"]) {
    const root = await temporaryRepository(t);
    await writeHumanFixture(root, reviewer);
    await assert.rejects(collectHumanReview({
      root,
      session: "artifacts/tmp/release-session.json",
    }), /reviewer|participant/i);
    await assert.rejects(readFile(join(root, "artifacts", "qa", "human-review.json")), /ENOENT/);
  }
});

test("development collection publishes only contiguous substantive privacy-reviewed Codex export events", async (t) => {
  const root = await temporaryRepository(t);
  const sourceRevision = git(root, "rev-parse", "HEAD");
  const events = developmentEvents();
  const sourceBytes = Buffer.from(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  await writeJson(root, "artifacts/tmp/release-session.json", {
    schemaVersion: 1,
    sourceRevision,
    privacyReview: {
      status: "PASS",
      reviewer: { kind: "participant", id: "owner-reviewer" },
      reviewedAt: "2026-08-30T12:02:00.000Z",
      sourceSha256: sha256Bytes(sourceBytes),
    },
  });
  await writeRelative(root, "artifacts/tmp/codex-export.jsonl", sourceBytes);
  const manifest = await collectDevelopmentEvidence({
    root,
    session: "artifacts/tmp/release-session.json",
    source: "artifacts/tmp/codex-export.jsonl",
  });
  const output = await readFile(join(root, "artifacts", "development-agent", "trajectory.jsonl"));
  assert.equal(output.toString("utf8"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  assert.equal(manifest.runId, "codex-task-0001");
  assert.equal(manifest.eventCount, 5);
  assert.equal(manifest.trajectorySha256, sha256Bytes(output));
  assert.deepEqual(await readJson(root, "artifacts/development-agent/manifest.json"), manifest);
});

test("development collection publishes the exact participant-reviewed JSONL bytes unchanged", async (t) => {
  const root = await temporaryRepository(t);
  const sourceRevision = git(root, "rev-parse", "HEAD");
  const sourceBytes = Buffer.from(`${developmentEvents().map((event) => `  ${JSON.stringify(event)} `).join("\n")}\n`);
  const sourceSha256 = sha256Bytes(sourceBytes);
  await writeJson(root, "artifacts/tmp/release-session.json", {
    schemaVersion: 1,
    sourceRevision,
    privacyReview: {
      status: "PASS",
      reviewer: { kind: "participant", id: "owner-reviewer" },
      reviewedAt: "2026-08-30T12:02:00.000Z",
      sourceSha256,
    },
  });
  await writeRelative(root, "artifacts/tmp/codex-export.jsonl", sourceBytes);
  const manifest = await collectDevelopmentEvidence({
    root,
    session: "artifacts/tmp/release-session.json",
    source: "artifacts/tmp/codex-export.jsonl",
  });
  const published = await readFile(join(root, "artifacts", "development-agent", "trajectory.jsonl"));
  assert.deepEqual(published, sourceBytes);
  assert.equal(manifest.privacyReview.sourceSha256, sourceSha256);
  assert.equal(manifest.trajectorySha256, sourceSha256);
});

test("development collection rejects substitution after participant privacy review", async (t) => {
  const root = await temporaryRepository(t);
  const sourceRevision = git(root, "rev-parse", "HEAD");
  const reviewedBytes = Buffer.from(`${developmentEvents().map((event) => JSON.stringify(event)).join("\n")}\n`);
  const substituted = developmentEvents();
  substituted[3].payload.feedback = "Substituted but still structurally valid private export content.";
  const substitutedBytes = Buffer.from(`${substituted.map((event) => JSON.stringify(event)).join("\n")}\n`);
  await writeJson(root, "artifacts/tmp/release-session.json", {
    schemaVersion: 1,
    sourceRevision,
    privacyReview: {
      status: "PASS",
      reviewer: { kind: "participant", id: "owner-reviewer" },
      reviewedAt: "2026-08-30T12:02:00.000Z",
      sourceSha256: sha256Bytes(reviewedBytes),
    },
  });
  await writeRelative(root, "artifacts/tmp/codex-export.jsonl", substitutedBytes);
  await assert.rejects(
    collectDevelopmentEvidence({
      root,
      session: "artifacts/tmp/release-session.json",
      source: "artifacts/tmp/codex-export.jsonl",
    }),
    { message: "Participant privacy review sourceSha256 must match the exact Codex export bytes" },
  );
  await assert.rejects(readFile(join(root, "artifacts", "development-agent", "manifest.json")), /ENOENT/);
});

test("development collection rejects absent privacy approval or malformed event order before publication", async (t) => {
  for (const problem of ["privacy", "sequence"]) {
    const root = await temporaryRepository(t);
    const sourceRevision = git(root, "rev-parse", "HEAD");
    const events = developmentEvents();
    if (problem === "sequence") events[3].sequence = 9;
    const sourceBytes = Buffer.from(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
    await writeJson(root, "artifacts/tmp/release-session.json", {
      schemaVersion: 1,
      sourceRevision,
      privacyReview: {
        status: problem === "privacy" ? "PENDING" : "PASS",
        reviewer: { kind: "participant", id: "owner-reviewer" },
        reviewedAt: "2026-08-30T12:02:00.000Z",
        sourceSha256: sha256Bytes(sourceBytes),
      },
    });
    await writeRelative(root, "artifacts/tmp/codex-export.jsonl", sourceBytes);
    await assert.rejects(collectDevelopmentEvidence({
      root,
      session: "artifacts/tmp/release-session.json",
      source: "artifacts/tmp/codex-export.jsonl",
    }), /privacy|sequence/i);
    await assert.rejects(readFile(join(root, "artifacts", "development-agent", "manifest.json")), /ENOENT/);
  }
});

test("participant session and Codex-export inputs reject Windows cross-drive repository escapes", { skip: process.platform !== "win32" }, async (t) => {
  const root = await temporaryRepository(t);
  if (root.slice(0, 2).toLowerCase() === repositoryRoot.slice(0, 2).toLowerCase()) {
    t.skip("temporary repository and source checkout are on the same Windows drive");
    return;
  }

  await assert.rejects(collectHumanReview({
    root,
    session: join(repositoryRoot, "package.json"),
  }), /escapes the repository root/i);

  const sourceRevision = git(root, "rev-parse", "HEAD");
  await writeJson(root, "artifacts/tmp/release-session.json", {
    schemaVersion: 1,
    sourceRevision,
    privacyReview: {
      status: "PASS",
      reviewer: { kind: "participant", id: "owner-reviewer" },
      reviewedAt: "2026-08-30T12:02:00.000Z",
      sourceSha256: hash,
    },
  });
  await assert.rejects(collectDevelopmentEvidence({
    root,
    session: "artifacts/tmp/release-session.json",
    source: join(repositoryRoot, "package.json"),
  }), /escapes the repository root/i);
});

test("MP4 inspection can be imported without running submission validation", () => {
  assert.equal(typeof inspectMp4, "function");
});

test("MP4 inspection enforces one cumulative box budget across top-level and child boxes", () => {
  const mvhd = Buffer.alloc(20);
  mvhd.writeUInt32BE(1_000, 12);
  mvhd.writeUInt32BE(1_000, 16);
  const movieChildren = Buffer.concat([
    isoBox("mvhd", mvhd),
    ...Array.from({ length: 9_998 }, () => isoBox("free")),
  ]);
  const malicious = Buffer.concat([
    isoBox("ftyp", Buffer.alloc(8)),
    isoBox("moov", movieChildren),
  ]);
  assert.ok(malicious.length < 128 * 1024);
  assert.throws(
    () => inspectMp4(malicious),
    { message: "ISO-BMFF box enumeration exceeds bounded validation limit" },
  );
});

test("video check prints inspected hash and AVC metadata without claiming upload acceptance", async (t) => {
  const root = await temporaryRepository(t);
  const video = validAvcVideo();
  await writeRelative(root, "artifacts/submission/demo.mp4", video);
  const output = [];
  const metadata = await inspectReleaseVideo({ root, print(value) { output.push(value); } });
  assert.deepEqual(metadata, {
    revision: git(root, "rev-parse", "HEAD"),
    path: "artifacts/submission/demo.mp4",
    sha256: sha256Bytes(video),
    durationSeconds: 1,
    width: 320,
    height: 180,
    codec: "avc1",
    videoSampleCount: 1,
    mediaBytes: 1_024,
  });
  assert.deepEqual(JSON.parse(output.join("")), metadata);
  assert.equal(Object.hasOwn(metadata, "upload"), false);
});

test("release composition writes eleven unique categories and a fully bound final envelope", async (t) => {
  const { root, session } = await completeReleaseFixture(t);
  const release = await composeRelease({ root, session: "artifacts/tmp/release-session.json" });
  const categoryFiles = (await readdir(join(root, "artifacts", "qa", "categories"))).sort();
  assert.deepEqual(categoryFiles, QA_CATEGORIES.map((category) => `${category}.json`).sort());
  assert.equal(Object.keys(release.categories).length, 11);
  assert.equal(new Set(Object.values(release.categories).map((item) => item.evidencePath)).size, 11);
  assert.equal(release.commands.length, 7);
  assert.deepEqual(release.decision, { value: "approve release", actor: "participant" });
  const expectedEnvelopePaths = {
    commandSuite: "artifacts/qa/command-suite.json",
    session: "artifacts/qa/session.json",
    participantAttestation: "artifacts/qa/participant-attestation.json",
    video: "artifacts/qa/video.json",
    humanReview: "artifacts/qa/human-review.json",
    developmentAgent: "artifacts/development-agent/manifest.json",
  };
  assert.deepEqual(Object.keys(release.artifacts), Object.keys(expectedEnvelopePaths));
  for (const [name, path] of Object.entries(expectedEnvelopePaths)) {
    const bytes = await readFile(join(root, ...path.split("/")));
    assert.deepEqual(release.artifacts[name], { path, sha256: sha256Bytes(bytes) });
  }
  const commandSuite = await readJson(root, "artifacts/qa/command-suite.json");
  assert.deepEqual(commandSuite.commands, release.commands);
  const video = await readJson(root, "artifacts/qa/video.json");
  assert.equal(video.upload.status, "accepted");
  assert.equal(video.playback.renderedFrameObserved, true);
  assert.equal(video.playback.evidencePath, release.categories.video.evidencePath);
  assert.equal(video.playback.evidenceSha256, release.categories.video.evidenceSha256);
  assert.deepEqual(await readJson(root, "artifacts/qa/release.json"), release);
  assert.deepEqual(await readJson(root, "artifacts/qa/session.json"), session);
  assert.equal(
    (await readJson(root, "artifacts/qa/participant-attestation.json")).eligibility.individualEntryConfirmed,
    true,
  );
  assert.match(await readFile(join(root, "artifacts", "qa", "README.md"), "utf8"), /browser.*keyboard.*accessib.*mobile.*desktop/is);
});

test("final-strict rejects producer-output envelope deletion, unknown fields, reordering, weak summaries, and participant substitution", async (t) => {
  const cases = [
    ["bound artifact deletion", async (root) => {
      await unlink(join(root, "artifacts", "qa", "session.json"));
    }],
    ["category unknown field", async (root, release) => {
      const category = await readJson(root, "artifacts/qa/categories/browser.json");
      category.unexpectedClaim = "must not be accepted";
      release.categories.browser.evidenceSha256 = await writeBoundJson(root, "artifacts/qa/categories/browser.json", category);
    }],
    ["command reorder", async (root, release) => {
      release.commands.reverse();
      const suite = await readJson(root, "artifacts/qa/command-suite.json");
      suite.commands.reverse();
      release.artifacts.commandSuite.sha256 = await writeBoundJson(root, "artifacts/qa/command-suite.json", suite);
    }],
    ["weak summary without hashes or byte counts", async (root, release) => {
      const command = await readJson(root, release.commands[0].outputPath);
      delete command.stdoutSha256;
      delete command.stderrSha256;
      delete command.stdoutBytes;
      delete command.stderrBytes;
      const commandHash = await writeBoundJson(root, release.commands[0].outputPath, command);
      release.commands[0].outputSha256 = commandHash;
      const suite = await readJson(root, "artifacts/qa/command-suite.json");
      suite.commands[0].outputSha256 = commandHash;
      release.artifacts.commandSuite.sha256 = await writeBoundJson(root, "artifacts/qa/command-suite.json", suite);
    }],
    ["participant attestation and session mismatch", async (root, release) => {
      const attestation = await readJson(root, "artifacts/qa/participant-attestation.json");
      attestation.rightsReview.preExistingWork = "A substituted but independently valid rights statement.";
      release.artifacts.participantAttestation.sha256 = await writeBoundJson(
        root,
        "artifacts/qa/participant-attestation.json",
        attestation,
      );
    }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async (t) => {
      const { root } = await completeReleaseFixture(t);
      const release = await composeRelease({ root, session: "artifacts/tmp/release-session.json" });
      await mutate(root, release);
      await writeJson(root, "artifacts/qa/release.json", release);
      const { validation } = runValidation({ mode: "final-strict", root });
      assert.ok(
        validation.errors.some((error) => error.startsWith("RELEASE ENVELOPE")),
        validation.errors.join("\n"),
      );
    });
  }
});

test("release composition rejects human evidence from a different selected run or server revision", async (t) => {
  for (const mutate of [
    (session) => { session.humanReview.runId = "run-participant-002"; },
    (session) => { session.humanReview.serverRevision = "rev-000006"; },
  ]) {
    const { root, session } = await completeReleaseFixture(t);
    const mismatched = structuredClone(session);
    mutate(mismatched);
    await writeJson(root, "artifacts/tmp/release-session.json", mismatched);
    await assert.rejects(
      composeRelease({ root, session: "artifacts/tmp/release-session.json" }),
      /human review evidence.*participant session|run ID|server revision/i,
    );
  }
});

test("release session is schema-closed before participant claims are republished", async (t) => {
  const cases = [
    ["schemaVersion", (session) => { session.schemaVersion = 2; }],
    ["category unknown field", (session) => { session.categories.browser.privateNote = "do not publish"; }],
    ["eligibility unknown field", (session) => { session.eligibility.privateClaim = true; }],
    ["rights unknown field", (session) => { session.rightsReview.privateClaim = true; }],
    ["top-level unknown field", (session) => { session.privateParticipantData = "do not publish"; }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async (t) => {
      const { root, session } = await completeReleaseFixture(t);
      const invalid = structuredClone(session);
      mutate(invalid);
      await writeJson(root, "artifacts/tmp/release-session.json", invalid);
      await assert.rejects(
        composeRelease({ root, session: "artifacts/tmp/release-session.json" }),
        /schemaVersion|unknown field|release session/i,
      );
      await assert.rejects(readFile(join(root, "artifacts", "qa", "release.json")), /ENOENT/);
    });
  }
});

test("release composition refuses every missing participant-controlled gate before publication", async (t) => {
  const { root, session } = await completeReleaseFixture(t);
  const cases = [
    ["privacy", (value) => { value.privacyReview.status = "PENDING"; }],
    ["upload", (value) => { value.video.upload.status = "pending"; }],
    ["playback", (value) => { value.video.playback.renderedFrameObserved = false; }],
    ["eligibility", (value) => { value.eligibility.individualEntryConfirmed = false; }],
    ["license|rights", (value) => { value.rightsReview.dataRightsConfirmed = false; }],
    ["approve release|participant", (value) => { value.decision = { value: "block release", actor: "participant" }; }],
  ];
  for (const [message, mutate] of cases) {
    const invalid = structuredClone(session);
    mutate(invalid);
    await writeJson(root, "artifacts/tmp/release-session.json", invalid);
    await assert.rejects(composeRelease({ root, session: "artifacts/tmp/release-session.json" }), new RegExp(message, "i"));
    await assert.rejects(readFile(join(root, "artifacts", "qa", "release.json")), /ENOENT/);
  }
});

test("multi-file evidence publication leaves no active generation marker after an injected write failure", async (t) => {
  await t.test("commands", async (t) => {
    const root = await temporaryRepository(t);
    const run = (command) => ({ exitCode: 0, stdout: `passed ${command}`, stderr: "" });
    await runCommandSuite({ root, run, now: timestampSequence() });
    await assert.rejects(runCommandSuite({
      root,
      run,
      now: timestampSequence(),
      artifactStore: failingArtifactStore(root, 2),
    }), /forced generation write failure/i);
    await assert.rejects(readFile(join(root, "artifacts", "qa", "command-suite.json")), /ENOENT/);
  });

  await t.test("human review", async (t) => {
    const root = await temporaryRepository(t);
    await writeHumanFixture(root);
    await collectHumanReview({ root, session: "artifacts/tmp/release-session.json" });
    await assert.rejects(collectHumanReview({
      root,
      session: "artifacts/tmp/release-session.json",
      artifactStore: failingArtifactStore(root, 2),
    }), /forced generation write failure/i);
    await assert.rejects(readFile(join(root, "artifacts", "qa", "human-review.json")), /ENOENT/);
  });

  await t.test("development agent", async (t) => {
    const root = await temporaryRepository(t);
    const sourceRevision = git(root, "rev-parse", "HEAD");
    const events = developmentEvents();
    const sourceBytes = Buffer.from(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
    await writeJson(root, "artifacts/tmp/release-session.json", {
      schemaVersion: 1,
      sourceRevision,
      privacyReview: {
        status: "PASS",
        reviewer: { kind: "participant", id: "owner-reviewer" },
        reviewedAt: "2026-08-30T12:02:00.000Z",
        sourceSha256: sha256Bytes(sourceBytes),
      },
    });
    await writeRelative(root, "artifacts/tmp/codex-export.jsonl", sourceBytes);
    const options = {
      root,
      session: "artifacts/tmp/release-session.json",
      source: "artifacts/tmp/codex-export.jsonl",
    };
    await collectDevelopmentEvidence(options);
    await assert.rejects(collectDevelopmentEvidence({
      ...options,
      artifactStore: failingArtifactStore(root, 1),
    }), /forced generation write failure/i);
    await assert.rejects(readFile(join(root, "artifacts", "development-agent", "manifest.json")), /ENOENT/);
  });

  await t.test("final release rerun", async (t) => {
    const { root } = await completeReleaseFixture(t);
    await composeRelease({ root, session: "artifacts/tmp/release-session.json" });
    await assert.rejects(composeRelease({
      root,
      session: "artifacts/tmp/release-session.json",
      artifactStore: failingArtifactStore(root, 3),
    }), /forced generation write failure/i);
    await assert.rejects(readFile(join(root, "artifacts", "qa", "release.json")), /ENOENT/);
  });
});

test("command invalidation removes the final release marker before a later marker error", async (t) => {
  const { root } = await completeReleaseFixture(t);
  await composeRelease({ root, session: "artifacts/tmp/release-session.json" });
  const commandMarker = join(root, "artifacts", "qa", "command-suite.json");
  const releaseMarker = join(root, "artifacts", "qa", "release.json");
  await rm(commandMarker);
  await mkdir(commandMarker);

  let commandCalls = 0;
  await assert.rejects(runCommandSuite({
    root,
    run() {
      commandCalls += 1;
      return { exitCode: 0, stdout: "pass", stderr: "" };
    },
    now: timestampSequence(),
  }), /marker must be a normal file/i);

  assert.equal(commandCalls, 0);
  await assert.rejects(readFile(releaseMarker), /ENOENT/);
});

test("package exposes the five exact release evidence commands", async () => {
  const packageJson = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
  assert.deepEqual(Object.fromEntries(Object.entries(packageJson.scripts).filter(([name]) => name.startsWith("release:"))), {
    "release:commands": "node scripts/release-evidence.js commands",
    "release:human": "node scripts/release-evidence.js human --session artifacts/tmp/release-session.json",
    "release:development": "node scripts/release-evidence.js development --session artifacts/tmp/release-session.json --source artifacts/tmp/codex-export.jsonl",
    "release:video-check": "node scripts/release-evidence.js video-check",
    "release:compose": "node scripts/release-evidence.js compose --session artifacts/tmp/release-session.json",
  });
});

test("direct video-check CLI prints metadata and unknown commands fail with a bounded error", async (t) => {
  const root = await temporaryRepository(t);
  await writeRelative(root, "artifacts/submission/demo.mp4", validAvcVideo());
  const video = spawnSync(process.execPath, [releaseCli, "video-check", "--root", root], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(video.status, 0, `${video.stdout}\n${video.stderr}`);
  assert.equal(JSON.parse(video.stdout).codec, "avc1");
  assert.equal(video.stderr, "");

  const unknown = spawnSync(process.execPath, [releaseCli, "unknown-command", "--root", root], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  assert.notEqual(unknown.status, 0);
  assert.equal(unknown.stdout, "");
  assert.match(unknown.stderr, /bounded fail-closed collector error/i);
});
