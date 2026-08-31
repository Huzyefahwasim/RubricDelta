# RubricDelta Final Integration Design

**Status:** Approved by the project owner on 2026-08-31.

## Objective

Move the completed RubricDelta implementation onto `main`, preserve its measured evaluation contract, close every automatable release check, and leave only evidence that must truthfully come from the participant. The release window is five hours, so this pass favors a verified fast-forward and the repository's existing fail-closed release tooling over new product scope.

## Selected source

The integration source is commit `b55a40e42727ffdb25b72b417d81887b97ece056` on `codex/task9-evidence-eol-refreeze`, plus this approved integration amendment and any narrowly tested fixes found during final verification. The root `main` checkout is an ancestor and will receive the completed history without rebuilding or selectively copying the application.

Existing untracked QA screenshots are participant data. They must be preserved until inspected and either incorporated into revision-bound QA evidence or explicitly returned to the participant. Unrelated untracked workspace probes must not be silently deleted.

## Frozen behavior

This historical Task 2 pass did not change benchmark cases, ground truth, protocol `rubricdelta-evaluation-v2`, metric formulas, review-budget calculation, baseline algorithm, deterministic ranking, provider prompts, replay inventory, or seed. Post-review, `rubricdelta-evaluation-v3` is current for new evidence and preserves those frozen inputs and the canonical baseline `16/20 = 0.80` versus advanced `18/20 = 0.90` comparison at the same 20 percent review budget. A clean bootstrap must regenerate v3 deterministic and replay evidence before release.

Any defect that would require changing this contract stops the release pass and requires a versioned protocol decision. Ordinary integration or portability defects receive a failing regression test before the smallest production fix.

## Integration and verification

1. Commit this approved amendment on the completed branch and fast-forward `main` to that branch.
2. Correct the stale protocol-v1 explanatory sentence identified during audit without changing machine-readable evidence.
3. Run focused tests for touched files, then the complete Node test suite.
4. Run deterministic evaluation, replay verification, exact replay evaluation, evidence generation, build validation, and whitespace checks.
5. Run a standard repository security scan, validate any candidate finding, fix only validated critical or high findings, and verify each fix.
6. Run the local product through its one-click demo, Rule Seam, keyboard decisions, guarded export, evaluation view, and trajectory view at desktop and mobile widths.
7. Reproduce the source and commands from a clean checkout. Generated artifacts must remain under `artifacts/` and must be bound to the final source revision.
8. Use `release-evidence.js` to collect and compose release records. Do not hand-author passing category, participant, privacy, video, or approval claims.

## Evidence boundary

Codex may generate deterministic evaluation, replay, command, clean-clone, security, and browser-QA evidence when it actually performs those checks. It may not assert participant identity, eligibility, registration, originality, rights, privacy approval, video upload/playback, or the final release decision.

The participant must supply or explicitly confirm:

- the privacy-reviewed exact development-agent export;
- eligibility, registration, originality, license, data-rights, and no-secret attestations;
- a measured video of no more than 300 seconds plus upload and playback confirmation;
- the final `approve release` decision.

Missing participant evidence remains an explicit blocker in `npm run validate:final`; it is never replaced with generated text or inferred consent.

## Completion criteria

- `main` contains the completed application and remains a linear descendant of the approved source.
- Focused and full tests pass on Node.js 24 or newer.
- Deterministic evaluation and exact replay reproduce the disclosed result with complete per-case artifacts.
- Build validation, security review, browser QA, clean-checkout reproduction, and `git diff --check` pass for one frozen source revision.
- The final release envelope passes only after all participant-owned evidence is genuinely supplied.
