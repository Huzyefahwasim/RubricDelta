import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const verifierPath = resolve(repositoryRoot, "scripts/verify-removed-experiment.js");
const artifactDir = resolve(
  repositoryRoot,
  "artifacts/experiments/exp-002-unsupported-inference",
);

function withArtifactCopy(callback) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "rubricdelta-exp002-"));
  const copy = resolve(temporaryRoot, "evidence");
  cpSync(artifactDir, copy, { recursive: true });
  try {
    callback(copy);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}


function runVerifier(extraArguments = []) {
  return spawnSync(process.execPath, [verifierPath, ...extraArguments], {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true,
  });
}

test("removed-experiment verifier re-scores the exact historical rankings", () => {
  const result = runVerifier();
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);

  assert.deepEqual(summary.scores, {
    baseline: { numerator: 16, denominator: 20, value: 0.8 },
    beforeAdvanced: { numerator: 19, denominator: 20, value: 0.95 },
    afterAdvanced: { numerator: 18, denominator: 20, value: 0.9 },
  });
  assert.deepEqual(summary.changedReviewQueues, [
    {
      caseId: "assistive-technology-blocker",
      beforeSelectedRecordIds: ["a11y-02", "a11y-04"],
      afterSelectedRecordIds: ["a11y-03", "a11y-07"],
      beforeTruePositiveIds: ["a11y-02", "a11y-04"],
      afterTruePositiveIds: [],
    },
    {
      caseId: "bank-chargeback-filed",
      beforeSelectedRecordIds: ["dispute-02", "dispute-04"],
      afterSelectedRecordIds: ["dispute-02", "dispute-07"],
      beforeTruePositiveIds: ["dispute-02"],
      afterTruePositiveIds: ["dispute-02", "dispute-07"],
    },
  ]);
  assert.deepEqual(summary.protocolEquivalence, {
    recordCountPerCase: 10,
    reviewBudgetFraction: 0.2,
    protocolV1Slots: 2,
    protocolV2Slots: 2,
  });
  assert.match(summary.git.status, /^(verified|unavailable)$/);
});


test("removed-experiment verifier rejects a changed bound file", () => {
  withArtifactCopy((copy) => {
    const readmePath = resolve(copy, "README.md");
    writeFileSync(readmePath, `${readFileSync(readmePath, "utf8")}changed\n`, "utf8");
    const result = runVerifier(["--artifact-dir", copy]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^HASH_MISMATCH:/);
  });
});

test("removed-experiment verifier rejects evaluator gold before hash validation", () => {
  withArtifactCopy((copy) => {
    const path = resolve(copy, "before-predictions.json");
    const predictions = JSON.parse(readFileSync(path, "utf8"));
    predictions.systems.advanced.metadata.ground_truth = { affected_record_ids: ["a11y-02"] };
    writeFileSync(path, `${JSON.stringify(predictions, null, 2)}\n`, "utf8");
    const result = runVerifier(["--artifact-dir", copy]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^PREDICTIONS_CONTAIN_GOLD:/);
  });
});

test("removed-experiment verifier rejects a complete ranking in the wrong case order", () => {
  withArtifactCopy((copy) => {
    const path = resolve(copy, "after-predictions.json");
    const predictions = JSON.parse(readFileSync(path, "utf8"));
    const [first] = predictions.systems.advanced.cases.splice(0, 1);
    predictions.systems.advanced.cases.splice(1, 0, first);
    writeFileSync(path, `${JSON.stringify(predictions, null, 2)}\n`, "utf8");
    const result = runVerifier(["--artifact-dir", copy]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^INVALID_PREDICTIONS:/);
  });
});

test("removed-experiment verifier rejects a changed meaningful manifest field", () => {
  withArtifactCopy((copy) => {
    const path = resolve(copy, "manifest.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    manifest.frozenEvaluation.recordCount = 99;
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const result = runVerifier(["--artifact-dir", copy]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^INVALID_MANIFEST:/);
  });
});

test("removed-experiment verifier rejects an unknown manifest key", () => {
  withArtifactCopy((copy) => {
    const path = resolve(copy, "manifest.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    manifest.unreviewedClaim = "accepted";
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const result = runVerifier(["--artifact-dir", copy]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^INVALID_MANIFEST:/);
  });
});

test("removed-experiment verifier rejects an extra file", () => {
  withArtifactCopy((copy) => {
    writeFileSync(resolve(copy, "unbound.txt"), "unbound\n", "utf8");
    const result = runVerifier(["--artifact-dir", copy]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^INVALID_DIRECTORY:/);
  });
});

test("removed-experiment verifier rejects an extra directory", () => {
  withArtifactCopy((copy) => {
    mkdirSync(resolve(copy, "unbound-directory"));
    const result = runVerifier(["--artifact-dir", copy]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^INVALID_DIRECTORY:/);
  });
});

test("removed-experiment verifier rejects an extra symlink", (t) => {
  withArtifactCopy((copy) => {
    try {
      symlinkSync("README.md", resolve(copy, "unbound-link.md"), "file");
    } catch (error) {
      if (["EACCES", "ENOSYS", "EPERM", "UNKNOWN"].includes(error.code)) {
        t.skip(`symlink creation unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    const result = runVerifier(["--artifact-dir", copy]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^INVALID_DIRECTORY:/);
  });
});

test("removed-experiment verifier rejects CRLF bytes with unchanged text", () => {
  withArtifactCopy((copy) => {
    const path = resolve(copy, "README.md");
    const source = readFileSync(path, "utf8");
    assert.match(source, /\n/);
    assert.doesNotMatch(source, /\r\n/);
    writeFileSync(path, source.replaceAll("\n", "\r\n"), "utf8");
    const result = runVerifier(["--artifact-dir", copy]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^HASH_MISMATCH:/);
  });
});
