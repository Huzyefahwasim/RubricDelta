# EXP-002 Retrospective Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve reproducible, data-only evidence for the removed unsupported cross-delta inference that scored 19/20 before hardening and 18/20 after hardening.

**Architecture:** Store complete gold-free baseline and advanced rankings from two isolated Git archives. A dependency-free verifier checks file hashes, benchmark order, ranking completeness, absence of evaluator-only fields, exact top-two differences, current-evaluator scores, and historical Git objects when the repository contains them. The archive contains no executable legacy implementation.

**Tech Stack:** Node.js 24 ESM, built-in `node:test`, built-in `crypto`, `fs`, `child_process`, and the current RubricDelta evaluator.

**Spec:** `docs/superpowers/specs/2026-08-29-rubricdelta-submission-design.md`

## Global Constraints

- Keep the offline path free of runtime package dependencies.
- Do not change benchmark ground truth, ranking code, provider code, or `package.json`.
- Store only rankings and provenance in the retrospective; omit ground truth, customer data, trajectories, and per-system runtime claims.
- Compare the same frozen 10 cases, 100 records, 20 affected records, 20 percent budget, deterministic provider, and seed 0.
- Record protocol-v1 ceiling and protocol-v2 floor equivalence for ten-record cases: both allocate two slots.
- Do not execute historical source from the verifier. Use Git objects only as optional provenance checks.

---

### Task 1: Verifier contract and RED test

**Files:**
- Create: `tests/removed-experiment.test.js`
- Create: `scripts/verify-removed-experiment.js`

**Interfaces:**
- Consumes: `node scripts/verify-removed-experiment.js [--artifact-dir <path>]`
- Produces: exit 0 and a JSON summary for valid evidence; exit 1 with a stable error code for tampered evidence.

- [ ] **Step 1: Write the failing success-path test**

Spawn the verifier and assert literal metrics: baseline `16/20`, before advanced `19/20`, after advanced `18/20`, plus the two changed top-two queues.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test tests/removed-experiment.test.js`

Expected: FAIL because `scripts/verify-removed-experiment.js` does not exist.

- [ ] **Step 3: Add the minimal verifier entry point**

Read the artifact directory, validate the declared files, score predictions with `loadBenchmark` and `evaluatePredictions`, and print the summary.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `node --test tests/removed-experiment.test.js`

Expected: PASS.

### Task 2: Durable retrospective data

**Files:**
- Create: `artifacts/experiments/exp-002-unsupported-inference/manifest.json`
- Create: `artifacts/experiments/exp-002-unsupported-inference/before-predictions.json`
- Create: `artifacts/experiments/exp-002-unsupported-inference/after-predictions.json`
- Create: `artifacts/experiments/exp-002-unsupported-inference/comparison.json`
- Create: `artifacts/experiments/exp-002-unsupported-inference/tests.json`

**Interfaces:**
- Consumes: rankings reproduced from Git archives at `21e5cc4b...` and `ba60a574...` under Node `v24.19.0`.
- Produces: complete ordered baseline and advanced rankings with SHA-256 bindings and no evaluator-only fields.

- [ ] **Step 1: Add literal gold-free rankings**

Each prediction file stores the source revision, deterministic provider, seed 0, and every record ID exactly once in frozen case order.

- [ ] **Step 2: Add hand-derived comparison facts**

Record accessibility `2 TP -> 0 TP`, chargeback `1 TP -> 2 TP`, and aggregate advanced `19/20 -> 18/20`. Record the unchanged baseline `16/20`.

- [ ] **Step 3: Add provenance and test observations**

Bind the benchmark, metric, and loader blobs; label test totals as retrospective archive observations; set runtime claims to `null`.

- [ ] **Step 4: Compute and record file SHA-256 values**

Hash `before-predictions.json`, `after-predictions.json`, `comparison.json`, and `tests.json` as exact UTF-8 bytes.

### Task 3: Tamper resistance

**Files:**
- Modify: `tests/removed-experiment.test.js`
- Modify: `scripts/verify-removed-experiment.js`

**Interfaces:**
- Consumes: copied artifact directories with controlled mutations.
- Produces: `HASH_MISMATCH`, `PREDICTIONS_CONTAIN_GOLD`, or `INVALID_PREDICTIONS` failures.

- [ ] **Step 1: Add failing mutation tests**

Copy the artifact directory to a temporary path, then test a changed ranking, injected `groundTruth`, and reordered case.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test tests/removed-experiment.test.js`

Expected: each mutation reaches its named assertion failure until the matching validation exists.

- [ ] **Step 3: Add bounded validation and optional Git checks**

Reject files above one MiB, unsafe shapes, unexpected case order, incomplete rankings, evaluator-only keys, hash mismatches, metric mismatches, and difference mismatches. If both historical commits exist, compare the three shared blob identities and the transition-scoring source blobs.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `node --test tests/removed-experiment.test.js`

Expected: PASS with all mutations rejected.

### Task 4: Retrospective prose and project record

**Files:**
- Create: `artifacts/experiments/exp-002-unsupported-inference/README.md`
- Modify: `IMPROVEMENT_CHANGELOG.md`

**Interfaces:**
- Consumes: verified metrics and provenance from Tasks 1 through 3.
- Produces: a precise EXP-002 removal decision and reproduction command.

- [ ] **Step 1: Write the archive README**

Explain the reconstruction boundary, exact source revisions, protocol equivalence, verifier command, and the absence of a runtime claim or legacy execution path.

- [ ] **Step 2: Append EXP-002 without replacing concurrent entries**

State that the 19/20 path used unsupported cross-delta label inference, the hardened path scored 18/20, and engineering integrity outweighed one benchmark hit. Disclose that the after commit also contains adjacent validation hardening, so the comparison is historical rather than a causal ablation.

- [ ] **Step 3: Apply stop-slop review**

Remove filler, em dashes, binary contrasts, adverbs, vague claims, and passive voice from both prose files.

### Task 5: Verification

**Files:**
- Verify only; do not commit.

**Interfaces:**
- Consumes: the complete scoped change.
- Produces: fresh focused, verifier, full-suite, and diff evidence.

- [ ] **Step 1: Run the verifier**

Run: `node scripts/verify-removed-experiment.js`

Expected: exit 0; baseline `16/20`; before advanced `19/20`; after advanced `18/20`; Git status `verified` when objects exist.

- [ ] **Step 2: Run focused tests**

Run: `node --test tests/removed-experiment.test.js`

Expected: all tests pass.

- [ ] **Step 3: Run the full suite**

Run: `node --test`

Expected: zero failures.

- [ ] **Step 4: Inspect scope and secrets**

Run: `git diff --check` and inspect `git status --short` plus the scoped diff. Confirm no provider, capture, evaluation implementation, benchmark, or package files changed for this task.
