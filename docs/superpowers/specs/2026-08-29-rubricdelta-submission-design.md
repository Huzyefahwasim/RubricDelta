# RubricDelta Submission Design

**Status:** Approved for implementation by the project owner on 2026-08-29.

## Objective

RubricDelta helps an annotation operations lead find existing labels that a guideline revision may have made stale. It ranks the records worth reviewing, ties each recommendation to exact policy evidence, asks an independent verifier to challenge the conclusion, and exports only corrections that a human approved.

The hackathon submission must prove the workflow against a fixed baseline on the same cases and review budget. The system must expose its instructions, tool calls, intermediate state, retries, verifier disagreements, and human checkpoints.

## User and job

The primary user manages a labeled dataset after a policy owner publishes a new guideline version. The user can inspect only 20 percent of the records. The product answers one question: which records should the user inspect first?

The included domain is synthetic customer-support ticket routing. RubricDelta does not evaluate workers, make employment decisions, or write to an external labeling platform.

## Product boundary

### In scope

- Compare guideline versions as semantic rules, exceptions, labels, and precedence.
- Generate boundary hypotheses for each meaningful change.
- Rank existing records by the likelihood that the new guideline changes their correct label.
- Verify each selected candidate against the source rules.
- Escalate ambiguous or unsupported candidates.
- Capture append-only trajectories and resource use.
- Let a human approve, reject, or escalate each candidate.
- Export approved changes with an evidence manifest.
- Run a deterministic offline benchmark and replay without credentials.
- Support an optional live OpenAI Responses API provider with structured output.

### Out of scope

- Automatic modification of production datasets.
- Worker quality scoring or personnel decisions.
- Private or customer data in the included benchmark.
- Arbitrary shell, network, or filesystem tools for project agents.
- Vector databases, external databases, Docker, or a cloud deployment requirement.
- A general-purpose guideline editor or labeling platform.

## Evaluation contract

The frozen benchmark contains 10 revisions, 100 synthetic records, and 20 affected records. Each case contains 10 records and exactly two review slots.

The primary metric is micro-averaged affected-record recall at a 20 percent review budget:

```text
selected = first floor(record_count * 0.20) ranked records
recall@20% = affected selected records / all affected records
```

The evaluator also reports precision, F1, per-case results, false positives, missed records, runtime, provider calls, token use, and cost when available.

The baseline and final system must share the benchmark version, provider, pinned live model, public inputs, output contract, seed where supported, review budget, and scoring code.

The deterministic lexical baseline remains the offline reference. The live report will use a direct one-request baseline and the final agent workflow with the same model and declared resource caps. Replay results must carry a replay label and cannot stand in for a fresh live result.

Production ranking code must never read gold affected-record IDs or expected labels. Only the evaluator may load those fields after predictions have been finalized.

## Architecture

Use Node.js 24 or newer, ECMAScript modules, the built-in HTTP server, built-in test runner, and browser-native HTML, CSS, and JavaScript. The offline path has no runtime package dependencies.

```text
browser workbench
       |
       v
HTTP controller and input validation
       |
       v
deterministic workflow controller
       |
       +-- Policy Analyst
       |     compile rules -> compare versions -> boundary hypotheses
       |
       +-- Impact Investigator
       |     retrieve records -> rank candidates -> explain evidence
       |
       +-- Independent Verifier
             validate citations -> test precedence -> support/reject/abstain
       |
       v
human decision gate -> guarded CSV and JSON export
       |
       v
immutable run artifacts and JSONL trajectory
```

The workflow controller is deterministic code. It owns the phase order, run state, retry budget, resource budget, artifact paths, and schema checks. Language models perform bounded reasoning roles; they do not control the process or receive benchmark gold data.

## Domain contracts

`PolicyRule` contains a stable ID, version, outcome label, priority, all/any/none predicates, exception IDs, a source citation, confidence, and unresolved questions.

`RuleDelta` contains old and new rule IDs, a change kind, scope terms, boundary cases, a precedence flag, and citations.

`CandidateAssessment` contains the record ID, existing and proposed labels, score, delta IDs, evidence, explanation, and proposed or abstain status.

`Verification` contains support, reject, or uncertain verdict, citation status, conflicts, counterargument, and proposed label.

`HumanDecision` contains record ID, approve/reject/escalate decision, reviewer, reason, and timestamp.

## Agent roles and tools

### Policy Analyst

The Policy Analyst compiles both guideline versions into atomic rules, pairs related rules, classifies semantic changes, and records boundary hypotheses. It may call only guideline span lookup, rule submission, rule comparison, and unknown reporting tools. Every rule and delta needs source evidence.

### Impact Investigator

The Impact Investigator receives public records and the delta ledger. It may search records, read one record, read one delta, evaluate deterministic rule predicates, and submit a candidate. It must cite the record and changed rules. It never sees gold labels.

### Independent Verifier

The verifier receives the raw evidence and proposed conclusion without the investigator's confidence score. It checks citations, precedence, exceptions, and alternative interpretations. It returns support, reject, or uncertain. Uncertain records enter the human escalation queue.

Each role receives two schema-repair attempts. The provider receives at most three retries for transient errors. A verifier disagreement permits one investigator reconsideration. Further disagreement produces an abstention.

## Provider modes

### Deterministic

The deterministic provider implements the complete workflow with transparent parsing and ranking rules. Judges can run it without credentials. It produces real trajectories, decisions, reports, and exports.

### Replay

Replay loads committed, sanitized role responses and preserves the original run manifest. The interface labels every replay result. Replay enables stable demonstration of a verifier challenge, retry, abstention, and human checkpoint.

### OpenAI

The server calls `POST https://api.openai.com/v1/responses` with a server-side key, pinned model, `store: false`, and strict JSON Schema output. The browser never receives the key. The adapter records model ID, response ID, token use, latency, and status while excluding credentials and hidden reasoning.

## Human review and export

Candidates begin as `pending`. A reviewer can approve, reject, escalate, or undo a prior decision. Undo appends a new event rather than removing history.

The exporter reads server-owned decisions and emits only approved changes. It neutralizes CSV fields that begin with `=`, `+`, `-`, or `@` to prevent spreadsheet formula execution. The export includes input hashes, run ID, reviewer, evidence references, and decision time.

## Interface design

The interface opens in the working product. The visual direction is a policy-forensics workbench: warm paper, near-black framing, amber change markers, teal approvals, square panels, condensed headings, and monospaced evidence labels.

The signature visual is the Rule Seam. A vertical amber rail connects a changed old clause, its new clause, the structured delta, and every candidate it affects.

The five views are Intake, Rule Deltas, Impact Queue, Evaluation, and Trajectory Inspector. The interface supports keyboard review with A, R, E, J, and K; one `h1`; semantic landmarks; visible focus; `aria-live` status; 44-pixel controls; reduced motion; and table equivalents for charts. No state depends on color alone.

## HTTP surface

```text
GET  /api/health
GET  /api/demo
POST /api/runs
GET  /api/runs/:runId
POST /api/runs/:runId/decisions
POST /api/runs/:runId/undo
GET  /api/runs/:runId/export.csv
GET  /api/runs/:runId/trajectory.jsonl
GET  /api/evaluation
```

Request bodies have a 1 MiB limit. The server accepts JSON for the included product flow. Uploaded filenames, paths, guideline text, record text, and provider output remain untrusted data.

## Artifacts and trajectories

Each run writes a manifest, sanitized input, state, recommendations, decisions, JSONL trajectory, and approved changes under `artifacts/runs/<run-id>/`.

The trajectory uses append-only events with schema version, run ID, sequence, timestamp, scenario, role, phase, type, input references, payload, status, latency, usage, model, and prompt version. Secret redaction runs before writing.

Representative committed trajectories must show one successful run, schema retry, verifier disagreement, abstention, and human checkpoint. The project must not fabricate failures; deterministic fixtures trigger the documented branches.

## Error handling

- Malformed benchmark or input returns a field-level 400 response.
- Duplicate or unknown record IDs fail before an agent run.
- Missing citations lower evidence completeness and prevent supported verification.
- Exhausted provider retries mark the run incomplete and preserve partial artifacts.
- Path traversal returns 404 without revealing filesystem paths.
- A failed export never changes decisions or source data.
- The UI shows the failed phase and recovery action without losing the loaded example.

## Security properties

- Project agents cannot access shell, arbitrary files, or arbitrary networks.
- Record and guideline contents remain data, not executable instructions.
- The server keeps credentials out of responses, logs, traces, and artifacts.
- Static and artifact paths stay inside resolved roots.
- The server sets CSP, `nosniff`, referrer, frame, and permissions headers.
- The application uses synthetic data and makes no high-impact decision.
- Every consequential correction requires human approval.

## Required commands

```text
npm start
npm test
npm run eval:baseline
npm run eval:advanced
npm run eval
npm run validate
```

The commands must run from a clean checkout with Node.js 24 or newer. Offline tests and evaluation require no network or API key.

## Acceptance criteria

- At least 10 fixed cases produce complete per-case baseline and final reports.
- Production workflows cannot read benchmark gold fields.
- The final system emits evidence for each selected candidate and abstains when evidence fails.
- Tests prove unapproved records cannot enter exports.
- A judge can load the example, inspect a Rule Seam, make three decision types, view paired evaluation, and inspect a trajectory.
- The interface works at 375, 768, and 1440 CSS pixels and passes keyboard navigation checks.
- All documented commands exist and return accurate status.
- A clean reproduction run creates artifacts without credentials.
- The repository includes code, instructions, changelog, failure mode, hot take, reproduction guide, video script, and representative trajectories.
- A Codex Security scan has no unresolved critical or high-severity findings before the final push.

## Main failure mode and supported insight

The main failure mode is lexical over-selection: a record repeats changed-rule terms without satisfying the changed condition. The verifier, precedence checker, and boundary hypotheses reduce this error; the evaluation must report any cases that remain.

The project will test this claim: high reviewer agreement can coexist with shared guideline drift, so teams need policy-version impact analysis in addition to agreement metrics.
