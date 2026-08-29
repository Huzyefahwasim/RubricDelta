import { types as utilTypes } from "node:util";
import { EVALUATION_PROTOCOL } from "../evaluation/protocol.js";
import {
  ProviderError,
  assertJsonByteSize,
  assertNoCredentialValues,
  canonicalJson,
  cloneJson,
  createProviderRequest,
  hashProviderRequest,
  validateJsonValue,
} from "./contracts.js";

const PROMPT_ROLES = [
  "rule-compiler",
  "change-analyst",
  "impact-investigator",
  "independent-verifier",
  "direct-baseline",
];
const SORTED_PROMPT_ROLES = [...PROMPT_ROLES].sort();
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_SOURCE_SEGMENT = /^[A-Za-z0-9._-]+$/;
const REPLAY_ARTIFACT_MAX_BYTES = 8 * 1024 * 1024;
const REPLAY_ARTIFACT_MAX_NODES = 100_000;
const REPLAY_BINDING_MAX_BYTES = 1024 * 1024;
const REPLAY_BINDING_MAX_NODES = 10_000;
const ADVANCED_RELEASE_ROLES = [
  "rule-compiler",
  "change-analyst",
  "impact-investigator",
  "independent-verifier",
];

function replayError(message, code = "REPLAY_INVALID_FIXTURE") {
  return new ProviderError(message, code, { retryable: false });
}

function safelyCloneReplayValue(value, maxBytes, maxNodes) {
  try {
    assertJsonByteSize(value, maxBytes, maxNodes);
    return cloneJson(value);
  } catch (error) {
    if (error instanceof ProviderError && error.code === "PROVIDER_JSON_LIMIT") {
      throw replayError("Replay artifact byte or node limit was exceeded", "REPLAY_ARTIFACT_TOO_LARGE");
    }
    throw replayError("Replay fixture failed bounded structural complexity validation");
  }
}

function nonblank(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function uniqueNonblankStrings(value) {
  return Array.isArray(value) && value.length > 0 && value.every(nonblank) && new Set(value).size === value.length;
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || canonicalJson(Object.keys(value).sort()) !== canonicalJson([...expected].sort())) {
    throw replayError(`Replay ${label} fields are malformed`);
  }
}

function canonicalSourcePath(value) {
  if (!nonblank(value) || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:\//.test(value)) return false;
  const segments = value.split("/");
  return segments.length > 0 && segments.every((segment) => (
    nonblank(segment)
    && segment !== "."
    && segment !== ".."
    && !segment.endsWith(".")
    && !segment.endsWith(" ")
    && SAFE_SOURCE_SEGMENT.test(segment)
  ));
}

function validateBenchmarkBinding(binding) {
  exactKeys(binding, ["id", "sha256", "orderedCaseIds", "orderedRecordIdsByCase"], "benchmark record binding");
  if (!nonblank(binding.id) || !SHA256.test(binding.sha256) || !uniqueNonblankStrings(binding.orderedCaseIds)) {
    throw replayError("Replay benchmark binding is malformed");
  }
  if (!binding.orderedRecordIdsByCase || typeof binding.orderedRecordIdsByCase !== "object" || Array.isArray(binding.orderedRecordIdsByCase)) {
    throw replayError("Replay benchmark ordered record binding is required");
  }
  if (canonicalJson(Object.keys(binding.orderedRecordIdsByCase).sort()) !== canonicalJson([...binding.orderedCaseIds].sort())) {
    throw replayError("Replay benchmark record binding does not cover every case");
  }
  for (const caseId of binding.orderedCaseIds) {
    if (!uniqueNonblankStrings(binding.orderedRecordIdsByCase[caseId])) {
      throw replayError("Replay benchmark record IDs are malformed");
    }
  }
}

function validateSourceBinding(binding) {
  exactKeys(binding, ["kind", "sha256", "sha256Canonicalization", "files"], "source binding");
  if (binding.kind !== "deterministic-role-capture"
    || binding.sha256Canonicalization !== "utf8-lf"
    || !SHA256.test(binding.sha256)
    || !Array.isArray(binding.files)
    || binding.files.length === 0) {
    throw replayError("Replay source binding or sha256 is malformed");
  }
  const paths = [];
  for (const item of binding.files) {
    exactKeys(item, ["path", "sha256"], "source file");
    if (!canonicalSourcePath(item.path) || !SHA256.test(item.sha256)) {
      throw replayError("Replay source path must be canonical POSIX repo-relative data with a valid hash");
    }
    paths.push(item.path);
  }
  const portablePaths = paths.map((item) => item.toLowerCase());
  if (new Set(portablePaths).size !== portablePaths.length) {
    throw replayError("Replay source binding contains duplicate or case-insensitive alias paths");
  }
}

function validatePromptBinding(binding) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) throw replayError("Replay prompt binding is malformed");
  const actualRoles = Object.keys(binding).sort();
  if (actualRoles.length !== SORTED_PROMPT_ROLES.length || canonicalJson(actualRoles) !== canonicalJson(SORTED_PROMPT_ROLES)) {
    throw replayError("Replay prompts binding must contain the exact five roles");
  }
  for (const role of PROMPT_ROLES) {
    const prompt = binding[role];
    exactKeys(prompt, ["version", "filename", "sha256"], `prompt ${role}`);
    if (prompt.version !== "v1" || prompt.filename !== `${role}.v1.md` || !SHA256.test(prompt.sha256)) {
      throw replayError("Replay prompt version, filename, or sha256 binding is malformed");
    }
  }
}

function validateBinding(binding) {
  exactKeys(binding, ["benchmark", "source", "protocol", "prompts", "model", "mode", "repeats"], "binding");
  validateBenchmarkBinding(binding.benchmark);
  validateSourceBinding(binding.source);
  if (canonicalJson(binding.protocol) !== canonicalJson(EVALUATION_PROTOCOL)) {
    throw replayError("Replay evaluation protocol binding is malformed");
  }
  validatePromptBinding(binding.prompts);
  if (!nonblank(binding.model)) throw replayError("Replay model binding is malformed");
  if (!["baseline", "advanced", "both"].includes(binding.mode)) throw replayError("Replay mode binding is malformed");
  if (binding.repeats !== 1) throw replayError("Replay repeats binding must be exactly one for the release fixture");
  return binding;
}

function compareBinding(actual, expected) {
  for (const field of ["benchmark", "source", "protocol", "prompts", "model", "mode", "repeats"]) {
    if (canonicalJson(actual[field]) !== canonicalJson(expected[field])) throw replayError(`Replay ${field} binding mismatch`, "REPLAY_BINDING_MISMATCH");
  }
}

function requestMatchesBinding(request, binding) {
  if (request.model !== binding.model) throw replayError("Replay request model conflicts with binding");
  if (request.benchmarkId !== binding.benchmark.id || !binding.benchmark.orderedCaseIds.includes(request.caseId)) {
    throw replayError("Replay request benchmark or case conflicts with binding");
  }
  if (binding.mode === "both") {
    if (!["baseline", "advanced"].includes(request.mode)) throw replayError("Replay request mode conflicts with binding");
  } else if (request.mode !== binding.mode) {
    throw replayError("Replay request mode conflicts with binding");
  }
  if (request.repetition > binding.repeats) throw replayError("Replay request repetition conflicts with binding");
  const prompt = binding.prompts[request.role];
  if (!prompt || request.prompt.version !== prompt.version || request.prompt.sha256 !== prompt.sha256) {
    throw replayError("Replay request prompt conflicts with binding");
  }
}

function validateResult(result, request, binding, expectedSequence) {
  if (!result || typeof result !== "object" || Array.isArray(result)) throw replayError("Replay result is malformed");
  const expectedKeys = [
    "attempts",
    "data",
    "estimatedCostUsd",
    "latencyMs",
    "model",
    "responseId",
    "transportAttempts",
    "usage",
  ];
  if (canonicalJson(Object.keys(result).sort()) !== canonicalJson(expectedKeys)) {
    throw replayError("Replay result attempt fields are malformed");
  }
  const expectedResponseId = `deterministic-capture-${String(expectedSequence).padStart(4, "0")}`;
  if (result.responseId !== expectedResponseId) throw replayError("Replay result responseId is not the deterministic capture ID");
  if (result.model !== request.model || result.model !== binding.model) throw replayError("Replay result model conflicts with request model");
  if (result.latencyMs !== 0) throw replayError("Replay deterministic capture latency must be zero");
  if (result.transportAttempts !== 1) throw replayError("Replay deterministic capture must have exactly one transport attempt");
  if (result.estimatedCostUsd !== 0) throw replayError("Replay deterministic capture estimated cost must be zero");
  if (canonicalJson(result.attempts) !== canonicalJson([{ attempt: 1, outcome: "deterministic-capture" }])) {
    throw replayError("Replay deterministic capture attempt telemetry is malformed");
  }
  exactKeys(result.usage, ["inputTokens", "outputTokens", "totalTokens"], "result usage");
  const zeroUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  if (canonicalJson(result.usage) !== canonicalJson(zeroUsage)) {
    throw replayError("Replay deterministic capture token usage must be exact camel-case zeros");
  }
  try { validateJsonValue(result.data, request.schema); }
  catch { throw replayError("Replay result data violates the request schema"); }
}

function validateEntry(entry, expectedSequence, binding) {
  exactKeys(entry, ["sequence", "requestHash", "request", "result"], `entry ${expectedSequence}`);
  if (entry.sequence !== expectedSequence) throw replayError(`Replay sequence ${expectedSequence} is missing or duplicated`);
  let request;
  try { request = createProviderRequest(entry.request); }
  catch { throw replayError(`Replay sequence ${expectedSequence} contains an invalid request`); }
  if (canonicalJson(request) !== canonicalJson(entry.request)) throw replayError(`Replay sequence ${expectedSequence} request is not canonical`);
  requestMatchesBinding(request, binding);
  if (!SHA256.test(entry.requestHash) || entry.requestHash !== hashProviderRequest(request)) {
    throw replayError(`Replay sequence ${expectedSequence} request hash mismatch`, "REPLAY_REQUEST_HASH_MISMATCH");
  }
  validateResult(entry.result, request, binding, expectedSequence);
}

function validateReleaseSequence(fixture, binding) {
  const tuples = [];
  const caseIds = binding.benchmark.orderedCaseIds;
  if (binding.mode === "baseline" || binding.mode === "both") {
    for (const caseId of caseIds) tuples.push({ role: "direct-baseline", mode: "baseline", caseId });
  }
  if (binding.mode === "advanced" || binding.mode === "both") {
    for (const caseId of caseIds) {
      for (const role of ADVANCED_RELEASE_ROLES) tuples.push({ role, mode: "advanced", caseId });
    }
  }
  if (fixture.entries.length !== tuples.length) {
    throw replayError(`Replay fixture call count must be exactly ${tuples.length} for its bound mode and cases`);
  }
  for (let index = 0; index < tuples.length; index += 1) {
    const expected = tuples[index];
    const request = fixture.entries[index].request;
    if (request.role !== expected.role
      || request.mode !== expected.mode
      || request.caseId !== expected.caseId
      || request.repetition !== 1) {
      const phase = expected.mode === "baseline" ? "baseline case" : "advanced role";
      throw replayError(`Replay ${phase} order is malformed at sequence ${index + 1}`);
    }
  }
}

function validateFixture(fixture, expectedBinding) {
  exactKeys(fixture, ["schemaVersion", "artifactKind", "binding", "entries"], "fixture envelope");
  if (fixture.schemaVersion !== 1 || fixture.artifactKind !== "rubricdelta-exact-provider-replay" || !Array.isArray(fixture.entries)) {
    throw replayError("Replay fixture envelope is malformed");
  }
  if (fixture.entries.length === 0) throw replayError("Replay fixture entries must not be empty");
  const binding = validateBinding(fixture.binding);
  validateBinding(expectedBinding);
  compareBinding(binding, expectedBinding);
  fixture.entries.forEach((entry, index) => validateEntry(entry, index + 1, binding));
  validateReleaseSequence(fixture, binding);
  return fixture;
}

export function createReplayProvider(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options) || utilTypes.isProxy(options)) {
    throw replayError("Replay provider options must be a plain non-Proxy object");
  }
  const prototype = Object.getPrototypeOf(options);
  if (prototype !== Object.prototype && prototype !== null) {
    throw replayError("Replay provider options must be a plain object");
  }
  const descriptors = Object.getOwnPropertyDescriptors(options);
  exactKeys(descriptors, ["fixture", "expectedBinding"], "provider options");
  for (const descriptor of Object.values(descriptors)) {
    if (descriptor.get || descriptor.set || !("value" in descriptor)) {
      throw replayError("Replay provider options must contain plain data fields");
    }
  }
  const fixture = descriptors.fixture.value;
  const expectedBinding = descriptors.expectedBinding.value;
  const stored = safelyCloneReplayValue(fixture, REPLAY_ARTIFACT_MAX_BYTES, REPLAY_ARTIFACT_MAX_NODES);
  const expected = safelyCloneReplayValue(expectedBinding, REPLAY_BINDING_MAX_BYTES, REPLAY_BINDING_MAX_NODES);
  try {
    assertNoCredentialValues(stored);
    assertNoCredentialValues(expected);
  } catch {
    throw replayError("Replay fixture contains invalid or credential-bearing data");
  }
  try {
    validateFixture(stored, expected);
  } catch (error) {
    if (error instanceof ProviderError && String(error.code).startsWith("REPLAY_")) throw error;
    throw replayError("Replay fixture failed safe validation");
  }
  let index = 0;
  return Object.freeze({
    name: "replay",
    model: stored.binding.model,
    binding: cloneJson(stored.binding),
    async complete(input) {
      if (index >= stored.entries.length) throw replayError("Replay fixture is exhausted; extra request rejected", "REPLAY_EXHAUSTED");
      let request;
      try { request = createProviderRequest(input); }
      catch { throw replayError(`Replay sequence ${index + 1} received an invalid request`, "REPLAY_REQUEST_MISMATCH"); }
      requestMatchesBinding(request, stored.binding);
      const entry = stored.entries[index];
      if (entry.requestHash !== hashProviderRequest(request) || canonicalJson(entry.request) !== canonicalJson(request)) {
        throw replayError(`Replay sequence ${index + 1} request hash mismatch`, "REPLAY_REQUEST_MISMATCH");
      }
      validateResult(entry.result, request, stored.binding, index + 1);
      index += 1;
      return cloneJson(entry.result);
    },
    assertExhausted() {
      const remaining = stored.entries.length - index;
      if (remaining !== 0) throw replayError(`Replay is not exhausted; ${remaining} entr${remaining === 1 ? "y" : "ies"} remaining`, "REPLAY_NOT_EXHAUSTED");
      return true;
    },
    position() {
      return { consumed: index, total: stored.entries.length };
    },
  });
}
