import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDecisionLedger } from "../src/domain/decisions.js";
import { exportApprovedCSV } from "../src/domain/csv.js";
import { createArtifactStore } from "../src/artifacts/store.js";

function approvedLedger(recordId = "a", proposedLabel = "Fraud") {
  const ledger = createDecisionLedger([{ recordId, proposedLabel }], { now: () => "2026-08-29T00:00:00.000Z" });
  ledger.decide({ recordId, decision: "approve", reviewer: "judge" });
  return ledger;
}

test("export accepts only a trusted ledger capability and excludes every non-approved record", () => {
  const ledger = createDecisionLedger([{ recordId: "a", proposedLabel: "Fraud" }, { recordId: "b", proposedLabel: "Billing" }, { recordId: "c", proposedLabel: "Support" }], { now: () => "now" });
  ledger.decide({ recordId: "a", decision: "approve", reviewer: "judge" });
  ledger.decide({ recordId: "b", decision: "reject", reviewer: "judge" });
  const csv = exportApprovedCSV({ runId: "run-1", ledger });
  assert.match(csv, /a,Fraud/); assert.doesNotMatch(csv, /b,Billing/); assert.doesNotMatch(csv, /c,Support/);
  assert.throws(() => exportApprovedCSV({ runId: "run-1", candidates: ledger.candidates(), decisions: ledger.events() }), /trusted ledger/i);
  assert.throws(() => exportApprovedCSV({ runId: "run-1", ledger: { candidates: ledger.candidates, events: ledger.events } }), /trusted ledger/i);
});

test("undo is an attributable append-only human decision and restores the preceding effective state", () => {
  const ledger = approvedLedger();
  ledger.decide({ recordId: "a", decision: "reject", reviewer: "judge", reason: "new evidence" });
  const undo = ledger.undo({ recordId: "a", reviewer: "senior reviewer", reason: "restore prior approval" });
  assert.deepEqual(undo, { type: "undo", sequence: 3, timestamp: "2026-08-29T00:00:00.000Z", recordId: "a", reviewer: "senior reviewer", reason: "restore prior approval", undoneSequence: 2, restoredDecision: "approve" });
  assert.equal(ledger.candidates()[0].status, "approved");
  assert.throws(() => ledger.undo({ recordId: "a", reviewer: " " }), /Invalid decision/);
  assert.throws(() => ledger.undo({ recordId: "a", reviewer: "judge", injected: true }), /Invalid decision/);
});

test("CSV derives approval from the opaque ledger and neutralizes formula cells after whitespace", () => {
  const ledger = approvedLedger(" \t=IMPORTXML(\"https://bad\")", " @Risk");
  const csv = exportApprovedCSV({ runId: " =run", ledger });
  assert.match(csv, /'=run/); assert.match(csv, /'=IMPORTXML\(""https:\/\/bad""\)/); assert.match(csv, /'@Risk/);
});

test("artifact store rejects traversal, Windows aliases, and an existing symlink or junction ancestor", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "rubricdelta-artifacts-"));
  const root = join(parent, "artifacts"); const outside = join(parent, "outside");
  await mkdir(root); await mkdir(outside); t.after(() => rm(parent, { recursive: true, force: true }));
  const store = createArtifactStore(root);
  for (const path of ["../outside.txt", "..\\outside.txt", "C:\\outside.txt", "../artifacts-sibling/escape.txt", "runs/state.csv:stream", "runs/CON.txt", "runs/state. "]) await assert.rejects(store.write(path, "bad"), /Invalid artifact path/);
  await writeFile(join(outside, "existing.txt"), "outside");
  await symlink(outside, join(root, "runs"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(store.write("runs/new.txt", "bad"), /Invalid artifact path/);
  await assert.rejects(store.read("runs/existing.txt"), /Invalid artifact path/);
});

test("a post-temporary write or rename failure preserves the old artifact and reports cleanup", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "rubricdelta-artifacts-"));
  const root = join(parent, "artifacts"); t.after(() => rm(parent, { recursive: true, force: true }));
  const stable = createArtifactStore(root); await stable.write("runs/run-1/state.txt", "known-good");
  const failWrite = createArtifactStore(root, { operations: { async writeFile(path, content, options) { await writeFile(path, content, options); throw new Error("forced write failure"); } } });
  await assert.rejects(failWrite.write("runs/run-1/state.txt", "replacement"), /forced write failure/);
  assert.equal(await stable.read("runs/run-1/state.txt"), "known-good");
  assert.equal((await readdir(join(root, "runs", "run-1"))).some((name) => name.includes(".tmp")), false);
  const failRename = createArtifactStore(root, { operations: { async rename() { throw new Error("forced rename failure"); } } });
  await assert.rejects(failRename.write("runs/run-1/state.txt", "replacement"), /forced rename failure/);
  assert.equal(await stable.read("runs/run-1/state.txt"), "known-good");
  const failCleanup = createArtifactStore(root, { operations: { async writeFile(path, content, options) { await writeFile(path, content, options); throw new Error("forced write failure"); }, async unlink() { throw new Error("forced cleanup failure"); } } });
  await assert.rejects(failCleanup.write("runs/run-1/state.txt", "replacement"), /temporary cleanup failed/);
});

test("ledger snapshots are detached and strict candidate and command validation leaves no event behind", () => {
  assert.throws(() => createDecisionLedger([{ recordId: "a", proposedLabel: "Fraud", injected: true }]), /Invalid candidate/);
  const ledger = createDecisionLedger([{ recordId: "a", proposedLabel: "Fraud" }]);
  for (const command of [{ recordId: "unknown", decision: "approve", reviewer: "judge" }, { recordId: "a", decision: "approve", reviewer: " " }, { recordId: "a", decision: "approve", reviewer: "judge", reason: "x".repeat(1001) }]) assert.throws(() => ledger.decide(command), /Invalid decision/);
  ledger.decide({ recordId: "a", decision: "approve", reviewer: "judge" });
  const event = ledger.events()[0]; event.decision = "escalate"; const candidate = ledger.candidates()[0]; candidate.status = "escalated";
  assert.equal(ledger.events()[0].decision, "approve"); assert.equal(ledger.candidates()[0].status, "approved");
});

test("artifact store never returns a path through a symlink or junction and rejects superscript device aliases", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "rubricdelta-artifacts-"));
  const root = join(parent, "artifacts"); const outside = join(parent, "outside");
  await mkdir(root); await mkdir(outside); t.after(() => rm(parent, { recursive: true, force: true }));
  const store = createArtifactStore(root);
  for (const path of ["runs/COM¹.txt", "runs/com².log", "runs/LPT³.csv"]) await assert.rejects(store.write(path, "bad"), /Invalid artifact path/);
  await symlink(outside, join(root, "runs"), process.platform === "win32" ? "junction" : "dir");
  assert.equal("pathFor" in store, false);
});
