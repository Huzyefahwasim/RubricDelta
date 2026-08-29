# RubricDelta Agent Instructions

## Mission

Build a reproducible agent system that finds existing data labels affected by a guideline revision, explains each finding with evidence, and requires a human decision before exporting corrections.

The submission must prove improvement over a simple baseline on the same fixed benchmark. A polished interface without measurable evidence does not satisfy the project goal.

## Source of truth

Read these files before changing implementation:

1. `docs/IMPLEMENTATION_PLAN.md`
2. `docs/EVALUATION.md`
3. `docs/ARCHITECTURE.md`
4. `docs/AGENT_SYSTEM.md`
5. `docs/SECURITY.md`

If code and documentation disagree, stop and update the plan or document the decision before changing the evaluation contract.

## Non-negotiable constraints

- Use Node.js 24+ and ECMAScript modules.
- Keep the offline path free of runtime package dependencies.
- Never require network access for the included benchmark, tests, or replay demo.
- Keep the optional OpenAI path behind `OPENAI_API_KEY` and an explicit provider flag.
- Never commit keys, private data, raw customer data, or model secrets.
- Never modify benchmark ground truth to improve a result.
- Run baseline and advanced systems on the same cases, review budget, seed, and provider.
- Store complete per-case results. Do not report only aggregate scores.
- Require a human decision before any correction enters an export.
- Record every agent instruction, tool call, result, retry, verification step, and human checkpoint as JSONL.
- Keep generated outputs under `artifacts/`; keep source fixtures under `data/benchmark/`.

## Working method

1. Write or update the implementation plan.
2. Add a failing test or benchmark case.
3. Implement the smallest change that satisfies it.
4. Run focused tests, then the full suite.
5. Run the benchmark when ranking behavior changes.
6. Record the experiment and result in `IMPROVEMENT_CHANGELOG.md`.
7. Update the README and reproduction instructions when commands or behavior change.

Use subagents for bounded work. Give each agent explicit file ownership. A reviewer must inspect changes from another agent before integration.

## Architecture boundaries

- `src/domain/`: pure domain rules and validation. No HTTP or model calls.
- `src/agents/`: orchestration, agent roles, retries, and verification.
- `src/providers/`: deterministic and remote model adapters.
- `src/evaluation/`: metrics and benchmark runner.
- `src/server/`: HTTP transport and static-file serving.
- `public/`: accessible browser interface. No business logic that affects scores.
- `data/benchmark/`: frozen synthetic cases and ground truth.
- `scripts/`: stable commands for evaluation and submission checks.
- `tests/`: deterministic tests using Node's built-in test runner.

Keep modules small and pass plain objects across boundaries. Validate untrusted input at the server and provider boundaries.

## Evaluation integrity

The declared primary metric is affected-record recall at a 20% human-review budget.

Do not change the following after the first recorded full run without adding a versioned evaluation protocol:

- case IDs;
- ground-truth affected record IDs;
- review-budget calculation;
- metric formulas;
- baseline prompt or algorithm;
- test seed.

Any correction to ground truth needs a written reason, before-and-after values, and a changelog entry.

## Agent behavior

The advanced system uses four purposeful stages:

1. Rule compiler
2. Change analyst
3. Impact investigator
4. Skeptical verifier

The orchestrator owns state and may retry a failed stage twice. It must escalate unresolved ambiguity instead of inventing evidence. The verifier must cite rule IDs and record IDs. Human decisions use `approve`, `reject`, or `escalate`.

## Interface requirements

- Open into the working product, not a marketing landing page.
- Provide a one-click benchmark example.
- Make old rule, new rule, interpretation, and affected records visible through the Rule Seam.
- Support keyboard review controls and visible focus.
- Use semantic HTML, one `h1`, labeled controls, `aria-live` status, and reduced-motion support.
- Never encode status through color alone.
- Provide an accessible table for each chart.

## Commands

Use the scripts defined in `package.json`:

```bash
npm start
npm test
npm run eval
npm run eval:baseline
npm run eval:advanced
npm run validate
```

## Definition of done

A change is complete when:

- focused and full tests pass;
- the offline example runs without credentials;
- affected evaluation results remain explainable;
- trajectories contain no secrets;
- documentation matches the behavior;
- the interface works at desktop and mobile widths;
- a clean checkout can reproduce the documented result.
