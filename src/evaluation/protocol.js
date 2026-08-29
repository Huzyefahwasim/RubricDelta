function deepFreeze(value) {
  for (const child of Object.values(value)) {
    if (child && typeof child === "object" && !Object.isFrozen(child)) {
      deepFreeze(child);
    }
  }
  return Object.freeze(value);
}

export const EVALUATION_PROTOCOL = deepFreeze({
  id: "rubricdelta-evaluation-v2",
  version: 2,
  supersedes: "rubricdelta-evaluation-v1",
  effectiveDate: "2026-08-29",
  primaryMetric: "microAffectedRecallAtReviewBudget",
  reviewBudget: {
    fractionSource: "benchmark.reviewBudgetFraction",
    calculation: "max(1, floor(recordCount * fraction))",
    rounding: "floor",
    minimumSlotsForNonemptyCase: 1,
  },
});
