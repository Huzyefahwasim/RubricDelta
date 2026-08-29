# Improvement Changelog

Record each experiment against the same evaluation contract. Include failed and removed experiments.

## Experiment template

### EXP-XXX: Short name

- Date:
- Hypothesis:
- Change:
- Evaluation command:
- Benchmark version:
- Before:
- After:
- Cost or runtime change:
- Failure analysis:
- Decision: keep, revise, or remove
- Evidence paths:

## EXP-000: Direct baseline

- Date: 2026-08-29
- Hypothesis: A direct comparison of the two guidelines can find obvious affected records but will miss precedence and exception changes.
- Change: Establish the frozen baseline before advanced implementation.
- Evaluation command: `npm run eval:baseline`
- Benchmark version: pending freeze
- Before: none
- After: pending
- Cost or runtime change: pending
- Failure analysis: pending
- Decision: keep as the official baseline
- Evidence paths: `artifacts/evaluation/`

## Main failure mode

RubricDelta may over-rank records that share changed-rule vocabulary but do not satisfy the changed condition. The verifier and boundary tests aim to reduce these false positives. The final submission will report the remaining rate and representative examples.

## Working hot take

High reviewer agreement can coexist with shared guideline drift. Teams should evaluate policy-version impact, not agreement alone.
