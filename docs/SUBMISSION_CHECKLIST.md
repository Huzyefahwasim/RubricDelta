# Submission Checklist

This source checklist defines the release contract. `artifacts/qa/release.json` records post-freeze completion and binds each PASS category to a unique evidence file. An unchecked source item does not authorize an agent to claim participant action. Missing release evidence leaves the item unverified.

## Participant eligibility and registration

- [ ] The participant is at least 18 years old.
- [ ] The participant's country, sanctions status, export-control status, and platform access permit participation.
- [ ] The entry is individual; the participant registered once and will submit one final entry.
- [ ] The participant has at least six months of practical software-building experience or equivalent evidence.
- [ ] The participant is not a micro1 employee, event administrator, judge, challenge creator or tester, or an immediate household member of an excluded person.
- [ ] The participant supplied accurate identity, location, contact, and eligibility information.
- [ ] The participant can use an approved payout rail if selected for a cash prize or trace-acquisition payment.
- [ ] The participant accepted the Hackathon Participation Agreement and reviewed its submission-ownership terms.

## Challenge brief and deadline

- [ ] The participant reviewed the official kickoff PDF and confirmed that the final entry follows its mandatory scope, format, and evidence requirements.
- [ ] The participant used each required starter artifact and passed every required acceptance test against the final source revision.
- [ ] The submission platform records receipt and acceptance no later than Aug 31 2026 18:00 UTC.

## Integrity, data, and control

- [ ] The participant disclosed project work that existed before kickoff and work added during the competition.
- [ ] The participant confirmed originality and documented third-party components, versions, licenses, sources, and modifications.
- [ ] The project uses each tool, service, dataset, and component under its license and service terms.
- [ ] The submitted use case is legal and ethical.
- [ ] Submitted data is public, synthetic, approved anonymous data, or other data the participant may share.
- [ ] The repository, artifacts, traces, screenshots, and video contain no credentials or private information.
- [ ] The local system keeps recommendations inside a review workflow and exposes no production write-back endpoint.
- [ ] A qualified reviewer must approve a correction before the export includes it.
- [ ] Each result claim links to submitted raw or per-case evidence.
- [ ] Judges receive enough access to run the project and reproduce the main result.

## Coding-agent disclosure

- [ ] The submission names each coding agent, skill, plugin, and material use.
- [ ] The participant exported or shared representative development-agent trajectories after checking them for private information.
- [ ] The development trajectories show agent instructions, tool calls, tool results, feedback, retries, review, and verification.
- [ ] The submission does not describe plans, task logs, or generated product trajectories as exported development-agent trajectories.
- [ ] `artifacts/development-agent/trajectory.jsonl` and its manifest bind the participant's privacy-review PASS to the final source revision.

## Deliverable 1: Code and engineering record

- [ ] The final repository or archive contains the complete source at an identified commit.
- [ ] `AGENTS.md`, versioned role prompts, provider contracts, and orchestration instructions are present.
- [ ] The Node.js 24+ application and built-in test suite are present.
- [ ] The README names the intended user, current bottleneck, product value, safety boundary, main failure mode, and hot take.
- [ ] The Improvement Changelog records each meaningful iteration and links the evidence that drove the next decision.
- [ ] The changelog identifies the largest supported measured change and one removed experiment without overstating causality.

## Deliverable 2: Reproduction package

- [ ] A clean environment can follow the clone, setup, test, baseline, advanced, evaluation, evidence, validation, and start commands without undocumented steps.
- [ ] The guide names required data, expected output paths, benchmark size, metric values, provider, model, seed, and review budget.
- [ ] The guide records Node, operating-system, and dependency versions.
- [ ] Runtime, calls, attempts, tokens, and cost use measured values or `null` when no measurement exists.
- [ ] Deterministic, replay, and optional OpenAI evidence use distinct labels and output directories.
- [ ] A clean-checkout record captures command output, exit codes, artifact hashes, and the final source revision.
- [ ] The untouched submitted checkout passes `npm run validate:final`, `npm test`, and `npm run replay:check`, then remains clean.

## Deliverable 3: Video

- [ ] The encoded video duration is at most 300 seconds.
- [ ] The video begins with the user problem and simple baseline.
- [ ] The video shows one realistic browser execution from guideline change through owner decision and guarded export.
- [ ] The video compares baseline and advanced results on the same fixed benchmark and shows a visible failure.
- [ ] The video opens the Improvement Changelog, names the largest supported measured change, and explains one removed experiment.
- [ ] The video shows the reproduction command, main failure mode, and supported hot take.
- [ ] The participant recorded the filename, SHA-256 hash, duration, resolution, and submission-platform acceptance.
- [ ] The platform displayed a rendered frame, and hash-bound video evidence records playback PASS.

## Deliverable 4: Product-agent trajectories

- [ ] Representative JSONL covers rule compiler, change analyst, impact investigator, skeptical verifier, and orchestrator roles.
- [ ] Each trajectory connects versioned instructions and input references to tool calls, results, retries, verification, and terminal state.
- [ ] The package includes success, verifier disagreement, retry and recovery, uncertain abstention, and escalation evidence.
- [ ] Documentation states that all ten deterministic case trajectories terminate `partial` and `escalated`.
- [ ] The generated `hackathon-evidence-generator` checkpoint is labeled as a mechanism test, not participant review proof.
- [ ] Final QA records owner-entered approve, reject, escalate, and undo events through the interface.

## Release evidence

- [ ] Focused tests and the full test suite pass on the final source revision.
- [ ] The deterministic evaluation and exact replay checks pass with truthful provenance.
- [ ] Immediately after source freeze, one unrecorded `npm run eval` bootstrap binds managed deterministic evidence to the frozen revision.
- [ ] `npm run release:commands` records exactly seven PASS commands at the source revision.
- [ ] `npm run release:human` binds the participant's approve, escalate, undo, and reject sequence to an approved-only CSV.
- [ ] `npm run release:development` publishes only the privacy-reviewed Codex export.
- [ ] `npm run release:video-check` validates the canonical H.264 video without claiming upload or playback.
- [ ] `npm run release:compose` writes the 11 category records, participant attestations, and `artifacts/qa/release.json`.
- [ ] `npm run validate:final` passes its automated contract checks.
- [ ] Browser, keyboard, accessibility, responsive, and reduced-motion QA results exist for the final revision.
- [ ] A final security scan records findings, accepted fixes, focused tests, and verification results.
- [ ] The final owner review proves that the CSV contains active approvals only.
- [ ] The public clone or submitted archive reproduces the documented result.
- [ ] The participant records `approve release` or `block release` for the final commit.

## Scoring evidence

| Category | Points | Direct evidence |
|---|---:|---|
| Problem & User Value | 15 | [README](../README.md), [implementation plan](IMPLEMENTATION_PLAN.md), and the one-case browser workflow |
| Agent Solution & Engineering | 30 | [architecture](ARCHITECTURE.md), [agent system](AGENT_SYSTEM.md), versioned prompts, and [representative trajectories](../artifacts/representative-trajectories/README.md) |
| End-to-End Quality | 20 | browser workbench, [security boundary](SECURITY.md), decision ledger tests, and guarded CSV export |
| Measured Improvement | 15 | [paired comparison](../artifacts/evaluation/comparison.json), complete per-case results, and [Improvement Changelog](../IMPROVEMENT_CHANGELOG.md) |
| Reproducibility | 15 | [reproduction guide](REPRODUCTION.md), evaluation manifest, exact commands, and clean-checkout evidence when recorded |
| Hot Take / Insights | 5 | [hot take](HOT_TAKE.md), [main failure mode](MAIN_FAILURE_MODE.md), and removed-experiment evidence |

## Tie-break order

1. Higher Agent Solution & Engineering score.
2. Higher Reproducibility score.
3. Higher Measured Improvement score.
4. Higher End-to-End Quality score.
5. Final panel review of documented evidence.
