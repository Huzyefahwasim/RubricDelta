import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

test("two default deterministic artifact runs produce identical raw predictions and trace hashes", (t) => {
  const first = mkdtempSync(join(tmpdir(), "rubricdelta-raw-a-"));
  const second = mkdtempSync(join(tmpdir(), "rubricdelta-raw-b-"));
  t.after(() => rmSync(first, { recursive: true, force: true }));
  t.after(() => rmSync(second, { recursive: true, force: true }));
  const script = resolve("scripts/evaluate.js");
  for (const output of [first, second]) {
    const run = spawnSync(process.execPath, [script, "--mode", "both", "--output-dir", output], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
  }
  for (const file of ["baseline-predictions.json", "advanced-predictions.json", "comparison.json"]) {
    assert.equal(readFileSync(join(first, file), "utf8"), readFileSync(join(second, file), "utf8"), file);
  }
  for (const file of readdirSync(join(first, "trajectories"))) {
    assert.equal(readFileSync(join(first, "trajectories", file), "utf8"), readFileSync(join(second, "trajectories", file), "utf8"), file);
  }
});
