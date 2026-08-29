import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  classifyTraceEvent,
  createDecisionRequest,
  createUndoRequest,
  evaluationSummary,
  keyboardCommand,
  relativeConfidence,
  reviewProgress,
  reviewStateAfterMutationFailure,
  safeDownloadHref,
  selectCandidateIndex,
  synchronizeReview,
} from "../public/ui-model.js";

test("workbench exposes one h1, skip navigation, live status, and labeled decision controls", () => {
  const html = readFileSync(resolve("public/index.html"), "utf8");
  assert.equal((html.match(/<h1\b/g) ?? []).length, 1);
  assert.match(html, /href="#main"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, />Approve</);
  assert.match(html, />Reject</);
  assert.match(html, />Escalate</);
});

test("workbench shell keeps CSP-compatible assets and five keyboard-accessible views", () => {
  const html = readFileSync(resolve("public/index.html"), "utf8");
  for (const label of ["Intake", "Rule Deltas", "Impact Queue", "Evaluation", "Trajectory Inspector"]) {
    assert.match(html, new RegExp(`>${label}<`));
  }
  assert.match(html, /role="tablist"/);
  assert.equal((html.match(/role="tab"/g) ?? []).length, 5);
  assert.match(html, /src="\/app\.js"/);
  assert.match(html, /href="\/styles\.css"/);
  assert.doesNotMatch(html, /\son(?:click|keydown|submit)=/i);
  assert.doesNotMatch(html, /<style\b|style="/i);
});

test("browser renderer has no HTML parsing sink, inline style sink, or local decision authority", () => {
  const source = readFileSync(resolve("public/app.js"), "utf8");
  assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/i);
  assert.doesNotMatch(source, /\.style\s*\./i);
  assert.doesNotMatch(source, /candidate\.status\s*=/i);
  assert.match(source, /refreshAuthoritativeRun/);
});

test("J and K wrap through the complete queue while an empty queue remains unselected", () => {
  assert.equal(selectCandidateIndex(0, 1, 3), 1);
  assert.equal(selectCandidateIndex(2, 1, 3), 0);
  assert.equal(selectCandidateIndex(0, -1, 3), 2);
  assert.equal(selectCandidateIndex(4, 1, 0), -1);
});

test("review shortcuts ignore form focus, modifiers, and repeated keys", () => {
  assert.deepEqual(keyboardCommand({ key: "A", target: { tagName: "DIV" } }), { type: "decision", decision: "approve" });
  assert.deepEqual(keyboardCommand({ key: "j", target: { tagName: "DIV" } }), { type: "navigate", offset: 1 });
  assert.deepEqual(keyboardCommand({ key: "K", target: { tagName: "DIV" } }), { type: "navigate", offset: -1 });
  for (const event of [
    { key: "a", target: { tagName: "INPUT" } },
    { key: "r", target: { tagName: "DIV", isContentEditable: true } },
    { key: "e", target: { tagName: "BUTTON" } },
    { key: "a", target: { tagName: "DIV" }, ctrlKey: true },
    { key: "a", target: { tagName: "DIV" }, repeat: true },
  ]) assert.equal(keyboardCommand(event), null);
});

test("decision and undo requests send commands without browser-owned status", () => {
  assert.deepEqual(createDecisionRequest({ runId: "run-acde-1234", recordId: "fraud-08", decision: "approve", reviewer: "Judge" }), {
    url: "/api/runs/run-acde-1234/decisions",
    body: { recordId: "fraud-08", decision: "approve", reviewer: "Judge" },
  });
  assert.deepEqual(createUndoRequest({ runId: "run-acde-1234", recordId: "fraud-08", reviewer: "Judge", reason: "Recheck" }), {
    url: "/api/runs/run-acde-1234/undo",
    body: { recordId: "fraud-08", reviewer: "Judge", reason: "Recheck" },
  });
  assert.throws(() => createDecisionRequest({ runId: "../escape", recordId: "fraud-08", decision: "approve", reviewer: "Judge" }), /run ID/i);
});

test("server refresh replaces stale local status and preserves selection by record ID", () => {
  const previous = {
    run: { recommendations: [{ recordId: "a", status: "approved" }, { recordId: "b", status: "rejected" }] },
    selectedIndex: 1,
  };
  const authoritative = { recommendations: [{ recordId: "b", status: "pending" }, { recordId: "a", status: "pending" }] };
  const next = synchronizeReview(previous, authoritative);
  assert.equal(next.run, authoritative);
  assert.equal(next.selectedIndex, 0);
  assert.equal(next.run.recommendations[0].status, "pending");
});

test("an accepted mutation with a failed refresh clears stale browser state", () => {
  const previous = { run: { recommendations: [{ recordId: "a", status: "pending" }] }, selectedIndex: 0 };
  assert.equal(reviewStateAfterMutationFailure(previous, false), previous);
  assert.deepEqual(reviewStateAfterMutationFailure(previous, true), { run: null, selectedIndex: -1 });
});

test("review counter derives the fixed 20 percent slot budget from server candidates", () => {
  assert.deepEqual(reviewProgress(10, [
    { status: "approved" }, { status: "rejected" }, { status: "escalated" }, { status: "pending" },
  ]), { slots: 2, decided: 3, used: 2, remaining: 0, overBudget: 1 });
  assert.deepEqual(reviewProgress(0, []), { slots: 0, decided: 0, used: 0, remaining: 0, overBudget: 0 });
});

test("download links accept only server-shaped run IDs and known artifacts", () => {
  assert.equal(safeDownloadHref("run-acde-1234", "export"), "/api/runs/run-acde-1234/export.csv");
  assert.equal(safeDownloadHref("run-acde-1234", "trajectory"), "/api/runs/run-acde-1234/trajectory.jsonl");
  assert.throws(() => safeDownloadHref("run-acde/../../secret", "export"), /run ID/i);
  assert.throws(() => safeDownloadHref("run-acde-1234", "manifest"), /download kind/i);
});

test("relative confidence keeps numeric rank evidence bounded without changing source labels", () => {
  assert.deepEqual(relativeConfidence({ score: 8 }, 8), { value: 100, label: "high" });
  assert.deepEqual(relativeConfidence({ score: 4 }, 8), { value: 50, label: "medium" });
  assert.deepEqual(relativeConfidence({ score: -3 }, 8), { value: 0, label: "low" });
});

test("evaluation projection leads with 0.80 to 0.90 and exposes failures and fairness", () => {
  const result = evaluationSummary({
    manifest: { benchmarkId: "bench-v1", caseIds: ["hard", "easy"], reviewBudgetFraction: 0.2, provider: "deterministic", seed: 0 },
    baseline: {
      benchmarkId: "bench-v1", reviewBudgetFraction: 0.2, caseCount: 2,
      primaryMetric: { value: 0.8 }, resourceUse: { runtimeMs: null },
      perCase: [
        { caseId: "hard", title: "Hard case", difficulty: "hard", reviewBudget: 2, counts: { falsePositives: 1, falseNegatives: 1 }, metrics: { affectedRecallAtBudget: 0.5 } },
        { caseId: "easy", title: "Easy case", difficulty: "easy", reviewBudget: 2, counts: { falsePositives: 0, falseNegatives: 0 }, metrics: { affectedRecallAtBudget: 1 } },
      ],
    },
    advanced: {
      benchmarkId: "bench-v1", reviewBudgetFraction: 0.2, caseCount: 2,
      primaryMetric: { value: 0.9 }, resourceUse: { runtimeMs: null },
      perCase: [
        { caseId: "hard", title: "Hard case", difficulty: "hard", reviewBudget: 2, counts: { falsePositives: 0, falseNegatives: 0 }, metrics: { affectedRecallAtBudget: 1 } },
        { caseId: "easy", title: "Easy case", difficulty: "easy", reviewBudget: 2, counts: { falsePositives: 1, falseNegatives: 1 }, metrics: { affectedRecallAtBudget: 0.5 } },
      ],
    },
  });
  assert.equal(result.baselineMetric, "0.80");
  assert.equal(result.advancedMetric, "0.90");
  assert.equal(result.budgetPercent, 20);
  assert.deepEqual(result.falsePositives, { baseline: 1, advanced: 1 });
  assert.deepEqual(result.misses, { baseline: 1, advanced: 1 });
  assert.equal(result.perCase[0].hardStatus, "passed");
  assert.ok(result.fairness.every((check) => check.passed));
});

test("trajectory classifier preserves every inspectable event family", () => {
  const fixtures = [
    [{ type: "instruction", agent: "orchestrator", phase: "compile" }, "instruction"],
    [{ type: "tool_call", agent: "compiler", phase: "compile" }, "tool-call"],
    [{ type: "result", agent: "compiler", phase: "compile" }, "result"],
    [{ type: "action-result", agent: "impact-investigator", phase: "ranking" }, "action-result"],
    [{ type: "validation", agent: "orchestrator", phase: "compile" }, "validation"],
    [{ type: "retry", agent: "orchestrator", phase: "compile" }, "retry"],
    [{ type: "result", agent: "skeptical-verifier", phase: "verification" }, "verifier-challenge"],
    [{ type: "human-decision", agent: "human-reviewer", phase: "human-checkpoint" }, "human-checkpoint"],
    [{ type: "final", agent: "orchestrator", phase: "final" }, "final"],
    [{ type: "final-evidence", agent: "orchestrator", phase: "workflow" }, "final"],
  ];
  for (const [event, expected] of fixtures) assert.equal(classifyTraceEvent(event), expected);
});
