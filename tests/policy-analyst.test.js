import assert from "node:assert/strict";
import test from "node:test";

import { analyzePolicy, EvidenceError } from "../src/agents/policy-analyst.js";
import { toPublicScenario } from "../src/domain/scenario.js";
import { loadBenchmark } from "../src/evaluation/benchmark.js";
import { createTraceRecorder } from "../src/agents/trace.js";

function publicCase(id) {
  return toPublicScenario(loadBenchmark().cases.find((item) => item.id === id));
}

function recorder(id = "test") {
  return createTraceRecorder({ runId: "r", scenarioId: id });
}

test("policy analyst identifies the fraud precedence exception with exact source spans", () => {
  const scenario = publicCase("fraud-overrides-refunds");
  const trace = recorder(scenario.id);
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
  assert.deepEqual(trace.events().map((event) => event.type), ["instruction", "action-result", "final-evidence"]);
});

test("policy analyst suppresses wording-only routing changes", () => {
  const oldGuideline = { version: "v1", text: "Route password reset requests to Technical Access." };
  const newGuideline = { version: "v2", text: "Route requests to reset a password to Technical Access." };

  const result = analyzePolicy({ oldGuideline, newGuideline, trace: recorder("wording") });

  assert.deepEqual(result.deltas, []);
});

test("policy analyst rejects a behavioral delta when either source citation cannot be derived", () => {
  const oldGuideline = { version: "v1", text: "Route refund requests to Billing Refunds." };
  const newGuideline = { text: "Route unauthorized purchases to Fraud Review even when a refund is requested." };

  assert.throws(() => analyzePolicy({ oldGuideline, newGuideline, trace: recorder("missing-citation") }), EvidenceError);
});

test("policy analyst rejects an unpaired removed rule instead of silently discarding it", () => {
  const oldGuideline = { version: "v1", text: "Route refund requests to Billing Refunds." };
  const newGuideline = { version: "v2", text: "Route delivery tracking questions to Delivery Support." };

  assert.throws(() => analyzePolicy({ oldGuideline, newGuideline, trace: recorder("removed") }), EvidenceError);
});

test("policy analyst rejects an unrelated new route instead of fabricating a citation pair", () => {
  const oldGuideline = { version: "v1", text: "Route refund requests to Billing Refunds." };
  const newGuideline = { version: "v2", text: "Route delivery tracking questions to Delivery Support." };

  assert.throws(() => analyzePolicy({ oldGuideline, newGuideline, trace: recorder("addition") }), /no evidence establishes/i);
});

test("policy analyst classifies a routing exception before scope expansion", () => {
  const oldGuideline = { version: "v1", text: "Route refund requests to Billing Refunds." };
  const newGuideline = { version: "v2", text: "Route refund requests to Billing Refunds along with stolen-card cases." };

  const result = analyzePolicy({ oldGuideline, newGuideline, trace: recorder("exception") });

  assert.equal(result.deltas[0].type, "exception-changed");
});

test("policy analyst validates guideline versions before parsing routes", () => {
  const oldGuideline = { text: "This guideline has no routing sentence." };
  const newGuideline = { version: "v2", text: "This guideline also has no routing sentence." };

  assert.throws(() => analyzePolicy({ oldGuideline, newGuideline, trace: recorder("version") }), /guideline version/i);
});

test("policy analyst requires a trace recorder and records each analysis phase", () => {
  const oldGuideline = { version: "v1", text: "Route refund requests to Billing Refunds." };
  const newGuideline = { version: "v2", text: "Route refund requests to Billing Refunds." };

  assert.throws(() => analyzePolicy({ oldGuideline, newGuideline }), /trace recorder/i);
  assert.throws(() => analyzePolicy({ oldGuideline, newGuideline, trace: { record() {} } }), /trace recorder/i);
});
