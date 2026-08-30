# Hot Take: Evidence Support Outranks One Benchmark Point

## Claim

Teams should remove an unsupported inference even when a benchmark score falls.

An archived deterministic advanced revision found `19/20` affected records at the fixed 20% review budget. Review found that the investigator could receive transition credit from one rule delta while the verifier used evidence from another. The score rewarded a relationship that the policy analysis could not support.

The team removed that cross-delta credit and added two regression boundaries:

- the verifier must bind its citation, target label, and precedence evidence to one selected delta;
- zero-overlap rules must escalate and abstain instead of producing a fabricated delta.

The official advanced result fell from `19/20 = 0.95` to `18/20 = 0.90`. The baseline stayed at `16/20 = 0.80`. Cases, affected records, seed, deterministic provider, and review-budget formula stayed fixed.

## Engineering basis

The current behavior exposes its failure. It misses both affected records in the accessibility case and records the case as partial and escalated. The prior behavior attached a higher recall number to evidence from the wrong delta.

The regression tests reject cross-delta evidence and require an abstention when the analyzer cannot connect old and new rules. A human decides whether any recommendation enters an export. Reviewers can trace the remaining recommendations to one selected delta, even though the benchmark records one extra miss.

## Limits of the claim

This result comes from one frozen, 100-record synthetic benchmark and a deterministic provider. It supports one narrow claim: this score decrease followed the removal of a tested unsupported inference. It cannot establish a general relationship between lower scores and system quality.

RubricDelta can regain the lost point only through a new evidence source, such as a cited category migration or versioned label ontology. A benchmark-specific exception would contradict the claim.

No live OpenAI run supports this conclusion. Replay results reproduce fixed calls and cannot measure model quality.

## Evidence

- [Official paired comparison](../artifacts/evaluation/comparison.json)
- [Accessibility failure details](MAIN_FAILURE_MODE.md)
- [Verifier boundary regressions](../tests/verifier-boundary.test.js)
- [Evaluation contract](EVALUATION.md)
- [Experiment record](../IMPROVEMENT_CHANGELOG.md)
