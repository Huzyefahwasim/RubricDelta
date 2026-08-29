import { types as utilTypes } from "node:util";

import { getPrompt } from "./prompt-registry.js";
import { ROLE_SCHEMAS } from "./provider-schemas.js";
import {
  createProviderTrace,
  FAILURE_REDACTION_FIELDS,
  resourcesFromTrace,
  safeProviderTelemetry,
  TRACE_SCHEMA_VERSION,
} from "./provider-trace.js";
import {
  safeErrorCode,
  safePublicScenario,
  validateBaselineRanking,
  validateCandidates,
  validateCompiledRules,
  validateProviderOptions,
  validateProviderResult,
  validateRuleChanges,
  validateVerifications,
} from "./provider-validation.js";
import {
  assertNoCredentialValues,
  createProviderRequest,
  hashProviderRequest,
  ProviderError,
  validateJsonValue,
} from "../providers/contracts.js";

const MAX_SCHEMA_REPAIRS = 2;
const REPAIR_INSTRUCTION = "Return a complete JSON value matching the supplied schema and public evidence constraints.";

function nonblank(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function unique(values) {
  return [...new Set(values.filter(nonblank))];
}

function ownData(descriptors, key, fallback) {
  const descriptor = descriptors[key];
  if (!descriptor) return fallback;
  if (descriptor.get || descriptor.set || !("value" in descriptor)) throw new Error("unsafe option descriptor");
  return descriptor.value;
}

function safeFailureSnapshot(error) {
  const fallback = {
    code: "PROVIDER_STAGE_FAILED",
    retryable: false,
    telemetry: safeProviderTelemetry(null),
  };
  try {
    if (!error || (typeof error !== "object" && typeof error !== "function") || utilTypes.isProxy(error)) return fallback;
    const descriptors = Object.getOwnPropertyDescriptors(error);
    const code = ownData(descriptors, "code", null);
    const retryable = ownData(descriptors, "retryable", false);
    const telemetry = ownData(descriptors, "telemetry", null);
    return {
      code: safeErrorCode(code),
      retryable: retryable === true,
      telemetry: safeProviderTelemetry(telemetry),
    };
  } catch {
    return fallback;
  }
}

function terminalError(role, trace) {
  const error = new ProviderError(
    `Provider ${role} exhausted two schema repair calls after invalid output`,
    "PROVIDER_SCHEMA_REPAIR_EXHAUSTED",
  );
  error.trace = trace.events();
  return error;
}

function recordFailure({ error, role, prompt, inputRefs, trace, schemaRepairAttempt }) {
  const failure = safeFailureSnapshot(error);
  const telemetry = failure.telemetry;
  const outputWithheld = failure.code === "PROVIDER_RESULT_INVALID"
    || failure.code === "PROVIDER_MODEL_MISMATCH";
  const common = {
    role,
    prompt,
    inputRefs,
    status: "failed",
    actualModel: telemetry.model,
    responseId: telemetry.responseId,
    usage: telemetry.usage,
    latencyMs: telemetry.latencyMs,
    schemaRepairAttempt,
    transportAttempts: telemetry.transportAttempts,
    verification: "failed",
    terminalState: "failed",
    redactionApplied: true,
    redactionFields: outputWithheld
      ? [...FAILURE_REDACTION_FIELDS, "provider.output"]
      : FAILURE_REDACTION_FIELDS,
  };
  trace.record({
    ...common,
    type: "provider-result",
    payload: {
      code: failure.code,
      attempts: telemetry.attempts,
      estimatedCostUsd: telemetry.estimatedCostUsd,
    },
  });
  trace.record({
    ...common,
    type: "terminal",
    payload: { code: failure.code, estimatedCostUsd: telemetry.estimatedCostUsd },
  });
  const wrapped = new ProviderError(`Provider ${role} failed without fallback`, failure.code, {
    retryable: failure.retryable,
    telemetry,
  });
  wrapped.trace = trace.events();
  throw wrapped;
}

function resultEvent(trace, {
  role, prompt, inputRefs, result, schemaRepairAttempt, status, verification, data,
}) {
  const outputWithheld = status === "invalid" && data === undefined;
  trace.record({
    role,
    type: "provider-result",
    prompt,
    inputRefs,
    status,
    actualModel: result.model,
    responseId: result.responseId,
    usage: result.usage,
    latencyMs: result.latencyMs,
    schemaRepairAttempt,
    transportAttempts: result.transportAttempts,
    verification,
    redactionApplied: outputWithheld,
    redactionFields: outputWithheld ? ["provider.output"] : [],
    payload: {
      responseId: result.responseId,
      attempts: result.attempts,
      estimatedCostUsd: result.estimatedCostUsd,
      ...(data === undefined ? {} : { data }),
    },
  });
}

function verificationEvent(trace, {
  role, prompt, inputRefs, result, schemaRepairAttempt, status, outcome, code, extra = {},
}) {
  trace.record({
    role,
    type: "verification",
    prompt,
    inputRefs,
    status,
    actualModel: result.model,
    responseId: result.responseId,
    usage: result.usage,
    latencyMs: result.latencyMs,
    schemaRepairAttempt,
    transportAttempts: result.transportAttempts,
    verification: outcome,
    payload: { code, estimatedCostUsd: result.estimatedCostUsd, ...extra },
  });
}

function repairInput(input, directive) {
  return directive === null ? input : { ...input, controllerRepair: directive };
}

async function callStage({
  role, input, inputRefs, validate, provider, model, benchmarkId, caseId, mode, repetition, trace,
}) {
  const prompt = getPrompt(role);
  const schema = ROLE_SCHEMAS[role];
  let directive = null;
  for (let repair = 0; repair <= MAX_SCHEMA_REPAIRS; repair += 1) {
    const request = createProviderRequest({
      role,
      prompt,
      input: repairInput(input, directive),
      schema,
      model,
      benchmarkId,
      caseId,
      mode,
      repetition,
      inputRefs,
    });
    trace.record({
      role,
      type: "provider-call",
      prompt,
      inputRefs,
      schemaRepairAttempt: repair,
      payload: { requestHash: hashProviderRequest(request), request },
    });
    let raw;
    try { raw = await provider.complete(request); }
    catch (error) { recordFailure({ error, role, prompt, inputRefs, trace, schemaRepairAttempt: repair }); }
    let result;
    try { result = validateProviderResult(raw, model); }
    catch (error) { recordFailure({ error, role, prompt, inputRefs, trace, schemaRepairAttempt: repair }); }

    let validated;
    let invalid = null;
    try { validateJsonValue(result.data, schema); }
    catch { invalid = { reason: "json-schema-validation-failed", pathClass: "schema-shape" }; }
    if (invalid === null) {
      try { validated = validate(result.data); }
      catch { invalid = { reason: "semantic-contract-validation-failed", pathClass: "public-evidence-binding" }; }
    }
    if (invalid !== null) {
      resultEvent(trace, {
        role, prompt, inputRefs, result, schemaRepairAttempt: repair, status: "invalid", verification: "rejected",
      });
      verificationEvent(trace, {
        role, prompt, inputRefs, result, schemaRepairAttempt: repair, status: "invalid", outcome: "rejected",
        code: "INVALID_STAGE_OUTPUT", extra: invalid,
      });
      if (repair === MAX_SCHEMA_REPAIRS) {
        trace.record({
          role,
          type: "terminal",
          prompt,
          inputRefs,
          status: "failed",
          actualModel: result.model,
          responseId: result.responseId,
          usage: result.usage,
          latencyMs: result.latencyMs,
          schemaRepairAttempt: repair,
          transportAttempts: result.transportAttempts,
          verification: "failed",
          terminalState: "failed",
          payload: { code: "PROVIDER_SCHEMA_REPAIR_EXHAUSTED", estimatedCostUsd: result.estimatedCostUsd },
        });
        throw terminalError(role, trace);
      }
      directive = {
        attempt: repair + 1,
        reason: invalid.reason,
        pathClass: invalid.pathClass,
        instruction: REPAIR_INSTRUCTION,
      };
      trace.record({
        role,
        type: "retry",
        prompt,
        inputRefs,
        status: "running",
        actualModel: result.model,
        responseId: result.responseId,
        usage: result.usage,
        latencyMs: result.latencyMs,
        schemaRepairAttempt: repair + 1,
        transportAttempts: result.transportAttempts,
        verification: "rejected",
        payload: { ...invalid, nextAttempt: repair + 2, estimatedCostUsd: result.estimatedCostUsd },
      });
      continue;
    }
    resultEvent(trace, {
      role, prompt, inputRefs, result, schemaRepairAttempt: repair, status: "completed", verification: "pending", data: result.data,
    });
    verificationEvent(trace, {
      role, prompt, inputRefs, result, schemaRepairAttempt: repair, status: "completed", outcome: "validated", code: "VALIDATED",
    });
    return { data: validated, result, prompt, inputRefs, schemaRepairAttempt: repair };
  }
  throw new ProviderError("Provider stage reached an impossible state", "PROVIDER_INTERNAL");
}

function recordRecovery(trace, stage) {
  if (stage.data?.recovered !== true) return;
  verificationEvent(trace, {
    role: "change-analyst",
    prompt: stage.prompt,
    inputRefs: stage.inputRefs,
    result: stage.result,
    schemaRepairAttempt: stage.schemaRepairAttempt,
    status: "completed",
    outcome: "validated",
    code: "EVIDENCE_BOUND_RECOVERY",
    extra: { unresolved: stage.data.unresolved, unresolvedRuleIds: stage.data.unresolvedRuleIds },
  });
}

function recordSuccessTerminal(trace, role, stage) {
  trace.record({
    role,
    type: "terminal",
    prompt: stage.prompt,
    inputRefs: stage.inputRefs,
    status: "completed",
    actualModel: stage.result.model,
    responseId: stage.result.responseId,
    usage: stage.result.usage,
    latencyMs: stage.result.latencyMs,
    schemaRepairAttempt: stage.schemaRepairAttempt,
    transportAttempts: stage.result.transportAttempts,
    verification: "validated",
    terminalState: "complete",
    payload: { outcome: "complete", estimatedCostUsd: stage.result.estimatedCostUsd },
  });
}

function commonOptions(scenario, options, mode) {
  try {
    if (!options || typeof options !== "object" || Array.isArray(options) || utilTypes.isProxy(options)) throw new Error("unsafe options");
    const descriptors = Object.getOwnPropertyDescriptors(options);
    const provider = ownData(descriptors, "provider");
    const model = ownData(descriptors, "model");
    const benchmarkId = ownData(descriptors, "benchmarkId");
    const repetition = ownData(descriptors, "repetition", 1);
    const validated = validateProviderOptions({ provider, model, benchmarkId, repetition });
    const runId = ownData(descriptors, "runId", `provider-${mode}-${scenario.id}-r${repetition}`);
    const now = ownData(descriptors, "now", () => new Date().toISOString());
    if (!nonblank(runId) || runId.length > 256 || typeof now !== "function") throw new Error("invalid trace binding");
    assertNoCredentialValues({ runId });
    return { ...validated, runId, now };
  } catch (error) {
    if (error instanceof ProviderError && error.code === "INVALID_PROVIDER_CONFIGURATION") throw error;
    throw new ProviderError("Provider trace configuration is invalid", "INVALID_PROVIDER_CONFIGURATION");
  }
}

function verifierCandidate(candidate) {
  return {
    recordId: candidate.recordId,
    existingLabel: candidate.existingLabel,
    proposedLabel: candidate.proposedLabel,
    ruleDeltaIds: [...candidate.ruleDeltaIds],
    evidence: candidate.evidence.map((item) => ({
      type: item.type,
      deltaId: item.deltaId,
      recordId: item.recordId,
      quote: item.quote,
      citation: item.citation,
      detail: item.detail,
    })),
  };
}

export async function analyzeScenarioWithProvider(scenarioValue, options = {}) {
  const scenario = safePublicScenario(scenarioValue);
  const settings = commonOptions(scenario, options, "advanced");
  const trace = createProviderTrace({
    runId: settings.runId, scenarioId: scenario.id, provider: settings.provider, model: settings.model, now: settings.now,
  });
  const base = {
    provider: settings.provider,
    model: settings.model,
    benchmarkId: settings.benchmarkId,
    caseId: scenario.id,
    mode: "advanced",
    repetition: settings.repetition,
    trace,
  };
  const compiler = await callStage({
    ...base,
    role: "rule-compiler",
    input: { oldGuideline: scenario.oldGuideline, newGuideline: scenario.newGuideline },
    inputRefs: unique([scenario.id, scenario.oldGuideline.version, scenario.newGuideline.version]),
    validate: (data) => validateCompiledRules(data, scenario),
  });
  const compiled = compiler.data;
  const analyst = await callStage({
    ...base,
    role: "change-analyst",
    input: compiled,
    inputRefs: unique([scenario.id, ...compiled.oldRules.map((rule) => rule.id), ...compiled.newRules.map((rule) => rule.id)]),
    validate: (data) => validateRuleChanges(data, scenario, compiled),
  });
  recordRecovery(trace, analyst);
  const analysis = { ...compiled, ...analyst.data };
  const investigator = await callStage({
    ...base,
    role: "impact-investigator",
    input: { scenario, analysis },
    inputRefs: unique([scenario.id, ...scenario.records.map((record) => record.id), ...analysis.deltas.map((delta) => delta.id)]),
    validate: (data) => validateCandidates(data, scenario, analysis),
  });
  const candidates = investigator.data;
  const byRecord = new Map(candidates.map((candidate) => [candidate.recordId, candidate]));
  const blindedCandidates = scenario.records.map((record) => verifierCandidate(byRecord.get(record.id)));
  const verifier = await callStage({
    ...base,
    role: "independent-verifier",
    input: { scenario, analysis, candidates: blindedCandidates },
    inputRefs: unique([scenario.id, ...scenario.records.map((record) => record.id), ...analysis.deltas.map((delta) => delta.id)]),
    validate: (data) => validateVerifications(data, candidates, scenario, analysis),
  });
  recordSuccessTerminal(trace, "independent-verifier", verifier);
  const events = trace.events();
  return { scenario, analysis, rankedCandidates: verifier.data, trace: events, resources: resourcesFromTrace(events) };
}

export async function analyzeBaselineWithProvider(scenarioValue, options = {}) {
  const scenario = safePublicScenario(scenarioValue);
  const settings = commonOptions(scenario, options, "baseline");
  const trace = createProviderTrace({
    runId: settings.runId, scenarioId: scenario.id, provider: settings.provider, model: settings.model, now: settings.now,
  });
  const inputRefs = unique([scenario.id, scenario.oldGuideline.version, scenario.newGuideline.version, ...scenario.records.map((record) => record.id)]);
  const stage = await callStage({
    role: "direct-baseline",
    input: { scenario },
    inputRefs,
    validate: (data) => validateBaselineRanking(data, scenario),
    provider: settings.provider,
    model: settings.model,
    benchmarkId: settings.benchmarkId,
    caseId: scenario.id,
    mode: "baseline",
    repetition: settings.repetition,
    trace,
  });
  recordSuccessTerminal(trace, "direct-baseline", stage);
  const events = trace.events();
  return { scenario, ranking: stage.data, trace: events, resources: resourcesFromTrace(events) };
}

export { ROLE_SCHEMAS, TRACE_SCHEMA_VERSION };
