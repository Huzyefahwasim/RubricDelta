import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "scripts", "validate-submission.js"), "utf8");

test("final QA revision is bound to the deterministic source revision", () => {
  assert.match(source, /release\.revision\s*!==\s*manifest\?\.git\?\.revision|manifest\?\.git\?\.revision\s*!==\s*release\.revision/);
});

test("development evidence uses a canonical contained path contract", () => {
  assert.match(source, /DEVELOPMENT_AGENT_PATH|canonicalDevelopmentPath|development-agent.*(?:segment|realpath|contain)/i);
  assert.match(source, /path\.includes\(\"\.\.\"\)|\.\.\/.*DEVELOPMENT|DEVELOPMENT.*\.\.\//i);
});

test("video validation binds sample timing, chunk maps, sizes, and byte ranges", () => {
  for (const contract of [/stts.*sampleCount|sampleCount.*stts/is, /stsc.*chunk|chunk.*stsc/is, /stsz.*sample|sample.*stsz/is, /stco|co64/, /sample.*(?:range|offset)|(?:range|offset).*sample/is]) {
    assert.match(source, contract);
  }
});

test("each QA category uses unique category-specific structured PASS evidence", () => {
  assert.match(source, /categoryPaths|unique.*category.*path/i);
  assert.match(source, /artifactKind.*rubricdelta-qa-category|rubricdelta-qa-category.*artifactKind/is);
  assert.match(source, /category.*timestamp.*tool.*coverage|coverage.*tool.*timestamp.*category/is);
  assert.match(source, /NOT RUN|PENDING/);
});
