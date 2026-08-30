# RubricDelta

RubricDelta finds existing labels that may have become invalid after an annotation guideline changes. It ranks the records a reviewer should inspect, links each record to old and new rules, records a skeptical counterargument, and requires human approval before export.

## Status

The deterministic benchmark, browser workbench, exact replay provider, optional OpenAI adapter, and fail-closed release-evidence commands are implemented.

- The default path uses the deterministic systems. It needs no credentials or network access.
- The replay path consumes the committed `deterministic-role-capture` fixture. It tests the provider workflow without a network call.
- The OpenAI path runs only after you select `--provider openai`, supply `--model`, and set `OPENAI_API_KEY` in the process environment.

Provider failures stop the selected run. RubricDelta does not substitute deterministic rankings for failed replay or OpenAI calls. The repository contains no verified live OpenAI evaluation result.

The default deterministic manifest records replay as `status: not-selected`, `operational: false`, and `substituted: false`.

The committed capture fixture contains 50 ordered deterministic-source calls. `npm run replay:check` checks those bytes, and `npm run eval:replay` consumes all 50 entries without network access.

Source documents describe the release contract. After the source freeze, [the structured release record](artifacts/qa/release.json) becomes the authority for participant QA, privacy review, security, video, and release approval. Absence of that file means the strict release gate has not passed.

## Product flow

```text
guideline v1 + guideline v2 + labeled records
                       |
                compile rule sets
                       |
                 map rule changes
                       |
              rank affected records
                       |
               challenge each claim
                       |
                 human review gate
                       |
              approved corrections CSV
```

## Quick start

Requirements: Node.js 24 or newer.

```bash
npm start
```

Open `http://localhost:4173` and choose **Load benchmark example**.

Run the offline source checks:

```bash
npm test
npm run eval
npm run replay:check
npm run eval:replay
npm run evidence
npm run validate
```

`npm run validate` checks the deterministic system plus provider, prompt, capture, replay, CLI, and artifact contracts. Build mode does not certify participant-owned release evidence.

Immediately after the source freeze, the release operator refreshes managed deterministic evidence once before recording the release suite:

```bash
npm run eval
npm run release:commands
npm run release:human
npm run release:development
npm run release:video-check
npm run release:compose
npm run validate:final
```

The first `npm run eval` is an unrecorded bootstrap that binds the stale managed manifest to the frozen source revision. `release:commands` still records exactly seven commands in its fixed order, including its own recorded `npm run eval`; the bootstrap is not an eighth command.

The participant supplies the human-review session, development-trajectory privacy decision, video, upload/playback confirmation, eligibility and rights attestations, and final `approve release` decision. The commands reject missing or inconsistent inputs. Read [the reproduction guide](docs/REPRODUCTION.md) for the evidence sequence and canonical paths.

## Measured result

The deterministic offline evaluation improved affected-record recall at a fixed 20% review budget from 16/20 (0.80) to 18/20 (0.90) on a frozen 100-record synthetic benchmark.

Both systems use benchmark `rubricdelta-support-guideline-drift-v1`, protocol `rubricdelta-evaluation-v2`, the same ten cases, the same record order, seed 0, and two review slots per case. The result measures the complete deterministic system bundle against the lexical baseline. It does not isolate one stage or measure a live OpenAI model.

The combined deterministic command writes under `artifacts/evaluation/`:

- `manifest.json`, including protocol, benchmark, Git, resource, and raw-prediction hash bindings
- gold-free `baseline-predictions.json` and `advanced-predictions.json`
- full paired results in `comparison.json` and `report.md`
- one complete JSONL trajectory per benchmark case

## Provider execution

Verify and run the committed exact replay:

```bash
npm run replay:check
npm run eval:replay
```

The replay run writes to `artifacts/runs/provider-replay/`. It reports provider `replay`, model `deterministic-role-capture-v1`, 50 calls and 50 attempts, no network requirement, zero tokens, zero provider latency, zero cost, `operational: true`, and `substituted: false`. Replay reproduces the deterministic 0.80 and 0.90 scores. The committed fixture at `data/benchmark/replay/rubricdelta-deterministic-source.v1.json` provides deterministic capture evidence, not a live OpenAI result.

For an approved live call, set `OPENAI_API_KEY` in the current process and run:

```bash
node scripts/evaluate.js --provider openai --model <pinned-model-id> --mode both --repeats 1 --output-dir artifacts/runs/provider-openai
```

An API key by itself does not change the deterministic default. RubricDelta records the provider output and fails the affected case if the provider, schema, citation, or semantic checks fail.

## Evaluation contract

The primary metric is **affected-record recall at a 20% human-review budget**. Read [the evaluation contract](docs/EVALUATION.md) before changing ranking behavior.

## Documentation

- [Implementation plan](docs/IMPLEMENTATION_PLAN.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Agent system](docs/AGENT_SYSTEM.md)
- [Evaluation contract](docs/EVALUATION.md)
- [Reproduction guide](docs/REPRODUCTION.md)
- [Security and data policy](docs/SECURITY.md)
- [Submission checklist](docs/SUBMISSION_CHECKLIST.md)
- [Five-minute demo script](docs/DEMO_SCRIPT.md)
- [Improvement changelog](IMPROVEMENT_CHANGELOG.md)
- [Model and cost disclosure](docs/MODEL_AND_COSTS.md)
- [Development-agent disclosure](docs/DEVELOPMENT_AGENT_DISCLOSURE.md)
- [Main failure mode](docs/MAIN_FAILURE_MODE.md)
- [Hot take](docs/HOT_TAKE.md)

## Safety boundary

RubricDelta creates recommendations from synthetic benchmark data. A reviewer must approve each correction before export. The project does not evaluate workers or make employment decisions.
