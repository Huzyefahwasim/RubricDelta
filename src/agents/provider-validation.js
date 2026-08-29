import { types as utilTypes } from "node:util";

import {
  citationResolves,
  validateCandidateRanking,
  validatePolicyAnalysis,
  validateVerifierResult,
} from "./contracts.js";
import { rankImpactCandidates } from "./impact-investigator.js";
import {
  analyzeRuleChanges,
  EvidenceError,
  recoverRuleChanges,
} from "./policy-analyst.js";
import { SCORE_KEYS } from "./provider-schemas.js";
import { safeProviderTelemetry } from "./provider-trace.js";
import { extractRoutingRules } from "../domain/rules.js";
import { semanticTerms } from "../domain/semantics.js";
import { validateScenario } from "../domain/validation.js";
import {
  assertNoCredentialValues,
  canonicalJson,
  cloneJson,
  normalizeUsage,
  ProviderError,
} from "../providers/contracts.js";

const RESULT_KEYS = Object.freeze([
  "attempts", "data", "estimatedCostUsd", "latencyMs", "model", "responseId", "transportAttempts", "usage",
]);
const DELTA_TYPES = new Set([
  "added", "exception-changed", "label-changed", "priority-changed", "removed", "scope-changed", "scope-expanded", "scope-narrowed",
]);
const EVIDENCE_TYPES = new Set([
  "boundary-condition", "changed-rule-citation", "explicit-exclusion", "label-transition", "record-evidence", "scope-match",
]);
const BOUNDARY_GENERIC_TERMS = new Set(["case", "cases", "mention", "mentioning"]);
const MAX_BINDING_LENGTH = 256;

function nonblank(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function cleanLabel(value) {
  return String(value ?? "").replace(/[,:;.!?]+$/g, "").trim();
}

function sameJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function identitySet(values) {
  return values.map((value) => canonicalJson(value)).sort();
}

function sameSet(left, right) {
  return sameJson(identitySet(left), identitySet(right));
}

function tokenIdentity(values) {
  return [...new Set(values.flatMap((value) => semanticTerms(value)))].sort();
}

function groupedTokenIdentity(values, { boundary = false } = {}) {
  return values
    .map((value) => semanticTerms(value).filter((term) => !boundary || !BOUNDARY_GENERIC_TERMS.has(term)))
    .map((tokens) => canonicalJson(tokens))
    .sort();
}

function boundaryIdentity(values) {
  return groupedTokenIdentity(values, { boundary: true });
}

function scopeIdentity(values) {
  return groupedTokenIdentity(values);
}

function ruleTokenIdentity(rule, key) {
  return groupedTokenIdentity(rule[key]);
}

function citationIdentity(citation) {
  return canonicalJson(citation);
}

function ownDataDescriptors(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) {
    throw new Error("configuration is not a plain object");
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new Error("configuration has a custom prototype");
  }
  return Object.getOwnPropertyDescriptors(value);
}

function ownData(descriptors, key) {
  const descriptor = descriptors[key];
  if (!descriptor || descriptor.get || descriptor.set || !("value" in descriptor)) {
    throw new Error("configuration field is not plain data");
  }
  return descriptor.value;
}

export function safeErrorCode(value, fallback = "PROVIDER_STAGE_FAILED") {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(value) ? value : fallback;
}

export function safePublicScenario(value) {
  try {
    const scenario = cloneJson(value);
    validateScenario(scenario);
    assertNoCredentialValues(scenario);
    return scenario;
  } catch {
    const error = new ProviderError(
      "Provider scenario failed safe public-input validation",
      "INVALID_PROVIDER_INPUT",
    );
    error.trace = [];
    throw error;
  }
}

export function validateProviderOptions(options = {}) {
  try {
    const descriptors = ownDataDescriptors(options);
    const provider = ownData(descriptors, "provider");
    const model = ownData(descriptors, "model");
    const benchmarkId = ownData(descriptors, "benchmarkId");
    const repetition = ownData(descriptors, "repetition");
    const providerDescriptors = ownDataDescriptors(provider);
    const name = ownData(providerDescriptors, "name");
    const complete = ownData(providerDescriptors, "complete");
    if (!nonblank(name) || name.length > MAX_BINDING_LENGTH || typeof complete !== "function"
      || !nonblank(model) || model.length > MAX_BINDING_LENGTH
      || !nonblank(benchmarkId) || benchmarkId.length > MAX_BINDING_LENGTH
      || !Number.isInteger(repetition) || repetition < 1) {
      throw new Error("configuration values are invalid");
    }
    assertNoCredentialValues({ providerName: name, model, benchmarkId });
    const safeProvider = Object.freeze({
      name,
      complete: (...args) => complete.apply(provider, args),
    });
    return { provider: safeProvider, model, benchmarkId, repetition };
  } catch {
    throw new ProviderError("Provider execution configuration is invalid", "INVALID_PROVIDER_CONFIGURATION");
  }
}

export function validateProviderResult(value, requestedModel) {
  try {
    assertNoCredentialValues(value);
    const result = cloneJson(value);
    if (!result || typeof result !== "object" || Array.isArray(result)
      || !sameJson(Object.keys(result).sort(), RESULT_KEYS)) throw new Error("invalid result envelope");
    const usage = normalizeUsage(result.usage);
    if (!nonblank(result.responseId) || result.responseId.length > MAX_BINDING_LENGTH
      || !nonblank(result.model) || result.model.length > MAX_BINDING_LENGTH
      || !Number.isFinite(result.latencyMs) || result.latencyMs < 0
      || !Number.isInteger(result.transportAttempts) || result.transportAttempts < 1 || result.transportAttempts > 3
      || !Array.isArray(result.attempts) || result.attempts.length !== result.transportAttempts
      || result.attempts.some((item, index) => item?.attempt !== index + 1 || typeof item.outcome !== "string" || !/^[a-z0-9-]{1,48}$/.test(item.outcome))
      || !(result.estimatedCostUsd === null || (Number.isFinite(result.estimatedCostUsd) && result.estimatedCostUsd >= 0))) {
      throw new Error("invalid result telemetry");
    }
    const telemetry = safeProviderTelemetry({
      responseId: result.responseId,
      model: result.model,
      usage,
      transportAttempts: result.transportAttempts,
      attempts: result.attempts,
      latencyMs: result.latencyMs,
      estimatedCostUsd: result.estimatedCostUsd,
    });
    if (result.model !== requestedModel) {
      throw new ProviderError("Provider result model did not match the requested model", "PROVIDER_MODEL_MISMATCH", { telemetry });
    }
    return { ...result, usage, telemetry };
  } catch (error) {
    if (error instanceof ProviderError && error.code === "PROVIDER_MODEL_MISMATCH") throw error;
    throw new ProviderError("Provider returned an invalid result envelope", "PROVIDER_RESULT_INVALID");
  }
}

function trustedRulesFor(document) {
  return extractRoutingRules(document);
}

function validateRuleCollection(rules, document) {
  const trusted = trustedRulesFor(document);
  if (rules.length !== trusted.length || new Set(rules.map((rule) => rule.id)).size !== rules.length) {
    throw new Error("compiled rule coverage or IDs are invalid");
  }
  const trustedByCitation = new Map(trusted.map((rule) => [citationIdentity(rule.citation), rule]));
  const seen = new Set();
  for (const rule of rules) {
    if (!citationResolves(rule.citation, document)) throw new Error("compiled rule citation does not resolve");
    const identity = citationIdentity(rule.citation);
    const expected = trustedByCitation.get(identity);
    if (!expected || seen.has(identity)) throw new Error("compiled rule coverage is missing or duplicated");
    seen.add(identity);
    if (cleanLabel(rule.label) !== cleanLabel(expected.label)
      || rule.precedence !== expected.precedence
      || !sameJson(ruleTokenIdentity(rule, "conditions"), ruleTokenIdentity(expected, "conditions"))
      || !sameJson(ruleTokenIdentity(rule, "exceptions"), ruleTokenIdentity(expected, "exceptions"))) {
      throw new Error("compiled rule semantics conflict with its cited source");
    }
  }
}

export function validateCompiledRules(data, scenario) {
  validateRuleCollection(data.oldRules, scenario.oldGuideline);
  validateRuleCollection(data.newRules, scenario.newGuideline);
  return data;
}

function noOpTrace() {
  return { record() {}, events() { return []; } };
}

function projectRecovered(recovered) {
  return {
    deltas: recovered.deltas.map(({ ambiguity: _ambiguity, ...delta }) => delta),
    boundaryCases: recovered.boundaryCases,
  };
}

function trustedChangeProfile(scenario) {
  const compiled = {
    oldRules: trustedRulesFor(scenario.oldGuideline),
    newRules: trustedRulesFor(scenario.newGuideline),
  };
  try {
    return { expected: analyzeRuleChanges({ ...compiled, trace: noOpTrace() }), recovery: null, compiled };
  } catch (error) {
    if (!(error instanceof EvidenceError)) throw error;
    const recovery = recoverRuleChanges(compiled);
    return { expected: projectRecovered(recovery), recovery, compiled };
  }
}

function mappedUnresolvedRuleIds(profile, compiled) {
  if (!profile.recovery) return [];
  const trustedRules = [...profile.compiled.oldRules, ...profile.compiled.newRules];
  const acceptedRules = [...compiled.oldRules, ...compiled.newRules];
  const mapped = profile.recovery.unresolvedRuleIds.map((trustedId) => {
    const trusted = trustedRules.find((rule) => rule.id === trustedId);
    const accepted = trusted && acceptedRules.find((rule) => sameJson(rule.citation, trusted.citation));
    if (!accepted) throw new Error("recovery metadata could not be citation-mapped into accepted rule IDs");
    return accepted.id;
  });
  if (new Set(mapped).size !== mapped.length) throw new Error("recovery metadata maps to duplicate accepted rule IDs");
  return mapped;
}

function rulesForDelta(delta, compiled) {
  return {
    oldRules: delta.oldRuleIds.map((id) => compiled.oldRules.find((rule) => rule.id === id)),
    newRules: delta.newRuleIds.map((id) => compiled.newRules.find((rule) => rule.id === id)),
  };
}

function relationshipIdentity(delta, compiled) {
  const linked = rulesForDelta(delta, compiled);
  if (linked.oldRules.some((rule) => !rule) || linked.newRules.some((rule) => !rule)) throw new Error("delta references an unknown rule");
  return {
    old: linked.oldRules.map((rule) => citationIdentity(rule.citation)).sort(),
    new: linked.newRules.map((rule) => citationIdentity(rule.citation)).sort(),
  };
}

function groundedTerms(values, allowed, { boundary = false } = {}) {
  const tokens = tokenIdentity(values).filter((term) => !boundary || !BOUNDARY_GENERIC_TERMS.has(term));
  return tokens.length > 0 && tokens.every((term) => allowed.has(term));
}

function validateDeltaSemantics(delta, compiled) {
  if (!DELTA_TYPES.has(delta.type)) throw new Error("delta type is outside the allowlist");
  if (new Set(delta.oldRuleIds).size !== delta.oldRuleIds.length
    || new Set(delta.newRuleIds).size !== delta.newRuleIds.length
    || new Set(delta.sourceLabels).size !== delta.sourceLabels.length) throw new Error("delta bindings are duplicated");
  const { oldRules, newRules } = rulesForDelta(delta, compiled);
  if (oldRules.some((rule) => !rule) || newRules.some((rule) => !rule)) throw new Error("delta references unknown rules");
  const sourceLabels = oldRules.map((rule) => cleanLabel(rule.label));
  const targetLabels = newRules.map((rule) => cleanLabel(rule.label));
  if (!sameSet(delta.sourceLabels.map(cleanLabel), sourceLabels) || !targetLabels.includes(cleanLabel(delta.targetLabel))) {
    throw new Error("delta source or target label is not exact");
  }
  const precedenceChanged = oldRules.some((oldRule) => newRules.some((newRule) => oldRule.precedence !== newRule.precedence));
  if (delta.precedenceChanged !== precedenceChanged) throw new Error("delta precedence claim is false");
  const allowedTerms = new Set([...oldRules, ...newRules].flatMap((rule) => [
    ...tokenIdentity(rule.conditions), ...tokenIdentity(rule.exceptions),
  ]));
  if (!groundedTerms(delta.scopeTerms, allowedTerms)
    || delta.boundaryCases.some((item) => !groundedTerms([item], allowedTerms, { boundary: true }))) {
    throw new Error("delta scope or boundary term is not grounded");
  }
  const linkedCitations = [...oldRules, ...newRules].map((rule) => rule.citation);
  if (!delta.citations.every((citation) => linkedCitations.some((item) => sameJson(citation, item)))) {
    throw new Error("delta contains a citation outside its linked rules");
  }
}

function validateSemanticSignature(actual, expected) {
  if (actual.type !== expected.type
    || cleanLabel(actual.targetLabel) !== cleanLabel(expected.targetLabel)
    || !sameSet(actual.sourceLabels.map(cleanLabel), expected.sourceLabels.map(cleanLabel))
    || actual.precedenceChanged !== expected.precedenceChanged
    || !sameJson(scopeIdentity(actual.scopeTerms), scopeIdentity(expected.scopeTerms))
    || !sameJson(boundaryIdentity(actual.boundaryCases), boundaryIdentity(expected.boundaryCases))
    || !sameSet(actual.citations, expected.citations)) {
    throw new Error("delta full semantic signature conflicts with trusted cited changes");
  }
}

export function validateRuleChanges(data, scenario, compiled) {
  validatePolicyAnalysis({ ...compiled, ...data, ...(data.deltas.length === 0 ? { unresolved: true } : {}) }, scenario);
  for (const delta of data.deltas) validateDeltaSemantics(delta, compiled);
  const profile = trustedChangeProfile(scenario);
  const expectedByRelationship = new Map(profile.expected.deltas.map((delta) => [
    canonicalJson(relationshipIdentity(delta, profile.compiled)), delta,
  ]));
  const actualRelationships = data.deltas.map((delta) => relationshipIdentity(delta, compiled));
  const expectedRelationships = profile.expected.deltas.map((delta) => relationshipIdentity(delta, profile.compiled));
  const actualRelationshipKeys = actualRelationships.map((relationship) => canonicalJson(relationship));
  const expectedRelationshipKeys = expectedRelationships.map((relationship) => canonicalJson(relationship));
  if (new Set(actualRelationshipKeys).size !== actualRelationshipKeys.length
    || new Set(expectedRelationshipKeys).size !== expectedRelationshipKeys.length
    || !sameSet(actualRelationships, expectedRelationships)) {
    throw new Error("change relationship coverage is incomplete or duplicated");
  }
  for (const delta of data.deltas) {
    const expected = expectedByRelationship.get(canonicalJson(relationshipIdentity(delta, compiled)));
    if (!expected) throw new Error("change relationship is not trusted");
    validateSemanticSignature(delta, expected);
  }
  if (!sameJson(boundaryIdentity(data.boundaryCases), boundaryIdentity(profile.expected.boundaryCases))) {
    throw new Error("top-level boundary cases do not match trusted change semantics");
  }
  const expectedRelationshipOrder = new Map(
    expectedRelationshipKeys.map((key, index) => [key, index]),
  );
  const orderedDeltas = data.deltas
    .map((delta, index) => ({ delta, key: actualRelationshipKeys[index] }))
    .sort((left, right) => expectedRelationshipOrder.get(left.key) - expectedRelationshipOrder.get(right.key))
    .map((item) => item.delta);
  const orderedData = { ...data, deltas: orderedDeltas };
  return profile.recovery
    ? {
      ...orderedData,
      recovered: true,
      unresolved: profile.recovery.unresolved,
      unresolvedRuleIds: mappedUnresolvedRuleIds(profile, compiled),
    }
    : orderedData;
}

function normalizedEvidenceFields(detail) {
  return {
    type: String(detail.type ?? "evidence"),
    deltaId: typeof detail.deltaId === "string" ? detail.deltaId : null,
    recordId: typeof detail.recordId === "string" ? detail.recordId : null,
    quote: typeof detail.quote === "string" ? detail.quote : null,
    citation: detail.citation ?? null,
  };
}

const EVIDENCE_DETAIL_KEYS = Object.freeze({
  "scope-match": Object.freeze(["deltaId", "explanation", "matchType", "recordTerm", "scopeTerm", "type"]),
  "label-transition": Object.freeze(["deltaId", "from", "to", "type"]),
  "boundary-condition": Object.freeze(["boundaryCase", "deltaId", "type"]),
  "explicit-exclusion": Object.freeze(["deltaId", "matches", "type"]),
  "changed-rule-citation": Object.freeze(["citation", "deltaId", "type"]),
  "record-evidence": Object.freeze(["quote", "recordId", "type"]),
});

function evidenceProjection(item) {
  const expectedKeys = EVIDENCE_DETAIL_KEYS[item.type];
  if (!expectedKeys || !sameJson(Object.keys(item).sort(), expectedKeys)) {
    throw new Error("candidate evidence uses unexpected or missing type-specific fields");
  }
  if (item.type === "scope-match") {
    if (!nonblank(item.deltaId) || !nonblank(item.scopeTerm) || !nonblank(item.recordTerm)
      || !["exact", "semantic-equivalent"].includes(item.matchType) || !nonblank(item.explanation)) {
      throw new Error("scope evidence fields are malformed");
    }
    return {
      type: item.type,
      deltaId: item.deltaId,
      scopeTerm: item.scopeTerm,
      recordTerm: item.recordTerm,
      matchType: item.matchType,
      explanation: item.explanation,
    };
  }
  if (item.type === "label-transition") {
    if (!nonblank(item.deltaId) || !nonblank(item.from) || !nonblank(item.to)) throw new Error("label transition evidence is malformed");
    return { type: item.type, deltaId: item.deltaId, from: item.from, to: item.to };
  }
  if (item.type === "boundary-condition") {
    if (!nonblank(item.deltaId) || !nonblank(item.boundaryCase)) throw new Error("boundary evidence is malformed");
    return { type: item.type, deltaId: item.deltaId, boundaryCase: item.boundaryCase };
  }
  if (item.type === "explicit-exclusion") {
    if (!nonblank(item.deltaId) || !Array.isArray(item.matches) || item.matches.length === 0) {
      throw new Error("exclusion evidence is malformed");
    }
    return { type: item.type, deltaId: item.deltaId, matches: identitySet(item.matches) };
  }
  if (item.type === "changed-rule-citation") {
    if (!nonblank(item.deltaId) || !item.citation) throw new Error("changed-rule citation evidence is malformed");
    return { type: item.type, deltaId: item.deltaId, citation: item.citation };
  }
  if (!nonblank(item.recordId) || !nonblank(item.quote)) throw new Error("record evidence is malformed");
  return { type: item.type, recordId: item.recordId, quote: item.quote };
}

function citationMatchesDelta(citation, delta, analysis, scenario) {
  return citationResolves(citation, scenario.newGuideline)
    && delta.newRuleIds
      .map((id) => analysis.newRules.find((rule) => rule.id === id))
      .filter(Boolean)
      .some((rule) => sameJson(rule.citation, citation));
}

function validateEvidence(candidate, expected, scenario, analysis) {
  const record = scenario.records.find((item) => item.id === candidate.recordId);
  const seen = new Set();
  const evidenceSemantics = [];
  for (const evidence of candidate.evidence) {
    const identity = canonicalJson(evidence);
    if (!EVIDENCE_TYPES.has(evidence.type) || seen.has(identity)) throw new Error("candidate evidence type or identity is invalid");
    seen.add(identity);
    let detail;
    try { detail = JSON.parse(evidence.detail); } catch { throw new Error("candidate evidence detail is not JSON"); }
    if (canonicalJson(detail) !== evidence.detail
      || !sameJson(normalizedEvidenceFields(detail), {
        type: evidence.type,
        deltaId: evidence.deltaId,
        recordId: evidence.recordId,
        quote: evidence.quote,
        citation: evidence.citation,
      })) throw new Error("candidate evidence detail is unbound");
    if (evidence.deltaId !== null && !candidate.ruleDeltaIds.includes(evidence.deltaId)) throw new Error("candidate evidence references unknown delta");
    if (evidence.recordId !== null && evidence.recordId !== candidate.recordId) throw new Error("candidate evidence references another record");
    if (evidence.quote !== null && !record.text.includes(evidence.quote)) throw new Error("candidate record evidence quote is forged");
    if (evidence.citation !== null) {
      const delta = analysis.deltas.find((item) => item.id === evidence.deltaId);
      if (!delta || !citationMatchesDelta(evidence.citation, delta, analysis, scenario)) throw new Error("candidate citation is forged or misbound");
    }
    evidenceSemantics.push(evidenceProjection(detail));
  }
  const expectedEvidence = expected.evidence.map(evidenceProjection);
  if (candidate.proposedLabel !== expected.proposedLabel
    || candidate.score !== expected.score
    || !sameJson(candidate.scoreBreakdown, expected.scoreBreakdown)
    || !sameSet(candidate.ruleDeltaIds, expected.ruleDeltaIds)
    || !sameSet(evidenceSemantics, expectedEvidence)) {
    throw new Error("candidate score and evidence are not controller-recomputed from public semantics");
  }
}

export function validateCandidates(data, scenario, analysis) {
  const candidates = data.candidates.map((candidate) => ({ ...candidate, status: "pending" }));
  validateCandidateRanking(candidates, scenario, analysis);
  const expectedRanking = rankImpactCandidates({ scenario, analysis });
  const expectedById = new Map(expectedRanking.map((candidate) => [candidate.recordId, candidate]));
  for (const candidate of candidates) {
    if (new Set(candidate.ruleDeltaIds).size !== candidate.ruleDeltaIds.length) throw new Error("candidate delta IDs are duplicated");
    const expected = expectedById.get(candidate.recordId);
    if (!expected) throw new Error("candidate record is not trusted");
    validateEvidence(candidate, expected, scenario, analysis);
  }
  if (!sameJson(candidates.map((item) => item.recordId), expectedRanking.map((item) => item.recordId))) {
    throw new Error("candidate ranking order conflicts with controller-recomputed semantics");
  }
  return candidates;
}

function expectedVerifierCitations(candidate) {
  return candidate.evidence
    .filter((item) => item.type === "changed-rule-citation" && item.citation !== null)
    .map((item) => ({ deltaId: item.deltaId, citation: item.citation }));
}

function recordEvidenceResolves(candidate, scenario) {
  const record = scenario.records.find((item) => item.id === candidate.recordId);
  return candidate.evidence.some((item) => item.type === "record-evidence"
    && item.recordId === candidate.recordId
    && nonblank(item.quote)
    && record?.text.includes(item.quote));
}

export function validateVerifications(data, candidates, scenario, analysis) {
  if (data.verifications.length !== candidates.length) throw new Error("verifier must return every record exactly once");
  const byId = new Map();
  for (const verification of data.verifications) {
    if (byId.has(verification.recordId)) throw new Error("verifier record IDs are duplicated");
    const candidate = candidates.find((item) => item.recordId === verification.recordId);
    if (!candidate) throw new Error("verifier references unknown record");
    if (!sameSet(verification.ruleDeltaIds, candidate.ruleDeltaIds)) throw new Error("verifier delta IDs are missing, duplicated, or unknown");
    const expected = expectedVerifierCitations(candidate);
    if (!sameSet(verification.citations, expected)) throw new Error("verifier citations are missing, forged, or misbound");
    for (const item of verification.citations) {
      const delta = analysis.deltas.find((value) => value.id === item.deltaId);
      if (!delta || !citationMatchesDelta(item.citation, delta, analysis, scenario)) throw new Error("verifier citation does not resolve");
    }
    validateVerifierResult(verification);
    const citedDeltaIds = new Set(expected.map((item) => item.deltaId));
    if (verification.verdict === "support"
      && (candidate.ruleDeltaIds.length === 0
        || !candidate.ruleDeltaIds.every((id) => citedDeltaIds.has(id))
        || !recordEvidenceResolves(candidate, scenario))) {
      throw new Error("support verdict lacks exact rule citation coverage and a resolving current-record quote");
    }
    byId.set(verification.recordId, verification);
  }
  return candidates.map((candidate) => ({ ...candidate, verifier: cloneJson(byId.get(candidate.recordId)) }));
}

export function validateBaselineRanking(data, scenario) {
  if (data.ranking.length !== scenario.records.length) throw new Error("baseline ranking must contain every record");
  const known = new Set(scenario.records.map((item) => item.id));
  const seen = new Set();
  for (const item of data.ranking) {
    if (!known.has(item.recordId) || seen.has(item.recordId) || new Set(item.matchedTerms).size !== item.matchedTerms.length) {
      throw new Error("baseline ranking bindings are invalid");
    }
    seen.add(item.recordId);
  }
  return data.ranking;
}

export { SCORE_KEYS };
