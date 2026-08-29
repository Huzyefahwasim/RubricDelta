# Agent System

## Orchestrator

The orchestrator owns the run state, stage order, retry budget, provider selection, and trajectory writer. It passes structured objects between stages and rejects outputs that fail schema checks.

## Roles

### Rule compiler

Purpose: turn each guideline into atomic rules with stable IDs, conditions, exceptions, priority, labels, and source citations.

Allowed tools:

- document section reader;
- rule schema validator;
- citation locator.

Failure condition: a rule lacks a label, condition, or source reference.

### Change analyst

Purpose: pair related old and new rules, classify the semantic change, identify precedence changes, and generate boundary hypotheses.

Allowed tools:

- rule-set search;
- rule comparator;
- boundary-case generator.

Failure condition: a claimed change has no supporting old and new rule IDs.

### Impact investigator

Purpose: retrieve and rank existing records that match the changed rule scope.

Allowed tools:

- record search;
- structured rule evaluator;
- candidate ranker.

Failure condition: a recommendation lacks a record ID, delta ID, or proposed label.

### Skeptical verifier

Purpose: find counterarguments, test rule precedence, check citations, and decide whether the evidence supports, contradicts, or leaves the claim ambiguous.

Allowed tools:

- rule lookup;
- record lookup;
- precedence checker;
- evidence validator.

The verifier cannot approve an export.

## Retry policy

- Each stage receives two retries.
- Schema failure uses a repair instruction that names the invalid fields.
- Tool failure retries only idempotent reads.
- Contradictory evidence routes the record to escalation.
- Exhausted retries produce a failed stage event and a partial, reproducible run.

## Human checkpoint

Each recommendation starts as `pending`. A reviewer can:

- `approve`: include the proposed correction in the export;
- `reject`: preserve the existing label;
- `escalate`: send the record to a policy owner without changing its label.

The server records reviewer action, time, record ID, evidence version, and optional note. Undo creates a new event rather than deleting history.

## Trajectory requirements

Store newline-delimited JSON. Each event contains:

- run and sequence IDs;
- timestamp;
- agent and phase;
- instruction or tool name;
- structured input references;
- structured result;
- retry or feedback reason;
- duration and usage;
- redaction state;
- linked human decision where applicable.

Submission trajectories must include at least one successful case, one verifier challenge, one retry, one escalation, and one human approval.

## Development-agent disclosure

Record material use of Codex or other coding agents in the Improvement Changelog. Include a representative development trajectory or concise task log that shows planning, implementation, review, and verification. Do not claim human-only authorship.
