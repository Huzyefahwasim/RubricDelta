import assert from "node:assert/strict";
import test from "node:test";

import { rankImpactCandidates } from "../src/agents/impact-investigator.js";
import { compilePolicyRules, analyzeRuleChanges } from "../src/agents/policy-analyst.js";
import { createTraceRecorder } from "../src/agents/trace.js";
import { validateCompiledRules, validateRuleChanges } from "../src/agents/provider-validation.js";
import { toPublicScenario } from "../src/domain/scenario.js";
import { loadBenchmark } from "../src/evaluation/index.js";

function trustedFraudChange() {
  const scenario = toPublicScenario(loadBenchmark().cases.find((item) => item.id === "fraud-overrides-refunds"));
  const trace = createTraceRecorder({
    runId: "semantic-grouping",
    scenarioId: scenario.id,
    now: () => "2026-08-29T00:00:00.000Z",
  });
  const compiled = compilePolicyRules({ ...scenario, trace });
  const changes = analyzeRuleChanges({ ...compiled, trace });
  return { scenario, compiled, changes };
}

function rankingProjection(scenario, compiled, changes, suffix) {
  const trace = createTraceRecorder({
    runId: `semantic-ranking-${suffix}`,
    scenarioId: scenario.id,
    now: () => "2026-08-29T00:00:00.000Z",
  });
  return rankImpactCandidates({
    scenario,
    analysis: { ...compiled, ...changes },
    trace,
  }).map((item) => ({
    recordId: item.recordId,
    score: item.score,
    scoreBreakdown: item.scoreBreakdown,
    evidence: item.evidence,
  }));
}

function assertGroupingRejected(mutate, name) {
  const { scenario, compiled, changes } = trustedFraudChange();
  const data = structuredClone(changes);
  mutate(data);
  assert.throws(
    () => validateRuleChanges(data, scenario, compiled),
    /semantic signature|boundary cases|scope/i,
    name,
  );
}

test("change validation preserves boundary-case grouping independently at both layers", async (t) => {
  const mutations = [
    ["delta-only merged boundary cases", (data) => {
      const merged = `${data.deltas[0].boundaryCases[0]} ${data.deltas[0].boundaryCases[1]}`;
      data.deltas[0].boundaryCases.splice(0, 2, merged);
    }],
    ["top-level-only merged boundary cases", (data) => {
      const merged = `${data.boundaryCases[0]} ${data.boundaryCases[1]}`;
      data.boundaryCases.splice(0, 2, merged);
    }],
    ["delta-only split boundary cases", (data) => {
      assert.equal(data.deltas[0].boundaryCases[0], "Cases mentioning card-security");
      data.deltas[0].boundaryCases.splice(0, 1, "Cases mentioning card", "Cases mentioning security");
    }],
    ["top-level-only split boundary cases", (data) => {
      assert.equal(data.boundaryCases[0], "Cases mentioning card-security");
      data.boundaryCases.splice(0, 1, "Cases mentioning card", "Cases mentioning security");
    }],
  ];
  for (const [name, mutate] of mutations) {
    await t.test(name, () => assertGroupingRejected(mutate, name));
  }
});

test("change validation preserves scope-term grouping while allowing order", async (t) => {
  await t.test("merged scope terms are rejected", () => {
    assertGroupingRejected((data) => {
      const merged = `${data.deltas[0].scopeTerms[0]} ${data.deltas[0].scopeTerms[1]}`;
      data.deltas[0].scopeTerms.splice(0, 2, merged);
    }, "merged scope");
  });

  await t.test("split scope terms are rejected", () => {
    const { scenario, compiled, changes } = trustedFraudChange();
    const data = structuredClone(changes);
    const index = data.deltas[0].scopeTerms.indexOf("card-security");
    assert.notEqual(index, -1);
    data.deltas[0].scopeTerms.splice(index, 1, "card", "security");
    assert.throws(
      () => validateRuleChanges(data, scenario, compiled),
      /semantic signature|scope/i,
      "split scope",
    );
  });
});

function trustedFraudCompilation() {
  const scenario = toPublicScenario(loadBenchmark().cases.find((item) => item.id === "fraud-overrides-refunds"));
  const trace = createTraceRecorder({
    runId: "compiler-grouping",
    scenarioId: scenario.id,
    now: () => "2026-08-29T00:00:00.000Z",
  });
  return { scenario, compiled: compilePolicyRules({ ...scenario, trace }) };
}

function assertCompilerGroupingRejected(mutate, name) {
  const { scenario, compiled } = trustedFraudCompilation();
  const data = structuredClone(compiled);
  mutate(data);
  assert.throws(
    () => {
      validateCompiledRules({ oldRules: data.oldRules, newRules: data.newRules }, scenario);
    },
    /compiled rule|semantic|coverage/i,
    name,
  );
}

test("compiler validation preserves condition grouping", async (t) => {
  await t.test("merged condition elements are rejected", () => {
    assertCompilerGroupingRejected((data) => {
      const rule = data.newRules.find((item) => item.id === "billing-1.1-r1");
      rule.conditions.splice(0, 2, `${rule.conditions[0]} ${rule.conditions[1]}`);
    }, "merged conditions");
  });

  await t.test("split compound condition elements are rejected", () => {
    assertCompilerGroupingRejected((data) => {
      const rule = data.newRules.find((item) => item.id === "billing-1.1-r2");
      const index = rule.conditions.indexOf("card-compromise");
      assert.notEqual(index, -1);
      rule.conditions.splice(index, 1, "card", "compromise");
    }, "split conditions");
  });
});

test("compiler validation preserves exception grouping", async (t) => {
  await t.test("merged exception elements are rejected", () => {
    assertCompilerGroupingRejected((data) => {
      const rule = data.newRules.find((item) => item.id === "billing-1.1-r2");
      rule.exceptions.splice(0, 2, `${rule.exceptions[0]} ${rule.exceptions[1]}`);
    }, "merged exceptions");
  });

  await t.test("duplicated semantic exception elements are rejected", () => {
    assertCompilerGroupingRejected((data) => {
      const rule = data.newRules.find((item) => item.id === "billing-1.1-r2");
      const index = rule.exceptions.indexOf("customer");
      assert.notEqual(index, -1);
      rule.exceptions.splice(index, 1, "customer", "customers");
    }, "split exceptions");
  });
});

test("semantic element identity preserves normalized token sequence", async (t) => {
  await t.test("compiler condition phrase reversal is rejected after proving ranking drift", () => {
    const { scenario, compiled, changes } = trustedFraudChange();
    const data = structuredClone(compiled);
    const rule = data.newRules.find((item) => item.id === "billing-1.1-r2");
    const index = rule.conditions.indexOf("stolen-card");
    assert.notEqual(index, -1);
    rule.conditions[index] = "card-stolen";
    const attackedTrace = createTraceRecorder({
      runId: "semantic-grouping-condition-attack",
      scenarioId: scenario.id,
      now: () => "2026-08-29T00:00:00.000Z",
    });
    const attackedChanges = analyzeRuleChanges({ ...data, trace: attackedTrace });
    assert.notDeepEqual(
      rankingProjection(scenario, compiled, changes, "condition-trusted"),
      rankingProjection(scenario, data, attackedChanges, "condition-attacked"),
    );
    assert.throws(
      () => validateCompiledRules({ oldRules: data.oldRules, newRules: data.newRules }, scenario),
      /compiled rule|semantic|coverage/i,
    );
  });

  await t.test("delta scope phrase reversal is rejected", () => {
    assertGroupingRejected((data) => {
      const index = data.deltas[0].scopeTerms.indexOf("stolen-card");
      assert.notEqual(index, -1);
      data.deltas[0].scopeTerms[index] = "card-stolen";
    }, "scope token sequence");
  });

  await t.test("delta boundary phrase reversal is rejected after proving ranking drift", () => {
    const { scenario, compiled, changes } = trustedFraudChange();
    const data = structuredClone(changes);
    const index = data.deltas[0].boundaryCases.indexOf("Cases mentioning card-compromise");
    assert.notEqual(index, -1);
    data.deltas[0].boundaryCases[index] = "Cases mentioning compromise-card";
    assert.notDeepEqual(
      rankingProjection(scenario, compiled, changes, "boundary-trusted"),
      rankingProjection(scenario, compiled, data, "boundary-attacked"),
    );
    assert.throws(
      () => validateRuleChanges(data, scenario, compiled),
      /semantic signature|boundary cases|scope/i,
    );
  });

  await t.test("top-level boundary phrase reversal is rejected", () => {
    assertGroupingRejected((data) => {
      const index = data.boundaryCases.indexOf("Cases mentioning stolen-card");
      assert.notEqual(index, -1);
      data.boundaryCases[index] = "Cases mentioning card-stolen";
    }, "top-level boundary token sequence");
  });
});
