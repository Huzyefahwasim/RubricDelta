import { validateScenario } from "../domain/validation.js";
import { extractRoutingRules } from "../domain/rules.js";
import { analyzePolicy } from "./policy-analyst.js";
import { createTraceRecorder } from "./trace.js";
import { rankImpactCandidates } from "./impact-investigator.js";
import { verifyCandidate } from "./verifier.js";

function cleanLabel(label) {
  return String(label ?? "").replace(/[,:;.!?]+$/g, "").trim();
}

function overlap(left, right) {
  const rightSet = new Set(right);
  return left.filter((item) => rightSet.has(item)).length;
}

function recoverPolicyAnalysis(scenario) {
  const oldRules = extractRoutingRules(scenario.oldGuideline);
  const newRules = extractRoutingRules(scenario.newGuideline);
  if (oldRules.length === 0 || newRules.length === 0) throw new Error("Policy recovery requires cited old and new routing rules");
  const deltas = newRules.map((newRule, index) => {
    const sameLabel = oldRules.find((rule) => cleanLabel(rule.label) === cleanLabel(newRule.label));
    const oldRule = sameLabel ?? [...oldRules].sort((left, right) => {
      const leftScore = overlap([...left.conditions, ...left.exceptions], [...newRule.conditions, ...newRule.exceptions]);
      const rightScore = overlap([...right.conditions, ...right.exceptions], [...newRule.conditions, ...newRule.exceptions]);
      return rightScore - leftScore || oldRules.indexOf(left) - oldRules.indexOf(right);
    })[0];
    const scopeTerms = [...new Set([...oldRule.conditions, ...oldRule.exceptions, ...newRule.conditions, ...newRule.exceptions])];
    return {
      id: `recovered-delta-${index + 1}`,
      type: cleanLabel(oldRule.label) === cleanLabel(newRule.label) ? "scope-changed" : "label-changed",
      oldRuleIds: [oldRule.id],
      newRuleIds: [newRule.id],
      targetLabel: cleanLabel(newRule.label),
      sourceLabels: [cleanLabel(oldRule.label)],
      scopeTerms,
      boundaryCases: scopeTerms.map((term) => `Cases mentioning ${term}`),
      precedenceChanged: oldRule.precedence !== newRule.precedence,
      citations: [oldRule.citation, newRule.citation],
      ambiguity: "high",
    };
  });
  return { oldRules, newRules, deltas, boundaryCases: [...new Set(deltas.flatMap((delta) => delta.boundaryCases))], recovered: true };
}

function boundedInteger(value, fallback, label) {
  const actual = value ?? fallback;
  if (!Number.isInteger(actual) || actual < 0) throw new Error(`${label} must be a non-negative integer`);
  return actual;
}

export function analyzeScenario(scenario, options = {}) {
  validateScenario(scenario);
  if ((options.mode ?? "deterministic") !== "deterministic") throw new Error("Only deterministic mode is available offline");
  const maxRetries = boundedInteger(options.maxRetries, 2, "maxRetries");
  const maxRecords = boundedInteger(options.maxRecords, scenario.records.length, "maxRecords");
  const trace = options.trace ?? createTraceRecorder({
    runId: options.runId ?? `run-${scenario.id}`,
    scenarioId: scenario.id,
    now: options.now,
  });
  trace.record({ agent: "orchestrator", phase: "workflow", type: "instruction", payload: { mode: "deterministic", maxRecords, maxRetries } });

  let analysis = options.policyAnalysis;
  let attempts = 0;
  let recovered = false;
  if (!analysis) {
    const policyAnalyzer = options.policyAnalyzer ?? analyzePolicy;
    while (attempts <= maxRetries) {
      attempts += 1;
      try {
        analysis = policyAnalyzer({ oldGuideline: scenario.oldGuideline, newGuideline: scenario.newGuideline, trace });
        break;
      } catch (error) {
        if (attempts <= maxRetries) {
          trace.record({ agent: "orchestrator", phase: "analysis", type: "retry", payload: { attempt: attempts, reason: error.message } });
        } else if (policyAnalyzer === analyzePolicy) {
          trace.record({ agent: "orchestrator", phase: "analysis", type: "escalation", payload: { attempts, reason: error.message } });
          analysis = recoverPolicyAnalysis(scenario);
          recovered = true;
        } else {
          trace.record({ agent: "orchestrator", phase: "analysis", type: "failed-stage", payload: { attempts, reason: error.message } });
          throw error;
        }
      }
    }
  }

  const ranked = rankImpactCandidates({ scenario, analysis, trace });
  const verificationLimit = Math.min(maxRecords, ranked.length);
  const candidateVerifier = options.candidateVerifier ?? verifyCandidate;
  const rankedCandidates = ranked.map((candidate, index) => {
    const { score: _score, scoreBreakdown: _scoreBreakdown, ...verifierCandidate } = candidate;
    const verifier = index < verificationLimit
      ? candidateVerifier({ candidate: verifierCandidate, scenario, analysis, trace })
      : {
        verdict: "uncertain",
        counterargument: "Verification budget was exhausted before this candidate could be challenged.",
        evidenceComplete: false,
        precedenceChecked: false,
      };
    return { ...candidate, verifier };
  });
  trace.record({
    agent: "orchestrator",
    phase: "workflow",
    type: "action-result",
    payload: { candidateCount: rankedCandidates.length, verificationCount: verificationLimit, recovered },
  });
  trace.record({
    agent: "orchestrator",
    phase: "workflow",
    type: "final-evidence",
    payload: { rankedRecordIds: rankedCandidates.map((candidate) => candidate.recordId), escalated: recovered },
  });
  return {
    scenarioId: scenario.id,
    analysis,
    rankedCandidates,
    trace: trace.events(),
    attempts,
    escalated: recovered,
  };
}
