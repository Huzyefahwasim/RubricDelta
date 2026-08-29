import test from "node:test";
import assert from "node:assert/strict";

import {
  ProviderError,
  assertNoCredentialValues,
  canonicalJson,
  createProviderRequest,
  hashProviderRequest,
  normalizeUsage,
  validateJsonSchema,
  validateJsonValue,
} from "../src/providers/contracts.js";
import { createOpenAIProvider } from "../src/providers/openai.js";
import { createReplayProvider } from "../src/providers/replay.js";
import { EVALUATION_PROTOCOL } from "../src/evaluation/protocol.js";
import { getPrompt, listPrompts, promptRegistryBinding } from "../src/agents/prompt-registry.js";

const MODEL = "gpt-rubricdelta-test-2026-08-29";

function objectSchema(properties) {
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

const SIMPLE_SCHEMA = objectSchema({
  rules: { type: "array", items: { type: "string" } },
});

function prompt(role = "rule-compiler") {
  return getPrompt(role);
}

function request(overrides = {}) {
  const role = overrides.role ?? "rule-compiler";
  return createProviderRequest({
    role,
    prompt: overrides.prompt ?? prompt(role),
    input: overrides.input ?? { guideline: "Route access failures to Security." },
    schema: overrides.schema ?? SIMPLE_SCHEMA,
    model: overrides.model ?? MODEL,
    benchmarkId: overrides.benchmarkId ?? "rubricdelta-frozen-v1",
    caseId: overrides.caseId ?? "case-1",
    mode: overrides.mode ?? "advanced",
    repetition: overrides.repetition ?? 1,
    inputRefs: overrides.inputRefs ?? ["guideline-v2"],
  });
}

function responseEnvelope({
  text = '{"rules":[]}',
  status = "completed",
  model = MODEL,
  usage = { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
  id = "resp_test_1",
  contentType = "output_text",
} = {}) {
  return {
    id,
    object: "response",
    status,
    model,
    output: [{
      id: "msg_test_1",
      type: "message",
      role: "assistant",
      status: "completed",
      content: contentType === "refusal"
        ? [{ type: "refusal", refusal: "I cannot comply." }]
        : [{ type: contentType, text }],
    }],
    usage,
    error: null,
    incomplete_details: null,
  };
}

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function neverTimeoutSleep(ms, options = {}) {
  if (options.purpose === "timeout") return new Promise(() => {});
  return Promise.resolve();
}

function provider(fetchImpl, options = {}) {
  let time = 100;
  return createOpenAIProvider({
    apiKey: options.apiKey ?? "test-provider-key",
    model: options.model ?? MODEL,
    fetchImpl,
    now: options.now ?? (() => (time += 5)),
    sleep: options.sleep ?? neverTimeoutSleep,
    timeoutMs: options.timeoutMs ?? 100,
    maxResponseBytes: options.maxResponseBytes ?? 32 * 1024,
  });
}

test("canonical provider identity is sorted, stable, and rejects non-JSON object behavior", () => {
  const left = { z: [3, { b: true, a: null }], a: "first" };
  const right = { a: "first", z: [3, { a: null, b: true }] };
  assert.equal(canonicalJson(left), '{"a":"first","z":[3,{"a":null,"b":true}]}');
  assert.equal(canonicalJson(left), canonicalJson(right));

  const cycle = {};
  cycle.self = cycle;
  assert.throws(() => canonicalJson(cycle), /cycle/i);
  assert.throws(() => canonicalJson({ value: undefined }), /unsupported|undefined/i);
  assert.throws(() => canonicalJson({ value: Number.POSITIVE_INFINITY }), /finite/i);
  assert.throws(() => canonicalJson(new Date()), /plain JSON object/i);

  const accessor = {};
  Object.defineProperty(accessor, "value", { enumerable: true, get: () => "hidden side effect" });
  assert.throws(() => canonicalJson(accessor), /accessor/i);
});

test("provider requests bind prompt, model, public context, strict schema, and a SHA-256 identity", () => {
  const value = request();
  assert.equal(value.schemaVersion, 1);
  assert.deepEqual(Object.keys(value), [
    "schemaVersion", "role", "prompt", "model", "benchmarkId", "caseId", "mode",
    "repetition", "inputRefs", "input", "schema",
  ]);
  assert.equal(value.prompt.id, "rule-compiler");
  assert.equal(value.prompt.version, "v1");
  assert.match(value.prompt.sha256, /^[a-f0-9]{64}$/);
  assert.match(hashProviderRequest(value), /^[a-f0-9]{64}$/);
  assert.equal(hashProviderRequest(value), hashProviderRequest(structuredClone(value)));

  const changed = structuredClone(value);
  changed.input.guideline = "Different public input";
  assert.notEqual(hashProviderRequest(value), hashProviderRequest(changed));
});

test("strict JSON Schema accepts only the supported closed subset and validates independently", () => {
  const schema = objectSchema({
    id: { type: "string", minLength: 1 },
    count: { type: "integer", minimum: 0 },
    verdict: { type: ["string", "null"], enum: ["support", "reject", null] },
    items: {
      type: "array",
      minItems: 1,
      items: objectSchema({ enabled: { type: "boolean" } }),
    },
  });
  assert.doesNotThrow(() => validateJsonSchema(schema));
  assert.doesNotThrow(() => validateJsonValue({
    id: "x", count: 0, verdict: null, items: [{ enabled: true }],
  }, schema));
  assert.throws(() => validateJsonValue({
    id: "x", count: -1, verdict: null, items: [{ enabled: true }],
  }, schema), /minimum|schema/i);
  assert.throws(() => validateJsonValue({
    id: "x", count: 0, verdict: null, items: [{ enabled: true }], extra: true,
  }, schema), /additional|unknown/i);

  assert.throws(() => validateJsonSchema({ type: "object", properties: {}, required: [] }), /additionalProperties/i);
  assert.throws(() => validateJsonSchema({ type: "object", properties: { id: { type: "string" } }, required: [], additionalProperties: false }), /required/i);
  assert.throws(() => validateJsonSchema({ ...SIMPLE_SCHEMA, oneOf: [] }), /unsupported.*oneOf/i);
  assert.throws(() => validateJsonSchema({ type: "array" }), /items/i);
});

test("usage normalization rejects malformed or internally inconsistent counters", () => {
  assert.deepEqual(normalizeUsage({ input_tokens: 10, output_tokens: 4, total_tokens: 14 }), {
    inputTokens: 10,
    outputTokens: 4,
    totalTokens: 14,
  });
  assert.throws(() => normalizeUsage({ input_tokens: -1, output_tokens: 4, total_tokens: 3 }), /usage/i);
  assert.throws(() => normalizeUsage({ input_tokens: 10, output_tokens: 4, total_tokens: 99 }), /total/i);
  assert.throws(() => normalizeUsage({ input_tokens: 10.5, output_tokens: 4, total_tokens: 14.5 }), /integer/i);
});

test("the prompt registry exposes exactly five versioned hash-bound role instructions", () => {
  const expected = [
    "rule-compiler",
    "change-analyst",
    "impact-investigator",
    "independent-verifier",
    "direct-baseline",
  ];
  assert.deepEqual(listPrompts().map((item) => item.id), expected);
  for (const item of listPrompts()) {
    assert.equal(item.version, "v1");
    assert.match(item.filename, new RegExp(`^${item.id}\\.v1\\.md$`));
    assert.match(item.sha256, /^[a-f0-9]{64}$/);
    assert.ok(item.instruction.length > 120);
    assert.equal(item.sha256, promptRegistryBinding()[item.id].sha256);
  }
  assert.throws(() => getPrompt("skeptical-verifier"), /unknown prompt role/i);
});

test("OpenAI provider posts a strict non-stored Responses request and never puts its key in data", async () => {
  const calls = [];
  const live = provider(async (url, init) => {
    calls.push({ url, init });
    return jsonResponse(responseEnvelope());
  });
  const result = await live.complete(request());

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.openai.com/v1/responses");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.redirect, "manual");
  assert.equal(calls[0].init.headers.authorization, "Bearer test-provider-key");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.store, false);
  assert.equal(body.model, MODEL);
  assert.equal(body.text.format.type, "json_schema");
  assert.equal(body.text.format.strict, true);
  assert.deepEqual(body.text.format.schema, SIMPLE_SCHEMA);
  assert.equal(JSON.stringify(body).includes("test-provider-key"), false);

  assert.deepEqual(result.data, { rules: [] });
  assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 4, totalTokens: 14 });
  assert.equal(result.model, MODEL);
  assert.equal(result.responseId, "resp_test_1");
  assert.equal(result.transportAttempts, 1);
  assert.equal(result.estimatedCostUsd, null);
  assert.equal(JSON.stringify(result).includes("test-provider-key"), false);
});

test("OpenAI provider is fail-closed on credentials, redirect, envelope, output, schema, model, and usage", async (t) => {
  await t.test("missing credentials fail before fetch", async () => {
    let calls = 0;
    const live = createOpenAIProvider({ apiKey: " ", model: MODEL, fetchImpl: async () => { calls += 1; } });
    await assert.rejects(live.complete(request()), /OPENAI_API_KEY|credential/i);
    assert.equal(calls, 0);
  });

  const cases = [
    ["redirect", () => new Response("", { status: 302, headers: { location: "https://attacker.invalid" } }), /redirect/i],
    ["incomplete", () => jsonResponse(responseEnvelope({ status: "incomplete" })), /incomplete/i],
    ["refusal", () => jsonResponse(responseEnvelope({ contentType: "refusal" })), /refusal/i],
    ["fenced", () => jsonResponse(responseEnvelope({ text: '```json\n{"rules":[]}\n```' })), /fenced|single JSON/i],
    ["multiple JSON values", () => jsonResponse(responseEnvelope({ text: '{"rules":[]}\n{"rules":[]}' })), /single JSON|malformed/i],
    ["schema mismatch", () => jsonResponse(responseEnvelope({ text: '{"rules":"not-an-array"}' })), /schema/i],
    ["model mismatch", () => jsonResponse(responseEnvelope({ model: "different-model" })), /model/i],
    ["usage mismatch", () => jsonResponse(responseEnvelope({ usage: { input_tokens: 1, output_tokens: 1, total_tokens: 9 } })), /usage|total/i],
  ];
  for (const [name, fetchImpl, pattern] of cases) {
    await t.test(name, async () => {
      let calls = 0;
      const live = provider(async () => { calls += 1; return fetchImpl(); });
      await assert.rejects(live.complete(request()), pattern);
      assert.equal(calls, 1, `${name} must not be retried`);
    });
  }
});

test("OpenAI provider preserves completed-response usage on later rejection without leaking credentials", async () => {
  const live = provider(async () => jsonResponse(responseEnvelope({ text: '{"rules":"wrong"}' })));
  await assert.rejects(live.complete(request()), (error) => {
    assert.ok(error instanceof ProviderError);
    assert.deepEqual(error.telemetry.usage, { inputTokens: 10, outputTokens: 4, totalTokens: 14 });
    assert.equal(error.telemetry.model, MODEL);
    assert.equal(JSON.stringify(error).includes("test-provider-key"), false);
    return true;
  });
});

test("OpenAI provider retries exactly transient transport failures and stops at three total attempts", async (t) => {
  for (const status of [429, 500, 503]) {
    await t.test(`HTTP ${status}`, async () => {
      let calls = 0;
      const live = provider(async () => {
        calls += 1;
        return calls < 3
          ? jsonResponse({ error: { message: "transient" } }, { status })
          : jsonResponse(responseEnvelope());
      });
      const result = await live.complete(request());
      assert.equal(calls, 3);
      assert.equal(result.transportAttempts, 3);
    });
  }

  await t.test("fetch TypeError", async () => {
    let calls = 0;
    const live = provider(async () => {
      calls += 1;
      if (calls < 3) throw new TypeError("network unavailable");
      return jsonResponse(responseEnvelope());
    });
    assert.equal((await live.complete(request())).transportAttempts, 3);
    assert.equal(calls, 3);
  });

  await t.test("non-retryable 400", async () => {
    let calls = 0;
    const live = provider(async () => {
      calls += 1;
      return jsonResponse({ error: { message: "invalid" } }, { status: 400 });
    });
    await assert.rejects(live.complete(request()), /HTTP 400/i);
    assert.equal(calls, 1);
  });

  await t.test("provider timeout", async () => {
    let calls = 0;
    const live = provider(async () => {
      calls += 1;
      return new Promise(() => {});
    }, {
      sleep: async (_ms, options = {}) => {
        if (options.purpose === "timeout") return;
      },
    });
    await assert.rejects(live.complete(request()), /timed out/i);
    assert.equal(calls, 3);
  });

  await t.test("caller abort", async () => {
    let calls = 0;
    const controller = new AbortController();
    controller.abort(new Error("caller stopped"));
    const live = provider(async () => { calls += 1; return jsonResponse(responseEnvelope()); });
    await assert.rejects(live.complete(request(), { signal: controller.signal }), /abort/i);
    assert.equal(calls, 0);
  });
});

test("OpenAI provider bounds response bytes before parsing", async () => {
  let calls = 0;
  const live = provider(async () => {
    calls += 1;
    return jsonResponse(responseEnvelope({ text: JSON.stringify({ rules: ["x".repeat(200)] }) }));
  }, { maxResponseBytes: 80 });
  await assert.rejects(live.complete(request()), /response.*large|byte limit/i);
  assert.equal(calls, 1);
});

function replayBinding(overrides = {}) {
  return {
    benchmark: {
      id: "rubricdelta-frozen-v1",
      sha256: "a".repeat(64),
      orderedCaseIds: ["case-1"],
      orderedRecordIdsByCase: { "case-1": ["record-1"] },
    },
    source: {
      kind: "deterministic-role-capture",
      sha256Canonicalization: "utf8-lf",
      sha256: "b".repeat(64),
      files: [{ path: "src/agents/policy-analyst.js", sha256: "c".repeat(64) }],
    },
    protocol: structuredClone(EVALUATION_PROTOCOL),

    prompts: promptRegistryBinding(),
    model: MODEL,
    mode: "advanced",
    repeats: 1,
    ...overrides,
  };
}

function replayFixture(requests, overrides = {}) {
  const supplied = new Map(requests.map((item) => [item.role, item]));
  const orderedRequests = [
    "rule-compiler",
    "change-analyst",
    "impact-investigator",
    "independent-verifier",
  ].map((role) => supplied.get(role) ?? request({ role, prompt: prompt(role), caseId: "case-1" }));
  return {
    schemaVersion: 1,
    artifactKind: "rubricdelta-exact-provider-replay",
    binding: replayBinding(overrides.binding),
    entries: orderedRequests.map((item, index) => ({
      sequence: index + 1,
      requestHash: hashProviderRequest(item),
      request: item,
      result: {
        data: { rules: [`result-${index + 1}`] },
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        responseId: `deterministic-capture-${String(index + 1).padStart(4, "0")}`,
        model: MODEL,
        latencyMs: 0,
        transportAttempts: 1,
        attempts: [{ attempt: 1, outcome: "deterministic-capture" }],
        estimatedCostUsd: 0,
      },
    })),
  };
}

test("replay consumes only the exact next request, clones results, and proves exhaustion", async () => {
  const first = request({ caseId: "case-1" });
  const second = request({ role: "change-analyst", caseId: "case-1", prompt: prompt("change-analyst") });
  const fixture = replayFixture([first, second]);
  const replay = createReplayProvider({ fixture, expectedBinding: fixture.binding });

  await assert.rejects(replay.complete(second), /sequence 1|request hash mismatch/i);
  const one = await replay.complete(first);
  one.data.rules.push("mutated by caller");
  assert.deepEqual(fixture.entries[0].result.data.rules, ["result-1"]);
  assert.deepEqual((await replay.complete(second)).data.rules, ["result-2"]);
  for (const entry of fixture.entries.slice(2)) await replay.complete(entry.request);
  assert.doesNotThrow(() => replay.assertExhausted());
  await assert.rejects(replay.complete(second), /exhausted|extra request/i);
});

test("replay rejects malformed sequence, request identity, bindings, secrets, and leftovers", async (t) => {
  const call = request();

  await t.test("duplicate sequence", () => {
    const fixture = replayFixture([call, call]);
    fixture.entries[1].sequence = 1;
    assert.throws(() => createReplayProvider({ fixture, expectedBinding: fixture.binding }), /sequence/i);
  });

  await t.test("stored request hash mismatch", () => {
    const fixture = replayFixture([call]);
    fixture.entries[0].requestHash = "0".repeat(64);
    assert.throws(() => createReplayProvider({ fixture, expectedBinding: fixture.binding }), /request hash/i);
  });

  for (const field of ["benchmark", "source", "prompts", "model", "mode", "repeats"]) {
    await t.test(`${field} binding mismatch`, () => {
      const fixture = replayFixture([call]);
      const expected = structuredClone(fixture.binding);
      if (field === "repeats") expected.repeats = 2;
      else if (field === "mode") expected.mode = "both";
      else if (field === "model") expected.model = "different-model";
      else expected[field] = { changed: true };
      assert.throws(() => createReplayProvider({ fixture, expectedBinding: expected }), new RegExp(field, "i"));
    });
  }

  await t.test("credential-like value", () => {
    const fixture = replayFixture([call]);
    fixture.entries[0].result.data.note = "Bearer should-not-be-committed";
    assert.throws(() => createReplayProvider({ fixture, expectedBinding: fixture.binding }), /credential|secret/i);
  });

  await t.test("leftover entry", () => {
    const fixture = replayFixture([call]);
    const replay = createReplayProvider({ fixture, expectedBinding: fixture.binding });
    assert.throws(() => replay.assertExhausted(), /4.*remaining|not exhausted/i);
  });
});

test("credential-value scanning catches harmless-key leaks without treating token counters as secrets", () => {
  assert.doesNotThrow(() => assertNoCredentialValues({ usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } }));
  assert.throws(() => assertNoCredentialValues({ harmless: "Bearer leaked-value" }), /credential/i);
  assert.throws(() => assertNoCredentialValues({ apiKey: "leaked-value" }), /credential/i);
  assert.throws(() => assertNoCredentialValues({ note: "sk-proj-abcdefghijklmnopqrstuvwxyz" }), /credential/i);
});
