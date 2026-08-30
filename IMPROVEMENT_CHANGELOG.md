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

## EXP-000: Direct lexical baseline

- Date: 2026-08-29
- Hypothesis: Words added to a revised guideline provide a transparent retrieval baseline for obvious vocabulary matches, with known weakness on paraphrase, precedence, and exception changes.
- Change: Added `added-guideline-term-overlap-v1`. It derives terms from text added to the new guideline, ranks records by overlap, and breaks ties by frozen input order. It does not use rule compilation, boundary generation, verification, retries, or provider calls.
- Evaluation command: `npm run eval:baseline`
- Benchmark version: canonical `rubricdelta-support-guideline-drift-v1` under `rubricdelta-evaluation-v2`; 10 cases, 100 records, 20 affected records, and 2 review slots per case.
- Before: No scored baseline.
- After: The baseline found 16 of 20 affected records, for 0.80 micro affected-record recall at the fixed 20% review budget.
- Cost or runtime change: Zero provider calls, attempts, tokens, provider latency, and model cost. The artifact records total command runtime and makes no per-system speed claim.
- Failure analysis: The baseline found one of two affected records in each of `fraud-overrides-refunds`, `security-vulnerability`, `multi-customer-outage`, and `regulated-text-translation`. Shared words displaced one affected record from each two-slot queue.
- Decision: Keep as the official baseline because judges can inspect and reproduce every ranking rule.
- Evidence paths: `src/evaluation/baseline.js`, `artifacts/evaluation/baseline-predictions.json`, `artifacts/evaluation/comparison.json`, `artifacts/evaluation/report.md`, and `tests/evaluation.test.js`.

## EXP-001: Largest supported measured deterministic system bundle

- Date: 2026-08-29
- Hypothesis: An evidence-bound multi-role ranking workflow can place more affected records inside the same two-slot review budget than direct lexical overlap.
- Change: Measured the complete deterministic ranking bundle: rule compiler, change analyst, impact investigator, skeptical verifier, controller validation, bounded retries, and escalation. The workflow records rule and record citations plus counterarguments. The product keeps recommendations behind the human approval gate.
- Evaluation command: `npm run eval`
- Benchmark version: canonical `rubricdelta-support-guideline-drift-v1` under `rubricdelta-evaluation-v2`; identical cases, record order, deterministic provider, seed 0, and review budget for both systems.
- Before: Direct lexical baseline found 16/20 = 0.80.
- After: The advanced bundle found 18/20 = 0.90. The absolute improvement is 0.10 at the fixed 20% review budget.
- Cost or runtime change: Both systems make zero provider calls and attempts, use zero model tokens, record zero provider latency, and cost $0. The evaluation records total command runtime without a per-system runtime comparison.
- Failure analysis: The advanced bundle selected both affected records in the hard precedence case but missed both affected records in `assistive-technology-blocker`. Its queue selected `a11y-03` and `a11y-07`, leaving `a11y-02` and `a11y-04` outside the review budget.
- Causal limit: The paired result measures the complete bundle. No submitted ablation assigns the 0.10 gain to one role, retry, prompt, or validation stage.
- Decision: Keep as the official advanced deterministic system. Retain the accessibility miss as a visible limitation.
- Evidence paths: `artifacts/evaluation/manifest.json`, `artifacts/evaluation/baseline-predictions.json`, `artifacts/evaluation/advanced-predictions.json`, `artifacts/evaluation/comparison.json`, `artifacts/evaluation/report.md`, `artifacts/evaluation/trajectories/`, and `tests/agent-workflow.test.js`.

## Main failure mode

The advanced queue fails on `assistive-technology-blocker`. Vocabulary and boundary signals place `a11y-03` and `a11y-07` in the two review slots, while ground-truth affected records `a11y-02` and `a11y-04` fall outside the budget. See `docs/MAIN_FAILURE_MODE.md` for the release explanation.

## Hot take

Reviewer agreement cannot detect a shared misreading of the same guideline. Teams should measure which historical records a policy revision affects, then route the evidence to a qualified reviewer. See `docs/HOT_TAKE.md`.

## EXP-005: Local review API security boundary

- Date: 2026-08-29
- Hypothesis: A dependency-free loopback HTTP boundary can expose the deterministic review workflow without leaking benchmark gold or weakening the human export gate.
- Change: Added strict JSON, size, and method handling; server-owned runs and serialized decision ledgers; complete artifacts; guarded CSV and trajectory endpoints; static containment; public demo projection; and evaluator-owned paired summaries.
- Evaluation command: `node --test tests/server.test.js` and `node --test`
- Historical benchmark ID: `support-routing-drift-v1`. The canonical submission benchmark ID is `rubricdelta-support-guideline-drift-v1`.
- Before: No HTTP application; frozen baseline recall 0.80 and advanced recall 0.90.
- After: 14 server integration and security tests plus 70 full-suite tests passed; paired recall remained 0.80 versus 0.90.
- Cost or runtime change: The server uses the offline deterministic path with no tokens or model cost. Startup precomputes the ten-case paired summary.
- Failure analysis: The first full run rejected an evaluator import inside `src/server`. The implementation moved the wire to `src/composition.js` while route and controller modules remained gold-blind.
- Decision: Keep.
- Evidence paths: `tests/server.test.js`, `src/server/`, `src/evaluation/server-data.js`, and `.superpowers/sdd/2026-08-29-rubricdelta-hackathon-submission/task-5-report.md`.

## EXP-005 Fix Round 1: Transactional HTTP publication hardening

- Date: 2026-08-29
- Hypothesis: Immutable revision snapshots published through one atomic current pointer can make HTTP mutations fail closed while bounded validation, cache policy, method gates, and canonical static identity close the remaining transport risks without changing ranking behavior.
- Change: Replayed ledgers into shadow runs with original decision timestamps; wrote seven-file revision snapshots before `current.json`; swapped authoritative memory after publication; bounded attacker-controlled shapes and scenario complexity; added no-store and static cache policies, static 405 handling, and Windows short-name and canonical-identity rejection; drained oversized request tails without retaining bytes past the one MiB cap.
- Evaluation command: `node --test tests/server.test.js` and `node --test`
- Historical benchmark ID: `support-routing-drift-v1`. The canonical submission benchmark ID is `rubricdelta-support-guideline-drift-v1`.
- Before: Adversarial RED had 18 tests, 7 passed and 11 failed. Persistence failures could mutate live export state; error fields reflected attacker keys; static POST returned 404; scenario complexity had no bound; and short-name aliases passed the raw predicate.
- After: 18 focused server tests and 74 full-suite tests passed; paired recall remained frozen at baseline 0.80 versus advanced 0.90.
- Cost or runtime change: Each successful decision writes a complete seven-file revision before one small pointer. Failed revisions may remain as unreachable evidence. The server discards oversized bodies after the cap.
- Failure analysis: A full-suite `ECONNRESET` reproduced on iteration 6 because Windows could truncate the 413 response while unread request bytes remained. Consuming excess chunks without storing them eliminated the reset in 20 consecutive full-suite runs.
- Decision: Keep.
- Evidence paths: `tests/server.test.js`, `src/server/router.js`, `src/server/app.js`, and `.superpowers/sdd/2026-08-29-rubricdelta-hackathon-submission/task-5-report.md`.

## REL-008: Evaluation protocol v2 correction

- Date: 2026-08-29
- Trigger: A release audit found that the evaluator used ceiling rounding while the evaluation contract, approved design, and browser used floor rounding.
- Change: Added machine-readable contract `rubricdelta-evaluation-v2`, changed the evaluator to `max(1, floor(recordCount * fraction))`, and made deterministic and provider manifests store an exact protocol clone.
- Development-agent disclosure: Codex agents performed project planning and this correction. Earlier work used the Superpowers brainstorming and writing-plans skills. This correction used test-driven-development, verification-before-completion, and stop-slop. The `gh-fix-ci` and `gh-address-comments` skills did not contribute because no pull request or CI review occurred.
- Evaluation commands: `node --test tests/evaluation.test.js`; `node --test tests/evaluation-protocol.test.js`; `node --test tests/evaluation.test.js tests/evaluation-protocol.test.js tests/cli.test.js`.
- Before: An 11-record case at 20% received 3 slots from `ceil`. The manifest described ceiling rounding.
- After: The same case receives 2 slots. New manifests identify protocol v2 and publish the floor calculation.
- Frozen benchmark impact: None. Each frozen case contains 10 records, so both formulas yield 2 slots. Baseline remains 16/20 = 0.80 and advanced remains 18/20 = 0.90.
- Evidence handling: The release procedure generates protocol-v2 artifacts from a clean source revision and stores them in a later evidence-only commit. Artifacts generated from a dirty source tree do not qualify as canonical evidence.
- Interpretation: REL-008 corrects release integrity. It changes no ranking and provides no measured agent-quality gain.
- Decision: Keep the correction and version the contract.
- Evidence paths: `docs/EVALUATION_PROTOCOL_V2.md`, `src/evaluation/protocol.js`, `scripts/evaluation-artifacts.js`, `tests/evaluation.test.js`, and `tests/evaluation-protocol.test.js`.

## EXP-002: Remove unsupported cross-delta label inference

- Date: 2026-08-29
- Reconstruction status: Retrospective data captured from isolated Git archives. The verifier does not execute legacy source.
- Hypothesis: Awarding transition points when a record label matched any compiled old rule would raise affected-record recall.
- Change: Revision `21e5cc4b2dc2d1612b50e479e9639c9f0279e79e` allowed a label match against any old rule. Revision `ba60a574ad3ec065039687651c808521ee420634` restricted transition points to labels named by the selected delta.
- Evaluation commands: `node scripts/verify-removed-experiment.js` and `node --test tests/removed-experiment.test.js`.
- Historical benchmark identity: The archive uses legacy ID `support-routing-drift-v1` and benchmark blob `5dafb1adde80ffbc5598bbfa6a0ba36bd6c1030c`. The canonical submission uses ID `rubricdelta-support-guideline-drift-v1`. The archive retains its original ID and bytes for provenance.
- Frozen composition: 10 cases, 100 records, 20 affected records, and 2 review slots per case.
- Shared evaluator objects: metrics `ba90be783b4795a7511722b4eeb72daf108bce90`, historical benchmark loader `f97f206b694e7506df4cd42848d9c9b563a9b662`, and baseline `37a573c9c6569596360929b0e638f57b15efce38`.
- Before: Baseline 16/20 = 0.80; advanced 19/20 = 0.95; historical archive tests 35/35.
- After: Baseline 16/20 = 0.80; advanced 18/20 = 0.90; historical archive tests 46/46.
- Queue differences: The accessibility case changed from `a11y-02,a11y-04` with two hits to `a11y-03,a11y-07` with zero hits. The chargeback case changed from `dispute-02,dispute-04` with one hit and `dispute-07` missed to `dispute-02,dispute-07` with two hits. The net change was one fewer affected record found.
- Protocol note: The historical evaluator used ceiling rounding and protocol v2 uses floor rounding. Each frozen case has ten records, so both formulas allocate two slots at a 20% budget.
- Cost or runtime change: No per-system runtime claim. Both paths use the offline deterministic provider with zero model calls, tokens, and model cost.
- Failure analysis: The extra benchmark hit depended on label-transition evidence that the selected delta did not support. Keeping that inference would reward a claim outside the cited rule change.
- Causal limit: The after revision also added validation hardening. This record proves the source-bound before-and-after behavior and does not present the commit comparison as an isolated causal ablation.
- Decision: Remove. Evidence integrity takes priority over the unsupported 19/20 result.
- Evidence paths: `artifacts/experiments/exp-002-unsupported-inference/`, `scripts/verify-removed-experiment.js`, and `tests/removed-experiment.test.js`.

## REL-009: Fail-closed release evidence and judge narrative

- Date: 2026-08-30
- Trigger: The Task 9 release audit found that source prose could drift from participant QA, privacy, security, video, and approval state after the source freeze.
- Change: Added buffered release commands for automated checks, participant review, development-agent evidence, video inspection, and final composition. Aligned the judge-facing documents with canonical evidence paths and a 4 minutes 40 seconds demo target.
- Evaluation command: `node --test tests/release-evidence.test.js` for the producer contract; Task 9 verification also runs the focused validator tests and `npm test`.
- Before: Source checklists carried release state, and the model disclosure retained a stale Task 8 fixture warning.
- After: `artifacts/qa/release.json` owns post-freeze completion state. The model disclosure cites the committed 50-entry deterministic-source fixture. Source documents make no participant QA, privacy approval, security PASS, video, upload, playback, live OpenAI, or platform-submission claim.
- Cost or runtime change: No ranking change and no per-system runtime claim. The release commands add local verification work and zero provider cost.
- Failure analysis: Before the source freeze, the Task 8 manifest names an older source revision. Under Controller Ruling 3, the corresponding current-repository build assertion remains the sole allowed full-suite failure through Task 5. Regeneration at the frozen source revision resolves that binding; weakening the validator would hide it.
- Decision: Keep the evidence producer and source/evidence split. Participant-controlled facts enter the release record only after the participant supplies them.
- Evidence paths: `scripts/release-evidence.js`, `tests/release-evidence.test.js`, `docs/REPRODUCTION.md`, `docs/DEVELOPMENT_AGENT_DISCLOSURE.md`, and `artifacts/qa/release.json` when the release composer succeeds.
