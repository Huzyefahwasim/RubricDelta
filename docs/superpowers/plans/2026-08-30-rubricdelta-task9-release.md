# RubricDelta Task 9 Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a complete RubricDelta hackathon release with final narrative, reproducible command evidence, real participant review, privacy-reviewed Codex development evidence, a playable demo, and clean strict validation.

**Architecture:** Finalize and test all source files before naming one clean source revision. Generate deterministic, QA, human, development-agent, and video artifacts after that revision, then publish them through evidence-only commits whose paths satisfy the existing provenance validator.

**Tech Stack:** Node.js 24 ESM, dependency-free HTML/CSS/JavaScript, Node test runner, local loopback HTTP server, Git, Codex Security, SHA-256 JSON/JSONL evidence, H.264 AVC MP4.

**Spec:** `docs/superpowers/specs/2026-08-30-rubricdelta-task9-release-design.md`

## Global Constraints

- Use Node.js 24 or newer and preserve ESM modules.
- Add no runtime package dependency.
- Keep the official deterministic evaluation offline with no credential or network requirement.
- Preserve benchmark `rubricdelta-support-guideline-drift-v1`, protocol `rubricdelta-evaluation-v2`, seed `0`, ten cases, two review slots per case, baseline `16/20 = 0.80`, and advanced `18/20 = 0.90`.
- Describe replay as deterministic-source replay with 50 calls, 50 attempts, zero tokens, zero provider latency, zero cost, and no live-model evidence.
- Keep benchmark gold outside ranking, prompts, raw predictions, browser payloads, and product trajectories.
- Require a server-recorded participant decision before export; export only active approvals.
- Do not fabricate participant actions, security results, privacy review, upload acceptance, playback, eligibility, or release approval.
- Do not change a Task 8 test file whose LF-canonical SHA-256 is frozen in `scripts/validate-submission.js`; add new Task 9 tests instead.
- After the source freeze, change only the six managed evidence roots accepted by `scripts/validate-submission.js`.
- Request action-time confirmation before any push, public share, file upload, live-provider call, spend, or final platform submission.

## File map

### Source files created before the freeze

- `src/release/evidence.js`: pure release evidence schemas, validation, hashing, and composition.
- `scripts/release-evidence.js`: allowlisted command runner and evidence collection CLI.
- `tests/release-evidence.test.js`: RED/GREEN tests for command, human, development, category, release, and video evidence.
- `tests/task9-release-docs.test.js`: release-document contract and stale-claim regression tests.

### Source files modified before the freeze

- `scripts/validate-submission.js`: export the existing MP4 inspector and guard direct CLI execution so the release tool can reuse the exact media calculation.
- `package.json`: add `release:commands`, `release:human`, `release:development`, `release:video-check`, and `release:compose` scripts.
- `README.md`, `IMPROVEMENT_CHANGELOG.md`, `docs/DEMO_SCRIPT.md`, `docs/MAIN_FAILURE_MODE.md`, `docs/HOT_TAKE.md`, `docs/MODEL_AND_COSTS.md`, `docs/REPRODUCTION.md`, `docs/DEVELOPMENT_AGENT_DISCLOSURE.md`, `docs/IMPLEMENTATION_PLAN.md`, and `docs/SUBMISSION_CHECKLIST.md`: final judge-facing narrative and source/evidence boundary.
- `public/index.html`, `public/app.js`, `public/ui-model.js`, and `public/styles.css`: modify only if preflight produces a reproducible frontend failure.
- `src/server/router.js` and related server modules: modify only if preflight produces a reproducible server or human-gate failure.

### Evidence generated after the freeze

- `artifacts/qa/commands/*.json`
- `artifacts/qa/categories/*.json`
- `artifacts/qa/human/ledger.jsonl`
- `artifacts/qa/human/export.csv`
- `artifacts/qa/human-review.json`
- `artifacts/qa/session.json`
- `artifacts/qa/participant-attestation.json`
- `artifacts/qa/video.json`
- `artifacts/qa/release.json`
- `artifacts/qa/README.md`
- `artifacts/qa/screenshots/*`
- `artifacts/development-agent/trajectory.jsonl`
- `artifacts/development-agent/manifest.json`
- `artifacts/submission/demo.mp4`
- regenerated files below `artifacts/evaluation/`, `artifacts/representative-trajectories/`, and `artifacts/expected-replay-report/`

---

### Task 1: Build the fail-closed release evidence producer

**Files:**
- Create: `src/release/evidence.js`
- Create: `scripts/release-evidence.js`
- Create: `tests/release-evidence.test.js`
- Modify: `scripts/validate-submission.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: current Git HEAD, `artifacts/evaluation/manifest.json`, final server snapshots below ignored `artifacts/runs/`, a real Codex thread export, `artifacts/submission/demo.mp4`, and the participant-reviewed `artifacts/tmp/release-session.json`.
- Produces: validator-compatible command JSON, human-review JSONL/CSV, development manifest, video metadata, category JSON, and `artifacts/qa/release.json`.
- Export from `src/release/evidence.js`: `REQUIRED_RELEASE_COMMANDS`, `QA_CATEGORIES`, `sha256Bytes(value)`, `buildCommandEvidence(input)`, `buildCategoryEvidence(input)`, `buildHumanEvidence(input)`, `buildDevelopmentManifest(input)`, `buildVideoEvidence(input)`, and `buildReleaseEvidence(input)`.
- Export from `scripts/release-evidence.js`: `runCommandSuite(options)`, `collectHumanReview(options)`, `collectDevelopmentEvidence(options)`, `inspectReleaseVideo(options)`, and `composeRelease(options)`.

- [ ] **Step 1: Write RED tests for the pure evidence contracts**

Add tests with these shapes:

```js
test("category evidence accepts only one final PASS revision", () => {
  const evidence = buildCategoryEvidence({
    revision: "a".repeat(40),
    category: "browser",
    timestamp: "2026-08-30T12:00:00.000Z",
    tool: "Codex in-app browser",
    coverage: ["Loaded the fixed benchmark and inspected the Rule Seam."],
  });
  assert.equal(evidence.artifactKind, "rubricdelta-qa-category");
  assert.equal(evidence.status, "PASS");
  assert.throws(() => buildCategoryEvidence({ ...evidence, status: "PENDING" }), /PASS/);
});

test("release composition rejects a missing category and agent-owned approval", () => {
  assert.throws(() => buildReleaseEvidence({
    revision: "a".repeat(40),
    categories: {},
    commands: [],
    decision: { value: "approve release", actor: "codex" },
  }), /participant|category/i);
});
```

- [ ] **Step 2: Run the new tests and confirm RED**

Run:

```text
node --test tests/release-evidence.test.js
```

Expected: FAIL because `src/release/evidence.js` does not exist.

- [ ] **Step 3: Implement the pure constants, validators, hashes, and builders**

Use these exact constants:

```js
export const REQUIRED_RELEASE_COMMANDS = Object.freeze([
  { id: "npm-test", command: "npm test" },
  { id: "npm-run-eval", command: "npm run eval" },
  { id: "npm-run-replay-check", command: "npm run replay:check" },
  { id: "npm-run-eval-replay", command: "npm run eval:replay" },
  { id: "npm-run-evidence", command: "npm run evidence" },
  { id: "npm-run-validate", command: "npm run validate" },
  { id: "git-diff-check", command: "git diff --check" },
]);

export const QA_CATEGORIES = Object.freeze([
  "automated", "browser", "keyboard", "accessibility", "responsive",
  "security", "cleanCheckout", "humanReview", "video",
  "developmentAgent", "release",
]);
```

Each builder must reject unknown fields, non-RFC3339 timestamps, non-Git revisions, blank coverage, banned reviewer identifiers, missing hashes, non-PASS category state, duplicate paths, and a non-participant release decision.

- [ ] **Step 4: Add RED command-runner and publication tests**

```js
test("command collection publishes no PASS file when one command fails", async (t) => {
  const root = await temporaryRepository(t);
  const calls = [];
  await assert.rejects(runCommandSuite({
    root,
    run(command) {
      calls.push(command);
      return command === "npm run eval"
        ? { exitCode: 1, stdout: "", stderr: "forced failure" }
        : { exitCode: 0, stdout: "pass", stderr: "" };
    },
    now: timestampSequence(),
  }), /npm run eval/);
  assert.deepEqual(await qaCommandFiles(root), []);
});
```

Run:

```text
node --test tests/release-evidence.test.js
```

Expected: FAIL because the CLI exports do not exist.

- [ ] **Step 5: Implement buffered allowlisted command execution**

`runCommandSuite()` must:

1. require a clean source tree at entry;
2. capture the current 40- or 64-hex HEAD;
3. run the seven exact commands in `REQUIRED_RELEASE_COMMANDS` order;
4. use `npm.cmd` on Windows and `npm` elsewhere;
5. set a timeout and output bound for every child process;
6. keep results in memory or the system temporary directory until every command exits `0`;
7. verify `artifacts/evaluation/manifest.json` binds the entry HEAD and the fixed scores;
8. write command JSON files through `createArtifactStore()` only after the full sequence passes.

Never write a PASS command file before the suite completes.

- [ ] **Step 6: Add RED human-review collection tests**

Create a temporary server snapshot with this exact decision order: approve A, escalate B, undo B, reject B. Assert that the collector:

- converts `decisions.json` to ordered JSONL;
- copies the final `export.csv` bytes;
- copies the full `trajectory.jsonl` to `artifacts/representative-trajectories/human-checkpoint.jsonl`;
- records a participant reviewer and rejects `codex`, `agent`, and `hackathon-evidence-generator`;
- proves that the CSV contains A and excludes B.

Run the focused test and confirm it fails before implementing `collectHumanReview()`.

- [ ] **Step 7: Implement human and development evidence collection**

`collectHumanReview()` reads the exact revision named by `artifacts/runs/RUN_ID/current.json`, where `RUN_ID` comes from the participant-reviewed session input. It must bind the final ledger, CSV, trajectory, reviewer, source revision, and hashes.

`collectDevelopmentEvidence()` reads a real Codex export at `artifacts/tmp/codex-export.jsonl`. It must verify contiguous sequence, one run ID, agent `codex`, source `codex-export`, ordered timestamps, substantive payloads, and the required event types `instruction`, `tool-call`, `tool-result`, `feedback`, and `verification`. It writes the canonical JSONL and a manifest only after the session input records participant privacy review PASS.

- [ ] **Step 8: Make the existing MP4 inspection reusable without changing its rules**

Change the existing declaration to an export and guard CLI execution:

```js
export function inspectMp4(buffer) {
  // Keep the existing implementation byte-for-byte inside this function.
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  printResult(options.mode, runValidation(options));
}

const directPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (directPath && directPath.toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  try {
    main();
  } catch {
    process.stderr.write("Validation failed: bounded fail-closed validator error\n");
    process.exitCode = 1;
  }
}
```

Add a test that imports `inspectMp4` without running validation. Keep all existing forged-video tests green.

- [ ] **Step 9: Implement video check and final composition**

`inspectReleaseVideo()` reads `artifacts/submission/demo.mp4`, calls the exported `inspectMp4`, computes SHA-256, and prints JSON metadata without asserting upload acceptance.

`composeRelease()` reads only participant-reviewed session data plus artifacts produced by earlier subcommands. It writes all 11 unique category files, `video.json`, `participant-attestation.json`, `session.json`, the final QA README, and `release.json`. It must refuse to compose when privacy review, upload acceptance, rendered-frame playback, eligibility, license/data-rights review, or `approve release` is absent.

- [ ] **Step 10: Add package scripts**

```json
"release:commands": "node scripts/release-evidence.js commands",
"release:human": "node scripts/release-evidence.js human --session artifacts/tmp/release-session.json",
"release:development": "node scripts/release-evidence.js development --session artifacts/tmp/release-session.json --source artifacts/tmp/codex-export.jsonl",
"release:video-check": "node scripts/release-evidence.js video-check",
"release:compose": "node scripts/release-evidence.js compose --session artifacts/tmp/release-session.json"
```

- [ ] **Step 11: Run focused and full verification**

Run:

```text
node --test tests/release-evidence.test.js tests/final-validator-preflight.test.js tests/final-validator-hardening.test.js tests/final-validator-canonical-hardening.test.js tests/final-validator-review-hardening.test.js
npm test
npm run replay:check
npm run validate
git diff --check
```

Expected: all commands exit `0`; build validation remains non-final.

- [ ] **Step 12: Commit the release evidence producer**

```text
git add src/release/evidence.js scripts/release-evidence.js scripts/validate-submission.js tests/release-evidence.test.js package.json
git commit -m "feat: add fail-closed release evidence producer"
```

### Task 2: Finalize the judge-facing source narrative

**Files:**
- Create: `tests/task9-release-docs.test.js`
- Modify: `README.md`
- Modify: `IMPROVEMENT_CHANGELOG.md`
- Modify: `docs/DEMO_SCRIPT.md`
- Modify: `docs/MAIN_FAILURE_MODE.md`
- Modify: `docs/HOT_TAKE.md`
- Modify: `docs/MODEL_AND_COSTS.md`
- Modify: `docs/REPRODUCTION.md`
- Modify: `docs/DEVELOPMENT_AGENT_DISCLOSURE.md`
- Modify: `docs/IMPLEMENTATION_PLAN.md`
- Modify: `docs/SUBMISSION_CHECKLIST.md`

**Interfaces:**
- Consumes: Task 8 manifest, comparison, replay result, experiment archive, approved Task 9 design, and canonical final-evidence paths.
- Produces: a complete submission narrative whose claims become true only when strict validation and participant approval complete.

- [ ] **Step 1: Write the RED release-document contract**

```js
test("final release prose removes stale Task 8 and development-evidence status", () => {
  const model = read("docs/MODEL_AND_COSTS.md");
  const disclosure = read("docs/DEVELOPMENT_AGENT_DISCLOSURE.md");
  assert.doesNotMatch(model, /Task 8.*(?:in progress|confirm.*before citing)/i);
  assert.doesNotMatch(disclosure, /pending|has not run|does not yet|still needs/i);
  assert.match(disclosure, /artifacts\/development-agent\/trajectory\.jsonl/i);
  assert.match(disclosure, /privacy review/i);
});

test("demo and changelog cover the required comparison and removed experiment", () => {
  const demo = read("docs/DEMO_SCRIPT.md");
  const changelog = read("IMPROVEMENT_CHANGELOG.md");
  for (const value of [/16\/20/, /18\/20/, /accessibility/i, /removed/i, /4 minutes 40 seconds|4:40/i]) {
    assert.match(`${demo}\n${changelog}`, value);
  }
});
```

- [ ] **Step 2: Run the new test and confirm RED**

Run:

```text
node --test tests/task9-release-docs.test.js
```

Expected: FAIL on the stale Task 8 and development-agent language.

- [ ] **Step 3: Edit the narrative using measured facts**

Required edits:

- remove the Task 8 fixture warning from `docs/MODEL_AND_COSTS.md` and cite the committed 50-call replay evidence;
- replace the pending sections in `docs/DEVELOPMENT_AGENT_DISCLOSURE.md` with the canonical Codex export path, participant privacy-review boundary, security-scan record, and development-role disclosure;
- distinguish tools and plugins that materially changed the project from installed tools and plugins that did not contribute to the project;
- keep the absence of a verified live OpenAI result;
- retain the advanced accessibility miss and the removed unsupported `19/20` inference;
- explain that post-freeze completion state lives in `artifacts/qa/release.json`, so source plans do not need later edits;
- align the README, reproduction guide, demo script, changelog, implementation plan, and submission checklist with the new release commands and evidence paths.

- [ ] **Step 4: Run prose and final-text gates**

Run:

```text
node --test tests/task9-release-docs.test.js
node scripts/validate-submission.js --mode final-strict
```

Expected: the document-focused test passes. Final-strict still fails only for participant QA, development evidence, and video that do not exist yet; it must not fail the final-text checks.

- [ ] **Step 5: Run the full suite and commit**

```text
npm test
npm run validate
git diff --check
git add README.md IMPROVEMENT_CHANGELOG.md docs tests/task9-release-docs.test.js
git commit -m "docs: finalize Task 9 submission narrative"
```

### Task 3: Run frontend, keyboard, accessibility, and server preflight

**Files:**
- Verify: `public/index.html`
- Verify: `public/app.js`
- Verify: `public/ui-model.js`
- Verify: `public/styles.css`
- Verify: `src/server/router.js`
- Verify: `tests/ui-contract.test.js`
- Verify: `tests/server.test.js`
- Verify: `tests/human-gate.test.js`
- Modify only after a reproduced failure: the smallest affected source file plus a new Task 9 regression test.

**Interfaces:**
- Consumes: the fixed browser example and local server API.
- Produces: a preflight record under ignored `artifacts/tmp/` and either a clean pass or one focused RED/GREEN fix commit.

- [ ] **Step 1: Run focused frontend and server tests**

```text
node --test tests/ui-contract.test.js tests/server.test.js tests/human-gate.test.js
```

Expected: zero failures.

- [ ] **Step 2: Start and probe the local server**

Run `npm start`, then verify HTTP 200 for `/`, `/styles.css`, `/app.js`, `/api/demo`, `/api/evaluation`, and `/api/health`.

- [ ] **Step 3: Perform the complete preflight flow**

Load the benchmark, inspect a Rule Seam, inspect the complete queue, exercise approve/reject/escalate/undo with a preflight reviewer, confirm approved-only export, inspect metrics, inspect the accessibility failure, and download a trajectory. Preflight decisions do not count as final participant proof.

- [ ] **Step 4: Check keyboard and accessibility behavior**

Verify visible focus, logical tab order, skip link, one `h1`, landmarks, labels, live-region updates, J/K wrapping, A/R/E decisions outside text inputs, focus restoration after server refresh, non-color status cues, and reduced-motion behavior.

- [ ] **Step 5: Check the three required viewports**

Use `375 x 812`, `768 x 1024`, and `1440 x 900`. Confirm no horizontal overflow, clipped evidence, hidden reviewer field, or hidden decision/export control.

- [ ] **Step 6: Handle a preflight failure through systematic debugging**

If a check fails, record the exact reproduction, add a new failing Task 9 test, run it RED, implement one focused fix, run it GREEN, run the three focused test files, and commit with `fix: address Task 9 frontend preflight finding`. Do not modify a hash-frozen Task 8 test.

### Task 4: Run source security and clean-checkout preflight

**Files:**
- Verify: complete repository source
- Modify only for a validated finding: affected source plus a new focused regression test
- Record preflight output under ignored `artifacts/tmp/`

**Interfaces:**
- Consumes: the post-documentation branch.
- Produces: no open critical/high finding and a clean-checkout reproduction before source freeze.

- [ ] **Step 1: Run the standard Codex Security repository scan**

Scan the complete repository. Focus on request bounds, path containment, prompt-injection boundaries, gold isolation, credential redaction, CSV formula injection, server-owned decisions, export authorization, QA evidence trust, Git provenance, and video parsing.

- [ ] **Step 2: Triage each validated finding**

Record severity, source-to-sink path, affected file, and required test. Fix all validated critical/high findings. Fix feasible medium findings that affect the qualification gate. Document accepted low-risk limitations without claiming a clean result before verification.

- [ ] **Step 3: Verify each accepted fix**

Use a new focused test, the affected test group, `npm test`, `npm run replay:check`, and `npm run validate`. Commit each coherent fix separately.

- [ ] **Step 4: Clone the branch into a new verified directory**

Use a newly created directory under `D:\Micro1 hackathon\tmp\verification`. Verify the resolved destination stays under that parent. Clone the current branch without local hardlinks.

- [ ] **Step 5: Run the documented clean setup**

```text
npm test
npm run eval
npm run replay:check
npm run eval:replay
npm run evidence
npm run validate
```

Expected: tests pass, replay consumes 50 calls, build validation passes, and the deterministic comparison remains `0.80` versus `0.90`.

### Task 5: Review and freeze the final source revision

**Files:**
- Review: every source and documentation change since `8964119`
- No evidence files created by this task

**Interfaces:**
- Consumes: Tasks 1 through 4 with clean focused and full verification.
- Produces: one clean source revision used by every final artifact.

- [ ] **Step 1: Request whole-branch code review**

Review against the approved Task 9 design, this plan, challenge deliverables, security boundary, frontend scope, and final-strict schemas. Address critical and important findings through the fix-and-re-review loop.

- [ ] **Step 2: Run the source-freeze gates without mutating the main checkout**

Run only these checks in the main checkout:

```text
npm test
npm run replay:check
npm run validate
git diff --check
git status --short
```

Run the mutation-producing reproduction commands and their validation checks in the clean Task 4 verification clone:

```text
npm run eval
npm run eval:replay
npm run evidence
npm run validate
git diff --check
```

Expected: all commands pass and `git status --short` is empty in the main checkout. Do not restore or reset files to obtain that state. Keep every generated clone output inside the managed evidence roots, and do not copy any clone output back into the main checkout.

- [ ] **Step 3: Record the source revision**

Run `git rev-parse HEAD`. Treat the returned full object ID as `SOURCE_REVISION`. Any later change outside a managed evidence root cancels this freeze and restarts Tasks 5 through 12.

### Task 6: Generate and publish automated release evidence

**Files:**
- Generate: `artifacts/evaluation/**`
- Generate: `artifacts/representative-trajectories/**`
- Generate: `artifacts/expected-replay-report/**`
- Generate: `artifacts/qa/commands/*.json`

**Interfaces:**
- Consumes: clean `SOURCE_REVISION`.
- Produces: seven command records and regenerated deterministic/replay evidence bound to `SOURCE_REVISION`.

- [ ] **Step 1: Run the buffered release command suite**

```text
npm run release:commands
```

Expected: the script exits `0` and writes exactly seven command JSON files after all commands pass.

- [ ] **Step 2: Verify revision and score bindings**

Confirm that `artifacts/evaluation/manifest.json` uses `SOURCE_REVISION`, records the historical clean-source/managed-evidence-dirty state, and reports `0.80`, `0.90`, and `0.10`. Confirm replay reports 50 calls and no substitution.

- [ ] **Step 3: Validate the evidence-only path set**

List every changed path. Reject the publication if any path falls outside the six managed evidence roots.

- [ ] **Step 4: Commit the automated evidence**

```text
git add artifacts/evaluation artifacts/representative-trajectories artifacts/expected-replay-report artifacts/qa/commands
git commit -m "docs: publish Task 9 automated release evidence"
```

### Task 7: Capture the participant human-review run

**Files:**
- Generate: `artifacts/qa/human/ledger.jsonl`
- Generate: `artifacts/qa/human/export.csv`
- Generate: `artifacts/qa/human-review.json`
- Replace: `artifacts/representative-trajectories/human-checkpoint.jsonl`
- Temporary input: `artifacts/tmp/release-session.json`

**Interfaces:**
- Consumes: participant reviewer ID, final local run ID, server snapshot revision, and `SOURCE_REVISION`.
- Produces: approve/escalate/undo/reject proof and an approved-only CSV.

- [ ] **Step 1: Ask the participant for one public reviewer ID**

Reject a blank value or a value containing `agent`, `generator`, or `codex`. Store the approved value only in the local session input and final participant evidence.

- [ ] **Step 2: Start the frozen application and create one final run**

Load the fixed benchmark example. Record the server-issued run ID and keep the same run for every participant decision.

- [ ] **Step 3: Guide the participant through the exact sequence**

The participant must personally:

1. approve the first selected record and leave it approved;
2. escalate a second record;
3. undo the escalation with a reason of at least four characters;
4. reject that second record;
5. download the approved corrections CSV.

- [ ] **Step 4: Let the participant inspect the export**

The participant confirms that the CSV contains the active approved record and excludes the rejected record, all pending records, and the undone escalation.

- [ ] **Step 5: Collect and validate the human evidence**

Update the ignored session input with `SOURCE_REVISION`, reviewer ID, run ID, and final server revision. Run:

```text
npm run release:human
```

Expected: the collector validates four action types, ledger/trajectory equality, undo restoration, and CSV equality before writing final artifacts.

### Task 8: Run final browser, keyboard, accessibility, responsive, security, and clean-checkout QA

**Files:**
- Generate: `artifacts/qa/screenshots/*`
- Update temporary session input: `artifacts/tmp/release-session.json`
- No source changes unless the source freeze is cancelled

**Interfaces:**
- Consumes: the frozen revision and participant run.
- Produces: factual coverage, tools, timestamps, screenshots, security result, and clean-checkout result for category composition.

- [ ] **Step 1: Repeat the full browser flow at the frozen revision**

Record browser name/version, operating system, viewport, run ID, Rule Seam inspected, queue behavior, metric display, accessibility failure display, retry trajectory, and downloads.

- [ ] **Step 2: Record keyboard and accessibility results**

Perform the keyboard-only path and the semantic/focus/live-region checks from Task 3. Record PASS only after each check succeeds.

- [ ] **Step 3: Record responsive screenshots**

Capture the workbench at `375 x 812`, `768 x 1024`, and `1440 x 900`. Store sanitized images under `artifacts/qa/screenshots/` and record each hash in the session input.

- [ ] **Step 4: Run the final standard security scan at `SOURCE_REVISION`**

Record scan scope, tool, timestamp, validated findings, fixes, and verification. A source finding cancels the freeze; an evidence-only issue may be corrected within the managed roots.

- [ ] **Step 5: Run clean-checkout build reproduction**

Clone the frozen branch plus automated evidence into a new verified directory. Run the six clean setup commands from Task 4 and record Node, OS, Git, hashes, metrics, and exit codes in the session input.

### Task 9: Export and privacy-review the Codex development trajectory

**Files:**
- Temporary source: `artifacts/tmp/codex-thread-export.json`
- Temporary normalized input: `artifacts/tmp/codex-export.jsonl`
- Generate: `artifacts/development-agent/trajectory.jsonl`
- Generate: `artifacts/development-agent/manifest.json`

**Interfaces:**
- Consumes: actual completed Codex turns and participant privacy approval.
- Produces: a revision-bound `codex-export` trajectory with real instruction, tool-call, tool-result, feedback, and verification events.

- [ ] **Step 1: Export completed task turns from Codex**

Use the current Codex task export/read interface. Select representative completed work that includes the Task 8 review/fix cycle and the preview root-cause investigation. Preserve source event IDs so a reviewer can trace every normalized event to the export.

- [ ] **Step 2: Normalize only actual events**

Create contiguous schema-v1 JSONL with one run ID, agent `codex`, source `codex-export`, RFC3339 timestamps, and substantive payloads. Map user instruction, tool call, tool output, user/reviewer feedback, and verification output without inventing content.

- [ ] **Step 3: Present the exact JSONL bytes to the participant**

The participant checks for credentials, private paths, personal information, unrelated conversation, and unsafe submission content. A requested redaction must preserve the event's meaning and source ID.

- [ ] **Step 4: Record participant privacy review and collect evidence**

After the participant states PASS, add the review time and reviewer kind to the ignored session input. Run:

```text
npm run release:development
```

Expected: the canonical trajectory and manifest bind `SOURCE_REVISION`, exact hash, event count, run ID, source, agent, and participant privacy review.

### Task 10: Record, inspect, upload, and attest the demo video

**Files:**
- Create: `artifacts/submission/demo.mp4`
- Update temporary session input: `artifacts/tmp/release-session.json`

**Interfaces:**
- Consumes: final browser run, final command evidence, `docs/DEMO_SCRIPT.md`, and participant screen recording.
- Produces: an H.264 AVC MP4 no longer than 300 seconds plus real upload/playback statements.

- [ ] **Step 1: Prepare the recording surfaces**

Open the browser at the benchmark, terminal at the evaluation report, Improvement Changelog, failure-mode document, and one trajectory. Hide credentials, unrelated tabs, notifications, and private paths.

- [ ] **Step 2: Record the 4:40 script**

The participant starts the recorder and follows `docs/DEMO_SCRIPT.md`: problem, baseline, fair comparison, realistic analysis, participant decision sequence, approved-only export, `0.80` to `0.90`, accessibility failure, largest supported bundle, removed `19/20` experiment, reproduction command, and hot take.

- [ ] **Step 3: Place the final encoded file at the canonical path**

Use H.264 AVC video, nonzero dimensions, and a target under 90 MB. Preserve the original recording until the canonical copy passes inspection.

- [ ] **Step 4: Inspect the file without claiming upload**

```text
npm run release:video-check
```

Expected: positive duration at or below 300 seconds, codec `avc1` or `avc3`, nonzero width/height, valid sample count, more than 1024 media bytes, and a SHA-256 hash.

- [ ] **Step 5: Correct encoding only when inspection fails**

If an installed encoder is available, transcode a new temporary H.264/AAC file and inspect it before replacing the canonical copy. Do not install or download software without participant approval.

- [ ] **Step 6: Upload through the participant account**

The participant uploads the inspected file to HackerEarth. Codex must request confirmation at the upload action if Codex controls the browser. The participant confirms the platform accepted the file and displayed a rendered frame.

- [ ] **Step 7: Record real upload and playback facts**

Add accepted status, test timestamp, tool, rendered-frame observation, video hash, duration, resolution, codec, and sample count to the ignored session input.

### Task 11: Collect participant attestations and compose final release evidence

**Files:**
- Generate: `artifacts/qa/categories/*.json`
- Generate: `artifacts/qa/participant-attestation.json`
- Generate: `artifacts/qa/session.json`
- Generate: `artifacts/qa/video.json`
- Generate: `artifacts/qa/release.json`
- Replace: `artifacts/qa/README.md`

**Interfaces:**
- Consumes: all completed machine evidence and direct participant statements.
- Produces: the complete final-strict QA envelope.

- [ ] **Step 1: Ask the participant for eligibility confirmation**

Record only the minimum statement needed: age/eligibility confirmed, individual entry confirmed, accurate registration confirmed, and payout eligibility understood. Do not store identity documents.

- [ ] **Step 2: Ask for provenance, originality, license, and data-rights confirmation**

Record project-specific pre-kickoff work, if any; participant ownership/control; allowed licenses; synthetic/public data rights; and absence of credentials/private data.

- [ ] **Step 3: Review every category result with the participant**

List automated, browser, keyboard, accessibility, responsive, security, cleanCheckout, humanReview, video, developmentAgent, and release. A failed or uncertain category blocks composition.

- [ ] **Step 4: Ask for the final decision**

The participant states exactly `approve release` or `block release` with a reason. Codex must not select the value.

- [ ] **Step 5: Compose the QA envelope**

After participant approval, run:

```text
npm run release:compose
```

Expected: 11 unique category files, seven command bindings, participant decision, human review, development manifest, video metadata, participant attestation, final QA README, and release manifest all bind `SOURCE_REVISION` with exact hashes.

- [ ] **Step 6: Run build validation and the secret scan**

```text
npm run validate
git diff --check
```

Expected: build mode passes and no credential value appears in committed evidence.

### Task 12: Publish evidence-only commits and run strict validation

**Files:**
- Commit only managed evidence roots

**Interfaces:**
- Consumes: composed Task 9 evidence.
- Produces: a clean evidence-only descendant and two successful final-strict validations.

- [ ] **Step 1: Enforce the managed-path boundary before staging**

List tracked and untracked changes. Fail the release if any changed path falls outside:

```text
artifacts/evaluation/
artifacts/representative-trajectories/
artifacts/expected-replay-report/
artifacts/qa/
artifacts/submission/
artifacts/development-agent/
```

- [ ] **Step 2: Commit final human, development, QA, and video evidence**

```text
git add artifacts/evaluation artifacts/representative-trajectories artifacts/expected-replay-report artifacts/qa artifacts/submission artifacts/development-agent
git commit -m "docs: package Task 9 hackathon release evidence"
```

- [ ] **Step 3: Run strict validation in the clean working checkout**

```text
npm run validate:final
git status --short
```

Expected: final-strict exits `0` and Git status is empty.

- [ ] **Step 4: Clone the final commit into a second verified directory**

Clone without local hardlinks. Before running any artifact-generating command, run:

```text
npm run validate:final
npm test
git status --short
```

Expected: final-strict and tests pass; Git remains clean.

- [ ] **Step 5: Run final whole-branch review**

Review final evidence hashes, video claims, participant statements, source/evidence ancestry, official deliverables, and README links. A source finding restarts the freeze and all bound evidence. An evidence-only correction gets a new evidence-only commit and repeats Steps 3 through 5.

### Task 13: Publish and complete the platform submission

**Files:**
- No local file changes expected

**Interfaces:**
- Consumes: clean final commit and participant authorization.
- Produces: remote repository state and one participant-controlled final hackathon entry.

- [ ] **Step 1: Present the final release summary**

Show source revision, evidence commit, test count, deterministic scores, replay calls, video duration/hash, final validator result, fresh-clone result, known accessibility failure, and absent live OpenAI claim.

- [ ] **Step 2: Request push authorization at action time**

After approval, push the named branch or repository. Read back the remote commit and verify it matches the local final commit.

- [ ] **Step 3: Let the participant perform or authorize final submission**

The participant reviews the HackerEarth form, repository/archive link, video, disclosure, and required fields. Codex must request confirmation before any representational final-submit action.

- [ ] **Step 4: Record submission completion outside the committed release tree**

Store the platform receipt or submission ID in a participant-controlled location. Do not amend the validated release commit unless the organizer requires the receipt inside the repository.
