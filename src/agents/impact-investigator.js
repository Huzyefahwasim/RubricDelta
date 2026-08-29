import { matchSemanticScope, semanticTerms } from "../domain/semantics.js";

const LOW_INFORMATION_TERMS = new Set([
  "account", "case", "caused", "customer", "described", "even", "involving", "ordinary",
  "question", "report", "request", "route", "service", "text", "user", "when",
]);

function cleanLabel(label) {
  return String(label ?? "").replace(/[,:;.!?]+$/g, "").trim();
}

function ruleTerms(rule) {
  return [...new Set([...(rule?.conditions ?? []), ...(rule?.exceptions ?? [])])];
}

function changedScopeTerms(delta, analysis) {
  const oldRules = analysis.oldRules.filter((rule) => delta.oldRuleIds.includes(rule.id));
  const newRules = analysis.newRules.filter((rule) => delta.newRuleIds.includes(rule.id));
  const oldTerms = new Set(oldRules.flatMap(ruleTerms).flatMap(semanticTerms));
  const newTerms = [...new Set(newRules.flatMap(ruleTerms))];
  const changed = newTerms.filter((term) => semanticTerms(term).some((normalized) => !oldTerms.has(normalized)));
  const source = changed.length > 0 ? changed : delta.scopeTerms;
  return source.filter((term) => !semanticTerms(term).every((normalized) => LOW_INFORMATION_TERMS.has(normalized)));
}

function boundaryMatches(boundaryCases, recordText) {
  for (const boundaryCase of boundaryCases) {
    const terms = semanticTerms(boundaryCase)
      .filter((term) => !new Set(["case", "mention", "mentioning"]).has(term));
    if (terms.length < 2) continue;
    const matches = matchSemanticScope(terms, recordText);
    if (matches.length === terms.length) return { boundaryCase, matches };
  }
  return null;
}

function explicitExclusionMatches(delta, analysis, recordText) {
  const newRules = analysis.newRules.filter((rule) => delta.newRuleIds.includes(rule.id));
  const hasUnless = newRules.some((rule) => /\bunless\b/i.test(rule.citation?.quote ?? ""));
  if (!hasUnless) return [];
  return newRules.flatMap((rule) => matchSemanticScope(rule.exceptions ?? [], recordText));
}

function scoreFor(record, delta, analysis) {
  const targetLabel = cleanLabel(delta.targetLabel);
  const scopeEvidence = matchSemanticScope(changedScopeTerms(delta, analysis), record.text);
  const exact = scopeEvidence.filter((item) => item.matchType === "exact");
  const semantic = scopeEvidence.filter((item) => item.matchType === "semantic-equivalent");
  const sourceLabels = new Set(delta.sourceLabels.map(cleanLabel));
  const transition = targetLabel !== cleanLabel(record.existingLabel)
    && sourceLabels.has(cleanLabel(record.existingLabel));
  const boundary = boundaryMatches(delta.boundaryCases ?? analysis.boundaryCases ?? [], record.text);
  const alreadyTarget = targetLabel === cleanLabel(record.existingLabel);
  const exclusionEvidence = explicitExclusionMatches(delta, analysis, record.text);
  const breakdown = {
    exactChangedScopePhraseMatches: exact.length,
    semanticEquivalentMatches: semantic.length,
    existingLabelTransitionMatch: Number(transition),
    boundaryConditionMatch: Number(Boolean(boundary)),
    alreadyAtTargetLabel: Number(alreadyTarget),
    explicitExclusionMatch: Number(exclusionEvidence.length > 0),
  };
  const score = 4 * breakdown.exactChangedScopePhraseMatches
    + 2 * breakdown.semanticEquivalentMatches
    + 2 * breakdown.existingLabelTransitionMatch
    + breakdown.boundaryConditionMatch
    - 3 * breakdown.alreadyAtTargetLabel
    - 2 * breakdown.explicitExclusionMatch;

  const newRule = analysis.newRules.find((rule) => delta.newRuleIds.includes(rule.id));
  const evidence = scopeEvidence.map((item) => ({ type: "scope-match", deltaId: delta.id, ...item }));
  if (transition) evidence.push({ type: "label-transition", from: record.existingLabel, to: targetLabel, deltaId: delta.id });
  if (boundary) evidence.push({ type: "boundary-condition", deltaId: delta.id, boundaryCase: boundary.boundaryCase });
  if (exclusionEvidence.length > 0) evidence.push({ type: "explicit-exclusion", deltaId: delta.id, matches: exclusionEvidence });
  if (newRule?.citation) evidence.push({ type: "changed-rule-citation", deltaId: delta.id, citation: structuredClone(newRule.citation) });
  if (scopeEvidence.length > 0) evidence.push({ type: "record-evidence", recordId: record.id, quote: record.text });
  return { score, breakdown, targetLabel, evidence, delta };
}

export function rankImpactCandidates({ scenario, analysis, trace } = {}) {
  trace?.record({
    agent: "impact-investigator",
    phase: "ranking",
    type: "instruction",
    payload: { recordIds: scenario.records.map((record) => record.id), deltaIds: analysis.deltas.map((delta) => delta.id) },
  });
  const candidates = scenario.records.map((record, inputIndex) => {
    const scored = analysis.deltas.map((delta) => scoreFor(record, delta, analysis));
    const best = scored.sort((left, right) => right.score - left.score || right.evidence.length - left.evidence.length)[0] ?? {
      score: 0,
      breakdown: {
        exactChangedScopePhraseMatches: 0,
        semanticEquivalentMatches: 0,
        existingLabelTransitionMatch: 0,
        boundaryConditionMatch: 0,
        alreadyAtTargetLabel: 0,
        explicitExclusionMatch: 0,
      },
      targetLabel: record.existingLabel,
      evidence: [],
      delta: { id: "unresolved" },
    };
    return {
      recordId: record.id,
      existingLabel: record.existingLabel,
      proposedLabel: best.targetLabel,
      score: best.score,
      scoreBreakdown: best.breakdown,
      ruleDeltaIds: best.delta.id === "unresolved" ? [] : [best.delta.id],
      evidence: best.evidence,
      status: "pending",
      inputIndex,
    };
  });
  candidates.sort((left, right) => right.score - left.score || right.evidence.length - left.evidence.length || left.inputIndex - right.inputIndex);
  const result = candidates.map(({ inputIndex: _inputIndex, ...candidate }) => candidate);
  trace?.record({ agent: "impact-investigator", phase: "ranking", type: "action-result", payload: { rankedRecordIds: result.map((item) => item.recordId) } });
  trace?.record({ agent: "impact-investigator", phase: "ranking", type: "final-evidence", payload: { candidateCount: result.length, evidenceCounts: result.map((item) => ({ recordId: item.recordId, count: item.evidence.length })) } });
  return result;
}
