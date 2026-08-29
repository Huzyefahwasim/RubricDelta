import { decisionInternals } from "./decisions.js";

const EVENT_FIELDS = {
  decision: new Set(["type", "sequence", "timestamp", "recordId", "decision", "reviewer", "reason"]),
  undo: new Set(["type", "sequence", "timestamp", "recordId", "undoneSequence", "restoredDecision"]),
};

function fail(message) {
  throw new Error(`Invalid export: ${message}`);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function nonblank(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function assertEventShape(event, expectedFields) {
  if (!isPlainObject(event) || Object.getOwnPropertySymbols(event).length > 0) fail("decision event must be a plain object");
  const fields = Object.getOwnPropertyNames(event);
  if (fields.length !== expectedFields.size || fields.some((field) => !expectedFields.has(field))) fail("decision event has an unknown field");
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(event, field);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) fail("decision event has an unsafe field");
  }
}

function replayDecisions(events, candidateIds) {
  if (!Array.isArray(events)) fail("decisions must be an array");
  const stacks = new Map([...candidateIds].map((recordId) => [recordId, [{ decision: null, event: null }]]));
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event?.type === "decision") {
      assertEventShape(event, EVENT_FIELDS.decision);
      if (!Number.isInteger(event.sequence) || event.sequence !== index + 1 || !nonblank(event.timestamp) || !candidateIds.has(event.recordId)) fail("decision event is malformed");
      if (!decisionInternals.DECISIONS.has(event.decision) || !nonblank(event.reviewer) || (event.reason !== null && (!nonblank(event.reason) || event.reason.length > 1000))) fail("decision event is malformed");
      stacks.get(event.recordId).push({ decision: event.decision, event });
      continue;
    }
    if (event?.type === "undo") {
      assertEventShape(event, EVENT_FIELDS.undo);
      if (!Number.isInteger(event.sequence) || event.sequence !== index + 1 || !nonblank(event.timestamp) || !candidateIds.has(event.recordId)) fail("undo event is malformed");
      const stack = stacks.get(event.recordId);
      if (stack.length === 1) fail("undo event has no decision to undo");
      const undone = stack.at(-1);
      const restored = stack.at(-2);
      if (event.undoneSequence !== undone.event.sequence || event.restoredDecision !== restored.decision) fail("undo event does not restore the prior state");
      stack.pop();
      continue;
    }
    fail("decision event type is invalid");
  }
  return stacks;
}

export function csvCell(value) {
  const text = String(value ?? "");
  const trimmed = text.replace(/^\s+/, "");
  const safe = /^[=+\-@]/.test(trimmed) ? `'${trimmed}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function exportApprovedCSV(runState) {
  const allowed = new Set(["runId", "candidates", "decisions"]);
  if (!isPlainObject(runState) || Object.getOwnPropertySymbols(runState).length > 0 || Object.getOwnPropertyNames(runState).some((field) => !allowed.has(field))) fail("run state must contain only runId, candidates, and decisions");
  if (!nonblank(runState.runId) || !Array.isArray(runState.candidates)) fail("run state is malformed");
  const candidates = runState.candidates.map((candidate) => decisionInternals.validateCandidate(candidate, { allowComputedStatus: true }));
  const byId = new Map();
  for (const candidate of candidates) {
    if (byId.has(candidate.recordId)) fail(`duplicate candidate ${candidate.recordId}`);
    byId.set(candidate.recordId, candidate);
  }
  const states = replayDecisions(runState.decisions, new Set(byId.keys()));
  const rows = [["runId", "recordId", "proposedLabel", "reviewer", "reason", "decidedAt"]];
  for (const candidate of candidates) {
    const active = states.get(candidate.recordId).at(-1);
    if (active.decision !== "approve") continue;
    rows.push([runState.runId, candidate.recordId, candidate.proposedLabel, active.event.reviewer, active.event.reason, active.event.timestamp]);
  }
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}
