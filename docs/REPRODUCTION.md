# Reproduction Guide

## Environment

- Operating system: Windows, macOS, or Linux
- Node.js: 24 or newer
- Runtime dependencies: none for the offline path
- Network: not required for tests, the deterministic benchmark, exact replay, evidence generation, or the browser demo

The deterministic manifest records the Node version, platform, architecture, benchmark hash, Git state, run timing, and zero provider calls, attempts, tokens, latency, and cost. It hashes the raw prediction bytes. The benchmark hash canonicalizes UTF-8 text to LF, and `.gitattributes` keeps hash-bound benchmark and evidence files byte-stable across Windows and Unix checkouts.

## Clean setup

```bash
git clone <submission-url>
cd RubricDelta
npm test
npm run eval
npm run replay:check
npm run eval:replay
npm run evidence
npm run validate
npm start
```

Open `http://localhost:4173` and load the benchmark example.

## Deterministic evaluation

```bash
npm run eval:baseline
npm run eval:advanced
npm run eval
```

The commands write under `artifacts/evaluation/`. The combined command runs both systems against benchmark `rubricdelta-support-guideline-drift-v1` under protocol `rubricdelta-evaluation-v2`. Each system receives the same ten cases, record order, deterministic provider, null model, seed 0, and 20% review budget.

Expected primary result:

- baseline: 16/20 = 0.80
- advanced: 18/20 = 0.90
- absolute improvement: 0.10

The result measures affected-record recall across the complete frozen 100-record synthetic benchmark. It measures the full deterministic system bundle against the lexical baseline and does not assign the gain to one stage.

The deterministic manifest records replay as `status: not-selected`, `operational: false`, and `substituted: false`. The separate replay command writes operational replay evidence under `artifacts/runs/provider-replay/`.

These CLI forms produce the same deterministic run:

```bash
node scripts/evaluate.js --mode both --output-dir artifacts/evaluation --provider deterministic --repeats 1
node scripts/evaluate.js --mode=both --output-dir=artifacts/evaluation --provider=deterministic --repeats=1
```

Legacy `--baseline`, `--predictions`, `--benchmark`, `--output`, `--summary-only`, and `--compact` modes remain available. The CLI rejects a command that mixes legacy selection flags with the artifact workflow.

## Exact replay

Run the committed capture check before replay evaluation:

```bash
npm run replay:check
npm run eval:replay
```

The scripts expand to:

```bash
node scripts/capture-replay.js --check
node scripts/evaluate.js --provider replay --replay-fixture data/benchmark/replay/rubricdelta-deterministic-source.v1.json --mode both --repeats 1 --output-dir artifacts/runs/provider-replay
```

The fixture contains 50 ordered deterministic captures: ten direct-baseline calls and four advanced role calls for each of ten cases. The replay manifest reports:

- provider `replay`
- model `deterministic-role-capture-v1`
- `operational: true` and `substituted: false`
- 50 calls and 50 attempts
- zero input, output, and total tokens
- zero provider latency and cost
- `networkRequired: false`

Replay must reproduce baseline 0.80 and advanced 0.90. It verifies request order, prompt, benchmark, source, model, mode, repetition, result, and resource bindings. The fixture came from deterministic role capture. It contains no OpenAI responses and provides no live-model evidence.

## Optional OpenAI evaluation

The live path requires three choices from the operator:

1. Approve sending the public or authorized scenario content to the OpenAI Responses API.
2. Set `OPENAI_API_KEY` in the current process environment.
3. Select the provider and pinned model in the command.

```bash
node scripts/evaluate.js --provider openai --model <pinned-model-id> --mode both --repeats 1 --output-dir artifacts/runs/provider-openai
```

The CLI does not read `OPENAI_MODEL` or `RUBRICDELTA_PROVIDER`. A key without `--provider openai --model <pinned-model-id>` leaves the deterministic default in place. A missing key, provider error, invalid structured output, citation failure, or semantic mismatch fails the selected path. RubricDelta does not fill the result with a deterministic ranking.

The adapter uses `POST https://api.openai.com/v1/responses`, `store: false`, and strict structured output. Its implementation follows the official [Responses create reference](https://developers.openai.com/api/reference/typescript/resources/beta/subresources/responses/methods/create) and [Structured Outputs guide](https://developers.openai.com/api/docs/guides/structured-outputs). The repository contains no verified live OpenAI evaluation result, dated price table, or live-model improvement claim.

## Representative evidence

After `npm run eval`, run:

```bash
npm run evidence
```

The command derives verifier disagreement, uncertainty, and retry/recovery trajectories from the deterministic evaluation. It also drives the guarded local decision endpoint with reviewer name `hackathon-evidence-generator`. That event demonstrates the server boundary and does not prove participant review, reviewer identity, or human approval. Final human-review evidence must come from the participant.

The command writes a hash-bound deterministic reference under `artifacts/expected-replay-report/`. Its `replayOperational: false` field describes that deterministic reference. The separate `eval:replay` artifacts record the operational replay run.

## Validator phases

```bash
npm run validate
npm run validate:final
```

`npm run validate` runs build mode and starts with `MODE: BUILD — NON-FINAL`. It validates the deterministic evidence plus all Task 8 provider, prompt, capture, replay, CLI, and artifact gates. It defers these five Task 9 paths:

- `docs/MAIN_FAILURE_MODE.md`
- `docs/HOT_TAKE.md`
- `docs/MODEL_AND_COSTS.md`
- `artifacts/qa/README.md`
- `artifacts/submission/demo.mp4`

`npm run validate:final` checks the final release evidence. Participant review, browser and accessibility QA, security review, clean-checkout proof, a playable video no longer than five minutes, development-agent evidence, and the release decision must use the final source revision.

## Expected outputs

- deterministic manifest and paired comparison
- raw gold-free baseline and advanced predictions
- aggregate and per-case metrics
- selected, missed, and false-positive record IDs for each case
- hard precedence case evidence
- one deterministic JSONL trajectory per case
- replay manifest, summary, repetitions, raw predictions, resources, and provider traces
- representative mechanism trajectories and deterministic reference hashes

## Acceptance test

A reviewer can reproduce the release when a clean checkout completes the clean setup commands, reports 16/20 and 18/20 on the deterministic run, verifies and runs the exact replay, starts the browser demo, records a participant decision, and exports only active approved corrections.
