import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeBaselineWithProvider,
  analyzeScenarioWithProvider,
} from "../src/agents/provider-workflow.js";
import { toPublicScenario } from "../src/domain/scenario.js";
import { loadBenchmark } from "../src/evaluation/index.js";
import { ProviderError } from "../src/providers/contracts.js";

const MODEL = "deterministic-role-capture-v1";

async function captureWorkflow(run, scenario) {
  let calls = 0;
  const provider = {
    name: "scenario-prevalidation-probe",
    async complete() {
      calls += 1;
      throw new Error("must not call");
    },
  };
  let error;
  let result;
  try {
    result = await run(scenario, {
      provider,
      model: MODEL,
      benchmarkId: loadBenchmark().benchmarkId,
      repetition: 1,
    });
  } catch (caught) {
    error = caught;
  }
  return { calls, error, result };
}

function assertStaticScenarioFailure(outcome, marker) {
  const surface = `${String(outcome.error?.message ?? "")}\n${String(outcome.error?.stack ?? "")}\n${JSON.stringify(outcome.error ?? null)}\n${JSON.stringify(outcome.result ?? null)}`;
  assert.equal(surface.includes(marker), false);
  assert.equal(outcome.calls, 0);
  assert.ok(outcome.error instanceof ProviderError);
  assert.equal(outcome.error.code, "INVALID_PROVIDER_INPUT");
  assert.equal(outcome.error.message, "Provider scenario failed safe public-input validation");
  assert.deepEqual(outcome.error.trace, []);
}

test("direct provider workflows credential-scan the complete scenario before calls", async (t) => {
  for (const [system, run] of [
    ["baseline", analyzeBaselineWithProvider],
    ["advanced", analyzeScenarioWithProvider],
  ]) {
    for (const location of ["title", "later-record-text"]) {
      await t.test(`${system} ${location}`, async () => {
        const marker = `sk-direct${system}${location.replaceAll("-", "")}2026`;
        const scenario = structuredClone(toPublicScenario(loadBenchmark().cases[0]));
        if (location === "title") scenario.title = `Public title with ${marker}`;
        else scenario.records.at(-1).text = `Public record with ${marker}`;
        assertStaticScenarioFailure(await captureWorkflow(run, scenario), marker);
      });
    }
  }
});
