#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { relative, resolve } from "node:path";
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
import { isGitObjectId, parseGitStatus } from "./git-provenance.js";
import { inspectMp4 } from "./validate-submission.js";

const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 10 * 60 * 1_000;
const RFC3339_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{3,120}$/;
const MANAGED_EVIDENCE_ROOTS = Object.freeze([
  "artifacts/evaluation/",
  "artifacts/representative-trajectories/",
  "artifacts/expected-replay-report/",
  "artifacts/qa/",
  "artifacts/submission/",
  "artifacts/development-agent/",
]);

function runGit(root, args) {
  return spawnSync("git", ["-c", `safe.directory=${root.replaceAll("\\", "/")}`, "-C", root, ...args], {
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  });
}

function entryRevision(root) {
  const result = runGit(root, ["rev-parse", "--verify", "HEAD"]);
  const value = result.status === 0 ? result.stdout.trim() : "";
  if (!isGitObjectId(value)) throw new Error("Release command collection requires a concrete Git HEAD");
  return value;
}

function evidencePath(path) {
  return MANAGED_EVIDENCE_ROOTS.some((prefix) => path.startsWith(prefix));
}

function requireCleanSource(root) {
  const result = runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"]);
  const status = result.status === 0 ? parseGitStatus(result.stdout) : null;
  if (!status) throw new Error("Release command collection could not verify a clean source tree");
  const sourceChanges = status.filter((entry) => !evidencePath(entry.path));
  if (sourceChanges.length > 0) {
    throw new Error(`Release command collection requires a clean source tree; found ${sourceChanges[0].path}`);
  }
}

async function readJson(root, relativePath) {
  const path = resolve(root, ...relativePath.split("/"));
  const bytes = await readFile(path);
  if (bytes.length > MAX_JSON_BYTES) throw new Error(`${relativePath} exceeds the bounded JSON limit`);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error(`${relativePath} must be valid bounded UTF-8 JSON`);
  }
}

function fixedMetric(value, numerator, expected) {
  return value?.numerator === numerator && value?.denominator === 20 && value?.value === expected;
}

async function verifyDeterministicEvidence(root, revision) {
  const manifest = await readJson(root, "artifacts/evaluation/manifest.json");
  const comparison = await readJson(root, "artifacts/evaluation/comparison.json");
  const slots = Object.values(manifest?.reviewBudget?.slotsByCase ?? {});
  const resources = manifest?.resources ?? {};
  if (manifest?.schemaVersion !== 1
    || manifest?.artifactKind !== "rubricdelta-evaluation-manifest"
    || manifest?.git?.revision !== revision
    || manifest?.evaluationProtocol?.id !== "rubricdelta-evaluation-v2"
    || manifest?.benchmark?.id !== "rubricdelta-support-guideline-drift-v1"
    || manifest?.provider?.name !== "deterministic"
    || manifest?.provider?.model !== null
    || manifest?.provider?.seed !== 0
    || manifest?.reviewBudget?.fraction !== 0.2
    || slots.length !== 10
    || slots.some((value) => value !== 2)
    || resources.providerCalls?.total !== 0
    || resources.providerAttempts?.total !== 0
    || resources.inputTokens !== 0
    || resources.outputTokens !== 0
    || resources.totalTokens !== 0
    || resources.latencyMs !== 0
    || resources.estimatedCostUsd !== 0
    || !fixedMetric(comparison?.baseline?.primaryMetric, 16, 0.8)
    || !fixedMetric(comparison?.advanced?.primaryMetric, 18, 0.9)
    || comparison?.improvement?.absolute !== 0.1) {
    throw new Error("Deterministic evaluation evidence must bind the entry HEAD and fixed 16/20 to 18/20 scores");
  }
}

function commandProcess(root, command) {
  const required = REQUIRED_RELEASE_COMMANDS.find((item) => item.command === command);
  if (!required) throw new Error(`Command is not allowlisted: ${command}`);
  const isGit = command === "git diff --check";
  const executable = isGit ? "git" : process.platform === "win32" ? "npm.cmd" : "npm";
  const args = isGit
    ? ["-c", `safe.directory=${root.replaceAll("\\", "/")}`, "-C", root, "diff", "--check"]
    : command.split(" ").slice(1);
  const result = spawnSync(executable, args, {
    cwd: root,
    encoding: "utf8",
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    windowsHide: true,
  });
  if (result.error) {
    const reason = result.error.code === "ETIMEDOUT" ? "command timed out" : "bounded command execution failed";
    return { exitCode: 1, stdout: result.stdout ?? "", stderr: `${reason}: ${result.error.message}` };
  }
  return {
    exitCode: Number.isInteger(result.status) ? result.status : 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function commandResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)
    || !Number.isInteger(result.exitCode) || typeof result.stdout !== "string" || typeof result.stderr !== "string") {
    throw new Error("Command runner returned an invalid bounded result");
  }
  const output = [result.stdout, result.stderr].filter((value) => value.trim() !== "").join("\n");
  if (Buffer.byteLength(output, "utf8") > MAX_COMMAND_OUTPUT_BYTES) throw new Error("Command output exceeds the bounded release evidence limit");
  return {
    output: output.trim() || "Command completed with no output.",
    stdoutSha256: sha256Bytes(result.stdout),
    stderrSha256: sha256Bytes(result.stderr),
    stdoutBytes: Buffer.byteLength(result.stdout, "utf8"),
    stderrBytes: Buffer.byteLength(result.stderr, "utf8"),
  };
}

export async function runCommandSuite(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("Release command options must be an object");
  const root = await realpath(resolve(options.root ?? resolve(import.meta.dirname, "..")));
  const now = options.now ?? (() => new Date().toISOString());
  const run = options.run ?? ((command) => commandProcess(root, command));
  if (typeof now !== "function" || typeof run !== "function") throw new Error("Release command options require callable now and run values");

  const revision = entryRevision(root);
  requireCleanSource(root);
  await verifyDeterministicEvidence(root, revision);

  const buffered = [];
  for (const required of REQUIRED_RELEASE_COMMANDS) {
    const startedAt = now();
    let result;
    try {
      result = await run(required.command, {
        root,
        executable: required.command.startsWith("npm ") && process.platform === "win32" ? "npm.cmd" : required.command.split(" ")[0],
        timeoutMs: COMMAND_TIMEOUT_MS,
        maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
      });
    } catch (error) {
      throw new Error(`Release command failed: ${required.command} — ${error.message}`);
    }
    const endedAt = now();
    const captured = commandResult(result);
    if (result.exitCode !== 0) throw new Error(`Release command failed: ${required.command} — ${captured.output.slice(0, 400)}`);
    const evidence = buildCommandEvidence({
      revision,
      command: required.command,
      startedAt,
      endedAt,
      exitCode: result.exitCode,
      summary: "Command completed successfully; captured stdout and stderr are bound by SHA-256 hashes and byte counts.",
      stdoutSha256: captured.stdoutSha256,
      stderrSha256: captured.stderrSha256,
      stdoutBytes: captured.stdoutBytes,
      stderrBytes: captured.stderrBytes,
    });
    const bytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`);
    buffered.push({ required, evidence, bytes });
  }

  const store = createArtifactStore(root);
  const records = [];
  for (const item of buffered) {
    const outputPath = `artifacts/qa/commands/${item.required.id}.json`;
    await store.write(outputPath, item.bytes);
    records.push({
      id: item.required.id,
      revision,
      command: item.required.command,
      status: "PASS",
      exitCode: 0,
      startedAt: item.evidence.startedAt,
      endedAt: item.evidence.endedAt,
      outputPath,
      outputSha256: sha256Bytes(item.bytes),
    });
  }
  return records;
}

function contained(root, target) {
  const value = relative(root, target);
  return value === "" || (value !== ".." && !value.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
}

async function readBounded(root, requestedPath, fallback, maximum = MAX_JSON_BYTES) {
  const configured = resolve(root, requestedPath ?? fallback);
  if (!contained(root, configured)) throw new Error("Release evidence input path escapes the repository root");
  const actual = await realpath(configured);
  if (!contained(root, actual)) throw new Error("Release evidence input resolves outside the repository root");
  const bytes = await readFile(actual);
  if (bytes.length > maximum) throw new Error("Release evidence input exceeds its bounded size");
  return bytes;
}

function decodeUtf8(bytes, kind) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${kind} must be valid UTF-8`);
  }
}

async function readInputJson(root, requestedPath, fallback, kind) {
  const source = decodeUtf8(await readBounded(root, requestedPath, fallback), kind);
  try {
    return JSON.parse(source);
  } catch {
    throw new Error(`${kind} must be valid JSON`);
  }
}

function jsonLines(bytes, kind) {
  const source = decodeUtf8(bytes, kind);
  if (!source.endsWith("\n") || source.trimEnd() === "") throw new Error(`${kind} must be nonempty newline-terminated JSONL`);
  try {
    return source.trimEnd().split("\n").map((line) => JSON.parse(line));
  } catch {
    throw new Error(`${kind} must contain valid JSONL`);
  }
}

function realTimestamp(value) {
  if (typeof value !== "string" || !RFC3339_TIMESTAMP.test(value)) return false;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return false;
  const normalized = new Date(milliseconds).toISOString();
  return value === normalized || value === normalized.replace(".000Z", "Z");
}

async function sourceRevisionFromSession(root, session) {
  if (!isGitObjectId(session?.sourceRevision)) throw new Error("Release session sourceRevision must be a concrete Git revision");
  const manifest = await readInputJson(root, "artifacts/evaluation/manifest.json", null, "evaluation manifest");
  if (manifest?.git?.revision !== session.sourceRevision) throw new Error("Release session sourceRevision must match the deterministic manifest revision");
  return session.sourceRevision;
}

function parseCsvRecordIds(source) {
  const lines = source.replace(/\r\n?/g, "\n").trimEnd().split("\n");
  if (lines.length < 1) return null;
  const headers = lines[0].split(",").map((item) => item.replace(/^"|"$/g, "").trim());
  const index = headers.indexOf("recordId");
  if (index < 0) return null;
  return lines.slice(1).filter(Boolean).map((line) => {
    const fields = line.match(/(?:^|,)("(?:[^"]|"")*"|[^,]*)/g)
      ?.map((item) => item.replace(/^,/, "").replace(/^"|"$/g, "").replaceAll('""', '"')) ?? [];
    return fields[index];
  });
}

function validateHumanDecisions(decisions, events, reviewer) {
  if (!Array.isArray(decisions) || decisions.length !== 4) throw new Error("Human review requires exactly approve, escalate, undo, and reject decisions");
  const human = events.filter((event) => event?.agent === "human-reviewer" && ["human-decision", "human-undo"].includes(event?.type));
  if (human.length !== decisions.length) throw new Error("Human decision ledger and trajectory must contain the same four events");
  const expected = ["approve", "escalate", "undo", "reject"];
  const ledger = [];
  for (let index = 0; index < decisions.length; index += 1) {
    const decision = decisions[index];
    const trajectory = human[index];
    const action = decision?.type === "undo" ? "undo" : decision?.decision;
    if (!decision || typeof decision !== "object" || Array.isArray(decision)
      || decision.sequence !== index + 1 || action !== expected[index]
      || decision.reviewer !== reviewer.id || !realTimestamp(decision.timestamp)
      || typeof decision.recordId !== "string" || decision.recordId.trim() === ""
      || !Number.isInteger(trajectory?.sequence) || trajectory.timestamp !== decision.timestamp
      || trajectory.payload?.reviewer !== reviewer.id || trajectory.payload?.recordId !== decision.recordId
      || trajectory.payload?.timestamp !== decision.timestamp) {
      throw new Error("Human decisions must preserve exact order, participant attribution, timestamps, records, and trajectory equality");
    }
    if (decision.type === "undo") {
      if (trajectory.type !== "human-undo" || decision.recordId !== decisions[1].recordId
        || decision.undoneSequence !== decisions[1].sequence || decision.restoredDecision !== null
        || trajectory.payload?.undoneSequence !== decision.undoneSequence
        || trajectory.payload?.restoredDecision !== decision.restoredDecision
        || trajectory.payload?.reason !== decision.reason
        || typeof decision.reason !== "string" || decision.reason.trim().length < 4) {
        throw new Error("Human undo must restore the prior state and exactly match the trajectory");
      }
      ledger.push({
        sequence: index + 1,
        trajectorySequence: trajectory.sequence,
        timestamp: decision.timestamp,
        reviewer: reviewer.id,
        recordId: decision.recordId,
        action: "undo",
        undoneSequence: decision.undoneSequence,
        restoredDecision: decision.restoredDecision,
        reason: decision.reason,
      });
    } else {
      if (trajectory.type !== "human-decision" || trajectory.payload?.decision !== decision.decision) {
        throw new Error("Human decision must exactly match the trajectory");
      }
      ledger.push({
        sequence: index + 1,
        trajectorySequence: trajectory.sequence,
        timestamp: decision.timestamp,
        reviewer: reviewer.id,
        recordId: decision.recordId,
        decision: decision.decision,
        reason: decision.reason ?? null,
      });
    }
  }
  if (decisions[0].recordId === decisions[1].recordId || decisions[1].recordId !== decisions[2].recordId || decisions[1].recordId !== decisions[3].recordId) {
    throw new Error("Human review requires one active approved record and one escalated, undone, then rejected record");
  }
  return ledger;
}

export async function collectHumanReview(options = {}) {
  const root = await realpath(resolve(options.root ?? resolve(import.meta.dirname, "..")));
  const session = await readInputJson(root, options.session, "artifacts/tmp/release-session.json", "release session");
  const revision = await sourceRevisionFromSession(root, session);
  const review = session?.humanReview;
  if (!review || typeof review !== "object" || Array.isArray(review)
    || !SAFE_IDENTIFIER.test(review.runId ?? "") || !/^rev-\d{6}$/.test(review.serverRevision ?? "")) {
    throw new Error("Release session human review must name a run ID and final server revision");
  }
  const current = await readInputJson(root, `artifacts/runs/${review.runId}/current.json`, null, "server current pointer");
  if (current?.schemaVersion !== 1 || current?.runId !== review.runId || current?.revision !== review.serverRevision) {
    throw new Error("Human collection must read the exact final server revision named by current.json and the release session");
  }
  const snapshot = `artifacts/runs/${review.runId}/revisions/${review.serverRevision}`;
  const manifest = await readInputJson(root, `${snapshot}/manifest.json`, null, "server snapshot manifest");
  if (manifest?.schemaVersion !== 1 || manifest?.runId !== review.runId || manifest?.revision !== review.serverRevision
    || manifest?.provider !== "deterministic" || manifest?.status !== "complete") {
    throw new Error("Human collection requires a complete deterministic final server snapshot");
  }
  const decisions = await readInputJson(root, `${snapshot}/decisions.json`, null, "decision ledger");
  const trajectoryBytes = await readBounded(root, `${snapshot}/trajectory.jsonl`, null);
  const trajectory = jsonLines(trajectoryBytes, "human checkpoint trajectory");
  const reviewer = review.reviewer;
  const ledger = validateHumanDecisions(decisions, trajectory, reviewer);
  const exportBytes = await readBounded(root, `${snapshot}/export.csv`, null);
  const exported = parseCsvRecordIds(decodeUtf8(exportBytes, "human CSV export"));
  if (!exported || exported.length !== 1 || exported[0] !== decisions[0].recordId || exported.includes(decisions[3].recordId)) {
    throw new Error("Human CSV export must contain only the active approved record and exclude the rejected record");
  }

  const ledgerBytes = Buffer.from(`${ledger.map((event) => JSON.stringify(event)).join("\n")}\n`);
  const evidence = buildHumanEvidence({
    revision,
    reviewer,
    ledgerPath: "artifacts/qa/human/ledger.jsonl",
    ledgerSha256: sha256Bytes(ledgerBytes),
    exportPath: "artifacts/qa/human/export.csv",
    exportSha256: sha256Bytes(exportBytes),
    trajectoryPath: "artifacts/representative-trajectories/human-checkpoint.jsonl",
    trajectorySha256: sha256Bytes(trajectoryBytes),
  });
  const store = createArtifactStore(root);
  await store.write(evidence.ledgerPath, ledgerBytes);
  await store.write(evidence.exportPath, exportBytes);
  await store.write(evidence.trajectoryPath, trajectoryBytes);
  await store.write("artifacts/qa/human-review.json", `${JSON.stringify(evidence, null, 2)}\n`);
  return evidence;
}

function substantiveDevelopmentPayload(event) {
  const payload = event?.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  let encoded;
  try { encoded = JSON.stringify(payload); } catch { return false; }
  if (encoded.length < 12 || encoded.length > 1_000_000) return false;
  const text = (...keys) => keys.some((key) => typeof payload[key] === "string" && payload[key].trim().length >= 4);
  if (event.type === "instruction") return text("instruction", "prompt", "text");
  if (event.type === "tool-call") return text("tool", "name") && ["arguments", "input", "request"].some((key) => Object.hasOwn(payload, key));
  if (event.type === "tool-result") return text("tool", "name") && (text("result", "output", "summary", "status") || Object.hasOwn(payload, "result") || Object.hasOwn(payload, "output"));
  if (event.type === "feedback") return text("feedback", "review", "comment", "text");
  if (event.type === "verification") return text("command", "check", "verification") && (payload.status === "PASS" || payload.exitCode === 0);
  return true;
}

function validateDevelopmentEvents(events) {
  if (!Array.isArray(events) || events.length < 5) throw new Error("Development export requires at least five events");
  const runId = events[0]?.runId;
  if (!SAFE_IDENTIFIER.test(runId ?? "")) throw new Error("Development export run ID is invalid");
  let previous = -Infinity;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const milliseconds = Date.parse(event?.timestamp ?? "");
    if (!event || typeof event !== "object" || Array.isArray(event) || event.schemaVersion !== 1
      || event.sequence !== index + 1 || event.runId !== runId || event.agent !== "codex" || event.source !== "codex-export"
      || !realTimestamp(event.timestamp) || milliseconds < previous
      || typeof event.type !== "string" || event.type.trim() === "" || !substantiveDevelopmentPayload(event)) {
      throw new Error("Development export requires contiguous sequence, ordered timestamps, one run, Codex identity, and substantive payloads");
    }
    previous = milliseconds;
  }
  const types = new Set(events.map((event) => event.type));
  for (const required of ["instruction", "tool-call", "tool-result", "feedback", "verification"]) {
    if (!types.has(required)) throw new Error(`Development export is missing required ${required} evidence`);
  }
  return runId;
}

export async function collectDevelopmentEvidence(options = {}) {
  const root = await realpath(resolve(options.root ?? resolve(import.meta.dirname, "..")));
  const session = await readInputJson(root, options.session, "artifacts/tmp/release-session.json", "release session");
  const revision = await sourceRevisionFromSession(root, session);
  if (session?.privacyReview?.status !== "PASS") throw new Error("Participant privacy review must be PASS before development evidence publication");
  const sourceBytes = await readBounded(root, options.source, "artifacts/tmp/codex-export.jsonl");
  const events = jsonLines(sourceBytes, "Codex export");
  const runId = validateDevelopmentEvents(events);
  const trajectoryBytes = Buffer.from(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  const manifest = buildDevelopmentManifest({
    revision,
    runId,
    eventCount: events.length,
    trajectoryPath: "artifacts/development-agent/trajectory.jsonl",
    trajectorySha256: sha256Bytes(trajectoryBytes),
    privacyReview: session.privacyReview,
  });
  const store = createArtifactStore(root);
  await store.write(manifest.trajectoryPath, trajectoryBytes);
  await store.write("artifacts/development-agent/manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export async function inspectReleaseVideo(options = {}) {
  const root = await realpath(resolve(options.root ?? resolve(import.meta.dirname, "..")));
  const manifest = await readInputJson(root, "artifacts/evaluation/manifest.json", null, "evaluation manifest");
  if (!isGitObjectId(manifest?.git?.revision)) throw new Error("Video inspection requires a concrete deterministic source revision");
  const path = "artifacts/submission/demo.mp4";
  const bytes = await readBounded(root, path, null, 512 * 1024 * 1024);
  const inspected = inspectMp4(bytes);
  const metadata = {
    revision: manifest.git.revision,
    path,
    sha256: sha256Bytes(bytes),
    durationSeconds: inspected.durationSeconds,
    width: inspected.width,
    height: inspected.height,
    codec: inspected.codec,
    videoSampleCount: inspected.sampleCount,
    mediaBytes: inspected.mediaBytes,
  };
  const print = options.print ?? ((value) => process.stdout.write(value));
  if (typeof print !== "function") throw new Error("Video inspection print option must be callable");
  print(`${JSON.stringify(metadata, null, 2)}\n`);
  return metadata;
}

function sameJson(left, right) {
  const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
    return value;
  };
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

async function commandRecordsForComposition(root, revision) {
  const records = [];
  for (const required of REQUIRED_RELEASE_COMMANDS) {
    const outputPath = `artifacts/qa/commands/${required.id}.json`;
    const bytes = await readBounded(root, outputPath, null);
    let evidence;
    try { evidence = JSON.parse(decodeUtf8(bytes, "release command evidence")); } catch { throw new Error(`Command evidence for ${required.command} must be valid JSON`); }
    const commandInput = {
      revision: evidence?.revision,
      command: evidence?.command,
      startedAt: evidence?.startedAt,
      endedAt: evidence?.endedAt,
      exitCode: evidence?.exitCode,
      ...(Object.hasOwn(evidence ?? {}, "output")
        ? { output: evidence.output }
        : {
            summary: evidence?.summary,
            stdoutSha256: evidence?.stdoutSha256,
            stderrSha256: evidence?.stderrSha256,
            stdoutBytes: evidence?.stdoutBytes,
            stderrBytes: evidence?.stderrBytes,
          }),
    };
    const rebuilt = buildCommandEvidence(commandInput);
    if (evidence?.schemaVersion !== 1 || evidence?.artifactKind !== "rubricdelta-qa-command"
      || evidence?.status !== "PASS" || evidence.revision !== revision || evidence.command !== required.command
      || !sameJson(evidence, rebuilt)) {
      throw new Error(`Command evidence for ${required.command} is not a revision-bound PASS record`);
    }
    records.push({
      id: required.id,
      revision,
      command: required.command,
      status: "PASS",
      exitCode: 0,
      startedAt: evidence.startedAt,
      endedAt: evidence.endedAt,
      outputPath,
      outputSha256: sha256Bytes(bytes),
    });
  }
  return records;
}

async function priorEvidenceForComposition(root, revision, session) {
  const human = await readInputJson(root, "artifacts/qa/human-review.json", null, "human review evidence");
  const rebuiltHuman = buildHumanEvidence({
    revision: human?.revision,
    reviewer: human?.reviewer,
    ledgerPath: human?.ledgerPath,
    ledgerSha256: human?.ledgerSha256,
    exportPath: human?.exportPath,
    exportSha256: human?.exportSha256,
    trajectoryPath: human?.trajectoryPath,
    trajectorySha256: human?.trajectorySha256,
  });
  if (human.revision !== revision || human.reviewer?.id !== session?.humanReview?.reviewer?.id || !sameJson(human, rebuiltHuman)) {
    throw new Error("Human review evidence must bind the release revision and participant session");
  }
  for (const [path, expectedHash] of [
    [human.ledgerPath, human.ledgerSha256],
    [human.exportPath, human.exportSha256],
    [human.trajectoryPath, human.trajectorySha256],
  ]) {
    if (sha256Bytes(await readBounded(root, path, null)) !== expectedHash) throw new Error("Human review evidence hash does not match its collected bytes");
  }

  const development = await readInputJson(root, "artifacts/development-agent/manifest.json", null, "development manifest");
  const rebuiltDevelopment = buildDevelopmentManifest({
    revision: development?.revision,
    runId: development?.runId,
    eventCount: development?.eventCount,
    trajectoryPath: development?.trajectoryPath,
    trajectorySha256: development?.trajectorySha256,
    privacyReview: development?.privacyReview,
  });
  if (development.revision !== revision || !sameJson(development, rebuiltDevelopment)
    || !sameJson(development.privacyReview, session.privacyReview)
    || sha256Bytes(await readBounded(root, development.trajectoryPath, null)) !== development.trajectorySha256) {
    throw new Error("Development evidence must bind the privacy-reviewed release session and exact trajectory bytes");
  }
  return { human, development };
}

function requireParticipantGates(session) {
  if (session?.privacyReview?.status !== "PASS") throw new Error("Participant privacy review must be PASS before release composition");
  if (session?.video?.upload?.status !== "accepted") throw new Error("Participant video upload acceptance is required before release composition");
  if (session?.video?.playback?.status !== "PASS" || session?.video?.playback?.renderedFrameObserved !== true) {
    throw new Error("Participant playback PASS with a rendered frame is required before release composition");
  }
  if (session?.eligibility?.status !== "PASS" || session.eligibility.ageAndEligibilityConfirmed !== true
    || session.eligibility.individualEntryConfirmed !== true || session.eligibility.accurateRegistrationConfirmed !== true
    || session.eligibility.payoutEligibilityUnderstood !== true) {
    throw new Error("Participant eligibility and individual-entry confirmation is required before release composition");
  }
  if (session?.rightsReview?.status !== "PASS" || session.rightsReview.originalityConfirmed !== true
    || session.rightsReview.licenseComplianceConfirmed !== true || session.rightsReview.dataRightsConfirmed !== true
    || session.rightsReview.credentialsAndPrivateDataExcluded !== true
    || typeof session.rightsReview.preExistingWork !== "string" || session.rightsReview.preExistingWork.trim() === "") {
    throw new Error("Participant originality, license, and data-rights review is required before release composition");
  }
  if (session?.decision?.value !== "approve release" || session?.decision?.actor !== "participant") {
    throw new Error("Participant-owned approve release decision is required before release composition");
  }
}

function verifyParticipantVideoFacts(session, metadata) {
  const facts = session?.video?.inspection;
  const expected = {
    sha256: metadata.sha256,
    durationSeconds: metadata.durationSeconds,
    width: metadata.width,
    height: metadata.height,
    codec: metadata.codec,
    videoSampleCount: metadata.videoSampleCount,
  };
  if (!sameJson(facts, expected)) throw new Error("Participant-recorded video inspection facts must match the actual MP4 bytes");
}

function participantAttestation(session, revision) {
  return {
    schemaVersion: 1,
    artifactKind: "rubricdelta-participant-attestation",
    revision,
    eligibility: structuredClone(session.eligibility),
    rightsReview: structuredClone(session.rightsReview),
    decision: { value: "approve release", actor: "participant" },
  };
}

export async function composeRelease(options = {}) {
  const root = await realpath(resolve(options.root ?? resolve(import.meta.dirname, "..")));
  const session = await readInputJson(root, options.session, "artifacts/tmp/release-session.json", "release session");
  const revision = await sourceRevisionFromSession(root, session);
  requireParticipantGates(session);
  if (!session.categories || typeof session.categories !== "object" || Array.isArray(session.categories)
    || Object.keys(session.categories).length !== QA_CATEGORIES.length
    || Object.keys(session.categories).some((category) => !QA_CATEGORIES.includes(category))) {
    throw new Error("Release session must contain exactly all eleven QA categories");
  }

  const commands = await commandRecordsForComposition(root, revision);
  await priorEvidenceForComposition(root, revision, session);
  const videoMetadata = await inspectReleaseVideo({ root, print() {} });
  if (videoMetadata.revision !== revision) throw new Error("Video inspection revision must match the release revision");
  verifyParticipantVideoFacts(session, videoMetadata);

  const categoryArtifacts = [];
  const categoryRecords = {};
  for (const category of QA_CATEGORIES) {
    const input = session.categories[category];
    const evidence = buildCategoryEvidence({
      revision,
      category,
      timestamp: input?.timestamp,
      tool: input?.tool,
      coverage: input?.coverage,
      status: input?.status,
    });
    const bytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`);
    const evidencePath = `artifacts/qa/categories/${category}.json`;
    categoryArtifacts.push({ evidencePath, bytes });
    categoryRecords[category] = {
      revision,
      status: "PASS",
      evidencePath,
      evidenceSha256: sha256Bytes(bytes),
    };
  }

  const playback = session.video.playback;
  const video = buildVideoEvidence({
    revision,
    sha256: videoMetadata.sha256,
    durationSeconds: videoMetadata.durationSeconds,
    width: videoMetadata.width,
    height: videoMetadata.height,
    codec: videoMetadata.codec,
    videoSampleCount: videoMetadata.videoSampleCount,
    upload: { status: session.video.upload.status },
    playback: {
      status: playback.status,
      revision,
      testedAt: playback.testedAt,
      tool: playback.tool,
      renderedFrameObserved: playback.renderedFrameObserved,
      evidencePath: categoryRecords.video.evidencePath,
      evidenceSha256: categoryRecords.video.evidenceSha256,
    },
  });
  const release = buildReleaseEvidence({
    revision,
    categories: categoryRecords,
    commands,
    decision: session.decision,
  });
  const attestation = participantAttestation(session, revision);
  const readme = `# RubricDelta final release QA\n\nAll eleven structured QA categories passed at source revision ${revision}. Browser and keyboard checks covered the complete fixed-benchmark workflow, visible focus, shortcuts, exports, and the Rule Seam. Accessibility checks covered semantic landmarks, labels, live status, reduced motion, and status text that does not rely on color. Responsive checks covered mobile viewport 375 x 812, tablet viewport 768 x 1024, and desktop viewport 1440 x 900 without hidden decision controls or horizontal overflow. Security, clean-checkout, human-review, development-agent, video, automated-command, and participant release gates are hash-bound in the adjacent JSON evidence.\n`;

  const store = createArtifactStore(root);
  for (const artifact of categoryArtifacts) await store.write(artifact.evidencePath, artifact.bytes);
  await store.write("artifacts/qa/video.json", `${JSON.stringify(video, null, 2)}\n`);
  await store.write("artifacts/qa/participant-attestation.json", `${JSON.stringify(attestation, null, 2)}\n`);
  await store.write("artifacts/qa/session.json", `${JSON.stringify(session, null, 2)}\n`);
  await store.write("artifacts/qa/README.md", readme);
  await store.write("artifacts/qa/release.json", `${JSON.stringify(release, null, 2)}\n`);
  return release;
}

function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.length === 0) throw new Error("A release evidence subcommand is required");
  const command = argv[0];
  const allowedByCommand = new Map([
    ["commands", new Set(["--root"])],
    ["human", new Set(["--root", "--session"])],
    ["development", new Set(["--root", "--session", "--source"])],
    ["video-check", new Set(["--root"])],
    ["compose", new Set(["--root", "--session"])],
  ]);
  const allowed = allowedByCommand.get(command);
  if (!allowed) throw new Error("Unknown release evidence subcommand");
  const options = {};
  const fields = new Map([["--root", "root"], ["--session", "session"], ["--source", "source"]]);
  const seen = new Set();
  for (let index = 1; index < argv.length; index += 1) {
    const separator = argv[index].indexOf("=");
    const flag = separator === -1 ? argv[index] : argv[index].slice(0, separator);
    if (!allowed.has(flag) || !fields.has(flag) || seen.has(flag)) throw new Error("Unknown or duplicate release evidence option");
    seen.add(flag);
    const inline = separator === -1 ? undefined : argv[index].slice(separator + 1);
    const value = inline ?? argv[index + 1];
    if (!value || (inline === undefined && value.startsWith("--"))) throw new Error("Release evidence option requires a value");
    if (inline === undefined) index += 1;
    options[fields.get(flag)] = value;
  }
  return { command, options };
}

export async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArguments(argv);
  let result;
  if (command === "commands") result = await runCommandSuite(options);
  else if (command === "human") result = await collectHumanReview(options);
  else if (command === "development") result = await collectDevelopmentEvidence(options);
  else if (command === "video-check") return inspectReleaseVideo(options);
  else result = await composeRelease(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

const directPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (directPath && directPath.toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  main().catch(() => {
    process.stderr.write("Release evidence failed: bounded fail-closed collector error\n");
    process.exitCode = 1;
  });
}
