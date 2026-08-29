# Architecture

## System context

RubricDelta accepts two guideline versions and a labeled dataset. It produces a ranked review queue with citations, verifier findings, uncertainty, and human decisions. The application exports corrections only after approval.

```text
Browser
  |
  | HTTP/JSON
  v
Node server
  |
  +-- input validation
  +-- run controller
  +-- human decision gate
  |
  v
Agent orchestrator
  |
  +-- rule compiler
  +-- change analyst
  +-- impact investigator
  +-- skeptical verifier
  |
  +-- deterministic provider
  +-- optional OpenAI provider
  |
  v
Artifacts
  +-- recommendations.json
  +-- decisions.json
  +-- trajectory.jsonl
  +-- evaluation report
```

## Repository map

```text
public/                 browser application
src/agents/             agent roles and orchestration
src/domain/             rules, deltas, candidates, decisions
src/providers/          deterministic and OpenAI adapters
src/evaluation/         metrics and benchmark execution
src/server/             HTTP endpoints and static server
data/benchmark/         synthetic versioned fixtures
scripts/                stable run and validation commands
tests/                  deterministic Node tests
artifacts/              generated runs, reports, and trajectories
docs/                   implementation and submission evidence
```

## Core data contracts

### Rule

```json
{
  "id": "v2-r04",
  "label": "FRAUD",
  "priority": 90,
  "conditions": ["mentions stolen card"],
  "exceptions": [],
  "source": { "document": "guideline-v2", "section": "4.2", "quote": "..." }
}
```

### RuleDelta

```json
{
  "id": "delta-04",
  "type": "exception_added",
  "oldRuleIds": ["v1-r02"],
  "newRuleIds": ["v2-r04"],
  "scopeTerms": ["refund", "stolen card"],
  "precedenceChange": true,
  "ambiguity": "low",
  "evidence": []
}
```

### AffectedCandidate

```json
{
  "recordId": "ticket-018",
  "existingLabel": "BILLING",
  "proposedLabel": "FRAUD",
  "score": 0.91,
  "ruleDeltaIds": ["delta-04"],
  "evidence": [],
  "verifier": {
    "verdict": "supported",
    "counterargument": "The user does not confirm possession of the card.",
    "evidenceComplete": true
  },
  "status": "pending"
}
```

### TraceEvent

```json
{
  "runId": "run-20260829-001",
  "sequence": 12,
  "time": "2026-08-29T12:00:00.000Z",
  "agent": "skeptical-verifier",
  "phase": "verification",
  "type": "tool_result",
  "inputRefs": ["ticket-018", "delta-04"],
  "payload": {},
  "durationMs": 14,
  "usage": { "inputTokens": 0, "outputTokens": 0 },
  "redacted": false
}
```

## Trust boundaries

- The browser never receives provider credentials.
- The server treats uploaded files and model output as untrusted input.
- The provider adapter must return schema-valid objects.
- The verifier cannot approve corrections.
- Only the human decision service can change a recommendation from `pending` to `approved`.
- The exporter reads approved records from the decision service rather than trusting browser state.

## Failure behavior

- Malformed input produces field-level validation errors.
- A failed model call retries twice with bounded backoff.
- Invalid structured output triggers one repair attempt, then escalation.
- Missing citations force `evidenceComplete: false` and prevent confident approval suggestions.
- A verifier disagreement lowers confidence or escalates the record.
- An interrupted run preserves its partial trajectory and marks the manifest incomplete.
