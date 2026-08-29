import assert from "node:assert/strict";
import test from "node:test";

import { analyzePolicy, EvidenceError } from "../src/agents/policy-analyst.js";
import { toPublicScenario } from "../src/domain/scenario.js";
import { loadBenchmark } from "../src/evaluation/benchmark.js";
import { createTraceRecorder } from "../src/agents/trace.js";

function publicCase(id) {
  return toPublicScenario(loadBenchmark().cases.find((item) => item.id === id));
}

test("policy analyst identifies the fraud precedence exception with exact source spans", () => {
  const scenario = publicCase("fraud-overrides-refunds");
  const trace = createTraceRecorder({ runId: "r", scenarioId: scenario.id });

  const result = analyzePolicy({ ...scenario, trace });
  const fraudDelta = result.deltas.find((delta) => delta.targetLabel === "Fraud Review" && delta.precedenceChanged);

  assert.ok(fraudDelta, "the new Fraud Review exception must be a precedence change");
  assert.equal(fraudDelta.type, "priority-changed");
  assert.equal(fraudDelta.citations.length, 2);
  assert.deepEqual(fraudDelta.citations.map((citation) => citation.documentId), ["billing-1.0", "billing-1.1"]);
  for (const citation of fraudDelta.citations) {
    const document = citation.documentId === "billing-1.0" ? scenario.oldGuideline : scenario.newGuideline;
    assert.equal(citation.quote, document.text.slice(citation.start, citation.end));
    assert.ok(citation.quote.length > 0);
  }
  assert.ok(fraudDelta.boundaryCases.some((item) => item.includes("refund")));
  assert.equal(trace.events().at(-1).agent, "policy-analyst");
});

test("policy analyst suppresses wording-only routing changes", () => {
  const oldGuideline = { version: "v1", text: "Route password reset requests to Technical Access." };
  const newGuideline = { version: "v2", text: "Route requests to reset a password to Technical Access." };

  const result = analyzePolicy({ oldGuideline, newGuideline, trace: createTraceRecorder({ runId: "r", scenarioId: "wording" }) });

  assert.deepEqual(result.deltas, []);
});

test("policy analyst rejects a behavioral delta when either source citation cannot be derived", () => {
  const oldGuideline = { version: "v1", text: "Route refund requests to Billing Refunds." };
  const newGuideline = { text: "Route unauthorized purchases to Fraud Review even when a refund is requested." };

  assert.throws(
    () => analyzePolicy({ oldGuideline, newGuideline, trace: createTraceRecorder({ runId: "r", scenarioId: "missing-citation" }) }),
    EvidenceError,
  );
});
