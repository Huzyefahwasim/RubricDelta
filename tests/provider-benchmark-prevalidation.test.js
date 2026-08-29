import assert from "node:assert/strict";
import test from "node:test";

import { toPublicScenario } from "../src/domain/scenario.js";
import {
  createProviderAdvancedPredictions,
  createProviderBaselinePredictions,
} from "../src/evaluation/provider-predictions.js";
import { loadBenchmark } from "../src/evaluation/index.js";
import { ProviderError } from "../src/providers/contracts.js";

function publicCase(fullCase) {
  return structuredClone(toPublicScenario(fullCase));
}

function publicBenchmark(full, cases) {
  return {
    benchmarkId: full.benchmarkId,
    reviewBudgetFraction: full.reviewBudgetFraction,
    cases,
  };
}

async function capturePredictions(createPredictions, benchmark) {
  let calls = 0;
  const provider = {
    name: "prevalidation-probe",
    async complete() {
      calls += 1;
      throw new Error("must not call");
    },
  };
  let error;
  let result;
  try {
    result = await createPredictions(benchmark, {
      provider,
      model: "deterministic-role-capture-v1",
      repetition: 1,
    });
  } catch (caught) {
    error = caught;
  }
  return { calls, error, result };
}

function assertStaticBenchmarkFailure(outcome, marker = null) {
  const surface = `${String(outcome.error?.message ?? "")}\n${String(outcome.error?.stack ?? "")}\n${JSON.stringify(outcome.error ?? null)}\n${JSON.stringify(outcome.result ?? null)}`;
  if (marker !== null) assert.equal(surface.includes(marker), false);
  assert.equal(outcome.calls, 0);
  assert.ok(outcome.error instanceof ProviderError);
  assert.equal(outcome.error.code, "INVALID_PROVIDER_BENCHMARK");
  assert.equal(outcome.error.message, "Provider benchmark failed safe public-only validation");
}

test("all public benchmark cases validate before either system's first provider call", async (t) => {
  for (const [name, createPredictions] of [
    ["baseline", createProviderBaselinePredictions],
    ["advanced", createProviderAdvancedPredictions],
  ]) {
    await t.test(name, async () => {
      const full = loadBenchmark();
      const first = publicCase(full.cases[0]);
      const second = publicCase(full.cases[1]);
      delete second.title;
      assertStaticBenchmarkFailure(await capturePredictions(
        createPredictions,
        publicBenchmark(full, [first, second]),
      ));
    });
  }
});

test("credential-shaped case IDs fail closed before calls or output metadata", async () => {
  const marker = "sk-abcdefghijklmnopqrstuvwx";
  const full = loadBenchmark();
  const item = publicCase(full.cases[0]);
  item.id = marker;
  assertStaticBenchmarkFailure(
    await capturePredictions(createProviderAdvancedPredictions, publicBenchmark(full, [item])),
    marker,
  );
});

test("credential-shaped record IDs fail closed before calls or output metadata", async () => {
  const marker = "sk-zyxwvutsrqponmlkjihgfedc";
  const full = loadBenchmark();
  const item = publicCase(full.cases[0]);
  item.records[0].id = marker;
  assertStaticBenchmarkFailure(
    await capturePredictions(createProviderBaselinePredictions, publicBenchmark(full, [item])),
    marker,
  );
});

test("credential-shaped values in a later case fail before either system calls the provider", async (t) => {
  for (const [system, createPredictions] of [
    ["baseline", createProviderBaselinePredictions],
    ["advanced", createProviderAdvancedPredictions],
  ]) {
    for (const location of ["title", "record-text"]) {
      await t.test(`${system} ${location}`, async () => {
        const marker = `sk-latercase${system}${location.replace("-", "")}2026`;
        const full = loadBenchmark();
        const first = publicCase(full.cases[0]);
        const second = publicCase(full.cases[1]);
        if (location === "title") second.title = `Public title containing ${marker}`;
        else second.records[0].text = `Public record containing ${marker}`;
        assertStaticBenchmarkFailure(
          await capturePredictions(createPredictions, publicBenchmark(full, [first, second])),
          marker,
        );
      });
    }
  }
});
