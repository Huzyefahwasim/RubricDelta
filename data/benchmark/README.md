# RubricDelta benchmark

This directory contains a deterministic, synthetic benchmark for measuring how
well a system finds labels made stale by a guideline revision.

## Evaluation contract

- Each case contains 10 records.
- A reviewer may inspect only 20% of a case, so the cutoff is exactly 2 records.
- Each case has 2 genuinely affected records.
- The primary metric is micro-averaged affected-record recall at that fixed
  review budget.
- Precision at budget and F1 at budget are reported with the same cutoff.
- Every case includes explicit expected labels and evidence-backed rationales.
- Case `fraud-overrides-refunds` is the hard precedence case: a new fraud rule
  overrides the otherwise applicable refund rule.

All names, messages, policies, and labels are synthetic. The benchmark may be
redistributed under CC0-1.0.

## Prediction format

```json
{
  "metadata": {
    "system": "rubricdelta-final",
    "runtimeMs": 1234,
    "estimatedCostUsd": 0.0123,
    "resourceNotes": "Measured over the complete benchmark run"
  },
  "cases": [
    {
      "caseId": "fraud-overrides-refunds",
      "rankedRecordIds": ["fraud-03", "fraud-08", "fraud-01"],
      "runtimeMs": 102,
      "estimatedCostUsd": 0.0012
    }
  ]
}
```

`rankedRecordIds` must contain known, unique IDs. The evaluator uses only the
first 2. A system may submit fewer, but unused review slots count against
precision so abstention cannot inflate the fixed-budget score.

The bundled lexical baseline derives query terms only from words added to the
new guideline, ranks records by overlap, and breaks ties by input order. It is a
transparent retrieval baseline, not a claimed substitute for the direct-model
baseline used in the final hackathon report.
