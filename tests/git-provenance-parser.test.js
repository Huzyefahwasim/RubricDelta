import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  isGitObjectId,
  parseGitIndexState,
  parseGitStatus,
  parseRawCommitChanges,
  portableGitPathSet,
} from "../scripts/git-provenance.js";

const hash = "a".repeat(40);

test("Git object IDs accept exactly lowercase SHA-1 and SHA-256 widths", () => {
  assert.equal(isGitObjectId("a".repeat(40)), true);
  assert.equal(isGitObjectId("b".repeat(64)), true);
  for (const value of [
    "a".repeat(39),
    "a".repeat(41),
    "b".repeat(63),
    "b".repeat(65),
    "A".repeat(40),
    `${"a".repeat(39)}g`,
    null,
  ]) {
    assert.equal(isGitObjectId(value), false);
  }
});

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

test("Git parsers preserve canonical slash paths and reject noncanonical path identity", () => {
  assert.deepEqual(
    parseGitStatus("?? artifacts/qa/probe.txt\0"),
    [{ code: "??", path: "artifacts/qa/probe.txt" }],
  );
  assert.equal(parseGitStatus("?? artifacts\\qa\\probe.txt\0"), null);
  assert.equal(parseGitStatus("?? artifacts//qa/probe.txt\0"), null);
  assert.equal(parseGitStatus("?? artifacts/../src/probe.txt\0"), null);

  const metadata = `:100644 100644 ${hash} ${hash} M`;
  assert.deepEqual(
    parseRawCommitChanges(`${metadata}\0artifacts/qa/probe.txt\0`),
    [{
      oldMode: "100644",
      newMode: "100644",
      status: "M",
      path: "artifacts/qa/probe.txt",
    }],
  );
  assert.equal(
    parseRawCommitChanges(`${metadata}\0artifacts\\qa\\probe.txt\0`),
    null,
  );
});

test("Git emits canonical slash paths for a nested filename on this platform", (t) => {
  const root = mkdtempSync(join(tmpdir(), "rubricdelta-git-path-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, ["init", "--initial-branch=main"]);
  mkdirSync(join(root, "artifacts", "qa"), { recursive: true });
  writeFileSync(join(root, "artifacts", "qa", "probe.txt"), "probe\n", "utf8");

  const source = git(root, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--no-renames",
  ]);
  assert.deepEqual(
    parseGitStatus(source),
    [{ code: "??", path: "artifacts/qa/probe.txt" }],
  );
});

test("Git parsers reject nonportable segments and sibling collisions", () => {
  assert.equal(
    portableGitPathSet(["README.md", "README.md"]),
    true,
    "index/status overlap is not a collision",
  );

  for (const path of [
    "artifacts/qa/bad:name.txt",
    "artifacts/qa/bad?.txt",
    "artifacts/qa/control\u0001.txt",
    "artifacts/qa/control\u0085.txt",
    "artifacts/qa/format\u202e.txt",
    "artifacts/qa/format\u200d.txt",
    "artifacts/qa/trailing.",
    "artifacts/qa/trailing ",
    "artifacts/qa/CON",
    "artifacts/qa/CONIN$",
    "artifacts/qa/CONOUT$.txt",
    "artifacts/qa/nul.txt",
    "artifacts/qa/COM1.json",
    "artifacts/qa/COM¹.txt",
    "artifacts/qa/LPT².txt",
    "artifacts/qa/e\u0301.txt",
    `artifacts/qa/${"a".repeat(256)}`,
    `artifacts/qa/${"é".repeat(128)}`,
  ]) {
    assert.equal(parseGitStatus(`?? ${path}\0`), null, path);
  }

  assert.equal(
    portableGitPathSet([`artifacts/qa/${"a".repeat(255)}`]),
    true,
    "a 255-byte ASCII component remains portable",
  );
  assert.equal(
    parseGitStatus("?? Artifacts/qa/one.txt\0?? artifacts/qa/two.txt\0"),
    null,
  );
  assert.equal(
    parseGitStatus("?? artifacts/qa/Å.txt\0?? artifacts/qa/å.txt\0"),
    null,
  );
  assert.equal(
    portableGitPathSet(["artifacts/qa/ΐ.txt", "artifacts/qa/Ϊ́.txt"]),
    false,
    "case folding must renormalize multi-code-point Unicode mappings",
  );
  assert.equal(
    parseGitIndexState("H artifacts/QA/one.txt\0H artifacts/qa/two.txt\0"),
    null,
  );
  assert.notEqual(
    parseGitStatus("?? one/File.txt\0?? two/file.txt\0"),
    null,
  );
});

test(
  "POSIX literal-backslash filenames are rejected without path rewriting",
  { skip: process.platform === "win32" },
  (t) => {
    const root = mkdtempSync(join(tmpdir(), "rubricdelta-git-backslash-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    git(root, ["init", "--initial-branch=main"]);
    writeFileSync(join(root, "artifacts\\qa\\probe.txt"), "probe\n", "utf8");

    const source = git(root, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--no-renames",
    ]);
    assert.match(source, /artifacts\\qa\\probe\.txt/);
    assert.equal(parseGitStatus(source), null);
  },
);

test(
  "POSIX case-colliding filenames are rejected as one real Git path set",
  { skip: process.platform === "win32" },
  (t) => {
    const root = mkdtempSync(join(tmpdir(), "rubricdelta-git-collision-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    git(root, ["init", "--initial-branch=main"]);
    writeFileSync(join(root, "Case.txt"), "one\n", "utf8");
    writeFileSync(join(root, "case.txt"), "two\n", "utf8");

    const source = git(root, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--no-renames",
    ]);
    assert.equal(parseGitStatus(source), null);
  },
);
