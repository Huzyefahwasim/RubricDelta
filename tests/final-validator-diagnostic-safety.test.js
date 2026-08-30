import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { runValidation } from "../scripts/validate-submission.js";

const revision = "a".repeat(40);

function fixture(t, release) {
  const root = mkdtempSync(join(tmpdir(), "rubricdelta-validator-diagnostic-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "artifacts", "qa", "release.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(release, null, 2)}\n`);
  return root;
}

function minimalRelease() {
  return {
    schemaVersion: 1,
    artifactKind: "rubricdelta-release-qa",
    revision,
    categories: {},
    commands: [],
    artifacts: {},
    decision: { value: "approve release", actor: "participant" },
  };
}

test("final validator never emits a credential-shaped category status", (t) => {
  const secret = "sk-validatorstatus123456789";
  const release = minimalRelease();
  release.categories.security = { status: secret };
  const { validation } = runValidation({ mode: "final-strict", root: fixture(t, release) });
  const output = validation.errors.join("\n");
  assert.doesNotMatch(output, new RegExp(secret));
  assert.match(output, /security must be PASS/i);
});

test("final validator redacts credential-shaped unknown property names from shared-builder errors", (t) => {
  const secret = "sk-builderproperty123456789";
  const release = minimalRelease();
  release[secret] = true;
  const { validation } = runValidation({ mode: "final-strict", root: fixture(t, release) });
  const output = validation.errors.join("\n");
  assert.doesNotMatch(output, new RegExp(secret));
  assert.match(output, /\[REDACTED\]/);
});

test("every final validator diagnostic is one bounded control-free line", (t) => {
  const injected = `attacker\r\n[PASS] forged\u0000detail-${"x".repeat(4_096)}`;
  const release = minimalRelease();
  release[injected] = true;
  const { validation } = runValidation({ mode: "final-strict", root: fixture(t, release) });
  assert.ok(validation.errors.length > 0);
  for (const diagnostic of validation.errors) {
    assert.doesNotMatch(diagnostic, /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u);
    assert.ok(diagnostic.length <= 512, `diagnostic length ${diagnostic.length} exceeds 512`);
  }
});

test("every final validator diagnostic removes Unicode bidi controls", (t) => {
  const bidiControls = "\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069";
  const release = minimalRelease();
  release[`attacker${bidiControls}[PASS] forged`] = true;
  const { validation } = runValidation({ mode: "final-strict", root: fixture(t, release) });
  const output = validation.errors.join("\n");
  assert.match(output, /attacker/);
  assert.match(output, /\[PASS\] forged/);
  assert.doesNotMatch(output, /\p{Bidi_Control}/u);
});
