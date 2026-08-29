# RubricDelta benchmark

This directory contains the frozen synthetic benchmark for measuring which labels a guideline revision may have made stale.

## Identity and license

- Benchmark ID: `rubricdelta-support-guideline-drift-v1`
- Cases: 10
- Records: 100
- Affected records: 20
- License: CC0-1.0

All names, messages, policies, and labels are synthetic.

## Evaluation contract

RubricDelta scores this fixture under [`rubricdelta-evaluation-v2`](../../docs/EVALUATION_PROTOCOL_V2.md). The protocol gives each nonempty case `max(1, floor(recordCount * fraction))` review slots.

- Each case contains 10 records and 2 affected records.
- The 20% review budget gives each case 2 review slots.
- The primary metric is micro-averaged affected-record recall at that budget.
- Precision and F1 use the same cutoff.
- Each case includes expected labels and evidence-backed rationales for scoring.
- Case `fraud-overrides-refunds` tests precedence: a new fraud rule overrides the general refund rule.

Ground truth stays inside benchmark and evaluator boundaries. Product agents receive public scenario fields without affected-record IDs, expected labels, or rationales.

## Prediction format

```json
{
  "metadata": {
    "system": "rubricdelta-four-stage-deterministic",
    "algorithmVersion": "rubricdelta-four-stage-deterministic-v1",
    "provider": "deterministic",
    "model": null,
    "seed": 0
  },
  "cases": [
    {
      "caseId": "fraud-overrides-refunds",
      "rankedRecordIds": ["fraud-08", "fraud-03", "fraud-01"]
    }
  ]
}
```

`rankedRecordIds` must contain known, unique record IDs. The evaluator reads the first two IDs for each frozen case. A system may submit fewer records, but unused review slots count against fixed-budget precision.

## Official baseline

The submitted baseline is the deterministic lexical algorithm `added-guideline-term-overlap-v1`. It derives query terms from words added to the new guideline, ranks records by term overlap, and breaks ties by input order. It makes zero provider calls and produces 16/20 = 0.80 affected-record recall at the fixed review budget.

The submitted advanced deterministic system produces 18/20 = 0.90 under the same cases, order, seed, provider, and review budget. The comparison measures the complete advanced system bundle. It does not identify one stage as the cause of the gain.

## Replay fixture

`replay/rubricdelta-deterministic-source.v1.json` contains `deterministic-role-capture` results for the provider workflow. It binds protocol, benchmark bytes and order, prompts, capture-source files, model `deterministic-role-capture-v1`, mode, repetition count, and all 50 ordered requests and results.

Use:

```bash
npm run replay:check
npm run eval:replay
```

The fixture requires no network access. It records zero tokens, provider latency, and cost. It contains deterministic captures rather than OpenAI responses and must not support a live-model claim.
