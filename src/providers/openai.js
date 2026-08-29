import {
  ProviderError,
  assertJsonByteSize,
  assertNoCredentialValues,
  canonicalJson,
  containsExactString,
  createProviderRequest,
  normalizeUsage,
  validateJsonValue,
} from "./contracts.js";

const RESPONSES_URL = "https://api.openai.com/v1/responses";
const TRANSPORT_ATTEMPTS = 3;
const DEFAULT_MAX_OUTPUT_TOKENS = 2048;
const DEFAULT_MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;

const TRANSPORT_ERROR_MESSAGES = Object.freeze({
  OPENAI_REDIRECT: "OpenAI redirect responses are forbidden",
  OPENAI_CONTENT_TYPE: "OpenAI response Content-Type must be application/json",
  OPENAI_RESPONSE_TOO_LARGE: "OpenAI response exceeded the configured byte limit",
  OPENAI_INVALID_RESPONSE: "OpenAI response was invalid",
});

const POST_RESPONSE_OUTCOMES = Object.freeze({
  OPENAI_INVALID_ENVELOPE: "invalid-envelope",
  OPENAI_RESPONSE_ERROR: "response-error",
  OPENAI_INCOMPLETE: "incomplete",
  OPENAI_INVALID_OUTPUT: "invalid-output",
  OPENAI_REFUSAL: "refusal",
  OPENAI_FENCED_OUTPUT: "fenced-output",
  OPENAI_INVALID_JSON: "invalid-json",
  OPENAI_SCHEMA_INVALID: "schema-invalid",
  OPENAI_USAGE_INVALID: "invalid-usage",
  OPENAI_MODEL_MISMATCH: "model-mismatch",
  OPENAI_CREDENTIAL_IN_OUTPUT: "credential-output",
  OPENAI_INVALID_RESPONSE: "invalid-response",
});

class ProviderTimeoutError extends Error {
  constructor() {
    super("provider timeout");
    this.name = "ProviderTimeoutError";
  }
}

function nonblank(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function defaultSleep(ms, { signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    }, { once: true });
  });
}

function isAbort(error) {
  return error?.name === "AbortError";
}

function isCredentialContractError(error) {
  return error instanceof ProviderError
    && error.code === "INVALID_PROVIDER_CONTRACT"
    && /credential|secret/i.test(error.message);
}

function containsCredential(value, apiKey) {
  if (containsExactString(value, apiKey)) return true;
  try {
    assertNoCredentialValues(value);
    return false;
  } catch (error) {
    if (isCredentialContractError(error)) return true;
    throw error;
  }
}

function safeIdentity(value, apiKey) {
  return nonblank(value) && !containsCredential(value, apiKey) ? value : null;
}

function safeNow(now, fallback) {
  try {
    const value = Number(now());
    return Number.isFinite(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function responseTelemetry({
  responseId = null,
  model = null,
  usage = null,
  attempts,
  started,
  now,
  apiKey,
}) {
  const current = safeNow(now, started);
  return {
    responseId: safeIdentity(responseId, apiKey),
    model: safeIdentity(model, apiKey),
    usage,
    transportAttempts: attempts.length,
    attempts: attempts.map(({ attempt, outcome }) => ({ attempt, outcome })),
    latencyMs: Math.max(0, current - started),
  };
}

function preflightTelemetry() {
  return {
    responseId: null,
    model: null,
    usage: null,
    transportAttempts: 0,
    attempts: [],
    latencyMs: 0,
  };
}

function callerAbort(telemetry = null) {
  return new ProviderError("OpenAI provider call was aborted by the caller", "CALLER_ABORTED", {
    retryable: false,
    telemetry,
  });
}

async function cancelRejectedBody(response) {
  const body = response?.body;
  if (!body || body.locked || typeof body.cancel !== "function") return;
  try {
    await body.cancel();
  } catch {
    // Cancellation is best-effort; rejection still remains fail-closed.
  }
}

async function invalidDecodedResponse(reader) {
  try {
    await reader.cancel();
  } catch {
    // The safe static error below is authoritative even if cancellation fails.
  }
  throw new ProviderError("OpenAI response was not valid UTF-8", "OPENAI_INVALID_RESPONSE");
}

async function readBounded(response, limit) {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^[0-9]+$/.test(declared) || Number(declared) > limit)) {
    await cancelRejectedBody(response);
    throw new ProviderError(TRANSPORT_ERROR_MESSAGES.OPENAI_RESPONSE_TOO_LARGE, "OPENAI_RESPONSE_TOO_LARGE");
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    await cancelRejectedBody(response);
    throw new ProviderError("OpenAI response body was unavailable", "OPENAI_INVALID_RESPONSE");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || typeof value.byteLength !== "number") {
        await reader.cancel();
        throw new ProviderError("OpenAI response contained an invalid byte stream", "OPENAI_INVALID_RESPONSE");
      }
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new ProviderError(TRANSPORT_ERROR_MESSAGES.OPENAI_RESPONSE_TOO_LARGE, "OPENAI_RESPONSE_TOO_LARGE");
      }
      try {
        text += decoder.decode(value, { stream: true });
      } catch {
        await invalidDecodedResponse(reader);
      }
    }
    try {
      text += decoder.decode();
    } catch {
      await invalidDecodedResponse(reader);
    }
    return text;
  } finally {
    reader.releaseLock();
  }
}

function combinedSignal(callerSignal, providerSignal) {
  return callerSignal ? AbortSignal.any([callerSignal, providerSignal]) : providerSignal;
}

function isRedirectResponse(response) {
  return response.status >= 300 && response.status < 400
    || response.redirected === true
    || (nonblank(response.url) && response.url !== RESPONSES_URL);
}

async function timedTransport({
  fetchImpl,
  init,
  callerSignal,
  timeoutMs,
  maxResponseBytes,
  sleep,
}) {
  if (callerSignal?.aborted) throw callerAbort();
  const timeoutAbort = new AbortController();
  const cancelTimeout = new AbortController();
  let completed = false;
  let timedOut = false;
  let response = null;
  const signal = combinedSignal(callerSignal, timeoutAbort.signal);
  const timeout = Promise.resolve()
    .then(() => sleep(timeoutMs, { purpose: "timeout", signal: cancelTimeout.signal }))
    .then(async () => {
      if (completed) return new Promise(() => {});
      timedOut = true;
      timeoutAbort.abort();
      await cancelRejectedBody(response);
      throw new ProviderTimeoutError();
    });
  const transport = Promise.resolve().then(async () => {
    response = await fetchImpl(RESPONSES_URL, { ...init, signal });
    if (!(response instanceof Response)) throw new Error("invalid fetch response");
    if (isRedirectResponse(response)) {
      await cancelRejectedBody(response);
      throw new ProviderError(TRANSPORT_ERROR_MESSAGES.OPENAI_REDIRECT, "OPENAI_REDIRECT");
    }
    if (response.status < 200 || response.status >= 300) return { response, text: null };
    const contentType = response.headers.get("content-type");
    if (!contentType || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
      await cancelRejectedBody(response);
      throw new ProviderError(TRANSPORT_ERROR_MESSAGES.OPENAI_CONTENT_TYPE, "OPENAI_CONTENT_TYPE");
    }
    return { response, text: await readBounded(response, maxResponseBytes) };
  });
  try {
    return await Promise.race([transport, timeout]);
  } catch (error) {
    if (callerSignal?.aborted) {
      await cancelRejectedBody(response);
      throw callerAbort();
    }
    if (timedOut || error instanceof ProviderTimeoutError) throw new ProviderTimeoutError();
    throw error;
  } finally {
    completed = true;
    cancelTimeout.abort();
  }
}

function outputText(envelope, telemetry) {
  if (!nonblank(envelope.id) || envelope.object !== "response" || !Array.isArray(envelope.output)) {
    throw new ProviderError("OpenAI returned a malformed response envelope", "OPENAI_INVALID_ENVELOPE", { telemetry });
  }
  if (envelope.error !== null && envelope.error !== undefined) {
    throw new ProviderError("OpenAI returned a response error", "OPENAI_RESPONSE_ERROR", { telemetry });
  }
  if (envelope.incomplete_details !== null && envelope.incomplete_details !== undefined) {
    throw new ProviderError("OpenAI returned incomplete response details", "OPENAI_INCOMPLETE", { telemetry });
  }
  if (envelope.status !== "completed") {
    throw new ProviderError("OpenAI response was incomplete", "OPENAI_INCOMPLETE", { telemetry });
  }
  const texts = [];
  for (const item of envelope.output) {
    if (item?.type === "reasoning") continue;
    if (!item || item.type !== "message" || item.role !== "assistant" || item.status !== "completed" || !Array.isArray(item.content)) {
      throw new ProviderError("OpenAI returned a malformed output item", "OPENAI_INVALID_OUTPUT", { telemetry });
    }
    for (const content of item.content) {
      if (content?.type === "refusal") {
        throw new ProviderError("OpenAI returned a refusal for the structured request", "OPENAI_REFUSAL", { telemetry });
      }
      if (!content || content.type !== "output_text" || typeof content.text !== "string") {
        throw new ProviderError("OpenAI returned a malformed output content item", "OPENAI_INVALID_OUTPUT", { telemetry });
      }
      texts.push(content.text);
    }
  }
  if (texts.length !== 1) {
    throw new ProviderError("OpenAI must return exactly one JSON output", "OPENAI_INVALID_OUTPUT", { telemetry });
  }
  const text = texts[0].trim();
  if (text.includes("```")) {
    throw new ProviderError("OpenAI returned fenced output instead of one JSON value", "OPENAI_FENCED_OUTPUT", { telemetry });
  }
  return text;
}

function parseEnvelope(text, apiKey, telemetry) {
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value;
  } catch {
    if (containsCredential(text, apiKey)) {
      throw new ProviderError("OpenAI response contained credential material", "OPENAI_CREDENTIAL_IN_OUTPUT", { telemetry });
    }
    throw new ProviderError("OpenAI response envelope was malformed JSON", "OPENAI_INVALID_ENVELOPE", { telemetry });
  }
}

function parseStructured(text, schema, telemetry) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ProviderError("OpenAI returned malformed structured JSON", "OPENAI_INVALID_JSON", { telemetry });
  }
  try {
    validateJsonValue(value, schema);
  } catch {
    throw new ProviderError("OpenAI structured output failed schema validation", "OPENAI_SCHEMA_INVALID", { telemetry });
  }
  return value;
}

function requestBody(request) {
  const roleName = `rubricdelta_${request.role.replaceAll("-", "_")}_${request.prompt.version}`;
  const publicPayload = {
    prompt: { id: request.prompt.id, version: request.prompt.version, sha256: request.prompt.sha256 },
    context: {
      benchmarkId: request.benchmarkId,
      caseId: request.caseId,
      mode: request.mode,
      repetition: request.repetition,
      inputRefs: request.inputRefs,
    },
    input: request.input,
  };
  return {
    model: request.model,
    store: false,
    instructions: request.prompt.instruction,
    input: [{ role: "user", content: [{ type: "input_text", text: canonicalJson(publicPayload) }] }],
    max_output_tokens: request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    text: {
      format: {
        type: "json_schema",
        name: roleName,
        strict: true,
        schema: request.schema,
      },
    },
    tools: [],
    tool_choice: "none",
  };
}

function telemetryFor({ attempts, started, now, apiKey, responseId, model, usage }) {
  return responseTelemetry({ attempts, started, now, apiKey, responseId, model, usage });
}

function internalTransportFailure(error, telemetry) {
  if (error instanceof ProviderError && Object.hasOwn(TRANSPORT_ERROR_MESSAGES, error.code)) {
    return new ProviderError(TRANSPORT_ERROR_MESSAGES[error.code], error.code, { telemetry });
  }
  return new ProviderError("OpenAI fetch implementation failed", "OPENAI_FETCH_FAILED", {
    retryable: false,
    telemetry,
  });
}

async function backoff({ sleep, callerSignal, attempt, telemetry }) {
  if (callerSignal?.aborted) throw callerAbort(telemetry());
  try {
    await sleep(100 * attempt, {
      purpose: "backoff",
      signal: callerSignal ?? new AbortController().signal,
    });
  } catch (error) {
    if (callerSignal?.aborted || isAbort(error)) throw callerAbort(telemetry());
    throw new ProviderError("OpenAI retry backoff failed", "OPENAI_BACKOFF_FAILED", {
      telemetry: telemetry(),
    });
  }
}

function tryUsage(value) {
  try {
    return normalizeUsage(value);
  } catch {
    return null;
  }
}

function requestFailure(message, code) {
  return new ProviderError(message, code, { telemetry: preflightTelemetry() });
}

function postResponseFailure(error, {
  attemptRecord,
  attempts,
  started,
  now,
  apiKey,
  envelope,
  usage,
}) {
  const known = error instanceof ProviderError && Object.hasOwn(POST_RESPONSE_OUTCOMES, error.code);
  const code = known ? error.code : "OPENAI_INVALID_RESPONSE";
  attemptRecord.outcome = POST_RESPONSE_OUTCOMES[code];
  const telemetry = telemetryFor({
    attempts,
    started,
    now,
    apiKey,
    responseId: envelope?.id,
    model: envelope?.model,
    usage,
  });
  return new ProviderError(
    known ? error.message : "OpenAI response failed bounded validation",
    code,
    { retryable: known && error.retryable, telemetry },
  );
}

export function createOpenAIProvider({
  apiKey,
  model,
  fetchImpl = globalThis.fetch,
  now = () => performance.now(),
  sleep = defaultSleep,
  timeoutMs = 30_000,
  maxResponseBytes = MAX_RESPONSE_BYTES,
  maxRequestBytes = DEFAULT_MAX_REQUEST_BYTES,
} = {}) {
  if (!nonblank(model)) throw new ProviderError("A pinned OpenAI model is required", "OPENAI_MODEL_REQUIRED");
  if (typeof fetchImpl !== "function" || typeof now !== "function" || typeof sleep !== "function") {
    throw new ProviderError("OpenAI provider dependencies are invalid", "OPENAI_CONFIGURATION");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1
    || !Number.isInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > MAX_RESPONSE_BYTES
    || !Number.isInteger(maxRequestBytes) || maxRequestBytes < 1 || maxRequestBytes > MAX_REQUEST_BYTES) {
    throw new ProviderError("OpenAI provider bounds are invalid", "OPENAI_CONFIGURATION");
  }

  return Object.freeze({
    name: "openai",
    model,
    async complete(input, { signal: callerSignal } = {}) {
      if (!nonblank(apiKey)) {
        throw new ProviderError("OPENAI_API_KEY is required for the OpenAI provider", "OPENAI_CREDENTIAL_REQUIRED");
      }
      if (callerSignal?.aborted) throw callerAbort(preflightTelemetry());
      let request;
      try {
        request = createProviderRequest(input);
      } catch (error) {
        if (error instanceof ProviderError && error.code === "PROVIDER_JSON_LIMIT") {
          throw requestFailure("OpenAI request exceeded bounded validation limits", "OPENAI_REQUEST_TOO_LARGE");
        }
        throw requestFailure("OpenAI request failed bounded validation", "OPENAI_INVALID_REQUEST");
      }
      if (request.model !== model) {
        throw requestFailure("Provider request model does not match the pinned OpenAI model", "OPENAI_MODEL_MISMATCH");
      }
      try {
        assertJsonByteSize(request, maxRequestBytes);
      } catch {
        throw requestFailure("OpenAI request exceeded the configured byte limit", "OPENAI_REQUEST_TOO_LARGE");
      }
      if (containsCredential(request, apiKey)) {
        throw requestFailure("OpenAI request contained the configured credential", "OPENAI_CREDENTIAL_IN_REQUEST");
      }
      const bodyValue = requestBody(request);
      try {
        assertJsonByteSize(bodyValue, maxRequestBytes);
      } catch {
        throw requestFailure("OpenAI request exceeded the configured byte limit", "OPENAI_REQUEST_TOO_LARGE");
      }
      if (containsCredential(bodyValue, apiKey)) {
        throw requestFailure("OpenAI request contained the configured credential", "OPENAI_CREDENTIAL_IN_REQUEST");
      }
      const body = JSON.stringify(bodyValue);
      if (Buffer.byteLength(body, "utf8") > maxRequestBytes) {
        throw requestFailure("OpenAI request exceeded the configured byte limit", "OPENAI_REQUEST_TOO_LARGE");
      }

      const started = safeNow(now, 0);
      const attempts = [];
      const baseTelemetry = () => telemetryFor({ attempts, started, now, apiKey });
      for (let attempt = 1; attempt <= TRANSPORT_ATTEMPTS; attempt += 1) {
        let transport;
        try {
          transport = await timedTransport({
            fetchImpl,
            init: {
              method: "POST",
              redirect: "manual",
              headers: {
                "content-type": "application/json",
                authorization: `Bearer ${apiKey}`,
              },
              body,
            },
            callerSignal,
            timeoutMs,
            maxResponseBytes,
            sleep,
          });
        } catch (error) {
          if (callerSignal?.aborted || error?.code === "CALLER_ABORTED") {
            attempts.push({ attempt, outcome: "caller-aborted" });
            throw callerAbort(baseTelemetry());
          }
          const timedOut = error instanceof ProviderTimeoutError;
          const networkError = error?.constructor === TypeError;
          if (timedOut || networkError) {
            attempts.push({ attempt, outcome: timedOut ? "timeout" : "network-error" });
            if (attempt === TRANSPORT_ATTEMPTS) {
              const onlyTimeouts = attempts.every(({ outcome }) => outcome === "timeout");
              throw new ProviderError(
                onlyTimeouts
                  ? "OpenAI provider timed out after three transport attempts"
                  : "OpenAI transient transport attempts were exhausted",
                "OPENAI_TRANSIENT_EXHAUSTED",
                { retryable: true, telemetry: baseTelemetry() },
              );
            }
            await backoff({ sleep, callerSignal, attempt, telemetry: baseTelemetry });
            continue;
          }
          const knownTransport = error instanceof ProviderError
            && Object.hasOwn(TRANSPORT_ERROR_MESSAGES, error.code);
          const outcome = error?.code === "OPENAI_REDIRECT"
            ? "redirect"
            : knownTransport ? "invalid-response" : "failed";
          attempts.push({ attempt, outcome });
          throw internalTransportFailure(error, baseTelemetry());
        }

        const { response, text } = transport;
        if (response.status < 200 || response.status >= 300) {
          await cancelRejectedBody(response);
          const outcome = `http-${response.status}`;
          attempts.push({ attempt, outcome });
          const transient = response.status === 429 || (response.status >= 500 && response.status <= 599);
          if (transient) {
            if (attempt === TRANSPORT_ATTEMPTS) {
              throw new ProviderError("OpenAI transient transport attempts were exhausted", "OPENAI_TRANSIENT_EXHAUSTED", {
                retryable: true,
                telemetry: baseTelemetry(),
              });
            }
            await backoff({ sleep, callerSignal, attempt, telemetry: baseTelemetry });
            continue;
          }
          throw new ProviderError(`OpenAI returned non-retryable HTTP ${response.status}`, "OPENAI_HTTP_ERROR", {
            telemetry: baseTelemetry(),
          });
        }

        const attemptRecord = { attempt, outcome: "invalid-response" };
        attempts.push(attemptRecord);
        let envelope = null;
        let possibleUsage = null;
        try {
          const initialTelemetry = baseTelemetry();
          envelope = parseEnvelope(text, apiKey, initialTelemetry);
          possibleUsage = tryUsage(envelope.usage);
          const telemetry = telemetryFor({
            attempts,
            started,
            now,
            apiKey,
            responseId: envelope.id,
            model: envelope.model,
            usage: possibleUsage,
          });
          if (containsCredential(envelope, apiKey)) {
            throw new ProviderError("OpenAI response contained credential material", "OPENAI_CREDENTIAL_IN_OUTPUT", {
              telemetry,
            });
          }
          if (possibleUsage === null) {
            throw new ProviderError("OpenAI returned malformed usage", "OPENAI_USAGE_INVALID", { telemetry });
          }
          if (envelope.model !== model) {
            throw new ProviderError("OpenAI actual model did not match the pinned model", "OPENAI_MODEL_MISMATCH", { telemetry });
          }
          const textOutput = outputText(envelope, telemetry);
          const data = parseStructured(textOutput, request.schema, telemetry);
          if (containsCredential(data, apiKey)) {
            throw new ProviderError("OpenAI structured output contained credential material", "OPENAI_CREDENTIAL_IN_OUTPUT", {
              telemetry,
            });
          }
          attemptRecord.outcome = "completed";
          const resultTelemetry = telemetryFor({
            attempts,
            started,
            now,
            apiKey,
            responseId: envelope.id,
            model: envelope.model,
            usage: possibleUsage,
          });
          const result = {
            data,
            usage: possibleUsage,
            responseId: envelope.id,
            model: envelope.model,
            latencyMs: resultTelemetry.latencyMs,
            transportAttempts: attempt,
            attempts: resultTelemetry.attempts,
            estimatedCostUsd: null,
          };
          if (containsCredential(result, apiKey)) {
            throw new ProviderError("OpenAI result contained credential material", "OPENAI_CREDENTIAL_IN_OUTPUT", {
              telemetry: resultTelemetry,
            });
          }
          return result;
        } catch (error) {
          throw postResponseFailure(error, {
            attemptRecord,
            attempts,
            started,
            now,
            apiKey,
            envelope,
            usage: possibleUsage,
          });
        }
      }
      throw new ProviderError("OpenAI provider reached an impossible state", "OPENAI_INTERNAL");
    },
  });
}
