# Evaluation Protocol v3

RubricDelta names its current scoring contract `rubricdelta-evaluation-v3`. It supersedes [protocol v2](EVALUATION_PROTOCOL_V2.md) for new evidence. Protocol v2 remains the historical contract for its recorded run.

## Frozen primary contract

V3 retains the v2 benchmark case IDs, ground truth, 20% floor-based review budget, primary metric, deterministic baseline algorithm and prompt, ranking behavior, provider-comparison rules, and deterministic evaluator seed `0`. The deterministic benchmark results remain baseline `16/20 = 0.80` and advanced `18/20 = 0.90` affected-record recall.

```text
review slots = max(1, floor(recordCount * reviewBudgetFraction))
selected = the first review slots in the submitted ranking
primary recall = selected affected records / all affected records
```

The evaluator micro-averages primary recall across every benchmark case. Predictors receive public scenarios only; ground truth remains outside prompts and ranking code.

## Secondary diagnostics

The evaluator rounds rates and reciprocal-rank values to six decimal places using half-up decimal rounding.

`reciprocalRankFirstAffected` is `1 / rank` for the first affected record in the complete submitted ranking and `0` when the ranking contains no affected record. `meanReciprocalRankFirstAffected` is the arithmetic mean of those per-case values across every benchmark case, including failed and missing cases.

The unsupported-claim denominator is the number of selected review claims, not all ranked records. A zero denominator produces `0`.

- The baseline uses `matched-terms-v1`: a selected claim has structural support only when it has a nonempty `matchedTerms` array.
- The advanced system uses `verifier-support-v1`: a selected claim has structural support only when its verifier verdict is `support`, `evidenceComplete` is true, `precedenceChecked` is true, record evidence names that record, and a changed-rule citation names one of the claim's delta IDs.

Malformed or missing support fields count as unsupported. These are system-native structural diagnostics, so unsupported-claim rates are not comparable across baseline and advanced support contracts.

The advanced escalation numerator counts selected claims whose verifier verdict is `uncertain`; its denominator is selected review claims. Baseline escalation reports `applicable: false` and `mechanism: "not-applicable"`. Advanced escalation reports `applicable: true` and `mechanism: "verifier-uncertain"`.

Output completeness is separate from evidence uncertainty. A missing prediction or a case with `status: "failed"` is failed; a partial ranking, absent ranking record, or malformed selected support is incomplete or partial. A verifier's `uncertain` verdict is an escalation and does not by itself make the case failed.

For the frozen deterministic run, baseline diagnostics are MRR `1.000000` and unsupported-claim rate `1/20 = 0.050000`. Advanced diagnostics are MRR `0.920000`, unsupported-claim rate `4/20 = 0.200000`, and escalation rate `2/20 = 0.100000`.

## Resources, failures, and comparison manifests

Each case records `providerCalls`, `providerAttempts`, `inputTokens`, `outputTokens`, `totalTokens`, `providerLatencyMs`, `runtimeMs`, and `estimatedCostUsd`. `providerLatencyMs` measures provider-call latency; `runtimeMs` measures whole-case runtime. A known deterministic value is exactly zero for calls, attempts, tokens, provider latency, and cost; deterministic runtime remains `null`. A provider or replay value is derived from its trace. Unknown values are `null`.

Aggregates recompute values from durable per-case resources. They do not trust mutable metadata. An aggregate is `null` when any included per-case value is unknown, and writers validate metadata against that recomputation.

Paired reports retain raw predictions, per-case metrics and diagnostics, resources, incomplete cases, and failed cases. They report primary metrics and secondary diagnostics together without presenting structural-support rates as cross-system comparisons.

The deterministic evaluator uses seed `0`. OpenAI uses `null` because no seed is sent. Replay uses `null` because it replays a fixed capture and applies no seed. The fair-comparison manifest records the same seed value as the provider manifest.

## Deterministic trace v2

Deterministic trajectory events use schema `rubricdelta-deterministic-trace-v2`. Each event contains a stable operation identity, scenario reference, old and new guideline-version references when those versions enter a stage, and record, rule, and delta references when present. Events also record a structured result where the event has a result, retry and feedback reasons, a finite nonnegative duration or `null`, exact-zero offline usage, redaction state, and nullable human-decision linkage.

The browser server owns human decision and undo events in its separate append-only ledger. Those server events link `evidenceVersion` to the evidence they review; the deterministic trace's nullable linkage does not replace the server ledger.
