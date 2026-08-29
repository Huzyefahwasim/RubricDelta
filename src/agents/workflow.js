import { validateScenario } from "../domain/validation.js";
import { extractRoutingRules } from "../domain/rules.js";
import { analyzePolicy } from "./policy-analyst.js";
import { createTraceRecorder } from "./trace.js";
import { rankImpactCandidates } from "./impact-investigator.js";
import { verifyCandidate } from "./verifier.js";
import { ContractError, validateCandidateRanking, validatePolicyAnalysis, validateVerifierResult } from "./contracts.js";

const EMPTY_BREAKDOWN = Object.freeze({
  exactChangedScopePhraseMatches: 0,
  semanticEquivalentMatches: 0,
  existingLabelTransitionMatch: 0,
  boundaryConditionMatch: 0,
  alreadyAtTargetLabel: 0,
  explicitExclusionMatch: 0,
});

function cleanLabel(label) {
  return String(label ?? "").replace(/[,:;.!?]+$/g, "").trim();
}

function overlap(left, right) {
  const rightSet = new Set(right);
  return left.filter((item) => rightSet.has(item)).length;
}

function ruleTerms(rule) {
  return [...rule.conditions, ...rule.exceptions];
}

function recoverPolicyAnalysis(scenario) {
  const oldRules = extractRoutingRules(scenario.oldGuideline);
  const newRules = extractRoutingRules(scenario.newGuideline);
  if (oldRules.length === 0 || newRules.length === 0) throw new ContractError("Policy recovery requires cited old and new routing rules", "POLICY_RECOVERY_UNAVAILABLE");
  const deltas = [];
  const linkedOldIds = new Set();
  const unresolvedRuleIds = [];
  for (const newRule of newRules) {
    const sameLabel = oldRules.find((rule) => cleanLabel(rule.label) === cleanLabel(newRule.label));
    const overlaps = oldRules
      .map((rule, inputIndex) => ({ rule, inputIndex, score: overlap(ruleTerms(rule), ruleTerms(newRule)) }))
      .sort((left, right) => right.score - left.score || left.inputIndex - right.inputIndex);
    const match = sameLabel ?? (overlaps[0]?.score > 0 ? overlaps[0].rule : null);
    if (!match) {
      unresolvedRuleIds.push(newRule.id);
      continue;
    }
    linkedOldIds.add(match.id);
    const scopeTerms = [...new Set([...ruleTerms(match), ...ruleTerms(newRule)])];
    deltas.push({
      id: `recovered-delta-${deltas.length + 1}`,
      type: cleanLabel(match.label) === cleanLabel(newRule.label) ? "scope-changed" : "label-changed",
      oldRuleIds: [match.id],
      newRuleIds: [newRule.id],
      targetLabel: cleanLabel(newRule.label),
      sourceLabels: [cleanLabel(match.label)],
      scopeTerms,
      boundaryCases: scopeTerms.map((term) => `Cases mentioning ${term}`),
      precedenceChanged: match.precedence !== newRule.precedence,
      citations: [match.citation, newRule.citation],
      ambiguity: "high",
    });
  }
  for (const oldRule of oldRules) if (!linkedOldIds.has(oldRule.id)) unresolvedRuleIds.push(oldRule.id);
  return {
    oldRules,
    newRules,
    deltas,
    boundaryCases: [...new Set(deltas.flatMap((delta) => delta.boundaryCases))],
    recovered: true,
    unresolved: unresolvedRuleIds.length > 0 || deltas.length === 0,
    unresolvedRuleIds,
  };
}

function unresolvedAnalysis(scenario) {
  return {
    oldRules: extractRoutingRules(scenario.oldGuideline),
    newRules: extractRoutingRules(scenario.newGuideline),
    deltas: [],
    boundaryCases: [],
    recovered: true,
    unresolved: true,
    unresolvedRuleIds: [],
  };
}

function boundedInteger(value, fallback, label) {
  const actual = value ?? fallback;
  if (!Number.isInteger(actual) || actual < 0) throw new Error(`${label} must be a non-negative integer`);
  return actual;
}

function errorCode(error) {
  const code = typeof error?.code === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(error.code)
    ? error.code
    : error?.name;
  return typeof code === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(code) ? code : "STAGE_ERROR";
}

function uncertainVerifier(counterargument = "The stage could not establish complete evidence within its retry budget.") {
  return { verdict: "uncertain", counterargument, evidenceComplete: false, precedenceChecked: false };
}

function abstentionRanking(scenario) {
  return scenario.records.map((record) => ({
    recordId: record.id,
    existingLabel: record.existingLabel,
    proposedLabel: record.existingLabel,
    score: 0,
    scoreBreakdown: { ...EMPTY_BREAKDOWN },
    ruleDeltaIds: [],
    evidence: [],
    status: "pending",
  }));
}

function traceFailure(trace, { agent = "orchestrator", phase, type, stage, attempt, error }) {
  trace.record({ agent, phase, type, payload: { stage, attempt, errorCode: errorCode(error) } });
}

function resultWithFinalTrace({ scenario, analysis, rankedCandidates, trace, attempts, escalated, recovered }) {
  trace.record({
    agent: "orchestrator",
    phase: "workflow",
    type: "action-result",
    payload: { candidateCount: rankedCandidates.length, verificationCount: rankedCandidates.filter((item) => item.verifier.precedenceChecked).length, recovered },
  });
  trace.record({
    agent: "orchestrator",
    phase: "workflow",
    type: "final-evidence",
    payload: { rankedRecordIds: rankedCandidates.map((candidate) => candidate.recordId), escalated, status: escalated ? "partial" : "complete" },
  });
  return { scenarioId: scenario.id, analysis, rankedCandidates, trace: trace.events(), attempts, escalated };
}

export function analyzeScenario(scenario, options = {}) {
  validateScenario(scenario);
  if ((options.mode ?? "deterministic") !== "deterministic") throw new Error("Only deterministic mode is available offline");
  const maxRetries = boundedInteger(options.maxRetries, 2, "maxRetries");
  const maxRecords = boundedInteger(options.maxRecords, scenario.records.length, "maxRecords");
  const trace = options.trace ?? createTraceRecorder({ runId: options.runId ?? `run-${scenario.id}`, scenarioId: scenario.id, now: options.now });
  trace.record({ agent: "orchestrator", phase: "workflow", type: "instruction", payload: { mode: "deterministic", maxRecords, maxRetries } });

  let analysis;
  let attempts = 0;
  let recovered = false;
  if (options.policyAnalysis) {
    try {
      analysis = validatePolicyAnalysis(options.policyAnalysis, scenario);
    } catch (error) {
      traceFailure(trace, { phase: "analysis", type: "validation-failure", stage: "policy-analysis", attempt: 0, error });
      analysis = unresolvedAnalysis(scenario);
      const rankedCandidates = abstentionRanking(scenario).map((candidate) => ({ ...candidate, verifier: uncertainVerifier() }));
      return resultWithFinalTrace({ scenario, analysis, rankedCandidates, trace, attempts, escalated: true, recovered: true });
    }
  } else {
    const policyAnalyzer = options.policyAnalyzer ?? analyzePolicy;
    let lastError;
    for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
      attempts = attempt;
      try {
        const output = policyAnalyzer({ oldGuideline: scenario.oldGuideline, newGuideline: scenario.newGuideline, trace });
        analysis = validatePolicyAnalysis(output, scenario);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (error instanceof ContractError) traceFailure(trace, { phase: "analysis", type: "validation-failure", stage: "policy-analysis", attempt, error });
        if (attempt <= maxRetries) traceFailure(trace, { phase: "analysis", type: "retry", stage: "policy-analysis", attempt, error });
      }
    }
    if (!analysis) {
      if (policyAnalyzer === analyzePolicy) {
        traceFailure(trace, { phase: "analysis", type: "escalation", stage: "policy-analysis", attempt: attempts, error: lastError });
        analysis = validatePolicyAnalysis(recoverPolicyAnalysis(scenario), scenario);
        recovered = true;
      } else {
        traceFailure(trace, { phase: "analysis", type: "failed-stage", stage: "policy-analysis", attempt: attempts, error: lastError });
        trace.record({ agent: "orchestrator", phase: "workflow", type: "final-evidence", payload: { rankedRecordIds: [], escalated: true, status: "failed" } });
        throw lastError;
      }
    }
  }

  const candidateRanker = options.candidateRanker ?? rankImpactCandidates;
  let ranked;
  let rankingFailed = false;
  if (analysis.deltas.length === 0) {
    ranked = abstentionRanking(scenario);
    rankingFailed = true;
  } else {
    let lastError;
    for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
      try {
        ranked = validateCandidateRanking(candidateRanker({ scenario, analysis, trace }), scenario, analysis);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (error instanceof ContractError) traceFailure(trace, { phase: "ranking", type: "validation-failure", stage: "ranking", attempt, error });
        if (attempt <= maxRetries) traceFailure(trace, { phase: "ranking", type: "retry", stage: "ranking", attempt, error });
      }
    }
    if (!ranked) {
      traceFailure(trace, { phase: "ranking", type: "failed-stage", stage: "ranking", attempt: maxRetries + 1, error: lastError });
      ranked = abstentionRanking(scenario);
      rankingFailed = true;
    }
  }

  const verificationLimit = Math.min(maxRecords, ranked.length);
  const candidateVerifier = options.candidateVerifier ?? verifyCandidate;
  const rankedCandidates = ranked.map((candidate, index) => {
    if (index >= verificationLimit || rankingFailed) return { ...candidate, verifier: uncertainVerifier(index >= verificationLimit ? "Verification budget was exhausted before this candidate could be challenged." : undefined) };
    const { score: _score, scoreBreakdown: _scoreBreakdown, ...verifierCandidate } = candidate;
    let verifier;
    let lastError;
    for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
      try {
        verifier = validateVerifierResult(candidateVerifier({ candidate: verifierCandidate, scenario, analysis, trace }));
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (error instanceof ContractError) traceFailure(trace, { phase: "verification", type: "validation-failure", stage: "verification", attempt, error });
        if (attempt <= maxRetries) traceFailure(trace, { phase: "verification", type: "retry", stage: "verification", attempt, error });
      }
    }
    if (!verifier) {
      traceFailure(trace, { phase: "verification", type: "failed-stage", stage: "verification", attempt: maxRetries + 1, error: lastError });
      verifier = uncertainVerifier();
    }
    return { ...candidate, verifier };
  });
  const escalated = recovered || rankingFailed || rankedCandidates.some((candidate) => candidate.verifier.verdict === "uncertain");
  return resultWithFinalTrace({ scenario, analysis, rankedCandidates, trace, attempts, escalated, recovered });
}
