# Evaluation Protocol v2

RubricDelta names the current scoring contract `rubricdelta-evaluation-v2`.

## Machine-readable contract

```json
{
  "id": "rubricdelta-evaluation-v2",
  "version": 2,
  "supersedes": "rubricdelta-evaluation-v1",
  "effectiveDate": "2026-08-29",
  "primaryMetric": "microAffectedRecallAtReviewBudget",
  "reviewBudget": {
    "fractionSource": "benchmark.reviewBudgetFraction",
    "calculation": "max(1, floor(recordCount * fraction))",
    "rounding": "floor",
    "minimumSlotsForNonemptyCase": 1
  }
}
```

`src/evaluation/protocol.js` exports this object as `EVALUATION_PROTOCOL`. Evaluation manifests store an exact structured clone under `evaluationProtocol`.

## Correction from v1

The first implementation used ceiling rounding even though `docs/EVALUATION.md`, the approved design, and the browser used floor rounding. Protocol v2 resolves that mismatch in favor of the declared formula:

```text
review slots = max(1, floor(record count * review budget fraction))
```

An 11-record case at a 20 percent budget receives two review slots. A nonempty case receives at least one slot.

## Frozen-result impact

The frozen benchmark has 10 cases with 10 records each. Floor and ceiling both yield two review slots for each frozen case. Protocol v2 does not change the benchmark, ground truth, predictions, or measured result:

- baseline: `16/20 = 0.80` affected-record recall;
- advanced: `18/20 = 0.90` affected-record recall.

This focused amendment does not overwrite the Task 7 evidence. Task 8 will regenerate protocol-v2 evidence after its source commit and place that evidence in a separate evidence-only commit. Until then, the Task 7 manifest remains a truthful historical artifact from the protocol-v1 implementation.
