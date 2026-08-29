import {
  assertNoCredentialValues,
  cloneJson,
  normalizeUsage,
} from "../providers/contracts.js";

export const TRACE_SCHEMA_VERSION = "rubricdelta-provider-trace-v1";
export const ZERO_USAGE = Object.freeze({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
export const FAILURE_REDACTION_FIELDS = Object.freeze(["error.message", "error.stack", "error.cause"]);

const ROLE_META = Object.freeze({
  "rule-compiler": { agent: "rule-compiler", phase: "rule-compilation" },
  "change-analyst": { agent: "change-analyst", phase: "change-analysis" },
  "impact-investigator": { agent: "impact-investigator", phase: "ranking" },
  "independent-verifier": { agent: "skeptical-verifier", phase: "verification" },
  "direct-baseline": { agent: "direct-baseline", phase: "direct-analysis" },
});

function nonblank(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validAttempts(attempts, count) {
  return Array.isArray(attempts)
    && attempts.length === count
    && attempts.every((item, index) => item
      && item.attempt === index + 1
      && typeof item.outcome === "string"
      && /^[a-z0-9-]{1,48}$/.test(item.outcome));
}

function emptyTelemetry() {
  return {
    responseId: null,
    model: null,
    usage: null,
    transportAttempts: 0,
    attempts: [],
    latencyMs: null,
    estimatedCostUsd: null,
  };
}

export function safeProviderTelemetry(value) {
  let telemetry;
  try {
    assertNoCredentialValues(value ?? {});
    if (!value || typeof value !== "object" || Array.isArray(value)) return emptyTelemetry();
    telemetry = cloneJson(value);
  } catch {
    return emptyTelemetry();
  }
  let usage = null;
  if (telemetry.usage !== null && telemetry.usage !== undefined) {
    try { usage = normalizeUsage(telemetry.usage); } catch { usage = null; }
  }
  const transportAttempts = Number.isInteger(telemetry.transportAttempts)
    && telemetry.transportAttempts >= 0
    && telemetry.transportAttempts <= 3
    && validAttempts(telemetry.attempts, telemetry.transportAttempts)
    ? telemetry.transportAttempts
    : 0;
  return {
    responseId: telemetry.responseId === null || (nonblank(telemetry.responseId) && telemetry.responseId.length <= 256)
      ? telemetry.responseId
      : null,
    model: telemetry.model === null || (nonblank(telemetry.model) && telemetry.model.length <= 256)
      ? telemetry.model
      : null,
    usage,
    transportAttempts,
    attempts: transportAttempts === telemetry.transportAttempts
      ? telemetry.attempts.map((item) => ({ attempt: item.attempt, outcome: item.outcome }))
      : [],
    latencyMs: telemetry.latencyMs === null || (Number.isFinite(telemetry.latencyMs) && telemetry.latencyMs >= 0)
      ? telemetry.latencyMs
      : null,
    estimatedCostUsd: telemetry.estimatedCostUsd === null
      || (Number.isFinite(telemetry.estimatedCostUsd) && telemetry.estimatedCostUsd >= 0)
      ? telemetry.estimatedCostUsd
      : null,
  };
}

export function createProviderTrace({ runId, scenarioId, provider, model, now }) {
  const events = [];
  let sequence = 0;
  return {
    record({
      role,
      type,
      prompt,
      inputRefs,
      status = "running",
      actualModel = null,
      responseId = null,
      usage = ZERO_USAGE,
      latencyMs = null,
      schemaRepairAttempt = 0,
      transportAttempts = 0,
      verification = "pending",
      terminalState = "running",
      redactionApplied = false,
      redactionFields = [],
      payload = {},
    }) {
      const meta = ROLE_META[role];
      sequence += 1;
      const event = {
        schemaVersion: TRACE_SCHEMA_VERSION,
        runId,
        sequence,
        timestamp: String(now()),
        scenarioId,
        agent: meta.agent,
        providerRole: role,
        phase: meta.phase,
        type,
        prompt: { id: prompt.id, version: prompt.version, sha256: prompt.sha256 },
        inputRefs: [...inputRefs],
        provider: { name: provider.name, requestedModel: model, actualModel, responseId },
        status,
        usage: usage === null ? null : { ...usage },
        latencyMs,
        redaction: { applied: redactionApplied, fields: [...redactionFields] },
        retry: { schemaRepairAttempt, transportAttempts },
        verification: { outcome: verification },
        terminalState,
        payload: cloneJson(payload),
      };
      assertNoCredentialValues(event);
      events.push(event);
      return cloneJson(event);
    },
    events() {
      return events.map((event) => cloneJson(event));
    },
  };
}

export function resourcesFromTrace(events) {
  const results = events.filter((event) => event.type === "provider-result");
  const resource = {
    providerCalls: results.length,
    providerAttempts: 0,
    usage: { ...ZERO_USAGE },
    latencyMs: 0,
    estimatedCostUsd: 0,
  };
  let usageKnown = true;
  let latencyKnown = true;
  let costKnown = true;
  for (const event of results) {
    resource.providerAttempts += event.retry.transportAttempts;
    if (event.usage) {
      resource.usage.inputTokens += event.usage.inputTokens;
      resource.usage.outputTokens += event.usage.outputTokens;
      resource.usage.totalTokens += event.usage.totalTokens;
    } else usageKnown = false;
    if (Number.isFinite(event.latencyMs)) resource.latencyMs += event.latencyMs;
    else latencyKnown = false;
    if (Number.isFinite(event.payload.estimatedCostUsd)) resource.estimatedCostUsd += event.payload.estimatedCostUsd;
    else costKnown = false;
  }
  if (!usageKnown) resource.usage = null;
  if (!latencyKnown) resource.latencyMs = null;
  if (!costKnown) resource.estimatedCostUsd = null;
  return resource;
}
