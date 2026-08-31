# RubricDelta Final Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the completed RubricDelta application on `main`, verify it at one frozen source revision, and close every release check that does not require a participant-owned attestation or video.

**Architecture:** Preserve the completed dependency-free Node.js application and its protocol-v2 evaluation contract. Integrate the existing linear branch, make only narrowly verified corrections, then use the repository's deterministic evaluator, exact replay, validator, browser workflow, security scan, and fail-closed release collector to generate revision-bound evidence.

**Tech Stack:** Node.js 24+, ECMAScript modules, built-in `node:test`, built-in HTTP and filesystem APIs, browser-native HTML/CSS/JavaScript, optional OpenAI Responses API behind explicit CLI selection.

**Spec:** `docs/superpowers/specs/2026-08-31-rubricdelta-final-integration-design.md`

## Global Constraints

- Finish within the participant's five-hour release window.
- Do not change benchmark cases, ground truth, protocol v2, metrics, review budget, baseline algorithm, deterministic ranking, prompts, replay inventory, or seed.
- Keep the offline path dependency-free at runtime and network-free.
- Preserve untracked QA screenshots until they are deliberately incorporated or returned.
- Add a failing regression test before any production-code fix.
- Use only the repository's release collector for passing evidence claims.
- Never infer participant identity, privacy approval, eligibility, rights, video proof, or final release approval.

---

### Task 1: Commit the Approved Integration Documents

**Files:**
- Create: `docs/superpowers/specs/2026-08-31-rubricdelta-final-integration-design.md`
- Create: `docs/superpowers/plans/2026-08-31-rubricdelta-final-integration.md`

**Interfaces:**
- Consumes: approved source commit `b55a40e42727ffdb25b72b417d81887b97ece056`.
- Produces: a documented source-integration contract that later evidence can bind to.

- [ ] **Step 1: Check the completed worktree before staging**

Run: `git status --short`

Expected: only the two new documents and the preserved `artifacts/qa/screenshots/` directory are untracked.

- [ ] **Step 2: Scan both documents for placeholders and contract drift**

Run: `rg -n "T[B]D|T[O]DO|implement l[a]ter|protocol-v1 implement[a]tion" docs/superpowers/specs/2026-08-31-rubricdelta-final-integration-design.md docs/superpowers/plans/2026-08-31-rubricdelta-final-integration.md`

Expected: no output.

- [ ] **Step 3: Commit only the approved documents**

```text
git add docs/superpowers/specs/2026-08-31-rubricdelta-final-integration-design.md docs/superpowers/plans/2026-08-31-rubricdelta-final-integration.md
git commit -m "docs: approve final RubricDelta integration"
```

Expected: screenshots remain untracked and unchanged.

---

### Task 2: Correct the Historical Protocol Wording

**Files:**
- Modify: `docs/EVALUATION_PROTOCOL_V2.md:42`
- Test: `tests/evaluation-protocol.test.js`
- Test: `tests/task9-release-docs.test.js`

**Interfaces:**
- Consumes: the canonical protocol-v2 manifest and current evaluation documentation.
- Produces: judge-facing prose that agrees with the committed machine-readable evidence.

- [ ] **Step 1: Capture the stale assertion**

Run: `rg -n "Task 7 manifest remains.*protocol-v1" docs/EVALUATION_PROTOCOL_V2.md`

Expected: one match on the stale final paragraph.

- [ ] **Step 2: Replace the stale paragraph**

Use this exact meaning: the canonical deterministic manifest now records protocol v2, and the final release bootstrap will regenerate that evidence for the frozen source revision. Do not alter any metric or artifact.

- [ ] **Step 3: Verify the stale claim is gone**

Run: `rg -n "Task 7 manifest remains.*protocol-v1" docs/EVALUATION_PROTOCOL_V2.md`

Expected: no output.

- [ ] **Step 4: Run focused documentation and protocol tests**

Run: `node --test tests/evaluation-protocol.test.js tests/task9-release-docs.test.js`

Expected: all tests pass.

- [ ] **Step 5: Commit the correction**

```text
git add docs/EVALUATION_PROTOCOL_V2.md
git commit -m "docs: align protocol v2 evidence wording"
```

---

### Task 3: Fast-Forward the Submission Branch

**Files:**
- Update: Git ref `main`
- Preserve: `artifacts/qa/screenshots/`

**Interfaces:**
- Consumes: the completed integration branch after Tasks 1 and 2.
- Produces: `main` containing the full application and a linear source history.

- [ ] **Step 1: Prove fast-forward safety**

Run: `git merge-base --is-ancestor main codex/task9-evidence-eol-refreeze`

Expected: exit 0.

- [ ] **Step 2: Verify root untracked paths do not overlap tracked integration paths**

Run: `git status --short --untracked-files=all`

Expected: no tracked modifications. Do not delete untracked workspace probes.

- [ ] **Step 3: Fast-forward main**

Run: `git merge --ff-only codex/task9-evidence-eol-refreeze`

Expected: `main` points at the completed integration commit with no merge commit.

- [ ] **Step 4: Verify identity and preserved data**

Run: `git rev-parse HEAD; git status --short`

Expected: full application files exist; unrelated untracked root paths remain untouched.

---

### Task 4: Run Source Verification and Review

**Files:**
- Modify only if a verified defect requires a regression-tested fix.
- Test: `tests/**/*.test.js`

**Interfaces:**
- Consumes: integrated `main`.
- Produces: a reviewed source-freeze candidate.

- [ ] **Step 1: Run focused core tests**

Run: `node --test tests/evaluation.test.js tests/evaluation-protocol.test.js tests/agent-workflow.test.js tests/human-gate.test.js tests/server.test.js tests/ui-contract.test.js`

Expected: all focused tests pass.

- [ ] **Step 2: Run the complete suite**

Run: `npm test`

Expected: zero failures. Allow the release-hardening integration tests to finish; do not treat partial output as success.

- [ ] **Step 3: Run an independent whole-branch review**

Review `main` against `AGENTS.md`, the approved integration spec, the frozen evaluation contract, security boundaries, and the four deliverables. Any important finding must name an exact file and reproducer.

- [ ] **Step 4: Fix only validated defects test-first**

For each defect: add the smallest failing test, run it to confirm failure, patch with `apply_patch`, run focused tests, then run the full affected suite. Commit each coherent fix separately.

- [ ] **Step 5: Freeze source**

Run: `git status --short; git diff --check`

Expected: no tracked source changes and no whitespace errors. Record the exact source-freeze revision.

---

### Task 5: Run Security and Browser Acceptance

**Files:**
- Modify only for validated critical or high security findings.
- Preserve or create QA media only under `artifacts/qa/`.

**Interfaces:**
- Consumes: source-freeze candidate.
- Produces: actual security and browser-QA observations for that revision.

- [ ] **Step 1: Run a standard Codex Security repository scan**

Scope: complete repository. Focus on path traversal, prompt injection, credentials, CSV injection, artifact access, request bounds, provider validation, and human-approval export.

Expected: no unresolved critical or high findings. Validate candidates before fixing them.

- [ ] **Step 2: Start the loopback application**

Run: `npm start`

Expected: server listens on `127.0.0.1:4173` and `/api/health` returns 200 with security headers.

- [ ] **Step 3: Exercise the judge flow**

Load the benchmark example, inspect the Rule Seam, approve one record, reject one, escalate one, undo once, export CSV, open paired evaluation, and inspect/download a trajectory.

Expected: only the active approved correction appears in CSV; status is conveyed with text as well as color.

- [ ] **Step 4: Verify accessibility and responsive behavior**

Check keyboard-only use, visible focus, shortcuts outside inputs, reduced motion, `aria-live`, one `h1`, accessible metric tables, and viewports 375x812, 768x1024, and 1440x900.

Expected: no horizontal overflow or inaccessible control. Preserve legitimate screenshots and record observed limitations.

---

### Task 6: Rebuild Automated Evidence at the Frozen Revision

**Files:**
- Regenerate: `artifacts/evaluation/**`
- Regenerate: `artifacts/expected-replay-report/operational-replay/**`
- Generate: `artifacts/qa/commands/**`
- Generate: `artifacts/qa/command-suite.json`

**Interfaces:**
- Consumes: clean frozen source revision.
- Produces: revision-bound deterministic, replay, command, and build evidence.

- [ ] **Step 1: Bootstrap deterministic evidence**

Run: `npm run eval`

Expected: baseline remains `16/20 = 0.80`, advanced remains `18/20 = 0.90`, and all ten per-case results are present.

- [ ] **Step 2: Record the fixed release command suite**

Run: `npm run release:commands`

Expected: seven ordered command records covering tests, deterministic evaluation, replay check, exact replay evaluation, evidence generation, build validation, and whitespace checks.

- [ ] **Step 3: Inspect the recorded suite**

Run: `node -e "const value=JSON.parse(require('node:fs').readFileSync('artifacts/qa/command-suite.json','utf8')); console.log(value.status, value.commands?.length ?? value.records?.length)"`

Expected: passing status and exactly seven commands.

- [ ] **Step 4: Run build validation independently**

Run: `npm run validate`

Expected: exit 0 with no missing-source or evidence-integrity errors.

---

### Task 7: Prove Clean Reproduction and Prepare Participant Handoff

**Files:**
- Generate through release tooling only: final category/session/release artifacts.
- Participant supplies: `artifacts/tmp/codex-export.jsonl`, `artifacts/submission/demo.mp4`, attestations, and final approval.

**Interfaces:**
- Consumes: frozen source and automated evidence.
- Produces: a precise participant checklist and, after genuine inputs, the final release envelope.

- [ ] **Step 1: Reproduce from a disposable clean checkout**

Create a clean checkout of the frozen revision outside the source tree, run `npm test`, `npm run eval`, `npm run replay:check`, `npm run eval:replay`, `npm run evidence`, and `npm run validate`, then compare result schemas and disclosed scores.

Expected: all commands pass without credentials or network access.

- [ ] **Step 2: Collect genuine human-review evidence**

The participant performs approve, reject, escalate, and undo in the final browser session. Run `npm run release:human` only against that real session.

- [ ] **Step 3: Collect the exact privacy-reviewed development trajectory**

The participant exports and reviews the exact newline-terminated Codex JSONL bytes at `artifacts/tmp/codex-export.jsonl`. Run `npm run release:development` only after explicit privacy approval of those bytes.

- [ ] **Step 4: Collect and verify the video**

The participant records `artifacts/submission/demo.mp4`, confirms it is no more than 300 seconds, uploads it, and verifies rendered playback. Run `npm run release:video-check` against the real file and confirmations.

- [ ] **Step 5: Record participant attestations and final approval**

Collect eligibility, registration, originality, license, data-rights, no-secret, and provenance confirmations plus the explicit `approve release` decision. Never prefill these as passing.

- [ ] **Step 6: Compose and validate final release**

```text
npm run release:compose
npm run validate:final
git diff --check
```

Expected: all exit 0, `artifacts/qa/release.json` binds every category to one revision, and the final tree satisfies the validator's cleanliness contract.
