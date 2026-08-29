#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createBaselinePredictions,
  evaluatePredictions,
  loadBenchmark,
} from "../src/evaluation/index.js";

const HELP = `RubricDelta deterministic evaluator

Usage:
  node scripts/evaluate.js --baseline
  node scripts/evaluate.js --predictions path/to/predictions.json

Options:
  --benchmark <path>    Override data/benchmark/benchmark.json
  --predictions <path>  Evaluate a candidate JSON file; use - for stdin
  --baseline            Evaluate the bundled lexical baseline
  --output <path>       Also write the complete JSON result to a file
  --summary-only        Print the top-level summary without per-case details
  --compact             Print compact JSON instead of indented JSON
  --help                Show this help
`;

function parseArguments(argv) {
  const options = {
    baseline: false,
    benchmarkPath: undefined,
    predictionsPath: undefined,
    outputPath: undefined,
    summaryOnly: false,
    compact: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--baseline") options.baseline = true;
    else if (argument === "--summary-only") options.summaryOnly = true;
    else if (argument === "--compact") options.compact = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else if (["--benchmark", "--predictions", "--output"].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      index += 1;
      if (argument === "--benchmark") options.benchmarkPath = resolve(value);
      if (argument === "--predictions") options.predictionsPath = value === "-" ? "-" : resolve(value);
      if (argument === "--output") options.outputPath = resolve(value);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!options.help && options.baseline === Boolean(options.predictionsPath)) {
    throw new Error("Choose exactly one of --baseline or --predictions <path>");
  }
  return options;
}

function readPredictions(filePath) {
  const source = filePath === "-" ? readFileSync(0, "utf8") : readFileSync(filePath, "utf8");
  return JSON.parse(source);
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }

  const benchmark = loadBenchmark(options.benchmarkPath);
  const predictions = options.baseline
    ? createBaselinePredictions(benchmark)
    : readPredictions(options.predictionsPath);
  const completeResult = evaluatePredictions(benchmark, predictions);
  const printableResult = options.summaryOnly
    ? { ...completeResult, perCase: undefined }
    : completeResult;
  const indentation = options.compact ? 0 : 2;
  const output = `${JSON.stringify(printableResult, null, indentation)}\n`;

  process.stdout.write(output);
  if (options.outputPath) writeFileSync(options.outputPath, output, "utf8");
}

try {
  main();
} catch (error) {
  process.stderr.write(`Evaluation failed: ${error.message}\n`);
  process.exitCode = 1;
}
