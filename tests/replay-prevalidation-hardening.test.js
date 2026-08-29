import assert from "node:assert/strict";
import test from "node:test";

import { ProviderError } from "../src/providers/contracts.js";
import { createReplayProvider } from "../src/providers/replay.js";

const MARKER = "opaque-replay-secret-marker-2026";

function deeplyNestedValue() {
  let value = "leaf";
  for (let depth = 0; depth < 70; depth += 1) {
    value = { nested: value };
  }
  return value;
}

function assertSafePrevalidationFailure(options) {
  let error;
  try {
    createReplayProvider(options);
  } catch (caught) {
    error = caught;
  }

  assert.ok(error instanceof ProviderError);
  assert.equal(error.code, "REPLAY_INVALID_FIXTURE");
  assert.equal(error.message, "Replay fixture failed bounded structural complexity validation");
  assert.equal(error.cause, undefined);
  const exposed = [
    error.message,
    error.stack,
    JSON.stringify(error),
  ].join("\n");
  assert.doesNotMatch(exposed, new RegExp(MARKER, "i"));
}

test("replay fixture prevalidation hides attacker-controlled paths and causes", () => {
  assertSafePrevalidationFailure({
    fixture: { [MARKER]: deeplyNestedValue() },
    expectedBinding: null,
  });
});

test("replay expected-binding prevalidation hides attacker-controlled paths and causes", () => {
  assertSafePrevalidationFailure({
    fixture: null,
    expectedBinding: { [MARKER]: deeplyNestedValue() },
  });
});
