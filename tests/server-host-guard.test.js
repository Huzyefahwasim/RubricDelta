import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { request as httpRequest } from "node:http";
import { createRubricDeltaServer } from "../src/server/index.js";
import { evaluateRequestAuthority, parseAuthority, parseHttpOrigin } from "../src/server/host-guard.js";

const REBIND_HOST = "rebind.attacker.invalid";

function scenario() {
  return {
    scenario: {
      id: "guard-case",
      title: "Host guard scenario",
      difficulty: "medium",
      changeType: "exception_added",
      oldGuideline: { version: "v1", text: "Route refund requests to BILLING." },
      newGuideline: { version: "v2", text: "Route refund requests to BILLING. Exception: route stolen card reports to FRAUD." },
      records: [
        { id: "rec-01", text: "My card was stolen and I want a refund.", existingLabel: "BILLING" },
        { id: "rec-02", text: "Please refund my duplicate charge.", existingLabel: "BILLING" },
        { id: "rec-03", text: "Someone stole my card and used it for a purchase.", existingLabel: "BILLING" },
      ],
    },
  };
}

async function startServer(t) {
  const artifactRoot = await mkdtemp(join(tmpdir(), "rubricdelta-guard-"));
  const server = createRubricDeltaServer({ port: 0, artifactRoot });
  await server.start();
  t.after(async () => {
    await server.stop();
    await rm(artifactRoot, { recursive: true, force: true });
  });
  return { server, artifactRoot, port: Number(new URL(server.address()).port) };
}

// Sends the exact wire headers an attacker-controlled page would produce: node:http
// emits any explicit `host` / `origin` header verbatim instead of its own value.
function send(port, { method = "GET", path = "/api/health", headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(body, "utf8");
    const outgoing = { ...headers };
    if (payload) outgoing["content-length"] = String(payload.length);
    const client = httpRequest({ host: "127.0.0.1", port, path, method, headers: outgoing }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      response.on("error", reject);
    });
    client.on("error", reject);
    client.end(payload ?? undefined);
  });
}

function rawGet(port, headerLines) {
  return new Promise((resolve, reject) => {
    const payload = ["GET /api/health HTTP/1.1", ...headerLines, "Connection: close", "", ""].join("\r\n");
    let raw = "";
    const socket = connect({ host: "127.0.0.1", port }, () => socket.end(payload));
    socket.setEncoding("utf8");
    socket.setTimeout(10_000, () => socket.destroy(new Error("raw request timed out")));
    socket.on("data", (chunk) => { raw += chunk; });
    socket.on("error", reject);
    socket.on("close", () => resolve({ status: Number(raw.split("\r\n", 1)[0].split(" ")[1]), raw }));
  });
}

function jsonHeaders(hostValue, extra = {}) {
  return { host: hostValue, "content-type": "application/json", ...extra };
}

async function createRun(port) {
  const response = await send(port, {
    method: "POST",
    path: "/api/runs",
    headers: jsonHeaders(`127.0.0.1:${port}`),
    body: JSON.stringify(scenario()),
  });
  assert.equal(response.status, 201, response.body);
  return JSON.parse(response.body);
}

test("loopback host and matching origin keep the normal localhost workflow intact", async (t) => {
  const { port } = await startServer(t);
  const created = await createRun(port);
  const { runId } = created;
  assert.match(runId, /^run-[a-f0-9-]+$/);
  const recordId = created.run.recommendations[0].recordId;

  for (const hostValue of [`127.0.0.1:${port}`, `localhost:${port}`, `LOCALHOST:${port}`, `[::1]:${port}`]) {
    const health = await send(port, { headers: { host: hostValue } });
    assert.equal(health.status, 200, `${hostValue} -> ${health.body}`);
  }

  const sameOrigin = await send(port, {
    method: "POST",
    path: `/api/runs/${runId}/decisions`,
    headers: jsonHeaders(`127.0.0.1:${port}`, { origin: `http://127.0.0.1:${port}` }),
    body: JSON.stringify({ recordId, decision: "approve", reviewer: "loopback-reviewer" }),
  });
  assert.equal(sameOrigin.status, 200, sameOrigin.body);

  const exported = await send(port, { path: `/api/runs/${runId}/export.csv`, headers: { host: `localhost:${port}` } });
  assert.equal(exported.status, 200, exported.body);
  assert.ok(exported.body.includes(recordId), exported.body);

  const undone = await send(port, {
    method: "POST",
    path: `/api/runs/${runId}/undo`,
    headers: jsonHeaders(`localhost:${port}`, { origin: `http://localhost:${port}` }),
    body: JSON.stringify({ recordId, reviewer: "loopback-reviewer" }),
  });
  assert.equal(undone.status, 200, undone.body);

  const afterUndo = await send(port, { path: `/api/runs/${runId}/export.csv`, headers: { host: `127.0.0.1:${port}` } });
  assert.equal(afterUndo.status, 200, afterUndo.body);
  assert.ok(!afterUndo.body.includes(recordId), afterUndo.body);

  const page = await send(port, { path: "/index.html", headers: { host: `127.0.0.1:${port}` } });
  assert.equal(page.status, 200);
});

test("a rebinding Host is rejected on every mutation, export, and run-creation route", async (t) => {
  const { port, artifactRoot } = await startServer(t);
  const created = await createRun(port);
  const { runId } = created;
  const recordId = created.run.recommendations[0].recordId;
  const before = await readdir(join(artifactRoot, "runs"));

  const protectedRoutes = [
    { method: "POST", path: "/api/runs", body: JSON.stringify(scenario()) },
    { method: "POST", path: `/api/runs/${runId}/decisions`, body: JSON.stringify({ recordId, decision: "approve", reviewer: "attacker" }) },
    { method: "POST", path: `/api/runs/${runId}/undo`, body: JSON.stringify({ recordId, reviewer: "attacker" }) },
    { method: "GET", path: `/api/runs/${runId}/export.csv` },
    { method: "GET", path: `/api/runs/${runId}/trajectory.jsonl` },
    { method: "GET", path: `/api/runs/${runId}` },
    { method: "GET", path: "/api/evaluation" },
    { method: "GET", path: "/api/demo" },
    { method: "GET", path: "/index.html" },
  ];

  for (const route of protectedRoutes) {
    const response = await send(port, { ...route, headers: jsonHeaders(`${REBIND_HOST}:${port}`) });
    assert.equal(response.status, 403, `${route.method} ${route.path} -> ${response.body}`);
    assert.ok(response.body.includes("FORBIDDEN_HOST"), response.body);
    assert.ok(!response.body.includes(recordId), response.body);
    assert.ok(!response.body.includes("proposedLabel"), response.body);
  }

  assert.deepEqual(await readdir(join(artifactRoot, "runs")), before);
  const ledger = await send(port, { path: `/api/runs/${runId}`, headers: { host: `127.0.0.1:${port}` } });
  assert.equal(ledger.status, 200, ledger.body);
  assert.deepEqual(JSON.parse(ledger.body).decisions, []);
});

test("Host port mismatch, absent Host, and duplicate Host are refused before routing", async (t) => {
  const { port } = await startServer(t);

  for (const hostValue of [`127.0.0.1:${port + 1}`, "127.0.0.1", `127.0.0.1.${REBIND_HOST}:${port}`, `169.254.169.254:${port}`]) {
    const response = await send(port, { headers: { host: hostValue } });
    assert.equal(response.status, 403, `${hostValue} -> ${response.body}`);
    assert.ok(response.body.includes("FORBIDDEN_HOST"), response.body);
  }

  // node:http rejects an HTTP/1.1 request line with no Host before the application sees it;
  // the guard independently refuses the same shape (covered by the unit contract below).
  const missing = await rawGet(port, []);
  assert.equal(missing.status, 400, missing.raw);

  const duplicate = await rawGet(port, [`Host: 127.0.0.1:${port}`, `Host: ${REBIND_HOST}:${port}`]);
  assert.equal(duplicate.status, 400, duplicate.raw);
  assert.ok(!duplicate.raw.includes('"status":"ok"'), duplicate.raw);

  const traversalWithBadHost = await send(port, { path: "/../package.json", headers: { host: `${REBIND_HOST}:${port}` } });
  assert.equal(traversalWithBadHost.status, 403, traversalWithBadHost.body);
});

test("a cross-site Origin cannot drive a loopback mutation even with a valid Host", async (t) => {
  const { port } = await startServer(t);
  const created = await createRun(port);
  const { runId } = created;
  const recordId = created.run.recommendations[0].recordId;

  for (const origin of [
    `http://${REBIND_HOST}:${port}`,
    "https://attacker.example",
    `http://127.0.0.1.attacker.invalid:${port}`,
    `http://127.0.0.1:${port + 1}`,
    `https://127.0.0.1:${port}`,
    "null",
  ]) {
    const response = await send(port, {
      method: "POST",
      path: `/api/runs/${runId}/decisions`,
      headers: jsonHeaders(`127.0.0.1:${port}`, { origin }),
      body: JSON.stringify({ recordId, decision: "approve", reviewer: "attacker" }),
    });
    assert.equal(response.status, 403, `${origin} -> ${response.body}`);
    assert.ok(response.body.includes("FORBIDDEN_ORIGIN"), response.body);
  }

  const exfiltration = await send(port, {
    path: `/api/runs/${runId}/export.csv`,
    headers: { host: `127.0.0.1:${port}`, origin: "https://attacker.example" },
  });
  assert.equal(exfiltration.status, 403, exfiltration.body);
  assert.ok(!exfiltration.body.includes(recordId), exfiltration.body);

  const state = await send(port, { path: `/api/runs/${runId}`, headers: { host: `127.0.0.1:${port}` } });
  assert.deepEqual(JSON.parse(state.body).decisions, []);
});

test("forwarding headers are never trusted to grant or revoke loopback access", async (t) => {
  const { port } = await startServer(t);

  const spoofedRescue = await send(port, {
    headers: {
      host: `${REBIND_HOST}:${port}`,
      "x-forwarded-host": `127.0.0.1:${port}`,
      "x-forwarded-for": "127.0.0.1",
      "x-forwarded-proto": "http",
    },
  });
  assert.equal(spoofedRescue.status, 403, spoofedRescue.body);
  assert.ok(spoofedRescue.body.includes("FORBIDDEN_HOST"), spoofedRescue.body);

  const spoofedPoison = await send(port, {
    headers: { host: `127.0.0.1:${port}`, "x-forwarded-host": REBIND_HOST, forwarded: `host=${REBIND_HOST}` },
  });
  assert.equal(spoofedPoison.status, 200, spoofedPoison.body);
});

test("authority evaluation rejects malformed, non-loopback, and mismatched values", () => {
  const boundPort = 4173;
  const allow = (headers) => evaluateRequestAuthority({ headers, rawHeaders: ["Host", headers.host], boundPort });

  assert.equal(allow({ host: `127.0.0.1:${boundPort}` }).allowed, true);
  assert.equal(allow({ host: `localhost:${boundPort}` }).allowed, true);
  assert.equal(allow({ host: `[::1]:${boundPort}` }).allowed, true);

  for (const host of [
    undefined,
    "",
    " 127.0.0.1:4173",
    "127.0.0.1:4173 ",
    "127.0.0.1:4173,localhost:4173",
    "127.0.0.1:abc",
    "user@127.0.0.1:4173",
    "::1:4173",
  ]) {
    const result = allow({ host });
    assert.equal(result.allowed, false, String(host));
    assert.equal(result.status, 400, String(host));
  }

  for (const host of [
    `${REBIND_HOST}:${boundPort}`,
    `127.0.0.1.${REBIND_HOST}:${boundPort}`,
    `127.0.0.2:${boundPort}`,
    `169.254.169.254:${boundPort}`,
    "127.0.0.1:4174",
    "127.0.0.1",
  ]) {
    const result = allow({ host });
    assert.equal(result.allowed, false, host);
    assert.equal(result.status, 403, host);
  }

  assert.equal(evaluateRequestAuthority({ headers: { host: `127.0.0.1:${boundPort}` }, rawHeaders: ["Host", "a", "host", "b"], boundPort }).status, 400);
  assert.equal(evaluateRequestAuthority({ headers: { host: `127.0.0.1:${boundPort}` }, rawHeaders: ["Host", "a"], boundPort: null }).status, 403);
  assert.equal(evaluateRequestAuthority({
    headers: { host: `127.0.0.1:${boundPort}`, origin: `http://127.0.0.1:${boundPort}` },
    rawHeaders: ["Host", "a", "Origin", "b", "origin", "c"],
    boundPort,
  }).status, 403);
});

test("authority parsers normalize loopback forms and reject smuggled origins", () => {
  assert.deepEqual(parseAuthority("127.0.0.1:4173"), { hostname: "127.0.0.1", port: 4173 });
  assert.deepEqual(parseAuthority("LocalHost:4173"), { hostname: "localhost", port: 4173 });
  assert.deepEqual(parseAuthority("[::1]:4173"), { hostname: "::1", port: 4173 });
  assert.deepEqual(parseAuthority("localhost"), { hostname: "localhost", port: 80 });
  assert.equal(parseAuthority("[::1"), null);
  assert.equal(parseAuthority("127.0.0.1:4173:4173"), null);
  assert.equal(parseAuthority(null), null);

  assert.deepEqual(parseHttpOrigin("http://127.0.0.1:4173"), { protocol: "http:", hostname: "127.0.0.1", port: 4173 });
  assert.deepEqual(parseHttpOrigin("http://localhost"), { protocol: "http:", hostname: "localhost", port: 80 });
  assert.deepEqual(parseHttpOrigin("http://[::1]:4173"), { protocol: "http:", hostname: "::1", port: 4173 });
  assert.equal(parseHttpOrigin("http://127.0.0.1:4173/"), null);
  assert.equal(parseHttpOrigin("http://127.0.0.1:4173/evil"), null);
  assert.equal(parseHttpOrigin("null"), null);
  assert.equal(parseHttpOrigin("file:///etc/passwd"), null);
  assert.equal(parseHttpOrigin(" http://127.0.0.1:4173"), null);
});
