const SECRET_KEYS = new Set(["authorization", "apikey", "token", "secret", "password"]);

export function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    SECRET_KEYS.has(key.toLowerCase()) ? "[REDACTED]" : redactSecrets(child),
  ]));
}

export function createTraceRecorder({ runId, scenarioId, now = () => new Date().toISOString() } = {}) {
  const stored = [];
  return {
    record(input) {
      const event = redactSecrets({ runId, scenarioId, sequence: stored.length + 1, timestamp: now(), ...input });
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
