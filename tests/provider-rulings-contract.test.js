import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  compilePolicyRules,
  recoverRuleChanges,
} from "../src/agents/policy-analyst.js";
import { createTraceRecorder } from "../src/agents/trace.js";
import { validateRuleChanges } from "../src/agents/provider-validation.js";
import { toPublicScenario } from "../src/domain/scenario.js";
import { loadBenchmark } from "../src/evaluation/index.js";

function trace(caseId) {
  return createTraceRecorder({ runId: `ruling-${caseId}`, scenarioId: caseId, now: () => "2026-08-29T00:00:00.000Z" });
}

test("recovered semantic projection accepts alternate rule and delta IDs and ordering", () => {
  const full = loadBenchmark().cases.find((item) => item.id === "perishable-delivery-quality");
  const scenario = toPublicScenario(full);
  const trustedCompiled = compilePolicyRules({ ...scenario, trace: trace(scenario.id) });
  const recovery = recoverRuleChanges(trustedCompiled);
  const oldId = new Map(trustedCompiled.oldRules.map((rule, index) => [rule.id, `old-alternate-${index + 1}`]));
  const newId = new Map(trustedCompiled.newRules.map((rule, index) => [rule.id, `new-alternate-${index + 1}`]));
  const compiled = {
    oldRules: trustedCompiled.oldRules.map((rule) => ({ ...rule, id: oldId.get(rule.id) })).reverse(),
    newRules: trustedCompiled.newRules.map((rule) => ({ ...rule, id: newId.get(rule.id) })).reverse(),
  };
  const data = {
    deltas: recovery.deltas.map(({ ambiguity: _ambiguity, ...delta }, index) => ({
      ...delta,
      id: `delta-alternate-${index + 1}`,
      oldRuleIds: delta.oldRuleIds.map((id) => oldId.get(id)).reverse(),
      newRuleIds: delta.newRuleIds.map((id) => newId.get(id)).reverse(),
      scopeTerms: [...delta.scopeTerms].reverse(),
      boundaryCases: [...delta.boundaryCases].reverse(),
      citations: [...delta.citations].reverse(),
    })).reverse(),
    boundaryCases: [...recovery.boundaryCases].reverse(),
  };
  const accepted = validateRuleChanges(data, scenario, compiled);
  assert.equal(accepted.recovered, true);
  assert.equal(accepted.unresolved, recovery.unresolved);
  assert.deepEqual(accepted.unresolvedRuleIds, [oldId.get("returns-1.4-r2")]);
  const returnedRuleIds = new Set([...compiled.oldRules, ...compiled.newRules].map((rule) => rule.id));
  assert.ok(accepted.unresolvedRuleIds.every((id) => returnedRuleIds.has(id)));
  assert.deepEqual(new Set(accepted.deltas.map((delta) => delta.id)), new Set(["delta-alternate-1", "delta-alternate-2"]));
});

test("live role prompts disclose every controller semantic contract before capture", () => {
  const compiler = readFileSync(new URL("../prompts/rule-compiler.v1.md", import.meta.url), "utf8");
  const analyst = readFileSync(new URL("../prompts/change-analyst.v1.md", import.meta.url), "utf8");
  const investigator = readFileSync(new URL("../prompts/impact-investigator.v1.md", import.meta.url), "utf8");
  const verifier = readFileSync(new URL("../prompts/independent-verifier.v1.md", import.meta.url), "utf8");

  assert.match(compiler, /one-to-one.*citation/i);
  assert.match(compiler, /semantic token.*condition.*exception/i);
  assert.match(compiler, /IDs? and order may differ/i);
  assert.match(analyst, /added.*removed.*label-changed.*priority-changed.*scope-changed.*scope-expanded.*scope-narrowed.*exception-changed/i);
  assert.match(analyst, /full semantic signature/i);
  assert.match(analyst, /grounded scope.*boundary/i);
  assert.match(analyst, /IDs? and order may differ/i);

  assert.match(investigator, /\+4.*exact.*\+2.*semantic.*\+2.*label.*\+1.*boundary.*-3.*target.*-2.*exclusion/is);
  assert.match(investigator, /scope-match.*label-transition.*boundary-condition.*explicit-exclusion.*changed-rule-citation.*record-evidence/is);
  assert.match(investigator, /score descending.*evidence count descending.*original record order/i);
  assert.match(verifier, /every referenced delta.*resolving changed-rule citation/i);
  assert.match(verifier, /nonblank.*current-record quote/i);
  assert.match(verifier, /original record order/i);
});

test("documented repair contract is bounded and never echoes attacker-controlled output", () => {
  const system = readFileSync(new URL("../docs/AGENT_SYSTEM.md", import.meta.url), "utf8");
  assert.match(system, /bounded static repair directive.*trusted schema path class/i);
  assert.match(system, /without repeating rejected output or attacker-controlled field names/i);
  assert.doesNotMatch(system, /names the invalid fields/i);
});
