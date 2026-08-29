# Implementation Plan

## Objective

Ship a judge-ready RubricDelta submission that demonstrates a useful end-to-end workflow, a fair baseline comparison, purposeful agent engineering, complete evidence, and clean reproduction.

## Success conditions

- A reviewer can load an included example and complete the workflow without credentials.
- The system identifies affected records across at least ten guideline-revision cases.
- Baseline and advanced runs share the same provider, cases, seed, and 20% review budget.
- The evaluator writes aggregate and per-case results.
- The interface shows rule evidence, verifier challenges, uncertainty, and human decisions.
- A clean Node.js environment can run the app, tests, evaluation, and validation commands.
- The repository contains the four required hackathon deliverables.

## Chosen scope

Use synthetic customer-support ticket routing. Each benchmark case contains:

- an old guideline;
- a revised guideline;
- labeled records;
- the affected record IDs;
- expected rule deltas;
- one or more boundary records.

The product does not relabel an entire dataset. It prioritizes the small review queue with the highest expected value.

## Phases

### Phase 1: Evaluation contract

- [ ] Freeze at least ten benchmark cases.
- [ ] Add explicit ground truth and data validation.
- [ ] Implement the 20% review-budget calculation.
- [ ] Implement recall, precision, F1, false-positive count, and per-case reporting.
- [ ] Implement a simple baseline.
- [ ] Record the first baseline run.

Exit gate: `npm run eval:baseline` produces deterministic JSON and Markdown reports.

### Phase 2: Agent pipeline

- [ ] Compile structured rules with stable IDs and citations.
- [ ] Classify rule changes and precedence.
- [ ] Generate boundary hypotheses.
- [ ] Rank candidate records.
- [ ] Verify candidates and record counterarguments.
- [ ] Escalate ambiguity.
- [ ] Record JSONL trajectories.

Exit gate: the advanced runner passes domain tests and writes evidence for each recommendation.

### Phase 3: Human review workflow

- [ ] Add approve, reject, and escalate decisions.
- [ ] Add undo.
- [ ] Prevent unapproved corrections from export.
- [ ] Write decision events to the trajectory.
- [ ] Export approved corrections and a review manifest.

Exit gate: tests prove that the export gate rejects unreviewed recommendations.

### Phase 4: Judge-facing interface

- [ ] Build intake and one-click example loading.
- [ ] Build the Rule Seam diff workbench.
- [ ] Build the ranked impact queue.
- [ ] Build the evidence and decision panel.
- [ ] Build baseline versus advanced evaluation view.
- [ ] Build the trajectory inspector.
- [ ] Test keyboard use, reduced motion, and responsive layouts.

Exit gate: a judge can complete the demo flow without reading the README.

### Phase 5: Submission evidence

- [ ] Record experiments and one removed experiment.
- [ ] Document the main failure mode and hot take.
- [ ] Store representative trajectories for each agent role.
- [ ] Add exact clean-environment commands.
- [ ] Record versions, runtime, token use, and cost.
- [ ] Run a clean reproduction check.
- [ ] Record and trim the five-minute video.

Exit gate: `npm run validate` passes every automated submission check.

## Decision log

| Date | Decision | Reason |
|---|---|---|
| 2026-08-29 | Use Node.js ESM and built-in tests | Judges can run the offline path without installing packages |
| 2026-08-29 | Use synthetic support-ticket data | Clear user value without private or high-impact data |
| 2026-08-29 | Declare recall at 20% review budget | Measures mistakes found under the user's real time constraint |
| 2026-08-29 | Keep the live model provider optional | The benchmark and demo remain reproducible without credentials |
| 2026-08-29 | Use an industrial editorial interface | Evidence should feel inspectable rather than decorative |

## Risks

| Risk | Effect | Mitigation |
|---|---|---|
| The product looks like a text diff | Low agent-engineering score | Show structured rules, boundary cases, verification, and retries |
| Synthetic cases leak into heuristics | Inflated evaluation | Keep ground truth separate and test unseen wording variants |
| Live model output varies | Weak reproduction | Pin model and prompts, store raw results, run repeated trials, include replay mode |
| Too many agent roles | Decorative orchestration | Keep four stages with explicit inputs, outputs, and failure handling |
| UI consumes build time | Missing evidence | Complete evaluation and tests before visual polish |
| Agent flags too many records | Poor user value | Optimize recall at a fixed review budget and report precision |
