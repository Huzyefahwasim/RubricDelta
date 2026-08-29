import assert from "node:assert/strict";
import {
  appendFileSync,
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const validator = join(root, "scripts", "validate-submission.js");
const replayRelativePath = "data/benchmark/replay/rubricdelta-deterministic-source.v1.json";
const EXACT_TASK9_DEFERRED = [
  "docs/MAIN_FAILURE_MODE.md",
  "docs/HOT_TAKE.md",
  "docs/MODEL_AND_COSTS.md",
  "artifacts/qa/README.md",
  "artifacts/submission/demo.mp4",
];
const REQUIRED_TASK8_TESTS = [
  "tests/capture-replay.test.js",
  "tests/openai-release-hardening.test.js",
  "tests/openai-telemetry-hardening.test.js",
  "tests/provider-artifact-boundary.test.js",
  "tests/provider-benchmark-prevalidation.test.js",
  "tests/provider-evaluation.test.js",
  "tests/provider-evidence-explanation.test.js",
  "tests/provider-rulings-contract.test.js",
  "tests/provider-scenario-prevalidation.test.js",
  "tests/provider-semantic-grouping.test.js",
  "tests/provider-telemetry-redaction.test.js",
  "tests/provider-workflow-hardening.test.js",
  "tests/provider-workflow-release-hardening.test.js",
  "tests/provider-workflow-semantic-hardening.test.js",
  "tests/provider-workflow-semantic-review.test.js",
  "tests/providers-hardening.test.js",
  "tests/providers-release-hardening.test.js",
  "tests/providers.test.js",
  "tests/replay-boundaries.test.js",
  "tests/replay-prevalidation-hardening.test.js",
  "tests/task8-cli.test.js",
];

function run(validationRoot, mode = "build") {
  return spawnSync(process.execPath, [
    validator,
    "--mode", mode,
    "--root", validationRoot,
  ], {
    cwd: root,
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

function output(command) {
  return `${command.stdout ?? ""}\n${command.stderr ?? ""}`;
}

function fixture(t) {
  const destination = join(mkdtempSync(join(tmpdir(), "rubricdelta-task8-validator-")), "repo");
  t.after(() => rmSync(dirname(destination), { recursive: true, force: true }));
  cpSync(root, destination, {
    recursive: true,
    filter(source) {
      const relative = source.slice(root.length).replaceAll("\\", "/");
      return !relative.startsWith("/.git")
        && !relative.startsWith("/.superpowers")
        && !relative.startsWith("/tmp")
        && !relative.startsWith("/artifacts/tmp")
        && !relative.startsWith("/artifacts/runs");
    },
  });
  return destination;
}

function readJson(validationRoot, relativePath) {
  return JSON.parse(readFileSync(join(validationRoot, ...relativePath.split("/")), "utf8"));
}

function writeJson(validationRoot, relativePath, value) {
  writeFileSync(
    join(validationRoot, ...relativePath.split("/")),
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
}

function mutateReplay(validationRoot, mutate) {
  const replay = readJson(validationRoot, replayRelativePath);
  mutate(replay);
  writeJson(validationRoot, replayRelativePath, replay);
}

function snapshotTree(paths) {
  const snapshot = {};
  function visit(path) {
    const stat = statSync(path);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(join(path, name));
      return;
    }
    snapshot[path.slice(root.length).replaceAll("\\", "/")] = {
      bytes: readFileSync(path).toString("base64"),
      mtimeMs: stat.mtimeMs,
    };
  }
  for (const path of paths) visit(path);
  return snapshot;
}

function assertRejected(command, expected) {
  const combined = output(command);
  assert.notEqual(command.status, 0, combined);
  assert.match(combined, expected);
}

test("build executes Task 8, defers exactly five Task 9 paths, and leaves canonical evidence untouched", () => {
  const protectedPaths = [
    join(root, ...replayRelativePath.split("/")),
    join(root, "artifacts", "evaluation"),
    join(root, "artifacts", "expected-replay-report"),
    join(root, "artifacts", "representative-trajectories"),
  ];
  const before = snapshotTree(protectedPaths);
  const build = run(root);
  const combined = output(build);

  assert.match(build.stdout, /^MODE: BUILD — NON-FINAL/m);
  assert.doesNotMatch(build.stdout, /DEFERRED \(Task 8\)/);
  assert.match(build.stdout, /\[PASS\].*Task 8/i);
  const task9Lines = build.stdout.split(/\r?\n/).filter((line) => line.startsWith("[DEFERRED (Task 9)] "));
  assert.equal(task9Lines.length, 1, combined);
  assert.deepEqual(task9Lines[0].slice("[DEFERRED (Task 9)] ".length).split(", "), EXACT_TASK9_DEFERRED);
  assert.deepEqual(snapshotTree(protectedPaths), before);
});

test("validator contains the complete accepted Task 8 test matrix and isolated replay semantics", () => {
  const source = readFileSync(validator, "utf8");
  for (const path of REQUIRED_TASK8_TESTS) {
    assert.match(source, new RegExp(path.replaceAll("/", "\\/")), `validator omitted ${path}`);
  }
  for (const contract of [
    /replay:check/,
    /eval:replay/,
    /rubricdelta-evaluation-v2/,
    /rubricdelta-provider-trace-v1/,
    /deterministic-role-capture-v1/,
    /prompt.*sha256|sha256.*prompt/is,
    /assertExhausted|exhaust/i,
    /substituted/,
    /actualModel/,
    /providerCalls/,
    /providerAttempts/,
    /inputTokens/,
    /latencyMs/,
    /estimatedCostUsd/,
    /rawPredictionSha256ByRepetition/,
    /(?:mkdtempSync|tmpdir|--output-dir)/,
  ]) assert.match(source, contract);
});

test("build runs an accepted hardening test that the old two-file gate omitted", (t) => {
  const validationRoot = fixture(t);
  writeFileSync(
    join(validationRoot, "tests", "provider-semantic-grouping.test.js"),
    "throw new Error('INJECTED_ACCEPTED_TASK8_FAILURE');\n",
    "utf8",
  );
  const command = run(validationRoot);
  assertRejected(command, /\[FAIL\].*(?:TASK 8|PROVIDER|WORKFLOW|HARDENING).*TEST/i);
});

test("build rejects no-op replacements for both fixed replay package scripts", (t) => {
  const validationRoot = fixture(t);
  const packageValue = readJson(validationRoot, "package.json");
  packageValue.scripts["replay:check"] = "node -e \"process.exit(0)\"";
  packageValue.scripts["eval:replay"] = "node -e \"process.exit(0)\"";
  writeJson(validationRoot, "package.json", packageValue);

  const command = run(validationRoot);
  const combined = output(command);
  assert.notEqual(command.status, 0, combined);
  assert.match(combined, /\[FAIL\].*package\.json#scripts\.replay:check.*exact|\[FAIL\].*exact.*replay:check/i);
  assert.match(combined, /\[FAIL\].*package\.json#scripts\.eval:replay.*exact|\[FAIL\].*exact.*eval:replay/i);
});

const replayMutations = [
  {
    name: "stale protocol v1",
    expected: /\[FAIL\].*REPLAY FIXTURE.*protocol.*v2/i,
    mutate(replay) {
      replay.binding.protocol.id = "rubricdelta-evaluation-v1";
      replay.binding.protocol.version = 1;
    },
  },
  {
    name: "source-closure hash drift",
    expected: /\[FAIL\].*REPLAY FIXTURE.*source/i,
    mutate(replay) {
      replay.binding.source.files[0].sha256 = "0".repeat(64);
    },
  },
  {
    name: "prompt hash drift",
    expected: /\[FAIL\].*REPLAY FIXTURE.*prompt/i,
    mutate(replay) {
      replay.binding.prompts["rule-compiler"].sha256 = "1".repeat(64);
    },
  },
  {
    name: "benchmark order drift",
    expected: /\[FAIL\].*REPLAY FIXTURE.*(?:benchmark|case).*order/i,
    mutate(replay) {
      replay.binding.benchmark.orderedCaseIds.reverse();
    },
  },
  {
    name: "request bytes without a matching hash",
    expected: /\[FAIL\].*REPLAY FIXTURE.*request.*hash/i,
    mutate(replay) {
      replay.entries[0].request.input.scenario.id = "mutated-case-id";
    },
  },
  {
    name: "captured result drift",
    expected: /\[FAIL\].*REPLAY FIXTURE.*result/i,
    mutate(replay) {
      replay.entries[0].result.data.ranking.reverse();
    },
  },
  {
    name: "entry sequence reordering",
    expected: /\[FAIL\].*REPLAY FIXTURE.*(?:sequence|entry order)/i,
    mutate(replay) {
      [replay.entries[0], replay.entries[1]] = [replay.entries[1], replay.entries[0]];
    },
  },
  {
    name: "nonzero replay resources",
    expected: /\[FAIL\].*REPLAY FIXTURE.*(?:resource|token|latency|cost|attempt)/i,
    mutate(replay) {
      replay.entries[0].result.usage.inputTokens = 1;
      replay.entries[0].result.usage.totalTokens = 1;
      replay.entries[0].result.latencyMs = 1;
      replay.entries[0].result.estimatedCostUsd = 1;
    },
  },
  {
    name: "a substituted captured result",
    expected: /\[FAIL\].*REPLAY FIXTURE.*(?:substitut|result)/i,
    mutate(replay) {
      replay.entries[0].result.data.substituted = true;
    },
  },
  {
    name: "an unconsumed 49-entry fixture",
    expected: /\[FAIL\].*REPLAY FIXTURE.*(?:50|exhaust|entry count)/i,
    mutate(replay) {
      replay.entries.pop();
    },
  },
];

for (const replayMutation of replayMutations) {
  test(`semantic replay validation independently rejects ${replayMutation.name}`, (t) => {
    const validationRoot = fixture(t);
    mutateReplay(validationRoot, replayMutation.mutate);
    assertRejected(run(validationRoot), replayMutation.expected);
  });
}

test("semantic fixture validation survives a no-op capture checker", (t) => {
  const validationRoot = fixture(t);
  writeFileSync(join(validationRoot, "scripts", "capture-replay.js"), "process.exitCode = 0;\n", "utf8");
  mutateReplay(validationRoot, (replay) => {
    replay.entries[0].requestHash = "0".repeat(64);
  });
  assertRejected(run(validationRoot), /\[FAIL\].*REPLAY FIXTURE.*request.*hash/i);
});

test("build rejects stale deterministic manifest replay and protocol disclosures", (t) => {
  const validationRoot = fixture(t);
  const manifest = readJson(validationRoot, "artifacts/evaluation/manifest.json");
  manifest.evaluationProtocol = {
    ...(manifest.evaluationProtocol ?? {}),
    id: "rubricdelta-evaluation-v1",
    version: 1,
  };
  manifest.replay = {
    status: "deferred-task-8",
    operational: false,
    substituted: false,
  };
  writeJson(validationRoot, "artifacts/evaluation/manifest.json", manifest);

  const command = run(validationRoot);
  const combined = output(command);
  assert.notEqual(command.status, 0, combined);
  assert.match(combined, /\[FAIL\].*manifest\.evaluationProtocol.*v2/i);
  assert.match(combined, /\[FAIL\].*manifest\.replay.*(?:not-selected|deferred-task-8|stale)/i);
});

test("credential scan covers prompts, provider source, capture source, and replay without echoing values", (t) => {
  const validationRoot = fixture(t);
  const promptSecret = "validator-private-bearer-123456789";
  const providerSecret = "validator-private-openai-assignment-987654321";
  const captureSecret = "github_pat_VALIDATOR_PRIVATE_CAPTURE_123456789";
  const replaySecret = "xoxb-validator-private-replay-123456789";
  appendFileSync(
    join(validationRoot, "prompts", "rule-compiler.v1.md"),
    `\nAuthorization: Bearer ${promptSecret}\n`,
    "utf8",
  );
  appendFileSync(
    join(validationRoot, "src", "providers", "openai.js"),
    `\n// OPENAI_API_KEY=${providerSecret}\n`,
    "utf8",
  );
  appendFileSync(
    join(validationRoot, "scripts", "capture-replay.js"),
    `\n// token=${captureSecret}\n`,
    "utf8",
  );
  mutateReplay(validationRoot, (replay) => {
    replay.validatorCredential = replaySecret;
  });

  const command = run(validationRoot);
  const combined = output(command);
  assert.notEqual(command.status, 0, combined);
  for (const path of [
    "prompts/rule-compiler.v1.md",
    "src/providers/openai.js",
    "scripts/capture-replay.js",
    replayRelativePath,
  ]) {
    assert.match(combined, new RegExp(`\\[FAIL\\].*SECRET.*${path.replaceAll("/", "\\/")}`, "i"));
  }
  for (const secret of [promptSecret, providerSecret, captureSecret, replaySecret]) {
    assert.doesNotMatch(combined, new RegExp(secret));
  }
  assert.doesNotMatch(buildPassLines(combined), /credential|secret/i);
});

function buildPassLines(value) {
  return value.split(/\r?\n/).filter((line) => line.startsWith("[PASS]")).join("\n");
}
