import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDecisionLedger } from "../src/domain/decisions.js";
import { exportApprovedCSV } from "../src/domain/csv.js";
import { createArtifactStore } from "../src/artifacts/store.js";

test("export contains approved corrections and excludes pending, rejected, and escalated records", () => {
  const ledger = createDecisionLedger([
    { recordId: "a", proposedLabel: "Fraud" },
    { recordId: "b", proposedLabel: "Billing" },
    { recordId: "c", proposedLabel: "Support" },
    { recordId: "d", proposedLabel: "Risk" },
  ], { now: () => "2026-08-29T00:00:00.000Z" });
  ledger.decide({ recordId: "a", decision: "approve", reviewer: "judge" });
  ledger.decide({ recordId: "b", decision: "reject", reviewer: "judge" });
  ledger.decide({ recordId: "c", decision: "escalate", reviewer: "judge" });
  const csv = exportApprovedCSV({ runId: "run-1", candidates: ledger.candidates(), decisions: ledger.events() });
  assert.match(csv, /a,Fraud/);
  assert.doesNotMatch(csv, /b,Billing/);
  assert.doesNotMatch(csv, /c,Support/);
  assert.doesNotMatch(csv, /d,Risk/);
});

test("decision history is append-only, detached, and undo restores the previous effective decision", () => {
  const ledger = createDecisionLedger([{ recordId: "a", proposedLabel: "Fraud" }], { now: () => "now" });
  ledger.decide({ recordId: "a", decision: "approve", reviewer: "judge" });
  ledger.decide({ recordId: "a", decision: "reject", reviewer: "judge", reason: "new evidence" });
  const undo = ledger.undo("a");
  assert.equal(undo.type, "undo");
  assert.equal(ledger.candidates()[0].status, "approved");
  const events = ledger.events(); events[0].decision = "escalate";
  const candidates = ledger.candidates(); candidates[0].status = "escalated";
  assert.equal(ledger.events()[0].decision, "approve");
  assert.equal(ledger.candidates()[0].status, "approved");
  ledger.undo("a");
  assert.equal(ledger.candidates()[0].status, "pending");
});

test("decision gate rejects unknown candidate and command shapes before recording an event", () => {
  assert.throws(() => createDecisionLedger([{ recordId: "a", proposedLabel: "Fraud", injected: true }]), /Invalid candidate/);
  assert.throws(() => createDecisionLedger([Object.create(null, { recordId: { value: "a", enumerable: true }, proposedLabel: { value: "Fraud", enumerable: true } })]), /Invalid candidate/);
  const ledger = createDecisionLedger([{ recordId: "a", proposedLabel: "Fraud" }]);
  for (const command of [
    { recordId: "unknown", decision: "approve", reviewer: "judge" }, { recordId: "a", decision: "approve", reviewer: " " },
    { recordId: "a", decision: "invent", reviewer: "judge" }, { recordId: "a", decision: "approve", reviewer: "judge", injected: true },
    { recordId: "a", decision: "approve", reviewer: "judge", reason: "x".repeat(1001) },
  ]) assert.throws(() => ledger.decide(command), /Invalid decision/);
  assert.equal(ledger.events().length, 0);
});

test("CSV uses effective server decision events instead of candidate status and neutralizes formula cells", () => {
  const noDecision = exportApprovedCSV({ runId: "run-1", candidates: [{ recordId: "a", proposedLabel: "Fraud", status: "approved" }], decisions: [] });
  assert.doesNotMatch(noDecision, /a,Fraud/);
  const ledger = createDecisionLedger([{ recordId: " \t=IMPORTXML(\"https://bad\")", proposedLabel: " @Risk" }], { now: () => "now" });
  ledger.decide({ recordId: " \t=IMPORTXML(\"https://bad\")", decision: "approve", reviewer: " +judge", reason: " -unsafe" });
  const csv = exportApprovedCSV({ runId: " =run", candidates: ledger.candidates(), decisions: ledger.events() });
  assert.match(csv, /'=run/); assert.match(csv, /'=IMPORTXML\(""https:\/\/bad""\)/); assert.match(csv, /'@Risk/);
  assert.match(csv, /'\+judge/); assert.match(csv, /'-unsafe/);
});

test("artifact store confines paths and preserves an existing artifact when a replacement write fails", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "rubricdelta-artifacts-"));
  const root = join(parent, "artifacts");
  t.after(() => rm(parent, { recursive: true, force: true }));
  const store = createArtifactStore(root);
  await assert.rejects(store.write("../outside.txt", "bad"), /Invalid artifact path/);
  await assert.rejects(store.write("..\\outside.txt", "bad"), /Invalid artifact path/);
  await assert.rejects(store.write("C:\\outside.txt", "bad"), /Invalid artifact path/);
  await assert.rejects(store.write("../artifacts-sibling/escape.txt", "bad"), /Invalid artifact path/);
  await store.write("runs/run-1/state.txt", "known-good");
  await assert.rejects(store.write("runs/run-1/state.txt", undefined), /Artifact content/);
  assert.equal(await store.read("runs/run-1/state.txt"), "known-good");
});
