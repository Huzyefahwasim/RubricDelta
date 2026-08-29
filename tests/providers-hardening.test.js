import test from "node:test";
import assert from "node:assert/strict";

import {
  ProviderError,
  assertNoCredentialValues,
  canonicalJson,
  createProviderRequest,
  hashProviderRequest,
  normalizeUsage,
} from "../src/providers/contracts.js";
import { getPrompt, promptRegistryBinding } from "../src/agents/prompt-registry.js";
import { createOpenAIProvider } from "../src/providers/openai.js";
import { createReplayProvider } from "../src/providers/replay.js";
import { EVALUATION_PROTOCOL } from "../src/evaluation/protocol.js";

const MODEL = "gpt-rubricdelta-test-2026-08-29";
const BENCHMARK_ID = "rubricdelta-frozen-v1";

function objectSchema(properties) {
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}

const SCHEMA = objectSchema({ rules: { type: "array", items: { type: "string" } } });

function providerRequest(overrides = {}) {
  const role = overrides.role ?? "rule-compiler";
  return createProviderRequest({
    role,
    prompt: overrides.prompt ?? getPrompt(role),
    input: overrides.input ?? { guideline: "Route access failures to Security." },
    schema: overrides.schema ?? SCHEMA,
    model: overrides.model ?? MODEL,
    benchmarkId: overrides.benchmarkId ?? BENCHMARK_ID,
    caseId: overrides.caseId ?? "case-1",
    mode: overrides.mode ?? "advanced",
    repetition: overrides.repetition ?? 1,
    inputRefs: overrides.inputRefs ?? ["guideline-v2"],
    maxOutputTokens: overrides.maxOutputTokens ?? 2048,
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
      content: [{ type: "output_text", text: '{"rules":[]}' }],
    }],
    usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
    error: null,
    incomplete_details: null,
    ...overrides,
  };
}

function jsonResponse(body, { status = 200, contentType = "application/json" } = {}) {
  const headers = contentType === null ? {} : { "content-type": contentType };
  return new Response(JSON.stringify(body), { status, headers });
}

function inertSleep(_ms, options = {}) {
  if (options.purpose === "timeout") return new Promise(() => {});
  return Promise.resolve();
}

function openAI(fetchImpl, options = {}) {
  let tick = 0;
  return createOpenAIProvider({
    apiKey: "test-provider-key",
    model: MODEL,
    fetchImpl,
    now: () => { tick += 5; return tick; },
    sleep: options.sleep ?? inertSleep,
    timeoutMs: 100,
    maxResponseBytes: 32 * 1024,
  });
}

test("provider requests deeply freeze public input and bind an explicit output-token budget", () => {
  const value = providerRequest();
  assert.equal(value.maxOutputTokens, 2048);
  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.isFrozen(value.input), true);
  assert.equal(Object.isFrozen(value.prompt), true);
  assert.equal(Object.isFrozen(value.schema), true);
  assert.throws(() => { value.input.guideline = "mutated after hashing"; }, TypeError);
  assert.throws(() => { value.schema.properties.rules.type = "string"; }, TypeError);

  assert.throws(() => providerRequest({ maxOutputTokens: 0 }), /maxOutputTokens/i);
  assert.throws(() => providerRequest({ maxOutputTokens: 32_769 }), /maxOutputTokens/i);
  assert.throws(() => providerRequest({ input: { text: "x".repeat(1_048_577) } }), /input.*byte|large/i);
});

test("provider requests reject evaluator-only nested keys and credential values but allow prompt warnings", () => {
  for (const key of ["groundTruth", "affectedRecordIds", "expectedLabels", "rationales", "reviewOutcomes", "workerQuality"]) {
    assert.throws(() => providerRequest({ input: { nested: { [key]: [] } } }), new RegExp(`${key}|gold|evaluator`, "i"));
  }
  assert.doesNotThrow(() => providerRequest({
    input: { guideline: "The words ground truth are ordinary untrusted public text here." },
  }));
  assert.match(providerRequest().prompt.instruction, /ground truth/i);
  assert.throws(() => providerRequest({ input: { harmless: "Bearer leaked-provider-value" } }), /credential/i);
});

test("prompt binding rejects a forged 64-hex hash and canonicalizes CRLF to LF", () => {
  const real = getPrompt("rule-compiler");
  assert.throws(() => providerRequest({ prompt: { ...real, sha256: "0".repeat(64) } }), /prompt.*hash|sha256/i);
  assert.doesNotThrow(() => providerRequest({ prompt: { ...real, instruction: real.instruction.replaceAll("\n", "\r\n") } }));
});

test("canonical and credential scanners reject accessors without executing them", () => {
  let getterCalls = 0;
  const accessor = {};
  Object.defineProperty(accessor, "note", {
    enumerable: true,
    get() { getterCalls += 1; return "Bearer hidden-value"; },
  });
  assert.throws(() => canonicalJson(accessor), /accessor/i);
  assert.throws(() => assertNoCredentialValues(accessor), /accessor/i);
  assert.equal(getterCalls, 0);

  const cycle = {};
  cycle.self = cycle;
  assert.throws(() => assertNoCredentialValues(cycle), /cycle/i);
  assert.throws(() => assertNoCredentialValues({ authToken: "value" }), /credential/i);
  assert.throws(() => assertNoCredentialValues({ api_token: "value" }), /credential/i);
  assert.doesNotThrow(() => assertNoCredentialValues({ usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }));
});

test("usage rejects ambiguous aliases and unexpected malformed counters", () => {
  assert.throws(() => normalizeUsage({
    input_tokens: 1, inputTokens: 1, output_tokens: 1, total_tokens: 2,
  }), /ambiguous|alias/i);
  assert.throws(() => normalizeUsage({ input_tokens: 1, output_tokens: 1, total_tokens: 2, cached_tokens: -1 }), /cached_tokens|usage/i);
  assert.throws(() => normalizeUsage({ inputTokens: 1, outputTokens: 1, totalTokens: 2, mystery: 3 }), /mystery|usage/i);
});

test("OpenAI body separates hash-bound instruction from canonical public input and binds output tokens", async () => {
  let call;
  const provider = openAI(async (url, init) => {
    call = { url, init };
    return jsonResponse(envelope());
  });
  const expected = providerRequest({ maxOutputTokens: 512 });
  await provider.complete(expected);

  const body = JSON.parse(call.init.body);
  assert.equal(body.instructions, expected.prompt.instruction.replaceAll("\r\n", "\n"));
  assert.equal(body.max_output_tokens, 512);
  assert.equal(body.text.format.name, "rubricdelta_rule_compiler_v1");
  assert.match(body.text.format.name, /^[a-z][a-z0-9_]{0,63}$/);
  const inputText = body.input[0].content[0].text;
  const input = JSON.parse(inputText);
  assert.deepEqual(input.input, expected.input);
  assert.deepEqual(input.prompt, { id: expected.prompt.id, version: expected.prompt.version, sha256: expected.prompt.sha256 });
  assert.equal(inputText.includes(expected.prompt.instruction), false);
  assert.equal(call.init.body.includes("test-provider-key"), false);
});

test("OpenAI rejects wrong content type and every malformed completed envelope without retry", async (t) => {
  const cases = [
    ["wrong content type", () => jsonResponse(envelope(), { contentType: "text/plain" })],
    ["missing content type", () => jsonResponse(envelope(), { contentType: null })],
    ["missing id", () => jsonResponse(envelope({ id: undefined }))],
    ["wrong object", () => jsonResponse(envelope({ object: "chat.completion" }))],
    ["missing output", () => jsonResponse(envelope({ output: undefined, output_text: '{"rules":[]}' }))],
    ["nonnull error", () => jsonResponse(envelope({ error: { code: "server_error", message: "failed" } }))],
    ["nonnull incomplete details", () => jsonResponse(envelope({ incomplete_details: { reason: "max_output_tokens" } }))],
    ["message not completed", () => {
      const value = envelope();
      value.output[0].status = "in_progress";
      return jsonResponse(value);
    }],
    ["multiple output text", () => {
      const value = envelope();
      value.output[0].content.push({ type: "output_text", text: '{"rules":[]}' });
      return jsonResponse(value);
    }],
  ];

  for (const [name, response] of cases) {
    await t.test(name, async () => {
      let calls = 0;
      const provider = openAI(async () => { calls += 1; return response(); });
      await assert.rejects(provider.complete(providerRequest()), (error) => {
        assert.ok(error instanceof ProviderError);
        assert.equal(error.retryable, false);
        assert.match(error.code, /^OPENAI_/);
        return true;
      });
      assert.equal(calls, 1);
    });
  }
});

test("OpenAI errors never echo credentials from HTTP bodies, thrown errors, causes, or telemetry", async (t) => {
  await t.test("HTTP body", async () => {
    const provider = openAI(async () => jsonResponse({ error: { message: "test-provider-key" } }, { status: 400 }));
    await assert.rejects(provider.complete(providerRequest()), (error) => {
      assert.equal(error.code, "OPENAI_HTTP_ERROR");
      assert.equal(error.retryable, false);
      const surfaces = [error.message, error.stack, String(error.cause ?? ""), JSON.stringify(error.telemetry)];
      assert.ok(surfaces.every((surface) => !surface.includes("test-provider-key")));
      return true;
    });
  });

  await t.test("thrown adapter error", async () => {
    let calls = 0;
    const provider = openAI(async () => {
      calls += 1;
      throw new Error("test-provider-key in a programming error");
    });
    await assert.rejects(provider.complete(providerRequest()), (error) => {
      assert.equal(error.code, "OPENAI_FETCH_FAILED");
      assert.equal(error.retryable, false);
      assert.equal(`${error.message}\n${error.stack}\n${String(error.cause ?? "")}\n${JSON.stringify(error.telemetry)}`.includes("test-provider-key"), false);
      return true;
    });
    assert.equal(calls, 1);
  });
});

test("OpenAI transport exhaustion is exactly three attempts and returns bounded attempt telemetry", async (t) => {
  for (const [name, operation] of [
    ["429", async () => jsonResponse({ error: { message: "retry" } }, { status: 429 })],
    ["503", async () => jsonResponse({ error: { message: "retry" } }, { status: 503 })],
    ["network TypeError", async () => { throw new TypeError("network unavailable"); }],
  ]) {
    await t.test(name, async () => {
      let calls = 0;
      const provider = openAI(async (...args) => { calls += 1; return operation(...args); });
      await assert.rejects(provider.complete(providerRequest()), (error) => {
        assert.equal(error.code, "OPENAI_TRANSIENT_EXHAUSTED");
        assert.equal(error.retryable, true);
        assert.equal(error.telemetry.transportAttempts, 3);
        assert.deepEqual(error.telemetry.attempts.map((item) => item.attempt), [1, 2, 3]);
        return true;
      });
      assert.equal(calls, 3);
    });
  }
});

test("caller abort is non-retryable before fetch, during fetch, and during backoff", async (t) => {
  await t.test("during fetch", async () => {
    const controller = new AbortController();
    let calls = 0;
    const provider = openAI(async (_url, init) => {
      calls += 1;
      queueMicrotask(() => controller.abort());
      return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
    });
    await assert.rejects(provider.complete(providerRequest(), { signal: controller.signal }), (error) => error.code === "CALLER_ABORTED" && error.retryable === false);
    assert.equal(calls, 1);
  });

  await t.test("during backoff", async () => {
    const controller = new AbortController();
    let calls = 0;
    let announceBackoff;
    const backoff = new Promise((resolve) => { announceBackoff = resolve; });
    const provider = openAI(async () => {
      calls += 1;
      return jsonResponse({ error: { message: "retry" } }, { status: 429 });
    }, {
      sleep: (_ms, options = {}) => {
        if (options.purpose === "timeout") return new Promise(() => {});
        announceBackoff();
        return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
      },
    });
    const completion = provider.complete(providerRequest(), { signal: controller.signal });
    await backoff;
    controller.abort();
    await assert.rejects(completion, (error) => error.code === "CALLER_ABORTED");
    assert.equal(calls, 1);
  });
});

test("provider-owned timeout aborts the actual fetch signal on all three attempts", async () => {
  let calls = 0;
  let aborts = 0;
  const provider = openAI(async (_url, init) => {
    calls += 1;
    return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => {
      aborts += 1;
      reject(new DOMException("aborted", "AbortError"));
    }, { once: true }));
  }, {
    sleep: async (_ms, options = {}) => {
      if (options.purpose === "timeout") return;
    },
  });
  await assert.rejects(provider.complete(providerRequest()), (error) => error.code === "OPENAI_TRANSIENT_EXHAUSTED");
  assert.equal(calls, 3);
  assert.equal(aborts, 3);
});

function binding(overrides = {}) {
  return {
    benchmark: {
      id: BENCHMARK_ID,
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

function fixture(requests = [providerRequest()]) {
  const supplied = new Map(requests.map((item) => [item.role, item]));
  const orderedRequests = [
    "rule-compiler",
    "change-analyst",
    "impact-investigator",
    "independent-verifier",
  ].map((role) => supplied.get(role) ?? providerRequest({ role, prompt: getPrompt(role) }));
  const value = {
    schemaVersion: 1,
    artifactKind: "rubricdelta-exact-provider-replay",
    binding: binding(),
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
  return value;
}

test("replay validates sequence gaps, stored results, and semantic entry bindings before use", async (t) => {
  const cases = [
    ["sequence gap", (value) => { value.entries.push(structuredClone(value.entries[0])); value.entries[1].sequence = 3; }],
    ["schema-invalid data", (value) => { value.entries[0].result.data.rules = "wrong"; }],
    ["blank response ID", (value) => { value.entries[0].result.responseId = ""; }],
    ["wrong result model", (value) => { value.entries[0].result.model = "different-model"; }],
    ["bad result usage", (value) => { value.entries[0].result.usage.totalTokens = 1; }],
    ["bad source hash", (value) => { value.binding.source.sha256 = "bad"; }],
    ["bad prompt hash", (value) => { value.binding.prompts["rule-compiler"].sha256 = "bad"; }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, () => {
      const value = fixture();
      mutate(value);
      assert.throws(() => createReplayProvider({ fixture: value, expectedBinding: value.binding }), /sequence|schema|responseId|model|usage|hash|sha256/i);
    });
  }

  await t.test("request conflicts with binding after a valid hash recomputation", () => {
    const value = fixture();
    const conflicting = providerRequest({ model: "different-model" });
    value.entries[0].request = conflicting;
    value.entries[0].requestHash = hashProviderRequest(conflicting);
    assert.throws(() => createReplayProvider({ fixture: value, expectedBinding: value.binding }), /model.*binding|binding.*model/i);
  });
});

test("replay clones its fixture at construction so later caller mutation cannot alter evidence", async () => {
  const call = providerRequest();
  const value = fixture([call]);
  const replay = createReplayProvider({ fixture: value, expectedBinding: value.binding });
  value.entries[0].result.data.rules[0] = "mutated-after-construction";
  value.binding.model = "mutated-after-construction";
  assert.deepEqual((await replay.complete(call)).data.rules, ["result-1"]);
  for (const entry of replay.position().total === 4 ? fixture([call]).entries.slice(1) : []) {
    await replay.complete(entry.request);
  }
  assert.doesNotThrow(() => replay.assertExhausted());
});
