#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServerDataService } from "../src/evaluation/server-data.js";
import { createRubricDeltaApplication } from "../src/server/app.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseArguments(argv) {
  const options = {
    evaluationDir: resolve(repositoryRoot, "artifacts/evaluation"),
    outputDir: resolve(repositoryRoot, "artifacts/representative-trajectories"),
    expectedReplayDir: resolve(repositoryRoot, "artifacts/expected-replay-report"),
  };
  const fields = new Map([
    ["--evaluation-dir", "evaluationDir"],
    ["--output-dir", "outputDir"],
    ["--expected-replay-dir", "expectedReplayDir"],
  ]);
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const separator = argv[index].indexOf("=");
    const flag = separator === -1 ? argv[index] : argv[index].slice(0, separator);
    const field = fields.get(flag);
    if (!field) throw new Error(`Unknown argument: ${flag}`);
    if (seen.has(flag)) throw new Error(`Duplicate argument: ${flag}`);
    seen.add(flag);
    const inline = separator === -1 ? undefined : argv[index].slice(separator + 1);
    const value = inline ?? argv[index + 1];
    if (!value || (inline === undefined && value.startsWith("--"))) throw new Error(`${flag} requires a value`);
    if (inline === undefined) index += 1;
    options[field] = resolve(value);
  }
  return options;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readJsonLines(path) {
  const source = readFileSync(path, "utf8").trim();
  if (!source) throw new Error(`Trajectory is empty: ${path}`);
  return source.split("\n").map((line) => JSON.parse(line));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeJsonLines(path, events) {
  if (!Array.isArray(events) || events.length === 0) throw new Error(`Refusing to write empty evidence: ${path}`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
}

function traceEntries(evaluationDir) {
  const predictions = readJson(join(evaluationDir, "advanced-predictions.json"));
  return predictions.cases.map((item) => ({
    caseId: item.caseId,
    events: readJsonLines(join(evaluationDir, "trajectories", `${item.caseId}.jsonl`)),
  }));
}

function findTrace(entries, predicate, description) {
  const entry = entries.find(({ events }) => predicate(events));
  if (!entry) throw new Error(`Real evaluation contains no ${description} branch`);
  return entry;
}

async function jsonRequest(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

async function generateHumanCheckpoint(outputDir) {
  const temporaryArtifacts = mkdtempSync(join(tmpdir(), "rubricdelta-human-evidence-"));
  const application = createRubricDeltaApplication({
    host: "127.0.0.1",
    port: 0,
    publicRoot: join(repositoryRoot, "public"),
    artifactRoot: temporaryArtifacts,
    dataService: createServerDataService(),
  });
  try {
    await application.start();
    const base = application.address();
    const demo = await jsonRequest(`${base}/api/demo`);
    const created = await jsonRequest(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scenario: demo.scenario }),
    });
    const candidate = created.run.recommendations.find((item) => item.verifier?.verdict === "support") ?? created.run.recommendations[0];
    await jsonRequest(`${base}/api/runs/${created.runId}/decisions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        recordId: candidate.recordId,
        decision: "approve",
        reviewer: "hackathon-evidence-generator",
        reason: "Representative attributable approval through the guarded server endpoint.",
      }),
    });
    const response = await fetch(`${base}/api/runs/${created.runId}/trajectory.jsonl`);
    if (!response.ok) throw new Error(`Could not fetch human checkpoint trajectory: HTTP ${response.status}`);
    const events = (await response.text()).trimEnd().split("\n").map((line) => JSON.parse(line));
    if (!events.some((event) => event.agent === "human-reviewer"
      && event.type === "human-decision"
      && event.payload?.reviewer === "hackathon-evidence-generator")) {
      throw new Error("Guarded server path did not record the attributed human checkpoint");
    }
    writeJsonLines(join(outputDir, "human-checkpoint.jsonl"), events);
  } finally {
    await application.stop();
    rmSync(temporaryArtifacts, { recursive: true, force: true });
  }
}

async function generate(options) {
  const entries = traceEntries(options.evaluationDir);
  const disagreement = findTrace(entries, (events) => {
    const verdicts = new Set(events.filter((event) => event.agent === "skeptical-verifier").map((event) => event.payload?.verdict));
    return verdicts.has("support") && verdicts.has("reject");
  }, "successful verifier-disagreement");
  const retry = findTrace(entries, (events) => events.some((event) => event.type === "retry")
    && events.some((event) => event.type === "escalation")
    && events.some((event) => event.payload?.recovered === true), "natural retry-and-recovery");
  const uncertain = findTrace(entries, (events) => events.some((event) => event.agent === "skeptical-verifier" && event.payload?.verdict === "uncertain"), "uncertain abstention");

  writeJsonLines(join(options.outputDir, "success-verifier-disagreement.jsonl"), disagreement.events);
  writeJsonLines(join(options.outputDir, "natural-retry-recovery.jsonl"), retry.events);
  writeJsonLines(join(options.outputDir, "uncertain-abstention.jsonl"), uncertain.events);
  await generateHumanCheckpoint(options.outputDir);
  writeFileSync(join(options.outputDir, "README.md"), `# Representative trajectories

These sanitized JSONL files are generated by \`node scripts/generate-evidence.js\` through the real deterministic evaluator and guarded local HTTP review endpoint.

- \`success-verifier-disagreement.jsonl\`: successful support and a skeptical verifier rejection in one complete run.
- \`natural-retry-recovery.jsonl\`: a benchmark case that naturally triggers bounded retry, escalation, and deterministic recovery.
- \`uncertain-abstention.jsonl\`: a verifier declines to claim complete evidence.
- \`human-checkpoint.jsonl\`: an attributable approval recorded by the server-owned decision gate.

Do not edit these events by hand; regenerate them from the command above.
`, "utf8");

  const comparison = readJson(join(options.evaluationDir, "comparison.json"));
  const baselineSource = readFileSync(join(options.evaluationDir, "baseline-predictions.json"));
  const advancedSource = readFileSync(join(options.evaluationDir, "advanced-predictions.json"));
  const reference = {
    schemaVersion: 1,
    status: "expected-reference-only-task-7",
    provider: "deterministic",
    replayOperational: false,
    substituted: false,
    benchmarkId: comparison.benchmarkId,
    baseline: comparison.baseline,
    advanced: comparison.advanced,
    improvement: comparison.improvement,
    artifacts: {
      baselinePredictionsSha256: sha256(baselineSource),
      advancedPredictionsSha256: sha256(advancedSource),
    },
  };
  writeJson(join(options.expectedReplayDir, "reference-comparison.json"), reference);
  writeFileSync(join(options.expectedReplayDir, "README.md"), `# Expected replay reference

Task 7 records this deterministic result as the exact reference Task 8 replay must reproduce. Replay is not operational in this build and the CLI fails instead of substituting deterministic output.

- Baseline: ${reference.baseline.primaryMetric.numerator}/${reference.baseline.primaryMetric.denominator} = ${reference.baseline.primaryMetric.value.toFixed(2)}
- Advanced: ${reference.advanced.primaryMetric.numerator}/${reference.advanced.primaryMetric.denominator} = ${reference.advanced.primaryMetric.value.toFixed(2)}
- Absolute improvement: +${reference.improvement.absolute.toFixed(2)}

The JSON file binds the reference to hashes of the raw gold-free predictions, not volatile Git or timing metadata.
`, "utf8");
}

try {
  await generate(parseArguments(process.argv.slice(2)));
  process.stdout.write("Representative evidence generated from evaluator and server workflows.\n");
} catch (error) {
  process.stderr.write(`Evidence generation failed: ${error.message}\n`);
  process.exitCode = 1;
}
