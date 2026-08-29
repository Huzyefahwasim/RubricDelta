const SECRET_INDICATOR = /(authorization|api.?key|token|secret|password)/i;
const EVENT_KEYS = new Set(["agent", "phase", "type", "payload", "runId", "scenarioId", "sequence", "timestamp"]);
export function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, SECRET_INDICATOR.test(key) ? "[REDACTED]" : redactSecrets(child)]));
}
function validateEvent(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid trace event: event must be an object");
  for (const key of Object.keys(input)) if (!EVENT_KEYS.has(key)) throw new Error(`Invalid trace event: unknown field ${key}`);
  for (const key of ["agent", "phase", "type"]) if (typeof input[key] !== "string" || input[key].trim() === "") throw new Error(`Invalid trace event: ${key} is required`);
  if (!input.payload || typeof input.payload !== "object" || Array.isArray(input.payload)) throw new Error("Invalid trace event: payload must be an object");
}
export function createTraceRecorder({ runId, scenarioId, now = () => new Date().toISOString() } = {}) {
  const stored = [];
  return { record(input) { validateEvent(input); const { agent, phase, type, payload } = input; const event = redactSecrets({ runId, scenarioId, sequence: stored.length + 1, timestamp: now(), agent, phase, type, payload }); stored.push(event); return structuredClone(event); }, events() { return structuredClone(stored); }, toJSONL() { return stored.map((event) => JSON.stringify(event)).join("\n"); } };
}
