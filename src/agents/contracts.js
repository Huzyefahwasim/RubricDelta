const SCORE_KEYS = [
  "exactChangedScopePhraseMatches",
  "semanticEquivalentMatches",
  "existingLabelTransitionMatch",
  "boundaryConditionMatch",
  "alreadyAtTargetLabel",
  "explicitExclusionMatch",
];

export class ContractError extends Error {
  constructor(message, code = "INVALID_AGENT_OUTPUT") {
    super(message);
    this.name = "ContractError";
    this.code = code;
  }
}

function fail(message, code) {
  throw new ContractError(message, code);
}

function object(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function nonblank(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function strings(value, nonempty = false) {
  return Array.isArray(value)
    && (!nonempty || value.length > 0)
    && value.every(nonblank);
}

function cleanLabel(value) {
  return String(value ?? "").replace(/[,:;.!?]+$/g, "").trim();
}

function sameCitation(left, right) {
  return object(left) && object(right)
    && left.documentId === right.documentId
    && left.section === right.section
    && left.start === right.start
    && left.end === right.end
    && left.quote === right.quote;
}

export function citationResolves(citation, document) {
  return object(citation)
    && citation.documentId === document?.version
    && nonblank(citation.section)
    && Number.isInteger(citation.start)
    && Number.isInteger(citation.end)
    && citation.start >= 0
    && citation.end >= citation.start
    && typeof citation.quote === "string"
    && document.text.slice(citation.start, citation.end) === citation.quote;
}

function validateRule(rule, document, kind) {
  if (!object(rule) || !nonblank(rule.id) || !nonblank(rule.label)) fail(`${kind} rule is malformed`, "INVALID_POLICY_ANALYSIS");
  if (!strings(rule.conditions) || !strings(rule.exceptions) || typeof rule.precedence !== "boolean") fail(`${kind} rule fields are malformed`, "INVALID_POLICY_ANALYSIS");
  if (!citationResolves(rule.citation, document)) fail(`${kind} rule citation does not resolve`, "INVALID_POLICY_ANALYSIS");
}

export function validatePolicyAnalysis(analysis, scenario) {
  if (!object(analysis)
    || !Array.isArray(analysis.oldRules)
    || !Array.isArray(analysis.newRules)
    || !Array.isArray(analysis.deltas)
    || !strings(analysis.boundaryCases)) {
    fail("policy analysis shape is malformed", "INVALID_POLICY_ANALYSIS");
  }
  analysis.oldRules.forEach((rule) => validateRule(rule, scenario.oldGuideline, "old"));
  analysis.newRules.forEach((rule) => validateRule(rule, scenario.newGuideline, "new"));
  const oldById = new Map(analysis.oldRules.map((rule) => [rule.id, rule]));
  const newById = new Map(analysis.newRules.map((rule) => [rule.id, rule]));
  if (oldById.size !== analysis.oldRules.length || newById.size !== analysis.newRules.length) fail("rule IDs must be unique", "INVALID_POLICY_ANALYSIS");
  const deltaIds = new Set();
  for (const delta of analysis.deltas) {
    if (!object(delta) || !nonblank(delta.id) || deltaIds.has(delta.id) || !nonblank(delta.type) || !nonblank(delta.targetLabel)) fail("delta identity is malformed", "INVALID_POLICY_ANALYSIS");
    deltaIds.add(delta.id);
    if (!strings(delta.oldRuleIds, true) || !strings(delta.newRuleIds, true) || !strings(delta.sourceLabels, true)
      || !strings(delta.scopeTerms) || !strings(delta.boundaryCases) || typeof delta.precedenceChanged !== "boolean"
      || !Array.isArray(delta.citations)) fail(`delta ${delta.id} fields are malformed`, "INVALID_POLICY_ANALYSIS");
    const oldRules = delta.oldRuleIds.map((id) => oldById.get(id));
    const newRules = delta.newRuleIds.map((id) => newById.get(id));
    if (oldRules.some((rule) => !rule) || newRules.some((rule) => !rule)) fail(`delta ${delta.id} references unknown rules`, "INVALID_POLICY_ANALYSIS");
    if (!newRules.some((rule) => cleanLabel(rule.label) === cleanLabel(delta.targetLabel))) fail(`delta ${delta.id} target label is not a linked new rule`, "INVALID_POLICY_ANALYSIS");
    if (!oldRules.some((rule) => delta.citations.some((item) => sameCitation(item, rule.citation)))
      || !newRules.some((rule) => delta.citations.some((item) => sameCitation(item, rule.citation)))) {
      fail(`delta ${delta.id} lacks exact old and new citations`, "INVALID_POLICY_ANALYSIS");
    }
    const actualPrecedenceChange = oldRules.some((oldRule) => newRules.some((newRule) => oldRule.precedence !== newRule.precedence));
    if (delta.precedenceChanged !== actualPrecedenceChange) fail(`delta ${delta.id} precedence claim conflicts with linked rules`, "INVALID_POLICY_ANALYSIS");
  }
  if (analysis.deltas.length === 0 && analysis.unresolved !== true) fail("empty analysis must explicitly abstain", "INVALID_POLICY_ANALYSIS");
  return analysis;
}

export function validateCandidateRanking(ranking, scenario, analysis) {
  if (!Array.isArray(ranking) || ranking.length !== scenario.records.length) fail("ranking must contain every record", "INVALID_CANDIDATE_RANKING");
  const records = new Map(scenario.records.map((record) => [record.id, record]));
  const deltaIds = new Set(analysis.deltas.map((delta) => delta.id));
  const seen = new Set();
  for (const candidate of ranking) {
    if (!object(candidate) || !nonblank(candidate.recordId) || seen.has(candidate.recordId) || !records.has(candidate.recordId)) fail("ranking record IDs are invalid", "INVALID_CANDIDATE_RANKING");
    seen.add(candidate.recordId);
    const record = records.get(candidate.recordId);
    if (candidate.existingLabel !== record.existingLabel || !nonblank(candidate.proposedLabel) || !Number.isFinite(candidate.score)
      || !object(candidate.scoreBreakdown) || !strings(candidate.ruleDeltaIds) || !Array.isArray(candidate.evidence) || candidate.status !== "pending") {
      fail(`candidate ${candidate.recordId} fields are malformed`, "INVALID_CANDIDATE_RANKING");
    }
    if (candidate.ruleDeltaIds.some((id) => !deltaIds.has(id))) fail(`candidate ${candidate.recordId} references an unknown delta`, "INVALID_CANDIDATE_RANKING");
    if (Object.keys(candidate.scoreBreakdown).length !== SCORE_KEYS.length
      || SCORE_KEYS.some((key) => !Number.isInteger(candidate.scoreBreakdown[key]) || candidate.scoreBreakdown[key] < 0)) {
      fail(`candidate ${candidate.recordId} score breakdown is malformed`, "INVALID_CANDIDATE_RANKING");
    }
    const breakdown = candidate.scoreBreakdown;
    const expected = 4 * breakdown.exactChangedScopePhraseMatches
      + 2 * breakdown.semanticEquivalentMatches
      + 2 * breakdown.existingLabelTransitionMatch
      + breakdown.boundaryConditionMatch
      - 3 * breakdown.alreadyAtTargetLabel
      - 2 * breakdown.explicitExclusionMatch;
    if (candidate.score !== expected) fail(`candidate ${candidate.recordId} score does not match its evidence breakdown`, "INVALID_CANDIDATE_RANKING");
  }
  return ranking;
}

export function validateVerifierResult(result) {
  if (!object(result)
    || !["support", "reject", "uncertain"].includes(result.verdict)
    || !nonblank(result.counterargument)
    || typeof result.evidenceComplete !== "boolean"
    || typeof result.precedenceChecked !== "boolean") {
    fail("verifier output is malformed", "INVALID_VERIFIER_OUTPUT");
  }
  if (result.evidenceComplete !== (result.verdict === "support") || (result.verdict === "support" && !result.precedenceChecked)) {
    fail("verifier output fields are inconsistent", "INVALID_VERIFIER_OUTPUT");
  }
  return result;
}

export function validateAdvancedWorkflowResult(result, scenario) {
  if (!object(result) || !Array.isArray(result.rankedCandidates) || !Array.isArray(result.trace)
    || result.rankedCandidates.length !== scenario.records.length) {
    fail("advanced workflow shape is malformed", "INVALID_ADVANCED_RESULT");
  }
  const known = new Set(scenario.records.map((record) => record.id));
  const seen = new Set();
  for (const candidate of result.rankedCandidates) {
    if (!object(candidate) || !nonblank(candidate.recordId) || !known.has(candidate.recordId) || seen.has(candidate.recordId) || !Array.isArray(candidate.evidence)) {
      fail("advanced workflow ranking is malformed", "INVALID_ADVANCED_RESULT");
    }
    seen.add(candidate.recordId);
  }
  if (result.trace.some((event) => !object(event))) fail("advanced workflow trace is malformed", "INVALID_ADVANCED_RESULT");
  return result;
}
