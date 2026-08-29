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

## EXP-005: Local review API security boundary

- Date: 2026-08-29
- Hypothesis: A dependency-free loopback HTTP boundary can expose the deterministic review workflow without leaking benchmark gold or weakening the human export gate.
- Change: Added strict JSON/size/method handling, server-owned runs and serialized decision ledgers, complete artifacts, guarded CSV/trajectory endpoints, static containment, public demo projection, and evaluator-owned paired summaries.
- Evaluation command: `node --test tests/server.test.js` and `node --test`
- Benchmark version: `support-routing-drift-v1`
- Before: no HTTP application; frozen baseline recall `0.80`, advanced recall `0.90`
- After: 14 server integration/security tests and 70 full-suite tests pass; paired recall remains `0.80` versus `0.90`
- Cost or runtime change: offline deterministic server path; no tokens or model cost; startup precomputes the ten-case paired summary
- Failure analysis: The first full run correctly rejected an evaluator import inside `src/server`; the wire moved to one narrow `src/composition.js` seam while route/controller modules remained gold-blind.
- Decision: keep
- Evidence paths: `tests/server.test.js`, `src/server/`, `src/evaluation/server-data.js`, `.superpowers/sdd/2026-08-29-rubricdelta-hackathon-submission/task-5-report.md`