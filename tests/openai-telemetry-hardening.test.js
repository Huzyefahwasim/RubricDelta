import test from "node:test";
import assert from "node:assert/strict";

import { ProviderError, createProviderRequest } from "../src/providers/contracts.js";
import { getPrompt } from "../src/agents/prompt-registry.js";
import { createOpenAIProvider } from "../src/providers/openai.js";

const MODEL = "deterministic-role-capture-v1";
const API_KEY = "opaque-provider-test-key-2026";
const SCHEMA = {
  type: "object",
  properties: { note: { type: "string" } },
  required: ["note"],
  additionalProperties: false,
};

function providerRequest() {
  return createProviderRequest({
    role: "rule-compiler",
    prompt: getPrompt("rule-compiler"),
    input: { guideline: "Public guideline." },
    schema: SCHEMA,
    model: MODEL,
    benchmarkId: "rubricdelta-frozen-v1",
    caseId: "case-1",
    mode: "advanced",
    repetition: 1,
    inputRefs: ["case-1"],
  });
}

function envelope(overrides = {}) {
  return {
    id: "resp_safe_1",
    object: "response",
    status: "completed",
    model: MODEL,
    output: [{
      id: "msg_safe_1",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: JSON.stringify({ note: "safe" }) }],
    }],
    usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
    error: null,
    incomplete_details: null,
    ...overrides,
  };
}

function liveProvider(fetchImpl) {
  let tick = 0;
  return createOpenAIProvider({
    apiKey: API_KEY,
    model: MODEL,
    fetchImpl,
    now: () => { tick += 5; return tick; },
    sleep: (_ms, options = {}) => options.purpose === "timeout" ? new Promise(() => {}) : Promise.resolve(),
    timeoutMs: 100,
    maxResponseBytes: 1024 * 1024,
  });
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}

test("OpenAI rejects invalid UTF-8 without retry and cancels the response body", async () => {
  const serialized = JSON.stringify(envelope());
  const marker = Buffer.from("safe", "utf8");
  const bytes = Buffer.from(serialized, "utf8");
  const markerIndex = bytes.indexOf(marker);
  assert.ok(markerIndex > 0);
  const invalid = Buffer.concat([
    bytes.subarray(0, markerIndex),
    Buffer.from([0xc3, 0x28]),
    bytes.subarray(markerIndex + marker.length),
  ]);
  let cancellations = 0;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(invalid);
      setTimeout(() => {
        try { controller.close(); } catch { /* Provider cancelled the invalid stream. */ }
      }, 10);
    },
    cancel() { cancellations += 1; },
  });
  let calls = 0;
  const live = liveProvider(async () => {
    calls += 1;
    return new Response(stream, { headers: { "content-type": "application/json" } });
  });

  await assert.rejects(live.complete(providerRequest()), (error) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.code, "OPENAI_INVALID_RESPONSE");
    assert.deepEqual(error.telemetry.attempts, [{ attempt: 1, outcome: "invalid-response" }]);
    return true;
  });
  assert.equal(calls, 1);
  assert.equal(cancellations, 1);
});

test("OpenAI emits allowlisted semantic outcomes for post-envelope failures", async (t) => {
  const cases = [
    ["usage", () => envelope({ usage: { input_tokens: 1, output_tokens: 1, total_tokens: 9 } }), "OPENAI_USAGE_INVALID", "invalid-usage"],
    ["model", () => envelope({ model: "different-model" }), "OPENAI_MODEL_MISMATCH", "model-mismatch"],
    ["incomplete", () => envelope({ status: "incomplete" }), "OPENAI_INCOMPLETE", "incomplete"],
    ["refusal", () => {
      const value = envelope();
      value.output[0].content = [{ type: "refusal", refusal: "Cannot comply." }];
      return value;
    }, "OPENAI_REFUSAL", "refusal"],
    ["fenced", () => {
      const value = envelope();
      value.output[0].content[0].text = '```json\n{"note":"safe"}\n```';
      return value;
    }, "OPENAI_FENCED_OUTPUT", "fenced-output"],
    ["schema", () => {
      const value = envelope();
      value.output[0].content[0].text = JSON.stringify({ note: 7 });
      return value;
    }, "OPENAI_SCHEMA_INVALID", "schema-invalid"],
    ["credential", () => {
      const value = envelope();
      value.output[0].content[0].text = JSON.stringify({ note: API_KEY });
      return value;
    }, "OPENAI_CREDENTIAL_IN_OUTPUT", "credential-output"],
  ];

  for (const [name, responseValue, code, outcome] of cases) {
    await t.test(name, async () => {
      let calls = 0;
      const live = liveProvider(async () => { calls += 1; return jsonResponse(responseValue()); });
      await assert.rejects(live.complete(providerRequest()), (error) => {
        assert.equal(error.code, code);
        assert.deepEqual(error.telemetry.attempts, [{ attempt: 1, outcome }]);
        assert.equal(`${error.message}\n${error.stack}\n${JSON.stringify(error.telemetry)}`.includes(API_KEY), false);
        return true;
      });
      assert.equal(calls, 1);
    });
  }
});
