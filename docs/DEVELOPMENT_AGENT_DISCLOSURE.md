# Development-Agent Disclosure

## Authorship and control

Codex coding agents produced material parts of RubricDelta, including plans, source code, tests, interface code, evaluation tooling, and documentation. The project does not claim human-only authorship.

The single human participant chose the project goal and authorized development. The participant owns final integration and release decisions, the hackathon submission, eligibility and originality confirmations, live-provider spend, public repository publication, and the recorded demo. An agent cannot make those decisions for the participant.

## Competition-built and pre-existing inventory

The repository history and dated plans record competition work on the RubricDelta benchmark, domain logic, deterministic agent pipeline, browser workbench, local server, evaluation tooling, provider design, tests, and submission documents.

Node.js, Git, Codex, installed skills, and installed plugins existed as development tools before this repository work. The offline application declares no runtime package dependencies, and `THIRD_PARTY_NOTICES.md` records that boundary.

The repository does not contain a participant-confirmed inventory that proves whether any project-specific code, design, data, or asset existed before kickoff. The participant must review the final tree and record that provenance before submission. Until then, this document makes no “built from scratch” claim.

## Skills and plugins used

| Capability | Status | Material use |
|---|---|---|
| Superpowers plugin | Used | Brainstorming, implementation plans, isolated worktree setup, test-driven development, debugging, bounded agent tasks, and review loops. |
| `frontend-design` | Used | Designed and refined the browser workbench, responsive states, keyboard interactions, and visual hierarchy. |
| `stop-slop` | Used | Edited submission prose for direct claims and explicit limits. |
| OpenAI documentation skill | Used | Checked official Responses API and structured-output contracts for the optional provider design. |
| `gh-fix-ci` | Installed and considered, not used | No GitHub pull-request CI failure existed in the recorded development work. |
| `gh-address-comments` | Installed and considered, not used | No open pull request or GitHub review comment existed to address. |
| Codex Security plugin | Installed; release scan pending | The final standard repository scan has not run. This document makes no clean-scan or zero-vulnerability claim. |

Installing a skill or plugin does not count as using it. The table separates available tooling from capabilities that changed project work.

## Agent workflow

Codex subagents filled the implementer, reviewer, and owner roles in the development workflow. Implementer subagents wrote tests and changes, reviewer subagents inspected work from other agents, and owner subagents integrated accepted findings into the shared worktree. Those role labels do not identify extra human teammates. The single participant owns final integration approval and submission. Dated plans and Git history record integration points; the final whole-branch review remains pending.

The tracked planning and audit trail includes:

- [submission design](superpowers/specs/2026-08-29-rubricdelta-submission-design.md);
- [implementation plan](superpowers/plans/2026-08-29-rubricdelta-hackathon-submission.md);
- [provider amendment](superpowers/plans/2026-08-29-rubricdelta-task8-provider-plan.md);
- [Improvement Changelog](../IMPROVEMENT_CHANGELOG.md);
- tests and JSON or JSONL product-evaluation evidence.

These files form a task log and repository audit trail. They are not an exported Codex development-agent trajectory. The repository does not yet include a representative development trajectory that connects an agent instruction to its tool calls, results, feedback, review, and final verification.

The participant must export or share representative development-agent evidence, inspect it for private information, and identify it in the submission package. This document must keep that item pending until the evidence exists.

## Product-agent trajectory boundary

`artifacts/evaluation/trajectories/` and `artifacts/representative-trajectories/` contain RubricDelta product-agent events. They show the rule compiler, change analyst, impact investigator, skeptical verifier, orchestrator, retries, and decision-gate behavior. They do not show how Codex developed the repository.

All ten deterministic case trajectories terminate with `status: partial` and `escalated: true`. That status describes unresolved evidence or recovery in the product workflow; it does not describe human approval or development-agent completion.

## Human-checkpoint status

`artifacts/representative-trajectories/human-checkpoint.jsonl` contains a checkpoint generated through the guarded API by `hackathon-evidence-generator`. It proves that the server records an attributable decision event. It does not prove that the participant performed a review or that the reviewer identity was authenticated.

Final QA must add participant-entered approval, rejection, escalation, and undo events through the interface. The release record must identify that run without exposing private information.

## Pending release work

The project still needs recorded evidence for:

- participant confirmation of pre-existing work, licenses, originality, eligibility, and submission details;
- a privacy-reviewed representative development-agent trajectory or share link;
- the Codex Security standard repository scan and verification of accepted fixes;
- final browser, keyboard, accessibility, and responsive QA;
- clean-checkout reproduction at the final source revision;
- final whole-branch review and participant release decision;
- a participant-recorded video of no more than 300 seconds;
- participant authorization for any push, public publication, or live OpenAI spend.
