import test from "node:test";
import assert from "node:assert/strict";
import { loadBenchmark } from "../src/evaluation/index.js";
import { toPublicScenario } from "../src/domain/scenario.js";
import { analyzeScenario } from "../src/agents/workflow.js";

test("workflow removes investigator scores at the verifier boundary", () => {
  const scenario = toPublicScenario(loadBenchmark().cases[0]);
  const oldRule = {
    id: "old-r1",
    label: "Billing Refunds",
    conditions: ["refund"],
    exceptions: [],
    precedence: false,
    citation: { documentId: scenario.oldGuideline.version, section: "sentence-1", start: 0, end: 0, quote: "" },
  };
  const newRule = {
    id: "new-r1",
    label: "Fraud Review",
    conditions: ["refund", "unauthorized"],
    exceptions: [],
    precedence: true,
    citation: { documentId: scenario.newGuideline.version, section: "sentence-1", start: 0, end: 0, quote: "" },
  };
  const policyAnalysis = {
    oldRules: [oldRule],
    newRules: [newRule],
    deltas: [{
      id: "delta-1",
      type: "priority-changed",
      oldRuleIds: [oldRule.id],
      newRuleIds: [newRule.id],
      targetLabel: newRule.label,
      sourceLabels: [oldRule.label],
      scopeTerms: ["refund", "unauthorized"],
      boundaryCases: [],
      precedenceChanged: true,
      citations: [oldRule.citation, newRule.citation],
    }],
    boundaryCases: [],
  };
  let verifierInput;
  analyzeScenario(scenario, {
    policyAnalysis,
    maxRecords: 1,
    candidateVerifier(input) {
      verifierInput = input.candidate;
      return { verdict: "uncertain", counterargument: "Alternative evidence may apply.", evidenceComplete: false, precedenceChecked: false };
    },
  });
  assert.equal("score" in verifierInput, false);
  assert.equal("scoreBreakdown" in verifierInput, false);
});
