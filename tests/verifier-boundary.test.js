import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAdvancedPredictions, loadBenchmark } from "../src/evaluation/index.js";
import { toPublicScenario } from "../src/domain/scenario.js";
import { matchSemanticScope } from "../src/domain/semantics.js";
import { createTraceRecorder } from "../src/agents/trace.js";
import { rankImpactCandidates } from "../src/agents/impact-investigator.js";
import { verifyCandidate } from "../src/agents/verifier.js";
import { analyzeScenario } from "../src/agents/workflow.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FORBIDDEN_PRODUCTION_REFERENCE = /(?:(?:from\s*["\']|(?:require|import)\s*\()[^)]*(?:evaluation|benchmark)|\b(?:loadBenchmark|DEFAULT_BENCHMARK_PATH|evaluatePredictions|createBaselinePredictions)\b)/i;

function citation(document, sentenceIndex = 0) {
  const quote = document.text.match(/[^.!?]+[.!?]?/g)[sentenceIndex].trim();
  const start = document.text.indexOf(quote);
  return { documentId: document.version, section: `sentence-${sentenceIndex + 1}`, start, end: start + quote.length, quote };
}

function scenarioFixture({ existingLabel = "Legacy" } = {}) {
  return {
    id: "boundary-case", title: "Boundary case", difficulty: "hard", changeType: "priority_change",
    oldGuideline: { version: "old-v1", text: "Route refund requests to Legacy." },
    newGuideline: { version: "new-v2", text: "Route unauthorized refund requests to Target, even when a refund is requested." },
    records: [{ id: "record-1", text: "This refund was unauthorized.", existingLabel }],
  };
}

function analysisFixture(scenario = scenarioFixture(), { precedenceChanged = true, newPrecedence = true } = {}) {
  const oldRule = { id: "old-r1", label: "Legacy", conditions: ["refund", "request"], exceptions: [], precedence: false, citation: citation(scenario.oldGuideline) };
  const newRule = { id: "new-r1", label: "Target", conditions: ["unauthorized", "refund", "request"], exceptions: [], precedence: newPrecedence, citation: citation(scenario.newGuideline) };
  return {
    oldRules: [oldRule], newRules: [newRule],
    deltas: [{
      id: "delta-1", type: "priority-changed", oldRuleIds: [oldRule.id], newRuleIds: [newRule.id],
      targetLabel: newRule.label, sourceLabels: [oldRule.label], scopeTerms: ["refund", "unauthorized"],
      boundaryCases: [], precedenceChanged, citations: [oldRule.citation, newRule.citation],
    }],
    boundaryCases: [],
  };
}

function supportedCandidate(scenario, analysis) {
  const record = scenario.records[0];
  return {
    recordId: record.id, existingLabel: record.existingLabel, proposedLabel: "Target", ruleDeltaIds: ["delta-1"],
    evidence: [
      { type: "changed-rule-citation", deltaId: "delta-1", citation: analysis.newRules[0].citation },
      { type: "record-evidence", recordId: record.id, quote: record.text },
    ],
  };
}

test("workflow removes investigator scores at the verifier boundary", () => {
  const scenario = scenarioFixture();
  let verifierInput;
  analyzeScenario(scenario, {
    policyAnalysis: analysisFixture(scenario), maxRecords: 1,
    candidateVerifier(input) {
      verifierInput = input.candidate;
      return { verdict: "uncertain", counterargument: "Alternative evidence may apply.", evidenceComplete: false, precedenceChecked: false };
    },
  });
  assert.equal("score" in verifierInput, false);
  assert.equal("scoreBreakdown" in verifierInput, false);
});

test("verifier rejects old-rule evidence and trusts the scenario label over a spoofed candidate label", () => {
  const scenario = scenarioFixture({ existingLabel: "Target" });
  const analysis = analysisFixture(scenario);
  const candidate = {
    ...supportedCandidate(scenario, analysis), existingLabel: "Legacy",
    evidence: [
      { type: "changed-rule-citation", deltaId: "delta-1", citation: analysis.oldRules[0].citation },
      { type: "record-evidence", recordId: "record-1", quote: scenario.records[0].text },
    ],
  };
  assert.equal(verifyCandidate({ candidate, scenario, analysis }).verdict, "reject");
});

test("verifier rejects a fabricated precedence change", () => {
  const scenario = scenarioFixture();
  const analysis = analysisFixture(scenario, { precedenceChanged: true, newPrecedence: false });
  const result = verifyCandidate({ candidate: supportedCandidate(scenario, analysis), scenario, analysis });
  assert.equal(result.verdict, "reject");
  assert.equal(result.precedenceChecked, false);
});

test("verifier binds citation target and precedence to one selected delta", () => {
  const scenario = {
    id: "cross-delta", title: "Cross delta", difficulty: "hard", changeType: "multi",
    oldGuideline: { version: "old", text: "Route alpha to Legacy A. Route beta to Legacy B." },
    newGuideline: { version: "new", text: "Route alpha changed to Target A. Route beta changed to Target B." },
    records: [{ id: "record-1", text: "alpha changed", existingLabel: "Legacy A" }],
  };
  const oldA = { id: "old-a", label: "Legacy A", conditions: ["alpha"], exceptions: [], precedence: false, citation: citation(scenario.oldGuideline, 0) };
  const oldB = { id: "old-b", label: "Legacy B", conditions: ["beta"], exceptions: [], precedence: false, citation: citation(scenario.oldGuideline, 1) };
  const newA = { id: "new-a", label: "Target A", conditions: ["alpha", "changed"], exceptions: [], precedence: false, citation: citation(scenario.newGuideline, 0) };
  const newB = { id: "new-b", label: "Target B", conditions: ["beta", "changed"], exceptions: [], precedence: false, citation: citation(scenario.newGuideline, 1) };
  const delta = (id, oldRule, newRule) => ({ id, type: "scope-expanded", oldRuleIds: [oldRule.id], newRuleIds: [newRule.id], targetLabel: newRule.label, sourceLabels: [oldRule.label], scopeTerms: newRule.conditions, boundaryCases: [], precedenceChanged: false, citations: [oldRule.citation, newRule.citation] });
  const analysis = { oldRules: [oldA, oldB], newRules: [newA, newB], deltas: [delta("delta-a", oldA, newA), delta("delta-b", oldB, newB)], boundaryCases: [] };
  const candidate = {
    recordId: "record-1", existingLabel: "Legacy A", proposedLabel: "Target A", ruleDeltaIds: ["delta-a", "delta-b"],
    evidence: [
      { type: "changed-rule-citation", deltaId: "delta-b", citation: newB.citation },
      { type: "record-evidence", recordId: "record-1", quote: "alpha changed" },
    ],
  };
  assert.equal(verifyCandidate({ candidate, scenario, analysis }).verdict, "reject");
});

test("workflow abstains and traces invalid injected policy analysis", () => {
  const scenario = scenarioFixture();
  const trace = createTraceRecorder({ runId: "invalid-analysis", scenarioId: scenario.id, now: () => "now" });
  const result = analyzeScenario(scenario, { trace, policyAnalysis: { oldRules: [], newRules: [], deltas: [{ id: "invented" }], boundaryCases: [] } });
  assert.ok(result.rankedCandidates.every((candidate) => candidate.verifier.verdict === "uncertain"));
  assert.ok(result.trace.some((event) => event.type === "validation-failure" && event.payload.stage === "policy-analysis"));
});

test("workflow abstains when an injected verifier emits an invalid schema", () => {
  const scenario = scenarioFixture();
  const result = analyzeScenario(scenario, { policyAnalysis: analysisFixture(scenario), maxRecords: 1, candidateVerifier() { return { verdict: "support" }; } });
  assert.equal(result.rankedCandidates[0].verifier.verdict, "uncertain");
  assert.ok(result.trace.some((event) => event.type === "validation-failure" && event.payload.stage === "verification"));
});

test("advanced adapter rejects malformed injected rankings", () => {
  const benchmark = loadBenchmark();
  assert.throws(() => createAdvancedPredictions(benchmark, {
    scenarioAnalyzer(scenario) { return { rankedCandidates: scenario.records.map(() => ({ recordId: scenario.records[0].id, evidence: [] })), trace: [] }; },
  }), /Invalid advanced workflow result/);
});

test("transition points apply only to the selected delta source label", () => {
  const scenario = { id: "multi-delta", oldGuideline: { version: "old", text: "Route alpha to Legacy A. Route beta to Legacy B." }, newGuideline: { version: "new", text: "Route alpha special to Target A." }, records: [{ id: "record-1", text: "alpha special", existingLabel: "Legacy B" }] };
  const oldA = { id: "old-a", label: "Legacy A", conditions: ["alpha"], exceptions: [], precedence: false, citation: citation(scenario.oldGuideline, 0) };
  const oldB = { id: "old-b", label: "Legacy B", conditions: ["beta"], exceptions: [], precedence: false, citation: citation(scenario.oldGuideline, 1) };
  const newA = { id: "new-a", label: "Target A", conditions: ["alpha", "special"], exceptions: [], precedence: false, citation: citation(scenario.newGuideline, 0) };
  const analysis = { oldRules: [oldA, oldB], newRules: [newA], deltas: [{ id: "delta-a", type: "scope-expanded", oldRuleIds: [oldA.id], newRuleIds: [newA.id], targetLabel: newA.label, sourceLabels: [oldA.label], scopeTerms: ["alpha", "special"], boundaryCases: [], precedenceChanged: false, citations: [oldA.citation, newA.citation] }], boundaryCases: [] };
  const [candidate] = rankImpactCandidates({ scenario, analysis });
  assert.equal(candidate.scoreBreakdown.existingLabelTransitionMatch, 0);
  assert.equal(candidate.score, 4);
});

test("zero-overlap recovery escalates and abstains without fabricated deltas", () => {
  const scenario = { id: "unrelated-rules", title: "Unrelated rules", difficulty: "hard", changeType: "unrelated", oldGuideline: { version: "old", text: "Route apples to Fruit." }, newGuideline: { version: "new", text: "Route quantum errors to Physics." }, records: [{ id: "record-1", text: "A quantum error occurred.", existingLabel: "Fruit" }] };
  const result = analyzeScenario(scenario, { maxRetries: 0 });
  assert.equal(result.escalated, true);
  assert.equal(result.analysis.deltas.length, 0);
  assert.equal(result.rankedCandidates[0].proposedLabel, "Fruit");
  assert.equal(result.rankedCandidates[0].verifier.verdict, "uncertain");
});

test("workflow never records raw exception messages", () => {
  const scenario = scenarioFixture();
  const trace = createTraceRecorder({ runId: "secret-error", scenarioId: scenario.id, now: () => "now" });
  assert.throws(() => analyzeScenario(scenario, { trace, maxRetries: 0, policyAnalyzer() { throw new Error("Authorization Bearer sk-private-value"); } }), /Authorization Bearer/);
  assert.doesNotMatch(trace.toJSONL(), /sk-private-value|Authorization Bearer/);
  assert.ok(trace.events().some((event) => event.type === "failed-stage" && event.payload.errorCode === "Error"));
});

test("workflow maps attacker-controlled error code and name to a controller-owned generic code", () => {
  const scenario = scenarioFixture();
  const trace = createTraceRecorder({ runId: "hostile-code", scenarioId: scenario.id, now: () => "now" });
  const hostile = new Error("safe message");
  hostile.code = "sk-private-value";
  hostile.name = "sk-private-name";
  assert.throws(() => analyzeScenario(scenario, { trace, maxRetries: 0, policyAnalyzer() { throw hostile; } }));
  assert.doesNotMatch(trace.toJSONL(), /sk-private-value|sk-private-name/);
  assert.ok(trace.events().some((event) => event.type === "failed-stage" && event.payload.errorCode === "STAGE_ERROR"));
});

test("investigator and verifier failures are retried, traced, and converted to abstention", () => {
  const scenario = scenarioFixture();
  const analysis = analysisFixture(scenario);
  let rankAttempts = 0;
  const ranked = analyzeScenario(scenario, { policyAnalysis: analysis, maxRetries: 1, candidateRanker() { rankAttempts += 1; throw new Error("private ranking payload"); } });
  assert.equal(rankAttempts, 2);
  assert.ok(ranked.rankedCandidates.every((candidate) => candidate.verifier.verdict === "uncertain"));
  assert.ok(ranked.trace.some((event) => event.type === "failed-stage" && event.payload.stage === "ranking"));
  let verifyAttempts = 0;
  const verified = analyzeScenario(scenario, { policyAnalysis: analysis, maxRecords: 1, maxRetries: 1, candidateVerifier() { verifyAttempts += 1; throw new Error("private verifier payload"); } });
  assert.equal(verifyAttempts, 2);
  assert.equal(verified.rankedCandidates[0].verifier.verdict, "uncertain");
});

test("numeric price evidence requires money context rather than arbitrary differing numbers", () => {
  assert.deepEqual(matchSemanticScope(["price"], "Version 10 changed to version 11 on 2026-08-29."), []);
  assert.equal(matchSemanticScope(["price"], "The checkout changed $10.00 to $100.00.").length, 1);
});

test("gold guard rejects dynamic evaluation imports as well as static references", () => {
  assert.match('await import("../evaluation/index.js")', FORBIDDEN_PRODUCTION_REFERENCE);
  const roots = ["src/agents", "src/domain", "src/providers", "src/server", "public"];
  const files = [];
  const visit = (path) => {
    if (!statSync(path).isDirectory()) { if (/\.(?:js|mjs|cjs|html|css)$/.test(path)) files.push(path); return; }
    for (const entry of readdirSync(path)) visit(join(path, entry));
  };
  for (const relative of roots) {
    const path = join(repositoryRoot, relative);
    try { visit(path); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const source = files.map((file) => readFileSync(file, "utf8")).join("\n");
  assert.doesNotMatch(source, /groundTruth|affectedRecordIds|expectedLabels|rationales/);
  assert.doesNotMatch(source, FORBIDDEN_PRODUCTION_REFERENCE);
});
