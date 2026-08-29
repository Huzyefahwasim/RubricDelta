# EXP-002: Unsupported cross-delta inference

This archive preserves the removed 19/20 experiment as data. It contains rankings and provenance from two isolated Git archives. The product cannot invoke the historical implementation through this archive.

## Result

The deterministic baseline scored 16/20 at both revisions. The advanced system scored 19/20 at `21e5cc4b2dc2d1612b50e479e9639c9f0279e79e` and 18/20 at `ba60a574ad3ec065039687651c808521ee420634`.

The 19/20 revision could award label-transition points when a record matched any old rule. The selected delta did not need to support that label transition. The hardened revision restricted those points to labels listed by the selected delta. RubricDelta removed the unsupported inference even though the benchmark score fell by one hit.

The after revision contains other validation work. This archive records the historical result. It does not present the one-commit comparison as an isolated causal ablation.

## Evidence boundary

- `before-predictions.json` and `after-predictions.json` store complete rankings for all ten cases. They contain no ground-truth fields.
- `comparison.json` records the current evaluator's scores and the two review queues that changed.
- `tests.json` records test totals observed under Node v24.19.0 in isolated Git archives.
- `manifest.json` binds the files, commits, and shared evaluator objects.

Each frozen case has ten records. The historical ceiling calculation and the current floor calculation both allocate two review slots at 20 percent. The current evaluator can therefore re-score these rankings without changing the historical result.

No file claims per-system runtime. The test observation omits archive execution durations because separate archive runs do not support a speed comparison.

## Verify

From the repository root, run:

```powershell
node scripts/verify-removed-experiment.js
node --test tests/removed-experiment.test.js
```

The verifier checks file hashes, prediction order and completeness, gold-field absence, exact score changes, protocol equivalence, and Git objects when the clone contains them.
