const SCORE_KEYS = Object.freeze([
  "exactChangedScopePhraseMatches",
  "semanticEquivalentMatches",
  "existingLabelTransitionMatch",
  "boundaryConditionMatch",
  "alreadyAtTargetLabel",
  "explicitExclusionMatch",
]);

function stringSchema({ nullable = false } = {}) {
  return { type: nullable ? ["string", "null"] : "string", minLength: 1 };
}

function integerSchema({ minimum } = {}) {
  return { type: "integer", ...(minimum === undefined ? {} : { minimum }) };
}

function arraySchema(items, { minItems } = {}) {
  return { type: "array", items, ...(minItems === undefined ? {} : { minItems }) };
}

function objectSchema(properties) {
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

const CITATION_SCHEMA = objectSchema({
  documentId: stringSchema(),
  section: stringSchema(),
  start: integerSchema({ minimum: 0 }),
  end: integerSchema({ minimum: 0 }),
  quote: stringSchema(),
});
const RULE_SCHEMA = objectSchema({
  id: stringSchema(),
  label: stringSchema(),
  conditions: arraySchema(stringSchema()),
  exceptions: arraySchema(stringSchema()),
  precedence: { type: "boolean" },
  citation: CITATION_SCHEMA,
});
const DELTA_SCHEMA = objectSchema({
  id: stringSchema(),
  type: stringSchema(),
  oldRuleIds: arraySchema(stringSchema(), { minItems: 1 }),
  newRuleIds: arraySchema(stringSchema(), { minItems: 1 }),
  targetLabel: stringSchema(),
  sourceLabels: arraySchema(stringSchema(), { minItems: 1 }),
  scopeTerms: arraySchema(stringSchema()),
  boundaryCases: arraySchema(stringSchema()),
  precedenceChanged: { type: "boolean" },
  citations: arraySchema(CITATION_SCHEMA, { minItems: 2 }),
});
const SCORE_BREAKDOWN_SCHEMA = objectSchema(Object.fromEntries(
  SCORE_KEYS.map((key) => [key, integerSchema({ minimum: 0 })]),
));
const NULLABLE_CITATION_SCHEMA = { ...CITATION_SCHEMA, type: ["object", "null"] };
const EVIDENCE_SCHEMA = objectSchema({
  type: stringSchema(),
  deltaId: stringSchema({ nullable: true }),
  recordId: stringSchema({ nullable: true }),
  quote: stringSchema({ nullable: true }),
  citation: NULLABLE_CITATION_SCHEMA,
  detail: stringSchema(),
});
const CANDIDATE_SCHEMA = objectSchema({
  recordId: stringSchema(),
  existingLabel: stringSchema(),
  proposedLabel: stringSchema(),
  score: integerSchema(),
  scoreBreakdown: SCORE_BREAKDOWN_SCHEMA,
  ruleDeltaIds: arraySchema(stringSchema()),
  evidence: arraySchema(EVIDENCE_SCHEMA),
});
const VERIFIER_CITATION_SCHEMA = objectSchema({ deltaId: stringSchema(), citation: CITATION_SCHEMA });
const VERIFICATION_SCHEMA = objectSchema({
  recordId: stringSchema(),
  ruleDeltaIds: arraySchema(stringSchema()),
  citations: arraySchema(VERIFIER_CITATION_SCHEMA),
  verdict: { type: "string", enum: ["support", "reject", "uncertain"] },
  counterargument: stringSchema(),
  evidenceComplete: { type: "boolean" },
  precedenceChecked: { type: "boolean" },
});
const BASELINE_RANKING_SCHEMA = objectSchema({
  recordId: stringSchema(),
  score: integerSchema(),
  matchedTerms: arraySchema(stringSchema()),
});

export const ROLE_SCHEMAS = Object.freeze({
  "rule-compiler": objectSchema({
    oldRules: arraySchema(RULE_SCHEMA, { minItems: 1 }),
    newRules: arraySchema(RULE_SCHEMA, { minItems: 1 }),
  }),
  "change-analyst": objectSchema({
    deltas: arraySchema(DELTA_SCHEMA),
    boundaryCases: arraySchema(stringSchema()),
  }),
  "impact-investigator": objectSchema({
    candidates: arraySchema(CANDIDATE_SCHEMA, { minItems: 1 }),
  }),
  "independent-verifier": objectSchema({
    verifications: arraySchema(VERIFICATION_SCHEMA, { minItems: 1 }),
  }),
  "direct-baseline": objectSchema({
    ranking: arraySchema(BASELINE_RANKING_SCHEMA, { minItems: 1 }),
  }),
});

export { SCORE_KEYS };
