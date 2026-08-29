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

function liveProvider(fetchImpl) {
  let tick = 0;
  return createOpenAIProvider({
    apiKey: API_KEY,
    model: MODEL,
    fetchImpl,
    now: () => { tick += 5; return tick; },
    sleep: (_ms, options = {}) => options.purpose === "timeout" ? new Promise(() => {}) : Promise.resolve(),
    maxResponseBytes: 1024 * 1024,
  });
}

function normalEnvelope() {
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
  };
}

test("OpenAI rejects a deeply nested bounded response with safe attempt telemetry", async () => {
  const base = JSON.stringify(normalEnvelope());
  const nested = `${"[".repeat(20_000)}null${"]".repeat(20_000)}`;
  const body = `${base.slice(0, -1)},"extra":${nested}}`;
  assert.ok(Buffer.byteLength(body, "utf8") < 1024 * 1024);

  const live = liveProvider(async () => new Response(body, {
    headers: { "content-type": "application/json" },
  }));
  await assert.rejects(live.complete(providerRequest()), (error) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.code, "OPENAI_INVALID_RESPONSE");
    assert.deepEqual(error.telemetry.attempts, [{ attempt: 1, outcome: "invalid-response" }]);
    assert.equal(`${error.message}\n${error.stack}\n${JSON.stringify(error.telemetry)}`.includes(API_KEY), false);
    return true;
  });
});

test("OpenAI request validation rejects a Proxy without invoking its traps or fetching", async () => {
  let traps = 0;
  let calls = 0;
  const hostile = new Proxy({}, {
    getPrototypeOf() { traps += 1; throw new Error(API_KEY); },
    ownKeys() { traps += 1; throw new Error(API_KEY); },
  });
  const raw = structuredClone(providerRequest());
  raw.input = hostile;
  const live = liveProvider(async () => { calls += 1; throw new Error("must not fetch"); });

  await assert.rejects(live.complete(raw), (error) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(`${error.message}\n${error.stack}\n${JSON.stringify(error.telemetry)}`.includes(API_KEY), false);
    return true;
  });
  assert.equal(traps, 0);
  assert.equal(calls, 0);
});

test("OpenAI statically maps invalid request paths that contain the configured key", async (t) => {
  await t.test("deep input property", async () => {
    let deep = "leaf";
    for (let index = 0; index < 70; index += 1) deep = { next: deep };
    const raw = structuredClone(providerRequest());
    raw.input = { [API_KEY]: deep };
    let calls = 0;
    const live = liveProvider(async () => { calls += 1; throw new Error("must not fetch"); });
    await assert.rejects(live.complete(raw), (error) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.code, "OPENAI_INVALID_REQUEST");
      assert.deepEqual(error.telemetry, {
        responseId: null,
        model: null,
        usage: null,
        transportAttempts: 0,
        attempts: [],
        latencyMs: 0,
      });
      assert.equal(`${error.message}\n${error.stack}\n${JSON.stringify(error.telemetry)}`.includes(API_KEY), false);
      return true;
    });
    assert.equal(calls, 0);
  });

  await t.test("invalid schema property", async () => {
    const raw = structuredClone(providerRequest());
    raw.schema = {
      type: "object",
      properties: {
        [API_KEY]: { type: "string", pattern: "(a+)+$" },
      },
      required: [API_KEY],
      additionalProperties: false,
    };
    let calls = 0;
    const live = liveProvider(async () => { calls += 1; throw new Error("must not fetch"); });
    await assert.rejects(live.complete(raw), (error) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.code, "OPENAI_INVALID_REQUEST");
      assert.equal(`${error.message}\n${error.stack}\n${JSON.stringify(error.telemetry)}`.includes(API_KEY), false);
      return true;
    });
    assert.equal(calls, 0);
  });
});
