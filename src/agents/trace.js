const SECRET_INDICATOR = /(authorization|api.?key|token|secret|password)/i;
const EVENT_KEYS = new Set(["agent", "phase", "type", "payload", "runId", "scenarioId", "sequence", "timestamp"]);
const TRACE_SCHEMA_VERSION = "rubricdelta-deterministic-trace-v2";
const ZERO_USAGE = Object.freeze({ inputTokens: 0, outputTokens: 0, totalTokens: 0, providerCalls: 0, providerAttempts: 0 });

function nonblank(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function redact(value, path, fields) {
  if (Array.isArray(value)) return value.map((child, index) => redact(child, `${path}[${index}]`, fields));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => {
    const childPath = path ? `${path}.${key}` : key;
    if (SECRET_INDICATOR.test(key)) {
      fields.push(childPath);
      return [key, "[REDACTED]"];
    }
    return [key, redact(child, childPath, fields)];
  }));
}

export function redactSecrets(value) {
  return redact(value, "", []);
}

function validateInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid trace event: event must be an object");
  for (const key of Object.keys(input)) if (!EVENT_KEYS.has(key)) throw new Error(`Invalid trace event: unknown field ${key}`);
  for (const key of ["agent", "phase", "type"]) if (!nonblank(input[key])) throw new Error(`Invalid trace event: ${key} is required`);
  if (!input.payload || typeof input.payload !== "object" || Array.isArray(input.payload)) throw new Error("Invalid trace event: payload must be an object");
  if (Object.hasOwn(input.payload, "durationMs")
    && (!Number.isFinite(input.payload.durationMs) || input.payload.durationMs < 0)) {
    throw new Error("Invalid trace event: payload.durationMs must be a non-negative finite number");
  }
}

function inputRefs(payload, scenarioId) {
  const refs = [{ kind: "scenario", id: scenarioId }];
  const seen = new Set();
  const add = (kind, value) => {
    if (!nonblank(value)) return;
    const key = `${kind}:${value}`;
    if (!seen.has(key)) {
      seen.add(key);
      refs.push({ kind, id: value });
    }
  };
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === "oldGuidelineVersion") add("old-guideline", child);
      else if (key === "newGuidelineVersion") add("new-guideline", child);
      else if (/guideline$/i.test(key) && nonblank(child?.version)) add("guideline", child.version);
      const match = key.match(/^(record|rule|delta)Ids?$/);
      if (match) {
        if (Array.isArray(child)) child.forEach((item) => add(match[1], item));
        else add(match[1], child);
      } else visit(child);
    }
  };
  visit(payload);
  return refs;
}

function humanDecision(type, payload) {
  if (!["human-decision", "human-undo"].includes(type)) return null;
  return {
    recordId: nonblank(payload.recordId) ? payload.recordId : null,
    decision: nonblank(payload.decision) ? payload.decision : null,
    evidenceVersion: nonblank(payload.evidenceVersion) ? payload.evidenceVersion : null,
    ledgerSequence: Number.isInteger(payload.sequence) && payload.sequence > 0 ? payload.sequence : null,
  };
}

function validateStored(event) {
  if (event.schemaVersion !== TRACE_SCHEMA_VERSION || !nonblank(event.runId) || !nonblank(event.scenarioId)
    || !Number.isInteger(event.sequence) || event.sequence < 1 || !nonblank(event.timestamp)
    || !nonblank(event.operation?.id) || !Array.isArray(event.inputRefs)
    || !event.result || typeof event.result !== "object" || Array.isArray(event.result)
    || !event.usage || Object.keys(event.usage).length !== 5
    || !event.redaction || typeof event.redaction.applied !== "boolean" || !Array.isArray(event.redaction.fields)) {
    throw new Error("Invalid trace event: normalized schema is invalid");
  }
}

export function createTraceRecorder({ runId, scenarioId, now = () => new Date().toISOString() } = {}) {
  if (!nonblank(runId) || !nonblank(scenarioId) || typeof now !== "function") {
    throw new Error("Invalid trace recorder: runId, scenarioId, and clock are required");
  }
  const stored = [];
  return {
    record(input) {
      validateInput(input);
      const fields = [];
      const payload = redact(input.payload, "payload", fields);
      const retryReason = ["retry", "validation-failure", "failed-stage", "escalation"].includes(input.type)
        ? (nonblank(payload.errorCode) ? payload.errorCode : null)
        : null;
      const feedbackReason = nonblank(payload.feedbackReason)
        ? payload.feedbackReason
        : nonblank(payload.counterargument) ? payload.counterargument : null;
      const event = {
        schemaVersion: TRACE_SCHEMA_VERSION,
        runId,
        scenarioId,
        sequence: stored.length + 1,
        timestamp: String(now()),
        agent: input.agent,
        phase: input.phase,
        type: input.type,
        operation: {
          id: `${input.agent}.${input.phase}`,
          eventType: input.type,
          instruction: input.type === "instruction" ? `${input.agent}.${input.phase}` : null,
          tool: input.type === "action-result" ? `${input.agent}.${input.phase}` : null,
        },
        inputRefs: inputRefs(payload, scenarioId),
        result: input.type === "instruction" ? {} : structuredClone(payload),
        retryReason,
        feedbackReason,
        durationMs: Number.isFinite(payload.durationMs) ? payload.durationMs : null,
        usage: { ...ZERO_USAGE },
        redaction: { applied: fields.length > 0, fields },
        humanDecision: humanDecision(input.type, payload),
        payload,
      };
      validateStored(event);
      stored.push(event);
      return structuredClone(event);
    },
    events() {
      return structuredClone(stored);
    },
    toJSONL() {
      return stored.map((event) => JSON.stringify(event)).join("\n");
    },
  };
}
