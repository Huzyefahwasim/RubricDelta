import { citationResolves, validatePolicyAnalysis } from "./contracts.js";

function sameCitation(left, right) {
  return left && right
    && left.documentId === right.documentId
    && left.section === right.section
    && left.start === right.start
    && left.end === right.end
    && left.quote === right.quote;
}

function recordEvidenceResolves(evidence, record) {
  return Boolean(record
    && evidence.recordId === record.id
    && typeof evidence.quote === "string"
    && evidence.quote.length > 0
    && record.text.includes(evidence.quote));
}

function recordTrace(trace, type, payload) {
  trace?.record({ agent: "skeptical-verifier", phase: "verification", type, payload });
}

export function verifyCandidate({ candidate, scenario, analysis, trace } = {}) {
  const recordId = candidate?.recordId;
  const proposedLabel = candidate?.proposedLabel;
  const ruleDeltaIds = Array.isArray(candidate?.ruleDeltaIds) ? [...candidate.ruleDeltaIds] : [];
  const evidence = Array.isArray(candidate?.evidence) ? candidate.evidence.map((item) => structuredClone(item)) : [];
  const trustedRecord = scenario?.records?.find((item) => item.id === recordId);
  const trustedExistingLabel = trustedRecord?.existingLabel ?? "unknown label";
  recordTrace(trace, "instruction", { recordId, ruleDeltaIds, checks: ["same-delta-binding", "new-rule-citation", "trusted-record", "target-label", "precedence", "counterargument"] });

  let analysisValid = true;
  try {
    validatePolicyAnalysis(analysis, scenario);
  } catch (error) {
    analysisValid = false;
    recordTrace(trace, "validation-failure", { stage: "verification", errorCode: error.code ?? "INVALID_POLICY_ANALYSIS", recordId });
  }
  const deltas = analysisValid ? analysis.deltas.filter((delta) => ruleDeltaIds.includes(delta.id)) : [];
  const newRulesById = new Map((analysis?.newRules ?? []).map((rule) => [rule.id, rule]));
  const oldRulesById = new Map((analysis?.oldRules ?? []).map((rule) => [rule.id, rule]));
  const citationEvidence = evidence.filter((item) => item.type === "changed-rule-citation");
  const recordEvidence = evidence.filter((item) => item.type === "record-evidence");
  const citationMatchesDelta = (item, delta) => item.deltaId === delta.id
    && citationResolves(item.citation, scenario.newGuideline)
    && delta.newRuleIds
      .map((id) => newRulesById.get(id))
      .filter(Boolean)
      .some((rule) => sameCitation(rule.citation, item.citation));
  const precedenceMatchesDelta = (delta) => {
    const oldRules = delta.oldRuleIds.map((id) => oldRulesById.get(id)).filter(Boolean);
    const newRules = delta.newRuleIds.map((id) => newRulesById.get(id)).filter(Boolean);
    if (oldRules.length === 0 || newRules.length === 0) return false;
    const actualChange = oldRules.some((oldRule) => newRules.some((newRule) => oldRule.precedence !== newRule.precedence));
    return actualChange === delta.precedenceChanged;
  };
  const invalidCitation = citationEvidence.some((item) => !deltas.some((delta) => citationMatchesDelta(item, delta)));
  const invalidRecordEvidence = recordEvidence.some((item) => !recordEvidenceResolves(item, trustedRecord));
  const validRecordEvidence = recordEvidence.some((item) => recordEvidenceResolves(item, trustedRecord));
  const targetDeltas = deltas.filter((delta) => String(delta.targetLabel).replace(/[,:;.!?]+$/g, "").trim() === proposedLabel);
  const targetMatchesDelta = targetDeltas.length > 0;
  const supportingDelta = targetDeltas.find((delta) => precedenceMatchesDelta(delta)
    && citationEvidence.some((item) => citationMatchesDelta(item, delta)));
  const validCitation = Boolean(supportingDelta);
  const misboundCitation = citationEvidence.length > 0 && !supportingDelta;
  const candidateLabelTrusted = Boolean(trustedRecord && candidate?.existingLabel === trustedExistingLabel);
  const changesLabel = typeof proposedLabel === "string" && proposedLabel.trim() !== "" && proposedLabel !== trustedExistingLabel;
  const precedenceChecked = targetDeltas.some(precedenceMatchesDelta);
  const counterargument = `Alternative: the record could remain ${trustedExistingLabel} if the cited changed condition does not apply to its exact context.`;

  let verdict = "uncertain";
  if (!analysisValid || invalidCitation || misboundCitation || invalidRecordEvidence || !targetMatchesDelta || !candidateLabelTrusted || !changesLabel || !precedenceChecked) verdict = "reject";
  else if (validCitation && validRecordEvidence) verdict = "support";
  const evidenceComplete = verdict === "support";
  const result = { verdict, counterargument, evidenceComplete, precedenceChecked };
  recordTrace(trace, "action-result", {
    recordId,
    supportingDeltaId: supportingDelta?.id ?? null,
    validCitation,
    validRecordEvidence,
    targetMatchesDelta,
    candidateLabelTrusted,
    changesLabel,
    precedenceChecked,
    verdict,
    counterargument,
  });
  recordTrace(trace, "final-evidence", { recordId, verdict, evidenceComplete, supportingDeltaId: supportingDelta?.id ?? null, counterargument });
  return result;
}
