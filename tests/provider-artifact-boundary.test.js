import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createProviderEvaluationArtifacts,
  createPublicBenchmarkProjection,
} from "../scripts/evaluation-artifacts.js";
import * as providerArtifactModule from "../scripts/provider-evaluation-artifacts.js";
import {
  evaluatePredictions,
  loadBenchmark,
} from "../src/evaluation/index.js";

const MODEL = "deterministic-role-capture-v1";
const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

function temporary(t, prefix) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function provider(name = "capture") {
  return {
    name,
    model: MODEL,
    async complete() {
      throw new Error("test prediction factory owns execution");
    },
  };
}

function predictions(benchmark, {
  providerName = "capture",
  model = MODEL,
  repetition = 1,
  mutate,
} = {}) {
  const publicBenchmark = createPublicBenchmarkProjection(benchmark);
  const value = {
    metadata: {
      system: "artifact-boundary-test",
      provider: providerName,
      model,
      repetition,
      runtimeMs: null,
      estimatedCostUsd: 0,
      resourceNotes: "test",
      fairnessManifest: {
        benchmarkId: publicBenchmark.benchmarkId,
        caseIds: publicBenchmark.cases.map((item) => item.id),
        orderedRecordIdsByCase: Object.fromEntries(
          publicBenchmark.cases.map((item) => [item.id, item.records.map((record) => record.id)]),
        ),
        reviewBudgetFraction: publicBenchmark.reviewBudgetFraction,
        provider: providerName,
        model,
        repetition,
      },
      resources: {
        providerCalls: publicBenchmark.cases.length,
        providerAttempts: publicBenchmark.cases.length,
        usage: ZERO_USAGE,
        latencyMs: 0,
        estimatedCostUsd: 0,
      },
    },
    cases: publicBenchmark.cases.map((item) => ({
      caseId: item.id,
      status: "complete",
      rankedRecordIds: item.records.map((record) => record.id),
      rankingEvidence: item.records.map((record) => ({ recordId: record.id })),
      trajectory: [{
        type: "provider-result",
        retry: { transportAttempts: 1 },
        usage: ZERO_USAGE,
        latencyMs: 0,
        payload: { estimatedCostUsd: 0 },
      }],
      substituted: false,
      runtimeMs: null,
      estimatedCostUsd: 0,
    })),
  };
  mutate?.(value);
  return value;
}

async function runArtifact(t, {
  providerName = "capture",
  replay = null,
  mutate,
  outputDir = temporary(t, "rubricdelta-provider-boundary-"),
} = {}) {
  const benchmark = loadBenchmark();
  return createProviderEvaluationArtifacts({
    benchmark,
    mode: "baseline",
    outputDir,
    provider: provider(providerName),
    model: MODEL,
    repeats: 1,
    createBaseline: async () => predictions(benchmark, { providerName, mutate }),
    score: evaluatePredictions,
    replay,
  });
}

test("durable provider writes request a synchronous flush before returning", () => {
  assert.equal(typeof providerArtifactModule.writeDurableFile, "function");
  const calls = [];
  providerArtifactModule.writeDurableFile("target", "payload", (...args) => {
    calls.push(args);
  });
  assert.deepEqual(calls, [[
    "target",
    "payload",
    { encoding: "utf8", flag: "wx", flush: true },
  ]]);
  const source = readFileSync(
    new URL("../scripts/provider-evaluation-artifacts.js", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /function safeWrite\([\s\S]*?writeDurableFile\(temporary, source\);/,
    "production safeWrite must invoke the flushed writer used by raw artifacts",
  );
});

test("provider artifacts reject evaluator aliases and credentials before raw persistence", async (t) => {
  const attacks = [
    {
      name: "evaluator alias",
      marker: "private-review-outcome",
      mutate(value) {
        value.metadata.reviewOutcome = "private-review-outcome";
      },
    },
    {
      name: "credential in trace",
      marker: "sk-provider-artifact-secret-2026",
      mutate(value) {
        value.cases[0].trajectory.push({ detail: "sk-provider-artifact-secret-2026" });
      },
    },
  ];
  for (const attack of attacks) {
    await t.test(attack.name, async () => {
      const outputDir = temporary(t, "rubricdelta-provider-private-");
      await assert.rejects(
        runArtifact(t, { outputDir, mutate: attack.mutate }),
        (error) => {
          const surface = error.message + "\n" + error.stack + "\n" + JSON.stringify(error);
          assert.doesNotMatch(surface, new RegExp(attack.marker, "i"));
          assert.match(error.message, /provider prediction|artifact validation|public-only/i);
          return true;
        },
      );
      assert.equal(
        existsSync(join(outputDir, "repetitions", "1", "baseline-predictions.json")),
        false,
      );
    });
  }
});

test("provider artifacts validate the exact paired fairness manifest before persistence", async (t) => {
  const attacks = [
    ["benchmark", (value) => { value.metadata.fairnessManifest.benchmarkId = "other"; }],
    ["case order", (value) => { value.metadata.fairnessManifest.caseIds.reverse(); }],
    ["record order", (value) => {
      const [caseId] = value.metadata.fairnessManifest.caseIds;
      value.metadata.fairnessManifest.orderedRecordIdsByCase[caseId].reverse();
    }],
    ["review budget", (value) => { value.metadata.fairnessManifest.reviewBudgetFraction = 0.5; }],
    ["provider", (value) => { value.metadata.fairnessManifest.provider = "other"; }],
    ["model", (value) => { value.metadata.fairnessManifest.model = "other"; }],
    ["repetition", (value) => { value.metadata.fairnessManifest.repetition = 2; }],
  ];
  for (const [name, mutate] of attacks) {
    await t.test(name, async () => {
      const outputDir = temporary(t, "rubricdelta-provider-fairness-");
      await assert.rejects(
        runArtifact(t, { outputDir, mutate }),
        /fairness|paired|provider prediction|artifact validation/i,
      );
      assert.equal(
        existsSync(join(outputDir, "repetitions", "1", "baseline-predictions.json")),
        false,
      );
    });
  }
});

test("provider resources are recomputed from durable result traces, not mutable metadata", async (t) => {
  const result = await runArtifact(t, {
    mutate(value) {
      value.metadata.resources = {
        providerCalls: 999,
        providerAttempts: 999,
        usage: { inputTokens: 999, outputTokens: 999, totalTokens: 1998 },
        latencyMs: 999,
        estimatedCostUsd: 999,
      };
    },
  });
  assert.deepEqual(result.manifest.resources.providerCalls, {
    baseline: 10,
    advanced: 0,
    total: 10,
  });
  assert.deepEqual(result.manifest.resources.providerAttempts, {
    baseline: 10,
    advanced: 0,
    total: 10,
  });
  assert.equal(result.manifest.resources.inputTokens, 0);
  assert.equal(result.manifest.resources.outputTokens, 0);
  assert.equal(result.manifest.resources.totalTokens, 0);
  assert.equal(result.manifest.resources.latencyMs, 0);
  assert.equal(result.manifest.resources.estimatedCostUsd, 0);
});

test("caller replay metadata cannot override trusted provider provenance", async (t) => {
  const result = await runArtifact(t, {
    replay: {
      status: "forged-operational",
      operational: true,
      substituted: true,
      binding: { public: "binding" },
      source: { public: "source" },
      fixture: { sha256: "0".repeat(64) },
    },
  });
  assert.equal(result.manifest.replay.status, "not-applicable");
  assert.equal(result.manifest.replay.operational, false);
  assert.equal(result.manifest.replay.substituted, false);
  assert.equal(Object.hasOwn(result.manifest.replay, "binding"), false);
  assert.equal(Object.hasOwn(result.manifest.replay, "source"), false);
  assert.equal(Object.hasOwn(result.manifest.replay, "fixture"), false);
});

test("runtime manifest discloses network requirement truthfully by provider", async (t) => {
  const replay = await runArtifact(t, { providerName: "replay" });
  assert.equal(replay.manifest.runtimeEnvironment.networkRequired, false);
  assert.equal(replay.manifest.provider.seed, null);
  const capture = await runArtifact(t, { providerName: "capture" });
  assert.equal(capture.manifest.provider.seed, 0);
  const openai = await runArtifact(t, { providerName: "openai" });
  assert.equal(openai.manifest.runtimeEnvironment.networkRequired, true);
  assert.equal(openai.manifest.provider.seed, null);
  assert.equal(openai.comparison.fairComparison.seed, null);
});

test("provider output root rejects a pre-existing link or junction before writes", async (t) => {
  const root = temporary(t, "rubricdelta-provider-link-");
  const external = join(root, "external");
  const output = join(root, "output-link");
  writeFileSync(join(root, "sentinel.txt"), "safe", "utf8");
  const externalCreated = temporary(t, "rubricdelta-provider-external-");
  try {
    symlinkSync(externalCreated, output, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EPERM", "EACCES"].includes(error.code)) {
      t.skip("link creation is not permitted on this host");
      return;
    }
    throw error;
  }
  await assert.rejects(runArtifact(t, { outputDir: output }), /link|junction|reparse|output root/i);
  assert.equal(readFileSync(join(root, "sentinel.txt"), "utf8"), "safe");
  assert.equal(existsSync(join(externalCreated, "repetitions")), false);
  assert.equal(existsSync(external), false);
});
