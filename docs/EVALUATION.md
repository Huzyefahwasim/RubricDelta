# Evaluation Contract

**Protocol:** [`rubricdelta-evaluation-v2`](EVALUATION_PROTOCOL_V2.md), effective 2026-08-29. The manifest stores the complete machine-readable contract.

## User question

A review lead can inspect only a fraction of the existing dataset. Which records should the lead inspect first after the guideline changes?

## Primary metric

**Affected-record recall at a 20% review budget**

For each case:

```text
review slots = max(1, floor(recordCount * reviewBudgetFraction))
selected = top-ranked records limited to review slots
recall@20% = affected records in selected / all affected records
```

The aggregate score uses micro-averaging across the complete benchmark. The report also includes every case score.

## Secondary metrics

- Precision at the review budget
- F1 at the review budget
- Mean reciprocal rank of the first affected record
- Unsupported-claim rate
- Escalation rate
- Runtime per case
- Input, output, and total tokens
- Estimated cost per case when a priced provider runs

## Benchmark composition

The frozen benchmark contains at least ten synthetic guideline revisions. It covers:

- a label renamed without semantic change;
- a new exception;
- a removed exception;
- a precedence change;
- a narrowed rule;
- an expanded rule;
- a new escalation requirement;
- a threshold change;
- overlapping rules;
- wording drift with no behavior change.

At least one hard case must require applying a new high-priority rule over an older general rule.

## Baseline

The baseline receives both guideline versions and all records. It produces one ranked list and an explanation using a direct prompt or a simple deterministic analogue. It does not use a rule graph, boundary-case generation, independent verification, retries, or persistent state.

## Advanced system

The final system compiles rules, maps semantic deltas, generates boundary hypotheses, ranks candidates, challenges each candidate, and escalates unresolved ambiguity.

## Fair comparison rules

Each paired run must use:

- the same benchmark version;
- the same provider and model;
- the same seed where supported;
- the same context documents and records;
- the same 20% review budget;
- the same metric implementation.

The report must disclose token, call, runtime, and cost differences. Resource parity and resource efficiency are separate claims.

## Run protocol

1. Validate benchmark files.
2. Record the manifest and primary metric before execution.
3. Run the baseline on all cases.
4. Run the advanced system on all cases.
5. Compute metrics from immutable predictions and ground truth.
6. Write raw predictions, per-case results, aggregates, manifest, and trajectories.
7. Run three live-model repetitions when budget permits and report mean plus range.

## Required report fields

- Git revision
- Benchmark version
- Provider and model
- Prompt or algorithm version
- Seed
- Review budget
- Start and end time
- Runtime
- Token counts
- Estimated cost and pricing date
- Aggregate metrics
- Per-case metrics
- Missed affected records
- False positives
- Escalated records
- Incomplete or failed cases

## Git provenance phases

The evaluator records `manifest.git` after it writes managed evaluation files. `revision` and `baseRevision` name the clean source commit at generation time. The dirty booleans record that historical post-generation, pre-publication state: source files are clean, and managed evidence files are dirty. The validator derives `trackedWorkingTreeDirty` from the first descendant commit that publishes `artifacts/evaluation/manifest.json`. It is true when that publication changes any path that existed at `revision`, and false when every published path is new. Later evidence commits do not redefine this value. `packagingCommit` remains null because the evaluator cannot name a future commit.

The validator measures the current checkout as a separate state. At `HEAD === revision`, it compares the measured status with every recorded dirty boolean. At a later `HEAD`, it requires a clean tracked and untracked tree plus a linear evidence-only commit chain from `revision`. The chain must publish `artifacts/evaluation/manifest.json`, keep paths under managed evidence roots, and use regular-file modes. The validator checks the full current path set and every source or descendant tree for portable Git identities. It rejects forbidden or reserved path segments, non-NFC text, case-equivalent siblings, literal backslashes, and tracked entries with assume-unchanged, skip-worktree, or other nondefault flags. It also rejects merges, source paths, evidence-to-source moves, unsafe modes, and intermediate source changes even when a later commit restores the original bytes. Final validation keeps the clean-tree requirement.

## Integrity rules

- Never tune against hidden or designated holdout cases.
- Never remove a failed case from the aggregate.
- Never replace a live run with replay results without labeling it.
- Never round a result in a way that changes the comparison.
- Keep ground truth separate from prompts and production ranking code.
