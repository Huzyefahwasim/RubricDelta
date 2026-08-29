import { EvidenceError, extractRoutingRules } from "../domain/rules.js";

export { EvidenceError };

function overlap(left, right) {
  const rightTerms = new Set(right);
  return left.filter((term) => rightTerms.has(term));
}

function sameTerms(left, right) {
  return left.length === right.length && overlap(left, right).length === left.length;
}

function ruleTerms(rule) {
  return [...new Set([...rule.conditions, ...rule.exceptions])].sort();
}

function pairFor(oldRule, newRules) {
  const exact = newRules.find((rule) => rule.label === oldRule.label);
  if (exact) return exact;
  const oldTerms = ruleTerms(oldRule);
  return newRules.find((rule) => overlap(oldTerms, ruleTerms(rule)).length > 0);
}

function relatedRule(rule, candidates) {
  const matches = candidates
    .map((candidate) => ({ candidate, score: overlap(ruleTerms(rule), ruleTerms(candidate)).length }))
    .filter((match) => match.score > 0)
    .sort((left, right) => right.score - left.score || left.candidate.id.localeCompare(right.candidate.id));
  return matches[0]?.candidate;
}

function details(oldRule, newRule, type) {
  const oldTerms = ruleTerms(oldRule);
  const newTerms = ruleTerms(newRule);
  return {
    id: `delta-${oldRule.id}-${newRule.id}`,
    type,
    oldRuleIds: [oldRule.id],
    newRuleIds: [newRule.id],
    targetLabel: newRule.label,
    sourceLabels: [oldRule.label],
    scopeTerms: [...new Set([...oldTerms, ...newTerms])].sort(),
    boundaryCases: [...new Set([...oldTerms, ...newTerms])].map((term) => `Cases mentioning ${term}`),
    precedenceChanged: oldRule.precedence !== newRule.precedence,
    citations: [oldRule.citation, newRule.citation],
  };
}

function deltaFor(oldRule, newRule) {
  const oldTerms = ruleTerms(oldRule);
  const newTerms = ruleTerms(newRule);
  const precedenceChanged = oldRule.precedence !== newRule.precedence;
  if (oldRule.label === newRule.label && sameTerms(oldTerms, newTerms) && !precedenceChanged) return null;
  let type = "label-changed";
  if (precedenceChanged) type = "priority-changed";
  else if (!sameTerms(oldRule.exceptions, newRule.exceptions)) type = "exception-changed";
  else if (oldRule.label === newRule.label && oldTerms.every((term) => newTerms.includes(term))) type = "scope-expanded";
  else if (oldRule.label === newRule.label && newTerms.every((term) => oldTerms.includes(term))) type = "scope-narrowed";
  return details(oldRule, newRule, type);
}

function requireTrace(trace) {
  if (!trace || typeof trace.record !== "function" || typeof trace.events !== "function") {
    throw new EvidenceError("A trace recorder is required for policy analysis");
  }
  return trace;
}

export function analyzePolicy({ oldGuideline, newGuideline, trace } = {}) {
  requireTrace(trace);
  trace.record({ agent: "policy-analyst", phase: "analysis", type: "instruction", payload: { oldGuidelineVersion: oldGuideline?.version, newGuidelineVersion: newGuideline?.version } });
  const oldRules = extractRoutingRules(oldGuideline);
  const newRules = extractRoutingRules(newGuideline);
  const deltas = [];
  const pairedNew = new Set();
  for (const oldRule of oldRules) {
    const newRule = pairFor(oldRule, newRules.filter((rule) => !pairedNew.has(rule.id)));
    if (!newRule) {
      const related = relatedRule(oldRule, newRules);
      if (!related) throw new EvidenceError(`No evidence establishes a relationship for removed rule ${oldRule.id}`);
      deltas.push(details(oldRule, related, "removed"));
      continue;
    }
    pairedNew.add(newRule.id);
    const delta = deltaFor(oldRule, newRule);
    if (delta) deltas.push(delta);
  }
  for (const newRule of newRules.filter((rule) => !pairedNew.has(rule.id))) {
    const related = relatedRule(newRule, oldRules);
    if (!related) throw new EvidenceError(`No evidence establishes a relationship for added rule ${newRule.id}`);
    deltas.push(details(related, newRule, "added"));
  }
  trace.record({ agent: "policy-analyst", phase: "analysis", type: "action-result", payload: { oldRuleCount: oldRules.length, newRuleCount: newRules.length, deltaIds: deltas.map((delta) => delta.id) } });
  const result = { oldRules, newRules, deltas, boundaryCases: [...new Set(deltas.flatMap((delta) => delta.boundaryCases))] };
  trace.record({ agent: "policy-analyst", phase: "analysis", type: "final-evidence", payload: { deltaIds: deltas.map((delta) => delta.id), citationCount: deltas.flatMap((delta) => delta.citations).length } });
  return result;
}
