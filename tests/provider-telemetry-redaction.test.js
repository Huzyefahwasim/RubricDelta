import assert from "node:assert/strict";
import test from "node:test";

import { analyzeScenarioWithProvider } from "../src/agents/provider-workflow.js";
import { toPublicScenario } from "../src/domain/scenario.js";
import { loadBenchmark } from "../src/evaluation/index.js";
import { ProviderError } from "../src/providers/contracts.js";

test("failure telemetry projects attempts to safe fields before durable redacted trace", async () => {
  const marker = "RAW_FAILURE_DETAIL_MUST_NOT_PERSIST";
  const scenario = toPublicScenario(loadBenchmark().cases[0]);
  const provider = {
    name: "failure-probe",
    async complete() {
      throw new ProviderError("Static transport failure", "OPENAI_RETRY_EXHAUSTED", {
        telemetry: {
          responseId: null,
          model: null,
          usage: null,
          transportAttempts: 1,
          attempts: [{ attempt: 1, outcome: "transport-error", detail: marker }],
          latencyMs: 7,
          estimatedCostUsd: null,
        },
      });
    },
  };
  let error;
  try {
    await analyzeScenarioWithProvider(scenario, {
      provider,
      model: "deterministic-role-capture-v1",
      benchmarkId: loadBenchmark().benchmarkId,
      repetition: 1,
    });
  } catch (caught) { error = caught; }
  assert.ok(error instanceof ProviderError);
  const failed = error.trace.find((event) => event.type === "provider-result" && event.status === "failed");
  assert.deepEqual(failed.payload.attempts, [{ attempt: 1, outcome: "transport-error" }]);
  assert.equal(failed.redaction.applied, true);
  assert.doesNotMatch(`${error.stack}\n${JSON.stringify(error)}\n${JSON.stringify(error.trace)}`, new RegExp(marker));
});

test("schema-invalid provider output is withheld with truthful static redaction", async () => {
  const marker = "RAW_REJECTED_PROVIDER_OUTPUT_MUST_NOT_PERSIST";
  const scenario = toPublicScenario(loadBenchmark().cases[0]);
  let calls = 0;
  const provider = {
    name: "invalid-output-probe",
    async complete() {
      calls += 1;
      return {
        data: { marker },
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        responseId: `invalid-output-${calls}`,
        model: "deterministic-role-capture-v1",
        latencyMs: 1,
        transportAttempts: 1,
        attempts: [{ attempt: 1, outcome: "deterministic-capture" }],
        estimatedCostUsd: 0,
      };
    },
  };
  let error;
  try {
    await analyzeScenarioWithProvider(scenario, {
      provider,
      model: "deterministic-role-capture-v1",
      benchmarkId: loadBenchmark().benchmarkId,
      repetition: 1,
    });
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof ProviderError);
  assert.equal(calls, 3);
  const invalidResults = error.trace.filter((event) => event.type === "provider-result" && event.status === "invalid");
  assert.equal(invalidResults.length, 3);
  for (const event of invalidResults) {
    assert.deepEqual(event.redaction, { applied: true, fields: ["provider.output"] });
    assert.equal(Object.hasOwn(event.payload, "data"), false);
  }
  assert.doesNotMatch(`${error.stack}\n${JSON.stringify(error)}\n${JSON.stringify(error.trace)}`, new RegExp(marker));
});

test("invalid provider envelope is withheld with provider-output redaction", async () => {
  const marker = "RAW_INVALID_ENVELOPE_MUST_NOT_PERSIST";
  const scenario = toPublicScenario(loadBenchmark().cases[0]);
  const provider = {
    name: "invalid-envelope-probe",
    async complete() {
      return { rawEnvelopeField: marker };
    },
  };
  let error;
  try {
    await analyzeScenarioWithProvider(scenario, {
      provider,
      model: "deterministic-role-capture-v1",
      benchmarkId: loadBenchmark().benchmarkId,
      repetition: 1,
    });
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof ProviderError);
  const failed = error.trace.find((event) => event.type === "provider-result" && event.status === "failed");
  assert.ok(failed);
  assert.equal(failed.redaction.applied, true);
  assert.ok(failed.redaction.fields.includes("provider.output"));
  assert.doesNotMatch(`${error.stack}\n${JSON.stringify(error)}\n${JSON.stringify(error.trace)}`, new RegExp(marker));
});
