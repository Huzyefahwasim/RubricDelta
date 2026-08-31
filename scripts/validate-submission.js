#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluatePredictions, loadBenchmark } from "../src/evaluation/index.js";
import { canonicalTextSha256 } from "../src/evaluation/evidence-hash.js";
import { EVALUATION_PROTOCOL } from "../src/evaluation/protocol.js";
import {
  containsCredentialLikeText,
  redactCredentialLikeText,
} from "../src/domain/credentials.js";
import {
  QA_CATEGORIES,
  REQUIRED_RELEASE_COMMANDS,
  buildCategoryEvidence,
  buildCommandEvidence,
  buildCommandSuite,
  buildDevelopmentManifest,
  buildHumanEvidence,
  buildParticipantAttestation,
  buildReleaseEvidence,
  buildReleaseSession,
  buildVideoEvidence,
} from "../src/release/evidence.js";
import {
  isGitObjectId,
  parseGitIndexState,
  parseGitPathList,
  parseGitStatus,
  parseRawCommitChanges,
  portableGitPathSet,
} from "./git-provenance.js";

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_REPLAY_BYTES = 8 * 1024 * 1024;
// Keep every validator diagnostic safe for one-line terminal and log consumers.
const MAX_DIAGNOSTIC_CHARACTERS = 512;
const GOLD_FIELDS = /groundTruth|affectedRecordIds|expectedLabels|rationales/i;
const ROLE_SET = new Set(["rule-compiler", "change-analyst", "impact-investigator", "skeptical-verifier", "orchestrator"]);
const PROVIDER_ROLES = ["rule-compiler", "change-analyst", "impact-investigator", "independent-verifier"];
const MODEL = "deterministic-role-capture-v1";
const FIXTURE_PATH = "data/benchmark/replay/rubricdelta-deterministic-source.v1.json";
const REPLAY_CHECK_SCRIPT = "node scripts/capture-replay.js --check";
const OPERATIONAL_REPLAY_PATH = "artifacts/expected-replay-report/operational-replay";
const EVAL_REPLAY_SCRIPT = "node scripts/evaluate.js --provider replay --replay-fixture data/benchmark/replay/rubricdelta-deterministic-source.v1.json --mode both --repeats 1 --output-dir artifacts/runs/provider-replay";
const TASK9_DEFERRED_PATHS = Object.freeze([
  "docs/MAIN_FAILURE_MODE.md",
  "docs/HOT_TAKE.md",
  "docs/MODEL_AND_COSTS.md",
  "artifacts/qa/README.md",
  "artifacts/submission/demo.mp4",
]);
const EVALUATION_PROTOCOL_LABEL = `protocol-v${EVALUATION_PROTOCOL.version}`;
const PROMPTS = Object.freeze({
  "change-analyst": "change-analyst.v1.md",
  "direct-baseline": "direct-baseline.v1.md",
  "impact-investigator": "impact-investigator.v1.md",
  "independent-verifier": "independent-verifier.v1.md",
  "rule-compiler": "rule-compiler.v1.md",
});
const CAPTURE_SOURCE_FILES = Object.freeze([
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
]);
const TASK8_TEST_HASHES = new Map([
  ["tests/providers.test.js", "f88fc2cfa0a18b5d613d4a19f1ec8cd56c3f71f4a0c3f2091ab47b3a02f320d8"],
  ["tests/providers-hardening.test.js", "5d2252ac1ae9b9b0229d9ee277efd5f1ff2ba3e4a778462a092df6fd1c61c05f"],
  ["tests/providers-release-hardening.test.js", "fc341c61818a39a56755eae7c532415dde1ce61d9f2c9c8a386e07cc9c32d8bb"],
  ["tests/openai-release-hardening.test.js", "b4aaf4d1a6fe0ed387a4b9a47e88885e110affdfa8bf2cb6ad1af34c8e3f0338"],
  ["tests/openai-telemetry-hardening.test.js", "d52faa64614c67678945310a8cd9fc87e3972613f28d8ac5641dc6e4aba3fc4d"],
  ["tests/replay-boundaries.test.js", "d2e4164b2f330b45c9350ae6dabc4445fe3d1e1901b82cbda14c584dc79bd029"],
  ["tests/replay-prevalidation-hardening.test.js", "b3149d9cfad4fd7a15fca6b7d5e772ec036698cd9ebcbe8bf8b76073338de1dc"],
  ["tests/provider-evaluation.test.js", "df707278eeb3cc71b120be13ed58973dc426f87276b7b4b4b703ca24a193ef67"],
  ["tests/provider-artifact-boundary.test.js", "ed9040889d814dec4fd4a4d9132ee1fb4b60bcb17d328a38b6a131de51ea5384"],
  ["tests/provider-benchmark-prevalidation.test.js", "c4d87157ace9d11280f7dcaf66b3818b9bf9d813b22ad0d9451bed1d0ab75e35"],
  ["tests/provider-evidence-explanation.test.js", "86e0bc415ec6821228b129e8c91aa23e26b0d1512ea539917712ad4205590d6e"],
  ["tests/provider-rulings-contract.test.js", "40b8bbb3089cc35c164790a7fa4a28b85707300e597faab3c88e8e57a37b2393"],
  ["tests/provider-scenario-prevalidation.test.js", "4c0bf2b8a7b46ab1074f82dbf6418308a421fb78d9612845b4ef0064f7d2fbee"],
  ["tests/provider-semantic-grouping.test.js", "ccf82bad2c3a8715033b46730b3c40ff83350cbb3c37d68c296fc30501a3cb7d"],
  ["tests/provider-telemetry-redaction.test.js", "8e3985850134a482963bae9ba10cad5accbf7567202d960d1b95a82d4d8cdb06"],
  ["tests/provider-workflow-hardening.test.js", "923ed321bd611a08f64631695412ad6343257c3b5a05e1026c5339c5584ca722"],
  ["tests/provider-workflow-release-hardening.test.js", "e185b3ecfab2c7ed068b80e340ecbfcea6294d22b3c5b963c38db125233da422"],
  ["tests/provider-workflow-semantic-hardening.test.js", "9c7d3bf1093275273b638b8520c0ac47361c271de0c2de7bf89a66c37d112911"],
  ["tests/provider-workflow-semantic-review.test.js", "51310cf04e326bdf297acd075a31c0ba7ab265c7ff3354d0679155cc0d2f330f"],
  ["tests/task8-cli.test.js", "598ffe34ce50fb89586ba1cb87e00c9d934b117d51e86bf25fa1905dace9db8d"],
  ["tests/task8-source-contract.test.js", "07ca1d4e2fa76b12a2bdd44ed7ebb23a7c52d11e2c4ce9c5add942b155e3a1b6"],
  ["tests/capture-replay.test.js", "7eb5fb3476d8951955f63010241e0e055351248bc79cece6103f37c1c3769e3a"],
]);
const TASK8_JS_PATHS = Object.freeze([
  "scripts/capture-replay.js",
  "scripts/evaluate.js",
  "scripts/provider-evaluation-artifacts.js",
  "src/providers/contracts.js",
  "src/providers/openai.js",
  "src/providers/replay.js",
  "src/agents/prompt-registry.js",
  "src/agents/provider-schemas.js",
  "src/agents/provider-trace.js",
  "src/agents/provider-validation.js",
  "src/agents/provider-workflow.js",
  "src/evaluation/provider-predictions.js",
  ...TASK8_TEST_HASHES.keys(),
]);
const MANAGED_EVIDENCE_ROOTS = Object.freeze([
  "artifacts/evaluation/",
  "artifacts/representative-trajectories/",
  "artifacts/expected-replay-report/",
  "artifacts/qa/",
  "artifacts/submission/",
  "artifacts/development-agent/",
]);
const SAFE_GIT_FILE_MODES = new Set(["000000", "100644", "100755"]);
const HISTORICAL_GENERATION_STATE = Object.freeze({
  wholeWorkingTreeDirty: true,
  sourceTrackedWorkingTreeDirty: false,
  sourceUntrackedWorkingTreeDirty: false,
  sourceWorkingTreeDirty: false,
  managedArtifactDirty: true,
});
function parseArguments(argv) {
  let mode = "build";
  let root = scriptRoot;
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const separator = argument.indexOf("=");
    const flag = separator === -1 ? argument : argument.slice(0, separator);
    if (!["--mode", "--root"].includes(flag)) throw new Error(`Unknown argument: ${flag}`);
    if (seen.has(flag)) throw new Error(`Duplicate argument: ${flag}`);
    seen.add(flag);
    const inline = separator === -1 ? undefined : argument.slice(separator + 1);
    const value = inline ?? argv[index + 1];
    if (!value || (inline === undefined && value.startsWith("--"))) throw new Error(`${flag} requires a value`);
    if (inline === undefined) index += 1;
    if (flag === "--mode") mode = value;
    else root = resolve(value);
  }
  if (!["build", "final-strict"].includes(mode)) throw new Error("--mode must be build or final-strict");
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error("--root must name an existing directory");
  return { mode, root: realpathSync(root) };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalLf(value) {
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function sameJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function posix(path) {
  return path.replaceAll("\\", "/");
}

function rel(root, path) {
  return posix(relative(root, path));
}

function isWithin(root, path) {
  const value = relative(root, path);
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

function readBounded(path, maximum = MAX_JSON_BYTES) {
  const handle = openSync(path, "r");
  try {
    const stat = fstatSync(handle);
    if (!stat.isFile() || stat.size > maximum) throw new Error("bounded file limit exceeded");
    const buffer = Buffer.alloc(Math.min(maximum + 1, stat.size + 1));
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(handle, buffer, offset, buffer.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset > maximum || readSync(handle, Buffer.alloc(1), 0, 1, null) !== 0) throw new Error("bounded file limit exceeded");
    return buffer.subarray(0, offset);
  } finally {
    closeSync(handle);
  }
}

function decodeUtf8(buffer) {
  return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
}

function containsSecret(value) {
  const source = Buffer.isBuffer(value) ? value.toString("latin1") : String(value);
  return containsCredentialLikeText(source);
}

function sanitizeDiagnostic(value) {
  const singleLine = redactCredentialLikeText(String(value))
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/gu, " ")
    .replace(/\p{Bidi_Control}+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (singleLine.length <= MAX_DIAGNOSTIC_CHARACTERS) return singleLine;
  const marker = " ... ";
  const available = MAX_DIAGNOSTIC_CHARACTERS - marker.length;
  const headLength = Math.ceil(available / 2);
  const tailLength = available - headLength;
  return `${singleLine.slice(0, headLength)}${marker}${singleLine.slice(-tailLength)}`;
}

class Validation {
  constructor(root) {
    this.root = root;
    this.errors = [];
    this.passes = [];
  }

  fail(kind, path, detail) {
    const location = typeof path === "string" && isAbsolute(path) ? rel(this.root, path) : path;
    this.errors.push(sanitizeDiagnostic(`${kind}: ${location}${detail ? ` — ${detail}` : ""}`));
  }

  pass(detail) {
    this.passes.push(detail);
  }

  passIfClean(start, detail) {
    if (this.errors.length === start) this.pass(detail);
  }

  required(relativePath) {
    const segments = relativePath.split("/");
    let cursor = this.root;
    for (const segment of segments) {
      cursor = join(cursor, segment);
      if (!existsSync(cursor)) {
        this.fail("MISSING", relativePath, "create or regenerate this required item");
        return null;
      }
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink()) {
        this.fail("UNSAFE PATH", relativePath, "links and junctions are not accepted release evidence");
        return null;
      }
    }
    if (!lstatSync(cursor).isFile()) {
      this.fail("INVALID TYPE", relativePath, "required item must be a regular file");
      return null;
    }
    const resolved = realpathSync(cursor);
    if (!isWithin(this.root, resolved)) {
      this.fail("UNSAFE PATH", relativePath, "resolved path escapes the validation root");
      return null;
    }
    return resolved;
  }

  text(relativePath, maximum = MAX_JSON_BYTES) {
    const path = this.required(relativePath);
    if (!path) return null;
    try {
      return decodeUtf8(readBounded(path, maximum));
    } catch {
      this.fail("INVALID TEXT", relativePath, "file is oversized or is not valid UTF-8");
      return null;
    }
  }

  substantive(relativePath, { minCharacters = 80, requirements = [] } = {}) {
    const source = this.text(relativePath);
    if (source === null) return null;
    const count = source.replace(/\s/g, "").length;
    if (count < minCharacters) this.fail("INSUBSTANTIAL", relativePath, `requires at least ${minCharacters} non-whitespace characters, found ${count}`);
    for (const [label, pattern] of requirements) if (!pattern.test(source)) this.fail("MISSING CONTRACT", relativePath, label);
    return source;
  }

  json(relativePath, maximum = MAX_JSON_BYTES) {
    const source = this.text(relativePath, maximum);
    if (source === null) return null;
    try {
      return JSON.parse(source);
    } catch {
      this.fail("INVALID JSON", relativePath, "file is not valid bounded JSON");
      return null;
    }
  }

  jsonl(relativePath) {
    const source = this.text(relativePath);
    if (source === null) return null;
    if (!source.endsWith("\n")) this.fail("INVALID JSONL", relativePath, "file must end with a newline");
    const lines = source.trimEnd() ? source.trimEnd().split("\n") : [];
    if (lines.length === 0) {
      this.fail("INVALID JSONL", relativePath, "file is empty");
      return [];
    }
    const events = [];
    for (const line of lines) {
      try {
        events.push(JSON.parse(line));
      } catch {
        this.fail("INVALID JSONL", relativePath, "contains malformed JSONL");
        return events;
      }
    }
    return events;
  }
}

function runGit(root, args) {
  return spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  });
}

function gitStatus(root) {
  const result = runGit(root, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--no-renames",
  ]);
  if (result.status !== 0) return null;
  return parseGitStatus(result.stdout);
}

function gitIndexState(root) {
  const result = runGit(root, ["ls-files", "--cached", "-v", "-z"]);
  if (result.status !== 0) return null;
  return parseGitIndexState(result.stdout);
}

function evidencePath(path) {
  return MANAGED_EVIDENCE_ROOTS.some((root) => path.startsWith(root));
}

function validateHistoricalGenerationState(validation, state) {
  if (typeof state?.trackedWorkingTreeDirty !== "boolean") {
    validation.fail(
      "MISMATCH",
      "manifest.git.trackedWorkingTreeDirty",
      "must be boolean in the post-generation, pre-publication evidence snapshot",
    );
  }
  for (const [field, expected] of Object.entries(HISTORICAL_GENERATION_STATE)) {
    if (state?.[field] !== expected) {
      validation.fail(
        "MISMATCH",
        `manifest.git.${field}`,
        "must describe the post-generation, pre-publication evidence snapshot",
      );
    }
  }
  if (state?.sourceState !== "clean-source-managed-artifacts-dirty") {
    validation.fail(
      "MISMATCH",
      "manifest.git.sourceState",
      "must identify a clean source with managed generated evidence pending publication",
    );
  }
  if (state?.packagingCommit !== null) {
    validation.fail(
      "MISMATCH",
      "manifest.git.packagingCommit",
      "is derived from verified source-to-HEAD history and must remain null in generated evidence",
    );
  }
}

function rawCommitChanges(root, commit) {
  const result = runGit(root, [
    "diff-tree",
    "--no-commit-id",
    "--raw",
    "-r",
    "-z",
    "--no-renames",
    "--no-abbrev",
    commit,
  ]);
  if (result.status !== 0) return null;
  return parseRawCommitChanges(result.stdout);
}

function rawTreeChanges(root, from, to) {
  const result = runGit(root, [
    "diff",
    "--raw",
    "-z",
    "--no-renames",
    "--no-abbrev",
    from,
    to,
    "--",
  ]);
  if (result.status !== 0) return null;
  return parseRawCommitChanges(result.stdout);
}

function gitTreePaths(root, revision) {
  const result = runGit(root, [
    "ls-tree",
    "-r",
    "--full-tree",
    "--name-only",
    "-z",
    revision,
  ]);
  if (result.status !== 0) return null;
  return parseGitPathList(result.stdout);
}

function validateGitProvenance(validation, state, { final = false } = {}) {
  const start = validation.errors.length;
  const probe = runGit(validation.root, ["rev-parse", "--is-inside-work-tree"]);
  if (probe.status !== 0 || probe.stdout.trim() !== "true") {
    validation.fail("GIT PROVENANCE", "repository", "a non-Git archive requires a complete independently hashed source inventory");
    return;
  }
  const indexState = gitIndexState(validation.root);
  if (!indexState) {
    validation.fail("GIT PROVENANCE", "repository", "tracked index state could not be measured");
    return;
  }
  if (indexState.hasNonDefaultFlags) {
    validation.fail("HIDDEN INDEX STATE", "repository", "tracked files use nondefault index flags");
    return;
  }
  const status = gitStatus(validation.root);
  if (!status) {
    validation.fail("GIT PROVENANCE", "repository", "actual Git state could not be measured");
    return;
  }
  if (!portableGitPathSet([
    ...indexState.paths,
    ...status.map(({ path }) => path),
  ])) {
    validation.fail(
      "NONPORTABLE GIT PATHS",
      "repository",
      "tracked and untracked paths must have one portable identity",
    );
    return;
  }
  const trackedDirty = status.some((item) => item.code !== "??");
  const wholeDirty = status.length > 0;
  const sourceEntries = status.filter((item) => !evidencePath(item.path));
  const managedEntries = status.filter((item) => evidencePath(item.path));
  const sourceUntracked = sourceEntries.some((item) => item.code === "??");
  const actual = {
    trackedWorkingTreeDirty: trackedDirty,
    wholeWorkingTreeDirty: wholeDirty,
    sourceTrackedWorkingTreeDirty: sourceEntries.some((item) => item.code !== "??"),
    sourceUntrackedWorkingTreeDirty: sourceUntracked,
    sourceWorkingTreeDirty: sourceEntries.length > 0,
    managedArtifactDirty: managedEntries.length > 0,
  };
  validateHistoricalGenerationState(validation, state);
  if (actual.sourceWorkingTreeDirty) validation.fail("DIRTY SOURCE", "repository", "tracked or untracked source changes are outside the evidence-only boundary");
  if (state?.revision !== state?.baseRevision || !isGitObjectId(state?.revision)) {
    validation.fail("MISMATCH", "manifest.git.revision", "must name one disclosed clean source commit");
    return;
  }
  if (runGit(validation.root, ["cat-file", "-e", `${state.revision}^{commit}`]).status !== 0
    || runGit(validation.root, ["merge-base", "--is-ancestor", state.revision, "HEAD"]).status !== 0) {
    validation.fail("MISMATCH", "manifest.git.revision", "must resolve and be ancestral to the validated HEAD");
    return;
  }
  const head = runGit(validation.root, ["rev-parse", "HEAD"]);
  if (head.status !== 0) {
    validation.fail("MISMATCH", "manifest.git.revision", "validated HEAD could not be resolved");
    return;
  }
  const descendants = runGit(validation.root, ["rev-list", "--reverse", `${state.revision}..HEAD`]);
  if (descendants.status !== 0) {
    validation.fail("MISMATCH", "manifest.git.revision", "could not enumerate source-to-HEAD commits");
    return;
  }
  const descendantCommits = descendants.stdout.split(/\s+/).filter(Boolean);
  for (const revision of [state.revision, ...descendantCommits]) {
    if (gitTreePaths(validation.root, revision) === null) {
      validation.fail(
        "MISMATCH",
        "manifest.git.revision",
        "source and descendant evidence trees must use portable Git paths",
      );
      return;
    }
  }
  let publicationCommit = null;
  for (const commit of descendantCommits) {
    const parents = runGit(validation.root, ["rev-list", "--parents", "-n", "1", commit]);
    const changes = rawCommitChanges(validation.root, commit);
    if (parents.status !== 0 || parents.stdout.trim().split(/\s+/).length !== 2 || changes === null) {
      validation.fail("MISMATCH", "manifest.git.revision", "evidence packaging must be a linear verifiable commit sequence");
      return;
    }
    const unsafe = changes.find(({ oldMode, newMode }) => (
      !SAFE_GIT_FILE_MODES.has(oldMode) || !SAFE_GIT_FILE_MODES.has(newMode)
    ));
    if (unsafe) {
      const mode = !SAFE_GIT_FILE_MODES.has(unsafe.oldMode) ? unsafe.oldMode : unsafe.newMode;
      validation.fail(
        "MISMATCH",
        "manifest.git.revision",
        `source-to-HEAD commits contain unsafe evidence mode ${mode}`,
      );
      return;
    }
    if (changes.some(({ status }) => !["A", "D", "M"].includes(status))) {
      validation.fail("MISMATCH", "manifest.git.revision", "evidence packaging contains an unverifiable change type");
      return;
    }
    const paths = changes.map(({ path }) => path);
    if (paths.some((path) => !evidencePath(path))) {
      validation.fail("MISMATCH", "manifest.git.revision", "source-to-HEAD commits contain non-evidence changes");
      return;
    }
    if (!publicationCommit && paths.includes("artifacts/evaluation/manifest.json")) {
      publicationCommit = commit;
    }
  }
  const exactGenerationHead = head.stdout.trim() === state.revision;
  if (exactGenerationHead) {
    for (const [field, value] of Object.entries(actual)) {
      if (state?.[field] !== value) {
        validation.fail("MISMATCH", `manifest.git.${field}`, "disclosure does not match measured generation-time Git state");
      }
    }
  } else {
    if (!publicationCommit) {
      validation.fail(
        "MISMATCH",
        "manifest.git.revision",
        "evidence-only descendants must publish artifacts/evaluation/manifest.json",
      );
    } else {
      const publicationChanges = rawTreeChanges(
        validation.root,
        state.revision,
        publicationCommit,
      );
      if (!publicationChanges
        || publicationChanges.some(({ path }) => !evidencePath(path))) {
        validation.fail(
          "MISMATCH",
          "manifest.git.revision",
          "first publication snapshot could not be verified",
        );
      } else {
        const expectedTrackedDirty = publicationChanges.some(
          ({ oldMode }) => oldMode !== "000000",
        );
        if (state.trackedWorkingTreeDirty !== expectedTrackedDirty) {
          validation.fail(
            "MISMATCH",
            "manifest.git.trackedWorkingTreeDirty",
            "does not match the first publication snapshot",
          );
        }
      }
    }
    if (wholeDirty) {
      validation.fail(
        "DIRTY PUBLISHED TREE",
        "repository",
        "an evidence-only descendant requires the current tracked and untracked tree to be clean",
      );
    }
  }
  if (final && wholeDirty) validation.fail("DIRTY FINAL TREE", "repository", "final validation requires a clean tracked and untracked tree");
  validation.passIfClean(start, "measured Git state matches a clean source and evidence-only ancestry");
}

function validatePrediction(validation, benchmark, predictions, label, prefix = "artifacts/evaluation") {
  const relativePath = `${prefix}/${label}-predictions.json`;
  if (!predictions) return;
  if (GOLD_FIELDS.test(JSON.stringify(predictions))) validation.fail("GOLD LEAK", relativePath, "raw predictions contain evaluator-only fields");
  if (!Array.isArray(predictions.cases)) {
    validation.fail("INVALID PREDICTIONS", relativePath, "cases must be an array");
    return;
  }
  const expectedCases = benchmark.cases.map((item) => item.id);
  if (!sameJson(predictions.cases.map((item) => item.caseId), expectedCases)) validation.fail("ORDER MISMATCH", relativePath, "all cases must appear in frozen benchmark order");
  for (const testCase of benchmark.cases) {
    const prediction = predictions.cases.find((item) => item.caseId === testCase.id);
    const expected = testCase.records.map((record) => record.id);
    const ranking = prediction?.rankedRecordIds;
    if (!Array.isArray(ranking) || ranking.length !== expected.length || new Set(ranking).size !== expected.length || expected.some((id) => !ranking.includes(id))) {
      validation.fail("INCOMPLETE RANKING", relativePath, `${testCase.id} must rank every record exactly once`);
    }
  }
}

function validateEvaluation(validation) {
  const start = validation.errors.length;
  const benchmarkPath = validation.required("data/benchmark/benchmark.json");
  if (!benchmarkPath) return null;
  let benchmark;
  try {
    benchmark = loadBenchmark(benchmarkPath);
  } catch {
    validation.fail("INVALID BENCHMARK", "data/benchmark/benchmark.json", "frozen benchmark validation failed");
    return null;
  }
  const manifest = validation.json("artifacts/evaluation/manifest.json");
  const baseline = validation.json("artifacts/evaluation/baseline-predictions.json");
  const advanced = validation.json("artifacts/evaluation/advanced-predictions.json");
  const comparison = validation.json("artifacts/evaluation/comparison.json");
  validation.required("artifacts/evaluation/report.md");
  validatePrediction(validation, benchmark, baseline, "baseline");
  validatePrediction(validation, benchmark, advanced, "advanced");
  if (manifest) {
    const benchmarkSource = canonicalLf(decodeUtf8(readBounded(benchmarkPath)));
    const caseIds = benchmark.cases.map((item) => item.id);
    const recordIds = Object.fromEntries(benchmark.cases.map((item) => [item.id, item.records.map((record) => record.id)]));
    if (!sameJson(manifest.evaluationProtocol, EVALUATION_PROTOCOL)) validation.fail("STALE PROTOCOL", "manifest.evaluationProtocol", `regenerate exact evaluation ${EVALUATION_PROTOCOL_LABEL} evidence`);
    if (manifest.reviewBudget?.calculation !== EVALUATION_PROTOCOL.reviewBudget.calculation) validation.fail("MISMATCH", "manifest.reviewBudget.calculation", `must use ${EVALUATION_PROTOCOL_LABEL} floor budgeting`);
    if (manifest.benchmark?.id !== benchmark.benchmarkId || manifest.benchmark?.sha256 !== canonicalTextSha256(benchmarkSource)
      || manifest.benchmark?.sha256Canonicalization !== "utf8-lf" || !sameJson(manifest.benchmark?.orderedCaseIds, caseIds)
      || !sameJson(manifest.benchmark?.orderedRecordIdsByCase, recordIds)) validation.fail("MISMATCH", "manifest.benchmark", "must bind the current frozen benchmark and exact order");
    if (!sameJson(manifest.provider, { name: "deterministic", model: null, seed: 0, status: "operational" })) validation.fail("MISMATCH", "manifest.provider", "committed evidence must be the deterministic offline run");
    if (!sameJson(manifest.resources?.providerCalls, { baseline: 0, advanced: 0, total: 0 })
      || !sameJson(manifest.resources?.providerAttempts, { baseline: 0, advanced: 0, total: 0 })
      || manifest.resources?.inputTokens !== 0 || manifest.resources?.outputTokens !== 0
      || manifest.resources?.totalTokens !== 0 || manifest.resources?.providerLatencyMs !== 0 || manifest.resources?.estimatedCostUsd !== 0) {
      validation.fail("MISMATCH", "manifest.resources", "deterministic evidence must report exact zero provider calls, attempts, input/output/total tokens, latency, and estimated cost");
    }
    if (manifest.execution?.status !== "complete") validation.fail("MISMATCH", "manifest.execution.status", "committed evidence must be complete");
    if (!sameJson(manifest.replay, { status: "not-selected", operational: false, substituted: false })) validation.fail("STALE TASK 7 EVIDENCE", "manifest.replay", "stale replay disclosure; regenerate exact not-selected deterministic evidence after Task 8");
    validateGitProvenance(validation, manifest.git ?? {});
  }
  if (comparison && baseline && advanced) {
    try {
      const computedBaseline = evaluatePredictions(benchmark, baseline);
      const computedAdvanced = evaluatePredictions(benchmark, advanced);
      if (!sameJson(comparison.baseline, computedBaseline) || !sameJson(comparison.advanced, computedAdvanced)) validation.fail("MISMATCH", "artifacts/evaluation/comparison.json", "stored results differ from independent recomputation");
    } catch {
      validation.fail("SCORING FAILURE", "artifacts/evaluation", "independent scoring failed");
    }
    const value = comparison.improvement;
    if (value?.baseline?.numerator !== 16 || value?.baseline?.denominator !== 20 || value?.baseline?.value !== 0.8
      || value?.advanced?.numerator !== 18 || value?.advanced?.denominator !== 20 || value?.advanced?.value !== 0.9
      || value?.absolute !== 0.1) validation.fail("MISMATCH", "comparison.improvement", "expected independently recomputed 0.80 to 0.90");
  }
  for (const testCase of benchmark.cases) {
    const relativePath = `artifacts/evaluation/trajectories/${testCase.id}.jsonl`;
    const events = validation.jsonl(relativePath);
    if (!events?.length) continue;
    if (events.some((event, index) => event.sequence !== index + 1) || events.some((event) => event.scenarioId !== testCase.id)) validation.fail("INVALID JSONL", relativePath, "sequence and scenario binding must be exact");
    const agents = new Set(events.map((event) => event.agent));
    for (const role of ROLE_SET) if (!agents.has(role)) validation.fail("MISSING ROLE", relativePath, role);
  }
  validation.passIfClean(start, `${EVALUATION_PROTOCOL_LABEL} deterministic evidence, paired 0.80/0.90 results, and complete trajectories`);
  return benchmark;
}

function validateRepresentativeEvidence(validation) {
  const start = validation.errors.length;
  const paths = [
    "artifacts/representative-trajectories/success-verifier-disagreement.jsonl",
    "artifacts/representative-trajectories/natural-retry-recovery.jsonl",
    "artifacts/representative-trajectories/uncertain-abstention.jsonl",
    "artifacts/representative-trajectories/human-checkpoint.jsonl",
  ];
  const values = paths.map((path) => validation.jsonl(path));
  if (!values[0]?.some((event) => event.agent === "skeptical-verifier" && event.payload?.verdict === "support")
    || !values[0]?.some((event) => event.agent === "skeptical-verifier" && event.payload?.verdict === "reject")) validation.fail("MISSING BRANCH", paths[0], "needs support and rejection");
  if (!values[1]?.some((event) => event.type === "retry") || !values[1]?.some((event) => event.type === "escalation") || !values[1]?.some((event) => event.payload?.recovered === true)) validation.fail("MISSING BRANCH", paths[1], "needs retry, escalation, and recovery");
  if (!values[2]?.some((event) => event.agent === "skeptical-verifier" && event.payload?.verdict === "uncertain")) validation.fail("MISSING BRANCH", paths[2], "needs verifier abstention");
  if (!values[3]?.some((event) => event.agent === "human-reviewer" && event.type === "human-decision")) validation.fail("MISSING BRANCH", paths[3], "needs a guarded decision-recording example");
  validation.required("artifacts/representative-trajectories/README.md");
  const reference = validation.json("artifacts/expected-replay-report/reference-comparison.json");
  validation.required("artifacts/expected-replay-report/README.md");
  if (reference) {
    if (/task-7/i.test(reference.status ?? "")) validation.fail("STALE TASK 7 EVIDENCE", "artifacts/expected-replay-report/reference-comparison.json", "regenerate the post-Task-8 non-selected reference");
    if (reference.replayOperational !== false || reference.substituted !== false || reference.baseline?.primaryMetric?.value !== 0.8 || reference.advanced?.primaryMetric?.value !== 0.9) validation.fail("MISMATCH", "artifacts/expected-replay-report/reference-comparison.json", "reference must remain non-operational, unsubstituted, and 0.80/0.90");
  }
  validation.passIfClean(start, "representative product-agent branches and post-Task-8 reference evidence");
}

function validateScripts(validation) {
  const start = validation.errors.length;
  const required = [
    "package.json", "scripts/evaluate.js", "scripts/evaluation-artifacts.js", "scripts/generate-evidence.js", "scripts/validate-submission.js",
    "src/agents/workflow.js", "src/agents/policy-analyst.js", "src/evaluation/baseline.js", "src/evaluation/advanced.js", "src/evaluation/metrics.js", "src/evaluation/protocol.js",
    "README.md", "docs/REPRODUCTION.md", "docs/EVALUATION.md", "docs/ARCHITECTURE.md", "docs/AGENT_SYSTEM.md", "docs/SECURITY.md",
  ];
  for (const path of required) validation.required(path);
  for (const path of required.filter((item) => item.endsWith(".js"))) validateJavaScript(validation, path);
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 24) validation.fail("RUNTIME", "Node.js", `requires 24+, found ${process.version}`);
  validation.passIfClean(start, `Node ${process.version} and required source/script/document paths`);
}

function validateJavaScript(validation, relativePath) {
  const path = validation.required(relativePath);
  if (!path) return false;
  const result = spawnSync(process.execPath, ["--check", path], { encoding: "utf8", timeout: 15_000, maxBuffer: 512 * 1024, windowsHide: true });
  if (result.status !== 0) {
    validation.fail("INVALID SCRIPT", relativePath, "syntax check failed");
    return false;
  }
  return true;
}

function safeCollect(validation, relativePath, output = []) {
  const absolute = join(validation.root, ...relativePath.split("/"));
  if (!existsSync(absolute)) return output;
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink()) {
    validation.fail("UNSAFE PATH", relativePath, "secret scanning refuses links or junctions");
    return output;
  }
  if (stat.isFile()) {
    output.push(relativePath);
    return output;
  }
  if (!stat.isDirectory()) return output;
  for (const name of readdirSync(absolute).sort()) safeCollect(validation, `${relativePath}/${name}`, output);
  return output;
}

function validateSecrets(validation, extraRoots = []) {
  const start = validation.errors.length;
  const roots = [
    "artifacts/evaluation", "artifacts/representative-trajectories", "artifacts/expected-replay-report",
    "data/benchmark/replay", "prompts", "src/providers", "src/agents/prompt-registry.js", "src/agents/provider-schemas.js",
    "src/agents/provider-trace.js", "src/agents/provider-validation.js", "src/agents/provider-workflow.js", "src/evaluation/provider-predictions.js",
    "scripts/capture-replay.js", "scripts/evaluate.js", "scripts/provider-evaluation-artifacts.js", "artifacts/qa", "artifacts/development-agent", "docs/DEVELOPMENT_AGENT_DISCLOSURE.md",
    ...extraRoots,
  ];
  const files = [...new Set(roots.flatMap((path) => safeCollect(validation, path)))];
  for (const relativePath of files) {
    const path = validation.required(relativePath);
    if (!path) continue;
    try {
      const stat = statSync(path);
      const maximum = relativePath.startsWith("artifacts/submission/") ? 512 * 1024 * 1024 : 64 * 1024 * 1024;
      if (stat.size > maximum) {
        validation.fail("SECRET SCAN", relativePath, "file exceeds the bounded scan limit");
        continue;
      }
      if (containsSecret(readBounded(path, maximum))) validation.fail("SECRET", relativePath, "credential-like content must be redacted");
    } catch {
      validation.fail("SECRET SCAN", relativePath, "bounded scan failed");
    }
  }
  validation.passIfClean(start, "credential scan covered replay, prompts, provider source, evaluation, QA, and development evidence");
}

function promptBinding(validation) {
  const value = {};
  for (const [role, filename] of Object.entries(PROMPTS)) {
    const relativePath = `prompts/${filename}`;
    const source = validation.text(relativePath);
    if (source === null) continue;
    value[role] = { filename, version: "v1", sha256: sha256(canonicalLf(source)) };
  }
  return value;
}

function sourceBinding(validation) {
  const files = [];
  for (const path of CAPTURE_SOURCE_FILES) {
    const source = validation.text(path);
    if (source === null) continue;
    files.push({ path, sha256: sha256(canonicalLf(source)) });
  }
  return {
    kind: "deterministic-role-capture",
    sha256: sha256(canonicalJson(files)),
    sha256Canonicalization: "utf8-lf",
    files,
  };
}

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) && sameJson(Object.keys(value).sort(), [...keys].sort());
}

function validateReplayFixtureSemantic(validation, benchmark) {
  const start = validation.errors.length;
  const path = validation.required(FIXTURE_PATH);
  if (!path || !benchmark) return null;
  let bytes;
  let fixture;
  try {
    bytes = readBounded(path, MAX_REPLAY_BYTES);
    fixture = JSON.parse(decodeUtf8(bytes));
  } catch {
    validation.fail("REPLAY FIXTURE SEMANTIC", FIXTURE_PATH, "fixture must be bounded valid UTF-8 JSON");
    return null;
  }
  if (containsSecret(bytes)) validation.fail("SECRET", FIXTURE_PATH, "credential-like content must be redacted");
  const fail = (detail) => validation.fail("REPLAY FIXTURE SEMANTIC", FIXTURE_PATH, detail);
  if (!exactKeys(fixture, ["artifactKind", "binding", "entries", "schemaVersion"]) || fixture.schemaVersion !== 1 || fixture.artifactKind !== "rubricdelta-exact-provider-replay") fail("fixture envelope is not exact replay schema v1");
  const binding = fixture.binding;
  if (!exactKeys(binding, ["benchmark", "mode", "model", "prompts", "protocol", "repeats", "source"])) fail("fixture binding fields are not exact");
  const benchmarkPath = validation.required("data/benchmark/benchmark.json");
  const benchmarkSource = benchmarkPath ? canonicalLf(decodeUtf8(readBounded(benchmarkPath))) : "";
  const expectedCases = benchmark.cases.map((item) => item.id);
  const expectedRecords = Object.fromEntries(benchmark.cases.map((item) => [item.id, item.records.map((record) => record.id)]));
  const expectedBenchmark = { id: benchmark.benchmarkId, sha256: canonicalTextSha256(benchmarkSource), orderedCaseIds: expectedCases, orderedRecordIdsByCase: expectedRecords };
  if (!sameJson(binding?.benchmark, expectedBenchmark)) fail("benchmark hash and ordered case/record binding mismatch");
  if (!sameJson(binding?.protocol, EVALUATION_PROTOCOL)) fail(`${EVALUATION_PROTOCOL_LABEL} binding mismatch`);
  if (binding?.model !== MODEL || binding?.mode !== "both" || binding?.repeats !== 1) fail("model, mode, and repeat binding mismatch");
  const expectedPrompts = promptBinding(validation);
  if (!sameJson(binding?.prompts, expectedPrompts)) fail("prompt registry/hash binding mismatch");
  const expectedSource = sourceBinding(validation);
  if (!sameJson(binding?.source, expectedSource)) fail("capture source closure/hash binding mismatch");
  if (!Array.isArray(fixture.entries) || fixture.entries.length !== 50) {
    fail("exactly 50 replay entries are required");
    return { fixture, bytes, sha256: sha256(bytes), valid: false };
  }
  const expectedTuples = [
    ...expectedCases.map((caseId) => ({ caseId, mode: "baseline", role: "direct-baseline" })),
    ...expectedCases.flatMap((caseId) => PROVIDER_ROLES.map((role) => ({ caseId, mode: "advanced", role }))),
  ];
  for (let index = 0; index < fixture.entries.length; index += 1) {
    const entry = fixture.entries[index];
    const tuple = expectedTuples[index];
    if (!exactKeys(entry, ["request", "requestHash", "result", "sequence"]) || entry.sequence !== index + 1) {
      fail("entry sequence/envelope mismatch");
      continue;
    }
    if (entry.requestHash !== REPLAY_REQUEST_HASHES[index] || entry.requestHash !== sha256(canonicalJson(entry.request))) fail("canonical request hash mismatch against the accepted per-sequence request inventory");
    const request = entry.request;
    const prompt = expectedPrompts[tuple.role];
    const promptSource = prompt ? canonicalLf(validation.text(`prompts/${prompt.filename}`) ?? "") : "";
    if (request?.benchmarkId !== benchmark.benchmarkId || request?.caseId !== tuple.caseId || request?.mode !== tuple.mode
      || request?.role !== tuple.role || request?.model !== MODEL || request?.repetition !== 1 || request?.schemaVersion !== 1
      || !sameJson(request?.prompt, prompt ? { id: tuple.role, instruction: promptSource, sha256: prompt.sha256, version: "v1" } : null)
      || !Array.isArray(request?.inputRefs) || request.inputRefs[0] !== tuple.caseId) fail("request tuple/prompt/input binding mismatch");
    const result = entry.result;
    const responseId = `deterministic-capture-${String(index + 1).padStart(4, "0")}`;
    if (!exactKeys(result, ["attempts", "data", "estimatedCostUsd", "latencyMs", "model", "responseId", "transportAttempts", "usage"])
      || result?.responseId !== responseId || result?.model !== MODEL || result?.latencyMs !== 0 || result?.estimatedCostUsd !== 0
      || result?.transportAttempts !== 1 || !sameJson(result?.usage, { inputTokens: 0, outputTokens: 0, totalTokens: 0 })
      || !sameJson(result?.attempts, [{ attempt: 1, outcome: "deterministic-capture" }]) || !result?.data || typeof result.data !== "object") fail("deterministic result/resource binding mismatch");
    if (sha256(canonicalJson(result)) !== REPLAY_RESULT_HASHES[index]) fail("captured result differs from the accepted per-sequence result inventory");
  }
  const valid = validation.errors.length === start;
  validation.passIfClean(start, "replay fixture semantic gate verified protocol, closure, prompts, exact 50-call order, hashes, and zero-resource results");
  return { fixture, bytes, sha256: sha256(bytes), valid };
}

function runBounded(validation, kind, path, command, args, timeout = 180_000) {
  const result = spawnSync(command, args, {
    cwd: validation.root,
    encoding: "utf8",
    timeout,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.status !== 0) {
    validation.fail(kind, path, result.error?.code === "ETIMEDOUT" ? `timed out after ${timeout} ms` : "failed or contains invalid contracts");
    return false;
  }
  return true;
}

function snapshotPath(validation, relativePath, output = {}) {
  const absolute = join(validation.root, ...relativePath.split("/"));
  if (!existsSync(absolute)) return output;
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink()) {
    output[relativePath] = { link: true };
  } else if (stat.isDirectory()) {
    for (const name of readdirSync(absolute).sort()) snapshotPath(validation, `${relativePath}/${name}`, output);
  } else if (stat.isFile()) {
    output[relativePath] = { sha256: sha256(readBounded(absolute, 64 * 1024 * 1024)), mtimeMs: stat.mtimeMs };
  }
  return output;
}

function validateReplayPredictionTraces(validation, predictions, roles, promptMap, label) {
  for (const item of predictions?.cases ?? []) {
    if (item.status !== "complete" || item.substituted !== false || item.estimatedCostUsd !== 0) validation.fail("REPLAY EVALUATION", label, "all cases must be complete, zero-cost, and unsubstituted");
    const events = item.trajectory;
    if (!Array.isArray(events) || events.some((event, index) => event.sequence !== index + 1) || events.at(-1)?.type !== "terminal" || events.at(-1)?.terminalState !== "complete") {
      validation.fail("REPLAY EVALUATION", label, "trace sequence and terminal state are incomplete");
      continue;
    }
    if (events.some((event) => event.schemaVersion !== "rubricdelta-provider-trace-v1" || event.provider?.name !== "replay"
      || event.provider?.requestedModel !== MODEL || event.usage?.inputTokens !== 0 || event.usage?.outputTokens !== 0
      || event.usage?.totalTokens !== 0 || (event.type === "provider-call" ? event.latencyMs !== null : event.latencyMs !== 0))) validation.fail("REPLAY EVALUATION", label, "trace schema/provider/model/resource fields mismatch");
    const results = events.filter((event) => event.type === "provider-result");
    if (!sameJson(results.map((event) => event.providerRole), roles)
      || results.some((event) => event.provider?.actualModel !== MODEL || !/^deterministic-capture-\d{4}$/.test(event.provider?.responseId ?? "")
        || event.retry?.transportAttempts !== 1 || event.status !== "completed")) validation.fail("REPLAY EVALUATION", label, "provider-result role/model/attempt binding mismatch");
    for (const event of events.filter((value) => value.type === "provider-call" || value.type === "provider-result")) {
      const prompt = promptMap[event.providerRole];
      if (!prompt || event.prompt?.id !== event.providerRole || event.prompt?.version !== "v1" || event.prompt?.sha256 !== prompt.sha256) validation.fail("REPLAY EVALUATION", label, "trace prompt hash binding mismatch");
    }
  }
}

function validReplayExecution(execution) {
  if (!exactKeys(execution, ["endedAt", "phase", "runtimeMs", "startedAt", "status"])) return false;
  const startedAt = Date.parse(execution.startedAt);
  const endedAt = Date.parse(execution.endedAt);
  return execution.status === "complete"
    && execution.phase === "complete"
    && RFC3339_TIMESTAMP.test(execution.startedAt)
    && RFC3339_TIMESTAMP.test(execution.endedAt)
    && Number.isFinite(startedAt)
    && Number.isFinite(endedAt)
    && endedAt >= startedAt
    && Number.isFinite(execution.runtimeMs)
    && execution.runtimeMs >= 0;
}

function validReplayRuntimeEnvironment(runtime) {
  const node = /^v(\d+)\.\d+\.\d+$/.exec(runtime?.node ?? "");
  return exactKeys(runtime, ["architecture", "networkRequired", "node", "platform", "runtimeDependencies"])
    && Number(node?.[1]) >= 24
    && typeof runtime.platform === "string"
    && runtime.platform !== ""
    && typeof runtime.architecture === "string"
    && runtime.architecture !== ""
    && runtime.runtimeDependencies === 0
    && runtime.networkRequired === false;
}

function validPublishedReplayGit(state, expectedRevision) {
  return exactKeys(state, [
    "baseRevision",
    "branch",
    "managedArtifactDirty",
    "packagingCommit",
    "provenanceNote",
    "revision",
    "sourceState",
    "sourceTrackedWorkingTreeDirty",
    "sourceUntrackedWorkingTreeDirty",
    "sourceWorkingTreeDirty",
    "trackedWorkingTreeDirty",
    "wholeWorkingTreeDirty",
  ])
    && isGitObjectId(expectedRevision)
    && state.revision === expectedRevision
    && state.baseRevision === expectedRevision
    && typeof state.branch === "string"
    && typeof state.trackedWorkingTreeDirty === "boolean"
    && state.sourceTrackedWorkingTreeDirty === false
    && state.sourceUntrackedWorkingTreeDirty === false
    && state.sourceWorkingTreeDirty === false
    && state.wholeWorkingTreeDirty === true
    && state.managedArtifactDirty === true
    && state.packagingCommit === null
    && state.provenanceNote === "revision identifies the clean source commit; generated evidence is added by the subsequent packaging commit"
    && state.sourceState === "clean-source-managed-artifacts-dirty";
}

function normalizedReplayManifest(manifest) {
  const normalized = structuredClone(manifest);
  normalized.git = "<validated-dynamic-git-state>";
  if (normalized.execution && typeof normalized.execution === "object" && !Array.isArray(normalized.execution)) {
    normalized.execution.startedAt = "<validated-dynamic-timing>";
    normalized.execution.endedAt = "<validated-dynamic-timing>";
    normalized.execution.runtimeMs = "<validated-dynamic-timing>";
  }
  if (normalized.runtimeEnvironment && typeof normalized.runtimeEnvironment === "object" && !Array.isArray(normalized.runtimeEnvironment)) {
    normalized.runtimeEnvironment.node = "<validated-host-runtime>";
    normalized.runtimeEnvironment.platform = "<validated-host-runtime>";
    normalized.runtimeEnvironment.architecture = "<validated-host-runtime>";
  }
  return normalized;
}

function validateReplayOutput(validation, outputRoot, fixtureInfo, benchmark, {
  label = "isolated replay",
  failureKind = "REPLAY EVALUATION",
  expectedRevision,
} = {}) {
  const start = validation.errors.length;
  const artifactPath = (path) => `${label}/${path}`;
  const readJson = (path) => {
    const absolute = join(outputRoot, ...path.split("/"));
    if (!existsSync(absolute)) {
      validation.fail("MISSING", artifactPath(path), "create or regenerate the canonical operational replay publication");
      return null;
    }
    try {
      if (!lstatSync(absolute).isFile() || lstatSync(absolute).isSymbolicLink()) throw new Error();
      return JSON.parse(decodeUtf8(readBounded(absolute)));
    } catch {
      validation.fail(failureKind, artifactPath(path), "missing or invalid replay artifact");
      return null;
    }
  };
  const manifest = readJson("manifest.json");
  const summary = readJson("summary.json");
  const comparison = readJson("comparison.json");
  const baseline = readJson("repetitions/1/baseline-predictions.json");
  const advanced = readJson("repetitions/1/advanced-predictions.json");
  const report = join(outputRoot, "report.md");
  if (!existsSync(report) || !lstatSync(report).isFile() || lstatSync(report).isSymbolicLink()) {
    validation.fail(failureKind, artifactPath("report.md"), "missing or invalid replay report");
  }
  if (!manifest || !summary || !comparison || !baseline || !advanced) return null;
  if (!sameJson(manifest.evaluationProtocol, EVALUATION_PROTOCOL)
    || !sameJson(manifest.provider, { name: "replay", model: MODEL, seed: null, status: "operational" })
    || !sameJson(manifest.resources?.providerCalls, { baseline: 10, advanced: 40, total: 50 })
    || !sameJson(manifest.resources?.providerAttempts, { baseline: 10, advanced: 40, total: 50 })
    || manifest.resources?.inputTokens !== 0 || manifest.resources?.outputTokens !== 0 || manifest.resources?.totalTokens !== 0
    || manifest.resources?.providerLatencyMs !== 0 || manifest.resources?.estimatedCostUsd !== 0) validation.fail(failureKind, artifactPath("manifest.json"), "provider, protocol, and resource claims are not exact");
  if (!validReplayRuntimeEnvironment(manifest.runtimeEnvironment)) {
    validation.fail(failureKind, artifactPath("manifest.json"), "runtime environment must be an exact dependency-free offline Node 24+ contract");
  }
  if (!validReplayExecution(manifest.execution)) {
    validation.fail(failureKind, artifactPath("manifest.json"), "execution must be exact, complete, failure-free, ordered, and nonnegative");
  }
  if (!sameJson(manifest.replay?.binding, fixtureInfo.fixture.binding) || !sameJson(manifest.replay?.source, fixtureInfo.fixture.binding.source)
    || manifest.replay?.fixture?.sha256 !== fixtureInfo.sha256 || manifest.replay?.status !== "operational"
    || manifest.replay?.operational !== true || manifest.replay?.substituted !== false) validation.fail(failureKind, artifactPath("manifest.replay"), "fixture/source/status binding mismatch");
  if (expectedRevision !== undefined) {
    if (!validPublishedReplayGit(manifest.git, expectedRevision)) {
      validation.fail(failureKind, artifactPath("manifest.git"), "must exactly bind the deterministic frozen revision to clean source with managed replay evidence pending publication");
    }
  }
  if (summary.provider !== "replay" || summary.model !== MODEL || summary.repeats !== 1
    || summary.baseline?.primaryMetric?.mean !== 0.8 || summary.baseline?.primaryMetric?.min !== 0.8 || summary.baseline?.primaryMetric?.max !== 0.8
    || summary.advanced?.primaryMetric?.mean !== 0.9 || summary.advanced?.primaryMetric?.min !== 0.9 || summary.advanced?.primaryMetric?.max !== 0.9
    || summary.improvement?.absolute !== 0.1) validation.fail(failureKind, artifactPath("summary.json"), "expected one-repeat 0.80 to 0.90 summary");
  validatePrediction(validation, benchmark, baseline, "baseline", `${label}/repetitions/1`);
  validatePrediction(validation, benchmark, advanced, "advanced", `${label}/repetitions/1`);
  try {
    const baselineScore = evaluatePredictions(benchmark, baseline);
    const advancedScore = evaluatePredictions(benchmark, advanced);
    if (baselineScore.primaryMetric?.value !== 0.8 || advancedScore.primaryMetric?.value !== 0.9) validation.fail(failureKind, artifactPath("raw predictions"), "independent raw scoring did not reproduce 0.80/0.90");
  } catch {
    validation.fail(failureKind, artifactPath("raw predictions"), "independent raw scoring failed");
  }
  const rawHashes = manifest.replay?.rawPredictionSha256ByRepetition?.["1"];
  const baselineBytes = readBounded(join(outputRoot, "repetitions", "1", "baseline-predictions.json"));
  const advancedBytes = readBounded(join(outputRoot, "repetitions", "1", "advanced-predictions.json"));
  if (rawHashes?.baseline !== sha256(baselineBytes) || rawHashes?.advanced !== sha256(advancedBytes)) validation.fail(failureKind, artifactPath("manifest.replay.rawPredictionSha256ByRepetition"), "raw prediction hashes mismatch durable bytes");
  validateReplayPredictionTraces(validation, baseline, ["direct-baseline"], fixtureInfo.fixture.binding.prompts, artifactPath("baseline traces"));
  validateReplayPredictionTraces(validation, advanced, PROVIDER_ROLES, fixtureInfo.fixture.binding.prompts, artifactPath("advanced traces"));
  validateGlobalReplayResponseIds(validation, baseline, advanced);
  if (comparison?.fairComparison?.repeats !== 1 || comparison?.fairComparison?.provider !== "replay" || comparison?.fairComparison?.model !== MODEL
    || comparison?.fairComparison?.reviewBudgetFraction !== benchmark.reviewBudgetFraction
    || !sameJson(comparison?.fairComparison?.orderedCaseIds, benchmark.cases.map((item) => item.id))
    || comparison?.repetitions?.length !== 1 || comparison.repetitions[0]?.repetition !== 1) validation.fail(failureKind, artifactPath("comparison.json"), "paired fairness/provider/repeat binding mismatch");
  validation.passIfClean(start, `${label} exhausted exact fixture and reproduced bound zero-resource 0.80/0.90 artifacts`);
  return { manifest, summary, comparison, baseline, advanced };
}

function comparePublishedReplay(validation, publishedRoot, isolatedRoot) {
  const start = validation.errors.length;
  try {
    const publishedManifest = JSON.parse(decodeUtf8(readBounded(join(publishedRoot, "manifest.json"))));
    const isolatedManifest = JSON.parse(decodeUtf8(readBounded(join(isolatedRoot, "manifest.json"))));
    if (!sameJson(normalizedReplayManifest(publishedManifest), normalizedReplayManifest(isolatedManifest))) {
      validation.fail("REPLAY PUBLICATION", `${OPERATIONAL_REPLAY_PATH}/manifest.json`, "immutable manifest content differs from the isolated exact replay output");
    }
  } catch {
    validation.fail("REPLAY PUBLICATION", `${OPERATIONAL_REPLAY_PATH}/manifest.json`, "could not cross-check immutable manifest content against the isolated exact replay output");
  }
  for (const path of [
    "summary.json",
    "comparison.json",
    "report.md",
    "repetitions/1/baseline-predictions.json",
    "repetitions/1/advanced-predictions.json",
  ]) {
    try {
      const published = readBounded(join(publishedRoot, ...path.split("/")), 64 * 1024 * 1024);
      const isolated = readBounded(join(isolatedRoot, ...path.split("/")), 64 * 1024 * 1024);
      if (sha256(published) !== sha256(isolated)) {
        validation.fail("REPLAY PUBLICATION", `${OPERATIONAL_REPLAY_PATH}/${path}`, "published bytes differ from the isolated exact replay output");
      }
    } catch {
      validation.fail("REPLAY PUBLICATION", `${OPERATIONAL_REPLAY_PATH}/${path}`, "could not cross-check published bytes against the isolated exact replay output");
    }
  }
  validation.passIfClean(start, "published operational replay bytes match the isolated exact replay output");
}

function validateTask8(validation, benchmark) {
  const start = validation.errors.length;
  const protectedBefore = {
    fixture: snapshotPath(validation, FIXTURE_PATH),
    evaluation: snapshotPath(validation, "artifacts/evaluation"),
    reference: snapshotPath(validation, "artifacts/expected-replay-report"),
    representative: snapshotPath(validation, "artifacts/representative-trajectories"),
  };
  const gitBefore = gitStatus(validation.root);
  const packageValue = validation.json("package.json");
  if (packageValue?.scripts?.["replay:check"] !== REPLAY_CHECK_SCRIPT) validation.fail("MISSING CONTRACT", "package.json#scripts.replay:check", "must exactly equal the fixed offline replay checker");
  if (packageValue?.scripts?.["eval:replay"] !== EVAL_REPLAY_SCRIPT) validation.fail("MISSING CONTRACT", "package.json#scripts.eval:replay", "must exactly equal the fixed offline replay evaluation command");
  let syntaxValid = true;
  for (const path of TASK8_JS_PATHS) if (!validateJavaScript(validation, path)) syntaxValid = false;
  let inventoryValid = true;
  for (const [path, expectedHash] of TASK8_TEST_HASHES) {
    const source = validation.text(path);
    if (source === null || sha256(canonicalLf(source)) !== expectedHash) {
      inventoryValid = false;
      validation.fail("TEST INVENTORY", path, "release hardening test bytes do not match the accepted LF-canonical inventory");
    }
  }
  const fixtureInfo = validateReplayFixtureSemantic(validation, benchmark);
  const structuralValid = validation.errors.length === start && syntaxValid && inventoryValid && fixtureInfo?.valid === true;
  const deterministicManifest = validation.json("artifacts/evaluation/manifest.json");
  const publishedRoot = join(validation.root, ...OPERATIONAL_REPLAY_PATH.split("/"));
  const publishedReplay = fixtureInfo?.valid
    ? validateReplayOutput(validation, publishedRoot, fixtureInfo, benchmark, {
      label: OPERATIONAL_REPLAY_PATH,
      failureKind: "REPLAY PUBLICATION",
      expectedRevision: deterministicManifest?.git?.revision,
    })
    : null;
  let testsOk = false;
  if (structuralValid) testsOk = runBounded(validation, "PROVIDER/WORKFLOW TESTS", [...TASK8_TEST_HASHES.keys()].join(", "), process.execPath, ["--test", ...TASK8_TEST_HASHES.keys()], 240_000);
  else if (!syntaxValid || !inventoryValid) validation.fail("PROVIDER/WORKFLOW TESTS", [...TASK8_TEST_HASHES.keys()].join(", "), "accepted test inventory failed before execution");
  const replayCheckOk = structuralValid && testsOk
    && runBounded(validation, "REPLAY CHECK", "package.json#scripts.replay:check", process.execPath, ["scripts/capture-replay.js", "--check"], 120_000);
  let outputRoot = null;
  if (fixtureInfo?.valid && replayCheckOk && packageValue?.scripts?.["eval:replay"] === EVAL_REPLAY_SCRIPT) {
    outputRoot = mkdtempSync(join(tmpdir(), "rubricdelta-validator-replay-"));
    try {
      const ok = runBounded(validation, "EVAL:REPLAY", "package.json#scripts.eval:replay", process.execPath, [
        "scripts/evaluate.js", "--provider", "replay", "--replay-fixture", FIXTURE_PATH,
        "--mode", "both", "--repeats", "1", "--output-dir", outputRoot,
      ], 180_000);
      const isolatedReplay = ok ? validateReplayOutput(validation, outputRoot, fixtureInfo, benchmark) : null;
      if (publishedReplay && isolatedReplay) comparePublishedReplay(validation, publishedRoot, outputRoot);
      scanAbsoluteTree(validation, outputRoot, "isolated replay output");
    } finally {
      if (isWithin(tmpdir(), outputRoot) && posix(outputRoot).includes("rubricdelta-validator-replay-")) rmSync(outputRoot, { recursive: true, force: true });
    }
  }
  if (outputRoot && existsSync(outputRoot)) validation.fail("READ-ONLY VIOLATION", "isolated eval:replay", "temporary output was not removed");
  const protectedAfter = {
    fixture: snapshotPath(validation, FIXTURE_PATH),
    evaluation: snapshotPath(validation, "artifacts/evaluation"),
    reference: snapshotPath(validation, "artifacts/expected-replay-report"),
    representative: snapshotPath(validation, "artifacts/representative-trajectories"),
  };
  if (!sameJson(protectedBefore, protectedAfter)) validation.fail("READ-ONLY VIOLATION", "Task 8 validation", "canonical fixture or committed deterministic evidence changed during validation");
  if (!sameJson(gitBefore, gitStatus(validation.root))) validation.fail("READ-ONLY VIOLATION", "Task 8 validation", "spawned gates changed measured Git state");
  validation.passIfClean(start, "Task 8 provider/workflow/capture/replay gates PASS");
}

const REPLAY_RESULT_HASHES = Object.freeze([
  "6542c67705c7249ddaa59711e914594c8e397235afe100a609e5b678cc71aa3f",
  "f3ec0ca2ee0f9c2746b197ab4bfaeda28aa3f439e7c6c513d21859878dd0e897",
  "a1b15051a392871ca8761e95778b7af547bc286d8eedb3fbc3e2ab7048e17ac9",
  "4035cbe10944b3ab842311a586a437ef76af68640a6c940cff9aab069252db5b",
  "a504aa493cf55a1a954492459578a676f1463b5a88bfa91078040d5085609333",
  "e28ffe01dad7b8528840d7be3b5b73e614dde9f274956ade60792288d29af0f5",
  "ce45a510e33d143c166b8f094a2e12a24daf140a81ceec084c9586eebb950997",
  "115cb49a74241819008f8798cd23ac92f98b3bee98e343ff2ff5f10aee48227a",
  "c0c9d000be6cdfd61b2e928206a6b68f95e335f6e4ecd36b706fe8c156d49dbc",
  "b1279b188eac7c0ef414e06f6cef7177e39ba5d677e79a04ea6dc366257d1868",
  "f0719d047820bf2ba0b842e43bea4cd7bb0eb5a12ad9068fdbfe27e8d39e19f4",
  "d1d7662fd297c08d2bd21162cdceb5dcd2e4953121c76b2647fbf3f78b6d500e",
  "00a2eafc07a70492447d31ab4ca4e4f56f0ce11771198fd5212e9782e38f1c95",
  "a879d6a73810d7deed1678cbfe2abb7cda693bd363344ba4471c7eb671754b03",
  "22897554a73f95d26f6234cb69fbf23f45a991c9f54df361b53a5667c3155794",
  "6b208a2fa4db2cabc20f44c8e26077da815af2af7b9f0717c3ddc70302cb8155",
  "36ab46f3ef748cc599dcefcd4ac5e0b4a8a3632a116f5a1937f9faf2e0937e38",
  "42909556f9b0c9c00edc6c98a27c4ac78f1c69292f68353c8d718cf6f4e3e534",
  "06594c2e3813523af24ab51592995126198082c1d3944248a266ffd5932f884c",
  "d82efd77ad0ba26822c882eb3855e85341455643c72e512256b11ae7855ea251",
  "725f992afbcc53dd5794d792115e02cf9b4473843ac4badd8dc6983dca5693bd",
  "e0bd93980f56693907638e28242d6f8ca7238c26a34dbe1c5132645d432a41ca",
  "fe9a27b8e36a59ccfebc1ac454d853aadf3d015375d94675e410f008ea77ed98",
  "5d9e63f154802f3ab3f80b0220a782785c48430915df957403b5a8345c1eb601",
  "2a23dc5225985593c3542b28d83273ed07865ebc4fa1917190003d4345e63ab3",
  "7e2414524727cafca36ec786cfd3d6b8a755c487dbcc3cfe40c0e17a131829e1",
  "d7a86e54c59ea4ab284d688b615b9222123811063eb52e41bc3cf3c0566ebe9f",
  "a8ce1ffa37462a9127a2c51d64984553f9d8bf96f8a62d9e70b15249ae21ec08",
  "895aaf9aa0cc08ddea31c4d83995e95f7d9bcfda07ebe6f27eb15e8ce4971eec",
  "40f457e75fb0969b271e74ad261355780ca309383b9361df5664461f6367a830",
  "62028bf78ca880c5bbc95907d844f37094fb3d994fe7ecdb1804e69af0e47189",
  "4c344c3c9241b05be4ca64abe2bc42791c93564b4d2437afc5147c3e897a0b87",
  "2aa7ba555ac4c85248d122028d954a8158155504b6b3b4f81292558b3bd3eaca",
  "52efa6df84c39cdd05096f0e50e061f5831cfc5bfc90f9e894b36daf57074b7e",
  "baa889424474be804e997aa7e38f1157daa35d7c2121626b473929ccfaccd943",
  "3603d32cdb28feefd3912d1cc86bf9705d999c03cf5d1ee962b6f7e4e1ad29b8",
  "2da0f2f8531fbe575c0db67a59d30d29e6c50490d88226657ca9c8f1f8a90a97",
  "766984a78cf1d5f43852e87f143b41e2cda303d9dd3a624b6836fd89f1b2e021",
  "523fa4741c7250eaa2102bb6363c8c3ab94a53707be5a4d6603e1932db5ee669",
  "7f19fc927b3419ac99509648785f5e5c20402ea6186a417564d14d1cbbf37540",
  "54d5cd0883f4b95f03e3ddc8173b15744e81b0335e614bd295e77ccedab6320b",
  "cbad43d556d0a30c255980ddeedf7cfb7a6d119bee6ee36663ef1cde1324559f",
  "f5ddb3f3ba160d7c48fbdb3697dcec3dee6c6a7128d741335904247d88d6591a",
  "b06c0414c6c39716fe245fbefba9946871b2b82196fdd4aa6d66789c8f370c6b",
  "7c4fdcfe6d998841cbc488ca33d74ddd67499ef9595ab3b3f18575e2f5c8aaf5",
  "8843e281d287f6b213fc211c1adf9dc28c0c147f5bed5b8e78d4dacbab9c273a",
  "31f043ca5a28db4d690c99267fc46a2e20964e61de445bf2bdf9ba4e408fdf63",
  "099876db8c43f3e44f31f24d124bcd89933d6e5cc0e0fc1e7d0de04c5b267add",
  "963987536d529ea1a07781898e4f62f6c68963bbbe1c6f724ee1edf520e22269",
  "d2be3b1ce03bfd7a4e96d90b9835bbb930716bb82277614902f58d0dc8410f5a",
]);

function validateExactReplayResults(validation) {
  const fixture = validation.json(FIXTURE_PATH, MAX_REPLAY_BYTES);
  if (!fixture || !Array.isArray(fixture.entries)) return;
  for (let index = 0; index < Math.min(fixture.entries.length, REPLAY_RESULT_HASHES.length); index += 1) {
    if (sha256(canonicalJson(fixture.entries[index]?.result)) !== REPLAY_RESULT_HASHES[index]) {
      validation.fail("REPLAY FIXTURE SEMANTIC", FIXTURE_PATH, "captured result differs from the accepted per-sequence result inventory");
      return;
    }
  }
}

function validateEvaluationSupplement(validation, benchmark) {
  if (!benchmark) return;
  const start = validation.errors.length;
  const manifest = validation.json("artifacts/evaluation/manifest.json");
  const baselinePath = validation.required("artifacts/evaluation/baseline-predictions.json");
  const advancedPath = validation.required("artifacts/evaluation/advanced-predictions.json");
  const comparison = validation.json("artifacts/evaluation/comparison.json");
  if (!manifest) return;
  if (manifest.reviewBudget?.fraction !== benchmark.reviewBudgetFraction
    || !sameJson(manifest.reviewBudget?.slotsByCase, Object.fromEntries(benchmark.cases.map((item) => [item.id, Math.max(1, Math.floor(item.records.length * benchmark.reviewBudgetFraction))])))) {
    validation.fail("MISMATCH", "manifest.reviewBudget", "fraction and floor-calculated case slots must match the benchmark");
  }
  if (!exactKeys(manifest.resources?.providerCalls, ["advanced", "baseline", "total"])) validation.fail("MISSING FIELD", "manifest.resources.providerCalls", "disclose exact baseline, advanced, and total calls");
  for (const field of ["startedAt", "endedAt", "runtimeMs", "status"]) if (!Object.hasOwn(manifest.execution ?? {}, field)) validation.fail("MISSING FIELD", `manifest.execution.${field}`, "record truthful run timing and state");
  if (!baselinePath || !/^[a-f0-9]{64}$/.test(manifest.artifacts?.baselinePredictionsSha256 ?? "") || manifest.artifacts.baselinePredictionsSha256 !== sha256(readBounded(baselinePath))) validation.fail("MISMATCH", "manifest.artifacts.baselinePredictionsSha256", "required hash must match durable baseline bytes");
  if (!advancedPath || !/^[a-f0-9]{64}$/.test(manifest.artifacts?.advancedPredictionsSha256 ?? "") || manifest.artifacts.advancedPredictionsSha256 !== sha256(readBounded(advancedPath))) validation.fail("MISMATCH", "manifest.artifacts.advancedPredictionsSha256", "required hash must match durable advanced bytes");
  if (comparison?.hardCase?.caseId !== "fraud-overrides-refunds") validation.fail("MISMATCH", "comparison.hardCase", "hard precedence case must remain explicit");
  if (comparison?.baseline?.perCase?.length !== 10 || comparison?.advanced?.perCase?.length !== 10) validation.fail("INCOMPLETE RESULTS", "artifacts/evaluation/comparison.json", "both systems require all ten per-case results");
  validation.passIfClean(start, "deterministic artifact hashes, floor budget, resources, timing, hard case, and per-case completeness");
}

function scanAbsoluteTree(validation, rootPath, label) {
  const start = validation.errors.length;
  const pending = [rootPath];
  while (pending.length > 0) {
    const path = pending.pop();
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      validation.fail("UNSAFE PATH", label, "isolated replay output contains a link or junction");
      continue;
    }
    if (stat.isDirectory()) {
      for (const name of readdirSync(path)) pending.push(join(path, name));
    } else if (stat.isFile()) {
      try {
        if (containsSecret(readBounded(path, 64 * 1024 * 1024))) validation.fail("SECRET", label, "isolated replay output contains credential-like content");
      } catch {
        validation.fail("SECRET SCAN", label, "isolated replay output exceeded the bounded scan contract");
      }
    }
  }
  validation.passIfClean(start, "isolated replay artifact scan completed");
}

const MAX_ISO_BOXES = 10_000;
const ISO_BOX_BUDGET_ERROR = "ISO_BOX_BUDGET_EXCEEDED";

function boxBudgetExceeded() {
  const error = new Error("ISO-BMFF box enumeration exceeds bounded validation limit");
  error.code = ISO_BOX_BUDGET_ERROR;
  return error;
}

function parseIsoBoxes(buffer, start, end, budget) {
  const boxes = [];
  let offset = start;
  while (offset < end) {
    if (end - offset < 8) throw new Error("truncated ISO-BMFF box header");
    const size32 = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    let headerSize = 8;
    let size = size32;
    if (size32 === 1) {
      if (end - offset < 16) throw new Error("truncated extended box header");
      const extended = buffer.readBigUInt64BE(offset + 8);
      if (extended > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("box is too large");
      size = Number(extended);
      headerSize = 16;
    } else if (size32 === 0) {
      size = end - offset;
    }
    if (size < headerSize || offset + size > end) throw new Error("invalid ISO-BMFF box bounds");
    if (budget.remaining === 0) throw boxBudgetExceeded();
    budget.remaining -= 1;
    boxes.push({ type, start: offset, end: offset + size, dataStart: offset + headerSize });
    offset += size;
  }
  return boxes;
}

function childBoxes(buffer, box, budget, offset = box.dataStart) {
  return parseIsoBoxes(buffer, offset, box.end, budget);
}

function movieDurationSeconds(buffer, mvhd) {
  if (mvhd.end - mvhd.dataStart < 20) throw new Error("mvhd box is truncated");
  const version = buffer[mvhd.dataStart];
  if (version === 0) {
    const scale = buffer.readUInt32BE(mvhd.dataStart + 12);
    const duration = buffer.readUInt32BE(mvhd.dataStart + 16);
    return scale === 0 ? null : duration / scale;
  }
  if (version === 1 && mvhd.end - mvhd.dataStart >= 32) {
    const scale = buffer.readUInt32BE(mvhd.dataStart + 20);
    const duration = Number(buffer.readBigUInt64BE(mvhd.dataStart + 24));
    return scale === 0 ? null : duration / scale;
  }
  throw new Error("unsupported or truncated mvhd metadata");
}

function uint32EntryCount(buffer, box, offset = 4) {
  if (box.end - box.dataStart < offset + 4) throw new Error(`${box.type} table is truncated`);
  return buffer.readUInt32BE(box.dataStart + offset);
}

function inspectSampleTables(buffer, { stsd, stts, stsc, stsz, stco, mediaBoxes }) {
  const descriptionCount = uint32EntryCount(buffer, stsd);
  const timingCount = uint32EntryCount(buffer, stts);
  const mappingCount = uint32EntryCount(buffer, stsc);
  const chunkCount = uint32EntryCount(buffer, stco);
  if (descriptionCount < 1 || timingCount < 1 || mappingCount < 1 || chunkCount < 1) throw new Error("video sample tables are empty");
  if (timingCount > 1_000_000 || mappingCount > 1_000_000 || chunkCount > 1_000_000) throw new Error("video sample tables exceed bounded limits");
  if (stts.dataStart + 8 + timingCount * 8 > stts.end) throw new Error("stts sample timing table is truncated");
  if (stsc.dataStart + 8 + mappingCount * 12 > stsc.end) throw new Error("stsc chunk map is truncated");
  const chunkWidth = stco.type === "co64" ? 8 : 4;
  if (stco.dataStart + 8 + chunkCount * chunkWidth > stco.end) throw new Error("stco/co64 chunk offset table is truncated");
  if (stsz.end - stsz.dataStart < 12) throw new Error("stsz sample table is truncated");

  const defaultSampleSize = buffer.readUInt32BE(stsz.dataStart + 4);
  const sampleCount = buffer.readUInt32BE(stsz.dataStart + 8);
  if (sampleCount < 1 || sampleCount > 1_000_000) throw new Error("stsz sample count is outside bounded limits");
  if (defaultSampleSize === 0 && stsz.dataStart + 12 + sampleCount * 4 > stsz.end) throw new Error("stsz sample-size entries are truncated");
  const sampleSizeAt = (index) => defaultSampleSize || buffer.readUInt32BE(stsz.dataStart + 12 + index * 4);

  let timedSamples = 0;
  for (let index = 0; index < timingCount; index += 1) {
    const offset = stts.dataStart + 8 + index * 8;
    const count = buffer.readUInt32BE(offset);
    const delta = buffer.readUInt32BE(offset + 4);
    if (count < 1 || delta < 1 || timedSamples + count > 1_000_000) throw new Error("stts sample timing is invalid");
    timedSamples += count;
  }
  if (timedSamples !== sampleCount) throw new Error("stts sample count differs from stsz sample count");

  const mappings = [];
  for (let index = 0; index < mappingCount; index += 1) {
    const offset = stsc.dataStart + 8 + index * 12;
    const firstChunk = buffer.readUInt32BE(offset);
    const samplesPerChunk = buffer.readUInt32BE(offset + 4);
    const sampleDescriptionIndex = buffer.readUInt32BE(offset + 8);
    if ((index === 0 && firstChunk !== 1) || (index > 0 && firstChunk <= mappings[index - 1].firstChunk)
      || samplesPerChunk < 1 || sampleDescriptionIndex < 1 || sampleDescriptionIndex > descriptionCount) throw new Error("stsc chunk mapping is invalid");
    mappings.push({ firstChunk, samplesPerChunk });
  }

  const chunkOffsets = [];
  for (let index = 0; index < chunkCount; index += 1) {
    const offset = stco.dataStart + 8 + index * chunkWidth;
    const value = chunkWidth === 8 ? buffer.readBigUInt64BE(offset) : BigInt(buffer.readUInt32BE(offset));
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("co64 chunk offset exceeds safe bounds");
    chunkOffsets.push(Number(value));
  }

  const sampleRanges = [];
  let mappingIndex = 0;
  let sampleIndex = 0;
  for (let chunkIndex = 0; chunkIndex < chunkOffsets.length; chunkIndex += 1) {
    const chunkNumber = chunkIndex + 1;
    while (mappingIndex + 1 < mappings.length && mappings[mappingIndex + 1].firstChunk <= chunkNumber) mappingIndex += 1;
    const chunkStart = chunkOffsets[chunkIndex];
    const media = mediaBoxes.find((box) => chunkStart >= box.dataStart && chunkStart < box.end);
    if (!media) throw new Error("sample chunk offset is outside an mdat media range");
    let cursor = chunkStart;
    for (let withinChunk = 0; withinChunk < mappings[mappingIndex].samplesPerChunk; withinChunk += 1) {
      if (sampleIndex >= sampleCount) throw new Error("stsc chunk map declares extra samples");
      const size = sampleSizeAt(sampleIndex);
      if (size < 1 || cursor + size > media.end) throw new Error("sample byte range escapes its mdat media payload");
      sampleRanges.push({ start: cursor, end: cursor + size });
      cursor += size;
      sampleIndex += 1;
    }
  }
  if (sampleIndex !== sampleCount) throw new Error("stsc chunk map does not cover every stsz sample");
  sampleRanges.sort((left, right) => left.start - right.start || left.end - right.end);
  for (let index = 1; index < sampleRanges.length; index += 1) {
    if (sampleRanges[index].start < sampleRanges[index - 1].end) throw new Error("video sample byte ranges overlap");
  }
  return { sampleCount, sampleRanges };
}
function parseAvcConfiguration(buffer, configBox) {
  const start = configBox?.dataStart;
  if (!Number.isInteger(start) || configBox.end - start < 7 || buffer[start] !== 1 || buffer[start + 1] === 0 || buffer[start + 3] === 0) return null;
  const lengthSize = (buffer[start + 4] & 3) + 1;
  if (lengthSize === 3) return null;
  let cursor = start + 6;
  const spsCount = buffer[start + 5] & 31;
  if (spsCount < 1) return null;
  for (let index = 0; index < spsCount; index += 1) {
    if (cursor + 2 > configBox.end) return null;
    const size = buffer.readUInt16BE(cursor);
    cursor += 2;
    if (size < 2 || cursor + size > configBox.end || (buffer[cursor] & 31) !== 7) return null;
    cursor += size;
  }
  if (cursor + 1 > configBox.end) return null;
  const ppsCount = buffer[cursor];
  cursor += 1;
  if (ppsCount < 1) return null;
  for (let index = 0; index < ppsCount; index += 1) {
    if (cursor + 2 > configBox.end) return null;
    const size = buffer.readUInt16BE(cursor);
    cursor += 2;
    if (size < 2 || cursor + size > configBox.end || (buffer[cursor] & 31) !== 8) return null;
    cursor += size;
  }
  return lengthSize;
}

function validateAvcSamplePayloads(buffer, sampleRanges, lengthSize) {
  if (!Number.isInteger(lengthSize) || !Array.isArray(sampleRanges) || sampleRanges.length === 0) return false;
  let sawVisualCodingLayer = false;
  for (const range of sampleRanges) {
    let cursor = range.start;
    while (cursor < range.end) {
      if (cursor + lengthSize > range.end) return false;
      let size = 0;
      for (let index = 0; index < lengthSize; index += 1) size = size * 256 + buffer[cursor + index];
      cursor += lengthSize;
      if (size < 1 || cursor + size > range.end) return false;
      const nalType = buffer[cursor] & 31;
      if (nalType < 1 || nalType > 23) return false;
      if (nalType <= 5) sawVisualCodingLayer = true;
      cursor += size;
    }
    if (cursor !== range.end) return false;
  }
  return sawVisualCodingLayer;
}
export function inspectMp4(buffer) {
  if (buffer.length > 512 * 1024 * 1024) throw new Error("video exceeds bounded validation size");
  const boxBudget = { remaining: MAX_ISO_BOXES };
  const top = parseIsoBoxes(buffer, 0, buffer.length, boxBudget);
  const ftyp = top.find((box) => box.type === "ftyp");
  const moov = top.find((box) => box.type === "moov");
  const mediaBoxes = top.filter((box) => box.type === "mdat");
  const mediaBytes = mediaBoxes.reduce((total, box) => total + box.end - box.dataStart, 0);
  if (!ftyp || ftyp.end - ftyp.dataStart < 8 || !moov) throw new Error("ISO-BMFF ftyp or moov metadata is missing");
  const movie = childBoxes(buffer, moov, boxBudget);
  const mvhd = movie.find((box) => box.type === "mvhd");
  if (!mvhd) throw new Error("ISO-BMFF moov box has no mvhd metadata");
  const durationSeconds = movieDurationSeconds(buffer, mvhd);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error("MP4 duration must be positive");
  if (durationSeconds > 300) { const error = new Error(`${durationSeconds.toFixed(2)} seconds exceeds five minutes`); error.code = "VIDEO_TOO_LONG"; throw error; }
  let accepted = null;
  for (const trak of movie.filter((box) => box.type === "trak")) {
    const track = childBoxes(buffer, trak, boxBudget);
    const tkhd = track.find((box) => box.type === "tkhd");
    const mdia = track.find((box) => box.type === "mdia");
    if (!tkhd || !mdia) continue;
    const media = childBoxes(buffer, mdia, boxBudget);
    const hdlr = media.find((box) => box.type === "hdlr");
    const minf = media.find((box) => box.type === "minf");
    if (!hdlr || !minf || hdlr.end - hdlr.dataStart < 12 || buffer.toString("ascii", hdlr.dataStart + 8, hdlr.dataStart + 12) !== "vide") continue;
    const stbl = childBoxes(buffer, minf, boxBudget).find((box) => box.type === "stbl");
    if (!stbl) continue;
    const tables = childBoxes(buffer, stbl, boxBudget);
    const stsd = tables.find((box) => box.type === "stsd");
    const stts = tables.find((box) => box.type === "stts");
    const stsc = tables.find((box) => box.type === "stsc");
    const stsz = tables.find((box) => box.type === "stsz");
    const stco = tables.find((box) => box.type === "stco" || box.type === "co64");
    if (!stsd || !stts || !stsc || !stsz || !stco || uint32EntryCount(buffer, stsd) < 1 || uint32EntryCount(buffer, stts) < 1 || uint32EntryCount(buffer, stsc) < 1 || uint32EntryCount(buffer, stco) < 1) continue;
    const sampleOffset = stsd.dataStart + 8;
    if (sampleOffset + 36 > stsd.end) continue;
    const sampleSize = buffer.readUInt32BE(sampleOffset);
    const codec = buffer.toString("ascii", sampleOffset + 4, sampleOffset + 8);
    if (sampleSize < 86 || sampleOffset + sampleSize > stsd.end || !["avc1", "avc3"].includes(codec)) continue;
    const width = buffer.readUInt16BE(sampleOffset + 32);
    const height = buffer.readUInt16BE(sampleOffset + 34);
    const sampleChildrenStart = sampleOffset + 86;
    let configBox = null;
    if (sampleChildrenStart < sampleOffset + sampleSize) {
      try {
        configBox = parseIsoBoxes(buffer, sampleChildrenStart, sampleOffset + sampleSize, boxBudget).find((box) => box.type === "avcC" && box.end > box.dataStart) ?? null;
      } catch (error) {
        if (error?.code === ISO_BOX_BUDGET_ERROR) throw error;
        configBox = null;
      }
    }
    let sampleInfo = null;
    let bitstreamConsistent = false;
    try {
      sampleInfo = inspectSampleTables(buffer, { stsd, stts, stsc, stsz, stco, mediaBoxes });
      bitstreamConsistent = validateAvcSamplePayloads(buffer, sampleInfo.sampleRanges, parseAvcConfiguration(buffer, configBox));
    } catch {
      sampleInfo = null;
      bitstreamConsistent = false;
    }
    if (width > 0 && height > 0 && sampleInfo?.sampleCount > 0 && bitstreamConsistent) accepted = { durationSeconds, width, height, codec, sampleCount: sampleInfo.sampleCount, mediaBytes };
  }
  if (!accepted || accepted.mediaBytes < 1024) throw new Error("video AVC configuration, sample tables, and media byte ranges are not internally consistent");
  return accepted;
}

function validateFinalText(validation, relativePath) {
  if (relativePath.startsWith("prompts/")) {
    return validation.substantive(relativePath, {
      minCharacters: 120,
      requirements: [
        ["declare prompt ID and version", /(?:prompt\s*id|\bid\s*:).*\bversion\s*:/is],
        ["treat public text as untrusted", /untrusted/i],
        ["forbid external tools", /external tool/i],
        ["require JSON", /json/i],
        ["abstain or escalate", /abstain|escalat/i],
        ["exclude ground truth", /ground truth/i],
      ],
    });
  }
  const requirements = relativePath === "docs/MODEL_AND_COSTS.md"
    ? [["model selection", /model/i], ["token or cost accounting", /token|cost|price/i]]
    : relativePath === "docs/MAIN_FAILURE_MODE.md"
      ? [["main failure mode", /failure|risk/i], ["mitigation", /mitigat|recover|detect/i]]
      : [["submission claim", /claim|thesis|hot take|argument/i]];
  return validation.substantive(relativePath, { minCharacters: 100, requirements });
}

const DEVELOPMENT_AGENT_PATH = /^artifacts\/development-agent\/(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*\.jsonl$/;
const RFC3339_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function releaseEnvelopeFailure(validation, path, message) {
  validation.fail("RELEASE ENVELOPE", path, message);
  validation.fail("RELEASE QA", "artifacts/qa/release.json", message);
}

function releaseEnvelopeJson(validation, path, expectedHash, subject) {
  const absolute = typeof path === "string" ? validation.required(path) : null;
  if (!absolute) {
    releaseEnvelopeFailure(validation, path ?? "artifacts/qa/release.json", `${subject} is required by the final release envelope`);
    return null;
  }
  let bytes;
  try {
    bytes = readBounded(absolute, MAX_JSON_BYTES);
  } catch (error) {
    releaseEnvelopeFailure(validation, path, `${subject} cannot be read within the bounded JSON limit: ${error.message}`);
    return null;
  }
  if (sha256(bytes) !== expectedHash) {
    releaseEnvelopeFailure(validation, path, `${subject} bytes must match the SHA-256 pointer in release.json`);
    return null;
  }
  try {
    return JSON.parse(decodeUtf8(bytes));
  } catch {
    releaseEnvelopeFailure(validation, path, `${subject} must contain valid JSON`);
    return null;
  }
}

function commandEvidenceInput(evidence) {
  return {
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
}

function validateQaRelease(validation) {
  const start = validation.errors.length;
  const readme = validation.substantive("artifacts/qa/README.md", {
    minCharacters: 200,
    requirements: [["viewport/browser coverage", /mobile|desktop|viewport|browser/i], ["accessibility coverage", /accessib|keyboard|focus/i]],
  });
  if (readme && /\b(?:PENDING|NOT RUN|has not run|protocol only|no passing result)\b/i.test(readme)) validation.fail("QA NOT RUN", "artifacts/qa/README.md", "prose protocols and pending claims are not passing evidence");
  const release = validation.json("artifacts/qa/release.json");
  if (!release) {
    validation.fail("RELEASE QA", "artifacts/qa/release.json", "structured PASS evidence is required");
    return null;
  }
  const missingCategories = QA_CATEGORIES.filter((category) => !Object.hasOwn(release.categories ?? {}, category));
  for (const category of missingCategories) {
    validation.fail("RELEASE QA", "artifacts/qa/release.json", `${category} missing from structured categories`);
  }
  for (const category of QA_CATEGORIES) {
    const status = release.categories?.[category]?.status;
    if (status !== undefined && status !== "PASS") {
      validation.fail("RELEASE QA", "artifacts/qa/release.json", `${category} must be PASS; non-PASS values are rejected`);
    }
  }
  const categoryPathList = Object.values(release.categories ?? {}).map((record) => record?.evidencePath);
  const categoryPaths = new Set(categoryPathList);
  if (categoryPaths.size !== categoryPathList.length) {
    validation.fail("RELEASE QA", "artifacts/qa/release.json", "each structured category requires a unique category-specific evidence path");
  }
  const diagnosticCommands = Array.isArray(release.commands) ? release.commands : [];
  const diagnosticCommandNames = diagnosticCommands.map((record) => record?.command);
  if (diagnosticCommands.length !== REQUIRED_RELEASE_COMMANDS.length
    || new Set(diagnosticCommandNames).size !== REQUIRED_RELEASE_COMMANDS.length
    || REQUIRED_RELEASE_COMMANDS.some(({ command }) => diagnosticCommandNames.filter((value) => value === command).length !== 1)) {
    validation.fail("RELEASE QA", "artifacts/qa/release.json", "commands must contain exactly one record per required command; duplicate command records are forbidden");
  }
  let canonicalRelease;
  try {
    canonicalRelease = buildReleaseEvidence(release);
    if (!sameJson(release, canonicalRelease)) throw new Error("release.json differs from the canonical release evidence schema");
  } catch (error) {
    releaseEnvelopeFailure(validation, "artifacts/qa/release.json", `release.json must be schema-closed, ordered, complete, participant-approved, and use unique category-specific structured evidence paths: ${error.message}`);
    return release;
  }

  const categoryEvidence = {};
  for (const category of QA_CATEGORIES) {
    const record = release.categories[category];
    const evidence = releaseEnvelopeJson(validation, record.evidencePath, record.evidenceSha256, `${category} category evidence`);
    if (!evidence) continue;
    try {
      const rebuilt = buildCategoryEvidence({
        revision: evidence.revision,
        category: evidence.category,
        timestamp: evidence.timestamp,
        tool: evidence.tool,
        coverage: evidence.coverage,
        status: evidence.status,
      });
      if (!sameJson(evidence, rebuilt) || evidence.artifactKind !== "rubricdelta-qa-category"
        || evidence.revision !== release.revision || evidence.category !== category) {
        throw new Error("category evidence differs from its canonical revision/category record");
      }
      categoryEvidence[category] = evidence;
    } catch (error) {
      releaseEnvelopeFailure(validation, record.evidencePath, `${category} category evidence must be schema-closed and canonical: ${error.message}`);
    }
  }

  for (let index = 0; index < REQUIRED_RELEASE_COMMANDS.length; index += 1) {
    const required = REQUIRED_RELEASE_COMMANDS[index];
    const record = release.commands[index];
    const evidence = releaseEnvelopeJson(validation, record.outputPath, record.outputSha256, `${required.command} command evidence`);
    if (!evidence) continue;
    try {
      const rebuilt = buildCommandEvidence(commandEvidenceInput(evidence));
      if (!sameJson(evidence, rebuilt) || evidence.revision !== release.revision || evidence.command !== required.command
        || evidence.startedAt !== record.startedAt || evidence.endedAt !== record.endedAt) {
        throw new Error("command evidence differs from its canonical ordered release record");
      }
    } catch (error) {
      releaseEnvelopeFailure(validation, record.outputPath, `${required.command} command evidence must be schema-closed and canonical, including summary hashes and byte counts: ${error.message}`);
    }
  }

  const artifacts = {};
  for (const [name, record] of Object.entries(release.artifacts)) {
    artifacts[name] = releaseEnvelopeJson(validation, record.path, record.sha256, `${name} artifact`);
  }
  try {
    if (artifacts.commandSuite) {
      const suite = buildCommandSuite(artifacts.commandSuite);
      if (!sameJson(suite, artifacts.commandSuite) || !sameJson(suite.commands, release.commands)) {
        throw new Error("command-suite.json must exactly repeat the ordered seven release command records");
      }
    }
    if (artifacts.session) {
      const session = buildReleaseSession(artifacts.session);
      const requiredSessionFields = ["humanReview", "privacyReview", "categories", "video", "eligibility", "rightsReview", "decision"];
      if (!sameJson(session, artifacts.session) || session.sourceRevision !== release.revision
        || requiredSessionFields.some((field) => !Object.hasOwn(session, field))) {
        throw new Error("session.json must be canonical, complete, and bound to the release revision");
      }
      for (const category of QA_CATEGORIES) {
        const expected = buildCategoryEvidence({ revision: release.revision, category, ...session.categories[category] });
        if (!sameJson(expected, categoryEvidence[category])) throw new Error(`${category} category evidence must match session.json`);
      }
      if (artifacts.participantAttestation) {
        const expected = buildParticipantAttestation({
          revision: release.revision,
          eligibility: session.eligibility,
          rightsReview: session.rightsReview,
          decision: session.decision,
        });
        if (!sameJson(expected, artifacts.participantAttestation)) throw new Error("participant-attestation.json must exactly match the participant session gates");
      }
      if (artifacts.video) {
        const expected = buildVideoEvidence({
          revision: release.revision,
          ...session.video.inspection,
          upload: session.video.upload,
          playback: {
            ...session.video.playback,
            revision: release.revision,
            evidencePath: release.categories.video.evidencePath,
            evidenceSha256: release.categories.video.evidenceSha256,
          },
        });
        if (!sameJson(expected, artifacts.video)) throw new Error("video.json must exactly match session inspection, upload, playback, and category evidence");
      }
      if (artifacts.humanReview) {
        const human = buildHumanEvidence({
          revision: artifacts.humanReview.revision,
          runId: artifacts.humanReview.runId,
          serverRevision: artifacts.humanReview.serverRevision,
          reviewer: artifacts.humanReview.reviewer,
          ledgerPath: artifacts.humanReview.ledgerPath,
          ledgerSha256: artifacts.humanReview.ledgerSha256,
          exportPath: artifacts.humanReview.exportPath,
          exportSha256: artifacts.humanReview.exportSha256,
          trajectoryPath: artifacts.humanReview.trajectoryPath,
          trajectorySha256: artifacts.humanReview.trajectorySha256,
        });
        if (!sameJson(human, artifacts.humanReview) || human.revision !== release.revision
          || human.runId !== session.humanReview.runId || human.serverRevision !== session.humanReview.serverRevision
          || !sameJson(human.reviewer, session.humanReview.reviewer)) {
          throw new Error("human-review.json must be canonical and match the selected participant session run");
        }
      }
      if (artifacts.developmentAgent) {
        const development = buildDevelopmentManifest({
          revision: artifacts.developmentAgent.revision,
          runId: artifacts.developmentAgent.runId,
          eventCount: artifacts.developmentAgent.eventCount,
          trajectoryPath: artifacts.developmentAgent.trajectoryPath,
          trajectorySha256: artifacts.developmentAgent.trajectorySha256,
          privacyReview: artifacts.developmentAgent.privacyReview,
        });
        if (!sameJson(development, artifacts.developmentAgent) || development.revision !== release.revision
          || !sameJson(development.privacyReview, session.privacyReview)) {
          throw new Error("development manifest must be canonical and match the exact privacy-reviewed participant session hash");
        }
      }
      if (!sameJson(release.decision, session.decision)) throw new Error("release decision must exactly match session.json");
    }
  } catch (error) {
    releaseEnvelopeFailure(validation, "artifacts/qa/release.json", `bound release artifacts must be canonical and cross-consistent: ${error.message}`);
  }
  validation.passIfClean(start, "schema-closed, hash-bound final release envelope is canonical and cross-consistent");
  return release;
}

function validateHumanReview(validation, release) {
  const start = validation.errors.length;
  const trajectory = validation.jsonl("artifacts/representative-trajectories/human-checkpoint.jsonl");
  const human = (trajectory ?? []).filter((event) => event.agent === "human-reviewer" && ["human-decision", "human-undo"].includes(event.type));
  const banned = human.some((event) => /hackathon-evidence-generator|agent|codex/i.test(event.payload?.reviewer ?? ""));
  const actions = new Set(human.map((event) => event.type === "human-undo" ? "undo" : event.payload?.decision));
  if (banned || !["approve", "reject", "escalate", "undo"].every((action) => actions.has(action))) validation.fail("HUMAN REVIEW", "artifacts/representative-trajectories/human-checkpoint.jsonl", "participant/owner-entered approve, reject, escalate, and undo proof is required; generated reviewers do not count");
  const evidence = validation.json("artifacts/qa/human-review.json");
  if (!validateHumanEvidenceFiles(validation, evidence, release, trajectory)) validation.fail("HUMAN REVIEW", "artifacts/qa/human-review.json", "hash-bound server ledger, participant attribution, append-only undo replay, and parsed CSV export equality are required");
  validation.passIfClean(start, "participant human decisions and approved-only export are hash-bound and equal");
}

function developmentEventPayloadIsSubstantive(event) {
  const payload = event?.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  let encoded;
  try {
    encoded = canonicalJson(payload);
  } catch {
    return false;
  }
  if (encoded.length < 12 || encoded.length > 1_000_000) return false;
  const text = (...keys) => keys.some((key) => typeof payload[key] === "string" && payload[key].trim().length >= 4);
  if (event.type === "instruction") return text("instruction", "prompt", "text");
  if (event.type === "tool-call") return text("tool", "name") && ["arguments", "input", "request"].some((key) => Object.hasOwn(payload, key));
  if (event.type === "tool-result") return text("tool", "name") && (text("result", "output", "summary", "status") || Object.hasOwn(payload, "result") || Object.hasOwn(payload, "output"));
  if (event.type === "feedback") return text("feedback", "review", "comment", "text");
  if (event.type === "verification") return text("command", "check", "verification") && (payload.status === "PASS" || payload.exitCode === 0);
  if (event.type === "retry") return text("reason", "classification", "message");
  return true;
}

function validateDevelopmentEvents(events, manifest) {
  if (!Array.isArray(events) || events.length === 0) return false;
  let previousTimestamp = -Infinity;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const source = typeof event?.source === "string" ? event.source : event?.source?.kind;
    const timestamp = Date.parse(event?.timestamp ?? "");
    if (!event || typeof event !== "object" || Array.isArray(event) || event.schemaVersion !== 1 || event.sequence !== index + 1
      || !RFC3339_TIMESTAMP.test(event.timestamp ?? "") || !Number.isFinite(timestamp) || timestamp < previousTimestamp
      || source !== "codex-export" || event.runId !== manifest.runId || event.agent !== manifest.agent
      || typeof event.type !== "string" || event.type.trim() === "" || !developmentEventPayloadIsSubstantive(event)) return false;
    previousTimestamp = timestamp;
  }
  return true;
}

function validateDevelopmentEvidence(validation, release) {
  const start = validation.errors.length;
  const disclosure = validation.substantive("docs/DEVELOPMENT_AGENT_DISCLOSURE.md", { minCharacters: 500, requirements: [["development trajectory link", /artifacts\/development-agent\//i], ["privacy review", /privacy.review/i]] });
  if (disclosure && /\b(?:pending|has not run|does not yet|still needs)\b/i.test(disclosure)) validation.fail("DEVELOPMENT TRAJECTORY", "docs/DEVELOPMENT_AGENT_DISCLOSURE.md", "pending development-agent evidence cannot pass final validation");
  const manifest = validation.json("artifacts/development-agent/manifest.json");
  if (!manifest || manifest.schemaVersion !== 1 || manifest.artifactKind !== "rubricdelta-development-agent-evidence" || manifest.revision !== release?.revision
    || manifest.privacyReview?.status !== "PASS" || manifest.privacyReview?.reviewer?.kind !== "participant"
    || !RFC3339_TIMESTAMP.test(manifest.privacyReview?.reviewedAt ?? "")
    || !/^[a-f0-9]{64}$/.test(manifest.privacyReview?.sourceSha256 ?? "")
    || manifest.source !== "codex-export" || manifest.agent !== "codex" || !/^[A-Za-z0-9][A-Za-z0-9._-]{3,120}$/.test(manifest.runId ?? "")
    || !Number.isInteger(manifest.eventCount) || manifest.eventCount < 5
    || !/^[a-f0-9]{64}$/.test(manifest.trajectorySha256 ?? "")
    || manifest.trajectorySha256 !== manifest.privacyReview.sourceSha256) {
    validation.fail("DEVELOPMENT TRAJECTORY", "artifacts/development-agent/manifest.json", "privacy-reviewed revision/hash-bound codex-export evidence requires exact participant-reviewed sourceSha256, event count, participant review, run identity, and agent identity");
    return;
  }
  const path = typeof manifest.trajectoryPath === "string" ? manifest.trajectoryPath : "artifacts/development-agent/trajectory.jsonl";
  const segments = path.split("/");
  if (path !== "artifacts/development-agent/trajectory.jsonl" || !DEVELOPMENT_AGENT_PATH.test(path) || path.includes("..") || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    validation.fail("DEVELOPMENT TRAJECTORY", "artifacts/development-agent/manifest.json", "trajectory path must be canonical and contained in the dedicated development-agent evidence root");
    return;
  }
  const absolute = validation.required(path);
  if (!absolute) return;
  const developmentRootPath = join(validation.root, "artifacts", "development-agent");
  if (!existsSync(developmentRootPath) || lstatSync(developmentRootPath).isSymbolicLink() || !lstatSync(developmentRootPath).isDirectory()
    || !isWithin(realpathSync(developmentRootPath), absolute)) {
    validation.fail("DEVELOPMENT TRAJECTORY", path, "trajectory must resolve strictly inside the dedicated development-agent evidence root");
    return;
  }
  const events = validation.jsonl(path);
  const trajectorySha256 = sha256(readBounded(absolute));
  if (manifest.trajectorySha256 !== trajectorySha256 || manifest.privacyReview.sourceSha256 !== trajectorySha256) {
    validation.fail("DEVELOPMENT TRAJECTORY", path, "participant-reviewed sourceSha256 and manifest trajectory hash must equal the published trajectory bytes");
  }
  if (events?.length !== manifest.eventCount || !validateDevelopmentEvents(events, manifest)) validation.fail("DEVELOPMENT TRAJECTORY", path, "events require exact manifest event count, contiguous sequence, RFC3339 timestamps, codex-export/run/agent identity, schema v1, and substantive type-specific payloads");
  const types = new Set((events ?? []).map((event) => event.type));
  for (const required of ["instruction", "tool-call", "tool-result", "feedback", "verification"]) if (!types.has(required)) validation.fail("DEVELOPMENT TRAJECTORY", path, `missing ${required} event`);
  validation.passIfClean(start, "privacy-reviewed development-agent trajectory is hash-bound and complete");
}
function validateVideo(validation, release) {
  const start = validation.errors.length;
  const path = validation.required("artifacts/submission/demo.mp4");
  if (!path) return;
  let inspected;
  let bytes;
  try {
    bytes = readBounded(path, 512 * 1024 * 1024);
    if (containsSecret(bytes)) {
      validation.fail("SECRET", "artifacts/submission/demo.mp4", "credential-like content must be redacted");
      return;
    }
    inspected = inspectMp4(bytes);
  } catch (error) {
    if (error.code === "VIDEO_TOO_LONG") validation.fail("VIDEO TOO LONG", "artifacts/submission/demo.mp4", error.message);
    else validation.fail("INVALID VIDEO", "artifacts/submission/demo.mp4", `invalid ISO-BMFF media: ${error.message}`);
    return;
  }
  if (inspected.durationSeconds > 300) validation.fail("VIDEO TOO LONG", "artifacts/submission/demo.mp4", `${inspected.durationSeconds.toFixed(2)} seconds exceeds five minutes`);
  const manifest = validation.json("artifacts/qa/video.json");
  const videoCategory = release?.categories?.video;
  if (!manifest || manifest.revision !== release?.revision || manifest.sha256 !== sha256(bytes)
    || manifest.durationSeconds !== inspected.durationSeconds || manifest.width !== inspected.width || manifest.height !== inspected.height
    || manifest.codec !== inspected.codec || manifest.videoSampleCount !== inspected.sampleCount || manifest.upload?.status !== "accepted"
    || manifest.playback?.status !== "PASS" || manifest.playback?.revision !== release?.revision
    || !RFC3339_TIMESTAMP.test(manifest.playback?.testedAt ?? "") || typeof manifest.playback?.tool !== "string"
    || manifest.playback.tool.trim().length < 2 || manifest.playback?.renderedFrameObserved !== true
    || manifest.playback?.evidencePath !== videoCategory?.evidencePath || manifest.playback?.evidenceSha256 !== videoCategory?.evidenceSha256) {
    validation.fail("VIDEO EVIDENCE", "artifacts/qa/video.json", "hash, duration, resolution, AVC codec/sample structure, accepted upload, hash-bound real playback attestation, and revision must match");
  }
  validation.passIfClean(start, `validated ${inspected.width}x${inspected.height} ${inspected.codec} video with ${inspected.sampleCount} samples and ${inspected.durationSeconds.toFixed(2)} seconds`);
}

function validateFinal(validation) {
  const start = validation.errors.length;
  for (const path of Object.keys(PROMPTS).map((role) => `prompts/${PROMPTS[role]}`)) validateFinalText(validation, path);
  for (const path of ["docs/MAIN_FAILURE_MODE.md", "docs/HOT_TAKE.md", "docs/MODEL_AND_COSTS.md"]) validateFinalText(validation, path);
  const release = validateQaRelease(validation);
  const manifest = validation.json("artifacts/evaluation/manifest.json");
  if (release && release.revision !== manifest?.git?.revision) validation.fail("RELEASE QA", "artifacts/qa/release.json", "release revision must equal the deterministic manifest.git.revision source commit");
  validateHumanReview(validation, release);
  validateDevelopmentEvidence(validation, release);
  validateVideo(validation, release);
  validateGitProvenance(validation, manifest?.git ?? {}, { final: true });
  validation.passIfClean(start, "final release QA, participant review, development evidence, video, and Git provenance PASS");
}

export function runValidation({ mode, root }) {
  const validation = new Validation(root);
  validateScripts(validation);
  const benchmark = validateEvaluation(validation);
  validateEvaluationSupplement(validation, benchmark);
  validateRepresentativeEvidence(validation);
  validateReferenceSupplement(validation);
  validateExactReplayResults(validation);
  validateTask8(validation, benchmark);
  validateSecrets(validation);
  if (mode === "final-strict") validateFinal(validation);
  return { validation, deferred: { task9: TASK9_DEFERRED_PATHS } };
}

function printResult(mode, result) {
  process.stdout.write(mode === "build" ? "MODE: BUILD — NON-FINAL\n" : "MODE: FINAL-STRICT\n");
  for (const pass of result.validation.passes) process.stdout.write(`[PASS] ${pass}\n`);
  if (mode === "build") process.stdout.write(`[DEFERRED (Task 9)] ${result.deferred.task9.join(", ")}\n`);
  for (const error of result.validation.errors) process.stdout.write(`[FAIL] ${error}\n`);
  if (result.validation.errors.length > 0) {
    process.stdout.write(`FAIL: ${mode} validation found ${result.validation.errors.length} actionable issue(s).\n`);
    process.exitCode = 1;
  } else if (mode === "build") {
    process.stdout.write("PASS: build validation completed as a non-final engineering gate.\n");
  } else {
    process.stdout.write("PASS: final-strict automated gates completed.\n");
  }
}


const REPLAY_REQUEST_HASHES = Object.freeze([
  "52edf3846580762c4840107bb8a814c5d70af56351084170fcdfabc48b24377e",
  "b9f306fe2b3329983b1d74fc912c5fbceeff88a568bb8a6fe543e5d974f9e3f0",
  "f54a87750bbea0ae7ffce32177b96db431dd4c9995b5bd612e8640f641257ec5",
  "76e544892694f52be3368a86a16924a87d72e144b25a00e3c17427d646ac8871",
  "6e4a66b4fef73cbb80a18d52d6725c78e6eab7a7fed03e1d680dc9050eae15a5",
  "beb29cc55fb94b127db63b07f94fd75412005f51ff18aac92f723defc6429857",
  "52db8915a907a1979bdf8b28fcc48b6ff468f9dd0528c6727756d89d15e42413",
  "fa3f05a374dec02b214bf0e42e4a95fb68a0fd79f7a57d3478d98706a4bf0afb",
  "deeee5da41aaea2756209b0a375af5a73eb379933b1974e15444c9595e3124cf",
  "1436efabdae885ab0bfcaee323edc57e48e748ec5df3a8f1be95b522114b7883",
  "4a2df63e3ef7cd22699644102c2f27cc870616f9e9387f7587ff86c3bc00b9a4",
  "2f1bbc3f8b6e3c017401b7db15232ffc66cf2c13789ad386e332fc2c1c68ea61",
  "a79b5b1272130b1fd712bcd0caf298869ad4f83b964e46302297a313d1bbd969",
  "43c58954f5c9ca6ab868d3f239765aa3a2a9579173baf771bb7186461e8f802a",
  "cdbfec1f37fab9578855b6ed118008783213e03d9f254a0607e17298da5da4a3",
  "d6f435d2e1ceb3fd33c566b38212c4119497a436b20e3a1c68b9feaeb0d8891b",
  "1e8dcadadd9c1a1e0b7eadd6e3f17f894b17d35ffde6d4e47390953e36b2ae0d",
  "9fa2e39e9812c9ec0a5ca15ecbc51f0d6893c01457158b29ae776e9fef46759b",
  "ed5c915517d67bd3edecc2c7acbc1cc4cb7b2b12bc8cca7da89c8eeea5ad6480",
  "8f09db5b40d0aea84d95f40c3f3b203ef81bcb600942612f14ea43a3c8b94864",
  "e1a1facc5ebfceceee791c8ab4e5d6349628eda9b968a4aa42ce3e558801f750",
  "7b988ce632d328cd82862be0364dbec88b7b171baffbb702f6d91452514333bd",
  "0c7bc41e9eba1b4df99c88c8cecf60ac342cbfa835a63f4811fe4592103ef51c",
  "59e6caa273cf8eb4755f6273caa0f547219b923918b9a3ee6b762cbabbcf1672",
  "1685bd987ea53e1cdd6bdb06006a4f70cf0a6b699f62601730386df5e277751f",
  "01872357d47da9c68838944e932ee90a502fa00b59fcaaa82d6a2a8bd95f445c",
  "a0a80989e6ca7f8d536fada3f3df80432b3baab84331206f9b902b894e9f6f36",
  "4e406d0008cb5953dd59422f75633bc08a7e6e3e43165984e0903c3cd760c26d",
  "de5590645702f5c64f07437ccde61ee720ce3a4673b07de6de74663ec7eb5dbc",
  "83ff583162000a61e8a955dd78c0b54e797ae5a4ec0f2a9ae57f0f99ed1b7181",
  "359995da2af47a0607fe3334293f7d6cd60c6f770d37989048a3b268ceeb7d12",
  "3ea42c778d3572f79fcdb8208b57712f39ef1c575be14a983aba450555f0726c",
  "359d90fdc02b7913545054f269223b36414847607cda1dd9163e3fe20131c1d3",
  "54d3ef04fddb9482305596a8ac5b2e5882e69baedb682caf76187d09a7ac77ae",
  "e0aa7751da7fb596e2ab508c0bafb851d66236a5c6c34b363ad1a2fd4f8a92f9",
  "32015f6884d803db706da15802f91e536aa14f80ab6a3fe2343cbefd3eb3298a",
  "45c94bd220eaaf1f0ab957ca351ee239801c56ca8555fe56c7c1593fd7c939a7",
  "ad883a61830e36aefae00ae9bb937b86e9c5c25034d3eadf0f90f58822115839",
  "772d73f0375892b77f534a8ac74d9a6877823b753843bdd36d83deccfd43a2d6",
  "18b8806e5f3822b5e68e9a053e1d51891dcd0d127b1fb205e65d31e0a64cedc7",
  "0ff409d9215420b379d13fbcba63d4caa13749b7d4ee605a709a5a6ae29098bc",
  "8a460cf8a18cb189b24b958d26312877735acf29354e65b925e4f7ad40239d08",
  "0955c62bad40b92ef4644c799b1a28d88680fbaaeaac8413ab58e11bb03cb3c5",
  "b7b0fbba9497e96a39a23d84c3dbdc3e418ff0e86bea17514f91462af1351076",
  "b793f5527cc80b6bacb225c7b4fa635a1765ea99cd9b004a3b28dcc5a30ab12b",
  "182527c409d2f49fef8e1f337b4beedb06e302f1133d9a5ce348beb10cd20b16",
  "d0e479ef7bfcfcd64e011a0ccba4017b35de39929b607f1c9ad94e0b543bb847",
  "8b1f9f44e58e73defa22fa5eb17eb149b54320a6ef8cdc841626225899e0a148",
  "26a6bdbae13ebf055f6ea0c9097acfc8bbc26b461b7cb223de0bf052709bc64b",
  "88d0daa5f47d868c89ef2a6eb4f1dd97d4e9f6185987400465a9f33fcda12fc6",
]);

function validateReferenceSupplement(validation) {
  const reference = validation.json("artifacts/expected-replay-report/reference-comparison.json");
  if (!reference) return;
  for (const [field, relativePath] of [
    ["baselinePredictionsSha256", "artifacts/evaluation/baseline-predictions.json"],
    ["advancedPredictionsSha256", "artifacts/evaluation/advanced-predictions.json"],
  ]) {
    const path = validation.required(relativePath);
    if (!path || reference.artifacts?.[field] !== sha256(readBounded(path))) validation.fail("MISMATCH", `expected replay ${field}`, `must bind ${relativePath}`);
  }
}

function validateGlobalReplayResponseIds(validation, baseline, advanced) {
  const results = [...(baseline?.cases ?? []), ...(advanced?.cases ?? [])].flatMap((item) => (item.trajectory ?? []).filter((event) => event.type === "provider-result"));
  const actual = results.map((event) => event.provider?.responseId);
  const expected = Array.from({ length: 50 }, (_, index) => `deterministic-capture-${String(index + 1).padStart(4, "0")}`);
  if (!sameJson(actual, expected)) validation.fail("REPLAY EVALUATION", "provider-result response IDs", "must consume exact global deterministic IDs 0001 through 0050 once in order");
}
export function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  printResult(options.mode, runValidation(options));
}

const directPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (directPath && directPath.toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  try {
    main();
  } catch {
    process.stderr.write("Validation failed: bounded fail-closed validator error\n");
    process.exitCode = 1;
  }
}

function boundQaEvidence(validation, path, expectedHash) {
  if (typeof path !== "string" || !path.startsWith("artifacts/qa/") || path.includes("..") || !/^[a-f0-9]{64}$/.test(expectedHash ?? "")) return null;
  const absolute = validation.required(path);
  if (!absolute) return null;
  try {
    const bytes = readBounded(absolute, 16 * 1024 * 1024);
    return sha256(bytes) === expectedHash ? { absolute, bytes } : null;
  } catch {
    return null;
  }
}

function parseCsvRecordIds(source) {
  const lines = source.replace(/\r\n?/g, "\n").trimEnd().split("\n");
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((item) => item.replace(/^"|"$/g, "").trim());
  const index = headers.indexOf("recordId");
  if (index < 0) return null;
  return lines.slice(1).filter(Boolean).map((line) => {
    const fields = line.match(/(?:^|,)("(?:[^"]|"")*"|[^,]*)/g)?.map((item) => item.replace(/^,/, "").replace(/^"|"$/g, "").replaceAll('""', '"')) ?? [];
    return fields[index];
  });
}

function validateHumanEvidenceFiles(validation, evidence, release, trajectory) {
  if (!evidence || evidence.revision !== release?.revision || evidence.reviewer?.kind !== "participant" || /agent|generator|codex/i.test(evidence.reviewer?.id ?? "")) return false;
  const ledgerFile = boundQaEvidence(validation, evidence.ledgerPath, evidence.ledgerSha256);
  const exportFile = boundQaEvidence(validation, evidence.exportPath, evidence.exportSha256);
  if (!ledgerFile || !exportFile || evidence.trajectoryPath !== "artifacts/representative-trajectories/human-checkpoint.jsonl" || !/^[a-f0-9]{64}$/.test(evidence.trajectorySha256 ?? "")) return false;
  const trajectoryPath = validation.required(evidence.trajectoryPath);
  if (!trajectoryPath || sha256(readBounded(trajectoryPath)) !== evidence.trajectorySha256) return false;
  let ledger;
  try {
    ledger = decodeUtf8(ledgerFile.bytes).trimEnd().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return false;
  }
  if (ledger.length < 4 || ledger.some((event, index) => event.sequence !== index + 1 || !Number.isInteger(event.trajectorySequence)
    || event.reviewer !== evidence.reviewer.id || /agent|generator|codex/i.test(event.reviewer ?? "")
    || !RFC3339_TIMESTAMP.test(event.timestamp ?? "") || typeof event.recordId !== "string" || event.recordId.trim() === "")) return false;
  const decisionStacks = new Map();
  const actions = new Set();
  for (const event of ledger) {
    const stack = decisionStacks.get(event.recordId) ?? [];
    if (["approve", "reject", "escalate"].includes(event.decision)) {
      actions.add(event.decision);
      stack.push({ sequence: event.sequence, decision: event.decision });
      decisionStacks.set(event.recordId, stack);
    } else if (event.action === "undo") {
      actions.add("undo");
      const target = stack.at(-1);
      const restoredDecision = stack.length > 1 ? stack.at(-2).decision : null;
      if (!target || target.sequence !== event.undoneSequence || event.restoredDecision !== restoredDecision
        || typeof event.reason !== "string" || event.reason.trim().length < 4) return false;
      stack.pop();
      decisionStacks.set(event.recordId, stack);
    } else {
      return false;
    }
  }
  if (!["approve", "reject", "escalate", "undo"].every((action) => actions.has(action))) return false;
  const approved = [...decisionStacks.entries()].filter(([, stack]) => stack.at(-1)?.decision === "approve").map(([recordId]) => recordId).sort();
  const exported = parseCsvRecordIds(decodeUtf8(exportFile.bytes));
  if (!exported || !sameJson(exported.sort(), approved)) return false;
  const humanTrajectory = (trajectory ?? []).filter((event) => event.agent === "human-reviewer" && ["human-decision", "human-undo"].includes(event.type));
  if (humanTrajectory.length !== ledger.length) return false;
  return humanTrajectory.every((event, index) => {
    const recorded = ledger[index];
    if (event.sequence !== recorded.trajectorySequence || event.timestamp !== recorded.timestamp
      || event.payload?.reviewer !== evidence.reviewer.id || event.payload?.recordId !== recorded.recordId
      || event.payload?.timestamp !== recorded.timestamp) return false;
    if (event.type === "human-undo") return recorded.action === "undo"
      && event.payload?.undoneSequence === recorded.undoneSequence
      && event.payload?.restoredDecision === recorded.restoredDecision
      && event.payload?.reason === recorded.reason;
    return event.payload?.decision === recorded.decision;
  });
}
