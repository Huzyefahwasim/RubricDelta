# Development-Agent Disclosure

## Authorship and control

Codex coding agents produced material parts of RubricDelta, including plans, source code, tests, interface code, evaluation tooling, and documentation. The project does not claim human-only authorship.

The single human participant chose the project goal and authorized development. The participant owns final integration and release decisions, the hackathon submission, eligibility and originality confirmations, live-provider spend, public repository publication, and the recorded demo. An agent cannot make those decisions for the participant.

## Competition-built and pre-existing inventory

The repository history and dated plans record competition work on the RubricDelta benchmark, domain logic, deterministic agent pipeline, browser workbench, local server, evaluation tooling, provider design, tests, and submission documents.

Node.js, Git, Codex, installed skills, and installed plugins existed as development tools before this repository work. The offline application declares no runtime package dependencies, and `THIRD_PARTY_NOTICES.md` records that boundary.

The repository does not contain a participant-confirmed inventory that proves whether any project-specific code, design, data, or asset existed before kickoff. The participant must review the final tree and record that provenance before submission. Until then, this document makes no “built from scratch” claim.

## Material development tools and sources

| Capability | Material contribution | Repository record |
|---|---|---|
| Codex and Superpowers workflow skills | Produced plans, isolated task work, tests, fixes, cross-agent review, and verification. | Dated files under `docs/superpowers/`, Git history, and the Improvement Changelog. |
| `frontend-design` | Shaped the browser workbench, responsive states, keyboard interaction, and visual hierarchy. | `public/`, interface tests, and the submission implementation plan. |
| `stop-slop` | Removed formulaic prose and forced direct evidence limits in submission documents. | This disclosure, the Improvement Changelog, and the Task 9 judge-facing documents. |
| Official OpenAI API documentation | The optional-provider code targets the Responses API and structured-output contracts cited in the reproduction guide. | `src/providers/openai.js`, versioned prompts, and the official documentation links in `docs/REPRODUCTION.md`. |

The release contract assigns the standard source scan to Codex Security. A reader can count that scan as a material contribution when `artifacts/qa/release.json` binds a PASS security category and its category record names the tool, findings, fixes, and verification. This source document makes no clean-scan or zero-vulnerability claim.

## Installed tools and plugins that did not change the project

| Capability | Status | Reason |
|---|---|---|
| `gh-fix-ci` | Installed, no material use | The recorded work contains no GitHub pull-request CI failure. |
| `gh-address-comments` | Installed, no material use | The recorded work contains no open pull request or GitHub review comment. |

Installation alone does not establish material use.

## Agent workflow

Codex subagents filled implementer, reviewer, and controller roles in the development workflow. Implementer subagents wrote tests and changes. Reviewer subagents inspected another agent's work, and the controller integrated accepted findings into the shared worktree. Those labels do not identify extra human teammates. The single participant owns final integration approval and submission. Dated plans and Git history record integration points.

The tracked planning and audit trail includes:

- [submission design](superpowers/specs/2026-08-29-rubricdelta-submission-design.md);
- [implementation plan](superpowers/plans/2026-08-29-rubricdelta-hackathon-submission.md);
- [provider amendment](superpowers/plans/2026-08-29-rubricdelta-task8-provider-plan.md);
- [Improvement Changelog](../IMPROVEMENT_CHANGELOG.md);
- tests and JSON or JSONL product-evaluation evidence.

These files form a task log and repository audit trail. They do not qualify as the exported Codex development-agent trajectory.

The canonical submission path is `artifacts/development-agent/trajectory.jsonl`. `npm run release:development` accepts actual `codex-export` events only after the participant reviews the exact JSONL bytes for credentials, private paths, personal information, unrelated conversation, and unsafe submission content. The command also writes `artifacts/development-agent/manifest.json`, which binds the source revision, trajectory hash, event count, run ID, agent, source, review time, and participant privacy-review PASS.

Treat the trajectory as release evidence only when `artifacts/qa/release.json` binds the development-agent category to that manifest. Source prose cannot certify the participant's privacy decision.

## Product-agent trajectory boundary

`artifacts/evaluation/trajectories/` and `artifacts/representative-trajectories/` contain RubricDelta product-agent events. They show the rule compiler, change analyst, impact investigator, skeptical verifier, orchestrator, retries, and decision-gate behavior. They do not show how Codex developed the repository.

All ten deterministic case trajectories terminate with `status: partial` and `escalated: true`. That status describes unresolved evidence or recovery in the product workflow; it does not describe human approval or development-agent completion.

## Human-checkpoint status

`artifacts/representative-trajectories/human-checkpoint.jsonl` contains a checkpoint generated through the guarded API by `hackathon-evidence-generator`. It proves that the server records an attributable decision event. It does not prove that the participant performed a review or that the reviewer identity was authenticated.

Final QA must add participant-entered approval, rejection, escalation, and undo events through the interface. The release record must identify that run without exposing private information.

## Release evidence authority

Post-freeze completion state lives in `artifacts/qa/release.json`. Its hash-bound categories cover automated checks, browser and keyboard QA, accessibility and responsive QA, security, clean checkout, human review, video, development-agent evidence, and release approval. Separate manifests bind participant attestations, the approved-only CSV, the development trajectory, and video inspection plus upload/playback confirmation.

The participant retains authority over provenance, licenses, originality, eligibility, privacy approval, the final release decision, and each push, publication, upload, submission, or live OpenAI expense. Missing canonical evidence leaves the related claim unverified.
