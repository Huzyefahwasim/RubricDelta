# RubricDelta

RubricDelta finds existing labels that may have become invalid after an annotation guideline changes. It ranks the records a reviewer should inspect, links each record to old and new rules, records a skeptical counterargument, and requires human approval before export.

## Status

The deterministic benchmark, browser demo, exact replay provider, and optional OpenAI adapter are implemented.

- The default path uses the deterministic systems. It needs no credentials or network access.
- The replay path consumes the committed `deterministic-role-capture` fixture. It tests the provider workflow without a network call.
- The OpenAI path runs only after you select `--provider openai`, supply `--model`, and set `OPENAI_API_KEY` in the process environment.

Provider failures stop the selected run. RubricDelta does not substitute deterministic rankings for failed replay or OpenAI calls. The repository contains no verified live OpenAI evaluation result.

The default deterministic manifest records replay as `status: not-selected`, `operational: false`, and `substituted: false`.

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

Run the offline release checks:

```bash
npm test
npm run eval
npm run replay:check
npm run eval:replay
npm run evidence
npm run validate
```

`npm run validate` starts with `MODE: BUILD — NON-FINAL`. It validates the deterministic system and all Task 8 provider, prompt, capture, replay, CLI, and artifact gates. Build mode defers these five Task 9 paths:

- `docs/MAIN_FAILURE_MODE.md`
- `docs/HOT_TAKE.md`
- `docs/MODEL_AND_COSTS.md`
- `artifacts/qa/README.md`
- `artifacts/submission/demo.mp4`

`npm run validate:final` applies the final release gates, including participant-owned QA and video evidence.

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

The replay run writes to `artifacts/runs/provider-replay/`. It reports provider `replay`, model `deterministic-role-capture-v1`, 50 calls and 50 attempts, no network requirement, zero tokens, zero provider latency, zero cost, `operational: true`, and `substituted: false`. Replay reproduces the deterministic 0.80 and 0.90 scores. It is deterministic capture evidence, not a live OpenAI run.

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

## Safety boundary

RubricDelta creates recommendations from synthetic benchmark data. A reviewer must approve each correction before export. The project does not evaluate workers or make employment decisions.
