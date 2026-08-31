const STOP_WORDS = new Set([
  "a", "all", "an", "and", "are", "as", "at", "be", "been", "but", "by",
  "case", "cases", "customer", "customers", "do", "even", "every", "for", "from",
  "go", "has", "have", "if", "in", "into", "is", "it", "its", "of", "on",
  "once", "or", "ordinary", "other", "over", "report", "reports", "request",
  "requests", "route", "routed", "routing", "that", "the", "their", "them", "this",
  "to", "when", "with",
]);

export function tokenize(value) {
  return (String(value).normalize("NFKD").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token));
}

export function addedGuidelineTerms(testCase) {
  const oldTerms = new Set(tokenize(testCase.oldGuideline.text));
  return [...new Set(tokenize(testCase.newGuideline.text).filter((term) => !oldTerms.has(term)))];
}

export function rankBaselineCase(testCase) {
  const queryTerms = new Set(addedGuidelineTerms(testCase));
  return testCase.records
    .map((record, inputIndex) => {
      const recordTerms = new Set(tokenize(record.text));
      const matchedTerms = [...queryTerms].filter((term) => recordTerms.has(term)).sort();
      return {
        recordId: record.id,
        score: matchedTerms.length,
        matchedTerms,
        inputIndex,
      };
    })
    .sort((left, right) => right.score - left.score || left.inputIndex - right.inputIndex)
    .map(({ inputIndex: _inputIndex, ...ranking }) => ranking);
}

export function createBaselinePredictions(benchmark) {
  return {
    metadata: {
      system: "added-guideline-term-overlap-baseline",
      claimSupportContract: "matched-terms-v1",
      runtimeMs: null,
      estimatedCostUsd: 0,
      resourceNotes: "Deterministic local lexical baseline; runtime is intentionally not claimed.",
    },
    cases: benchmark.cases.map((testCase) => {
      const ranking = rankBaselineCase(testCase);
      return {
        caseId: testCase.id,
        rankedRecordIds: ranking.map((item) => item.recordId),
        rankingEvidence: ranking,
        resources: {
          providerCalls: 0,
          providerAttempts: 0,
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          providerLatencyMs: 0,
          runtimeMs: null,
          estimatedCostUsd: 0,
        },
      };
    }),
  };
}
