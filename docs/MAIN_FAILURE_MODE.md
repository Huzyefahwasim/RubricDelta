# Main Failure Mode: Evidence Gaps Across Renamed Categories

## Failure

RubricDelta can miss a policy change when the old rule and new rule describe the same operational boundary with different vocabulary. The deterministic change analyst requires an evidence-backed relationship between the two rules. It escalates when it cannot establish that relationship.

The frozen `assistive-technology-blocker` case exposes this limit. The old guideline routes interface defects to `Product Bugs`. The new guideline creates an `Accessibility` route for screen-reader and keyboard blockers. The compiler extracts no supported transition from the old category to the new category.

At the two-record review budget, the advanced system selected:

- `a11y-03`: “Please add a darker theme.”
- `a11y-07`: “Could you offer more profile colors?”

Both records are false positives. The system missed:

- `a11y-02`: an unlabeled checkout control that blocks a screen reader;
- `a11y-04`: a submit button that cannot be reached with the keyboard.

The evaluator records `0/2 = 0.00` affected-record recall and `0/2 = 0.00` precision for this case at the fixed 20% review budget. Across all ten cases, the deterministic advanced system records `18/20 = 0.90`, compared with the baseline's `16/20 = 0.80`. `artifacts/evaluation/comparison.json` contains every selected, missed, and false-positive record ID behind those values.

## Why the controller abstains

An earlier experiment gave transition credit across deltas without enough evidence. That behavior raised the benchmark result to `19/20 = 0.95`, but it could combine a target label from one delta with evidence from another. The current verifier binds each claim, citation, target label, and precedence check to one selected delta. The controller now escalates the unresolved accessibility transition instead of asserting it.

This safeguard prevents an unsupported label change from reaching export. It does not recover the missed records, so the failure remains visible in the official score.

## How often uncertainty appears

The committed deterministic trajectories contain 100 verifier outcomes:

| Scope | Support | Reject | Uncertain |
|---|---:|---:|---:|
| All 100 ranked records | 25 | 18 | 57 |
| Top 20 records inside the review budget | 16 | 2 | 2 |

All 10 case trajectories end with `status: partial` and `escalated: true`. Four cases recover a usable ranking after 8 retry events in total. These states describe evidence completeness. They do not represent human-approved corrections.

## Product impact

A reviewer who trusts rank alone could spend the full accessibility budget on appearance requests and miss both assistive-technology blockers. RubricDelta exposes the verifier verdict and requires a human decision before export, but review capacity has already been spent by that point.

## Mitigation boundary

The next evidence-safe experiment should add an explicit old-to-new category relation supplied by the policy document or a versioned label ontology. The agent may use that relation only when it cites both rule versions. The experiment must run against the same frozen cases, seed, provider, and review budget. It must not read ground truth during ranking.

The current implementation keeps the abstention because no tested approach establishes that relation without benchmark-specific knowledge.

This mitigation remains an experiment proposal. The submitted artifacts contain no result for an ontology-backed recovery.

## Evidence

- [Paired evaluation](../artifacts/evaluation/comparison.json)
- [Advanced raw predictions](../artifacts/evaluation/advanced-predictions.json)
- [Accessibility trajectory](../artifacts/evaluation/trajectories/assistive-technology-blocker.jsonl)
- [Same-delta and zero-overlap regressions](../tests/verifier-boundary.test.js)
- [Improvement changelog](../IMPROVEMENT_CHANGELOG.md)
