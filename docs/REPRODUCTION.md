# Reproduction Guide

## Environment

- Operating system: Windows, macOS, or Linux
- Node.js: 24 or newer
- Runtime dependencies: none for the offline path
- Network: not required for tests, the deterministic benchmark, exact replay, evidence generation, or the browser demo

The deterministic manifest records the Node version, platform, architecture, benchmark hash, Git state, run timing, and zero provider calls, attempts, tokens, latency, and cost. It hashes the raw prediction bytes. The benchmark hash canonicalizes UTF-8 text to LF, and `.gitattributes` keeps hash-bound benchmark and evidence files byte-stable across Windows and Unix checkouts.

The manifest's Git booleans describe the post-generation, pre-publication state. A run from a clean source revision records clean source files and dirty managed evidence files. The validator derives `trackedWorkingTreeDirty` from the first descendant commit that publishes the evaluation manifest; later evidence commits do not change it. The value is false when every path in that first publication is new. After you commit the evidence, a clean clone retains the historical booleans. The validator measures the clone's current status on its own and rejects nondefault index flags or path identities that cannot round-trip across supported filesystems.

## Clean setup

```bash
git clone https://github.com/Huzyefahwasim/RubricDelta.git RubricDelta-release
cd RubricDelta-release
npm run validate:final
npm test
npm run replay:check
git status --short
npm start
```

The first three checks inspect the submitted release without regenerating evidence. `git status --short` must print no paths. Open `http://localhost:4173` and load the benchmark example.

Use a second clean checkout for a source-level reproduction because these commands regenerate managed evidence:

```bash
git clone https://github.com/Huzyefahwasim/RubricDelta.git RubricDelta-source
cd RubricDelta-source
npm test
npm run eval
npm run replay:check
npm run eval:replay
npm run evidence
npm run validate
npm start
```

The release record at `artifacts/qa/release.json` identifies the source revision and the evidence-only publication chain. A clone without that record cannot pass `npm run validate:final`.

## Deterministic evaluation

```bash
npm run eval:baseline
npm run eval:advanced
npm run eval
```

The commands write under `artifacts/evaluation/`. The combined command runs both systems against benchmark `rubricdelta-support-guideline-drift-v1` under current protocol `rubricdelta-evaluation-v3`. Each system receives the same ten cases, record order, deterministic provider, null model, seed 0, and 20% review budget. Protocol v2 remains historical; regenerate deterministic and replay artifacts from a clean source revision before release validation.

Expected primary result:

- baseline: 16/20 = 0.80
- advanced: 18/20 = 0.90
- absolute improvement: 0.10

The result measures affected-record recall across the complete frozen 100-record synthetic benchmark. It measures the full deterministic system bundle against the lexical baseline and does not assign the gain to one stage.

The deterministic manifest records replay as `status: not-selected`, `operational: false`, and `substituted: false`. The normal replay command publishes its canonical operational evidence under `artifacts/expected-replay-report/operational-replay/` and keeps a byte-equivalent compatibility copy under the explicit `artifacts/runs/provider-replay/` destination.

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

The package command retains the frozen explicit `artifacts/runs/provider-replay/` argument. For that exact replay fixture, provider, mode, repeat count, and destination, it also publishes the canonical bundle at `artifacts/expected-replay-report/operational-replay/`. Custom destinations remain literal and untrusted. Build and final validation require the canonical publication, bind its revision to the deterministic manifest, and compare its stable bytes with an isolated replay.

Replay must reproduce baseline 0.80 and advanced 0.90. Those scores belong to `comparison.json` and `report.md`; the replay manifest records provenance, protocol, resources, replay state, and hashes. Deterministic-source replay validates the captured request and result bindings. The fixture contains no OpenAI responses and provides no evidence about live-model behavior.

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

The command writes a hash-bound deterministic reference under `artifacts/expected-replay-report/`. Its `replayOperational: false` field describes that deterministic reference. `eval:replay` writes the separate operational bundle under the adjacent `operational-replay/` directory without changing the reference.

## Release evidence commands

Immediately after committing the clean source-freeze revision, refresh the managed deterministic evidence:

```bash
npm run eval
```

This bootstrap is intentionally unrecorded. It makes `artifacts/evaluation/manifest.json` name the frozen `HEAD` before the fail-closed command preflight. If it is skipped, `release:commands` stops before executing any command and instructs the operator to run `npm run eval` and retry.

Then run the automated suite:

```bash
npm run release:commands
```

The suite records exactly `npm test`, `npm run eval`, `npm run replay:check`, `npm run eval:replay`, `npm run evidence`, `npm run validate`, and `git diff --check` under `artifacts/qa/commands/`. It publishes no command-suite marker unless all seven commands pass at one revision. The bootstrap is not an eighth recorded command.

Participant-controlled inputs use the ignored file `artifacts/tmp/release-session.json`. The operator then runs:

```bash
npm run release:human
npm run release:development
npm run release:video-check
npm run release:compose
```

These commands use fixed inputs and outputs:

- `release:human` reads the participant's browser run and writes `artifacts/qa/human/ledger.jsonl`, `artifacts/qa/human/export.csv`, and `artifacts/qa/human-review.json`.
- `release:development` reads a real newline-terminated Codex export from `artifacts/tmp/codex-export.jsonl`. The participant records the SHA-256 of those exact reviewed bytes as `privacyReview.sourceSha256` in the ignored session input. Collection rejects a mismatch before parsing and publishes the reviewed bytes unchanged to `artifacts/development-agent/trajectory.jsonl`; its manifest and final session retain the same hash.
- `release:video-check` inspects `artifacts/submission/demo.mp4` without claiming upload or playback.
- `release:compose` writes category evidence, participant attestations, video evidence, `artifacts/qa/session.json`, and `artifacts/qa/release.json` only after every machine and participant gate passes.

No source document substitutes for those artifacts. Their absence leaves the related participant or release claim unverified.

The relevant ignored-session fragment is:

```json
{
  "privacyReview": {
    "status": "PASS",
    "reviewer": { "kind": "participant", "id": "<participant-reviewer-id>" },
    "reviewedAt": "<RFC3339-UTC-timestamp>",
    "sourceSha256": "<sha256-of-exact-newline-terminated-artifacts/tmp/codex-export.jsonl>"
  }
}
```

## Validator phases

```bash
npm run validate
npm run validate:final
```

`npm run validate` checks build-time source, deterministic evidence, provider, prompt, capture, replay, CLI, and artifact contracts. It does not certify participant evidence.

`npm run validate:final` adds hash-bound participant review, browser and accessibility QA, security review, clean-checkout proof, a playable H.264 video no longer than five minutes, development-agent evidence, upload/playback confirmation, and the participant's release decision. Every record must bind the source revision in the deterministic manifest.

## Expected outputs

- deterministic manifest and paired comparison
- raw gold-free baseline and advanced predictions
- aggregate and per-case metrics
- selected, missed, and false-positive record IDs for each case
- hard precedence case evidence
- one deterministic JSONL trajectory per case
- replay manifest, summary, repetitions, raw predictions, resources, and provider traces
- representative mechanism trajectories and deterministic reference hashes
- seven command records and 11 release-category records
- participant decision ledger and approved-only CSV
- privacy-reviewed development-agent trajectory and manifest
- inspected demo video plus upload/playback evidence
- `artifacts/qa/release.json` as the post-freeze completion record

## Acceptance test

A reviewer can reproduce the measured system when a clean checkout reports 16/20 and 18/20 on the deterministic run, verifies and runs the exact replay, and starts the browser workbench. The submitted release qualifies only when the untouched checkout also passes `npm run validate:final` and stays clean.
