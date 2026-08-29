# Expected replay reference

This post-Task-8 file records the deterministic default's exact reference result. Replay was not selected for this reference, so `replayOperational` is false. The separate explicit `npm run eval:replay` workflow is operational and must reproduce the same bound predictions without claiming a live OpenAI run.

- Baseline: 16/20 = 0.80
- Advanced: 18/20 = 0.90
- Absolute improvement: +0.10

The JSON file binds the reference to hashes of the raw gold-free predictions, not volatile Git or timing metadata.
