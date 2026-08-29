import { toPublicScenario } from "../domain/scenario.js";
import { analyzeScenario } from "../agents/workflow.js";

export function createAdvancedPredictions(benchmark, options = {}) {
  const scenarioAnalyzer = options.scenarioAnalyzer ?? analyzeScenario;
  const provider = options.provider ?? "deterministic";
  const seed = options.seed ?? 0;
  if (provider !== "deterministic") throw new Error("The offline advanced adapter requires provider=deterministic");
  const cases = benchmark.cases.map((testCase) => {
    const scenario = toPublicScenario(testCase);
    const result = scenarioAnalyzer(scenario, {
      mode: "deterministic",
      maxRecords: options.maxRecords ?? scenario.records.length,
      maxRetries: options.maxRetries ?? 2,
      runId: `evaluation-${scenario.id}`,
    });
    return {
      caseId: scenario.id,
      rankedRecordIds: result.rankedCandidates.map((candidate) => candidate.recordId),
      rankingEvidence: result.rankedCandidates,
      trajectory: result.trace,
      runtimeMs: null,
      estimatedCostUsd: 0,
    };
  });
  return {
    metadata: {
      system: "rubricdelta-four-stage-deterministic",
      runtimeMs: null,
      estimatedCostUsd: 0,
      resourceNotes: "Deterministic offline rule compilation, change analysis, impact ranking, and blind verification.",
      fairnessManifest: {
        benchmarkId: benchmark.benchmarkId,
        caseIds: benchmark.cases.map((testCase) => testCase.id),
        reviewBudgetFraction: benchmark.reviewBudgetFraction,
        provider,
        seed,
      },
    },
    cases,
  };
}
