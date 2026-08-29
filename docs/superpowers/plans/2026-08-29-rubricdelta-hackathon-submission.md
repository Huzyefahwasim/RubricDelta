# RubricDelta Hackathon Submission Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a judge-ready RubricDelta application that proves an evidence-linked agent workflow outperforms a fixed baseline while preserving reproduction, safety, and human control.

**Architecture:** A dependency-free Node.js workflow controller coordinates a Policy Analyst, Impact Investigator, and Independent Verifier through strict plain-object contracts. A built-in HTTP server exposes immutable run artifacts and a guarded human-review API to a browser-native Policy Forensics Workbench.

**Tech Stack:** Node.js 24+, ECMAScript modules, `node:test`, built-in HTTP and filesystem APIs, browser-native HTML/CSS/JavaScript, optional OpenAI Responses API through server-side `fetch`.

**Spec:** `docs/superpowers/specs/2026-08-29-rubricdelta-submission-design.md`

## Global Constraints

- Node.js 24 or newer and ECMAScript modules.
- No runtime package dependencies for the offline path.
- The benchmark, replay, tests, and demo require no network or credentials.
- Production workflow modules must not import or read benchmark ground-truth fields.
- The primary metric remains micro affected-record recall at a 20 percent review budget.
- The binding review-budget contract is `rubricdelta-evaluation-v2`: `max(1, floor(recordCount * fraction))`. See `docs/superpowers/plans/2026-08-29-rubricdelta-evaluation-protocol-v2.md`.
- Baseline and advanced systems use the same public inputs, review budget, provider, and model in paired comparisons.
- Model output and user input remain untrusted until schema checks pass.
- Only server-owned human approvals can enter an export.
- Every agent instruction, tool call, result, retry, verification, and human decision produces a sanitized trajectory event.
- Browser code never receives `OPENAI_API_KEY`.
- All user-facing states support keyboard access and never depend on color alone.
- Use `apply_patch` for source edits and test-first development for each implementation task.

---

### Task 1: Public Scenario Boundary and Trajectory Recorder

**Files:**
- Create: `src/domain/scenario.js`
- Create: `src/domain/validation.js`
- Create: `src/agents/trace.js`
- Create: `tests/domain.test.js`

**Interfaces:**
- Consumes: benchmark case objects from `loadBenchmark()`.
- Produces: `toPublicScenario(testCase)`, `validateScenario(scenario)`, `createTraceRecorder(options)`, and `redactSecrets(value)`.

- [ ] **Step 1: Write failing public-boundary tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { loadBenchmark } from "../src/evaluation/index.js";
import { toPublicScenario } from "../src/domain/scenario.js";

test("public scenarios exclude every ground-truth field", () => {
  const scenario = toPublicScenario(loadBenchmark().cases[0]);
  const serialized = JSON.stringify(scenario);
  assert.equal("groundTruth" in scenario, false);
  assert.doesNotMatch(serialized, /affectedRecordIds|expectedLabels|rationales/);
});
```

- [ ] **Step 2: Run the test and confirm the module is missing**

Run: `node --test tests/domain.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/domain/scenario.js`.

- [ ] **Step 3: Implement immutable public projection and validation**

```js
export function toPublicScenario(testCase) {
  return Object.freeze({
    id: testCase.id,
    title: testCase.title,
    difficulty: testCase.difficulty,
    changeType: testCase.changeType,
    oldGuideline: structuredClone(testCase.oldGuideline),
    newGuideline: structuredClone(testCase.newGuideline),
    records: testCase.records.map((record) => ({ ...record })),
  });
}
```

Validation must reject missing guideline text, duplicate record IDs, empty record text, missing existing labels, and unknown object shapes.

- [ ] **Step 4: Add failing trajectory redaction and sequencing tests**

```js
test("trace recorder redacts secrets and increments sequence", () => {
  const trace = createTraceRecorder({ runId: "run-1", scenarioId: "case-1", now: () => "2026-08-29T00:00:00.000Z" });
  const first = trace.record({ agent: "policy-analyst", phase: "compile", type: "instruction", payload: { authorization: "Bearer secret" } });
  const second = trace.record({ agent: "policy-analyst", phase: "compile", type: "final", payload: {} });
  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
  assert.equal(JSON.stringify(first).includes("Bearer secret"), false);
});
```

- [ ] **Step 5: Implement append-only in-memory trace recording**

The recorder returns copied events through `events()`, supports JSONL through `toJSONL()`, and replaces keys matching `authorization`, `apiKey`, `token`, `secret`, or `password` with `[REDACTED]`.

- [ ] **Step 6: Run focused and full tests**

Run: `node --test tests/domain.test.js && node --test`

Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/domain/scenario.js src/domain/validation.js src/agents/trace.js tests/domain.test.js
git commit -m "feat: enforce public scenario and trace boundaries"
```

---

### Task 2: Policy Analyst and Evidence-Linked Rule Deltas

**Files:**
- Create: `src/domain/text.js`
- Create: `src/domain/rules.js`
- Create: `src/agents/policy-analyst.js`
- Create: `tests/policy-analyst.test.js`

**Interfaces:**
- Consumes: the public `oldGuideline` and `newGuideline` objects from Task 1 plus a trace recorder.
- Produces: `analyzePolicy({ oldGuideline, newGuideline, trace })` returning `{ oldRules, newRules, deltas, boundaryCases }`.

- [ ] **Step 1: Write failing citation and precedence tests**

```js
test("policy analyst identifies the fraud precedence exception with source spans", () => {
  const scenario = toPublicScenario(loadBenchmark().cases.find((item) => item.id === "fraud-overrides-refunds"));
  const result = analyzePolicy({ ...scenario, trace: createTraceRecorder({ runId: "r", scenarioId: scenario.id }) });
  assert.ok(result.deltas.some((delta) => delta.precedenceChanged));
  assert.ok(result.deltas.some((delta) => delta.targetLabel === "Fraud Review"));
  assert.ok(result.deltas.every((delta) => delta.citations.length >= 2));
  assert.ok(result.deltas.flatMap((delta) => delta.citations).every((citation) => citation.quote.length > 0));
});
```

- [ ] **Step 2: Run the test and confirm the analyst module is missing**

Run: `node --test tests/policy-analyst.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement sentence spans and routing-rule extraction**

`splitWithSpans(text)` returns sentence text, start offset, end offset, and normalized tokens. `extractRoutingRules(document)` recognizes `Route ... to <Label>` clauses, keeps exact quotes, assigns stable IDs from version and position, and extracts explicit precedence language.

```js
export function citationFor(document, span) {
  return {
    documentId: document.id,
    section: `sentence-${span.index + 1}`,
    start: span.start,
    end: span.end,
    quote: document.text.slice(span.start, span.end),
  };
}
```

- [ ] **Step 4: Implement semantic delta pairing**

Pair rules by label overlap and normalized scope similarity. Emit `added`, `removed`, `scope-expanded`, `scope-narrowed`, `label-changed`, `exception-changed`, or `priority-changed`. Every delta contains old and new rule IDs, target label, source labels, scope terms, boundary cases, precedence flag, and both citations.

- [ ] **Step 5: Add no-change and evidence-failure tests**

Tests must prove a wording-only change does not create a behavioral delta and that a delta without both source citations throws `EvidenceError`.

- [ ] **Step 6: Run focused and full tests**

Run: `node --test tests/policy-analyst.test.js && node --test`

Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/domain/text.js src/domain/rules.js src/agents/policy-analyst.js tests/policy-analyst.test.js
git commit -m "feat: compile evidence-linked guideline deltas"
```

---

### Task 3: Impact Investigator, Independent Verifier, and Advanced Predictions

**Files:**
- Create: `src/domain/semantics.js`
- Create: `src/agents/impact-investigator.js`
- Create: `src/agents/verifier.js`
- Create: `src/agents/workflow.js`
- Create: `src/evaluation/advanced.js`
- Modify: `src/evaluation/index.js`
- Create: `tests/agent-workflow.test.js`

**Interfaces:**
- Consumes: public scenarios, policy-analysis output, trace recorder, and `{ maxRecords, maxRetries }` budget.
- Produces: `analyzeScenario(scenario, options)` and `createAdvancedPredictions(benchmark, options)` with the existing prediction schema.

- [ ] **Step 1: Write failing investigator tests for known baseline misses**

```js
test("investigator ranks semantic and inflectional matches above lexical distractors", () => {
  const ids = ["fraud-overrides-refunds", "security-vulnerability", "multi-customer-outage", "regulated-text-translation"];
  for (const id of ids) {
    const scenario = toPublicScenario(loadBenchmark().cases.find((item) => item.id === id));
    const result = analyzeScenario(scenario, { mode: "deterministic" });
    assert.equal(result.rankedCandidates.length, scenario.records.length);
    assert.ok(result.rankedCandidates.slice(0, 2).every((item) => item.evidence.length > 0));
  }
});
```

- [ ] **Step 2: Run the test and confirm the workflow module is missing**

Run: `node --test tests/agent-workflow.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement transparent semantic normalization**

Normalize Unicode, lowercase, singularize common plurals, and expand bounded domain-independent equivalence groups such as `credential/secret/token`, `unauthorized/unrecognized/not authorized`, and `all/every/entire/multiple`. Keep each expansion in candidate evidence so judges can inspect why a score changed.

- [ ] **Step 4: Implement candidate scoring**

```text
score = 4 * exact changed-scope phrase matches
      + 2 * semantic-equivalent matches
      + 2 * existing-label transition match
      + 1 * boundary-condition match
      - 3 * already-at-target-label
      - 2 * explicit exclusion match
```

Break ties by evidence completeness, then stable input order. Return a complete ranking so the existing evaluator controls the cutoff.

- [ ] **Step 5: Implement blind verification and abstention**

The verifier receives candidate evidence without investigator score. It rejects invalid citations, applies target-label and precedence checks, records one counterargument, and returns `support`, `reject`, or `uncertain`. A supported candidate needs a changed-rule citation, record evidence, and a proposed label different from the existing label.

- [ ] **Step 6: Add the fair improvement test**

```js
test("advanced workflow beats the frozen lexical baseline without gold access", () => {
  const benchmark = loadBenchmark();
  const baseline = evaluatePredictions(benchmark, createBaselinePredictions(benchmark));
  const advanced = evaluatePredictions(benchmark, createAdvancedPredictions(benchmark));
  assert.ok(advanced.primaryMetric.value > baseline.primaryMetric.value);
  assert.ok(advanced.primaryMetric.value >= 0.9);
});
```

Add a source scan test that fails if files outside `src/evaluation/` contain `groundTruth`, `affectedRecordIds`, `expectedLabels`, or `rationales`.

- [ ] **Step 7: Run focused and full tests plus paired evaluation**

Run: `node --test tests/agent-workflow.test.js && node --test && node scripts/evaluate.js --baseline --summary-only`

Expected: all tests PASS and the frozen baseline remains 0.80 recall.

- [ ] **Step 8: Commit**

```bash
git add src/domain/semantics.js src/agents src/evaluation/advanced.js src/evaluation/index.js tests/agent-workflow.test.js
git commit -m "feat: rank and verify policy-drift candidates"
```

---

### Task 4: Immutable Artifacts and Human Decision Gate

**Files:**
- Create: `src/domain/decisions.js`
- Create: `src/domain/csv.js`
- Create: `src/artifacts/store.js`
- Create: `tests/human-gate.test.js`

**Interfaces:**
- Consumes: workflow result, run manifest, trace events, and decision commands.
- Produces: `createDecisionLedger(candidates, options)`, `createArtifactStore(root)`, and `exportApprovedCSV(runState)`.

- [ ] **Step 1: Write failing guarded-export tests**

```js
test("export contains approved corrections and excludes pending, rejected, and escalated records", () => {
  const ledger = createDecisionLedger([{ recordId: "a", proposedLabel: "Fraud" }, { recordId: "b", proposedLabel: "Billing" }], { now: () => "2026-08-29T00:00:00.000Z" });
  ledger.decide({ recordId: "a", decision: "approve", reviewer: "judge" });
  ledger.decide({ recordId: "b", decision: "escalate", reviewer: "judge" });
  const csv = exportApprovedCSV({ runId: "run-1", candidates: ledger.candidates(), decisions: ledger.events() });
  assert.match(csv, /a,Fraud/);
  assert.doesNotMatch(csv, /b,Billing/);
});
```

- [ ] **Step 2: Run the test and confirm missing modules**

Run: `node --test tests/human-gate.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement append-only decisions and undo**

Accept only `approve`, `reject`, and `escalate`. Validate known record IDs, non-empty reviewers, and optional reason length. `undo(recordId)` appends an undo event and restores the preceding effective state.

- [ ] **Step 4: Implement safe CSV and atomic artifacts**

Prefix fields beginning with `=`, `+`, `-`, or `@` with a single quote. Escape double quotes. Resolve every artifact path under the configured root, write to a sibling temporary file, and rename it into place.

- [ ] **Step 5: Add traversal, formula, and failed-write tests**

Tests must reject `../outside`, neutralize `=IMPORTXML(...)`, and leave an existing artifact intact if a replacement write fails.

- [ ] **Step 6: Run focused and full tests**

Run: `node --test tests/human-gate.test.js && node --test`

Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/domain/decisions.js src/domain/csv.js src/artifacts/store.js tests/human-gate.test.js
git commit -m "feat: guard correction exports with human decisions"
```

---

### Task 5: HTTP Application and Offline Demo API

**Files:**
- Create: `src/server/headers.js`
- Create: `src/server/router.js`
- Create: `src/server/app.js`
- Create: `src/server/index.js`
- Create: `tests/server.test.js`

**Interfaces:**
- Consumes: workflow, artifact store, benchmark public projection, decision ledger, and static `public/` root.
- Produces: `createRubricDeltaServer({ port, host, publicRoot, artifactRoot })` returning `{ start(), stop(), address() }`.

- [ ] **Step 1: Write failing health, demo, and security-header tests**

```js
test("server exposes health and a gold-free demo payload", async () => {
  const server = createRubricDeltaServer({ port: 0, artifactRoot: temporaryDirectory });
  await server.start();
  t.after(() => server.stop());
  const health = await fetch(`${server.address()}/api/health`);
  assert.equal(health.status, 200);
  assert.equal(health.headers.get("x-content-type-options"), "nosniff");
  const demoText = await (await fetch(`${server.address()}/api/demo`)).text();
  assert.doesNotMatch(demoText, /affectedRecordIds|expectedLabels|rationales/);
});
```

- [ ] **Step 2: Run the test and confirm the server module is missing**

Run: `node --test tests/server.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement routing, JSON limits, and static serving**

Implement the HTTP surface from the spec. Reject unsupported methods with 405, JSON over 1 MiB with 413, malformed JSON with 400, unknown run IDs with 404, and path traversal with 404. Serve only files resolved inside `publicRoot`.

- [ ] **Step 4: Implement run, decision, undo, export, trajectory, and evaluation endpoints**

The demo endpoint runs or reuses the deterministic example. Decision endpoints write human checkpoint events. Export reads server-owned state. Evaluation returns paired baseline and advanced results with the fair-comparison manifest.

- [ ] **Step 5: Add integration tests for decisions and guarded export**

Create a run, attempt export before approval, approve one known candidate, export again, and verify that only that record appears. Test escalation and undo.

- [ ] **Step 6: Run focused and full tests**

Run: `node --test tests/server.test.js && node --test`

Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/server tests/server.test.js
git commit -m "feat: expose local RubricDelta review API"
```

---

### Task 6: Policy Forensics Workbench

**Files:**
- Create: `public/index.html`
- Create: `public/styles.css`
- Create: `public/app.js`
- Create: `public/ui-model.js`
- Create: `tests/ui-contract.test.js`

**Interfaces:**
- Consumes: `GET /api/demo`, run decision endpoints, evaluation response, and trajectory events from Task 5.
- Produces: five navigable views, keyboard review actions, and downloadable export/trajectory links.

- [ ] **Step 1: Write failing semantic and accessibility contract tests**

```js
test("workbench exposes one h1, skip navigation, live status, and labeled decision controls", () => {
  const html = readFileSync(resolve("public/index.html"), "utf8");
  assert.equal((html.match(/<h1\b/g) ?? []).length, 1);
  assert.match(html, /href="#main"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, />Approve</);
  assert.match(html, />Reject</);
  assert.match(html, />Escalate</);
});
```

- [ ] **Step 2: Run the test and confirm UI files are missing**

Run: `node --test tests/ui-contract.test.js`

Expected: FAIL with `ENOENT` for `public/index.html`.

- [ ] **Step 3: Build semantic shell and industrial editorial tokens**

Use `--paper: #f1efe6`, `--ink: #121411`, `--amber: #f2a900`, `--teal: #087a68`, `--red: #a93630`, and `--focus: #145cff`. Use system fallbacks for condensed display, readable body, and monospace evidence type. Include a skip link, one `h1`, five phase buttons, and named landmarks.

- [ ] **Step 4: Implement the Rule Seam and Impact Queue**

Render old and new policy quotes with semantic `del` and `ins`. Connect each selected delta to candidate cards through the amber seam. Show existing label, proposed label, confidence, citations, verifier verdict, counterargument, and status text.

- [ ] **Step 5: Implement human decisions and keyboard controls**

Use A, R, E, J, and K only when focus is outside an input. Show a persistent decision bar, visible review-slot counter, undo, and `aria-live` updates. Never update source labels in browser state.

- [ ] **Step 6: Implement evaluation and trajectory views**

Show the declared primary metric first, paired baseline/final values, per-case table, hard-case status, false positives, misses, runtime, and fair-comparison flags. Render the event rail as instruction, tool call, result, validation, retry, verifier challenge, human checkpoint, and final.

- [ ] **Step 7: Add responsive and reduced-motion rules**

At 900 pixels stack policy panes; at 640 pixels turn the queue into cards and keep decisions in a sticky bottom bar. Disable nonessential transitions under `prefers-reduced-motion: reduce`.

- [ ] **Step 8: Run contract tests and browser QA**

Run: `node --test tests/ui-contract.test.js && node --test`

Then inspect at 375x812, 768x1024, and 1440x900. Verify keyboard focus order, decision shortcuts, no horizontal overflow, and readable evidence.

- [ ] **Step 9: Commit**

```bash
git add public tests/ui-contract.test.js
git commit -m "feat: build the policy forensics workbench"
```

---

### Task 7: Evaluation CLI, Reproduction Validator, and Representative Evidence

**Files:**
- Modify: `scripts/evaluate.js`
- Create: `scripts/validate-submission.js`
- Modify: `package.json`
- Create: `tests/cli.test.js`
- Create: `artifacts/representative-trajectories/README.md`
- Create: `artifacts/expected-replay-report/README.md`

**Interfaces:**
- Consumes: baseline and advanced prediction creators, evaluator, workflow traces, and required documentation paths.
- Produces: stable commands for baseline, advanced, combined evaluation, validation, and judge-facing artifacts.

- [ ] **Step 1: Write failing CLI tests**

```js
test("combined evaluation writes paired raw and summary reports", () => {
  const output = mkdtempSync(join(tmpdir(), "rubricdelta-eval-"));
  const run = spawnSync(process.execPath, ["scripts/evaluate.js", "--mode", "both", "--output-dir", output], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(existsSync(join(output, "baseline-predictions.json")));
  assert.ok(existsSync(join(output, "advanced-predictions.json")));
  assert.ok(existsSync(join(output, "comparison.json")));
  assert.ok(existsSync(join(output, "report.md")));
});
```

- [ ] **Step 2: Run the test and observe argument failure**

Run: `node --test tests/cli.test.js`

Expected: FAIL because `--mode` and `--output-dir` are unsupported.

- [ ] **Step 3: Extend evaluation CLI**

Support `--mode baseline|advanced|both`, `--output-dir`, `--provider deterministic|replay|openai`, `--model`, and `--repeats`. Preserve existing `--baseline` and `--predictions` compatibility. Write raw predictions before loading gold for scoring.

- [ ] **Step 4: Implement submission validator**

Check required source, prompts, docs, benchmark, test, representative trajectory, and report paths. Validate JSON and JSONL. Confirm video duration only when a video file exists. Exit nonzero with one actionable line per missing or invalid item.

- [ ] **Step 5: Align package scripts with exact commands**

```json
{
  "start": "node src/server/index.js",
  "test": "node --test",
  "eval": "node scripts/evaluate.js --mode both",
  "eval:baseline": "node scripts/evaluate.js --mode baseline",
  "eval:advanced": "node scripts/evaluate.js --mode advanced",
  "validate": "node scripts/validate-submission.js"
}
```

- [ ] **Step 6: Generate representative deterministic evidence**

Run the example to capture real successful, retry, verifier-disagreement, abstention, and human-checkpoint branches. Commit sanitized trajectories and the replay report. Do not fabricate an event that the workflow did not produce.

- [ ] **Step 7: Run CLI, full test, and validator checks**

Run: `node --test tests/cli.test.js && node --test && npm run eval && npm run validate`

Expected: all tests PASS, evaluation exits 0, and validator exits 0.

- [ ] **Step 8: Commit**

```bash
git add scripts package.json tests/cli.test.js artifacts
git commit -m "feat: package reproducible evaluation evidence"
```

---

### Task 8: Optional OpenAI Provider and Versioned Role Instructions

**Files:**
- Create: `prompts/policy-analyst.v1.md`
- Create: `prompts/impact-investigator.v1.md`
- Create: `prompts/independent-verifier.v1.md`
- Create: `prompts/direct-baseline.v1.md`
- Create: `src/providers/openai.js`
- Create: `src/providers/replay.js`
- Create: `tests/providers.test.js`

**Interfaces:**
- Consumes: role name, system instruction, public payload, strict JSON Schema, model, budget, and injected `fetch`.
- Produces: `createOpenAIProvider(options).complete(request)` and `createReplayProvider(fixtures).complete(request)` returning `{ data, usage, responseId, model, latencyMs }`.

- [ ] **Step 1: Read current official OpenAI Responses API documentation**

Confirm the request shape for `POST /v1/responses`, strict `text.format` JSON Schema, token usage, `store: false`, and response text extraction. Record the official documentation URL in `docs/REPRODUCTION.md`.

- [ ] **Step 2: Write failing provider tests with an injected fetch stub**

```js
test("OpenAI provider keeps credentials in headers and parses strict JSON output", async () => {
  const calls = [];
  const provider = createOpenAIProvider({ apiKey: "test-key", model: "pinned-test-model", fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ id: "resp_1", model: "pinned-test-model", output_text: "{\"rules\":[]}", usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } }), { status: 200 });
  }});
  const result = await provider.complete({ role: "policy-analyst", instruction: "Compile", input: {}, schema: { type: "object", properties: { rules: { type: "array" } }, required: ["rules"], additionalProperties: false } });
  assert.equal(result.data.rules.length, 0);
  assert.equal(JSON.stringify(calls[0].init.body).includes("test-key"), false);
  assert.equal(calls[0].init.headers.authorization, "Bearer test-key");
});
```

- [ ] **Step 3: Run the test and confirm provider module is missing**

Run: `node --test tests/providers.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 4: Implement strict provider, retry classification, and replay**

Set `store: false`, send role instructions separately from untrusted input, parse `output_text`, validate the parsed shape, and never log headers. Retry 429 and 5xx responses within the controller budget. Reject missing API key before network access.

- [ ] **Step 5: Write concise role instructions**

Each prompt must define goal, allowed tools, input/output schema, citation requirement, abstention behavior, and a statement that guideline and record contents are data rather than instructions.

- [ ] **Step 6: Run focused and full tests**

Run: `node --test tests/providers.test.js && node --test`

Expected: all tests PASS without network access.

- [ ] **Step 7: Commit**

```bash
git add prompts src/providers tests/providers.test.js docs/REPRODUCTION.md
git commit -m "feat: add strict live and replay model providers"
```

---

### Task 9: Submission Documentation, End-to-End QA, and Release Evidence

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `IMPROVEMENT_CHANGELOG.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/AGENT_SYSTEM.md`
- Modify: `docs/EVALUATION.md`
- Modify: `docs/REPRODUCTION.md`
- Modify: `docs/SECURITY.md`
- Modify: `docs/SUBMISSION_CHECKLIST.md`
- Modify: `docs/DEMO_SCRIPT.md`
- Create: `docs/MAIN_FAILURE_MODE.md`
- Create: `docs/HOT_TAKE.md`
- Create: `docs/MODEL_AND_COSTS.md`

**Interfaces:**
- Consumes: verified commands, raw reports, real trajectories, browser QA notes, and security findings.
- Produces: the complete four-part hackathon submission package.

- [ ] **Step 1: Run the complete clean verification before writing claims**

Run:

```text
npm test
npm run eval
npm run validate
```

Record exact counts, metric values, runtime, and artifact paths. Do not draft performance claims from expected results.

- [ ] **Step 2: Update documentation with measured evidence**

README contains problem, user, quick start, architecture, safety gate, baseline/final comparison, limitations, and exact links. Changelog records hypothesis, change, command, before, after, cost/runtime, failure analysis, decision, and evidence for every experiment, including one removed experiment.

- [ ] **Step 3: Document failure mode and hot take**

`MAIN_FAILURE_MODE.md` includes concrete false-positive examples and mitigation limits. `HOT_TAKE.md` states the coherent-drift claim and links it to benchmark evidence without claiming more than the experiment measured.

- [ ] **Step 4: Run browser end-to-end and accessibility QA**

Start the server, load the benchmark, inspect a Rule Seam, approve one candidate, reject one, escalate one, undo once, download approved CSV, inspect paired metrics, and inspect trajectory. Repeat responsive checks at 375, 768, and 1440 CSS pixels. Record screenshots and failures under `artifacts/qa/`.

- [ ] **Step 5: Run Codex Security standard scan and fix validated findings**

Scan the complete repository with focus on input handling, path traversal, prompt injection, credential exposure, CSV injection, artifact access, and the human approval boundary. Fix validated critical and high findings, re-run affected tests, and verify each fix.

- [ ] **Step 6: Run a clean-checkout reproduction**

Clone the repository to a temporary directory, run the documented commands, compare the generated report schema with the committed expected replay report, and record Node and OS versions.

- [ ] **Step 7: Run final whole-branch code review**

Review the complete branch against the approved spec, implementation plan, hackathon rubric, security policy, deferred findings, and all four deliverables. Address critical and important findings through the Superpowers fix-and-re-review loop.

- [ ] **Step 8: Final verification**

Run:

```text
npm test
npm run eval
npm run validate
git diff --check
```

Expected: zero test failures, evaluator and validator exit 0, and no whitespace errors.

- [ ] **Step 9: Commit**

```bash
git add README.md AGENTS.md IMPROVEMENT_CHANGELOG.md docs artifacts/qa
git commit -m "docs: package RubricDelta hackathon submission"
```
