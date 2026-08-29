#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";
import {
  createAdvancedPredictions,
  createBaselinePredictions,
  DEFAULT_BENCHMARK_PATH,
  evaluatePredictions,
  loadBenchmark,
} from "../src/evaluation/index.js";
import {
  createProviderAdvancedPredictions,
  createProviderBaselinePredictions,
} from "../src/evaluation/provider-predictions.js";
import { createOpenAIProvider } from "../src/providers/openai.js";
import { createReplayProvider } from "../src/providers/replay.js";
import {
  benchmarkSourceAt,
  createEvaluationArtifacts,
  createPublicBenchmarkProjection,
  displayPath,
  createProviderEvaluationArtifacts,
} from "./evaluation-artifacts.js";
import { createExpectedReplayBinding } from "./capture-replay.js";

const HELP = `RubricDelta evaluation CLI

New reproducible workflow:
  node scripts/evaluate.js --mode baseline|advanced|both [--output-dir <dir>]

Legacy evaluator workflow:
  node scripts/evaluate.js --baseline
  node scripts/evaluate.js --predictions <path>

Options:
  --mode <value>       Run baseline, advanced, or both (default: both)
  --output-dir <dir>   Artifact directory (default: artifacts/evaluation)
  --provider <value>   deterministic, replay, or openai (default: deterministic)
  --model <id>         Required pinned model ID for explicit OpenAI runs
  --replay-fixture <path>  Required exact fixture for explicit replay runs
  --repeats <count>    Positive number of paired repetitions (default: 1)
  --benchmark <path>   Override data/benchmark/benchmark.json
  --predictions <path> Legacy: evaluate candidate JSON; use - for stdin
  --baseline           Legacy: evaluate the bundled lexical baseline
  --output <path>      Legacy: also write the complete JSON result
  --summary-only       Legacy: omit per-case details from stdout/output
  --compact            Print compact JSON
  --help               Show this help
`;

const VALUE_FLAGS = new Set([
  "--mode",
  "--output-dir",
  "--provider",
  "--model",
  "--replay-fixture",
  "--repeats",
  "--benchmark",
  "--predictions",
  "--output",
]);
const BOOLEAN_FLAGS = new Set(["--baseline", "--summary-only", "--compact", "--help", "-h"]);

function splitArgument(argument) {
  if (!argument.startsWith("--") || !argument.includes("=")) return [argument, undefined];
  const separator = argument.indexOf("=");
  return [argument.slice(0, separator), argument.slice(separator + 1)];
}

function positiveInteger(value, flag) {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`${flag} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${flag} must be a positive safe integer`);
  return parsed;
}

export function parseArguments(argv) {
  const options = {
    baseline: false,
    benchmarkPath: DEFAULT_BENCHMARK_PATH,
    predictionsPath: undefined,
    outputPath: undefined,
    summaryOnly: false,
    compact: false,
    mode: undefined,
    outputDir: undefined,
    provider: undefined,
    model: undefined,
    replayFixturePath: undefined,
    repeats: undefined,
    help: false,
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const [flag, inlineValue] = splitArgument(argv[index]);
    if (!VALUE_FLAGS.has(flag) && !BOOLEAN_FLAGS.has(flag)) throw new Error(`Unknown argument: ${flag}`);
    if (seen.has(flag) && !["--help", "-h"].includes(flag)) throw new Error(`Duplicate argument: ${flag}`);
    seen.add(flag);
    if (BOOLEAN_FLAGS.has(flag)) {
      if (inlineValue !== undefined) throw new Error(`${flag} does not accept a value`);
      if (flag === "--baseline") options.baseline = true;
      if (flag === "--summary-only") options.summaryOnly = true;
      if (flag === "--compact") options.compact = true;
      if (flag === "--help" || flag === "-h") options.help = true;
      continue;
    }
    const value = inlineValue ?? argv[index + 1];
    if (value === undefined || value === "" || (inlineValue === undefined && value.startsWith("--"))) {
      throw new Error(`${flag} requires a value`);
    }
    if (inlineValue === undefined) index += 1;
    if (flag === "--mode") options.mode = value;
    if (flag === "--output-dir") options.outputDir = resolve(value);
    if (flag === "--provider") options.provider = value;
    if (flag === "--model") options.model = value;
    if (flag === "--replay-fixture") options.replayFixturePath = resolve(value);
    if (flag === "--repeats") options.repeats = positiveInteger(value, "--repeats");
    if (flag === "--benchmark") options.benchmarkPath = resolve(value);
    if (flag === "--predictions") options.predictionsPath = value === "-" ? "-" : resolve(value);
    if (flag === "--output") options.outputPath = resolve(value);
  }
  if (options.help) return options;
  const legacy = options.baseline || options.predictionsPath !== undefined;
  const newFlags = ["--mode", "--output-dir", "--provider", "--model", "--replay-fixture", "--repeats"].filter((flag) => seen.has(flag));
  if (legacy && newFlags.length > 0) throw new Error(`Legacy --baseline/--predictions conflict with ${newFlags.join(", ")}`);
  if (options.baseline && options.predictionsPath !== undefined) throw new Error("Choose exactly one of --baseline or --predictions <path>");
  if (legacy) return { ...options, interface: "legacy" };
  if (seen.has("--output") || seen.has("--summary-only")) throw new Error("--output and --summary-only are legacy options and conflict with --mode");
  const mode = options.mode ?? "both";
  if (!["baseline", "advanced", "both"].includes(mode)) throw new Error("--mode must be baseline, advanced, or both");
  const provider = options.provider ?? "deterministic";
  if (!["deterministic", "replay", "openai"].includes(provider)) throw new Error("--provider must be deterministic, replay, or openai");
  if (provider === "deterministic" && options.model !== undefined) {
    throw new Error("--model cannot be used with provider deterministic");
  }
  if (provider === "deterministic" && options.replayFixturePath !== undefined) {
    throw new Error("--replay-fixture conflicts with provider deterministic");
  }
  if (provider === "replay" && options.replayFixturePath === undefined) {
    throw new Error("--replay-fixture is required with provider replay");
  }
  if (provider === "replay" && options.model !== undefined) {
    throw new Error("--model cannot override the replay fixture model");
  }
  if (provider === "openai" && options.model === undefined) {
    throw new Error("--model is required with provider openai");
  }
  if (provider === "openai" && options.replayFixturePath !== undefined) {
    throw new Error("--replay-fixture conflicts with provider openai");
  }
  return {
    ...options,
    interface: "artifacts",
    mode,
    outputDir: options.outputDir ?? resolve("artifacts/evaluation"),
    provider,
    model: options.model ?? null,
    repeats: options.repeats ?? 1,
  };
}

function readPredictions(filePath) {
  const source = filePath === "-" ? readFileSync(0, "utf8") : readFileSync(filePath, "utf8");
  return JSON.parse(source);
}

function legacyEvaluation(options) {
  const benchmark = loadBenchmark(options.benchmarkPath);
  const predictions = options.baseline
    ? createBaselinePredictions(createPublicBenchmarkProjection(benchmark))
    : readPredictions(options.predictionsPath);
  const completeResult = evaluatePredictions(benchmark, predictions);
  const printableResult = options.summaryOnly
    ? Object.fromEntries(Object.entries(completeResult).filter(([key]) => key !== "perCase"))
    : completeResult;
  const output = `${JSON.stringify(printableResult, null, options.compact ? 0 : 2)}\n`;
  process.stdout.write(output);
  if (options.outputPath) writeFileSync(options.outputPath, output, "utf8");
}

export function providerAvailability(provider) {
  if (provider === "deterministic") return { operational: true, task: 7 };
  if (provider === "replay" || provider === "openai") return { operational: true, task: 8 };
  return { operational: false, task: 8, message: "Unknown provider" };
}

const MAX_REPLAY_FIXTURE_BYTES = 8 * 1024 * 1024;

export function readBoundedReplayBytes(path, overrides = {}) {
  if (typeof path !== "string" || path.length === 0
    || !overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new Error("Replay fixture reader configuration is invalid");
  }
  const io = {
    openSync: overrides.openSync ?? openSync,
    fstatSync: overrides.fstatSync ?? fstatSync,
    readSync: overrides.readSync ?? readSync,
    closeSync: overrides.closeSync ?? closeSync,
  };
  if (Object.values(io).some((value) => typeof value !== "function")) {
    throw new Error("Replay fixture reader configuration is invalid");
  }

  let handle;
  try {
    handle = io.openSync(path, "r");
  } catch {
    throw new Error("Replay fixture is required and must be readable");
  }

  let pendingError = null;
  try {
    let details;
    try {
      details = io.fstatSync(handle);
    } catch {
      throw new Error("Replay fixture handle validation failed");
    }
    if (!details || typeof details.isFile !== "function" || !details.isFile()) {
      throw new Error("Replay fixture must be a regular file");
    }
    if (!Number.isSafeInteger(details.size) || details.size < 0
      || details.size > MAX_REPLAY_FIXTURE_BYTES) {
      throw new Error("Replay fixture byte size exceeds the 8 MiB limit");
    }

    const buffer = Buffer.allocUnsafe(MAX_REPLAY_FIXTURE_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      let count;
      try {
        count = io.readSync(handle, buffer, offset, buffer.length - offset, null);
      } catch {
        throw new Error("Replay fixture bounded read failed");
      }
      if (!Number.isInteger(count) || count < 0 || count > buffer.length - offset) {
        throw new Error("Replay fixture bounded read returned an invalid byte count");
      }
      if (count === 0) break;
      offset += count;
    }
    if (offset > MAX_REPLAY_FIXTURE_BYTES) {
      throw new Error("Replay fixture byte size exceeds the 8 MiB limit");
    }
    return Buffer.from(buffer.subarray(0, offset));
  } catch (error) {
    pendingError = error;
    throw error;
  } finally {
    try {
      io.closeSync(handle);
    } catch {
      if (!pendingError) throw new Error("Replay fixture handle close failed");
    }
  }
}

function readReplayFixture(path) {
  let details;
  try {
    details = lstatSync(path);
  } catch {
    throw new Error("Replay fixture is required and must be a readable regular file");
  }
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new Error("Replay fixture must be a non-linked regular file");
  }
  if (details.size > MAX_REPLAY_FIXTURE_BYTES) {
    throw new Error("Replay fixture byte size exceeds the 8 MiB limit");
  }
  const bytes = readBoundedReplayBytes(path);
  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Replay fixture has invalid UTF-8 encoding");
  }
  let fixture;
  try {
    fixture = JSON.parse(source);
  } catch {
    throw new Error("Replay fixture JSON is invalid");
  }
  return {
    fixture,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function replayProviderFor(options) {
  if (resolve(options.benchmarkPath) !== resolve(DEFAULT_BENCHMARK_PATH)) {
    throw new Error("Replay benchmark binding requires the bundled benchmark");
  }
  const loaded = readReplayFixture(options.replayFixturePath);
  const expectedBinding = createExpectedReplayBinding();
  if (options.mode !== expectedBinding.mode) {
    throw new Error("Replay mode must exactly match the fixture binding");
  }
  if (options.repeats !== expectedBinding.repeats) {
    throw new Error("Replay repeat count must exactly match the fixture binding");
  }
  const provider = createReplayProvider({
    fixture: loaded.fixture,
    expectedBinding,
  });
  return {
    provider,
    model: expectedBinding.model,
    replay: {
      binding: expectedBinding,
      source: expectedBinding.source,
      fixture: { sha256: loaded.sha256 },
    },
  };
}

function openAIProviderFor(options) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
    throw new Error("OPENAI_API_KEY is required with provider openai");
  }
  return {
    provider: createOpenAIProvider({ apiKey, model: options.model }),
    model: options.model,
    replay: null,
  };
}

function artifactEvaluation(options) {
  const benchmark = loadBenchmark(options.benchmarkPath);
  const result = createEvaluationArtifacts({
    benchmark,
    benchmarkSource: benchmarkSourceAt(options.benchmarkPath),
    mode: options.mode,
    outputDir: options.outputDir,
    provider: options.provider,
    model: options.model,
    repeats: options.repeats,
    createBaseline: createBaselinePredictions,
    createAdvanced: createAdvancedPredictions,
    score: evaluatePredictions,
  });
  const summary = {
    benchmarkId: benchmark.benchmarkId,
    provider: options.provider,
    model: options.model,
    repeats: options.repeats,
    outputDir: displayPath(result.outputDir),
    baseline: result.comparison.baseline?.primaryMetric ?? null,
    advanced: result.comparison.advanced?.primaryMetric ?? null,
    replayStatus: result.manifest.replay.status,
  };
  process.stdout.write(`${JSON.stringify(summary, null, options.compact ? 0 : 2)}\n`);
}

async function providerArtifactEvaluation(options) {
  const selected = options.provider === "replay"
    ? replayProviderFor(options)
    : openAIProviderFor(options);
  const benchmark = loadBenchmark(options.benchmarkPath);
  const result = await createProviderEvaluationArtifacts({
    benchmark,
    benchmarkSource: benchmarkSourceAt(options.benchmarkPath),
    mode: options.mode,
    outputDir: options.outputDir,
    provider: selected.provider,
    model: selected.model,
    repeats: options.repeats,
    createBaseline: createProviderBaselinePredictions,
    createAdvanced: createProviderAdvancedPredictions,
    score: evaluatePredictions,
    replay: selected.replay,
  });
  const summary = {
    benchmarkId: benchmark.benchmarkId,
    provider: options.provider,
    model: selected.model,
    repeats: options.repeats,
    outputDir: displayPath(result.outputDir),
    baseline: result.summary.baseline?.primaryMetric ?? null,
    advanced: result.summary.advanced?.primaryMetric ?? null,
    replayStatus: result.manifest.replay.status,
  };
  process.stdout.write(`${JSON.stringify(summary, null, options.compact ? 0 : 2)}\n`);
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(HELP);
    return undefined;
  }
  if (options.interface === "legacy") return legacyEvaluation(options);
  if (options.provider === "deterministic") return artifactEvaluation(options);
  return providerArtifactEvaluation(options);
}

function reportCliFailure(error) {
  process.stderr.write(`Evaluation failed: ${error.message}\n`);
  process.exitCode = 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  try {
    const operation = main();
    if (operation && typeof operation.then === "function") {
      operation.catch(reportCliFailure);
    }
  } catch (error) {
    reportCliFailure(error);
  }
}

export { createEvaluationArtifacts, createPublicBenchmarkProjection } from "./evaluation-artifacts.js";
