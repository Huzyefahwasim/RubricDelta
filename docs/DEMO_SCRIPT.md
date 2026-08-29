# Five-Minute Demo Script

Target length: 4 minutes 45 seconds. Leave 15 seconds for transitions.

## 0:00 to 0:25: User and problem

Show 250 existing support-ticket labels. Explain that one guideline exception changed and the review lead can inspect only 20% of the dataset.

## 0:25 to 0:55: Fair comparison

Load the included benchmark. Show the two guideline versions, record count, model or provider, fixed seed, and declared 20% review budget.

## 0:55 to 1:25: Baseline

Run the direct baseline. Open the hard precedence case and show which affected records it missed.

## 1:25 to 2:20: Agent run

Run RubricDelta. Open the Rule Seam and connect the changed clause to its structured interpretation, boundary case, and affected records.

## 2:20 to 3:20: Human review

Review three records:

- approve one supported correction;
- reject one false positive;
- escalate one ambiguous record.

Show that each action creates a human-checkpoint event and that the exporter excludes pending records.

## 3:20 to 4:05: Results

Compare baseline and advanced results on the same cases. Lead with recall at the fixed review budget. Show one failure rather than hiding it. Mention runtime and cost.

## 4:05 to 4:35: Improvement evidence

Open the Improvement Changelog. Identify the change that contributed the largest measured gain. Show one experiment that the team removed and the evidence behind the decision.

## 4:35 to 4:55: Reproduction and insight

Open the run manifest and trajectory. Show the exact evaluation command. State the supported conclusion: high reviewer agreement can coexist with shared guideline drift, so review teams need policy-version impact analysis.

## Recording checklist

- Use readable zoom and 1080p capture.
- Keep the pointer still while speaking.
- Remove dead time from model calls or label replay footage.
- Show the complete realistic workflow.
- Keep the final file below five minutes.
