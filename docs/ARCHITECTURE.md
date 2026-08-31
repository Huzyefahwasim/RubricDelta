# Architecture

## System context

RubricDelta accepts two guideline versions and a labeled JSON scenario. It produces a ranked review queue with citations, verifier findings, uncertainty, and decision state. The local browser server runs the deterministic workflow. It exports rows only when the server-owned decision ledger has an active `approve` event.

```text
Browser workbench
  |
  | loopback HTTP/JSON
  v
Node demo server
  +-- loopback host and origin guard
  +-- bounded JSON validation
  +-- deterministic run controller
  +-- append-only decision ledger
  +-- active-approval CSV export
  |
  v
Deterministic agent orchestrator
  +-- rule compiler
  +-- change analyst
  +-- impact investigator
  +-- skeptical verifier
  |
  v
Server run artifacts under the configured artifact root

Evaluation CLI
  +-- deterministic default, synchronous and network-free
  +-- replay, explicit exact fixture
  +-- OpenAI, explicit model and process key
  |
  v
Raw predictions, per-case scores, manifests, and trajectories
```

Replay and OpenAI are evaluation-CLI providers. The browser server does not read an environment provider flag, call the OpenAI adapter, or relabel a deterministic run as provider evidence.

## Repository map

```text
public/                 browser application
src/agents/             deterministic and async provider orchestration
src/domain/             rules, deltas, candidates, decisions, and CSV export
src/providers/          replay and OpenAI provider contracts and adapters
src/evaluation/         metrics, benchmark execution, and provider predictions
src/server/             loopback HTTP transport, host and origin guard, and static server
data/benchmark/         synthetic benchmark and exact replay fixture
prompts/                versioned provider role instructions
scripts/                evaluation, evidence, replay, and validation commands
tests/                  deterministic Node test suite
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
  "scenarioId": "case-001",
  "sequence": 12,
  "timestamp": "2026-08-29T12:00:00.000Z",
  "agent": "skeptical-verifier",
  "phase": "verification",
  "type": "action-result",
  "payload": {}
}
```

Deterministic traces use `action-result` for action outputs. Provider traces use `provider-result` and add prompt ID, prompt version, prompt hash, model, call and retry data, usage, latency, redaction state, and terminal state. Each trace keeps its schema identity explicit.

## Trust boundaries

- The demo server answers only its own bound loopback authority. It refuses a foreign or rebound `Host`, a mismatched port, and a cross-site `Origin` before routing, and never reads forwarding headers.
- The demo server accepts bounded JSON scenarios, not file uploads or CSV input.
- The browser never receives provider credentials.
- The browser server uses the deterministic orchestrator; only the evaluation CLI can select replay or OpenAI.
- Provider inputs contain public scenario fields and exclude benchmark ground truth, expected labels, rationales, and review outcomes.
- Provider adapters must return schema-valid objects with resolving record, rule, delta, and citation references.
- The skeptical verifier cannot approve a correction.
- The server-owned ledger derives decision state; browser status fields cannot authorize an export.
- The decision endpoint accepts a self-asserted reviewer string and provides no authentication. A ledger event does not prove reviewer identity or human participation.
- The artifact store contains server-run writes under its configured root. The evaluation CLI operator chooses its output directory.

## Failure behavior

- A request whose `Host` or `Origin` falls outside the bound loopback authority is refused with `400` or `403` before path resolution, routing, mutation, and export.
- Malformed or oversized JSON produces bounded field-level errors without stack or credential disclosure.
- The deterministic workflow retries eligible failed analysis stages within its fixed budget and preserves retry events.
- The OpenAI adapter bounds request and response bytes and retries eligible transport failures within its transport budget.
- Invalid provider output uses bounded schema-repair calls; exhausted repair produces a failed case.
- Replay rejects fixture, source, prompt, request-order, model, mode, and call-count mismatches.
- Replay or OpenAI failure never invokes a deterministic substitute.
- Missing citations or unresolved rule relations preserve uncertainty and escalation.
- Failed provider cases keep empty rankings, explicit failure status, and zero score instead of disappearing from the aggregate.

## Deployment limit

The submitted server binds to loopback and has no accounts, sessions, reviewer authorization, encryption-at-rest policy, retention automation, or external-platform write-back. A production deployment must add those controls before it accepts private or consequential data.
