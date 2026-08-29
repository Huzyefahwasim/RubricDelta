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

function closestRule(rule, candidates) {
  return candidates
    .map((candidate) => ({ candidate, score: overlap(ruleTerms(rule), ruleTerms(candidate)).length }))
    .sort((left, right) => right.score - left.score || left.candidate.id.localeCompare(right.candidate.id))[0];
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
  else if (oldRule.label === newRule.label && oldTerms.every((term) => newTerms.includes(term))) type = "scope-expanded";
  else if (oldRule.label === newRule.label && newTerms.every((term) => oldTerms.includes(term))) type = "scope-narrowed";
  else if (!sameTerms(oldRule.exceptions, newRule.exceptions)) type = "exception-changed";
  return details(oldRule, newRule, type);
}

export function analyzePolicy({ oldGuideline, newGuideline, trace } = {}) {
  const oldRules = extractRoutingRules(oldGuideline);
  const newRules = extractRoutingRules(newGuideline);
  const deltas = [];
  const pairedNew = new Set();
  for (const oldRule of oldRules) {
    const newRule = pairFor(oldRule, newRules.filter((rule) => !pairedNew.has(rule.id)));
    if (!newRule) continue;
    pairedNew.add(newRule.id);
    const delta = deltaFor(oldRule, newRule);
    if (delta) deltas.push(delta);
  }
  for (const newRule of newRules.filter((rule) => !pairedNew.has(rule.id))) {
    const match = closestRule(newRule, oldRules);
    if (!match) throw new EvidenceError("A behavioral delta requires citations from both guideline versions");
    deltas.push(details(match.candidate, newRule, "added"));
  }
  const result = { oldRules, newRules, deltas, boundaryCases: [...new Set(deltas.flatMap((delta) => delta.boundaryCases))] };
  trace?.record({ agent: "policy-analyst", phase: "analysis", type: "rule-deltas", payload: { oldRuleCount: oldRules.length, newRuleCount: newRules.length, deltaIds: deltas.map((delta) => delta.id) } });
  return result;
}
