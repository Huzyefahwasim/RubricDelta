import { toPublicScenario } from "../domain/scenario.js";
import { loadBenchmark } from "./benchmark.js";
import { createBaselinePredictions } from "./baseline.js";
import { createAdvancedPredictions } from "./advanced.js";
import { evaluatePredictions } from "./metrics.js";

function publicEvaluation(result) {
  return {
    benchmarkId: result.benchmarkId,
    system: result.system,
    reviewBudgetFraction: result.reviewBudgetFraction,
    caseCount: result.caseCount,
    primaryMetric: result.primaryMetric,
    metrics: result.metrics,
    resourceUse: result.resourceUse,
    warnings: result.warnings,
    perCase: result.perCase.map((item) => ({
      caseId: item.caseId,
      title: item.title,
      difficulty: item.difficulty,
      changeType: item.changeType,
      reviewBudget: item.reviewBudget,
      counts: item.counts,
      metrics: item.metrics,
      resourceUse: item.resourceUse,
    })),
  };
}

export function createServerDataService() {
  const benchmark = loadBenchmark();
  const scenario = toPublicScenario(benchmark.cases[0]);
  const baselinePredictions = createBaselinePredictions(benchmark);
  const advancedPredictions = createAdvancedPredictions(benchmark, { provider: "deterministic", seed: 0 });
  const evaluation = {
    manifest: structuredClone(advancedPredictions.metadata.fairnessManifest),
    baseline: publicEvaluation(evaluatePredictions(benchmark, baselinePredictions)),
    advanced: publicEvaluation(evaluatePredictions(benchmark, advancedPredictions)),
  };

  return {
    demo() {
      return { scenario: structuredClone(scenario) };
    },
    evaluation() {
      return structuredClone(evaluation);
    },
  };
}
