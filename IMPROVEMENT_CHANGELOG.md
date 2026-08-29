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
## EXP-005 Fix Round 1: Transactional HTTP publication hardening

- Date: 2026-08-29
- Hypothesis: Immutable revision snapshots published through one atomic current pointer can make HTTP mutations fail closed while bounded validation, explicit cache policy, method gates, and canonical static identity close the remaining transport risks without changing ranking behavior.
- Change: Replayed ledgers into shadow runs with original human timestamps; wrote seven-file revision snapshots before `current.json`; swapped authoritative memory only after publication; bounded attacker-controlled shapes and scenario complexity; added no-store/static cache policies, static 405 handling, and Windows short-name/canonical-identity rejection; drained but never retained oversized request tails so 413 responses complete without exceeding the one MiB buffer cap.
- Evaluation command: `node --test tests/server.test.js` and `node --test`
- Benchmark version: `support-routing-drift-v1`
- Before: adversarial RED had 18 tests, 7 passed, 11 failed; persistence failures could mutate live export state, error fields reflected attacker keys, static POST returned 404, dynamic cache policy was implicit, scenario complexity was unbounded, and short-name aliases passed the raw predicate.
- After: 18 focused server tests and 74 full-suite tests pass; paired recall remains frozen at baseline `0.80` versus advanced `0.90`.
- Cost or runtime change: each successful decision writes a complete seven-file revision before one small pointer; failed revisions may remain as unreachable evidence. Oversized bodies are discarded after the cap rather than buffered.
- Failure analysis: a full-suite-only `ECONNRESET` reproduced on iteration 6 because Windows could truncate the 413 response while unread request bytes remained. Continuing to consume excess chunks without storing them eliminated the reset in 20 consecutive full-suite runs.
- Decision: keep
- Evidence paths: `tests/server.test.js`, `src/server/router.js`, `src/server/app.js`, `.superpowers/sdd/2026-08-29-rubricdelta-hackathon-submission/task-5-report.md`