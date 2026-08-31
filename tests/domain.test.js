import test from "node:test";
import assert from "node:assert/strict";
import { loadBenchmark } from "../src/evaluation/index.js";
import { toPublicScenario } from "../src/domain/scenario.js";
import { validateScenario } from "../src/domain/validation.js";
import { createTraceRecorder, redactSecrets } from "../src/agents/trace.js";

test("public scenarios exclude every ground-truth field", () => {
  const scenario = toPublicScenario(loadBenchmark().cases[0]);
  const serialized = JSON.stringify(scenario);
  assert.equal("groundTruth" in scenario, false);
  assert.doesNotMatch(serialized, /affectedRecordIds|expectedLabels|rationales/);
});
test("public scenario projection is immutable and detached", () => {
  const source = loadBenchmark().cases[0]; const scenario = toPublicScenario(source);
  assert.throws(() => { scenario.title = "changed"; }, TypeError);
  assert.throws(() => { scenario.records[0].text = "changed"; }, TypeError);
  assert.notEqual(scenario.records, source.records); assert.notEqual(scenario.oldGuideline, source.oldGuideline);
});
test("scenario validation rejects malformed records and guidelines", () => {
  const valid = toPublicScenario(loadBenchmark().cases[0]);
  for (const mutate of [(v) => { delete v.oldGuideline.text; }, (v) => { v.records[1].id = v.records[0].id; }, (v) => { v.records[0].text = ""; }, (v) => { delete v.records[0].existingLabel; }, (v) => { v.extra = true; }]) { const candidate = structuredClone(valid); mutate(candidate); assert.throws(() => validateScenario(candidate), /Invalid scenario/); }
  assert.equal(validateScenario(valid), true);
});
test("trace recorder redacts secrets and increments sequence", () => {
  const trace = createTraceRecorder({ runId: "run-1", scenarioId: "case-1", now: () => "2026-08-29T00:00:00.000Z" });
  const first = trace.record({ agent: "policy-analyst", phase: "compile", type: "instruction", payload: { authorization: "Bearer secret" } });
  const second = trace.record({ agent: "policy-analyst", phase: "compile", type: "final", payload: {} });
  assert.equal(first.sequence, 1); assert.equal(second.sequence, 2); assert.equal(JSON.stringify(first).includes("Bearer secret"), false);
});
test("trace events are copied, JSONL is line-delimited, and nested secrets redact", () => {
  const trace = createTraceRecorder({ runId: "run-1", scenarioId: "case-1", now: () => "now" });
  const event = trace.record({ agent: "a", phase: "p", type: "result", payload: { apiKey: "x", nested: { token: "y", safe: 1 } } }); const events = trace.events();
  assert.notEqual(events, trace.events()); assert.notEqual(events[0], event); assert.equal(events[0].payload.apiKey, "[REDACTED]"); assert.equal(events[0].payload.nested.token, "[REDACTED]"); assert.equal(trace.toJSONL().split("\n").length, 1); assert.equal(redactSecrets({ password: "pw", secret: "s" }).password, "[REDACTED]");
});
test("trace recorder owns sequencing and run metadata", () => {
  const trace = createTraceRecorder({ runId: "run-1", scenarioId: "case-1", now: () => "now" });
  const event = trace.record({ agent: "a", phase: "p", type: "result", payload: {}, runId: "forged", scenarioId: "other", sequence: 99, timestamp: "old" });
  assert.equal(event.schemaVersion, "rubricdelta-deterministic-trace-v2");
  assert.deepEqual(event.operation, { id: "a.p", eventType: "result", instruction: null, tool: null });
  assert.deepEqual(event.inputRefs, [{ kind: "scenario", id: "case-1" }]);
  assert.deepEqual(event.result, {});
  assert.equal(event.retryReason, null);
  assert.equal(event.feedbackReason, null);
  assert.equal(event.durationMs, null);
  assert.deepEqual(event.usage, { inputTokens: 0, outputTokens: 0, totalTokens: 0, providerCalls: 0, providerAttempts: 0 });
  assert.deepEqual(event.redaction, { applied: false, fields: [] });
  assert.equal(event.humanDecision, null);
  assert.equal(event.runId, "run-1");
  assert.equal(event.scenarioId, "case-1");
  assert.equal(event.sequence, 1);
  assert.equal(event.timestamp, "now");
  assert.equal(event.agent, "a");
  assert.equal(event.phase, "p");
  assert.equal(event.type, "result");
  assert.deepEqual(event.payload, {});
});
test("trace recorder rejects malformed event shapes before persistence", () => {
  const trace = createTraceRecorder({ runId: "run-1", scenarioId: "case-1" });
  for (const input of [{}, { agent: "a", phase: "p", type: "t" }, { agent: "a", phase: "p", type: "t", payload: [] }, { agent: "a", phase: "p", type: "t", payload: {}, extra: true }]) assert.throws(() => trace.record(input), /Invalid trace event/);
  assert.equal(trace.events().length, 0);
});
test("redaction matches secret indicators in compound key names", () => {
  assert.deepEqual(redactSecrets({ accessToken: "a", clientSecret: "b", authorizationHeader: "c", safe: "ok" }), { accessToken: "[REDACTED]", clientSecret: "[REDACTED]", authorizationHeader: "[REDACTED]", safe: "ok" });
});
test("scenario validation rejects whitespace-only identifiers and text", () => {
  const valid = toPublicScenario(loadBenchmark().cases[0]);
  for (const mutate of [(v) => { v.id = "   "; }, (v) => { v.oldGuideline.text = "\t"; }, (v) => { v.records[0].text = "  "; }, (v) => { v.records[0].existingLabel = "\n"; }]) { const candidate = structuredClone(valid); mutate(candidate); assert.throws(() => validateScenario(candidate), /Invalid scenario/); }
});
