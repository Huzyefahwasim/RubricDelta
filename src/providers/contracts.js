import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";

const PROVIDER_ROLES = new Set([
  "rule-compiler",
  "change-analyst",
  "impact-investigator",
  "independent-verifier",
  "direct-baseline",
]);
const GOLD_INPUT_KEYS = new Set([
  "groundtruth",
  "affectedrecordids",
  "expectedlabels",
  "rationales",
  "reviewoutcome",
  "reviewoutcomes",
  "reviewdecision",
  "reviewdecisions",
  "workerquality",
  "workerqualityfields",
  "workerqualityscore",
  "workerqualityscores",
]);
const JSON_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const COMMON_SCHEMA_KEYS = new Set(["type", "enum", "description"]);
const TYPE_SCHEMA_KEYS = {
  object: new Set(["properties", "required", "additionalProperties"]),
  array: new Set(["items", "minItems", "maxItems"]),
  string: new Set(["minLength", "maxLength"]),
  number: new Set(["minimum", "maximum"]),
  integer: new Set(["minimum", "maximum"]),
  boolean: new Set(),
  null: new Set(),
};
const CREDENTIAL_VALUE = /(?:\bBearer\s+[A-Za-z0-9._~+/=-]{6,}|\bsk-[A-Za-z0-9_-]{20,})/i;
const CREDENTIAL_KEYS = new Set([
  "authorization", "apikey", "secret", "password", "credential", "privatekey", "secretkey", "accesstoken", "refreshtoken",
]);
const CREDENTIAL_KEY_SUFFIXES = [
  "apikey", "secret", "password", "credential", "privatekey", "secretkey", "accesstoken", "refreshtoken",
];
const SAFE_TOKEN_COUNTER_KEYS = new Set([
  "inputtokens", "outputtokens", "totaltokens", "cachedtokens", "reasoningtokens", "acceptedpredictiontokens", "rejectedpredictiontokens",
]);
const MAX_PROVIDER_INPUT_BYTES = 1024 * 1024;
const MAX_PROVIDER_OUTPUT_TOKENS = 32_768;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 100_000;
const MAX_PROVIDER_REQUEST_NODES = 10_000;
const MAX_JSON_ARRAY_LENGTH = 10_000;
const MAX_JSON_OBJECT_KEYS = 10_000;
const MAX_JSON_STRING_BYTES = 1024 * 1024;
const MAX_JSON_CANONICAL_BYTES = 16 * 1024 * 1024;
const MAX_PROVIDER_REQUEST_CANONICAL_BYTES = 2 * 1024 * 1024;

function contractError(message) {
  throw new ProviderError(message, "INVALID_PROVIDER_CONTRACT");
}

function contractLimitError(message) {
  throw new ProviderError(message, "PROVIDER_JSON_LIMIT");
}

function nonblank(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizedKey(key) {
  return String(key).replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function visitJsonNode(state, depth, path) {
  if (depth > MAX_JSON_DEPTH) contractError(`${path} exceeds the maximum JSON depth`);
  state.nodes += 1;
  if (state.nodes > state.maxNodes) contractLimitError(`${path} exceeds the maximum JSON node complexity`);
}

function accountJsonBytes(state, count, path) {
  state.bytes += count;
  if (state.bytes > state.maxBytes) contractLimitError(`${path} exceeds the cumulative JSON byte limit`);
}

function inspectableDescriptors(value, path) {
  if (utilTypes.isProxy(value)) contractError(`${path} contains a forbidden Proxy object`);
  const isArray = Array.isArray(value);
  if (isArray && value.length > MAX_JSON_ARRAY_LENGTH) {
    contractLimitError(`${path} exceeds the maximum array length complexity`);
  }
  if (!isArray) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) contractError(`${path} must be a plain JSON object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string")) contractError(`${path} contains a symbol key`);
  for (const key of keys) {
    if (Buffer.byteLength(key, "utf8") > MAX_JSON_STRING_BYTES) {
      contractLimitError(`${path} contains an object key too large for the byte limit`);
    }
  }
  if (isArray) {
    if (keys.length !== value.length + 1
      || keys.some((key) => key !== "length" && !/^(?:0|[1-9][0-9]*)$/.test(key))) {
      contractError(`${path} array has unsupported properties`);
    }
  } else if (keys.length > MAX_JSON_OBJECT_KEYS) {
    contractLimitError(`${path} exceeds the maximum object-key complexity`);
  }
  const dataKeys = keys.filter((key) => !(isArray && key === "length"));
  if (isArray) dataKeys.sort((left, right) => Number(left) - Number(right));
  else dataKeys.sort();
  for (const key of dataKeys) {
    const descriptor = descriptors[key];
    if (descriptor.get || descriptor.set || !("value" in descriptor)) contractError(`${path}.${key} uses an accessor`);
    if (!descriptor.enumerable) contractError(`${path}.${key} is not enumerable JSON data`);
  }
  return { dataKeys, descriptors, isArray };
}

function canonicalPart(value, state, path, depth) {
  visitJsonNode(state, depth, path);
  if (value === null) {
    accountJsonBytes(state, 4, path);
    return "null";
  }
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > MAX_JSON_STRING_BYTES) contractLimitError(`${path} string is too large for the byte limit`);
    const encoded = JSON.stringify(value);
    accountJsonBytes(state, Buffer.byteLength(encoded, "utf8"), path);
    return encoded;
  }
  if (typeof value === "boolean") {
    const encoded = JSON.stringify(value);
    accountJsonBytes(state, encoded.length, path);
    return encoded;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) contractError(`${path} must contain only finite numbers`);
    const encoded = JSON.stringify(value);
    accountJsonBytes(state, encoded.length, path);
    return encoded;
  }
  if (typeof value !== "object") contractError(`${path} contains an unsupported JSON value`);
  if (state.stack.has(value)) contractError(`${path} contains a cycle`);
  const inspected = inspectableDescriptors(value, path);
  accountJsonBytes(state, 2 + Math.max(0, inspected.dataKeys.length - 1), path);
  state.stack.add(value);
  try {
    const parts = inspected.dataKeys.map((key) => {
      const childPath = inspected.isArray ? `${path}[${key}]` : `${path}.${key}`;
      if (!inspected.isArray) accountJsonBytes(state, Buffer.byteLength(JSON.stringify(key), "utf8") + 1, childPath);
      const child = canonicalPart(inspected.descriptors[key].value, state, childPath, depth + 1);
      return inspected.isArray ? child : `${JSON.stringify(key)}:${child}`;
    });
    return inspected.isArray ? `[${parts.join(",")}]` : `{${parts.join(",")}}`;
  } finally {
    state.stack.delete(value);
  }
}

function walkJsonDescriptors(value, {
  checkCredentials = false,
  checkPrivate = false,
  exactString = null,
  path = "$root",
  state = {
    stack: new Set(),
    nodes: 0,
    bytes: 0,
    maxBytes: MAX_JSON_CANONICAL_BYTES,
    maxNodes: MAX_JSON_NODES,
    exactFound: false,
  },
  depth = 0,
} = {}) {
  visitJsonNode(state, depth, path);
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > MAX_JSON_STRING_BYTES) contractLimitError(`${path} string is too large for the byte limit`);
    accountJsonBytes(state, Buffer.byteLength(JSON.stringify(value), "utf8"), path);
    if (checkCredentials && CREDENTIAL_VALUE.test(value)) contractError(`${path} contains a credential-like value`);
    if (exactString !== null && value.includes(exactString)) state.exactFound = true;
    return;
  }
  if (value === null) {
    accountJsonBytes(state, 4, path);
    return;
  }
  if (typeof value === "boolean") {
    accountJsonBytes(state, value ? 4 : 5, path);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) contractError(`${path} must contain only finite numbers`);
    accountJsonBytes(state, JSON.stringify(value).length, path);
    return;
  }
  if (!value || typeof value !== "object") contractError(`${path} contains an unsupported JSON value`);
  if (state.stack.has(value)) contractError(`${path} contains a cycle`);
  const inspected = inspectableDescriptors(value, path);
  accountJsonBytes(state, 2 + Math.max(0, inspected.dataKeys.length - 1), path);
  state.stack.add(value);
  try {
    for (const key of inspected.dataKeys) {
      const normalized = normalizedKey(key);
      const childPath = inspected.isArray ? `${path}[${key}]` : `${path}.${key}`;
      if (!inspected.isArray) {
        accountJsonBytes(state, Buffer.byteLength(JSON.stringify(key), "utf8") + 1, childPath);
        if (exactString !== null && key.includes(exactString)) state.exactFound = true;
      }
      if (checkCredentials && credentialKey(key)) contractError(`${path} contains a credential-bearing field`);
      if (checkPrivate && GOLD_INPUT_KEYS.has(normalized)) {
        contractError(`Provider input contains evaluator-only field ${normalized}`);
      }
      walkJsonDescriptors(inspected.descriptors[key].value, {
        checkCredentials,
        checkPrivate,
        exactString,
        path: childPath,
        state,
        depth: depth + 1,
      });
    }
  } finally {
    state.stack.delete(value);
  }
}

function deepFreeze(value, stack = new Set()) {
  if (!value || typeof value !== "object" || stack.has(value)) return value;
  stack.add(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if ("value" in descriptor) deepFreeze(descriptor.value, stack);
  }
  return Object.freeze(value);
}

export class ProviderError extends Error {
  constructor(message, code = "PROVIDER_ERROR", options = {}) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    if (!options || typeof options !== "object" || Array.isArray(options) || utilTypes.isProxy(options)) {
      contractError("ProviderError options must be a plain non-Proxy object");
    }
    const descriptors = Object.getOwnPropertyDescriptors(options);
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key];
      if (typeof key !== "string" || descriptor.get || descriptor.set || !("value" in descriptor)) {
        contractError("ProviderError options must contain plain data fields");
      }
    }
    this.retryable = descriptors.retryable?.value === true;
    const telemetry = descriptors.telemetry?.value;
    if (telemetry !== undefined && telemetry !== null) {
      assertNoCredentialValues(telemetry);
      this.telemetry = cloneJson(telemetry);
    } else {
      this.telemetry = null;
    }
  }
}

export function canonicalJson(value) {
  return canonicalPart(value, {
    stack: new Set(),
    nodes: 0,
    bytes: 0,
    maxBytes: MAX_JSON_CANONICAL_BYTES,
    maxNodes: MAX_JSON_NODES,
  }, "$root", 0);
}

export function cloneJson(value) {
  return JSON.parse(canonicalJson(value));
}

export function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function credentialKey(key) {
  const normalized = normalizedKey(key);
  return CREDENTIAL_KEYS.has(normalized)
    || CREDENTIAL_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
    || (normalized.endsWith("token") && !SAFE_TOKEN_COUNTER_KEYS.has(normalized));
}

export function assertNoCredentialValues(value) {
  walkJsonDescriptors(value, { checkCredentials: true });
  return value;
}

export function assertJsonByteSize(value, maxBytes = MAX_JSON_CANONICAL_BYTES, maxNodes = MAX_JSON_NODES) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_JSON_CANONICAL_BYTES) {
    contractError("JSON byte limit must be a positive bounded integer");
  }
  if (!Number.isInteger(maxNodes) || maxNodes < 1 || maxNodes > MAX_JSON_NODES) {
    contractError("JSON node limit must be a positive bounded integer");
  }
  const state = {
    stack: new Set(),
    nodes: 0,
    bytes: 0,
    maxBytes,
    maxNodes,
    exactFound: false,
  };
  walkJsonDescriptors(value, { state });
  return state.bytes;
}

export function containsExactString(value, needle) {
  if (!nonblank(needle) || Buffer.byteLength(needle, "utf8") > MAX_JSON_STRING_BYTES) {
    contractError("Exact-string needle must be a bounded nonblank string");
  }
  const state = {
    stack: new Set(),
    nodes: 0,
    bytes: 0,
    maxBytes: MAX_JSON_CANONICAL_BYTES,
    maxNodes: MAX_JSON_NODES,
    exactFound: false,
  };
  walkJsonDescriptors(value, { exactString: needle, state });
  return state.exactFound;
}

function rejectPrivateInputKeys(value) {
  walkJsonDescriptors(value, { checkPrivate: true, path: "$input" });
}

export function assertNoEvaluatorOnlyFields(value) {
  rejectPrivateInputKeys(value);
  return value;
}

function schemaTypes(schema, path) {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.length === 0 || types.some((type) => !JSON_TYPES.has(type)) || new Set(types).size !== types.length) {
    contractError(`${path}.type must contain unique supported JSON types`);
  }
  return types;
}

function optionalNonNegativeInteger(value, path) {
  if (value !== undefined && (!Number.isInteger(value) || value < 0)) contractError(`${path} must be a non-negative integer`);
}

function validateSchemaNode(schema, path) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) contractError(`${path} must be a schema object`);
  canonicalJson(schema);
  const types = schemaTypes(schema, path);
  const allowed = new Set(COMMON_SCHEMA_KEYS);
  for (const type of types) for (const key of TYPE_SCHEMA_KEYS[type]) allowed.add(key);
  for (const key of Object.keys(schema)) if (!allowed.has(key)) contractError(`${path} uses unsupported schema keyword ${key}`);
  if (Object.hasOwn(schema, "description") && !nonblank(schema.description)) contractError(`${path}.description must be nonblank`);
  if (Object.hasOwn(schema, "enum")) {
    if (!Array.isArray(schema.enum) || schema.enum.length === 0) contractError(`${path}.enum must be a nonempty array`);
    const identities = schema.enum.map((item) => canonicalJson(item));
    if (new Set(identities).size !== identities.length) contractError(`${path}.enum values must be unique`);
  }
  if (types.includes("object")) {
    if (!schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties)) contractError(`${path}.properties is required`);
    if (schema.additionalProperties !== false) contractError(`${path}.additionalProperties must be false`);
    if (!Array.isArray(schema.required)) contractError(`${path}.required must list every property`);
    const propertyNames = Object.keys(schema.properties).sort();
    const required = [...schema.required].sort();
    if (required.some((item) => !nonblank(item)) || new Set(required).size !== required.length || canonicalJson(required) !== canonicalJson(propertyNames)) {
      contractError(`${path}.required must list every property exactly once`);
    }
    for (const [key, child] of Object.entries(schema.properties)) validateSchemaNode(child, `${path}.properties.${key}`);
  }
  if (types.includes("array")) {
    if (!schema.items) contractError(`${path}.items is required`);
    validateSchemaNode(schema.items, `${path}.items`);
    optionalNonNegativeInteger(schema.minItems, `${path}.minItems`);
    optionalNonNegativeInteger(schema.maxItems, `${path}.maxItems`);
    if (schema.minItems !== undefined && schema.maxItems !== undefined && schema.minItems > schema.maxItems) contractError(`${path} has minItems greater than maxItems`);
  }
  if (types.includes("string")) {
    optionalNonNegativeInteger(schema.minLength, `${path}.minLength`);
    optionalNonNegativeInteger(schema.maxLength, `${path}.maxLength`);
    if (schema.minLength !== undefined && schema.maxLength !== undefined && schema.minLength > schema.maxLength) contractError(`${path} has minLength greater than maxLength`);
  }
  for (const key of ["minimum", "maximum"]) if (schema[key] !== undefined && !Number.isFinite(schema[key])) contractError(`${path}.${key} must be finite`);
  if (schema.minimum !== undefined && schema.maximum !== undefined && schema.minimum > schema.maximum) contractError(`${path} has minimum greater than maximum`);
}

export function validateJsonSchema(schema) {
  validateSchemaNode(schema, "$schema");
  return schema;
}

function matchesType(value, type) {
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "array") return Array.isArray(value);
  if (type === "object") return Boolean(value && typeof value === "object" && !Array.isArray(value));
  if (type === "null") return value === null;
  return typeof value === type;
}

function validateValueNode(value, schema, path) {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!types.some((type) => matchesType(value, type))) contractError(`${path} does not match the required schema type`);
  if (schema.enum && !schema.enum.some((item) => canonicalJson(item) === canonicalJson(value))) contractError(`${path} is outside the schema enum`);
  if (value === null) return;
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) contractError(`${path} is below minItems`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) contractError(`${path} exceeds maxItems`);
    value.forEach((item, index) => validateValueNode(item, schema.items, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    for (const key of schema.required) if (!Object.hasOwn(value, key)) contractError(`${path} is missing a required property`);
    for (const key of keys) if (!Object.hasOwn(schema.properties, key)) contractError(`${path} has an unknown additional property`);
    for (const key of keys) validateValueNode(value[key], schema.properties[key], `${path}.${key}`);
    return;
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) contractError(`${path} is below minLength`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) contractError(`${path} exceeds maxLength`);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) contractError(`${path} must be finite`);
    if (schema.minimum !== undefined && value < schema.minimum) contractError(`${path} is below minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) contractError(`${path} exceeds maximum`);
  }
}

export function validateJsonValue(value, schema) {
  validateJsonSchema(schema);
  canonicalJson(value);
  validateValueNode(value, schema, "$result");
  return value;
}

function usageInteger(value, field) {
  if (!Number.isInteger(value) || value < 0) contractError(`usage ${field} must be a non-negative integer`);
  return value;
}

function validateUsageDetails(value, path) {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) contractError(`usage ${path} must be an object`);
  for (const [key, child] of Object.entries(value)) {
    if (!Number.isInteger(child) || child < 0) contractError(`usage ${path}.${key} must be a non-negative integer`);
  }
}

export function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) contractError("usage must be an object");
  canonicalJson(usage);
  const snakeKeys = ["input_tokens", "output_tokens", "total_tokens"];
  const camelKeys = ["inputTokens", "outputTokens", "totalTokens"];
  const snake = snakeKeys.some((key) => Object.hasOwn(usage, key));
  const camel = camelKeys.some((key) => Object.hasOwn(usage, key));
  if (snake && camel) contractError("usage aliases are ambiguous");
  const allowed = snake
    ? new Set([...snakeKeys, "input_tokens_details", "output_tokens_details"])
    : new Set(camelKeys);
  for (const key of Object.keys(usage)) if (!allowed.has(key)) contractError(`usage contains unsupported field ${key}`);
  if (snake) {
    if (!snakeKeys.every((key) => Object.hasOwn(usage, key))) contractError("usage is missing required counters");
    validateUsageDetails(usage.input_tokens_details, "input_tokens_details");
    validateUsageDetails(usage.output_tokens_details, "output_tokens_details");
  } else if (!camelKeys.every((key) => Object.hasOwn(usage, key))) {
    contractError("usage is missing required counters");
  }
  const inputTokens = usageInteger(snake ? usage.input_tokens : usage.inputTokens, "input tokens");
  const outputTokens = usageInteger(snake ? usage.output_tokens : usage.outputTokens, "output tokens");
  const totalTokens = usageInteger(snake ? usage.total_tokens : usage.totalTokens, "total tokens");
  if (totalTokens !== inputTokens + outputTokens) contractError("usage total tokens must equal input plus output tokens");
  return { inputTokens, outputTokens, totalTokens };
}

export function createProviderRequest(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options) || utilTypes.isProxy(options)) {
    contractError("Provider request options must be a plain non-Proxy object");
  }
  assertJsonByteSize(options, MAX_PROVIDER_REQUEST_CANONICAL_BYTES, MAX_PROVIDER_REQUEST_NODES);
  canonicalJson(options);
  const {
    role,
    prompt,
    input,
    schema,
    model,
    benchmarkId,
    caseId,
    mode,
    repetition,
    inputRefs,
    maxOutputTokens,
  } = options;
  if (!PROVIDER_ROLES.has(role)) contractError("Unknown provider role");
  const instruction = typeof prompt?.instruction === "string"
    ? prompt.instruction.replaceAll("\r\n", "\n").replaceAll("\r", "\n")
    : "";
  if (!prompt || prompt.id !== role || !/^v[1-9][0-9]*$/.test(prompt.version) || !/^[a-f0-9]{64}$/.test(prompt.sha256) || !nonblank(instruction)) {
    contractError(`Prompt binding for ${role} is invalid`);
  }
  if (sha256(instruction) !== prompt.sha256) contractError(`Prompt hash for ${role} does not match its LF-canonical instruction`);
  if (!nonblank(model) || !nonblank(benchmarkId) || !nonblank(caseId)) contractError("Provider request model, benchmarkId, and caseId are required");
  if (!["baseline", "advanced"].includes(mode)) contractError("Provider request mode must be baseline or advanced");
  if ((role === "direct-baseline") !== (mode === "baseline")) contractError("Provider role conflicts with execution mode");
  if (!Number.isInteger(repetition) || repetition < 1) contractError("Provider request repetition must be a positive integer");
  if (!Array.isArray(inputRefs) || inputRefs.some((item) => !nonblank(item)) || new Set(inputRefs).size !== inputRefs.length) contractError("Provider inputRefs must be unique nonblank strings");
  if (maxOutputTokens !== undefined && (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > MAX_PROVIDER_OUTPUT_TOKENS)) {
    contractError(`maxOutputTokens must be an integer from 1 to ${MAX_PROVIDER_OUTPUT_TOKENS}`);
  }
  validateJsonSchema(schema);
  rejectPrivateInputKeys(input);
  const inputIdentity = canonicalJson(input);
  if (Buffer.byteLength(inputIdentity, "utf8") > MAX_PROVIDER_INPUT_BYTES) contractError("Provider input exceeds the one MiB byte limit");
  const value = {
    schemaVersion: 1,
    role,
    prompt: { id: prompt.id, version: prompt.version, sha256: prompt.sha256, instruction },
    model,
    benchmarkId,
    caseId,
    mode,
    repetition,
    inputRefs: [...inputRefs],
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    input: cloneJson(input),
    schema: cloneJson(schema),
  };
  assertNoCredentialValues(value);
  return deepFreeze(value);
}

export function hashProviderRequest(request) {
  return sha256(canonicalJson(request));
}
