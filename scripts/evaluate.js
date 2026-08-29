#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAdvancedPredictions,
  createBaselinePredictions,
  DEFAULT_BENCHMARK_PATH,
  evaluatePredictions,
  loadBenchmark,
} from "../src/evaluation/index.js";
import {
  benchmarkSourceAt,
  createEvaluationArtifacts,
  createPublicBenchmarkProjection,
  displayPath,
} from "./evaluation-artifacts.js";

const HELP = `RubricDelta evaluation CLI

New reproducible workflow:
  node scripts/evaluate.js --mode baseline|advanced|both [--output-dir <dir>]

Legacy evaluator workflow:
  node scripts/evaluate.js --baseline
  node scripts/evaluate.js --predictions <path>

Options:
  --mode <value>       Run baseline, advanced, or both (default: both)
  --output-dir <dir>   Artifact directory (default: artifacts/evaluation)
  --provider <value>   deterministic, replay, or openai (Task 7 runs deterministic only)
  --model <id>         Pinned model ID for a future non-deterministic provider
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
    if (flag === "--repeats") options.repeats = positiveInteger(value, "--repeats");
    if (flag === "--benchmark") options.benchmarkPath = resolve(value);
    if (flag === "--predictions") options.predictionsPath = value === "-" ? "-" : resolve(value);
    if (flag === "--output") options.outputPath = resolve(value);
  }
  if (options.help) return options;
  const legacy = options.baseline || options.predictionsPath !== undefined;
  const newFlags = ["--mode", "--output-dir", "--provider", "--model", "--repeats"].filter((flag) => seen.has(flag));
  if (legacy && newFlags.length > 0) throw new Error(`Legacy --baseline/--predictions conflict with ${newFlags.join(", ")}`);
  if (options.baseline && options.predictionsPath !== undefined) throw new Error("Choose exactly one of --baseline or --predictions <path>");
  if (legacy) return { ...options, interface: "legacy" };
  if (seen.has("--output") || seen.has("--summary-only")) throw new Error("--output and --summary-only are legacy options and conflict with --mode");
  const mode = options.mode ?? "both";
  if (!["baseline", "advanced", "both"].includes(mode)) throw new Error("--mode must be baseline, advanced, or both");
  const provider = options.provider ?? "deterministic";
  if (!["deterministic", "replay", "openai"].includes(provider)) throw new Error("--provider must be deterministic, replay, or openai");
  if (provider === "deterministic" && options.model !== undefined) throw new Error("--model cannot be used with provider deterministic");
  if (provider === "openai" && options.model === undefined) throw new Error("--model is required with provider openai");
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
  return { operational: false, task: 8, message: `Provider ${provider} is unavailable in Task 7; Task 8 must install it before use` };
}

function artifactEvaluation(options) {
  const availability = providerAvailability(options.provider);
  if (!availability.operational) throw new Error(availability.message);
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

export function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  if (options.interface === "legacy") legacyEvaluation(options);
  else artifactEvaluation(options);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Evaluation failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

export { createEvaluationArtifacts, createPublicBenchmarkProjection } from "./evaluation-artifacts.js";
