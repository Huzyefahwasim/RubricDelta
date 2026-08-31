# Implementation Plan

## Objective

Ship a judge-ready RubricDelta submission that demonstrates an end-to-end review workflow, a fair baseline comparison, purposeful agent engineering, complete evidence, and clean reproduction.

## Status convention

A checked item has source-repository evidence. An unchecked item requires final-revision evidence or participant action. After the source freeze, `artifacts/qa/release.json` records completion state so this source plan can remain unchanged. A checked feature does not replace final browser QA or the participant's release decision.

## Success conditions

- A reviewer can load an included example and complete the local deterministic workflow without credentials.
- The evaluation covers ten guideline-revision cases and 100 synthetic records.
- Baseline and advanced runs share the same provider, cases, seed, and 20% review budget.
- The evaluator writes aggregate and per-case results.
- The interface shows rule evidence, verifier challenges, uncertainty, and decision state.
- A clean Node.js environment can run the app, tests, evaluation, and validation commands.
- The final submission contains the four required deliverables and participant confirmations.

## Chosen scope

RubricDelta uses synthetic customer-support ticket routing. Each benchmark case contains:

- an old guideline and a revised guideline;
- ten labeled records with two affected record IDs;
- expected rule deltas and boundary records.

The product prioritizes a review queue. It does not relabel a full dataset or write to an external labeling platform.

## Phases

### Phase 1: Evaluation contract

- [x] Freeze ten benchmark cases with 100 records and 20 affected records.
- [x] Add explicit ground truth and benchmark validation.
- [x] Implement the 20% floor-based review-budget calculation under evaluation protocol v2.
- [x] Implement recall, precision, F1, false-positive count, and per-case reporting.
- [x] Implement the deterministic lexical baseline.
- [x] Record a complete historical deterministic comparison with raw predictions and per-case results.
- [ ] Regenerate final protocol-v2 artifacts from the final clean source revision.

Exit evidence: the repository records baseline `16/20 = 0.80` and advanced `18/20 = 0.90` on the frozen benchmark. The final manifest must identify protocol v2.

### Phase 2: Deterministic agent pipeline

- [x] Compile structured rules with stable IDs and citations.
- [x] Classify rule changes and precedence.
- [x] Generate boundary hypotheses.
- [x] Rank all candidate records.
- [x] Verify candidates and record counterarguments.
- [x] Escalate unresolved ambiguity.
- [x] Record role-complete JSONL event streams.
- [x] Disclose that all ten deterministic case runs terminate `partial` and `escalated`.

Exit evidence: deterministic agent, verifier-boundary, trace-role, and evaluation tests exercise the four stages and their failure behavior.

### Phase 2B: Optional provider and replay release

- [x] Land the complete Task 8 CLI, provider, prompt, capture, fixture, and validator integration.
- [x] Expose `replay:check` and `eval:replay` commands that consume the exact deterministic-role capture.
- [x] Prove that replay binds benchmark, prompts, source, request order, model, mode, and all 50 calls.
- [x] Prove that explicit OpenAI and replay failures never substitute deterministic rankings.
- [x] Run the Task 8 focused suite and build validator on the integrated source.
- [x] Publish the canonical offline replay run under `artifacts/expected-replay-report/operational-replay/` while retaining the deterministic `reference-comparison.json` and its `replayOperational: false` disclosure.
- [x] Treat only the canonical deterministic-evaluation and operational-replay output directories as generated evidence during evaluator Git-provenance capture; unrelated tracked or untracked paths remain source dirt.
- [x] Require build and final validation to cross-check the published operational replay bundle against an isolated exact replay run, frozen source revision, 50-call/50-attempt telemetry, zero-resource claims, and no-substitution/secret contracts.
- [x] Reject any immutable operational manifest drift against the isolated replay while allowing only validated Git, execution-timing, and host-runtime differences.

Exit gate: offline replay reproduces the deterministic comparison with replay provenance, while the default remains synchronous and network-free. No live OpenAI result is required.

### Phase 3: Human decision workflow

- [x] Add approve, reject, and escalate decision commands.
- [x] Add append-only undo.
- [x] Prevent pending, rejected, escalated, and undone corrections from entering CSV export.
- [x] Write decision and undo events to the trajectory.
- [x] Publish revision snapshots and an active-approval-only CSV.
- [ ] Record owner-entered approve, reject, escalate, and undo events during final QA.

Exit evidence: domain and server tests prove the ledger and export boundary. The generated `hackathon-evidence-generator` checkpoint tests the mechanism and does not prove participant review.

### Phase 4: Judge-facing interface

- [x] Build one-click loading for the first public ten-record benchmark case.
- [x] Build the Rule Seam policy-difference workbench.
- [x] Build the ranked impact queue.
- [x] Build the evidence and decision panel.
- [x] Build the ten-case baseline-versus-advanced evaluation view.
- [x] Build the trajectory inspector and downloads.
- [x] Implement keyboard controls, visible focus, reduced-motion styles, and responsive layouts.
- [ ] Record final browser, keyboard, accessibility, and responsive QA at the required viewports.

Exit gate: final QA must show a judge completing the workflow at the final source revision. Unit and contract tests do not replace that record.

### Phase 5: Submission evidence and release

- [x] Record the removed cross-delta inference experiment as EXP-002.
- [x] Record the baseline-to-final system bundle in the Improvement Changelog with linked evaluation evidence.
- [x] Document the main failure mode and supported hot take.
- [x] Store representative deterministic product-agent trajectories.
- [x] Document deterministic provider, model, calls, tokens, cost, and live-run limits.
- [x] Add fail-closed release commands for automated, human, development-agent, video, and composition evidence.
- [x] Make `artifacts/qa/release.json` the post-freeze completion authority.
- [ ] Publish the repository URL through the participant-controlled submission platform.
- [ ] Record final clean-run runtime and command output.
- [ ] Run and record the clean-checkout reproduction.
- [ ] Run and record the final Codex Security scan and accepted-fix verification.
- [ ] Export or share a representative development-agent trajectory after privacy review.
- [ ] Record participant provenance, licenses, eligibility, and originality confirmations.
- [ ] Record owner review and the final release decision.
- [ ] Record, measure, and upload the video at no more than 300 seconds.
- [ ] Publish or package the final commit for judge access.

Exit gate: `npm run validate:final` must pass its automated contracts. The release record must bind separate human, browser, security, clean-clone, development-agent, and video evidence plus the participant's `approve release` decision.

#### Task 5 release-hardening addendum

- [ ] Require one explicit unrecorded `npm run eval` bootstrap immediately after source freeze, before the unchanged ordered seven-command release suite.
- [ ] Make stale deterministic evidence fail before command execution with an actionable bootstrap instruction.
- [ ] Bind participant privacy approval to the exact newline-terminated Codex-export bytes and publish those bytes unchanged.
- [ ] Rebuild and validate the complete final release envelope through shared schema-closed canonical builders, including command summaries, suite, categories, session, participant attestation, human, development, video, revision, and release decision.
- [ ] Make judge reproduction commands executable for the canonical remote and both clean checkouts, and keep security and participant claims revision-scoped and evidence-backed.

Task 5 does not change benchmark cases, ground truth, protocol v2, metrics, providers, deterministic rankings, or the seven recorded commands. R6 is a participant-approved release-contract correction: it updates the independent-verifier v1 final sentence and exact replay fixture/request-hash bindings while preserving the result inventory, source binding, benchmark, protocol, baseline prompt and algorithm, seed, review budget, and deterministic rankings. The addendum becomes complete only after focused release/validator tests, replay verification, the full suite, and a disposable clean-clone bootstrap check.

Verification distinguishes the main source checkout's expected R3 stale manifest failure, where managed evaluation evidence is deliberately left untouched, from a disposable clean clone. In the clone, the unrecorded `npm run eval` bootstrap refreshes managed evidence and the same suite must pass without an R3 failure.

#### Evaluation contract v3 decision

Independent whole-repository review found that the secondary diagnostics already declared in `docs/EVALUATION.md` were not defined precisely or emitted completely. Because the first full protocol-v2 run froze the metric contract, this correction will publish `rubricdelta-evaluation-v3` rather than silently changing v2 history. Protocol v3 supersedes v2 for newly generated evidence while preserving the v2 primary metric, floor-based 20% review budget, benchmark cases and ground truth, deterministic baseline algorithm and prompt, deterministic/replay seed, provider comparison rules, rankings, and recorded `0.80` baseline / `0.90` advanced scores. The only evaluation additions are explicitly defined secondary diagnostics and honest resource/failure disclosure; predictors remain blind to ground truth.

## Decision log

| Date | Decision | Reason |
|---|---|---|
| 2026-08-29 | Use Node.js ESM and built-in tests | Judges can run the offline path without installing packages |
| 2026-08-29 | Use synthetic support-ticket data | The benchmark shows user value without private or high-impact data |
| 2026-08-29 | Declare recall at a 20% review budget | The metric measures affected records found under a fixed review limit |
| 2026-08-29 | Keep the live model provider optional | The benchmark and browser demo remain reproducible without credentials |
| 2026-08-29 | Use an evidence-dense editorial interface | Judges can inspect rules, records, decisions, and trajectories in one workbench |
| 2026-08-30 | Bootstrap frozen evaluation evidence before recording the release suite | A fresh source revision cannot satisfy the manifest-to-HEAD preflight until the unrecorded deterministic evaluation refreshes managed evidence; the recorded suite remains exactly seven commands |
| 2026-08-31 | Publish operational replay beside, not inside, the deterministic reference | `reference-comparison.json` remains the non-operational deterministic score reference. `eval:replay` owns a separate canonical `operational-replay/` bundle. Score values remain canonical in comparison/report artifacts rather than being duplicated into the provenance manifest. |
| 2026-08-31 | Compare normalized operational manifests, not a selected field subset | The isolated replay is the authority for immutable manifest content. Validation permits different Git state, execution timing, and host identity only after those dynamic fields satisfy their own strict schemas. |
| 2026-08-31 | Version the evaluation contract to v3 for defined secondary diagnostics | Independent review found declared diagnostics without exact formulas or complete output. A versioned successor preserves every frozen v2 ranking input, algorithm, seed, budget, primary score, and benchmark value while adding scoring-only diagnostics and honest resource/failure fields. |

## Risks

| Risk | Effect | Mitigation |
|---|---|---|
| The product resembles a text diff | Low agent-engineering score | Show structured rules, boundary cases, verification, and retries |
| Synthetic cases leak into ranking logic | Inflated evaluation | Keep ground truth outside prompts and production ranking code |
| Live model output varies | Weak reproduction | Pin model and prompts, store raw results, separate repetitions, and include exact replay |
| Agent roles add ceremony | Decorative orchestration | Give four stages distinct inputs, outputs, validation, and failure handling |
| The interface lacks final browser evidence | Unproven end-to-end quality | Record keyboard, accessibility, responsive, and export QA on the final revision |
| Rank errors consume the review budget | Missed affected records | Report precision, expose verifier uncertainty, and keep the accessibility failure visible |
