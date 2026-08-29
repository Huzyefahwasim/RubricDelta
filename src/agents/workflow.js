import { validateScenario } from "../domain/validation.js";
import { extractRoutingRules } from "../domain/rules.js";
import { analyzePolicy, recoverRuleChanges } from "./policy-analyst.js";
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

function recoverPolicyAnalysis(scenario) {
  const oldRules = extractRoutingRules(scenario.oldGuideline);
  const newRules = extractRoutingRules(scenario.newGuideline);
  try {
    return { oldRules, newRules, ...recoverRuleChanges({ oldRules, newRules }) };
  } catch {
    throw new ContractError("Policy recovery requires cited old and new routing rules", "POLICY_RECOVERY_UNAVAILABLE");
  }
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

const TRACE_CONTRACT_ERROR_CODES = new Set([
  "INVALID_AGENT_OUTPUT",
  "INVALID_POLICY_ANALYSIS",
  "INVALID_CANDIDATE_RANKING",
  "INVALID_VERIFIER_OUTPUT",
  "INVALID_ADVANCED_RESULT",
  "POLICY_RECOVERY_UNAVAILABLE",
]);

function errorCode(error) {
  if (error instanceof ContractError) return TRACE_CONTRACT_ERROR_CODES.has(error.code) ? error.code : "STAGE_ERROR";
  if (error?.constructor === TypeError && error.name === "TypeError" && error.code === undefined) return "TYPE_ERROR";
  if (error?.constructor === RangeError && error.name === "RangeError" && error.code === undefined) return "RANGE_ERROR";
  if (error?.constructor === SyntaxError && error.name === "SyntaxError" && error.code === undefined) return "SYNTAX_ERROR";
  if (error?.constructor === Error && error.name === "Error" && error.code === undefined) return "Error";
  return "STAGE_ERROR";
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

function traceFailure(trace, { phase, type, stage, attempt, error }) {
  trace.record({ agent: "orchestrator", phase, type, payload: { stage, attempt, errorCode: errorCode(error) } });
}

function finalResult({ scenario, analysis, rankedCandidates, trace, attempts, escalated, recovered }) {
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
      return finalResult({ scenario, analysis, rankedCandidates, trace, attempts, escalated: true, recovered: true });
    }
  } else {
    const policyAnalyzer = options.policyAnalyzer ?? analyzePolicy;
    let lastError;
    for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
      attempts = attempt;
      try {
        analysis = validatePolicyAnalysis(policyAnalyzer({ oldGuideline: scenario.oldGuideline, newGuideline: scenario.newGuideline, trace }), scenario);
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
    if (index >= verificationLimit || rankingFailed) {
      return { ...candidate, verifier: uncertainVerifier(index >= verificationLimit ? "Verification budget was exhausted before this candidate could be challenged." : undefined) };
    }
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
  return finalResult({ scenario, analysis, rankedCandidates, trace, attempts, escalated, recovered });
}
