import test from "node:test";
import assert from "node:assert/strict";

import { createProviderRequest, hashProviderRequest } from "../src/providers/contracts.js";
import { createReplayProvider } from "../src/providers/replay.js";
import { EVALUATION_PROTOCOL } from "../src/evaluation/protocol.js";
import { getPrompt, promptRegistryBinding } from "../src/agents/prompt-registry.js";

const MODEL = "deterministic-role-capture-v1";
const SCHEMA = {
  type: "object",
  properties: { rankedRecordIds: { type: "array", items: { type: "string" } } },
  required: ["rankedRecordIds"],
  additionalProperties: false,
};

function request(role, mode, sequence) {
  return createProviderRequest({
    role,
    prompt: getPrompt(role),
    input: { records: [{ id: `record-${sequence}`, text: "public", existingLabel: "General" }] },
    schema: SCHEMA,
    model: MODEL,
    benchmarkId: "rubricdelta-frozen-v1",
    caseId: "case-1",
    mode,
    repetition: 1,
    inputRefs: ["case-1"],
    maxOutputTokens: 512,
  });
}

function fixture() {
  const requests = [
    request("direct-baseline", "baseline", 1),
    request("rule-compiler", "advanced", 2),
    request("change-analyst", "advanced", 3),
    request("impact-investigator", "advanced", 4),
    request("independent-verifier", "advanced", 5),
  ];
  return {
    schemaVersion: 1,
    artifactKind: "rubricdelta-exact-provider-replay",
    binding: {
      benchmark: {
        id: "rubricdelta-frozen-v1",
        sha256: "a".repeat(64),
        orderedCaseIds: ["case-1"],
        orderedRecordIdsByCase: { "case-1": ["record-1", "record-2", "record-3", "record-4", "record-5"] },
      },
      source: {
        kind: "deterministic-role-capture",
        sha256Canonicalization: "utf8-lf",
        sha256: "b".repeat(64),
        files: [{ path: "src/agents/policy-analyst.js", sha256: "c".repeat(64) }],
      },
      protocol: structuredClone(EVALUATION_PROTOCOL),

      prompts: promptRegistryBinding(),
      model: MODEL,
      mode: "both",
      repeats: 1,
    },
    entries: requests.map((item, index) => ({
      sequence: index + 1,
      requestHash: hashProviderRequest(item),
      request: item,
      result: {
        data: { rankedRecordIds: [`record-${index + 1}`] },
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        responseId: `deterministic-capture-${String(index + 1).padStart(4, "0")}`,
        model: MODEL,
        latencyMs: 0,
        transportAttempts: 1,
        attempts: [{ attempt: 1, outcome: "deterministic-capture" }],
        estimatedCostUsd: 0,
      },
    })),
  };
}

test("a replay fixture bound to both accepts baseline and advanced entries in exact order", async () => {
  const value = fixture();
  const replay = createReplayProvider({ fixture: value, expectedBinding: value.binding });
  assert.deepEqual((await replay.complete(value.entries[0].request)).data.rankedRecordIds, ["record-1"]);
  for (let index = 1; index < value.entries.length; index += 1) {
    assert.deepEqual((await replay.complete(value.entries[index].request)).data.rankedRecordIds, [`record-${index + 1}`]);
  }
  assert.doesNotThrow(() => replay.assertExhausted());
});

test("single-mode replay rejects entries from the other mode", () => {
  const value = fixture();
  value.binding.mode = "baseline";
  assert.throws(() => createReplayProvider({ fixture: value, expectedBinding: value.binding }), /mode.*binding|binding.*mode/i);
});

test("replay source binding rejects traversal, absolute, backslash, and duplicate paths", () => {
  for (const path of ["../outside.js", "/absolute.js", "C:/outside.js", "src\\agents\\policy-analyst.js"]) {
    const value = fixture();
    value.binding.source.files[0].path = path;
    assert.throws(() => createReplayProvider({ fixture: value, expectedBinding: value.binding }), /source.*path|path.*source/i);
  }
  const value = fixture();
  value.binding.source.files.push(structuredClone(value.binding.source.files[0]));
  assert.throws(() => createReplayProvider({ fixture: value, expectedBinding: value.binding }), /duplicate.*source|source.*duplicate/i);
});

test("replay binding requires the exact evaluation protocol and utf8-lf source canonicalization", () => {
  for (const mutate of [
    (value) => { delete value.binding.protocol; },
    (value) => { value.binding.protocol.reviewBudget.rounding = "ceil"; },
    (value) => { delete value.binding.source.sha256Canonicalization; },
    (value) => { value.binding.source.sha256Canonicalization = "raw-bytes"; },
  ]) {
    const value = fixture();
    mutate(value);
    assert.throws(
      () => createReplayProvider({ fixture: value, expectedBinding: value.binding }),
      /protocol|canonical|source|binding|field/i,
    );
  }
});
