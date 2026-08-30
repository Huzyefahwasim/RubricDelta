import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function doc(name) {
  return readFileSync(join(root, "docs", name), "utf8");
}

test("judge reproduction, security, ownership, and demo wording remain release-accurate", () => {
  const reproduction = doc("REPRODUCTION.md");
  const security = doc("SECURITY.md");
  const failureMode = doc("MAIN_FAILURE_MODE.md");
  const demo = doc("DEMO_SCRIPT.md");
  const implementationPlan = doc("IMPLEMENTATION_PLAN.md");
  const remote = "https://github.com/Huzyefahwasim/RubricDelta.git";

  assert.match(
    reproduction,
    new RegExp(`git clone ${remote.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} RubricDelta-release\\s+cd RubricDelta-release`),
  );
  assert.match(
    reproduction,
    new RegExp(`git clone ${remote.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} RubricDelta-source\\s+cd RubricDelta-source`),
  );
  assert.match(reproduction, /deterministic-source replay/i);
  assert.match(reproduction, /(?:not|no) (?:a )?live-model (?:run|result|evidence)/i);

  assert.match(security, /security (?:scan|review).*(?:source )?revision|(?:source )?revision.*security (?:scan|review)/i);
  assert.match(security, /artifacts\/qa\/release\.json/i);
  assert.match(security, /(?:absence|absent|without).{0,80}unverified|unverified.{0,80}(?:absence|absent|without)/is);

  assert.doesNotMatch(failureMode, /\bThe team\b/i);
  assert.match(failureMode, /current implementation/i);
  assert.doesNotMatch(demo, /largest supported measured system bundle|stage-level causal attribution|isolated stage ablation/i);
  assert.match(demo, /measured bundle.{0,100}not.{0,60}(?:one|any) stage/is);

  for (const source of [reproduction, security, failureMode, demo]) {
    assert.doesNotMatch(source, /participant (?:has |already )?(?:completed|approved|confirmed) (?:the )?(?:release|review|upload|playback)/i);
  }

  assert.match(implementationPlan, /source checkout.{0,160}R3.{0,160}stale manifest/is);
  assert.match(implementationPlan, /disposable clean clone.{0,200}npm run eval.{0,200}(?:must|expected to) pass/is);
});
