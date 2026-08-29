# RubricDelta Evaluation Protocol v2 Amendment

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development for behavior changes and superpowers:verification-before-completion before reporting success.

**Goal:** Correct the review-budget rounding mismatch while preserving the frozen benchmark, ground truth, predictions, and measured `16/20` to `18/20` result.

**Architecture:** `src/evaluation/protocol.js` owns one deep-frozen, machine-readable protocol object. The evaluator computes each nonempty case budget with `max(1, floor(recordCount * fraction))`; artifact manifests embed an exact structured clone and repeat the same calculation string in `reviewBudget.calculation`.

**Tech Stack:** Node.js 24+, ECMAScript modules, `node:test`, dependency-free offline evaluation.

**Spec:** `docs/EVALUATION_PROTOCOL_V2.md`

## Binding status

This document amends both `docs/superpowers/specs/2026-08-29-rubricdelta-submission-design.md` and `docs/superpowers/plans/2026-08-29-rubricdelta-hackathon-submission.md`. It replaces any implementation or artifact text that uses ceiling rounding for the 20 percent review budget. The frozen benchmark still contains 10 records per case and receives two slots per case under both formulas. This focused amendment does not overwrite Task 7 evidence. Task 8 regenerates protocol-v2 evidence after its source commit and stores it in a separate evidence-only commit.

## Global constraints

- Do not change case IDs, records, ground truth, rankings, seed, provider, or metric formulas beyond the rounding correction named here.
- Keep the deterministic evaluation API synchronous and dependency-free.
- Leave Task 7 evidence unchanged; Task 8 regenerates protocol-v2 evidence only after its source commit.
- Preserve baseline `16/20 = 0.80` and advanced `18/20 = 0.90` on the frozen 100-record benchmark.
- Store the exact protocol object shown in the specification in every new deterministic or provider evaluation manifest.

### Task 1: Lock the 11-record boundary

**Files:**
- Modify: `tests/evaluation.test.js`
- Modify: `src/evaluation/benchmark.js`

**Interfaces:**
- Consumes: a nonempty case and `fraction` in `(0, 1]`.
- Produces: `reviewBudgetForCase(testCase, fraction)` with a minimum of one slot and floor rounding.

- [ ] Add a test with 11 records and fraction `0.20`; assert a literal budget of `2`.
- [ ] Run `node --test tests/evaluation.test.js` against ceiling rounding and confirm the test reports `3 !== 2`.
- [ ] Replace ceiling rounding with `Math.floor`.
- [ ] Run `node --test tests/evaluation.test.js` and confirm every focused test passes.

### Task 2: Publish the machine-readable protocol

**Files:**
- Create: `src/evaluation/protocol.js`
- Create: `tests/evaluation-protocol.test.js`
- Modify: `src/evaluation/index.js`

**Interfaces:**
- Produces: deep-frozen `EVALUATION_PROTOCOL` with ID `rubricdelta-evaluation-v2` and version `2`.

- [ ] Add a test that imports the missing module, deep-compares the complete literal object, and checks the root plus nested review-budget object are frozen.
- [ ] Run `node --test tests/evaluation-protocol.test.js` and confirm `ERR_MODULE_NOT_FOUND`.
- [ ] Create the protocol module and export it through the evaluation index.
- [ ] Run `node --test tests/evaluation-protocol.test.js` and confirm the test passes.

### Task 3: Bind manifests and disclose the correction

**Files:**
- Modify: `tests/evaluation-protocol.test.js`
- Modify: `scripts/evaluation-artifacts.js`
- Modify: `docs/EVALUATION.md`
- Modify: `IMPROVEMENT_CHANGELOG.md`

**Interfaces:**
- Produces: `manifest.evaluationProtocol`, an exact structured clone of `EVALUATION_PROTOCOL`, and a matching `manifest.reviewBudget.calculation` string.

- [ ] Add focused manifest assertions for the exact protocol object, structured-clone identity, and matching floor calculation.
- [ ] Run `node --test tests/evaluation-protocol.test.js` and confirm the manifest protocol is `undefined`.
- [ ] Add the protocol clone and calculation to manifest generation.
- [ ] Run `node --test tests/evaluation.test.js tests/evaluation-protocol.test.js tests/cli.test.js` and confirm all focused tests pass.
- [ ] Record REL-008 with the mismatch, agent-development process, unchanged frozen scores, and the Task 7/Task 8 evidence boundary.
- [ ] Run `git diff --check` and report the exact RED and GREEN commands without committing.
