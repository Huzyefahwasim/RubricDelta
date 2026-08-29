#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  compilePolicyRules,
  analyzeRuleChanges,
  EvidenceError,
  recoverRuleChanges,
} from "../src/agents/policy-analyst.js";
import { promptRegistryBinding } from "../src/agents/prompt-registry.js";
import { rankImpactCandidates } from "../src/agents/impact-investigator.js";
import { verifyCandidate } from "../src/agents/verifier.js";
import { toPublicScenario } from "../src/domain/scenario.js";
import { rankBaselineCase } from "../src/evaluation/baseline.js";
import {
  DEFAULT_BENCHMARK_PATH,
  loadBenchmark,
} from "../src/evaluation/benchmark.js";
import { canonicalTextSha256 } from "../src/evaluation/evidence-hash.js";
import { EVALUATION_PROTOCOL } from "../src/evaluation/protocol.js";
import {
  createProviderAdvancedPredictions,
  createProviderBaselinePredictions,
} from "../src/evaluation/provider-predictions.js";
import {
  assertNoCredentialValues,
  canonicalJson,
  cloneJson,
  hashProviderRequest,
} from "../src/providers/contracts.js";
import { createReplayProvider } from "../src/providers/replay.js";

const modulePath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(modulePath), "..");
const DEFAULT_FIXTURE_PATH = resolve(
  repositoryRoot,
  "data",
  "benchmark",
  "replay",
  "rubricdelta-deterministic-source.v1.json",
);
const MODEL = "deterministic-role-capture-v1";
const MAX_FIXTURE_BYTES = 8 * 1024 * 1024;
const ZERO_USAGE = Object.freeze({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });

export const CAPTURE_SOURCE_FILES = Object.freeze([
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
].sort());

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalLfSource(path) {
  return readFileSync(resolve(repositoryRoot, ...path.split("/")), "utf8")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n");
}

function sourceBinding() {
  const files = CAPTURE_SOURCE_FILES.map((path) => ({
    path,
    sha256: sha256(canonicalLfSource(path)),
  }));
  return {
    kind: "deterministic-role-capture",
    sha256: sha256(canonicalJson(files)),
    sha256Canonicalization: "utf8-lf",
    files,
  };
}

function noOpTrace() {
  return { record() {}, events() { return []; } };
}

function normalizeEvidence(item) {
  return {
    type: String(item.type || "evidence"),
    deltaId: typeof item.deltaId === "string" ? item.deltaId : null,
    recordId: typeof item.recordId === "string" ? item.recordId : null,
    quote: typeof item.quote === "string" ? item.quote : null,
    citation: item.citation || null,
    detail: canonicalJson(item),
  };
}

function deterministicRoleResult(request) {
  const trace = noOpTrace();
  if (request.role === "rule-compiler") {
    return compilePolicyRules({ ...request.input, trace });
  }
  if (request.role === "change-analyst") {
    try {
      return analyzeRuleChanges({ ...request.input, trace });
    } catch (error) {
      if (!(error instanceof EvidenceError)) throw error;
      const { deltas, boundaryCases } = recoverRuleChanges(request.input);
      return {
        deltas: deltas.map(({ ambiguity: _ambiguity, ...delta }) => delta),
        boundaryCases,
      };
    }
  }
  if (request.role === "impact-investigator") {
    return {
      candidates: rankImpactCandidates({ ...request.input, trace }).map((candidate) => {
        const { status: _status, evidence, ...rest } = candidate;
        return { ...rest, evidence: evidence.map(normalizeEvidence) };
      }),
    };
  }
  if (request.role === "independent-verifier") {
    return {
      verifications: request.input.candidates.map((candidate) => {
        const evidence = candidate.evidence.map((item) => JSON.parse(item.detail));
        const verdict = verifyCandidate({
          candidate: { ...candidate, evidence },
          scenario: request.input.scenario,
          analysis: request.input.analysis,
          trace,
        });
        return {
          recordId: candidate.recordId,
          ruleDeltaIds: [...candidate.ruleDeltaIds],
          citations: evidence
            .filter((item) => item.type === "changed-rule-citation" && item.citation)
            .map((item) => ({ deltaId: item.deltaId, citation: item.citation })),
          ...verdict,
        };
      }),
    };
  }
  if (request.role === "direct-baseline") {
    return { ranking: rankBaselineCase(request.input.scenario) };
  }
  throw new Error("Deterministic capture received an unknown role");
}

function capturedResult(data, sequence) {
  return {
    data,
    usage: { ...ZERO_USAGE },
    responseId: "deterministic-capture-" + String(sequence).padStart(4, "0"),
    model: MODEL,
    latencyMs: 0,
    transportAttempts: 1,
    attempts: [{ attempt: 1, outcome: "deterministic-capture" }],
    estimatedCostUsd: 0,
  };
}

function captureProvider(entries) {
  return Object.freeze({
    name: "capture",
    model: MODEL,
    async complete(requestValue) {
      const request = cloneJson(requestValue);
      const sequence = entries.length + 1;
      const result = capturedResult(deterministicRoleResult(request), sequence);
      const entry = {
        sequence,
        requestHash: hashProviderRequest(request),
        request,
        result,
      };
      assertNoCredentialValues(entry);
      entries.push(cloneJson(entry));
      return cloneJson(result);
    },
  });
}

function publicBenchmark(benchmark) {
  return {
    benchmarkId: benchmark.benchmarkId,
    reviewBudgetFraction: benchmark.reviewBudgetFraction,
    cases: benchmark.cases.map(toPublicScenario),
  };
}

function assertCompleteCapture(predictions, expectedCases, system) {
  if (!predictions || !Array.isArray(predictions.cases)
    || predictions.cases.length !== expectedCases.length) {
    throw new Error("Deterministic " + system + " capture is incomplete");
  }
  for (let index = 0; index < expectedCases.length; index += 1) {
    const result = predictions.cases[index];
    if (result.caseId !== expectedCases[index].id
      || result.status !== "complete"
      || result.substituted !== false) {
      throw new Error("Deterministic " + system + " capture failed before fixture publication");
    }
  }
}

function benchmarkBinding(benchmark) {
  const benchmarkSource = readFileSync(DEFAULT_BENCHMARK_PATH, "utf8");
  return {
    id: benchmark.benchmarkId,
    sha256: canonicalTextSha256(benchmarkSource),
    orderedCaseIds: benchmark.cases.map((item) => item.id),
    orderedRecordIdsByCase: Object.fromEntries(
      benchmark.cases.map((item) => [item.id, item.records.map((record) => record.id)]),
    ),
  };
}

export function createExpectedReplayBinding(benchmark = loadBenchmark()) {
  return cloneJson({
    benchmark: benchmarkBinding(benchmark),
    source: sourceBinding(),
    protocol: structuredClone(EVALUATION_PROTOCOL),
    prompts: promptRegistryBinding(),
    model: MODEL,
    mode: "both",
    repeats: 1,
  });
}

export async function generateReplayFixture() {
  const benchmark = loadBenchmark();
  const projected = publicBenchmark(benchmark);
  const entries = [];
  const provider = captureProvider(entries);
  const baseline = await createProviderBaselinePredictions(projected, {
    provider,
    model: MODEL,
    repetition: 1,
    now: () => "2000-01-01T00:00:00.000Z",
  });
  const advanced = await createProviderAdvancedPredictions(projected, {
    provider,
    model: MODEL,
    repetition: 1,
    now: () => "2000-01-01T00:00:00.000Z",
  });
  assertCompleteCapture(baseline, projected.cases, "baseline");
  assertCompleteCapture(advanced, projected.cases, "advanced");
  if (entries.length !== 50) {
    throw new Error("Deterministic capture must produce exactly 50 provider calls");
  }
  const binding = createExpectedReplayBinding(benchmark);
  const fixture = {
    schemaVersion: 1,
    artifactKind: "rubricdelta-exact-provider-replay",
    binding,
    entries,
  };
  assertNoCredentialValues(fixture);
  createReplayProvider({ fixture, expectedBinding: binding });
  return cloneJson(fixture);
}

function serializeFixture(fixture) {
  return JSON.stringify(fixture, null, 2) + "\n";
}

function parseArguments(argv) {
  const options = { check: false, fixture: DEFAULT_FIXTURE_PATH };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--check") {
      options.check = true;
      continue;
    }
    if (value === "--fixture") {
      const path = argv[index + 1];
      if (!path || path.startsWith("--")) throw new Error("--fixture requires a path");
      options.fixture = resolve(path);
      index += 1;
      continue;
    }
    throw new Error("Unknown capture argument");
  }
  return options;
}

function readBoundedFixture(path) {
  const size = statSync(path).size;
  if (size > MAX_FIXTURE_BYTES) throw new Error("Replay fixture byte size exceeds the 8 MiB limit");
  const bytes = readFileSync(path);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Replay fixture JSON is invalid");
  }
  return { bytes, value };
}

function safePublicationStat(path, inspect) {
  try {
    return inspect(path);
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw new Error("Replay fixture publication path validation failed");
  }
}

function assertSafePublicationPath(path, inspect) {
  let current = path;
  let target = true;
  while (true) {
    const details = safePublicationStat(current, inspect);
    if (details?.isSymbolicLink()) {
      throw new Error("Replay fixture publication rejects links, junctions, and reparse points");
    }
    if (details && target && !details.isFile()) {
      throw new Error("Replay fixture publication target must be a regular file");
    }
    if (details && !target && !details.isDirectory()) {
      throw new Error("Replay fixture publication ancestors must be directories");
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
    target = false;
  }
}

export function publishReplayFixture(pathValue, bytes, overrides = {}) {
  if (typeof pathValue !== "string" || pathValue.trim().length === 0
    || !(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array)
    || !overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new Error("Replay fixture publication arguments are invalid");
  }
  const path = resolve(pathValue);
  const io = {
    lstatSync: overrides.lstatSync ?? lstatSync,
    mkdirSync: overrides.mkdirSync ?? mkdirSync,
    writeFileSync: overrides.writeFileSync ?? writeFileSync,
    renameSync: overrides.renameSync ?? renameSync,
    unlinkSync: overrides.unlinkSync ?? unlinkSync,
    randomId: overrides.randomId ?? randomUUID,
  };
  if (Object.values(io).some((value) => typeof value !== "function")) {
    throw new Error("Replay fixture publication dependencies are invalid");
  }

  assertSafePublicationPath(path, io.lstatSync);
  io.mkdirSync(dirname(path), { recursive: true });
  assertSafePublicationPath(path, io.lstatSync);

  const id = io.randomId();
  if (typeof id !== "string" || !/^[A-Za-z0-9-]{1,128}$/.test(id)) {
    throw new Error("Replay fixture publication temporary identity is invalid");
  }
  const tempPath = path + ".tmp-" + id;
  if (safePublicationStat(tempPath, io.lstatSync)) {
    throw new Error("Replay fixture publication temporary path already exists");
  }

  let tempOwned = true;
  try {
    io.writeFileSync(tempPath, bytes, { flag: "wx", flush: true });
    assertSafePublicationPath(path, io.lstatSync);
    io.renameSync(tempPath, path);
    tempOwned = false;
  } finally {
    if (tempOwned) {
      try {
        io.unlinkSync(tempPath);
      } catch {
        // Preserve the original publication failure; the unpredictable temp name remains non-authoritative.
      }
    }
  }
}

async function runCli() {
  const options = parseArguments(process.argv.slice(2));
  const generated = await generateReplayFixture();
  const generatedBytes = Buffer.from(serializeFixture(generated), "utf8");
  if (generatedBytes.length > MAX_FIXTURE_BYTES) {
    throw new Error("Generated replay fixture exceeds the 8 MiB limit");
  }
  if (options.check) {
    const existing = readBoundedFixture(options.fixture);
    createReplayProvider({
      fixture: existing.value,
      expectedBinding: generated.binding,
    });
    if (!existing.bytes.equals(generatedBytes)) {
      throw new Error("Replay capture fixture byte mismatch");
    }
    process.stdout.write("Replay capture fixture is exact and current.\n");
    return;
  }
  publishReplayFixture(options.fixture, generatedBytes);
  process.stdout.write("Wrote deterministic replay fixture: " + options.fixture + "\n");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(modulePath)) {
  runCli().catch((error) => {
    process.stderr.write("Replay capture failed: " + error.message + "\n");
    process.exitCode = 1;
  });
}
