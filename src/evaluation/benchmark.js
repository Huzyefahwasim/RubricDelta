import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_BENCHMARK_PATH = resolve(
  moduleDirectory,
  "../../data/benchmark/benchmark.json",
);

function invariant(condition, message) {
  if (!condition) {
    throw new Error(`Invalid benchmark: ${message}`);
  }
}

export function reviewBudgetForCase(testCase, fraction) {
  invariant(Number.isFinite(fraction) && fraction > 0 && fraction <= 1, "review budget fraction must be in (0, 1]");
  invariant(Array.isArray(testCase?.records) && testCase.records.length > 0, `case ${testCase?.id ?? "<unknown>"} has no records`);
  return Math.max(1, Math.ceil(testCase.records.length * fraction));
}

export function validateBenchmark(benchmark) {
  invariant(benchmark && typeof benchmark === "object", "root must be an object");
  invariant(typeof benchmark.benchmarkId === "string" && benchmark.benchmarkId.length > 0, "benchmarkId is required");
  invariant(
    Number.isFinite(benchmark.reviewBudgetFraction)
      && benchmark.reviewBudgetFraction > 0
      && benchmark.reviewBudgetFraction <= 1,
    "reviewBudgetFraction must be in (0, 1]",
  );
  invariant(Array.isArray(benchmark.cases) && benchmark.cases.length >= 10, "at least 10 cases are required");

  const caseIds = new Set();
  const globalRecordIds = new Set();
  let hasHardPrecedenceCase = false;

  for (const testCase of benchmark.cases) {
    invariant(typeof testCase.id === "string" && testCase.id.length > 0, "every case needs an id");
    invariant(!caseIds.has(testCase.id), `duplicate case id ${testCase.id}`);
    caseIds.add(testCase.id);

    invariant(typeof testCase.oldGuideline?.text === "string", `case ${testCase.id} needs old guideline text`);
    invariant(typeof testCase.newGuideline?.text === "string", `case ${testCase.id} needs new guideline text`);
    invariant(typeof testCase.changeSummary === "string" && testCase.changeSummary.length > 0, `case ${testCase.id} needs a change summary`);
    invariant(Array.isArray(testCase.records) && testCase.records.length > 0, `case ${testCase.id} needs records`);

    const localRecordIds = new Set();
    for (const record of testCase.records) {
      invariant(typeof record.id === "string" && record.id.length > 0, `case ${testCase.id} has a record without an id`);
      invariant(!localRecordIds.has(record.id), `case ${testCase.id} has duplicate record id ${record.id}`);
      invariant(!globalRecordIds.has(record.id), `record id ${record.id} is not globally unique`);
      localRecordIds.add(record.id);
      globalRecordIds.add(record.id);
      invariant(typeof record.text === "string" && record.text.length > 0, `record ${record.id} needs text`);
      invariant(typeof record.existingLabel === "string" && record.existingLabel.length > 0, `record ${record.id} needs an existing label`);
    }

    const truth = testCase.groundTruth;
    invariant(Array.isArray(truth?.affectedRecordIds) && truth.affectedRecordIds.length > 0, `case ${testCase.id} needs affected-record ground truth`);
    invariant(new Set(truth.affectedRecordIds).size === truth.affectedRecordIds.length, `case ${testCase.id} has duplicate affected IDs`);
    invariant(truth.expectedLabels && typeof truth.expectedLabels === "object", `case ${testCase.id} needs expected labels`);
    invariant(truth.rationales && typeof truth.rationales === "object", `case ${testCase.id} needs rationales`);

    for (const recordId of truth.affectedRecordIds) {
      invariant(localRecordIds.has(recordId), `case ${testCase.id} references unknown affected record ${recordId}`);
      invariant(typeof truth.expectedLabels[recordId] === "string", `case ${testCase.id} lacks expected label for ${recordId}`);
      invariant(typeof truth.rationales[recordId] === "string", `case ${testCase.id} lacks rationale for ${recordId}`);
      const record = testCase.records.find((item) => item.id === recordId);
      invariant(record.existingLabel !== truth.expectedLabels[recordId], `affected record ${recordId} does not change label`);
    }

    const budget = reviewBudgetForCase(testCase, benchmark.reviewBudgetFraction);
    invariant(
      truth.affectedRecordIds.length <= budget,
      `case ${testCase.id} has more affected records than its review budget, making perfect recall impossible`,
    );

    if (testCase.difficulty === "hard" && testCase.changeType === "precedence_exception") {
      hasHardPrecedenceCase = true;
    }
  }

  invariant(hasHardPrecedenceCase, "a hard precedence/exception case is required");
  return benchmark;
}

export function loadBenchmark(filePath = DEFAULT_BENCHMARK_PATH) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Could not load benchmark at ${filePath}: ${error.message}`, { cause: error });
  }
  return validateBenchmark(parsed);
}
