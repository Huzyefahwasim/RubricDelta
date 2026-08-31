function deepFreeze(value) {
  for (const child of Object.values(value)) {
    if (child && typeof child === "object" && !Object.isFrozen(child)) {
      deepFreeze(child);
    }
  }
  return Object.freeze(value);
}

export const EVALUATION_PROTOCOL = deepFreeze({
  id: "rubricdelta-evaluation-v3",
  version: 3,
  supersedes: "rubricdelta-evaluation-v2",
  effectiveDate: "2026-08-31",
  primaryMetric: "microAffectedRecallAtReviewBudget",
  reviewBudget: {
    fractionSource: "benchmark.reviewBudgetFraction",
    calculation: "max(1, floor(recordCount * fraction))",
    rounding: "floor",
    minimumSlotsForNonemptyCase: 1,
  },
  secondaryDiagnostics: {
    rounding: "rates and reciprocal-rank values are rounded to six decimal places",
    reciprocalRankFirstAffected: {
      perCase: "1 / rank of the first affected record in the complete submitted ranking; 0 when absent",
      aggregate: "arithmetic mean across every benchmark case (MRR)",
    },
    unsupportedClaimRate: {
      denominator: "selected reviewed claims",
      baselineSupport: "nonempty matchedTerms under matched-terms-v1",
      advancedSupport: "support verdict, complete evidence, precedence checked, aligned record evidence, and changed-rule citation under verifier-support-v1",
      missingOrMalformedEvidence: "unsupported",
      zeroDenominator: 0,
      comparison: "system-native structural diagnostic; not comparable across support contracts",
    },
    escalationRate: {
      numerator: "selected reviewed advanced claims with verifier.verdict=\"uncertain\"",
      denominator: "selected reviewed claims",
      zeroDenominator: 0,
      applicability: "verifier-support-v1 only; other contracts report applicable=false",
    },
    resources: {
      fields: ["providerCalls", "providerAttempts", "inputTokens", "outputTokens", "totalTokens", "providerLatencyMs", "runtimeMs", "estimatedCostUsd"],
      unknown: null,
      aggregate: "sum only when every included per-case value is known; otherwise null",
    },
  },
});
