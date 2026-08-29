function sameCitation(left, right) {
  return left && right
    && left.documentId === right.documentId
    && left.section === right.section
    && left.start === right.start
    && left.end === right.end
    && left.quote === right.quote;
}

function citationResolves(citation, scenario) {
  const document = [scenario.oldGuideline, scenario.newGuideline]
    .find((item) => item.version === citation?.documentId);
  return Boolean(document
    && Number.isInteger(citation.start)
    && Number.isInteger(citation.end)
    && citation.start >= 0
    && citation.end >= citation.start
    && document.text.slice(citation.start, citation.end) === citation.quote);
}

function recordEvidenceResolves(evidence, scenario, recordId) {
  const record = scenario.records.find((item) => item.id === recordId);
  return Boolean(record
    && evidence.recordId === recordId
    && typeof evidence.quote === "string"
    && evidence.quote.length > 0
    && record.text.includes(evidence.quote));
}

function recordTrace(trace, type, payload) {
  trace?.record({ agent: "skeptical-verifier", phase: "verification", type, payload });
}

export function verifyCandidate({ candidate, scenario, analysis, trace } = {}) {
  const recordId = candidate?.recordId;
  const existingLabel = candidate?.existingLabel;
  const proposedLabel = candidate?.proposedLabel;
  const ruleDeltaIds = Array.isArray(candidate?.ruleDeltaIds) ? [...candidate.ruleDeltaIds] : [];
  const evidence = Array.isArray(candidate?.evidence) ? candidate.evidence.map((item) => structuredClone(item)) : [];
  recordTrace(trace, "instruction", { recordId, ruleDeltaIds, checks: ["citations", "target-label", "precedence", "counterargument"] });

  const deltas = analysis.deltas.filter((delta) => ruleDeltaIds.includes(delta.id));
  const allowedCitations = deltas.flatMap((delta) => delta.citations ?? []);
  const citationEvidence = evidence.filter((item) => item.type === "changed-rule-citation");
  const recordEvidence = evidence.filter((item) => item.type === "record-evidence");
  const invalidCitation = citationEvidence.some((item) => !citationResolves(item.citation, scenario)
    || !allowedCitations.some((citation) => sameCitation(citation, item.citation)));
  const validCitation = citationEvidence.some((item) => citationResolves(item.citation, scenario)
    && allowedCitations.some((citation) => sameCitation(citation, item.citation)));
  const invalidRecordEvidence = recordEvidence.some((item) => !recordEvidenceResolves(item, scenario, recordId));
  const validRecordEvidence = recordEvidence.some((item) => recordEvidenceResolves(item, scenario, recordId));
  const targetMatchesDelta = deltas.some((delta) => String(delta.targetLabel).replace(/[,:;.!?]+$/g, "").trim() === proposedLabel);
  const changesLabel = typeof proposedLabel === "string" && proposedLabel.trim() !== "" && proposedLabel !== existingLabel;
  const precedenceChecked = deltas.length > 0;
  const counterargument = `Alternative: the record could remain ${existingLabel} if the cited changed condition does not apply to its exact context.`;

  let verdict = "uncertain";
  if (invalidCitation || invalidRecordEvidence || !targetMatchesDelta || !changesLabel) verdict = "reject";
  else if (validCitation && validRecordEvidence && precedenceChecked) verdict = "support";
  const evidenceComplete = verdict === "support";
  const result = { verdict, counterargument, evidenceComplete, precedenceChecked };
  recordTrace(trace, "action-result", { recordId, validCitation, validRecordEvidence, targetMatchesDelta, changesLabel, verdict, counterargument });
  recordTrace(trace, "final-evidence", { recordId, verdict, evidenceComplete, counterargument });
  return result;
}
