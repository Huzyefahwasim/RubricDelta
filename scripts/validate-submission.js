#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluatePredictions, loadBenchmark } from "../src/evaluation/index.js";

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GOLD_FIELDS = /groundTruth|affectedRecordIds|expectedLabels|rationales/i;
const SECRET_VALUE = /\bsk-[A-Za-z0-9_-]{8,}\b/g;
const ROLE_SET = new Set(["rule-compiler", "change-analyst", "impact-investigator", "skeptical-verifier", "orchestrator"]);

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
    if (flag === "--root") root = resolve(value);
  }
  if (!["build", "final-strict"].includes(mode)) throw new Error("--mode must be build or final-strict");
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`--root must name an existing directory: ${root}`);
  return { mode, root: realpathSync(root) };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function posix(path) {
  return path.replaceAll("\\", "/");
}

function rel(root, path) {
  return posix(relative(root, path));
}

function collectFiles(path) {
  if (!existsSync(path)) return [];
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).flatMap((entry) => collectFiles(join(path, entry)));
}

function parseIsoBoxes(buffer, start = 0, end = buffer.length) {
  const boxes = [];
  let offset = start;
  while (offset < end) {
    if (end - offset < 8) throw new Error("truncated ISO-BMFF box header");
    const size32 = buffer.readUInt32BE(offset);
    const rawType = buffer.toString("ascii", offset + 4, offset + 8);
    const type = /^[\x20-\x7e]{4}$/.test(rawType) ? rawType : "unknown";
    let headerSize = 8;
    let size = size32;
    if (size32 === 1) {
      if (end - offset < 16) throw new Error(`truncated extended ${type} box header`);
      const extended = buffer.readBigUInt64BE(offset + 8);
      if (extended > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${type} box is too large`);
      size = Number(extended);
      headerSize = 16;
    } else if (size32 === 0) {
      size = end - offset;
    }
    if (size < headerSize || offset + size > end) throw new Error(`invalid ${type || "unknown"} box bounds`);
    boxes.push({ type, start: offset, end: offset + size, dataStart: offset + headerSize });
    offset += size;
  }
  return boxes;
}

function childBoxes(buffer, box) {
  return parseIsoBoxes(buffer, box.dataStart, box.end);
}

function movieDurationSeconds(buffer, mvhd) {
  if (mvhd.end - mvhd.dataStart < 20) throw new Error("mvhd box is truncated");
  const version = buffer[mvhd.dataStart];
  if (version === 0) {
    const timescale = buffer.readUInt32BE(mvhd.dataStart + 12);
    const duration = buffer.readUInt32BE(mvhd.dataStart + 16);
    return timescale === 0 ? null : duration / timescale;
  }
  if (version === 1) {
    if (mvhd.end - mvhd.dataStart < 32) throw new Error("version 1 mvhd box is truncated");
    const timescale = buffer.readUInt32BE(mvhd.dataStart + 20);
    const duration = Number(buffer.readBigUInt64BE(mvhd.dataStart + 24));
    return timescale === 0 ? null : duration / timescale;
  }
  throw new Error(`unsupported mvhd version ${version}`);
}

function inspectMp4(buffer) {
  const top = parseIsoBoxes(buffer);
  const ftyp = top.find((box) => box.type === "ftyp");
  const moov = top.find((box) => box.type === "moov");
  const mdat = top.find((box) => box.type === "mdat" && box.end > box.dataStart);
  if (!ftyp || ftyp.end - ftyp.dataStart < 8) throw new Error("ISO-BMFF ftyp box is missing or truncated");
  if (!moov) throw new Error("ISO-BMFF moov box is missing");
  if (!mdat) throw new Error("ISO-BMFF media data is missing or empty");
  const movie = childBoxes(buffer, moov);
  const mvhd = movie.find((box) => box.type === "mvhd");
  if (!mvhd) throw new Error("ISO-BMFF moov box has no mvhd metadata");
  const duration = movieDurationSeconds(buffer, mvhd);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("MP4 duration must be positive");
  const tracks = movie.filter((box) => box.type === "trak");
  const hasVideoTrack = tracks.some((trak) => {
    const track = childBoxes(buffer, trak);
    const mdia = track.find((box) => box.type === "mdia");
    if (!track.some((box) => box.type === "tkhd") || !mdia) return false;
    const media = childBoxes(buffer, mdia);
    const hdlr = media.find((box) => box.type === "hdlr");
    const minf = media.find((box) => box.type === "minf");
    if (!media.some((box) => box.type === "mdhd") || !hdlr || !minf || hdlr.end - hdlr.dataStart < 12) return false;
    const handler = buffer.toString("ascii", hdlr.dataStart + 8, hdlr.dataStart + 12);
    return handler === "vide" && childBoxes(buffer, minf).some((box) => box.type === "stbl");
  });
  if (!hasVideoTrack) throw new Error("ISO-BMFF moov box has no complete video trak/mdia/minf/stbl structure");
  return duration;
}

class Validation {
  constructor(root) {
    this.root = root;
    this.errors = [];
    this.passes = [];
  }

  fail(kind, path, detail) {
    const location = typeof path === "string" && isAbsolute(path) ? rel(this.root, path) : path;
    this.errors.push(`${kind}: ${location}${detail ? ` — ${detail}` : ""}`);
  }

  pass(detail) {
    this.passes.push(detail);
  }

  required(relativePath) {
    const path = join(this.root, ...relativePath.split("/"));
    if (!existsSync(path)) {
      this.fail("MISSING", relativePath, "create or regenerate this required item");
      return null;
    }
    if (!statSync(path).isFile()) {
      this.fail("INVALID TYPE", relativePath, "required item must be a regular file");
      return null;
    }
    return path;
  }

  substantive(relativePath, { minCharacters = 80, requirements = [] } = {}) {
    const path = this.required(relativePath);
    if (!path) return null;
    const source = readFileSync(path, "utf8");
    const count = source.replace(/\s/g, "").length;
    if (count < minCharacters) {
      this.fail("INSUBSTANTIAL", relativePath, `requires at least ${minCharacters} non-whitespace characters, found ${count}`);
      return null;
    }
    for (const [label, pattern] of requirements) {
      if (!pattern.test(source)) this.fail("MISSING CONTRACT", relativePath, label);
    }
    return source;
  }

  json(relativePath) {
    const path = this.required(relativePath);
    if (!path) return null;
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      this.fail("INVALID JSON", relativePath, error.message);
      return null;
    }
  }

  jsonl(relativePath) {
    const path = this.required(relativePath);
    if (!path) return null;
    const source = readFileSync(path, "utf8");
    if (!source.endsWith("\n")) this.fail("INVALID JSONL", relativePath, "file must end with a newline");
    const lines = source.trimEnd() ? source.trimEnd().split("\n") : [];
    if (lines.length === 0) {
      this.fail("INVALID JSONL", relativePath, "file is empty");
      return [];
    }
    const events = [];
    for (let index = 0; index < lines.length; index += 1) {
      try {
        events.push(JSON.parse(lines[index]));
      } catch (error) {
        this.fail("INVALID JSONL", relativePath, `line ${index + 1}: ${error.message}`);
      }
    }
    return events;
  }
}

function validatePrediction(validation, benchmark, predictions, name) {
  if (!predictions) return;
  if (GOLD_FIELDS.test(JSON.stringify(predictions))) validation.fail("GOLD LEAK", `artifacts/evaluation/${name}-predictions.json`, "raw predictions contain evaluator-only fields");
  if (!Array.isArray(predictions.cases)) {
    validation.fail("INVALID PREDICTIONS", `artifacts/evaluation/${name}-predictions.json`, "cases must be an array");
    return;
  }
  const expectedCases = benchmark.cases.map((item) => item.id);
  if (JSON.stringify(predictions.cases.map((item) => item.caseId)) !== JSON.stringify(expectedCases)) {
    validation.fail("ORDER MISMATCH", `artifacts/evaluation/${name}-predictions.json`, "all cases must appear in frozen benchmark order");
  }
  for (const testCase of benchmark.cases) {
    const prediction = predictions.cases.find((item) => item.caseId === testCase.id);
    const expected = testCase.records.map((record) => record.id);
    const ranking = prediction?.rankedRecordIds;
    if (!Array.isArray(ranking)
      || ranking.length !== expected.length
      || new Set(ranking).size !== expected.length
      || expected.some((recordId) => !ranking.includes(recordId))) {
      validation.fail("INCOMPLETE RANKING", `artifacts/evaluation/${name}-predictions.json`, `${testCase.id} must rank all ${expected.length} records exactly once`);
    }
  }
}

function validateEvaluation(validation) {
  const benchmarkPath = validation.required("data/benchmark/benchmark.json");
  if (!benchmarkPath) return;
  let benchmark;
  try {
    benchmark = loadBenchmark(benchmarkPath);
  } catch (error) {
    validation.fail("INVALID BENCHMARK", "data/benchmark/benchmark.json", error.message);
    return;
  }
  const manifest = validation.json("artifacts/evaluation/manifest.json");
  const baseline = validation.json("artifacts/evaluation/baseline-predictions.json");
  const advanced = validation.json("artifacts/evaluation/advanced-predictions.json");
  const comparison = validation.json("artifacts/evaluation/comparison.json");
  validation.required("artifacts/evaluation/report.md");
  validatePrediction(validation, benchmark, baseline, "baseline");
  validatePrediction(validation, benchmark, advanced, "advanced");

  if (manifest) {
    const expectedHash = sha256(readFileSync(benchmarkPath));
    if (manifest.benchmark?.id !== "rubricdelta-support-guideline-drift-v1") validation.fail("MISMATCH", "manifest.benchmark.id", "expected frozen benchmark ID");
    if (manifest.benchmark?.schemaVersion !== benchmark.schemaVersion) validation.fail("MISMATCH", "manifest.benchmark.schemaVersion", `expected ${benchmark.schemaVersion}`);
    if (manifest.benchmark?.sha256 !== expectedHash) validation.fail("MISMATCH", "manifest.benchmark.sha256", "does not bind the current benchmark bytes");
    const orderedCases = benchmark.cases.map((item) => item.id);
    if (JSON.stringify(manifest.benchmark?.orderedCaseIds) !== JSON.stringify(orderedCases)) validation.fail("ORDER MISMATCH", "manifest.benchmark.orderedCaseIds", "must equal frozen case order");
    const orderedRecords = Object.fromEntries(benchmark.cases.map((item) => [item.id, item.records.map((record) => record.id)]));
    if (JSON.stringify(manifest.benchmark?.orderedRecordIdsByCase) !== JSON.stringify(orderedRecords)) validation.fail("ORDER MISMATCH", "manifest.benchmark.orderedRecordIdsByCase", "must equal frozen record order");
    if (manifest.provider?.name !== "deterministic" || manifest.provider?.model !== null || manifest.provider?.seed !== 0) validation.fail("MISMATCH", "manifest.provider", "build evidence must be deterministic with model null and seed 0");
    const gitState = manifest.git ?? {};
    const disclosedDirtyBooleans = [
      "trackedWorkingTreeDirty",
      "wholeWorkingTreeDirty",
      "sourceTrackedWorkingTreeDirty",
      "sourceUntrackedWorkingTreeDirty",
      "sourceWorkingTreeDirty",
      "managedArtifactDirty",
    ].every((field) => typeof gitState[field] === "boolean");
    const cleanRevision = typeof gitState.revision === "string" && /^[a-f0-9]{40}$/.test(gitState.revision);
    const cleanSource = gitState.sourceWorkingTreeDirty === false
      && gitState.sourceTrackedWorkingTreeDirty === false
      && gitState.sourceUntrackedWorkingTreeDirty === false;
    const consistentState = gitState.sourceState === "clean-commit"
      ? gitState.wholeWorkingTreeDirty === false && gitState.managedArtifactDirty === false
      : gitState.sourceState === "clean-source-managed-artifacts-dirty"
        && gitState.wholeWorkingTreeDirty === true && gitState.managedArtifactDirty === true;
    if (!cleanRevision || !disclosedDirtyBooleans || !cleanSource || !consistentState) {
      validation.fail("MISMATCH", "manifest.git", "source working tree is dirty or provenance fields are incomplete/inconsistent; regenerate from a clean source state");
    }
    if (!String(manifest.git?.provenanceNote ?? "").includes("subsequent packaging commit")) validation.fail("MISSING FIELD", "manifest.git.provenanceNote", "explain that evidence is added by the packaging commit");
    if (manifest.reviewBudget?.fraction !== 0.2 || Object.values(manifest.reviewBudget?.slotsByCase ?? {}).some((slots) => slots !== 2)) validation.fail("MISMATCH", "manifest.reviewBudget", "expected 20% and exactly two slots per case");
    for (const field of ["startedAt", "endedAt", "runtimeMs"]) if (!Object.hasOwn(manifest.execution ?? {}, field)) validation.fail("MISSING FIELD", `manifest.execution.${field}`, "record truthful run timing");
    if (!Object.hasOwn(manifest.resources ?? {}, "providerCalls")) validation.fail("MISSING FIELD", "manifest.resources.providerCalls", "disclose provider-call counts");
    if (manifest.replay?.status !== "deferred-task-8" || manifest.replay?.substituted !== false) validation.fail("MISMATCH", "manifest.replay", "Task 7 must disclose replay as deferred with no substitution");
  }

  if (comparison && baseline && advanced) {
    let computedBaseline;
    let computedAdvanced;
    try {
      computedBaseline = evaluatePredictions(benchmark, baseline);
      computedAdvanced = evaluatePredictions(benchmark, advanced);
    } catch (error) {
      validation.fail("SCORING FAILURE", "artifacts/evaluation", error.message);
    }
    if (computedBaseline && JSON.stringify(comparison.baseline) !== JSON.stringify(computedBaseline)) validation.fail("MISMATCH", "comparison.baseline", "stored complete results differ from recomputation");
    if (computedAdvanced && JSON.stringify(comparison.advanced) !== JSON.stringify(computedAdvanced)) validation.fail("MISMATCH", "comparison.advanced", "stored complete results differ from recomputation");
    const improvement = comparison.improvement;
    if (improvement?.baseline?.numerator !== 16 || improvement?.baseline?.denominator !== 20 || improvement?.baseline?.value !== 0.8
      || improvement?.advanced?.numerator !== 18 || improvement?.advanced?.denominator !== 20 || improvement?.advanced?.value !== 0.9
      || improvement?.absolute !== 0.1) validation.fail("MISMATCH", "comparison.improvement", "expected recomputed 16/20=0.80 to 18/20=0.90");
    if (comparison.hardCase?.caseId !== "fraud-overrides-refunds") validation.fail("MISMATCH", "comparison.hardCase", "hard precedence case must be explicit");
    if (comparison.baseline?.perCase?.length !== 10 || comparison.advanced?.perCase?.length !== 10) validation.fail("INCOMPLETE RESULTS", "comparison.json", "both systems need all ten per-case results");
  }

  for (const testCase of benchmark.cases) {
    const relativePath = `artifacts/evaluation/trajectories/${testCase.id}.jsonl`;
    const events = validation.jsonl(relativePath);
    if (!events || events.length === 0) continue;
    if (events.some((event, index) => event.sequence !== index + 1)) validation.fail("NONCONTIGUOUS JSONL", relativePath, "sequence must start at 1 and increase by one");
    if (events.some((event) => event.scenarioId !== testCase.id)) validation.fail("MISMATCH", relativePath, "scenarioId differs from filename");
    const agents = new Set(events.map((event) => event.agent));
    for (const role of ROLE_SET) if (!agents.has(role)) validation.fail("MISSING ROLE", relativePath, role);
  }
  validation.pass("frozen benchmark, complete gold-free predictions, paired results, and ten role-complete trajectories");
}

function validateRepresentativeEvidence(validation) {
  const disagreementPath = "artifacts/representative-trajectories/success-verifier-disagreement.jsonl";
  const disagreement = validation.jsonl(disagreementPath);
  const verdicts = new Set((disagreement ?? []).filter((event) => event.agent === "skeptical-verifier").map((event) => event.payload?.verdict));
  if (!verdicts.has("support") || !verdicts.has("reject")) validation.fail("MISSING BRANCH", disagreementPath, "needs real verifier support and rejection");

  const retryPath = "artifacts/representative-trajectories/natural-retry-recovery.jsonl";
  const retry = validation.jsonl(retryPath);
  if (!(retry ?? []).some((event) => event.type === "retry")
    || !(retry ?? []).some((event) => event.type === "escalation")
    || !(retry ?? []).some((event) => event.payload?.recovered === true)) validation.fail("MISSING BRANCH", retryPath, "needs real retry, escalation, and recovery");

  const uncertainPath = "artifacts/representative-trajectories/uncertain-abstention.jsonl";
  const uncertain = validation.jsonl(uncertainPath);
  if (!(uncertain ?? []).some((event) => event.agent === "skeptical-verifier" && event.payload?.verdict === "uncertain")) validation.fail("MISSING BRANCH", uncertainPath, "needs real uncertain verifier abstention");

  const humanPath = "artifacts/representative-trajectories/human-checkpoint.jsonl";
  const human = validation.jsonl(humanPath);
  if (!(human ?? []).some((event) => event.agent === "human-reviewer"
    && event.phase === "human-checkpoint"
    && event.type === "human-decision"
    && event.payload?.reviewer === "hackathon-evidence-generator")) validation.fail("MISSING BRANCH", humanPath, "needs attributable server-owned human decision");
  validation.required("artifacts/representative-trajectories/README.md");

  const reference = validation.json("artifacts/expected-replay-report/reference-comparison.json");
  validation.required("artifacts/expected-replay-report/README.md");
  if (reference) {
    if (reference.status !== "expected-reference-only-task-7" || reference.replayOperational !== false || reference.substituted !== false) validation.fail("MISMATCH", "expected replay status", "must be a non-operational Task 7 reference with no substitution");
    for (const [field, path] of [
      ["baselinePredictionsSha256", "artifacts/evaluation/baseline-predictions.json"],
      ["advancedPredictionsSha256", "artifacts/evaluation/advanced-predictions.json"],
    ]) {
      const target = validation.required(path);
      if (target && reference.artifacts?.[field] !== sha256(readFileSync(target))) validation.fail("MISMATCH", field, `must match ${path}`);
    }
    if (reference.baseline?.primaryMetric?.value !== 0.8 || reference.advanced?.primaryMetric?.value !== 0.9) validation.fail("MISMATCH", "expected replay metrics", "expected 0.80 to 0.90 reference");
  }
  validation.pass("representative success, disagreement, retry/recovery, uncertainty, human checkpoint, and replay reference");
}

function validateScripts(validation) {
  const required = [
    "package.json",
    "scripts/evaluate.js",
    "scripts/evaluation-artifacts.js",
    "scripts/generate-evidence.js",
    "scripts/validate-submission.js",
    "tests/cli.test.js",
    "tests/trace-roles.test.js",
    "tests/deterministic-trace-clock.test.js",
    "tests/raw-repeatability.test.js",
    "src/agents/workflow.js",
    "src/agents/policy-analyst.js",
    "src/evaluation/baseline.js",
    "src/evaluation/advanced.js",
    "src/evaluation/metrics.js",
    "README.md",
    "docs/REPRODUCTION.md",
    "docs/EVALUATION.md",
    "docs/ARCHITECTURE.md",
    "docs/AGENT_SYSTEM.md",
    "docs/SECURITY.md",
  ];
  for (const path of required) validation.required(path);
  for (const path of required.filter((item) => item.endsWith(".js"))) {
    const absolute = join(validation.root, ...path.split("/"));
    if (!existsSync(absolute)) continue;
    const syntax = spawnSync(process.execPath, ["--check", absolute], { encoding: "utf8" });
    if (syntax.status !== 0) validation.fail("INVALID SCRIPT", path, (syntax.stderr || syntax.stdout).split("\n")[0]);
  }
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 24) validation.fail("RUNTIME", "Node.js", `requires 24+, found ${process.version}`);
  else validation.pass(`Node ${process.version} and required source/script/document paths`);
}

function validateSecrets(validation) {
  const roots = [
    join(validation.root, "artifacts", "evaluation"),
    join(validation.root, "artifacts", "representative-trajectories"),
    join(validation.root, "artifacts", "expected-replay-report"),
  ];
  for (const file of roots.flatMap(collectFiles)) {
    const source = readFileSync(file, "utf8");
    SECRET_VALUE.lastIndex = 0;
    if (SECRET_VALUE.test(source)) validation.fail("SECRET", file, "redact the credential-like value and regenerate evidence");
  }
  validation.pass("generated evidence contains no credential-like sk- values");
}

function finalTask8Paths() {
  return [
    "prompts/rule-compiler.v1.md",
    "prompts/change-analyst.v1.md",
    "prompts/impact-investigator.v1.md",
    "prompts/independent-verifier.v1.md",
    "prompts/direct-baseline.v1.md",
    "src/providers/contracts.js",
    "src/providers/openai.js",
    "src/providers/replay.js",
    "src/agents/prompt-registry.js",
    "src/agents/provider-workflow.js",
    "src/evaluation/provider-predictions.js",
    "scripts/capture-replay.js",
    "data/benchmark/replay/rubricdelta-deterministic-source.v1.json",
    "tests/providers.test.js",
    "tests/provider-evaluation.test.js",
  ];
}

function finalTask9Paths() {
  return [
    "docs/MAIN_FAILURE_MODE.md",
    "docs/HOT_TAKE.md",
    "docs/MODEL_AND_COSTS.md",
    "artifacts/qa/README.md",
  ];
}

function validateFinalJavaScript(validation, relativePath) {
  const source = validation.substantive(relativePath, { minCharacters: 16 });
  if (!source) return false;
  const absolute = join(validation.root, ...relativePath.split("/"));
  const syntax = spawnSync(process.execPath, ["--check", absolute], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 256 * 1024,
    windowsHide: true,
  });
  if (syntax.status !== 0) {
    validation.fail("INVALID SCRIPT", relativePath, (syntax.stderr || syntax.stdout || syntax.error?.message || "syntax check failed").split("\n")[0]);
    return false;
  }
  return true;
}

function validateFinalText(validation, relativePath) {
  if (relativePath.startsWith("prompts/")) {
    return validation.substantive(relativePath, {
      minCharacters: 120,
      requirements: [
        ["declare a stable prompt ID and version", /(?:prompt\s*id|\bid\s*:).*\bversion\s*:/is],
        ["treat guideline and record text as untrusted data", /untrusted/i],
        ["forbid external tools", /(?:no|forbid|without).*external tool|external tool.*(?:not|forbid)/i],
        ["require JSON output", /json/i],
        ["abstain or escalate instead of inventing evidence", /abstain|escalat/i],
        ["exclude benchmark ground truth", /ground truth/i],
      ],
    });
  }
  const requirements = relativePath === "artifacts/qa/README.md"
    ? [["document viewport coverage", /mobile|desktop|viewport/i], ["document accessibility checks", /accessib|keyboard|focus/i], ["document test outcome", /pass|fail|result/i]]
    : relativePath === "docs/MODEL_AND_COSTS.md"
      ? [["document model selection", /model/i], ["document token or cost accounting", /token|cost|price/i]]
      : relativePath === "docs/MAIN_FAILURE_MODE.md"
        ? [["name the main failure mode", /failure|risk/i], ["document mitigation or recovery", /mitigat|recover|detect/i]]
        : [["state the submission claim", /claim|thesis|hot take|argument/i]];
  return validation.substantive(relativePath, { minCharacters: 100, requirements });
}

function runBounded(validation, kind, path, command, args, timeout) {
  const result = spawnSync(command, args, {
    cwd: validation.root,
    encoding: "utf8",
    timeout,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  if (result.status !== 0) {
    const reason = result.error?.code === "ETIMEDOUT" ? `timed out after ${timeout} ms` : "failed or contains invalid contracts";
    validation.fail(kind, path, reason);
    return false;
  }
  validation.pass(`${kind.toLowerCase()} passed`);
  return true;
}

function validateFinalGates(validation, mode) {
  const task8 = finalTask8Paths();
  const task9 = finalTask9Paths();
  if (mode === "build") return { task8, task9 };

  const promptPaths = task8.filter((path) => path.startsWith("prompts/"));
  const javascriptPaths = task8.filter((path) => path.endsWith(".js"));
  const testPaths = task8.filter((path) => path.startsWith("tests/"));
  for (const path of promptPaths) validateFinalText(validation, path);
  const javascriptValidity = new Map(javascriptPaths.map((path) => [path, validateFinalJavaScript(validation, path)]));
  for (const path of task9) validateFinalText(validation, path);

  const sourceContracts = [
    ["src/providers/contracts.js", /ProviderError/],
    ["src/providers/openai.js", /createOpenAIProvider/],
    ["src/providers/replay.js", /createReplayProvider/],
    ["src/agents/prompt-registry.js", /rule-compiler/],
    ["src/agents/provider-workflow.js", /analyzeScenarioWithProvider/],
    ["src/evaluation/provider-predictions.js", /provider/i],
    ["scripts/capture-replay.js", /--check/],
    ["tests/providers.test.js", /node:test/],
    ["tests/provider-evaluation.test.js", /node:test/],
  ];
  for (const [path, pattern] of sourceContracts) {
    const absolute = join(validation.root, ...path.split("/"));
    if (existsSync(absolute) && statSync(absolute).isFile() && !pattern.test(readFileSync(absolute, "utf8"))) {
      validation.fail("MISSING CONTRACT", path, `required marker ${pattern}`);
    }
  }

  const replaySource = validation.substantive("data/benchmark/replay/rubricdelta-deterministic-source.v1.json", { minCharacters: 40 });
  if (replaySource) {
    try {
      const fixture = JSON.parse(replaySource);
      if (fixture.binding?.source?.kind !== "deterministic-role-capture") {
        validation.fail("MISSING CONTRACT", "data/benchmark/replay/rubricdelta-deterministic-source.v1.json", "set binding.source.kind to deterministic-role-capture");
      }
    } catch (error) {
      validation.fail("INVALID JSON", "data/benchmark/replay/rubricdelta-deterministic-source.v1.json", error.message);
    }
  }

  if (testPaths.every((path) => javascriptValidity.get(path) === true)) {
    runBounded(validation, "PROVIDER TESTS", testPaths.join(", "), process.execPath, ["--test", ...testPaths], 60_000);
  } else if (testPaths.every((path) => existsSync(join(validation.root, ...path.split("/"))))) {
    validation.fail("PROVIDER TESTS", testPaths.join(", "), "failed or contains invalid contracts");
  }

  let packageValue = null;
  try {
    packageValue = JSON.parse(readFileSync(join(validation.root, "package.json"), "utf8"));
  } catch {
    // The base validator reports package failures separately.
  }
  if (typeof packageValue?.scripts?.["replay:check"] !== "string") {
    validation.fail("MISSING CONTRACT", "package.json#scripts.replay:check", "Task 8 must expose the bounded offline replay verifier");
  } else if (javascriptValidity.get("scripts/capture-replay.js") === true && replaySource) {
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    runBounded(validation, "REPLAY CHECK", "package.json#scripts.replay:check", npm, ["run", "replay:check", "--silent"], 60_000);
  }

  const videoPath = join(validation.root, "artifacts", "submission", "demo.mp4");
  if (!existsSync(videoPath)) {
    validation.fail("MISSING", "artifacts/submission/demo.mp4", "add the final hackathon video or revise the final gate to a documented hosted-video manifest");
  } else {
    try {
      const duration = inspectMp4(readFileSync(videoPath));
      if (duration > 300) validation.fail("VIDEO TOO LONG", "artifacts/submission/demo.mp4", `${duration.toFixed(2)} seconds exceeds five minutes`);
      else validation.pass(`local structurally valid video duration ${duration.toFixed(2)} seconds`);
    } catch (error) {
      validation.fail("INVALID VIDEO", "artifacts/submission/demo.mp4", `invalid ISO-BMFF container: ${error.message}`);
    }
  }
  return { task8, task9 };
}

export function runValidation({ mode, root }) {
  const validation = new Validation(root);
  validateScripts(validation);
  validateEvaluation(validation);
  validateRepresentativeEvidence(validation);
  validateSecrets(validation);
  const deferred = validateFinalGates(validation, mode);
  return { validation, deferred };
}

function printResult(mode, result) {
  process.stdout.write(mode === "build" ? "MODE: BUILD — NON-FINAL\n" : "MODE: FINAL-STRICT\n");
  for (const pass of result.validation.passes) process.stdout.write(`[PASS] ${pass}\n`);
  if (mode === "build") {
    process.stdout.write(`[DEFERRED (Task 8)] ${result.deferred.task8.join(", ")}\n`);
    process.stdout.write(`[DEFERRED (Task 9)] ${[...result.deferred.task9, "artifacts/submission/demo.mp4 (duration checked only when present)"].join(", ")}\n`);
  }
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

try {
  const options = parseArguments(process.argv.slice(2));
  printResult(options.mode, runValidation(options));
} catch (error) {
  process.stderr.write(`Validation failed: ${error.message}\n`);
  process.exitCode = 1;
}
