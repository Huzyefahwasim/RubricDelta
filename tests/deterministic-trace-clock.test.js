import test from "node:test";
import assert from "node:assert/strict";
import { createAdvancedPredictions, loadBenchmark } from "../src/evaluation/index.js";

test("advanced evaluator forwards the explicit deterministic trace clock", () => {
  const timestamp = "2000-01-01T00:00:00.000Z";
  const first = createAdvancedPredictions(loadBenchmark(), { now: () => timestamp });
  const second = createAdvancedPredictions(loadBenchmark(), { now: () => timestamp });
  assert.deepEqual(first, second);
  assert.ok(first.cases.every((item) => item.trajectory.length > 0));
  assert.ok(first.cases.flatMap((item) => item.trajectory).every((event) => event.timestamp === timestamp));
});
