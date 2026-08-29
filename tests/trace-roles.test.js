import test from "node:test";
import assert from "node:assert/strict";
import { analyzePolicy } from "../src/agents/policy-analyst.js";
import { createTraceRecorder } from "../src/agents/trace.js";
import { loadBenchmark } from "../src/evaluation/index.js";
import { toPublicScenario } from "../src/domain/scenario.js";

test("policy analysis truthfully traces distinct rule-compiler and change-analyst stages", () => {
  const scenario = toPublicScenario(loadBenchmark().cases[0]);
  const trace = createTraceRecorder({ runId: "role-contract", scenarioId: scenario.id, now: () => "now" });
  const result = analyzePolicy({
    oldGuideline: scenario.oldGuideline,
    newGuideline: scenario.newGuideline,
    trace,
  });

  assert.ok(result.oldRules.length > 0);
  assert.ok(result.newRules.length > 0);
  assert.ok(result.deltas.length > 0);
  const events = trace.events();
  const compiler = events.filter((event) => event.agent === "rule-compiler");
  const analyst = events.filter((event) => event.agent === "change-analyst");
  assert.deepEqual(compiler.map((event) => event.type), ["instruction", "action-result", "final-evidence"]);
  assert.deepEqual(analyst.map((event) => event.type), ["instruction", "action-result", "final-evidence"]);
  assert.deepEqual(compiler.at(-1).payload.ruleIds, [...result.oldRules, ...result.newRules].map((rule) => rule.id));
  assert.deepEqual(analyst.at(-1).payload.deltaIds, result.deltas.map((delta) => delta.id));
});
