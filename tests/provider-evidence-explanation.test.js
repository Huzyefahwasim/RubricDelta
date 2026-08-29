import assert from "node:assert/strict";
import test from "node:test";

import { rankImpactCandidates } from "../src/agents/impact-investigator.js";
import { analyzeRuleChanges, compilePolicyRules } from "../src/agents/policy-analyst.js";
import { createTraceRecorder } from "../src/agents/trace.js";
import { validateCandidates } from "../src/agents/provider-validation.js";
import { toPublicScenario } from "../src/domain/scenario.js";
import { loadBenchmark } from "../src/evaluation/index.js";
import { canonicalJson } from "../src/providers/contracts.js";

function trace(caseId) {
  return createTraceRecorder({ runId: `explanation-${caseId}`, scenarioId: caseId, now: () => "2026-08-29T00:00:00.000Z" });
}

function normalizeEvidence(item) {
  return {
    type: String(item.type ?? "evidence"),
    deltaId: typeof item.deltaId === "string" ? item.deltaId : null,
    recordId: typeof item.recordId === "string" ? item.recordId : null,
    quote: typeof item.quote === "string" ? item.quote : null,
    citation: item.citation ?? null,
    detail: canonicalJson(item),
  };
}

test("controller rejects a forged scope-match explanation instead of preserving attacker narrative", () => {
  const scenario = toPublicScenario(loadBenchmark().cases[0]);
  const compiled = compilePolicyRules({ ...scenario, trace: trace(scenario.id) });
  const changes = analyzeRuleChanges({ ...compiled, trace: trace(scenario.id) });
  const analysis = { ...compiled, ...changes };
  const candidates = rankImpactCandidates({ scenario, analysis, trace: trace(scenario.id) })
    .map(({ status: _status, evidence, ...candidate }) => ({ ...candidate, evidence: evidence.map(normalizeEvidence) }));
  const candidate = candidates.find((item) => item.evidence.some((evidence) => evidence.type === "scope-match"));
  const evidence = candidate.evidence.find((item) => item.type === "scope-match");
  const detail = JSON.parse(evidence.detail);
  detail.explanation = "FORGED EXPLANATION ACCEPTED";
  evidence.detail = canonicalJson(detail);
  assert.throws(
    () => validateCandidates({ candidates }, scenario, analysis),
    /explanation|evidence|semantic/i,
  );
});
