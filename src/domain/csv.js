import { decisionInternals } from "./decisions.js";

const EVENT_FIELDS = {
  decision: new Set(["type", "sequence", "timestamp", "recordId", "decision", "reviewer", "reason"]),
  undo: new Set(["type", "sequence", "timestamp", "recordId", "reviewer", "reason", "undoneSequence", "restoredDecision"]),
};
function fail(message) { throw new Error(`Invalid export: ${message}`); }
function plain(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function nonblank(value) { return typeof value === "string" && value.trim().length > 0; }
function exactObject(value, allowed, message) {
  if (!plain(value) || Object.getOwnPropertySymbols(value).length > 0) fail(message);
  const fields = Object.getOwnPropertyNames(value); if (fields.length !== allowed.size || fields.some((field) => !allowed.has(field))) fail(message);
  for (const field of fields) { const descriptor = Object.getOwnPropertyDescriptor(value, field); if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) fail(message); }
}
function replay(events, candidateIds) {
  const stacks = new Map([...candidateIds].map((id) => [id, [{ decision: null, event: null }]]));
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event?.type === "decision") {
      exactObject(event, EVENT_FIELDS.decision, "decision event is malformed");
      if (!Number.isInteger(event.sequence) || event.sequence !== index + 1 || !nonblank(event.timestamp) || !candidateIds.has(event.recordId) || !decisionInternals.DECISIONS.has(event.decision) || !nonblank(event.reviewer) || (event.reason !== null && (!nonblank(event.reason) || event.reason.length > 1000))) fail("decision event is malformed");
      stacks.get(event.recordId).push({ decision: event.decision, event }); continue;
    }
    if (event?.type === "undo") {
      exactObject(event, EVENT_FIELDS.undo, "undo event is malformed");
      if (!Number.isInteger(event.sequence) || event.sequence !== index + 1 || !nonblank(event.timestamp) || !candidateIds.has(event.recordId) || !nonblank(event.reviewer) || (event.reason !== null && (!nonblank(event.reason) || event.reason.length > 1000))) fail("undo event is malformed");
      const stack = stacks.get(event.recordId); if (stack.length === 1) fail("undo event has no decision to undo"); const undone = stack.at(-1); const restored = stack.at(-2);
      if (event.undoneSequence !== undone.event.sequence || event.restoredDecision !== restored.decision) fail("undo event does not restore the prior state"); stack.pop(); continue;
    }
    fail("decision event type is invalid");
  }
  return stacks;
}
export function csvCell(value) {
  const text = String(value ?? ""); const trimmed = text.replace(/^\s+/, ""); const safe = /^[=+\-@]/.test(trimmed) ? `'${trimmed}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
export function exportApprovedCSV(runState) {
  exactObject(runState, new Set(["runId", "ledger"]), "run state must contain a trusted ledger capability");
  if (!nonblank(runState.runId)) fail("run state is malformed"); const state = decisionInternals.trustedExportState(runState.ledger);
  if (!state) fail("run state must contain a trusted ledger capability");
  const candidates = state.candidates.map((candidate) => decisionInternals.validateCandidate(candidate, { allowComputedStatus: true })); const byId = new Map();
  for (const candidate of candidates) { if (byId.has(candidate.recordId)) fail(`duplicate candidate ${candidate.recordId}`); byId.set(candidate.recordId, candidate); }
  const states = replay(state.decisions, new Set(byId.keys())); const rows = [["runId", "recordId", "proposedLabel", "reviewer", "reason", "decidedAt"]];
  for (const candidate of candidates) { const active = states.get(candidate.recordId).at(-1); if (active.decision === "approve") rows.push([runState.runId, candidate.recordId, candidate.proposedLabel, active.event.reviewer, active.event.reason, active.event.timestamp]); }
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}
