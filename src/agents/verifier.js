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
  recordTrace(trace, "instruction", { recordId, ruleDeltaIds, checks: ["new-rule-citation", "trusted-record", "target-label", "precedence", "counterargument"] });

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
  const citationIsAllowed = (item) => {
    const delta = deltas.find((entry) => entry.id === item.deltaId);
    if (!delta || !citationResolves(item.citation, scenario.newGuideline)) return false;
    return delta.newRuleIds
      .map((id) => newRulesById.get(id))
      .filter(Boolean)
      .some((rule) => sameCitation(rule.citation, item.citation));
  };
  const invalidCitation = citationEvidence.some((item) => !citationIsAllowed(item));
  const validCitation = citationEvidence.some(citationIsAllowed);
  const invalidRecordEvidence = recordEvidence.some((item) => !recordEvidenceResolves(item, trustedRecord));
  const validRecordEvidence = recordEvidence.some((item) => recordEvidenceResolves(item, trustedRecord));
  const targetMatchesDelta = deltas.some((delta) => String(delta.targetLabel).replace(/[,:;.!?]+$/g, "").trim() === proposedLabel);
  const candidateLabelTrusted = Boolean(trustedRecord && candidate?.existingLabel === trustedExistingLabel);
  const changesLabel = typeof proposedLabel === "string" && proposedLabel.trim() !== "" && proposedLabel !== trustedExistingLabel;
  const precedenceChecked = analysisValid && deltas.length > 0 && deltas.every((delta) => {
    const oldRules = delta.oldRuleIds.map((id) => oldRulesById.get(id)).filter(Boolean);
    const newRules = delta.newRuleIds.map((id) => newRulesById.get(id)).filter(Boolean);
    if (oldRules.length === 0 || newRules.length === 0) return false;
    const actualChange = oldRules.some((oldRule) => newRules.some((newRule) => oldRule.precedence !== newRule.precedence));
    return actualChange === delta.precedenceChanged;
  });
  const counterargument = `Alternative: the record could remain ${trustedExistingLabel} if the cited changed condition does not apply to its exact context.`;

  let verdict = "uncertain";
  if (!analysisValid || invalidCitation || invalidRecordEvidence || !targetMatchesDelta || !candidateLabelTrusted || !changesLabel || !precedenceChecked) verdict = "reject";
  else if (validCitation && validRecordEvidence) verdict = "support";
  const evidenceComplete = verdict === "support";
  const result = { verdict, counterargument, evidenceComplete, precedenceChecked };
  recordTrace(trace, "action-result", {
    recordId,
    validCitation,
    validRecordEvidence,
    targetMatchesDelta,
    candidateLabelTrusted,
    changesLabel,
    precedenceChecked,
    verdict,
    counterargument,
  });
  recordTrace(trace, "final-evidence", { recordId, verdict, evidenceComplete, counterargument });
  return result;
}
