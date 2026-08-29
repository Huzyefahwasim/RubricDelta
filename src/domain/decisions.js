const CANDIDATE_KEYS = new Set(["recordId", "existingLabel", "proposedLabel", "score", "scoreBreakdown", "ruleDeltaIds", "evidence", "status", "verifier"]);
const DECISION_KEYS = new Set(["recordId", "decision", "reviewer", "reason"]);
const DECISIONS = new Set(["approve", "reject", "escalate"]);
const MAX_REASON_LENGTH = 1000;
function fail(kind, message) { throw new Error(`Invalid ${kind}: ${message}`); }
function isPlainObject(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function assertPlainObject(value, allowed, kind) {
  if (!isPlainObject(value)) fail(kind, "must be a plain object");
  const names = Object.getOwnPropertyNames(value);
  if (Object.getOwnPropertySymbols(value).length > 0) fail(kind, "must not contain symbol fields");
  for (const key of names) { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value") || !allowed.has(key)) fail(kind, `has unknown field ${key}`); }
}
function assertSafeValue(value, kind) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) { for (const item of value) assertSafeValue(item, kind); return; }
  if (!isPlainObject(value)) fail(kind, "contains an unsafe value");
  if (Object.getOwnPropertySymbols(value).length > 0) fail(kind, "contains symbol fields");
  for (const key of Object.getOwnPropertyNames(value)) { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value") || key === "__proto__" || key === "constructor" || key === "prototype") fail(kind, `contains unsafe field ${key}`); assertSafeValue(descriptor.value, kind); }
}
function nonblank(value) { return typeof value === "string" && value.trim().length > 0; }
function validateCandidate(candidate, { allowComputedStatus = false } = {}) {
  assertPlainObject(candidate, CANDIDATE_KEYS, "candidate");
  if (!nonblank(candidate.recordId) || !nonblank(candidate.proposedLabel)) fail("candidate", "recordId and proposedLabel are required");
  if (Object.hasOwn(candidate, "existingLabel") && !nonblank(candidate.existingLabel)) fail("candidate", "existingLabel must be nonblank");
  if (Object.hasOwn(candidate, "score") && !Number.isFinite(candidate.score)) fail("candidate", "score must be finite");
  if (Object.hasOwn(candidate, "ruleDeltaIds") && (!Array.isArray(candidate.ruleDeltaIds) || !candidate.ruleDeltaIds.every(nonblank))) fail("candidate", "ruleDeltaIds must contain nonblank strings");
  if (Object.hasOwn(candidate, "status") && (!allowComputedStatus ? candidate.status !== "pending" : !["pending", "approved", "rejected", "escalated"].includes(candidate.status))) fail("candidate", "status is not allowed");
  assertSafeValue(candidate, "candidate"); return structuredClone(candidate);
}
function statusFor(decision) { return decision === null ? "pending" : { approve: "approved", reject: "rejected", escalate: "escalated" }[decision]; }
function validTime(value) { return nonblank(value) ? value : null; }
export function createDecisionLedger(candidates, options = {}) {
  if (!Array.isArray(candidates)) fail("candidate list", "must be an array");
  if (!isPlainObject(options) || Object.getOwnPropertyNames(options).some((key) => key !== "now")) fail("decision options", "must contain only now");
  const now = options.now ?? (() => new Date().toISOString());
  if (typeof now !== "function") fail("decision options", "now must be a function");
  const storedCandidates = candidates.map((candidate) => validateCandidate(candidate)); const stacks = new Map();
  for (const candidate of storedCandidates) { if (stacks.has(candidate.recordId)) fail("candidate", `duplicate recordId ${candidate.recordId}`); stacks.set(candidate.recordId, [{ decision: null, event: null }]); }
  const events = [];
  function time() { const value = now(); if (!validTime(value)) fail("decision", "now must return a nonblank timestamp"); return value; }
  function decide(command) {
    assertPlainObject(command, DECISION_KEYS, "decision");
    if (!nonblank(command.recordId) || !stacks.has(command.recordId)) fail("decision", "recordId is unknown");
    if (!DECISIONS.has(command.decision)) fail("decision", "decision is invalid");
    if (!nonblank(command.reviewer)) fail("decision", "reviewer is required");
    if (Object.hasOwn(command, "reason") && (!nonblank(command.reason) || command.reason.length > MAX_REASON_LENGTH)) fail("decision", "reason must be a nonblank string of at most 1000 characters");
    const event = { type: "decision", sequence: events.length + 1, timestamp: time(), recordId: command.recordId, decision: command.decision, reviewer: command.reviewer.trim(), reason: command.reason?.trim() ?? null };
    events.push(event); stacks.get(command.recordId).push({ decision: command.decision, event }); return structuredClone(event);
  }
  function undo(recordId) {
    if (!nonblank(recordId) || !stacks.has(recordId)) fail("decision", "recordId is unknown");
    const stack = stacks.get(recordId); if (stack.length === 1) fail("decision", "record has no decision to undo");
    const undone = stack.pop(); const restored = stack.at(-1);
    const event = { type: "undo", sequence: events.length + 1, timestamp: time(), recordId, undoneSequence: undone.event.sequence, restoredDecision: restored.decision };
    events.push(event); return structuredClone(event);
  }
  function currentCandidates() { return storedCandidates.map((candidate) => ({ ...structuredClone(candidate), status: statusFor(stacks.get(candidate.recordId).at(-1).decision) })); }
  return { decide, undo, candidates: currentCandidates, events: () => structuredClone(events) };
}
export const decisionInternals = { validateCandidate, statusFor, DECISIONS };
