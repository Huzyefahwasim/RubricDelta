import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import {
  ProviderError,
  assertNoCredentialValues,
  canonicalJson,
  createProviderRequest,
  hashProviderRequest,
} from "../src/providers/contracts.js";
import { getPrompt, promptRegistryBinding } from "../src/agents/prompt-registry.js";
import { createOpenAIProvider } from "../src/providers/openai.js";
import { createReplayProvider } from "../src/providers/replay.js";
import { EVALUATION_PROTOCOL } from "../src/evaluation/protocol.js";

const MODEL = "deterministic-role-capture-v1";
const API_KEY = "opaque-provider-test-key-2026";
const RELEASE_BENCHMARK_ID = "rubricdelta-support-guideline-drift-v1";
const RESPONSES_URL = "https://api.openai.com/v1/responses";
const SCHEMA = {
  type: "object",
  properties: { note: { type: "string" } },
  required: ["note"],
  additionalProperties: false,
};

function request(overrides = {}) {
  const role = overrides.role ?? "rule-compiler";
  return createProviderRequest({
    role,
    prompt: overrides.prompt ?? getPrompt(role),
    input: overrides.input ?? { guideline: "Public guideline." },
    schema: overrides.schema ?? SCHEMA,
    model: overrides.model ?? MODEL,
    benchmarkId: "rubricdelta-frozen-v1",
    caseId: "case-1",
    mode: overrides.mode ?? "advanced",
    repetition: 1,
    inputRefs: ["case-1"],
    maxOutputTokens: 512,
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

function cancellable(body, options = {}) {
  let cancellations = 0;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      setTimeout(() => {
        try { controller.close(); } catch { /* The provider already cancelled the rejected body. */ }
      }, 10);
    },
    cancel() { cancellations += 1; },
  });
  const headers = {};
  if (options.contentType !== null) headers["content-type"] = options.contentType ?? "application/json";
  if (options.contentLength !== undefined) headers["content-length"] = String(options.contentLength);
  const response = new Response(stream, { status: options.status ?? 200, headers });
  Object.defineProperty(response, "redirected", { value: options.redirected ?? false });
  Object.defineProperty(response, "url", { value: options.url ?? "" });
  return { response, cancellations: () => cancellations };
}

function inertSleep(_ms, options = {}) {
  return options.purpose === "timeout" ? new Promise(() => {}) : Promise.resolve();
}

function provider(fetchImpl, overrides = {}) {
  let tick = 0;
  return createOpenAIProvider({
    apiKey: overrides.apiKey ?? API_KEY,
    model: MODEL,
    fetchImpl,
    now: () => { tick += 5; return tick; },
    sleep: overrides.sleep ?? inertSleep,
    timeoutMs: 100,
    maxResponseBytes: overrides.maxResponseBytes ?? 32 * 1024,
    ...(overrides.maxRequestBytes === undefined ? {} : { maxRequestBytes: overrides.maxRequestBytes }),
  });
}

function assertAttempt(error, outcome) {
  assert.ok(error instanceof ProviderError);
  assert.equal(error.telemetry.transportAttempts, 1);
  assert.deepEqual(error.telemetry.attempts, [{ attempt: 1, outcome }]);
  assert.equal(Number.isFinite(error.telemetry.latencyMs), true);
  return true;
}

test("provider contracts bound recursive JSON depth and node count", () => {
  let deep = "leaf";
  for (let index = 0; index < 70; index += 1) deep = { next: deep };
  assert.throws(() => request({ input: deep }), /depth|complex/i);
  assert.throws(() => request({ input: { values: Array.from({ length: 10_001 }, () => null) } }), /node|complex/i);

  const oversizedSparse = [];
  oversizedSparse.length = 10_001;
  assert.throws(
    () => request({ input: { values: oversizedSparse } }),
    (error) => error instanceof ProviderError && /array length|complex/i.test(error.message),
  );

  assert.throws(() => request({
    schema: {
      type: "object",
      properties: { note: { type: "string", pattern: "(a+)+$" } },
      required: ["note"],
      additionalProperties: false,
    },
  }), /unsupported.*pattern|pattern.*unsupported/i);

  const oversizedKey = "k".repeat(1_048_577);
  assert.throws(
    () => canonicalJson({ [oversizedKey]: true }),
    /key.*byte|key.*large/i,
  );
});

test("all contract scanners reject deep graphs, proxies, and compound credential keys safely", () => {
  let deep = { reviewDecision: "private" };
  for (let index = 0; index < 70; index += 1) deep = { next: deep };

  for (const operation of [
    () => assertNoCredentialValues(deep),
    () => new ProviderError("safe", "SAFE", { telemetry: deep }),
    () => request({ input: deep }),
  ]) {
    assert.throws(operation, (error) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.code, "INVALID_PROVIDER_CONTRACT");
      assert.match(error.message, /depth|complex/i);
      return true;
    });
  }

  let trapCalls = 0;
  const trapped = new Proxy({}, {
    getPrototypeOf() {
      trapCalls += 1;
      throw new Error("PROXY_TRAP_MARKER");
    },
  });
  for (const operation of [
    () => canonicalJson(trapped),
    () => assertNoCredentialValues(trapped),
    () => new ProviderError("safe", "SAFE", { telemetry: trapped }),
    () => request({ input: trapped }),
  ]) {
    assert.throws(operation, (error) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.code, "INVALID_PROVIDER_CONTRACT");
      assert.equal(`${error.message}\n${error.stack}`.includes("PROXY_TRAP_MARKER"), false);
      return true;
    });
  }
  assert.equal(trapCalls, 0);

  const rawRequest = { ...request() };
  for (const [name, value] of [
    ["request options", rawRequest],
    ["prompt", rawRequest.prompt],
    ["inputRefs", [...rawRequest.inputRefs]],
  ]) {
    let readTraps = 0;
    const proxy = new Proxy(value, {
      get() {
        readTraps += 1;
        throw new Error(`${name.toUpperCase()}_PROXY_MARKER`);
      },
    });
    const options = name === "request options"
      ? proxy
      : { ...rawRequest, [name]: proxy };
    assert.throws(() => createProviderRequest(options), (error) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(`${error.message}\n${error.stack}`.includes("PROXY_MARKER"), false);
      return true;
    });
    assert.equal(readTraps, 0);
  }

  for (const key of ["openaiApiKey", "clientSecret", "privateKey", "secretKey"]) {
    assert.throws(() => assertNoCredentialValues({ [key]: "opaque" }), /credential/i);
  }
});

test("provider requests enforce cumulative bytes across refs and schema before serialization", () => {
  const base = { ...request() };
  const manyRefs = Array.from(
    { length: 300 },
    (_, index) => `ref-${String(index).padStart(3, "0")}-${"x".repeat(8_000)}`,
  );
  assert.throws(
    () => createProviderRequest({ ...base, inputRefs: manyRefs }),
    /cumulative|request.*byte|too large/i,
  );

  const properties = {};
  for (let index = 0; index < 500; index += 1) {
    properties[`field_${index}`] = {
      type: "string",
      description: `public-${index}-${"d".repeat(5_000)}`,
    };
  }
  assert.throws(() => createProviderRequest({
    ...base,
    schema: {
      type: "object",
      properties,
      required: Object.keys(properties),
      additionalProperties: false,
    },
  }), /cumulative|request.*byte|too large/i);
});

test("OpenAI bounds the final serialized body and rejects an exact key before fetch", async (t) => {
  await t.test("body bytes", async () => {
    let calls = 0;
    const live = provider(async () => { calls += 1; throw new Error("must not fetch"); }, { maxRequestBytes: 256 });
    await assert.rejects(live.complete(request()), (error) => {
      assert.equal(error.code, "OPENAI_REQUEST_TOO_LARGE");
      assert.equal(error.telemetry.transportAttempts, 0);
      return true;
    });
    assert.equal(calls, 0);
  });
  await t.test("configured key", async () => {
    let calls = 0;
    const live = provider(async () => { calls += 1; throw new Error("must not fetch"); });
    await assert.rejects(live.complete(request({ input: { publicNote: API_KEY } })), (error) => {
      assert.equal(error.code, "OPENAI_CREDENTIAL_IN_REQUEST");
      assert.equal(`${error.message}\n${error.stack}\n${JSON.stringify(error.telemetry)}`.includes(API_KEY), false);
      return true;
    });
    assert.equal(calls, 0);
  });
});

test("OpenAI scans parsed output for credentials and retains known telemetry", async () => {
  const value = envelope();
  value.output[0].content[0].text = JSON.stringify({ note: API_KEY });
  const live = provider(async () => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } }));
  await assert.rejects(live.complete(request()), (error) => {
    assert.equal(error.code, "OPENAI_CREDENTIAL_IN_OUTPUT");
    assert.deepEqual(error.telemetry.usage, { inputTokens: 5, outputTokens: 2, totalTokens: 7 });
    assert.equal(error.telemetry.model, MODEL);
    assert.equal(error.telemetry.responseId, "resp_safe_1");
    assert.equal(`${error.message}\n${error.stack}\n${JSON.stringify(error.telemetry)}`.includes(API_KEY), false);
    return true;
  });
});

test("OpenAI rejects exact-key echoes in response identity without leaking telemetry", async (t) => {
  for (const [name, override] of [
    ["response id", { id: API_KEY }],
    ["actual model", { model: API_KEY }],
  ]) {
    await t.test(name, async () => {
      const value = envelope(override);
      const live = provider(async () => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } }));
      await assert.rejects(live.complete(request()), (error) => {
        assert.equal(error.code, "OPENAI_CREDENTIAL_IN_OUTPUT");
        assert.deepEqual(error.telemetry.usage, { inputTokens: 5, outputTokens: 2, totalTokens: 7 });
        assert.equal(error.telemetry.transportAttempts, 1);
        assert.equal(`${error.message}\n${error.stack}\n${JSON.stringify(error.telemetry)}`.includes(API_KEY), false);
        return true;
      });
    });
  }
});

test("OpenAI rejects redirect metadata even on 200 and cancels the body", async (t) => {
  for (const options of [{ redirected: true, url: RESPONSES_URL }, { url: "https://example.invalid/final" }]) {
    await t.test(options.redirected ? "redirected flag" : "different URL", async () => {
      const item = cancellable(JSON.stringify(envelope()), options);
      const live = provider(async () => item.response);
      await assert.rejects(live.complete(request()), (error) => {
        assert.equal(error.code, "OPENAI_REDIRECT");
        return assertAttempt(error, "redirect");
      });
      assert.equal(item.cancellations(), 1);
    });
  }
});

test("OpenAI cancels every body rejected before successful parsing", async (t) => {
  for (const [name, options, code] of [
    ["redirect", { status: 302 }, "OPENAI_REDIRECT"],
    ["HTTP 400", { status: 400 }, "OPENAI_HTTP_ERROR"],
    ["content type", { contentType: "text/plain" }, "OPENAI_CONTENT_TYPE"],
    ["declared oversize", { contentLength: 32_769 }, "OPENAI_RESPONSE_TOO_LARGE"],
  ]) {
    await t.test(name, async () => {
      const item = cancellable(JSON.stringify(envelope()), options);
      const live = provider(async () => item.response);
      await assert.rejects(live.complete(request()), (error) => error.code === code);
      assert.equal(item.cancellations(), 1);
    });
  }
  await t.test("all retry bodies", async () => {
    const items = Array.from({ length: 3 }, () => cancellable("retry", { status: 429 }));
    let index = 0;
    const live = provider(async () => items[index++].response);
    await assert.rejects(live.complete(request()), (error) => error.code === "OPENAI_TRANSIENT_EXHAUSTED");
    assert.deepEqual(items.map((item) => item.cancellations()), [1, 1, 1]);
  });
  await t.test("stream oversize", async () => {
    const item = cancellable("x".repeat(65));
    const live = provider(async () => item.response, { maxResponseBytes: 64 });
    await assert.rejects(live.complete(request()), (error) => error.code === "OPENAI_RESPONSE_TOO_LARGE");
    assert.equal(item.cancellations(), 1);
  });
});

test("every post-attempt terminal failure carries safe attempt telemetry", async (t) => {
  await t.test("bad content type", async () => {
    const item = cancellable("bad", { contentType: "text/plain" });
    await assert.rejects(provider(async () => item.response).complete(request()), (error) => assertAttempt(error, "invalid-response"));
  });
  await t.test("malformed envelope", async () => {
    const response = new Response("{", { headers: { "content-type": "application/json" } });
    await assert.rejects(provider(async () => response).complete(request()), (error) => assertAttempt(error, "invalid-envelope"));
  });
  await t.test("fetch abort", async () => {
    const controller = new AbortController();
    const live = provider(async (_url, init) => {
      queueMicrotask(() => controller.abort());
      return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
    });
    await assert.rejects(live.complete(request(), { signal: controller.signal }), (error) => assertAttempt(error, "caller-aborted"));
  });
  await t.test("backoff abort", async () => {
    const controller = new AbortController();
    let announce;
    const started = new Promise((resolve) => { announce = resolve; });
    const live = provider(async () => new Response("retry", { status: 429 }), {
      sleep: (_ms, options = {}) => {
        if (options.purpose === "timeout") return new Promise(() => {});
        announce();
        return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
      },
    });
    const completion = live.complete(request(), { signal: controller.signal });
    await started;
    controller.abort();
    await assert.rejects(completion, (error) => assertAttempt(error, "http-429"));
  });
});

test("provider inputs reject nested controller-owned review and quality variants", () => {
  for (const key of ["reviewOutcome", "reviewOutcomes", "reviewDecision", "reviewDecisions", "workerQualityScore", "worker_quality_score"]) {
    assert.throws(() => request({ input: { nested: { [key]: "private" } } }), /evaluator|private|review|quality/i);
  }
});

function replayFixture() {
  const replayRequest = request();
  return {
    schemaVersion: 1,
    artifactKind: "rubricdelta-exact-provider-replay",
    binding: {
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
    },
    entries: [{
      sequence: 1,
      requestHash: hashProviderRequest(replayRequest),
      request: replayRequest,
      result: {
        data: { note: "safe" },
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        responseId: "deterministic-capture-0001",
        model: MODEL,
        latencyMs: 0,
        transportAttempts: 1,
        attempts: [{ attempt: 1, outcome: "deterministic-capture" }],
        estimatedCostUsd: 0,
      },
    }],
  };
}

test("replay rejects deep and Proxy fixture bindings without invoking traps", () => {
  const deepFixture = replayFixture();
  let deep = "leaf";
  for (let index = 0; index < 70; index += 1) deep = { next: deep };
  deepFixture.untrusted = deep;
  assert.throws(
    () => createReplayProvider({ fixture: deepFixture, expectedBinding: deepFixture.binding }),
    (error) => (
      error instanceof ProviderError
      && error.code !== "REPLAY_ARTIFACT_TOO_LARGE"
      && /depth|complex/i.test(error.message)
    ),
  );

  let trapCalls = 0;
  const trapped = new Proxy({}, {
    getPrototypeOf() {
      trapCalls += 1;
      throw new Error("REPLAY_PROXY_TRAP");
    },
  });
  const proxyFixture = replayFixture();
  proxyFixture.untrusted = trapped;
  assert.throws(() => createReplayProvider({ fixture: proxyFixture, expectedBinding: proxyFixture.binding }), (error) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(`${error.message}\n${error.stack}`.includes("REPLAY_PROXY_TRAP"), false);
    return true;
  });

  const expectedFixture = replayFixture();
  const expectedBinding = { ...expectedFixture.binding, untrusted: trapped };
  assert.throws(() => createReplayProvider({ fixture: expectedFixture, expectedBinding }), (error) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(`${error.message}\n${error.stack}`.includes("REPLAY_PROXY_TRAP"), false);
    return true;
  });
  assert.equal(trapCalls, 0);
});

test("replay rejects extra envelope fields, noncanonical source aliases, and snake usage", async (t) => {
  const extraFields = [
    ["fixture", (value) => { value.extra = true; }],
    ["binding", (value) => { value.binding.extra = true; }],
    ["benchmark", (value) => { value.binding.benchmark.extra = true; }],
    ["source", (value) => { value.binding.source.extra = true; }],
    ["source file", (value) => { value.binding.source.files[0].extra = true; }],
    ["prompt", (value) => { value.binding.prompts["rule-compiler"].extra = true; }],
    ["entry", (value) => { value.entries[0].extra = true; }],
  ];
  for (const [name, mutate] of extraFields) {
    await t.test(`extra ${name} field`, () => {
      const value = replayFixture();
      mutate(value);
      assert.throws(() => createReplayProvider({ fixture: value, expectedBinding: value.binding }), /field|key|envelope|binding/i);
    });
  }

  for (const path of ["./src/agent.js", "src//agent.js", "src/./agent.js", "src/agent.", "src/agent.js/"]) {
    await t.test(`source alias ${path}`, () => {
      const value = replayFixture();
      value.binding.source.files[0].path = path;
      assert.throws(() => createReplayProvider({ fixture: value, expectedBinding: value.binding }), /source.*path|path.*source|canonical/i);
    });
  }

  await t.test("case-insensitive source alias", () => {
    const value = replayFixture();
    value.binding.source.files.push({
      path: "SRC/AGENTS/POLICY-ANALYST.JS",
      sha256: "d".repeat(64),
    });
    assert.throws(
      () => createReplayProvider({ fixture: value, expectedBinding: value.binding }),
      /duplicate|alias|source.*path/i,
    );
  });

  await t.test("snake usage", () => {
    const value = replayFixture();
    value.entries[0].result.usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
    assert.throws(() => createReplayProvider({ fixture: value, expectedBinding: value.binding }), /usage|camel/i);
  });
});

test("replay rejects Proxy options before property traps execute", () => {
  const value = replayFixture();
  let traps = 0;
  const options = new Proxy({ fixture: value, expectedBinding: value.binding }, {
    get() {
      traps += 1;
      throw new Error("REPLAY_OPTIONS_PROXY_MARKER");
    },
  });
  assert.throws(() => createReplayProvider(options), (error) => {
    assert.ok(error instanceof ProviderError);
    assert.notEqual(error.code, "REPLAY_ARTIFACT_TOO_LARGE");
    assert.equal(`${error.message}\n${error.stack}`.includes("REPLAY_OPTIONS_PROXY_MARKER"), false);
    return true;
  });
  assert.equal(traps, 0);
});

function releaseReplayRequest(role, mode, caseId) {
  return createProviderRequest({
    role,
    prompt: getPrompt(role),
    input: { caseId, public: true },
    schema: SCHEMA,
    model: MODEL,
    benchmarkId: RELEASE_BENCHMARK_ID,
    caseId,
    mode,
    repetition: 1,
    inputRefs: [caseId],
    maxOutputTokens: 512,
  });
}

function releaseReplayFixture() {
  const caseIds = Array.from({ length: 10 }, (_, index) => `case-${index + 1}`);
  const roles = ["rule-compiler", "change-analyst", "impact-investigator", "independent-verifier"];
  const requests = [
    ...caseIds.map((caseId) => releaseReplayRequest("direct-baseline", "baseline", caseId)),
    ...caseIds.flatMap((caseId) => roles.map((role) => releaseReplayRequest(role, "advanced", caseId))),
  ];
  const value = {
    schemaVersion: 1,
    artifactKind: "rubricdelta-exact-provider-replay",
    binding: {
      benchmark: {
        id: RELEASE_BENCHMARK_ID,
        sha256: "a".repeat(64),
        orderedCaseIds: caseIds,
        orderedRecordIdsByCase: Object.fromEntries(caseIds.map((caseId) => [caseId, [`${caseId}-record-1`]])),
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
      mode: "both",
      repeats: 1,
    },
    entries: requests.map((item, index) => ({
      sequence: index + 1,
      requestHash: hashProviderRequest(item),
      request: item,
      result: {
        data: { note: "safe" },
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

test("release replay requires exactly 50 calls in baseline-then-four-role case order", async (t) => {
  const valid = releaseReplayFixture();
  assert.doesNotThrow(() => createReplayProvider({ fixture: valid, expectedBinding: valid.binding }));

  await t.test("empty", () => {
    const value = releaseReplayFixture();
    value.entries = [];
    assert.throws(() => createReplayProvider({ fixture: value, expectedBinding: value.binding }), /50|count|empty|sequence/i);
  });
  await t.test("short", () => {
    const value = releaseReplayFixture();
    value.entries.pop();
    assert.throws(() => createReplayProvider({ fixture: value, expectedBinding: value.binding }), /50|count|short|sequence/i);
  });
  await t.test("baseline case order", () => {
    const value = releaseReplayFixture();
    const wrong = releaseReplayRequest("direct-baseline", "baseline", "case-2");
    value.entries[0].request = wrong;
    value.entries[0].requestHash = hashProviderRequest(wrong);
    assert.throws(() => createReplayProvider({ fixture: value, expectedBinding: value.binding }), /order|case|sequence/i);
  });
  await t.test("advanced role order", () => {
    const value = releaseReplayFixture();
    const wrong = releaseReplayRequest("change-analyst", "advanced", "case-1");
    value.entries[10].request = wrong;
    value.entries[10].requestHash = hashProviderRequest(wrong);
    assert.throws(() => createReplayProvider({ fixture: value, expectedBinding: value.binding }), /order|role|sequence/i);
  });
  await t.test("baseline swap with valid resequencing", () => {
    const value = releaseReplayFixture();
    [value.entries[0], value.entries[1]] = [value.entries[1], value.entries[0]];
    for (let index = 0; index < 2; index += 1) {
      value.entries[index].sequence = index + 1;
      value.entries[index].result.responseId = `deterministic-capture-${String(index + 1).padStart(4, "0")}`;
    }
    assert.throws(() => createReplayProvider({ fixture: value, expectedBinding: value.binding }), /baseline.*order|case.*order/i);
  });
  await t.test("advanced swap with valid resequencing", () => {
    const value = releaseReplayFixture();
    [value.entries[10], value.entries[11]] = [value.entries[11], value.entries[10]];
    for (let index = 10; index < 12; index += 1) {
      value.entries[index].sequence = index + 1;
      value.entries[index].result.responseId = `deterministic-capture-${String(index + 1).padStart(4, "0")}`;
    }
    assert.throws(() => createReplayProvider({ fixture: value, expectedBinding: value.binding }), /advanced.*order|role.*order/i);
  });
});

test("deterministic replay requires record bindings and zero-cost one-attempt telemetry", () => {
  const mutations = [
    (value) => { delete value.binding.benchmark.orderedRecordIdsByCase; },
    (value) => { value.entries[0].result.usage.inputTokens = 1; value.entries[0].result.usage.totalTokens = 1; },
    (value) => { value.entries[0].result.latencyMs = 1; },
    (value) => { value.entries[0].result.estimatedCostUsd = null; },
    (value) => { value.entries[0].result.transportAttempts = 2; },
    (value) => { delete value.entries[0].result.attempts; },
    (value) => { value.entries[0].result.attempts[0].outcome = "completed"; },
    (value) => { value.entries[0].result.responseId = "arbitrary-id"; },
  ];
  for (const mutate of mutations) {
    const value = replayFixture();
    mutate(value);
    assert.throws(() => createReplayProvider({ fixture: value, expectedBinding: value.binding }), /record|usage|token|latency|cost|attempt|capture|responseId/i);
  }
});

test("release replay enforces a separate bounded artifact byte ceiling", () => {
  const value = releaseReplayFixture();
  for (const entry of value.entries) {
    const enlarged = createProviderRequest({
      ...entry.request,
      input: { ...entry.request.input, padding: "p".repeat(200_000) },
    });
    entry.request = enlarged;
    entry.requestHash = hashProviderRequest(enlarged);
  }
  assert.throws(
    () => createReplayProvider({ fixture: value, expectedBinding: value.binding }),
    /artifact.*byte|fixture.*large|replay.*byte/i,
  );
});

test("release replay enforces its artifact node ceiling independently of bytes", () => {
  const value = releaseReplayFixture();
  for (const entry of value.entries) {
    const enlarged = createProviderRequest({
      ...entry.request,
      input: { ...entry.request.input, values: Array.from({ length: 2_500 }, () => null) },
    });
    entry.request = enlarged;
    entry.requestHash = hashProviderRequest(enlarged);
  }
  assert.throws(
    () => createReplayProvider({ fixture: value, expectedBinding: value.binding }),
    (error) => error instanceof ProviderError && error.code === "REPLAY_ARTIFACT_TOO_LARGE",
  );
});

test("provider code lives at public plan paths and prompt files are LF-bound", () => {
  for (const stale of ["src/providers/contract-core.js", "src/providers/openai-core.js", "src/providers/replay-v1.js"]) {
    assert.equal(existsSync(new URL(`../${stale}`, import.meta.url)), false, `${stale} must not mask its public adapter`);
  }
  const attributes = readFileSync(new URL("../.gitattributes", import.meta.url), "utf8");
  assert.match(attributes, /prompts\/\*\.md\s+text\s+eol=lf/);
});
