# Five-Minute Demo Script

Target length: 4 minutes 40 seconds. Stop at 4:40, which leaves 20 seconds below the limit.

Record this script after the automated, human-review, development-agent, browser, accessibility, security, and clean-checkout evidence exists at one final source revision. The participant performs the review actions and recording. After the video and participant attestations exist, `artifacts/qa/release.json` becomes the completion authority. This script does not prove that recording, upload, playback, or release approval occurred.

## 0:00 to 0:20: User and problem

Introduce the annotation operations lead who can inspect 20% of the existing labels after a guideline revision. State the benchmark scope: 100 synthetic support-ticket records across ten cases. Explain that the browser workbench opens one ten-record case for the review workflow while the evaluation covers all 100 records.

## 0:20 to 0:45: Simple baseline

Open the committed `artifacts/evaluation/report.md`. Show the lexical baseline result, `16/20 = 0.80` affected-record recall, and one miss from the hard precedence case. If the recording needs a live baseline run, use `node scripts/evaluate.js --mode baseline --output-dir artifacts/runs/demo-baseline`; the ignored disposable directory keeps baseline-mode pruning away from the canonical release evidence. Do not run `npm run eval:baseline` after release evidence exists, and do not imply that the browser has a separate baseline-run button.

## 0:45 to 1:10: Fair comparison

Show that baseline and advanced results use the same ten cases, ordered records, deterministic provider, null model, seed 0, and two review slots per case. Point to the fixed 20% budget before showing the advanced score.

## 1:10 to 2:05: Realistic analysis run

Choose **Load benchmark example**. The browser sends the first public ten-record case to the local deterministic server and creates a server-owned run. Open the Rule Seam and connect the changed clause to its structured interpretation, citations, boundary case, and ranked records.

## 2:05 to 3:10: Participant review and guarded export

The participant enters the public reviewer attribution, then uses two records:

- approve a supported correction on the first record and leave that approval active;
- escalate the second record, undo that decision, then reject the same record.

Open the trajectory and show the appended checkpoint events. Download the CSV and show its one active approval. The server excludes all other decision states from the export.

## 3:10 to 3:50: Results and visible failure

Compare `16/20 = 0.80` baseline recall with `18/20 = 0.90` advanced recall on the same frozen benchmark. Scroll to the accessibility evaluation row, where the advanced system finds `0/2`, and disclose that the deterministic trajectories end partial and escalated. Show recorded runtime and cost fields without making a speed or live-model claim.

## 3:50 to 4:20: Improvement evidence

Open the Improvement Changelog. Describe the four-stage system as the `largest supported measured system bundle` against the lexical baseline. State that the bundle comparison provides no stage-level causal attribution because no isolated stage ablation exists. Show the removed cross-delta inference experiment, its `19/20` to `18/20` score change, and the evidence defect that justified removal.

## 4:20 to 4:40: Reproduction and hot take

Show `npm run eval`, the run manifest, and one JSONL trajectory. Close with the supported conclusion: reviewer agreement can coexist with shared guideline drift, so review leads need policy-version impact analysis.

## Recording checklist

- Use readable zoom and 1080p capture.
- Record the participant's real review actions; do not present the generated checkpoint as human QA.
- Label replay evidence as deterministic-source replay and do not present it as a live model run.
- Remove terminal and browser wait time without hiding failures.
- Measure the encoded file and keep it at or below 300 seconds.
- Record upload acceptance and a rendered playback frame only after the participant observes both on the submission platform.
