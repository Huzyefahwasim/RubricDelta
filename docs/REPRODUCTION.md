# Reproduction Guide

## Environment

- Operating system: Windows, macOS, or Linux
- Node.js: 24 or newer
- Runtime dependencies: none for the offline path
- Network: not required for the benchmark, tests, evidence generation, or interface

The evaluation manifest records the exact Node version, platform, architecture, benchmark hash, Git state, truthful overall run timing, and zero deterministic provider calls/tokens/cost.

## Clean setup

```bash
git clone <submission-url>
cd rubric-delta
npm test
npm run eval
npm run evidence
npm run validate
npm start
```

Open `http://localhost:4173` and load the benchmark example.

## Exact evaluation commands

```bash
npm run eval:baseline
npm run eval:advanced
npm run eval
```

The commands write reports under `artifacts/evaluation/`. The combined command runs both systems against the same benchmark version, deterministic provider, null model, seed 0, ordered cases and records, and fixed 20% review budget.

Equivalent explicit CLI forms are supported:

```bash
node scripts/evaluate.js --mode both --output-dir artifacts/evaluation --provider deterministic --repeats 1
node scripts/evaluate.js --mode=both --output-dir=artifacts/evaluation --provider=deterministic --repeats=1
```

Legacy `--baseline`, `--predictions`, `--benchmark`, `--output`, `--summary-only`, and `--compact` modes remain available. Mixing legacy selection flags with the artifact workflow is rejected as a conflict.

## Representative evidence

After the combined evaluation:

```bash
npm run evidence
```

This command derives success, verifier disagreement, uncertainty, and natural retry/recovery trajectories from the real deterministic run. It also starts the guarded local server, creates a run, submits an attributable human approval, downloads the server-owned trajectory, and writes a hash-bound expected replay reference. It does not hand-edit events.

## Validator phases

```bash
npm run validate
npm run validate:final
```

During Task 7, `validate` runs `--mode build`, starts with `MODE: BUILD — NON-FINAL`, validates all current deterministic evidence, and labels Task 8/9 release items `DEFERRED`. `validate:final` intentionally exits nonzero until versioned provider instructions/adapters, final documentation, QA evidence, and video evidence exist. Task 9 will make final-strict the default release gate.

## Provider status in this build

`--provider replay` and `--provider openai --model <pinned-model>` parse, then fail with an accurate Task 8 unavailable message. They never substitute deterministic results. Task 8 will document the live Responses API request shape, exact model ID, replay fixture binding, and pricing source.

## Expected outputs

- run manifest;
- raw gold-free baseline and advanced predictions;
- complete aggregate and per-case metrics;
- selected, missed, and false-positive record IDs for every case;
- explicit hard precedence case;
- one complete JSONL trajectory per case;
- Markdown report with raw-artifact links;
- representative workflow and human-checkpoint trajectories;
- hash-bound expected replay reference.

## Reproduction acceptance test

A reviewer should be able to remove generated evaluation/evidence outputs, run `npm run eval`, run `npm run evidence`, receive the same raw deterministic predictions and metrics, pass `npm run validate`, start the interface, make a human decision, and export only approved corrections.
