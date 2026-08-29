import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAdvancedPredictions,
  createBaselinePredictions,
  evaluatePredictions,
  loadBenchmark,
} from "../src/evaluation/index.js";
import { toPublicScenario } from "../src/domain/scenario.js";
import { createTraceRecorder } from "../src/agents/trace.js";
import { analyzeScenario } from "../src/agents/workflow.js";
import { matchSemanticScope } from "../src/domain/semantics.js";
import { rankImpactCandidates } from "../src/agents/impact-investigator.js";
import { verifyCandidate } from "../src/agents/verifier.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function citation(documentId, quote) {
  return { documentId, section: "sentence-1", start: 0, end: quote.length, quote };
}

function analysisFixture({ oldTerms = [], newTerms = [], targetLabel = "Target", sourceLabel = "Legacy" } = {}) {
  const oldQuote = `Route ${oldTerms.join(" ")} to ${sourceLabel}.`;
  const newQuote = `Route ${newTerms.join(" ")} to ${targetLabel}.`;
  const oldRule = { id: "old-r1", label: sourceLabel, conditions: oldTerms, exceptions: [], precedence: false, citation: citation("old", oldQuote) };
  const newRule = { id: "new-r1", label: targetLabel, conditions: newTerms, exceptions: [], precedence: false, citation: citation("new", newQuote) };
  return {
    oldRules: [oldRule],
    newRules: [newRule],
    deltas: [{
      id: "delta-1",
      type: "scope-expanded",
      oldRuleIds: [oldRule.id],
      newRuleIds: [newRule.id],
      targetLabel,
      sourceLabels: [sourceLabel],
      scopeTerms: [...new Set([...oldTerms, ...newTerms])],
      boundaryCases: ["Cases mentioning every account"],
      precedenceChanged: false,
      citations: [oldRule.citation, newRule.citation],
    }],
    boundaryCases: ["Cases mentioning every account"],
  };
}

test("investigator ranks semantic and inflectional matches above lexical distractors", () => {
  const ids = [
    "fraud-overrides-refunds",
    "security-vulnerability",
    "multi-customer-outage",
    "regulated-text-translation",
  ];
  for (const id of ids) {
    const scenario = toPublicScenario(loadBenchmark().cases.find((item) => item.id === id));
    const result = analyzeScenario(scenario, { mode: "deterministic" });
    assert.equal(result.rankedCandidates.length, scenario.records.length);
    assert.ok(result.rankedCandidates.slice(0, 2).every((item) => item.evidence.length > 0));
  }
});

test("semantic normalization makes every expansion inspectable", () => {
  const evidence = matchSemanticScope(
    ["credential", "all", "translation"],
    "Tokens were exposed in every translated warning.",
  );
  assert.deepEqual(evidence.map(({ scopeTerm, recordTerm, matchType }) => ({ scopeTerm, recordTerm, matchType })), [
    { scopeTerm: "credential", recordTerm: "token", matchType: "semantic-equivalent" },
    { scopeTerm: "all", recordTerm: "every", matchType: "semantic-equivalent" },
    { scopeTerm: "translation", recordTerm: "translated", matchType: "semantic-equivalent" },
  ]);
  assert.ok(evidence.every((item) => typeof item.explanation === "string" && item.explanation.length > 0));
});

test("investigator applies the declared scoring formula", () => {
  const analysis = analysisFixture({
    oldTerms: ["account"],
    newTerms: ["account", "unauthorized", "credential", "all"],
  });
  const scenario = {
    id: "formula-case",
    oldGuideline: { version: "old", text: analysis.oldRules[0].citation.quote },
    newGuideline: { version: "new", text: analysis.newRules[0].citation.quote },
    records: [{ id: "record-a", text: "Unauthorized tokens affect every account.", existingLabel: "Legacy" }],
  };
  const [candidate] = rankImpactCandidates({ scenario, analysis });
  assert.equal(candidate.score, 11);
  assert.deepEqual(candidate.scoreBreakdown, {
    exactChangedScopePhraseMatches: 1,
    semanticEquivalentMatches: 2,
    existingLabelTransitionMatch: 1,
    boundaryConditionMatch: 1,
    alreadyAtTargetLabel: 0,
    explicitExclusionMatch: 0,
  });
});

test("investigator breaks score ties by evidence completeness and then input order", () => {
  const analysis = analysisFixture({ oldTerms: [], newTerms: ["credential", "all"] });
  const scenario = {
    id: "tie-case",
    oldGuideline: { version: "old", text: analysis.oldRules[0].citation.quote },
    newGuideline: { version: "new", text: analysis.newRules[0].citation.quote },
    records: [
      { id: "exact", text: "credential", existingLabel: "Legacy" },
      { id: "complete-first", text: "token every", existingLabel: "Legacy" },
      { id: "complete-second", text: "secret entire", existingLabel: "Legacy" },
    ],
  };
  const ranking = rankImpactCandidates({ scenario, analysis });
  assert.deepEqual(ranking.map((item) => item.recordId), ["complete-first", "complete-second", "exact"]);
  assert.deepEqual(ranking.map((item) => item.score), [6, 6, 6]);
});

test("verifier is blind to investigator score and records a concrete counterargument", () => {
  const analysis = analysisFixture({ oldTerms: ["account"], newTerms: ["account", "unauthorized"] });
  const scenario = {
    id: "blind-case",
    oldGuideline: { version: "old", text: analysis.oldRules[0].citation.quote },
    newGuideline: { version: "new", text: analysis.newRules[0].citation.quote },
    records: [{ id: "record-a", text: "unauthorized account", existingLabel: "Legacy" }],
  };
  const trace = createTraceRecorder({ runId: "blind", scenarioId: scenario.id, now: () => "now" });
  const candidate = {
    recordId: "record-a",
    existingLabel: "Legacy",
    proposedLabel: "Target",
    ruleDeltaIds: ["delta-1"],
    evidence: [
      { type: "changed-rule-citation", deltaId: "delta-1", citation: analysis.newRules[0].citation },
      { type: "record-evidence", recordId: "record-a", quote: "unauthorized account" },
    ],
  };
  Object.defineProperty(candidate, "score", { get() { throw new Error("verifier read investigator score"); } });
  const result = verifyCandidate({ candidate, scenario, analysis, trace });
  assert.equal(result.verdict, "support");
  assert.match(result.counterargument, /could|however|unless|alternative/i);
  assert.doesNotMatch(JSON.stringify(trace.events()), /"score"/);
});

test("verifier rejects invalid citations and abstains on incomplete evidence", () => {
  const analysis = analysisFixture({ oldTerms: [], newTerms: ["unauthorized"] });
  const scenario = {
    id: "citation-case",
    oldGuideline: { version: "old", text: analysis.oldRules[0].citation.quote },
    newGuideline: { version: "new", text: analysis.newRules[0].citation.quote },
    records: [{ id: "record-a", text: "unauthorized account", existingLabel: "Legacy" }],
  };
  const base = {
    recordId: "record-a",
    existingLabel: "Legacy",
    proposedLabel: "Target",
    ruleDeltaIds: ["delta-1"],
    evidence: [{ type: "record-evidence", recordId: "record-a", quote: "unauthorized account" }],
  };
  const invalid = verifyCandidate({
    candidate: { ...base, evidence: [...base.evidence, { type: "changed-rule-citation", deltaId: "delta-1", citation: { ...analysis.newRules[0].citation, quote: "invented" } }] },
    scenario,
    analysis,
  });
  const incomplete = verifyCandidate({ candidate: base, scenario, analysis });
  assert.equal(invalid.verdict, "reject");
  assert.equal(incomplete.verdict, "uncertain");
  assert.equal(incomplete.evidenceComplete, false);
});

test("workflow retries a failed stage within budget and keeps a complete ranking", () => {
  const scenario = toPublicScenario(loadBenchmark().cases[0]);
  const analysis = analysisFixture({ oldTerms: ["refund"], newTerms: ["refund", "unauthorized"] });
  let attempts = 0;
  const result = analyzeScenario(scenario, {
    maxRecords: 1,
    maxRetries: 2,
    policyAnalyzer() {
      attempts += 1;
      if (attempts < 3) throw new Error("transient analysis failure");
      return analysis;
    },
  });
  assert.equal(attempts, 3);
  assert.equal(result.rankedCandidates.length, scenario.records.length);
  assert.equal(result.rankedCandidates.filter((item) => item.verifier.verdict !== "uncertain").length, 1);
  assert.equal(result.trace.filter((event) => event.type === "retry").length, 2);
});

test("advanced adapter projects gold away before invoking production workflow", () => {
  const benchmark = loadBenchmark();
  const seen = [];
  const predictions = createAdvancedPredictions(benchmark, {
    scenarioAnalyzer(scenario) {
      seen.push(scenario);
      return {
        rankedCandidates: scenario.records.map((record) => ({ recordId: record.id, evidence: [] })),
        trace: [],
      };
    },
  });
  assert.equal(seen.length, benchmark.cases.length);
  assert.ok(seen.every((scenario) => Object.isFrozen(scenario)));
  assert.ok(seen.every((scenario) => !JSON.stringify(scenario).match(/groundTruth|affectedRecordIds|expectedLabels|rationales/)));
  assert.deepEqual(predictions.metadata.fairnessManifest, {
    benchmarkId: benchmark.benchmarkId,
    caseIds: benchmark.cases.map((item) => item.id),
    reviewBudgetFraction: benchmark.reviewBudgetFraction,
    provider: "deterministic",
    seed: 0,
  });
});

test("advanced workflow beats the frozen lexical baseline without gold access", () => {
  const benchmark = loadBenchmark();
  const baseline = evaluatePredictions(benchmark, createBaselinePredictions(benchmark));
  const advancedPredictions = createAdvancedPredictions(benchmark);
  const advanced = evaluatePredictions(benchmark, advancedPredictions);
  assert.equal(baseline.primaryMetric.value, 0.8);
  assert.ok(advancedPredictions.cases.every((item) => item.rankedRecordIds.length === 10));
  assert.ok(advanced.primaryMetric.value > baseline.primaryMetric.value);
  assert.ok(advanced.primaryMetric.value >= 0.9);
});

test("production workflow source has no benchmark gold or ID hardcoding", () => {
  const roots = ["src/agents", "src/domain", "src/providers", "src/server", "public"];
  const files = [];
  const visit = (path) => {
    if (!statSync(path).isDirectory()) {
      if (/\.(?:js|mjs|cjs|html|css)$/.test(path)) files.push(path);
      return;
    }
    for (const entry of readdirSync(path)) visit(join(path, entry));
  };
  for (const relative of roots) {
    const path = join(repositoryRoot, relative);
    try { visit(path); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const source = files.map((file) => readFileSync(file, "utf8")).join("\n");
  assert.doesNotMatch(source, /groundTruth|affectedRecordIds|expectedLabels|rationales/);
  const benchmark = loadBenchmark();
  for (const id of benchmark.cases.flatMap((item) => [item.id, ...item.records.map((record) => record.id)])) {
    assert.equal(source.includes(id), false, `production workflow hardcodes benchmark identifier ${id}`);
  }
});
