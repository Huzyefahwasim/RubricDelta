# RubricDelta Task 9 Release Design

**Status:** Approved in chat by the project owner on 2026-08-30

**Scope:** Final hackathon narrative, release QA, participant evidence, development-agent evidence, demo video, strict validation, and evidence-only publication

## Goal

Package RubricDelta as a complete, reproducible hackathon submission without inventing human actions, model results, security claims, or upload acceptance. The release must preserve the measured deterministic comparison of `16/20 = 0.80` baseline recall and `18/20 = 0.90` advanced recall at the fixed 20% review budget.

## Challenge contract

The release must satisfy these organizer requirements:

- one individual participant and one final entry;
- a baseline and an advanced solution with a meaningful engineering improvement;
- complete code, README, Improvement Changelog, main failure mode, and hot take;
- clean-environment reproduction commands, required data, expected outputs, versions, runtime, and cost;
- a demo no longer than 300 seconds that covers the problem, baseline, realistic run, comparison, changelog, largest supported improvement, and one removed experiment;
- representative development-agent trajectories that connect instructions, tool calls, results, feedback, retries, verification, and human checkpoints;
- human approval before consequential export actions;
- evidence for measured claims, disclosed pre-existing work and tools, lawful data use, and no submitted credentials or private data.

The qualification gate takes priority over rubric optimization. A release that judges cannot run, trace, or reproduce does not qualify for scoring.

## Selected approach

The project uses a paired evidence-first release session. Codex performs mechanical work and records machine-verifiable results. The participant performs decisions and attestations that require human authority.

The rejected alternatives are:

1. Deferring participant evidence until the end. This approach risks revision mismatches and leaves little time to repeat failed checks.
2. Generating stand-ins for participant actions. This approach would misrepresent authorship and could fail the integrity gate.

## Release roles

### Codex responsibilities

Codex may:

- edit source and documentation before the source freeze;
- implement tested evidence tooling when the repository lacks a safe collector;
- run tests, deterministic evaluation, replay, evidence generation, and validators;
- perform non-decision browser, keyboard, accessibility, and responsive checks;
- run the final standard Codex Security repository scan and verify accepted fixes;
- reproduce the release in a clean checkout;
- capture command output, timestamps, revisions, hashes, screenshots, and media metadata;
- export a representative development trajectory from real Codex work;
- prepare evidence files from results and participant statements;
- inspect and compress the demo video;
- commit approved source and evidence.

Codex may not claim that the participant performed an action that Codex performed.

### Participant responsibilities

The participant must:

- choose a public reviewer identifier that does not imply an agent or generator;
- enter the final approve, escalate, undo, and reject sequence through the local interface;
- inspect the approved-only CSV export;
- review the development trajectory for private information and approve or block its inclusion;
- record the demo video;
- confirm that the submission platform accepted the upload and rendered a playable frame;
- confirm eligibility, originality, pre-existing work, licenses, data rights, and accurate submission details;
- issue the exact final decision `approve release` or block the release with a reason;
- authorize each push, public publication, file upload, or final platform submission at the time of that action.

## Revision and publication model

RubricDelta separates source from managed evidence. The validator binds final QA, human review, development-agent evidence, and video evidence to the source revision recorded by `artifacts/evaluation/manifest.json`.

The release follows this sequence:

```text
clean Task 8 HEAD
  -> source and documentation changes
  -> preflight QA and security fixes
  -> clean source-freeze commit
  -> deterministic and replay generation
  -> participant review and release evidence
  -> evidence-only publication commit or commits
  -> clean current checkout
  -> fresh-checkout final validation
```

All files that affect source behavior, judge-facing prose, schemas, or evidence tooling must enter the source-freeze commit. After that commit, descendants may change files only under the validator's managed evidence roots:

- `artifacts/evaluation/`
- `artifacts/representative-trajectories/`
- `artifacts/expected-replay-report/`
- `artifacts/qa/`
- `artifacts/submission/`
- `artifacts/development-agent/`

A source change after the freeze invalidates later evidence. Codex must fix the source, create a new source revision, and regenerate every revision-bound artifact.

## Source finalization

Before the source freeze, Codex must:

- replace stale Task 8 and release-status prose with measured facts;
- align `README.md`, `IMPROVEMENT_CHANGELOG.md`, `docs/DEMO_SCRIPT.md`, `docs/MAIN_FAILURE_MODE.md`, `docs/HOT_TAKE.md`, `docs/MODEL_AND_COSTS.md`, `docs/REPRODUCTION.md`, `docs/DEVELOPMENT_AGENT_DISCLOSURE.md`, `docs/IMPLEMENTATION_PLAN.md`, and `docs/SUBMISSION_CHECKLIST.md`;
- retain the disclosed deterministic result and the absence of a verified live OpenAI result;
- retain the accessibility failure and the removed unsupported cross-delta inference;
- state which tools changed the project and which installed tools did not contribute;
- add or harden evidence collection only when tests prove the required schema and fail-closed behavior;
- remove language that claims a release check still waits when final evidence will support the release statement.

The final narrative must connect each score, cost, failure, and development claim to a repository artifact.

## Preflight gate

Codex runs preflight checks before freezing the source so fixes do not invalidate final evidence:

- full automated tests;
- deterministic evaluation and exact replay;
- build validation;
- browser workflow checks;
- keyboard-only operation;
- accessibility semantics and focus behavior;
- viewport checks at `375 x 812`, `768 x 1024`, and `1440 x 900`;
- reduced-motion behavior;
- standard Codex Security repository scan;
- clean-checkout reproduction.

A validated security finding, product defect, accessibility block, or reproduction mismatch blocks the source freeze. Codex must add a regression test for code fixes, verify the fix, and repeat affected preflight checks.

## Final automated evidence

At the clean source revision, Codex records these commands in this order:

```text
npm test
npm run eval
npm run replay:check
npm run eval:replay
npm run evidence
npm run validate
git diff --check
```

Each command record must contain the exact command, source revision, start and finish timestamps, exit code, result, output or bounded output artifact, and SHA-256 binding required by the validator. The deterministic run must report:

- benchmark `rubricdelta-support-guideline-drift-v1`;
- protocol `rubricdelta-evaluation-v2`;
- baseline `16/20 = 0.80`;
- advanced `18/20 = 0.90`;
- absolute improvement `0.10`;
- deterministic provider, null model, seed `0`, and two review slots per case;
- zero provider calls, attempts, tokens, latency, and cost.

The replay run must identify itself as deterministic-source replay, consume the exact committed fixture, report 50 calls and 50 attempts, require no network, and reproduce `0.80` and `0.90`. The project must not describe replay as a live-model evaluation.

## Human review evidence

Codex starts the frozen local application and makes the browser visible. The participant enters the selected reviewer identifier and performs this sequence:

1. approve record A and leave the approval active;
2. escalate record B;
3. undo that escalation, restoring the prior state;
4. reject record B;
5. export the corrections CSV.

The append-only ledger must contain approve, escalate, undo, and reject events in order. The participant checks that the CSV contains record A and excludes record B plus all pending records.

Codex records the run ID, record IDs, participant identifier, timestamps, ledger, CSV, trajectory, hashes, and source revision. Generated mechanism-test events do not qualify as participant evidence.

## Browser and accessibility evidence

Codex tests the frozen revision with the selected browser and records the browser version. Evidence must cover:

- complete benchmark-example loading and Rule Seam inspection;
- visible focus and logical keyboard order;
- working A, R, E, J, and K shortcuts outside text inputs;
- labeled controls, one `h1`, skip link, semantic landmarks, and live-region updates;
- status and comparison content that does not depend on color;
- no horizontal overflow or hidden decision controls at the three required viewports;
- reduced-motion behavior;
- trajectory download, approved-only CSV export, metrics, accessibility failure, and retry evidence.

Screenshots support the QA record but do not replace action logs or participant review evidence.

## Development-agent evidence

Codex exports a representative trajectory from real project work. The trajectory must use the canonical path `artifacts/development-agent/trajectory.jsonl` and include at least these event types:

- instruction;
- tool call;
- tool result;
- feedback or review correction;
- verification.

Events must use one run ID, contiguous sequence numbers, ordered timestamps, substantive payloads, and source `codex-export`. Codex must not invent a tool call or result.

The participant reviews the exact exported bytes for credentials, private paths, private conversation content, and personal information. The participant records PASS or blocks the artifact. The manifest binds the reviewed trajectory hash, source revision, participant review time, and review result.

## Security and clean-checkout evidence

The final standard security scan targets the frozen source. The release record lists each validated finding, severity, fix revision, focused test, and verification result. A clean-scan claim requires a completed scan record.

The clean-checkout test starts from the frozen source plus published evidence in a new directory. The operator follows `docs/REPRODUCTION.md` without hidden setup. The checkout must reproduce the deterministic scores, exact replay, evidence, build validation, browser start, and final strict validation.

## Demo video

The participant records the final application and terminal after the release gates pass. The target duration is 4 minutes 40 seconds, leaving 20 seconds below the limit. The video must show:

- the user problem and 20% review constraint;
- the lexical baseline;
- the fair comparison contract;
- one realistic Rule Seam analysis;
- the participant approve, escalate, undo, reject, and export flow;
- `16/20` compared with `18/20`;
- the accessibility failure;
- the complete measured system bundle and causal limit;
- the removed `19/20` unsupported-inference experiment;
- one reproduction command and the hot take.

Codex verifies an H.264 AVC video track, nonzero dimensions, duration at or below 300 seconds, playable media samples, SHA-256 hash, and absence of credential-like bytes. The preferred delivery stays below 90 MB to avoid common repository and platform limits.

The participant uploads the video. The video evidence may state `accepted` and playback PASS only after the participant confirms that the platform accepted the file and displayed a rendered frame.

## Release attestations

The participant reviews the completed package and records:

- eligibility and accurate registration details;
- project-specific work that existed before kickoff, if any;
- originality, license compliance, and data-sharing rights;
- development-trajectory privacy review;
- video upload acceptance and playback;
- the exact decision `approve release` or `block release` with a reason.

Codex converts those statements into schema-bound evidence without changing their meaning. Codex cannot choose `approve release` for the participant.

## Failure handling

The release uses these fail-closed rules:

- a nonzero command exit blocks its QA category;
- changed scores block release until the project versions and explains the change;
- a source edit after freeze invalidates revision-bound evidence;
- a missing participant action remains missing;
- a security finding remains open until a focused verification passes;
- an unreadable, oversized, non-H.264, or longer-than-300-second video blocks video PASS;
- upload or playback uncertainty blocks the accepted claim;
- a dirty final checkout blocks final validation;
- `npm run validate:final` must fail when any required evidence is absent or inconsistent.

Codex records a failure before attempting a fix. The release package contains PASS only after a rerun proves the condition.

## External side effects

Local tests, local browser QA, local recording support, hashing, and commits stay within the authorized project scope. Codex must request confirmation at the action point before:

- pushing commits to GitHub;
- publishing a repository or share link;
- uploading the video or another file;
- submitting the final HackerEarth entry;
- spending money or calling a live model provider.

The participant may perform any external action directly instead of delegating it.

## Completion criteria

Task 9 is complete only when:

- judge-facing documents contain accurate final claims and evidence links;
- the full test suite, deterministic evaluation, exact replay, evidence generation, build validation, and diff check pass at the frozen revision;
- browser, keyboard, accessibility, responsive, reduced-motion, security, and clean-checkout categories contain real PASS evidence;
- participant review evidence contains approve, escalate, undo, and reject with an approved-only CSV;
- the participant approves the privacy-reviewed Codex trajectory;
- the demo meets content, codec, size, duration, upload, and playback requirements;
- the participant records `approve release`;
- all final evidence binds to the manifest source revision;
- final evidence appears only in allowed evidence descendants;
- `npm run validate:final` passes in the working checkout and a fresh checkout;
- Git reports a clean final tree.

Push and final platform submission remain separate participant-authorized actions.
