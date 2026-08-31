# RubricDelta provider evaluation

- Benchmark: rubricdelta-support-guideline-drift-v1
- Provider/model: replay / deterministic-role-capture-v1
- Repetitions: 1
- Replay substitution: false

## Primary metric

- baseline: mean 0.80 (min 0.80, max 0.80)
- advanced: mean 0.90 (min 0.90, max 0.90)

Every repetition is stored before scoring. Provider failures receive zero credit and are never replaced.
