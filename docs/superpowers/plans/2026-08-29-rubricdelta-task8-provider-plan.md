# RubricDelta Task 8: Fail-Closed Providers and Exact Replay

> This is the binding Task 8 amendment to `2026-08-29-rubricdelta-hackathon-submission.md`. It replaces that plan's original Task 8 section under SDD Rulings 7 and 8.

**Goal:** Add optional OpenAI Responses and exact replay execution without changing the proven synchronous, dependency-free offline path or fabricating live-model evidence.

**Official contracts verified:**
- `https://developers.openai.com/api/reference/typescript/resources/beta/subresources/responses/methods/create`
- `https://developers.openai.com/api/docs/guides/structured-outputs`

## Files

- Create `prompts/rule-compiler.v1.md`
- Create `prompts/change-analyst.v1.md`
- Create `prompts/impact-investigator.v1.md`
- Create `prompts/independent-verifier.v1.md`
- Create `prompts/direct-baseline.v1.md`
- Create `src/providers/contracts.js`
- Create `src/providers/openai.js`
- Create `src/providers/replay.js`
- Create `src/agents/prompt-registry.js`
- Create `src/agents/provider-workflow.js`
- Create `src/evaluation/provider-predictions.js`
- Create `scripts/capture-replay.js`
- Create `data/benchmark/replay/rubricdelta-deterministic-source.v1.json`
- Create `tests/providers.test.js`
- Create `tests/provider-evaluation.test.js`
- Modify `src/agents/policy-analyst.js`, `src/evaluation/index.js`, `scripts/evaluation-artifacts.js`, `scripts/evaluate.js`, `scripts/validate-submission.js`, `package.json`, and `docs/REPRODUCTION.md`

## Non-negotiable interfaces

- Keep `analyzePolicy`, `analyzeScenario`, `createBaselinePredictions`, `createAdvancedPredictions`, `createEvaluationArtifacts`, and default `npm run eval` synchronous, network-free, and output-compatible.
- Extract truthful synchronous `compilePolicyRules(...)` and `analyzeRuleChanges(...)` stages; `analyzePolicy(...)` remains their compatibility composition.
- The prompt registry exposes exactly `rule-compiler`, `change-analyst`, `impact-investigator`, `independent-verifier`, and `direct-baseline`. The provider role `independent-verifier` records the existing `skeptical-verifier` trajectory identity.
- Add a separate async path: `analyzeScenarioWithProvider(...)`, provider prediction creators, and `createProviderEvaluationArtifacts(...)`.
- OpenAI and replay never call a deterministic predictor after failure and never fall back to another provider.
- Raw provider predictions are durable before evaluator-owned gold reaches the scorer. Failed or incomplete provider cases stay explicit and score zero; they are never filled with deterministic rankings.

## Step 1: Provider contracts and role boundaries — RED then GREEN

Write failing tests for strict plain-JSON requests/results, canonical sorted-key identity, SHA-256 request hashes, normalized usage, strict supported JSON Schema validation, prompt filename/version/hash binding, and separate compiler/change-analyst exports.

Reject cycles, accessors, unsupported values or schema keywords, permissive schemas, malformed usage, and schema-invalid results. Then implement contracts, five prompts, the prompt registry, and the role split without changing deterministic rankings or the frozen 0.80-to-0.90 result.

Run:

```text
node --test tests/providers.test.js
node --test tests/policy-analyst.test.js tests/trace-roles.test.js tests/agent-workflow.test.js
```

## Step 2: OpenAI Responses adapter — RED then GREEN

Use injected `fetch`, clock, and sleep stubs only. Cover:

- fixed `POST https://api.openai.com/v1/responses` and redirect rejection;
- bearer key only in the authorization header and absent from bodies, errors, results, traces, and artifacts;
- `store: false`, explicit pinned model, and strict `text.format` JSON Schema;
- bounded response reading, response-envelope validation, refusal/incomplete rejection, exactly one non-fenced JSON output, schema validation, actual-model matching, and usage accounting;
- exactly three total transport attempts, retrying only 429, 5xx, genuine fetch failures, and provider-owned timeouts;
- no retry for other 4xx, caller abort, refusal, incomplete output, malformed output, schema failure, or replay mismatch.

Record usage even when a completed response is later rejected. Aggregate calls, attempts, tokens, model, response ID, and latency. Keep estimated cost `null` until a dated price table exists.

Run: `node --test tests/providers.test.js`

## Step 3: Exact replay and capture — RED then GREEN

Test exact next-entry consumption, canonical request hashes, cloned results, `assertExhausted`, benchmark/source/prompt/model/mode bindings, every identity mismatch, duplicate or missing sequence, secret rejection, and no closest-match or fallback behavior.

`scripts/capture-replay.js` regenerates the committed fixture by executing the real deterministic compiler, change analyst, investigator, verifier, and lexical baseline through a capture adapter on the frozen public benchmark. The fixture must be labeled `deterministic-role-capture`; it must never claim to be an OpenAI run. Bind the benchmark, prompt registry, source files/hash, mode, model, and ordered request hashes. `--check` regenerates in memory and fails on any byte difference. Use deterministic IDs, zero source latency, zero tokens, and zero cost without fabricating provider metadata.

## Step 4: Async workflow, paired evaluation, and CLI — RED then GREEN

Test and implement compiler → change analyst → impact investigator → independent verifier order. Validate role results against current domain IDs and citations. Do not pass investigator scores or score breakdowns to the verifier. Add `status: pending` only after controller validation. Allow at most two schema-repair calls beyond the first attempt.

Provider inputs must contain no ground truth, affected-record IDs, expected labels, rationales, review outcomes, or worker-quality fields. Baseline and advanced systems must receive the same public cases, provider/model binding, repetition count, and review budget.

CLI modes:

```text
--provider replay --replay-fixture <path>
--provider openai --model <pinned-model>
```

Replay fixtures are required only for replay. OpenAI requires `OPENAI_API_KEY` and an explicit model. An environment key alone must never change the offline default. Provider repetitions are written separately and report mean/range; they are never normalized away. Replay is labeled replay with source provenance and `substituted: false`.

Run:

```text
node --test tests/provider-evaluation.test.js
node --test tests/cli.test.js
```

## Step 5: Reproduction and validator gates

Document the two official OpenAI pages, exact replay verification/evaluation, optional live execution, explicit environment setup, pinned-model requirement, and resource disclosure. State clearly that the committed fixture is deterministic-source replay evidence, not OpenAI evidence.

Extend final-strict validation to the five prompts, contracts, providers, async workflow/evaluator, capture script, fixture bindings, exact request consumption, prompt hashes, secret absence, role telemetry, paired provider/model/repeat integrity, and preservation of the offline default. At the Task 8 boundary, build validation passes as non-final and final-strict fails only for named Task 9 deliverables.

## Verification matrix

```text
node --test tests/providers.test.js
node --test tests/provider-evaluation.test.js
node --test tests/cli.test.js tests/trace-roles.test.js tests/agent-workflow.test.js
npm run replay:check
npm run eval:replay
node --test
npm run eval
npm run validate
npm run validate:final
git diff --check
```

Expected:

- all focused and full tests pass without network access;
- replay regeneration is byte-identical;
- replay and offline evaluations reproduce 0.80 versus 0.90 with truthful labels;
- the default deterministic APIs remain synchronous and unchanged;
- build validation passes and stays visibly non-final;
- final-strict fails only for explicit Task 9 items;
- no secret, whitespace, or provenance gate fails.

## Acceptance criteria

- Five versioned prompt roles exist; compiler and change analyst are distinct in provider calls and real trajectories.
- The OpenAI adapter is fail-closed, bounded, credential-safe, strictly structured, and honest about usage and retry behavior.
- Replay is capture-generated and bound to exact requests, benchmark, prompts, source, mode, and model; every mismatch, extra call, or leftover entry fails.
- Replay and OpenAI use only the async path, never leak gold, and never silently substitute deterministic results.
- Provider artifacts disclose calls, attempts, tokens, latency, model, replay provenance, and unknown cost.

## Ruling 8

Existing deterministic workflow, prediction, and artifact APIs remain synchronous and unchanged. Replay and OpenAI use explicit async sibling paths, and replay consumes a capture-generated, source/benchmark/prompt-bound exact request sequence with no closest match or deterministic fallback. This preserves offline reproduction while making provider evidence truthful. If wrong, Task 9 needs one narrow async composition adapter rather than converting deterministic contracts.

## Ruling 9

Every provider and direct-baseline trajectory uses one versioned trace schema containing prompt ID, prompt version, prompt hash, input references, explicit provider/tool call and result events, status, actual model, usage, latency, redaction state, retry accounting, verification outcome, and terminal state. Provider role `independent-verifier` maps only at the trajectory boundary to the product identity `skeptical-verifier`, and direct baseline receives its own trace — this makes the 30-point agent-engineering evidence inspectable and comparable — if wrong, Task 9 must add a narrow trace projection without rewriting provider execution.

## Ruling 10

Use two distinct bindings. `fixture.binding.source.files` contains only the complete deterministic capture dependency closure that can change its 50 requests/results, plus the capture script and any artifact helper it actually imports. Do not include OpenAI-only code or tests there. Prompt hashes remain in `binding.prompts`; benchmark hash/order and protocol ID remain separate binding fields. The validator independently syntax-checks and secret-scans relevant public provider source and runs and hashes every accepted provider, workflow, and capture hardening test as release gates.

## Ruling 11

Keep `analyzePolicy` and `analyzeRuleChanges` strict and output-compatible. Extract the existing pure recovery algorithm as exported `recoverRuleChanges({ oldRules, newRules })` and make deterministic `workflow.js` call it so old ranking, output, and trace behavior stays identical. The deterministic role-capture adapter may call it only after the same strict `EvidenceError`, then project the provider change result back to the unchanged `{ deltas, boundaryCases }` schema. Controller validation may independently compute strict-or-recovered expected data from public cited rules and accept only semantically matching provider output; it must never replace or complete a failed or mismatched provider result. If recovery matched, the controller may add trusted `recovered`, `unresolved`, and `unresolvedRuleIds` metadata to its internal analysis and trace an explicit evidence-bound recovery marker. Tests must prove the strict helper still throws on a known recovery case, extracted recovery preserves previous deterministic analysis, any scoring-relevant deviation from recovered provider output exhausts repairs, and a provider outage never invokes recovery. When provider IDs differ, controller-added `unresolvedRuleIds` are mapped by exact citation into accepted provider rule IDs; every reference must resolve in the accepted analysis, and private trusted IDs must not leak into metadata or traces.

## Ruling 12

Use semantic validation, not undocumented exact-object equality. The compiler requires unique IDs, exact resolving citations, one-to-one coverage of every trusted extracted rule, clean-label and precedence equality, and multiset equality of per-element normalized semantic-token sequences for condition and exception sets. Token sequence and repeated-token cardinality inside each element are fixed because the matcher is phrase-order-sensitive; element-list order, provider IDs, and surface punctuation variants may differ only when that sequence and citation-bound meaning stay stable. The change analyst must satisfy the existing policy contract; use referenced rules and citations; preserve exact source and target labels and precedence truth; use an allowlisted delta type; ground scope and boundary terms with the same per-element sequence semantics; and cover every strict-or-recovered public change relationship after rules are mapped by exact citation. Delta ID wording and list order may differ, but before scoring the controller maps each accepted provider citation/relationship identity to its index in the trusted expected relationship sequence and orders by that index, never by provider order or ID wording. This preserves deterministic and recovered output order without substituting provider fields. The controller never replaces provider fields with trusted fields. The v1 prompts must state these validation rules and the allowed ID and list-order flexibility. Exact replay still enforces the exact recorded requests and results.
