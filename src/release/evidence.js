import { createHash } from "node:crypto";

export const REQUIRED_RELEASE_COMMANDS = Object.freeze([
  { id: "npm-test", command: "npm test" },
  { id: "npm-run-eval", command: "npm run eval" },
  { id: "npm-run-replay-check", command: "npm run replay:check" },
  { id: "npm-run-eval-replay", command: "npm run eval:replay" },
  { id: "npm-run-evidence", command: "npm run evidence" },
  { id: "npm-run-validate", command: "npm run validate" },
  { id: "git-diff-check", command: "git diff --check" },
]);

export const QA_CATEGORIES = Object.freeze([
  "automated", "browser", "keyboard", "accessibility", "responsive",
  "security", "cleanCheckout", "humanReview", "video",
  "developmentAgent", "release",
]);

const RFC3339_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const GIT_REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SHA256 = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{3,120}$/;
const BANNED_REVIEWER = /hackathon-evidence-generator|agent|codex/i;
const PENDING_SENTINEL = /\b(?:PENDING|NOT RUN)\b/i;
const COMMANDS_BY_NAME = new Map(REQUIRED_RELEASE_COMMANDS.map((item) => [item.command, item]));
const CATEGORY_SET = new Set(QA_CATEGORIES);

function fail(kind, message) {
  throw new Error(`Invalid ${kind}: ${message}`);
}

function plain(value) {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactObject(value, fields, kind) {
  if (!plain(value) || Object.getOwnPropertySymbols(value).length > 0) fail(kind, "must be a plain object");
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value") || !fields.has(key)) {
      fail(kind, `has unknown field ${key}`);
    }
  }
  return value;
}

function nonblank(value, kind, field, { minimum = 1, maximum = 1_000_000 } = {}) {
  if (typeof value !== "string" || value.trim().length < minimum || value.length > maximum) {
    fail(kind, `${field} must be a nonblank bounded string`);
  }
  return value;
}

function revision(value, kind = "evidence") {
  if (typeof value !== "string" || !GIT_REVISION.test(value)) fail(kind, "revision must be a concrete 40- or 64-hex Git revision");
  return value;
}

function timestamp(value, kind, field) {
  const milliseconds = typeof value === "string" && RFC3339_TIMESTAMP.test(value) ? Date.parse(value) : NaN;
  if (!Number.isFinite(milliseconds)) fail(kind, `${field} must be an RFC3339 UTC timestamp`);
  const normalized = new Date(milliseconds).toISOString();
  if (value !== normalized && value !== normalized.replace(".000Z", "Z")) fail(kind, `${field} must be a real RFC3339 UTC timestamp`);
  return value;
}

function sha256(value, kind, field) {
  if (typeof value !== "string" || !SHA256.test(value)) fail(kind, `${field} must be a SHA-256 hash`);
  return value;
}

function participant(value, kind) {
  exactObject(value, new Set(["kind", "id"]), `${kind} reviewer`);
  if (value.kind !== "participant") fail(kind, "reviewer kind must be participant");
  nonblank(value.id, kind, "reviewer id", { minimum: 2, maximum: 120 });
  if (BANNED_REVIEWER.test(value.id)) fail(kind, "reviewer id must identify the participant, not Codex, an agent, or a generator");
  return { kind: "participant", id: value.id };
}

function canonicalPath(value, expected, kind, field) {
  if (value !== expected) fail(kind, `${field} must be ${expected}`);
  return value;
}

export function sha256Bytes(value) {
  if (typeof value !== "string" && !Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    fail("hash input", "value must be a string or bytes");
  }
  return createHash("sha256").update(value).digest("hex");
}

export function buildCommandEvidence(input) {
  const kind = "command evidence";
  exactObject(input, new Set([
    "revision", "command", "startedAt", "endedAt", "exitCode", "output", "summary",
    "stdoutSha256", "stderrSha256", "stdoutBytes", "stderrBytes",
  ]), kind);
  revision(input.revision, kind);
  if (!COMMANDS_BY_NAME.has(input.command)) fail(kind, "command is not in the release allowlist");
  timestamp(input.startedAt, kind, "startedAt");
  timestamp(input.endedAt, kind, "endedAt");
  if (Date.parse(input.endedAt) < Date.parse(input.startedAt)) fail(kind, "endedAt must not precede startedAt");
  if (input.exitCode !== 0) fail(kind, "exitCode must be zero before PASS evidence can be built");
  const hasOutput = Object.hasOwn(input, "output");
  const hasSummary = Object.hasOwn(input, "summary");
  if (hasOutput === hasSummary) fail(kind, "exactly one of output or summary is required");
  const result = {
    schemaVersion: 1,
    artifactKind: "rubricdelta-qa-command",
    revision: input.revision,
    command: input.command,
    status: "PASS",
    exitCode: 0,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
  };
  if (hasOutput) {
    nonblank(input.output, kind, "output", { maximum: 1_000_000 });
    if (PENDING_SENTINEL.test(input.output)) fail(kind, "output cannot publish PENDING or NOT RUN text as PASS evidence");
    result.output = input.output;
  } else {
    nonblank(input.summary, kind, "summary", { maximum: 1_000 });
    if (PENDING_SENTINEL.test(input.summary)) fail(kind, "summary cannot publish PENDING or NOT RUN text as PASS evidence");
    sha256(input.stdoutSha256, kind, "stdoutSha256");
    sha256(input.stderrSha256, kind, "stderrSha256");
    if (!Number.isInteger(input.stdoutBytes) || input.stdoutBytes < 0 || !Number.isInteger(input.stderrBytes) || input.stderrBytes < 0) {
      fail(kind, "stdoutBytes and stderrBytes must be nonnegative integers");
    }
    Object.assign(result, {
      summary: input.summary,
      stdoutSha256: input.stdoutSha256,
      stderrSha256: input.stderrSha256,
      stdoutBytes: input.stdoutBytes,
      stderrBytes: input.stderrBytes,
    });
  }
  return result;
}

export function buildCategoryEvidence(input) {
  const kind = "category evidence";
  exactObject(input, new Set(["revision", "category", "timestamp", "tool", "coverage", "status"]), kind);
  revision(input.revision, kind);
  if (!CATEGORY_SET.has(input.category)) fail(kind, "category is not recognized");
  timestamp(input.timestamp, kind, "timestamp");
  nonblank(input.tool, kind, "tool", { minimum: 2, maximum: 200 });
  if (Object.hasOwn(input, "status") && input.status !== "PASS") fail(kind, "status must be PASS");
  if (!Array.isArray(input.coverage) || input.coverage.length === 0) fail(kind, "coverage must contain at least one item");
  const coverage = input.coverage.map((item) => nonblank(item, kind, "coverage item", { minimum: 4, maximum: 1_000 }));
  if (coverage.some((item) => PENDING_SENTINEL.test(item))) fail(kind, "coverage cannot publish PENDING or NOT RUN text as PASS evidence");
  return {
    schemaVersion: 1,
    artifactKind: "rubricdelta-qa-category",
    revision: input.revision,
    category: input.category,
    timestamp: input.timestamp,
    tool: input.tool,
    coverage,
    status: "PASS",
  };
}

export function buildHumanEvidence(input) {
  const kind = "human evidence";
  exactObject(input, new Set([
    "revision", "reviewer", "ledgerPath", "ledgerSha256", "exportPath", "exportSha256",
    "trajectoryPath", "trajectorySha256",
  ]), kind);
  revision(input.revision, kind);
  const reviewer = participant(input.reviewer, kind);
  canonicalPath(input.ledgerPath, "artifacts/qa/human/ledger.jsonl", kind, "ledgerPath");
  canonicalPath(input.exportPath, "artifacts/qa/human/export.csv", kind, "exportPath");
  canonicalPath(input.trajectoryPath, "artifacts/representative-trajectories/human-checkpoint.jsonl", kind, "trajectoryPath");
  sha256(input.ledgerSha256, kind, "ledgerSha256");
  sha256(input.exportSha256, kind, "exportSha256");
  sha256(input.trajectorySha256, kind, "trajectorySha256");
  return {
    schemaVersion: 1,
    artifactKind: "rubricdelta-human-review-evidence",
    revision: input.revision,
    reviewer,
    ledgerPath: input.ledgerPath,
    ledgerSha256: input.ledgerSha256,
    exportPath: input.exportPath,
    exportSha256: input.exportSha256,
    trajectoryPath: input.trajectoryPath,
    trajectorySha256: input.trajectorySha256,
  };
}

export function buildDevelopmentManifest(input) {
  const kind = "development manifest";
  exactObject(input, new Set([
    "revision", "runId", "eventCount", "trajectoryPath", "trajectorySha256", "privacyReview",
  ]), kind);
  revision(input.revision, kind);
  if (typeof input.runId !== "string" || !IDENTIFIER.test(input.runId)) fail(kind, "runId is invalid");
  if (!Number.isInteger(input.eventCount) || input.eventCount < 5) fail(kind, "eventCount must be at least five");
  canonicalPath(input.trajectoryPath, "artifacts/development-agent/trajectory.jsonl", kind, "trajectoryPath");
  sha256(input.trajectorySha256, kind, "trajectorySha256");
  exactObject(input.privacyReview, new Set(["status", "reviewer", "reviewedAt"]), "privacy review");
  if (input.privacyReview.status !== "PASS") fail(kind, "privacy review status must be PASS");
  const reviewer = participant(input.privacyReview.reviewer, "privacy review");
  timestamp(input.privacyReview.reviewedAt, kind, "privacyReview.reviewedAt");
  return {
    schemaVersion: 1,
    artifactKind: "rubricdelta-development-agent-evidence",
    revision: input.revision,
    source: "codex-export",
    agent: "codex",
    runId: input.runId,
    eventCount: input.eventCount,
    trajectoryPath: input.trajectoryPath,
    trajectorySha256: input.trajectorySha256,
    privacyReview: {
      status: "PASS",
      reviewer,
      reviewedAt: input.privacyReview.reviewedAt,
    },
  };
}

export function buildVideoEvidence(input) {
  const kind = "video evidence";
  exactObject(input, new Set([
    "revision", "sha256", "durationSeconds", "width", "height", "codec", "videoSampleCount",
    "upload", "playback",
  ]), kind);
  revision(input.revision, kind);
  sha256(input.sha256, kind, "sha256");
  if (!Number.isFinite(input.durationSeconds) || input.durationSeconds <= 0 || input.durationSeconds > 300) fail(kind, "durationSeconds must be within 300 seconds");
  if (!Number.isInteger(input.width) || input.width < 1 || !Number.isInteger(input.height) || input.height < 1) fail(kind, "width and height must be positive integers");
  if (!["avc1", "avc3"].includes(input.codec)) fail(kind, "codec must be AVC");
  if (!Number.isInteger(input.videoSampleCount) || input.videoSampleCount < 1) fail(kind, "videoSampleCount must be positive");
  exactObject(input.upload, new Set(["status"]), "video upload");
  if (input.upload.status !== "accepted") fail(kind, "upload status must be accepted");
  exactObject(input.playback, new Set([
    "status", "revision", "testedAt", "tool", "renderedFrameObserved", "evidencePath", "evidenceSha256",
  ]), "video playback");
  if (input.playback.status !== "PASS" || input.playback.renderedFrameObserved !== true) fail(kind, "playback must be PASS with a rendered frame observed");
  if (input.playback.revision !== input.revision) fail(kind, "playback revision must match the video revision");
  timestamp(input.playback.testedAt, kind, "playback.testedAt");
  nonblank(input.playback.tool, kind, "playback.tool", { minimum: 2, maximum: 200 });
  canonicalPath(input.playback.evidencePath, "artifacts/qa/categories/video.json", kind, "playback.evidencePath");
  sha256(input.playback.evidenceSha256, kind, "playback.evidenceSha256");
  return {
    schemaVersion: 1,
    artifactKind: "rubricdelta-video-evidence",
    revision: input.revision,
    sha256: input.sha256,
    durationSeconds: input.durationSeconds,
    width: input.width,
    height: input.height,
    codec: input.codec,
    videoSampleCount: input.videoSampleCount,
    upload: { status: "accepted" },
    playback: structuredClone(input.playback),
  };
}

function validateCategoryRecord(value, category, expectedRevision, paths) {
  const kind = "release category";
  exactObject(value, new Set(["revision", "status", "evidencePath", "evidenceSha256"]), kind);
  if (value.revision !== expectedRevision) fail(kind, `${category} revision must match the release revision`);
  if (value.status !== "PASS") fail(kind, `${category} status must be PASS`);
  canonicalPath(value.evidencePath, `artifacts/qa/categories/${category}.json`, kind, "evidencePath");
  if (paths.has(value.evidencePath)) fail(kind, "evidence paths must be unique; duplicate path found");
  paths.add(value.evidencePath);
  sha256(value.evidenceSha256, kind, "evidenceSha256");
  return structuredClone(value);
}

function validateCommandRecord(value, required, expectedRevision, paths) {
  const kind = "release command";
  exactObject(value, new Set([
    "id", "revision", "command", "status", "exitCode", "startedAt", "endedAt", "outputPath", "outputSha256",
  ]), kind);
  if (value.id !== required.id || value.command !== required.command) fail(kind, `record must bind ${required.command}`);
  if (value.revision !== expectedRevision) fail(kind, "revision must match the release revision");
  if (value.status !== "PASS" || value.exitCode !== 0) fail(kind, "status must be PASS with exitCode zero");
  timestamp(value.startedAt, kind, "startedAt");
  timestamp(value.endedAt, kind, "endedAt");
  if (Date.parse(value.endedAt) < Date.parse(value.startedAt)) fail(kind, "endedAt must not precede startedAt");
  canonicalPath(value.outputPath, `artifacts/qa/commands/${required.id}.json`, kind, "outputPath");
  if (paths.has(value.outputPath)) fail(kind, "output paths must be unique; duplicate path found");
  paths.add(value.outputPath);
  sha256(value.outputSha256, kind, "outputSha256");
  return structuredClone(value);
}

export function buildReleaseEvidence(input) {
  const kind = "release evidence";
  exactObject(input, new Set(["revision", "categories", "commands", "decision"]), kind);
  revision(input.revision, kind);
  exactObject(input.decision, new Set(["value", "actor"]), "release decision");
  if (input.decision.value !== "approve release" || input.decision.actor !== "participant") {
    fail(kind, "participant-owned approve release decision is required");
  }
  exactObject(input.categories, new Set(QA_CATEGORIES), "release categories");
  const categoryPaths = new Set();
  const categories = {};
  for (const category of QA_CATEGORIES) {
    if (!Object.hasOwn(input.categories, category)) fail(kind, `category ${category} is required`);
    categories[category] = validateCategoryRecord(input.categories[category], category, input.revision, categoryPaths);
  }
  if (!Array.isArray(input.commands) || input.commands.length !== REQUIRED_RELEASE_COMMANDS.length) {
    fail(kind, "commands must contain exactly the seven required command records");
  }
  const byCommand = new Map();
  for (const record of input.commands) {
    if (!plain(record) || typeof record.command !== "string" || byCommand.has(record.command)) fail(kind, "commands contain a duplicate or invalid record");
    byCommand.set(record.command, record);
  }
  const commandPaths = new Set();
  const commands = REQUIRED_RELEASE_COMMANDS.map((required) => {
    const record = byCommand.get(required.command);
    if (!record) fail(kind, `command ${required.command} is required`);
    return validateCommandRecord(record, required, input.revision, commandPaths);
  });
  return {
    schemaVersion: 1,
    artifactKind: "rubricdelta-release-qa",
    revision: input.revision,
    categories,
    commands,
    decision: { value: "approve release", actor: "participant" },
  };
}
