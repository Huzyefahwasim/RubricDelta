# RubricDelta

RubricDelta finds existing labels that may have become invalid after an annotation guideline changes. It ranks the records a reviewer should inspect, links each record to the old and new rules, asks a skeptical verifier to challenge the finding, and requires human approval before export.

## Status

The repository is under active hackathon development. The deterministic benchmark and offline demo are operational. Replay and OpenAI providers are intentionally unavailable until their versioned instructions and adapters land in Task 8; the CLI fails clearly instead of substituting deterministic output.

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

Run the current offline verification gate:

```bash
npm test
npm run eval
npm run evidence
npm run validate
```

`npm run validate` is explicitly the **BUILD — NON-FINAL** gate during Task 7. `npm run validate:final` must fail until the deferred Task 8 provider/prompt work and Task 9 release evidence exist.

## Reproducible evaluation artifacts

```bash
npm run eval:baseline
npm run eval:advanced
npm run eval
```

The combined command writes under `artifacts/evaluation/`:

- `manifest.json` with benchmark hash, ordered cases and records, provider/model/seed, fixed budget, versions, runtime environment, truthful run timing, and resource disclosure;
- gold-free `baseline-predictions.json` and `advanced-predictions.json` written before scoring;
- full paired results in `comparison.json` and a judge-facing `report.md`;
- one complete JSONL trajectory per ordered benchmark case.

The frozen deterministic result is baseline 16/20 = 0.80 versus advanced 18/20 = 0.90 affected-record recall at the fixed 20% review budget.

## Provider status

Task 7 accepts `--provider deterministic|replay|openai` syntactically. Only `deterministic` is operational in this build. `replay` and `openai` return an explicit Task 8 unavailable error; they never fall back or relabel deterministic output.

## Declared evaluation

The primary metric is **affected-record recall at a 20% human-review budget**. Both systems use the same frozen cases, ordered records, deterministic provider, null model, seed 0, and exactly two review slots per case.

Read [the evaluation contract](docs/EVALUATION.md) before changing ranking behavior.

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

RubricDelta creates recommendations. A reviewer must approve each correction before export. The project uses synthetic benchmark data and does not evaluate workers or make employment decisions.
