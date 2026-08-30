import { randomUUID } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { analyzeScenario } from "../agents/workflow.js";
import { createArtifactStore } from "../artifacts/store.js";
import { exportApprovedCSV } from "../domain/csv.js";
import { redactCredentialLikeText } from "../domain/credentials.js";
import { createDecisionLedger } from "../domain/decisions.js";
import { responseHeaders } from "./headers.js";

function sendJson(response, status, value, extraHeaders = {}) {
  response.writeHead(status, { ...responseHeaders("application/json; charset=utf-8"), "Cache-Control": "no-store", ...extraHeaders });
  response.end(JSON.stringify(value));
}

function sendText(response, status, contentType, value, cacheControl = "no-store") {
  response.writeHead(status, { ...responseHeaders(contentType), "Cache-Control": cacheControl });
  response.end(value);
}

export class RequestError extends Error {
  constructor(status, code, field, message) {
    super(code);
    this.name = "RequestError";
    this.status = status;
    this.body = { error: { code, message, fields: [{ field, message }] } };
  }
}

function invalid(field, message) {
  throw new RequestError(400, "INVALID_REQUEST", field, message);
}

function plain(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function exactObject(value, fields, path) {
  if (!plain(value)) invalid(path, "Expected an object");
  if (Object.keys(value).some((key) => !fields.includes(key))) invalid(path, "Object contains unknown fields");
}

const INPUT_LIMITS = Object.freeze({
  records: 100,
  id: 128,
  title: 200,
  descriptor: 64,
  guidelineText: 50_000,
  recordText: 10_000,
  label: 128,
  reviewer: 128,
  reason: 1_000,
});

function nonblank(value, field, maxLength) {
  if (typeof value !== "string" || value.trim().length === 0) invalid(field, "Expected a nonblank string");
  if (value.length > maxLength) invalid(field, `Must be at most ${maxLength} characters`);
}

function validateScenarioInput(scenario) {
  const scenarioFields = ["id", "title", "difficulty", "changeType", "oldGuideline", "newGuideline", "records"];
  exactObject(scenario, scenarioFields, "scenario");
  nonblank(scenario.id, "scenario.id", INPUT_LIMITS.id);
  nonblank(scenario.title, "scenario.title", INPUT_LIMITS.title);
  nonblank(scenario.difficulty, "scenario.difficulty", INPUT_LIMITS.descriptor);
  nonblank(scenario.changeType, "scenario.changeType", INPUT_LIMITS.descriptor);
  for (const name of ["oldGuideline", "newGuideline"]) {
    exactObject(scenario[name], ["version", "text"], `scenario.${name}`);
    nonblank(scenario[name].version, `scenario.${name}.version`, INPUT_LIMITS.id);
    nonblank(scenario[name].text, `scenario.${name}.text`, INPUT_LIMITS.guidelineText);
  }
  if (!Array.isArray(scenario.records) || scenario.records.length === 0) invalid("scenario.records", "Expected at least one record");
  if (scenario.records.length > INPUT_LIMITS.records) invalid("scenario.records", `Must contain at most ${INPUT_LIMITS.records} records`);
  const ids = new Set();
  for (let index = 0; index < scenario.records.length; index += 1) {
    const record = scenario.records[index];
    const path = `scenario.records[${index}]`;
    exactObject(record, ["id", "text", "existingLabel"], path);
    nonblank(record.id, `${path}.id`, INPUT_LIMITS.id);
    nonblank(record.text, `${path}.text`, INPUT_LIMITS.recordText);
    nonblank(record.existingLabel, `${path}.existingLabel`, INPUT_LIMITS.label);
    if (ids.has(record.id)) invalid(`${path}.id`, "Duplicate record ID");
    ids.add(record.id);
  }
}

function validateCreateBody(body) {
  exactObject(body, ["scenario"], "$");
  if (!Object.hasOwn(body, "scenario")) invalid("scenario", "Required field");
  validateScenarioInput(body.scenario);
  return body;
}

const MAX_BODY_BYTES = 1024 * 1024;

function payloadTooLarge() {
  return new RequestError(413, "PAYLOAD_TOO_LARGE", "$", "Request body exceeds one MiB");
}

function validateHumanBody(body, run, undo = false) {
  const allowed = undo ? ["recordId", "reviewer", "reason"] : ["recordId", "decision", "reviewer", "reason"];
  exactObject(body, allowed, "$");
  nonblank(body.recordId, "recordId", INPUT_LIMITS.id);
  if (!run.ledger.candidates().some((candidate) => candidate.recordId === body.recordId)) invalid("recordId", "Unknown record ID");
  if (!undo && !["approve", "reject", "escalate"].includes(body.decision)) invalid("decision", "Expected approve, reject, or escalate");
  nonblank(body.reviewer, "reviewer", INPUT_LIMITS.reviewer);
  if (Object.hasOwn(body, "reason")) nonblank(body.reason, "reason", INPUT_LIMITS.reason);
  return body;
}

async function readJson(request) {
  const contentType = request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") throw new RequestError(415, "UNSUPPORTED_MEDIA_TYPE", "content-type", "Content-Type must be application/json");
  const declaredLength = request.headers["content-length"];
  const declaredOversized = declaredLength !== undefined && Number(declaredLength) > MAX_BODY_BYTES;
  const chunks = [];
  let received = 0;
  let oversized = declaredOversized;
  for await (const chunk of request) {
    received += chunk.length;
    if (received > MAX_BODY_BYTES) oversized = true;
    if (!oversized) chunks.push(chunk);
  }
  if (oversized) throw payloadTooLarge();
  try {
    return JSON.parse(Buffer.concat(chunks, received).toString("utf8"));
  } catch {
    throw new RequestError(400, "MALFORMED_JSON", "$", "Request body must be valid JSON");
  }
}

function jsonLines(events) {
  return events.length === 0 ? "" : `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

function snapshot(run) {
  return {
    runId: run.runId,
    createdAt: run.createdAt,
    status: "complete",
    scenario: structuredClone(run.scenario),
    analysis: structuredClone(run.analysis),
    recommendations: run.ledger.candidates(),
    decisions: run.ledger.events(),
    escalated: run.escalated,
  };
}

function sanitizeHumanText(value) {
  if (typeof value !== "string") return value;
  let clean = value;
  const configuredSecret = process.env.OPENAI_API_KEY;
  if (configuredSecret) clean = clean.replaceAll(configuredSecret, "[REDACTED]");
  return redactCredentialLikeText(clean).trim();
}

function sanitizeValue(value) {
  if (typeof value === "string") return sanitizeHumanText(value);
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (plain(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeValue(item)]));
  return value;
}

function humanCommand(body) {
  const command = { ...body, reviewer: sanitizeHumanText(body.reviewer) };
  if (Object.hasOwn(command, "reason")) command.reason = sanitizeHumanText(command.reason);
  return command;
}

function checkpoint(run, event) {
  run.trace.push({
    runId: run.runId,
    scenarioId: run.scenario.id,
    sequence: run.trace.length + 1,
    timestamp: event.timestamp,
    agent: "human-reviewer",
    phase: "human-checkpoint",
    type: event.type === "decision" ? "human-decision" : "human-undo",
    payload: structuredClone(event),
  });
}

function replayCommand(event) {
  const command = { recordId: event.recordId, reviewer: event.reviewer };
  if (event.reason !== null) command.reason = event.reason;
  if (event.type === "decision") command.decision = event.decision;
  return command;
}

function cloneLedger(run) {
  const originalEvents = run.ledger.events();
  let timestampIndex = 0;
  const candidates = run.ledger.candidates().map((candidate) => ({ ...candidate, status: "pending" }));
  const ledger = createDecisionLedger(candidates, {
    now() {
      const timestamp = originalEvents[timestampIndex]?.timestamp;
      timestampIndex += 1;
      return timestamp ?? new Date().toISOString();
    },
  });
  for (const event of originalEvents) {
    if (event.type === "decision") ledger.decide(replayCommand(event));
    else ledger.undo(replayCommand(event));
  }
  if (JSON.stringify(ledger.events()) !== JSON.stringify(originalEvents)) throw new Error("Decision ledger replay failed integrity validation");
  return ledger;
}

function createShadowRun(run) {
  return {
    runId: run.runId,
    createdAt: run.createdAt,
    scenario: structuredClone(run.scenario),
    analysis: structuredClone(run.analysis),
    trace: structuredClone(run.trace),
    escalated: run.escalated,
    ledger: cloneLedger(run),
    revision: run.revision + 1,
  };
}

function revisionName(revision) {
  return `rev-${String(revision).padStart(6, "0")}`;
}

async function publishSnapshot(store, run) {
  const revision = revisionName(run.revision);
  const prefix = `runs/${run.runId}/revisions/${revision}`;
  const state = snapshot(run);
  await store.write(`${prefix}/manifest.json`, `${JSON.stringify({
    schemaVersion: 1,
    runId: run.runId,
    revision,
    scenarioId: run.scenario.id,
    createdAt: run.createdAt,
    provider: "deterministic",
    status: "complete",
  }, null, 2)}\n`);
  await store.write(`${prefix}/input.json`, `${JSON.stringify(run.scenario, null, 2)}\n`);
  await store.write(`${prefix}/state.json`, `${JSON.stringify(state, null, 2)}\n`);
  await store.write(`${prefix}/recommendations.json`, `${JSON.stringify(state.recommendations, null, 2)}\n`);
  await store.write(`${prefix}/decisions.json`, `${JSON.stringify(state.decisions, null, 2)}\n`);
  await store.write(`${prefix}/trajectory.jsonl`, jsonLines(run.trace));
  await store.write(`${prefix}/export.csv`, exportApprovedCSV({ runId: run.runId, ledger: run.ledger }));
  await store.write(`runs/${run.runId}/current.json`, `${JSON.stringify({ schemaVersion: 1, runId: run.runId, revision }, null, 2)}\n`);
}

function serializeMutation(slot, operation) {
  const result = slot.mutation.then(() => operation(slot.current));
  slot.mutation = result.then(() => undefined, () => undefined);
  return result;
}
const STATIC_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".ico", "image/x-icon"],
]);

function contained(root, target) {
  const path = relative(root, target);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

const WINDOWS_RESERVED = /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\..*)?$/i;
const WINDOWS_SHORT_NAME = /^[^~]{1,6}~[1-9][0-9]*(?:\..*)?$/i;

export function requestPathIsSafe(requestUrl) {
  const rawPath = String(requestUrl ?? "").split(/[?#]/, 1)[0];
  if (!rawPath.startsWith("/") || rawPath.includes("\\") || rawPath.includes("\0")) return false;
  try {
    const decoded = decodeURIComponent(rawPath);
    const parts = decoded.split("/").filter(Boolean);
    return !decoded.includes("\\") && !decoded.includes("\0")
      && !parts.some((part) => part === "." || part === ".." || part.startsWith(".")
        || part.includes(":") || /[. ]$/.test(part) || WINDOWS_RESERVED.test(part) || WINDOWS_SHORT_NAME.test(part));
  } catch {
    return false;
  }
}

export async function serveStaticFile({ publicRoot, requestUrl, method = "GET", response }) {
  if (!requestPathIsSafe(requestUrl)) return false;
  const rawPath = String(requestUrl).split(/[?#]/, 1)[0];
  const decoded = decodeURIComponent(rawPath);
  const parts = decoded.split("/").filter(Boolean);
  if (decoded !== "/" && decoded.endsWith("/")) return false;
  const configuredRoot = resolve(publicRoot);
  const requestedRelative = decoded === "/" ? "index.html" : parts.join(sep);
  const target = resolve(configuredRoot, requestedRelative);
  if (!contained(configuredRoot, target)) return false;
  try {
    const rootStat = await lstat(configuredRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return false;
    const targetStat = await lstat(target);
    if (!targetStat.isFile() || targetStat.isSymbolicLink()) return false;
    const canonicalRoot = await realpath(configuredRoot);
    const canonicalTarget = await realpath(target);
    if (!contained(canonicalRoot, canonicalTarget)) return false;
    const canonicalRelative = relative(canonicalRoot, canonicalTarget);
    const requestedIdentity = process.platform === "win32" ? requestedRelative.toLowerCase() : requestedRelative;
    const canonicalIdentity = process.platform === "win32" ? canonicalRelative.toLowerCase() : canonicalRelative;
    if (requestedIdentity !== canonicalIdentity) return false;
    if (method !== "GET") {
      sendJson(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed" } }, { Allow: "GET" });
      return true;
    }
    const content = await readFile(canonicalTarget);
    sendText(response, 200, STATIC_TYPES.get(extname(canonicalTarget).toLowerCase()) ?? "application/octet-stream", content, "public, max-age=0, must-revalidate");
    return true;
  } catch {
    return false;
  }
}

export function createRouter({ artifactRoot, artifactStore, dataService }) {
  const store = artifactStore ?? createArtifactStore(artifactRoot);
  const runs = new Map();

  return async function route(request, response, pathname) {
    const allowedMethod = new Map([
      ["/api/health", "GET"],
      ["/api/demo", "GET"],
      ["/api/evaluation", "GET"],
      ["/api/runs", "POST"],
    ]).get(pathname);
    if (allowedMethod && request.method !== allowedMethod) {
      sendJson(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed" } }, { Allow: allowedMethod });
      return true;
    }
    const dynamicMethod = [
      [/^\/api\/runs\/run-[a-f0-9-]+\/(?:export\.csv|trajectory\.jsonl)$/, "GET"],
      [/^\/api\/runs\/run-[a-f0-9-]+\/(?:decisions|undo)$/, "POST"],
      [/^\/api\/runs\/run-[a-f0-9-]+$/, "GET"],
    ].find(([pattern]) => pattern.test(pathname))?.[1];
    if (dynamicMethod && request.method !== dynamicMethod) {
      sendJson(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed" } }, { Allow: dynamicMethod });
      return true;
    }
    if (request.method === "GET" && pathname === "/api/health") {
      sendJson(response, 200, { status: "ok" });
      return true;
    }
    if (request.method === "GET" && pathname === "/api/demo") {
      sendJson(response, 200, dataService.demo());
      return true;
    }
    if (request.method === "GET" && pathname === "/api/evaluation") {
      sendJson(response, 200, dataService.evaluation());
      return true;
    }
    if (request.method === "POST" && pathname === "/api/runs") {
      const body = validateCreateBody(await readJson(request));
      const scenario = sanitizeValue(body.scenario);
      const runId = `run-${randomUUID()}`;
      const result = analyzeScenario(scenario, { runId });
      const run = {
        runId,
        createdAt: new Date().toISOString(),
        scenario: structuredClone(scenario),
        analysis: structuredClone(result.analysis),
        trace: structuredClone(result.trace),
        escalated: result.escalated,
        ledger: createDecisionLedger(result.rankedCandidates),
        revision: 1,
      };
      await publishSnapshot(store, run);
      runs.set(runId, { current: run, mutation: Promise.resolve() });
      sendJson(response, 201, { runId, run: snapshot(run) });
      return true;
    }
    const exportMatch = pathname.match(/^\/api\/runs\/(run-[a-f0-9-]+)\/export\.csv$/);
    if (request.method === "GET" && exportMatch) {
      const slot = runs.get(exportMatch[1]);
      if (!slot) {
        sendJson(response, 404, { error: { code: "NOT_FOUND", message: "Run not found" } });
        return true;
      }
      const run = slot.current;
      sendText(response, 200, "text/csv; charset=utf-8", exportApprovedCSV({ runId: run.runId, ledger: run.ledger }));
      return true;
    }
    const trajectoryMatch = pathname.match(/^\/api\/runs\/(run-[a-f0-9-]+)\/trajectory\.jsonl$/);
    if (request.method === "GET" && trajectoryMatch) {
      const slot = runs.get(trajectoryMatch[1]);
      if (!slot) {
        sendJson(response, 404, { error: { code: "NOT_FOUND", message: "Run not found" } });
        return true;
      }
      sendText(response, 200, "application/x-ndjson; charset=utf-8", jsonLines(slot.current.trace));
      return true;
    }
    const decisionMatch = pathname.match(/^\/api\/runs\/(run-[a-f0-9-]+)\/decisions$/);
    if (request.method === "POST" && decisionMatch) {
      const slot = runs.get(decisionMatch[1]);
      if (!slot) {
        sendJson(response, 404, { error: { code: "NOT_FOUND", message: "Run not found" } });
        return true;
      }
      const command = humanCommand(validateHumanBody(await readJson(request), slot.current));
      const mutation = await serializeMutation(slot, async (current) => {
        const shadow = createShadowRun(current);
        const event = shadow.ledger.decide(command);
        checkpoint(shadow, event);
        await publishSnapshot(store, shadow);
        slot.current = shadow;
        return { event, run: snapshot(shadow) };
      });
      sendJson(response, 200, mutation);
      return true;
    }
    const undoMatch = pathname.match(/^\/api\/runs\/(run-[a-f0-9-]+)\/undo$/);
    if (request.method === "POST" && undoMatch) {
      const slot = runs.get(undoMatch[1]);
      if (!slot) {
        sendJson(response, 404, { error: { code: "NOT_FOUND", message: "Run not found" } });
        return true;
      }
      const command = humanCommand(validateHumanBody(await readJson(request), slot.current, true));
      const mutation = await serializeMutation(slot, async (current) => {
        const shadow = createShadowRun(current);
        const candidate = shadow.ledger.candidates().find((item) => item.recordId === command.recordId);
        if (candidate.status === "pending") invalid("recordId", "Record has no decision to undo");
        const event = shadow.ledger.undo(command);
        checkpoint(shadow, event);
        await publishSnapshot(store, shadow);
        slot.current = shadow;
        return { event, run: snapshot(shadow) };
      });
      sendJson(response, 200, mutation);
      return true;
    }
    const match = pathname.match(/^\/api\/runs\/(run-[a-f0-9-]+)$/);
    if (request.method === "GET" && match) {
      const slot = runs.get(match[1]);
      if (!slot) {
        sendJson(response, 404, { error: { code: "NOT_FOUND", message: "Run not found" } });
        return true;
      }
      sendJson(response, 200, snapshot(slot.current));
      return true;
    }
    return false;
  };
}
