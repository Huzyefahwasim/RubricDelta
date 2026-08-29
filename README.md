# RubricDelta

RubricDelta finds existing labels that may have become invalid after an annotation guideline changes. It ranks the records a reviewer should inspect, links each record to the old and new rules, asks a skeptical verifier to challenge the finding, and requires human approval before export.

## Status

The repository is under active hackathon development. The deterministic benchmark and offline replay path remain the source of truth while the live model adapter stays optional.

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

Run the complete verification suite:

```bash
npm test
npm run eval
npm run validate
```

The included benchmark and replay mode require no API key or network access.

## Optional live model mode

Copy `.env.example` to `.env`, provide `OPENAI_API_KEY`, and choose the OpenAI provider in the run manifest. RubricDelta uses the Responses API with structured output. The application never exposes the key to browser code.

The final benchmark report must state the provider, model, seed, review budget, runtime, token use, and estimated cost.

## Declared evaluation

The primary metric is **affected-record recall at a 20% human-review budget**. The evaluator runs the baseline and final system on the same versioned cases and writes complete per-case results to `artifacts/evaluation/`.

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
