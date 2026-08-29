import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { createRubricDeltaServer } from "../src/server/index.js";
import { requestPathIsSafe } from "../src/server/router.js";

function rawRequest(url, { method = "POST", headers = {}, chunks = [] } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = httpRequest({
      host: target.hostname,
      port: target.port,
      path: url.slice(target.origin.length),
      method,
      headers,
    }, (response) => {
      const body = [];
      response.on("data", (chunk) => body.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(body).toString("utf8") }));
    });
    request.on("error", reject);
    for (const chunk of chunks) request.write(chunk);
    request.end();
  });
}

function rawSocketRequest(address, payload) {
  return new Promise((resolve, reject) => {
    const target = new URL(address);
    let response = "";
    const socket = connect({ host: target.hostname, port: Number(target.port) }, () => socket.end(payload));
    socket.setEncoding("utf8");
    socket.setTimeout(2_000, () => socket.destroy(new Error("raw socket response timed out")));
    socket.on("data", (chunk) => { response += chunk; });
    socket.on("error", reject);
    socket.on("close", () => resolve(response));
  });
}

async function startServer(t, options = {}) {
  const artifactRoot = await mkdtemp(join(tmpdir(), "rubricdelta-server-"));
  const server = createRubricDeltaServer({ port: 0, artifactRoot, ...options });
  await server.start();
  t.after(async () => {
    await server.stop();
    await rm(artifactRoot, { recursive: true, force: true });
  });
  return { server, artifactRoot };
}

test("server exposes health and a gold-free demo payload", async (t) => {
  const { server } = await startServer(t);
  assert.match(server.address(), /^http:\/\/127\.0\.0\.1:/);
  const health = await fetch(`${server.address()}/api/health`);
  assert.equal(health.status, 200);
  assert.equal(health.headers.get("x-content-type-options"), "nosniff");
  assert.equal(health.headers.get("content-security-policy"), "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");

  const demo = await fetch(`${server.address()}/api/demo`);
  const demoText = await demo.text();
  assert.equal(demo.status, 200);
  assert.doesNotMatch(demoText, /groundTruth|affectedRecordIds|expectedLabels|rationales/);
  assert.equal(JSON.parse(demoText).scenario.records.length, 10);
});

test("a public scenario creates a server-owned review run and complete artifacts", async (t) => {
  const { server, artifactRoot } = await startServer(t);
  const demo = await (await fetch(`${server.address()}/api/demo`)).json();
  const created = await fetch(`${server.address()}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenario: demo.scenario }),
  });
  assert.equal(created.status, 201);
  const payload = await created.json();
  assert.match(payload.runId, /^run-[a-f0-9-]+$/);
  assert.equal(payload.run.runId, payload.runId);
  assert.equal(payload.run.scenario.id, demo.scenario.id);
  assert.equal(payload.run.recommendations.length, demo.scenario.records.length);
  assert.ok(payload.run.recommendations.every((item) => item.status === "pending"));

  const fetched = await fetch(`${server.address()}/api/runs/${payload.runId}`);
  assert.equal(fetched.status, 200);
  assert.deepEqual(await fetched.json(), payload.run);
  assert.deepEqual((await readdir(join(artifactRoot, "runs", payload.runId))).sort(), [
    "decisions.json",
    "export.csv",
    "input.json",
    "manifest.json",
    "recommendations.json",
    "state.json",
    "trajectory.jsonl",
  ]);
});
test("only active human approvals enter export and undo is an append-only checkpoint", async (t) => {
  const { server } = await startServer(t);
  const demo = await (await fetch(`${server.address()}/api/demo`)).json();
  const created = await (await fetch(`${server.address()}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenario: demo.scenario }),
  })).json();
  const [approvedCandidate, escalatedCandidate] = created.run.recommendations;

  const beforeResponse = await fetch(`${server.address()}/api/runs/${created.runId}/export.csv`);
  assert.equal(beforeResponse.status, 200);
  const before = await beforeResponse.text();
  assert.equal(before.trim().split("\n").length, 1);

  const approved = await fetch(`${server.address()}/api/runs/${created.runId}/decisions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ recordId: approvedCandidate.recordId, decision: "approve", reviewer: "judge", reason: "evidence verified" }),
  });
  assert.equal(approved.status, 200);
  assert.equal((await approved.json()).run.recommendations[0].status, "approved");

  const escalated = await fetch(`${server.address()}/api/runs/${created.runId}/decisions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ recordId: escalatedCandidate.recordId, decision: "escalate", reviewer: "judge" }),
  });
  assert.equal(escalated.status, 200);
  assert.equal((await escalated.json()).run.recommendations[1].status, "escalated");

  const approvedCsv = await (await fetch(`${server.address()}/api/runs/${created.runId}/export.csv`)).text();
  assert.match(approvedCsv, new RegExp(`,${approvedCandidate.recordId},`));
  assert.doesNotMatch(approvedCsv, new RegExp(`,${escalatedCandidate.recordId},`));
  assert.equal(approvedCsv.trim().split("\n").length, 2);

  const undone = await fetch(`${server.address()}/api/runs/${created.runId}/undo`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ recordId: approvedCandidate.recordId, reviewer: "judge", reason: "needs policy owner" }),
  });
  assert.equal(undone.status, 200);
  assert.equal((await undone.json()).run.recommendations[0].status, "pending");
  const afterUndo = await (await fetch(`${server.address()}/api/runs/${created.runId}/export.csv`)).text();
  assert.equal(afterUndo.trim().split("\n").length, 1);

  const trajectory = await (await fetch(`${server.address()}/api/runs/${created.runId}/trajectory.jsonl`)).text();
  const checkpoints = trajectory.trim().split("\n").map((line) => JSON.parse(line)).filter((event) => event.agent === "human-reviewer");
  assert.deepEqual(checkpoints.map((event) => event.type), ["human-decision", "human-decision", "human-undo"]);
  assert.deepEqual(checkpoints.map((event) => event.sequence), checkpoints.map((_event, index) => checkpoints[0].sequence + index));
});
test("evaluation publishes the frozen paired result and fair-comparison manifest", async (t) => {
  const { server } = await startServer(t);
  const response = await fetch(`${server.address()}/api/evaluation`);
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.doesNotMatch(text, /groundTruth|affectedRecordIds|expectedLabels|rationales/);
  const result = JSON.parse(text);
  assert.equal(result.manifest.provider, "deterministic");
  assert.equal(result.manifest.seed, 0);
  assert.equal(result.manifest.reviewBudgetFraction, 0.2);
  assert.equal(result.manifest.caseIds.length, 10);
  assert.equal(result.baseline.primaryMetric.value, 0.8);
  assert.equal(result.advanced.primaryMetric.value, 0.9);
  assert.equal(result.baseline.perCase.length, 10);
  assert.equal(result.advanced.perCase.length, 10);
});
test("invalid JSON requests return bounded field errors without internal disclosure", async (t) => {
  const { server } = await startServer(t);
  const demo = await (await fetch(`${server.address()}/api/demo`)).json();
  const duplicate = structuredClone(demo.scenario);
  duplicate.records[1].id = duplicate.records[0].id;
  const cases = [
    {
      name: "wrong content type",
      init: { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ scenario: demo.scenario }) },
      status: 415,
      field: "content-type",
    },
    {
      name: "malformed JSON",
      init: { method: "POST", headers: { "content-type": "application/json" }, body: "{\"scenario\":" },
      status: 400,
      field: "$",
    },
    {
      name: "unknown field",
      init: { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scenario: demo.scenario, status: "approved" }) },
      status: 400,
      field: "status",
    },
    {
      name: "duplicate record ID",
      init: { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scenario: duplicate }) },
      status: 400,
      field: "scenario.records[1].id",
    },
  ];

  for (const item of cases) {
    const response = await fetch(`${server.address()}/api/runs`, item.init);
    assert.equal(response.status, item.status, item.name);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff", item.name);
    const text = await response.text();
    const payload = JSON.parse(text);
    assert.equal(payload.error.fields[0].field, item.field, item.name);
    assert.ok(text.length < 1024, item.name);
    assert.doesNotMatch(text, /D:\\|node:internal|stack|OPENAI_API_KEY|sk-[A-Za-z0-9]/, item.name);
  }
});
test("content-length and chunked bodies are rejected at the one MiB boundary", async (t) => {
  const { server } = await startServer(t);
  const oversized = Buffer.alloc((1024 * 1024) + 1, 0x20);
  const fixed = await rawRequest(`${server.address()}/api/runs`, {
    headers: { "content-type": "application/json", "content-length": oversized.length },
    chunks: [oversized],
  });
  assert.equal(fixed.status, 413);
  assert.equal(JSON.parse(fixed.body).error.code, "PAYLOAD_TOO_LARGE");
  assert.equal(fixed.headers["x-content-type-options"], "nosniff");
  assert.equal(fixed.headers.connection, "close");

  const chunked = await rawRequest(`${server.address()}/api/runs`, {
    headers: { "content-type": "application/json", "transfer-encoding": "chunked" },
    chunks: [Buffer.alloc(700_000, 0x20), Buffer.alloc(400_000, 0x20)],
  });
  assert.equal(chunked.status, 413);
  assert.equal(JSON.parse(chunked.body).error.code, "PAYLOAD_TOO_LARGE");
  assert.equal(chunked.headers["x-content-type-options"], "nosniff");
  assert.equal(chunked.headers.connection, "close");
});
test("known resources reject unsupported methods with an exact Allow header", async (t) => {
  const { server } = await startServer(t);
  for (const item of [
    { path: "/api/health", method: "POST", allow: "GET" },
    { path: "/api/demo", method: "POST", allow: "GET" },
    { path: "/api/evaluation", method: "DELETE", allow: "GET" },
    { path: "/api/runs", method: "GET", allow: "POST" },
  ]) {
    const response = await fetch(`${server.address()}${item.path}`, { method: item.method });
    assert.equal(response.status, 405, `${item.method} ${item.path}`);
    assert.equal(response.headers.get("allow"), item.allow, item.path);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff", item.path);
  }
  const demo = await (await fetch(`${server.address()}/api/demo`)).json();
  const created = await (await fetch(`${server.address()}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenario: demo.scenario }),
  })).json();
  for (const item of [
    { path: `/api/runs/${created.runId}`, method: "POST", allow: "GET" },
    { path: `/api/runs/${created.runId}/decisions`, method: "GET", allow: "POST" },
    { path: `/api/runs/${created.runId}/undo`, method: "GET", allow: "POST" },
    { path: `/api/runs/${created.runId}/export.csv`, method: "POST", allow: "GET" },
    { path: `/api/runs/${created.runId}/trajectory.jsonl`, method: "POST", allow: "GET" },
  ]) {
    const response = await fetch(`${server.address()}${item.path}`, { method: item.method });
    assert.equal(response.status, 405, `${item.method} ${item.path}`);
    assert.equal(response.headers.get("allow"), item.allow, item.path);
  }
  const unknown = await fetch(`${server.address()}/api/runs/run-00000000-0000-4000-8000-000000000000`);
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error.code, "NOT_FOUND");
  const traversedApi = await rawRequest(`${server.address()}/api/%2e%2e/api/health`, { method: "GET" });
  assert.equal(traversedApi.status, 404);
});
test("decision commands reject browser authority and unknown IDs without mutating the ledger", async (t) => {
  const { server } = await startServer(t);
  const demo = await (await fetch(`${server.address()}/api/demo`)).json();
  const created = await (await fetch(`${server.address()}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenario: demo.scenario }),
  })).json();
  const recordId = created.run.recommendations[0].recordId;
  for (const item of [
    { body: { recordId, decision: "approve", reviewer: "judge", status: "approved" }, field: "status" },
    { body: { recordId: "unknown-record", decision: "approve", reviewer: "judge" }, field: "recordId" },
    { body: { recordId, decision: "approved", reviewer: "judge" }, field: "decision" },
    { body: { recordId, decision: "approve", reviewer: " " }, field: "reviewer" },
  ]) {
    const response = await fetch(`${server.address()}/api/runs/${created.runId}/decisions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(item.body),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.fields[0].field, item.field);
  }
  const invalidUndo = await fetch(`${server.address()}/api/runs/${created.runId}/undo`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ recordId, reviewer: "judge" }),
  });
  assert.equal(invalidUndo.status, 400);
  assert.equal((await invalidUndo.json()).error.fields[0].field, "recordId");
  const run = await (await fetch(`${server.address()}/api/runs/${created.runId}`)).json();
  assert.deepEqual(run.decisions, []);
  assert.ok(run.recommendations.every((item) => item.status === "pending"));
});
test("per-run mutations serialize ledger events and persisted artifacts", async (t) => {
  const { server, artifactRoot } = await startServer(t);
  const demo = await (await fetch(`${server.address()}/api/demo`)).json();
  const created = await (await fetch(`${server.address()}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenario: demo.scenario }),
  })).json();
  const [first, second] = created.run.recommendations;
  const decide = (recordId) => fetch(`${server.address()}/api/runs/${created.runId}/decisions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ recordId, decision: "approve", reviewer: "judge" }),
  });
  const responses = await Promise.all([decide(first.recordId), decide(second.recordId)]);
  assert.deepEqual(responses.map((response) => response.status), [200, 200]);

  const run = await (await fetch(`${server.address()}/api/runs/${created.runId}`)).json();
  assert.deepEqual(run.decisions.map((event) => event.sequence), [1, 2]);
  assert.equal(run.recommendations.filter((item) => item.status === "approved").length, 2);
  const persisted = JSON.parse(await readFile(join(artifactRoot, "runs", created.runId, "decisions.json"), "utf8"));
  assert.deepEqual(persisted, run.decisions);
});
test("static serving allows normal public files and denies every traversal form", async (t) => {
  const publicRoot = await mkdtemp(join(tmpdir(), "rubricdelta-public-"));
  await writeFile(join(publicRoot, "index.html"), "<!doctype html><title>RubricDelta</title>");
  await writeFile(join(publicRoot, "app.js"), "globalThis.RubricDelta = true;\n");
  await writeFile(join(publicRoot, ".hidden"), "secret");
  await mkdir(join(publicRoot, "assets"));
  t.after(() => rm(publicRoot, { recursive: true, force: true }));
  const { server } = await startServer(t, { publicRoot });

  const index = await fetch(`${server.address()}/`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get("content-type"), /^text\/html/);
  assert.equal(index.headers.get("x-frame-options"), "DENY");
  assert.match(await index.text(), /RubricDelta/);
  const script = await fetch(`${server.address()}/app.js`);
  assert.equal(script.status, 200);
  assert.match(script.headers.get("content-type"), /javascript/);

  for (const path of ["/%2e%2e/package.json", "/..%5cpackage.json", "/%2e%2e%2fpackage.json", "/%00", "/.hidden", "/assets/", "/app.js%3A%24DATA", "/CON", "/app.js."]) {
    const response = await rawRequest(`${server.address()}${path}`, { method: "GET" });
    assert.equal(response.status, 404, path);
    assert.equal(response.headers["x-content-type-options"], "nosniff", path);
    assert.doesNotMatch(response.body, /D:\\|Micro1 hackathon|public/i, path);
  }
});
test("ambiguous transfer framing is rejected with secured connection-close errors", async (t) => {
  const { server } = await startServer(t);
  const target = new URL(server.address());
  const response = await rawSocketRequest(server.address(), [
    "POST /api/runs HTTP/1.1",
    `Host: ${target.host}`,
    "Content-Type: application/json",
    "Content-Length: 4",
    "Transfer-Encoding: chunked",
    "Connection: keep-alive",
    "",
    "0",
    "",
    "",
  ].join("\r\n"));
  assert.match(response, /^HTTP\/1\.1 400 /);
  assert.match(response, /X-Content-Type-Options: nosniff/i);
  assert.match(response, /Content-Security-Policy:/i);
  assert.match(response, /Connection: close/i);
  assert.doesNotMatch(response, /node:internal|stack|D:\\/i);
});
test("browser-supplied secrets are redacted from responses and persisted run artifacts", async (t) => {
  const secret = "sk-serversecret123456789";
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = secret;
  t.after(() => {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  });
  const { server, artifactRoot } = await startServer(t);
  const demo = await (await fetch(`${server.address()}/api/demo`)).json();
  demo.scenario.records[0].text += ` supplied ${secret}`;
  const createdResponse = await fetch(`${server.address()}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenario: demo.scenario }),
  });
  assert.equal(createdResponse.status, 201);
  const createdText = await createdResponse.text();
  assert.doesNotMatch(createdText, new RegExp(secret));
  const created = JSON.parse(createdText);
  const recordId = created.run.recommendations[0].recordId;
  const decisionResponse = await fetch(`${server.address()}/api/runs/${created.runId}/decisions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ recordId, decision: "approve", reviewer: "judge", reason: `contains ${secret} and sk-othersecret987654` }),
  });
  const decisionText = await decisionResponse.text();
  assert.equal(decisionResponse.status, 200);
  assert.doesNotMatch(decisionText, /sk-(?:serversecret|othersecret)/);
  for (const name of ["input.json", "state.json", "decisions.json", "trajectory.jsonl", "export.csv"]) {
    const content = await readFile(join(artifactRoot, "runs", created.runId, name), "utf8");
    assert.doesNotMatch(content, /sk-(?:serversecret|othersecret)/, name);
  }
});
test("request path validation rejects Windows filesystem aliases before lookup", () => {
  for (const path of ["/app.js%3A%24DATA", "/CON", "/con.txt", "/LPT1.css", "/app.js.", "/asset%20"]) {
    assert.equal(requestPathIsSafe(path), false, path);
  }
  assert.equal(requestPathIsSafe("/assets/app.js"), true);
});
test("an artifact write failure preserves authoritative decisions and does not poison the run queue", async (t) => {
  const { server, artifactRoot } = await startServer(t);
  const demo = await (await fetch(`${server.address()}/api/demo`)).json();
  const created = await (await fetch(`${server.address()}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenario: demo.scenario }),
  })).json();
  const [first, second] = created.run.recommendations;
  const statePath = join(artifactRoot, "runs", created.runId, "state.json");
  await rm(statePath);
  await mkdir(statePath);
  const failed = await fetch(`${server.address()}/api/runs/${created.runId}/decisions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ recordId: first.recordId, decision: "approve", reviewer: "judge" }),
  });
  assert.equal(failed.status, 500);
  const failedText = await failed.text();
  assert.doesNotMatch(failedText, /D:\\|Micro1 hackathon|state\.json/i);
  const authoritative = await (await fetch(`${server.address()}/api/runs/${created.runId}`)).json();
  assert.equal(authoritative.recommendations[0].status, "approved");
  assert.equal(authoritative.decisions.length, 1);

  await rm(statePath, { recursive: true });
  const recovered = await fetch(`${server.address()}/api/runs/${created.runId}/decisions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ recordId: second.recordId, decision: "approve", reviewer: "judge" }),
  });
  assert.equal(recovered.status, 200);
  const persisted = JSON.parse(await readFile(join(artifactRoot, "runs", created.runId, "decisions.json"), "utf8"));
  assert.deepEqual(persisted.map((event) => event.sequence), [1, 2]);
});