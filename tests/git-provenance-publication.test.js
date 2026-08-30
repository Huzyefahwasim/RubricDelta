import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  after,
  test,
} from "node:test";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let sharedFixture;
let firstPublicationFixture;
const temporaryRoots = new Set();
const managedEvidenceRoots = [
  "artifacts/evaluation",
  "artifacts/representative-trajectories",
  "artifacts/expected-replay-report",
  "artifacts/qa",
  "artifacts/submission",
  "artifacts/development-agent",
];

after(() => {
  for (const temporary of temporaryRoots) rmSync(temporary, { recursive: true, force: true });
});

function command(cwd, executable, args, options = {}) {
  return spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    input: options.input,
    windowsHide: true,
    timeout: options.timeout ?? 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

function output(result) {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

function git(cwd, args) {
  const result = command(cwd, "git", args);
  assert.equal(result.status, 0, `git ${args.join(" ")}\n${output(result)}`);
  return result.stdout.trim();
}

function run(cwd, script, args = []) {
  return command(cwd, process.execPath, [script, ...args]);
}

function validate(cwd) {
  return run(cwd, "scripts/validate-submission.js", ["--mode", "build"]);
}

function readManifest(cwd) {
  return JSON.parse(readFileSync(join(cwd, "artifacts", "evaluation", "manifest.json"), "utf8"));
}

function assertHistoricalGenerationSnapshot(state, sourceRevision, trackedWorkingTreeDirty = true) {
  assert.equal(state.revision, sourceRevision);
  assert.equal(state.baseRevision, sourceRevision);
  assert.equal(state.trackedWorkingTreeDirty, trackedWorkingTreeDirty);
  assert.equal(state.wholeWorkingTreeDirty, true);
  assert.equal(state.sourceTrackedWorkingTreeDirty, false);
  assert.equal(state.sourceUntrackedWorkingTreeDirty, false);
  assert.equal(state.sourceWorkingTreeDirty, false);
  assert.equal(state.managedArtifactDirty, true);
  assert.equal(state.sourceState, "clean-source-managed-artifacts-dirty");
}

function privacyExcludedPath(path) {
  const topLevel = path.split("/")[0];
  return path === ".env"
    || (path.startsWith(".env.") && path !== ".env.example")
    || ["node_modules", "logs", "coverage", "tmp"].includes(topLevel)
    || path.endsWith(".log");
}

function copyGitVisibleWorktree(sourceRoot, target) {
  const listPaths = (args, label) => {
    const listed = command(sourceRoot, "git", ["ls-files", ...args, "-z"]);
    assert.equal(listed.status, 0, `${label}\n${output(listed)}`);
    const paths = listed.stdout === ""
      ? []
      : listed.stdout.endsWith("\0")
        ? listed.stdout.slice(0, -1).split("\0")
        : null;
    assert.ok(paths, `${label} must return NUL-terminated records`);
    return paths;
  };
  const candidates = [
    ...listPaths(["--cached"], "git ls-files --cached").map((path) => ({ path, untracked: false })),
    ...listPaths(
      ["--others", "--exclude-standard"],
      "git ls-files --others --exclude-standard",
    ).map((path) => ({ path, untracked: true })),
  ];
  mkdirSync(target, { recursive: true });
  for (const { path, untracked } of candidates) {
    const parts = path.split("/");
    assert.ok(
      path !== "" && !path.includes("\\") && !path.startsWith("/") && !path.endsWith("/")
        && parts.every((part) => part !== "" && part !== "." && part !== ".."),
      "git ls-files returned a noncanonical path",
    );
    if (untracked && privacyExcludedPath(path)) continue;
    const sourcePath = join(sourceRoot, ...parts);
    if (!existsSync(sourcePath)) continue;
    assert.equal(lstatSync(sourcePath).isFile(), true, "fixture copies regular files only");
    const targetPath = join(target, ...parts);
    mkdirSync(dirname(targetPath), { recursive: true });
    copyFileSync(sourcePath, targetPath);
  }
}

function buildPublicationFixture({ prefix, omitManagedEvidence = false }) {
  const temporary = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.add(temporary);
  const source = join(temporary, "source");
  copyGitVisibleWorktree(root, source);
  if (omitManagedEvidence) {
    for (const relativePath of managedEvidenceRoots) {
      rmSync(join(source, ...relativePath.split("/")), { recursive: true, force: true });
    }
  }
  git(source, ["init", "--initial-branch=main"]);
  git(source, ["config", "user.name", "RubricDelta Provenance Test"]);
  git(source, ["config", "user.email", "provenance@rubricdelta.invalid"]);
  git(source, ["add", "--all"]);
  git(source, ["commit", "-m", "clean source revision"]);
  const sourceRevision = git(source, ["rev-parse", "HEAD"]);

  const evaluation = run(source, "scripts/evaluate.js", ["--mode", "both"]);
  assert.equal(evaluation.status, 0, `evaluation\n${output(evaluation)}`);
  const evidence = run(source, "scripts/generate-evidence.js");
  assert.equal(evidence.status, 0, `evidence\n${output(evidence)}`);
  const generationState = readManifest(source).git;
  const prePublicationValidation = validate(source);

  git(source, ["add", "--all", "--", "artifacts"]);
  git(source, ["commit", "-m", "publish deterministic evidence"]);
  const publicationRevision = git(source, ["rev-parse", "HEAD"]);
  assert.notEqual(publicationRevision, sourceRevision);
  assert.equal(git(source, ["status", "--porcelain=v1", "--untracked-files=all"]), "");

  return {
    temporary,
    source,
    sourceRevision,
    publicationRevision,
    generationState,
    prePublicationValidation,
  };
}

function createPublicationFixture() {
  if (!sharedFixture) {
    sharedFixture = buildPublicationFixture({
      prefix: "rubricdelta-provenance-publication-",
    });
  }
  return sharedFixture;
}

function createFirstPublicationFixture() {
  if (!firstPublicationFixture) {
    firstPublicationFixture = buildPublicationFixture({
      prefix: "rubricdelta-first-publication-",
      omitManagedEvidence: true,
    });
  }
  return firstPublicationFixture;
}

function cloneFixture(fixture, prefix) {
  const parent = mkdtempSync(join(fixture.temporary, prefix));
  const clone = join(parent, "clone");
  const result = command(parent, "git", ["clone", "--quiet", "--no-hardlinks", "--", fixture.source, clone]);
  assert.equal(result.status, 0, `local clone\n${output(result)}`);
  return { ...fixture, clone };
}

function clonePublication(prefix) {
  return cloneFixture(createPublicationFixture(), prefix);
}

function cloneFirstPublication(prefix) {
  return cloneFixture(createFirstPublicationFixture(), prefix);
}

test("fixture copier preserves tracked privacy-named files and filters only untracked privacy paths", (t) => {
  const temporary = mkdtempSync(join(tmpdir(), "rubricdelta-hermetic-copy-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const source = join(temporary, "source");
  const target = join(temporary, "target");
  mkdirSync(source, { recursive: true });
  git(source, ["init", "--initial-branch=main"]);

  const writeFixture = (relativePath, content) => {
    const path = join(source, ...relativePath.split("/"));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
  };
  writeFixture(
    ".gitignore",
    ".env*\nlogs/\ncoverage/\ntmp/\nnode_modules/\n*.log\n",
  );
  const trackedPrivacyPaths = [
    ".env",
    "logs/tracked.log",
    "coverage/tracked.txt",
    "tmp/tracked.txt",
    "node_modules/tracked.js",
  ];
  for (const relativePath of trackedPrivacyPaths) {
    writeFixture(relativePath, `tracked fixture ${relativePath}\n`);
  }
  git(source, ["add", "--", ".gitignore"]);
  git(source, ["add", "--force", "--", ...trackedPrivacyPaths]);

  const untrackedPrivacyPaths = [
    ".env.local",
    "logs/untracked.log",
    "coverage/untracked.txt",
    "tmp/untracked.txt",
    "node_modules/untracked.js",
  ];
  for (const relativePath of untrackedPrivacyPaths) {
    writeFixture(relativePath, `untracked private fixture ${relativePath}\n`);
  }
  writeFixture("current-untracked.js", "export const current = true;\n");

  copyGitVisibleWorktree(source, target);

  for (const relativePath of trackedPrivacyPaths) {
    assert.equal(existsSync(join(target, ...relativePath.split("/"))), true, relativePath);
  }
  for (const relativePath of untrackedPrivacyPaths) {
    assert.equal(existsSync(join(target, ...relativePath.split("/"))), false, relativePath);
  }
  assert.equal(existsSync(join(target, "current-untracked.js")), true);
});

test("one-run clean source publication reports managed dirtiness and validates", () => {
  const fixture = createPublicationFixture();
  assertHistoricalGenerationSnapshot(fixture.generationState, fixture.sourceRevision);
  assert.equal(
    fixture.prePublicationValidation.status,
    0,
    `pre-publication validation\n${output(fixture.prePublicationValidation)}`,
  );
});

test("first publication accepts untracked-only generated evidence", () => {
  const fixture = createFirstPublicationFixture();
  assertHistoricalGenerationSnapshot(
    fixture.generationState,
    fixture.sourceRevision,
    false,
  );
  assert.equal(
    fixture.prePublicationValidation.status,
    0,
    `first-publication validation\n${output(fixture.prePublicationValidation)}`,
  );
});

test("historical tracked dirtiness disclosure must remain boolean", () => {
  const { clone } = clonePublication("nonboolean-tracked-state-");
  git(clone, ["config", "user.name", "RubricDelta Provenance Test"]);
  git(clone, ["config", "user.email", "provenance@rubricdelta.invalid"]);
  const manifest = readManifest(clone);
  manifest.git.trackedWorkingTreeDirty = "unknown";
  writeFileSync(
    join(clone, "artifacts", "evaluation", "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  git(clone, ["add", "--", "artifacts/evaluation/manifest.json"]);
  git(clone, ["commit", "-m", "forge nonboolean tracked state"]);

  const result = validate(clone);
  assert.notEqual(result.status, 0, output(result));
  assert.match(output(result), /manifest\.git\.trackedWorkingTreeDirty.*must be boolean/i);
});

test("published tracked evidence rejects a forged false tracked-dirty disclosure", () => {
  const { clone } = clonePublication("tracked-state-false-forgery-");
  git(clone, ["config", "user.name", "RubricDelta Provenance Test"]);
  git(clone, ["config", "user.email", "provenance@rubricdelta.invalid"]);
  const manifest = readManifest(clone);
  manifest.git.trackedWorkingTreeDirty = false;
  writeFileSync(
    join(clone, "artifacts", "evaluation", "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  git(clone, ["add", "--", "artifacts/evaluation/manifest.json"]);
  git(clone, ["commit", "-m", "forge false tracked publication state"]);

  const result = validate(clone);
  assert.notEqual(result.status, 0, output(result));
  assert.match(output(result), /manifest\.git\.trackedWorkingTreeDirty.*first publication snapshot/i);
});

test("untracked-only first publication rejects a forged true tracked-dirty disclosure", () => {
  const { clone } = cloneFirstPublication("tracked-state-true-forgery-");
  git(clone, ["config", "user.name", "RubricDelta Provenance Test"]);
  git(clone, ["config", "user.email", "provenance@rubricdelta.invalid"]);
  const manifest = readManifest(clone);
  manifest.git.trackedWorkingTreeDirty = true;
  writeFileSync(
    join(clone, "artifacts", "evaluation", "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  git(clone, ["add", "--", "artifacts/evaluation/manifest.json"]);
  git(clone, ["commit", "-m", "forge true tracked publication state"]);

  const result = validate(clone);
  assert.notEqual(result.status, 0, output(result));
  assert.match(output(result), /manifest\.git\.trackedWorkingTreeDirty.*first publication snapshot/i);
});

test("later evidence commits do not redefine the first publication snapshot", () => {
  const { clone } = cloneFirstPublication("later-evidence-publication-");
  git(clone, ["config", "user.name", "RubricDelta Provenance Test"]);
  git(clone, ["config", "user.email", "provenance@rubricdelta.invalid"]);
  appendFileSync(
    join(clone, "artifacts", "expected-replay-report", "README.md"),
    "\nlater Task 9 evidence\n",
    "utf8",
  );
  git(clone, ["add", "--", "artifacts/expected-replay-report/README.md"]);
  git(clone, ["commit", "-m", "publish later evidence"]);

  const result = validate(clone);
  assert.equal(result.status, 0, output(result));
});

test("clean clone of an evidence-only publication validates the historical generation snapshot", () => {
  const fixture = clonePublication("clean-clone-");
  assert.equal(git(fixture.clone, ["rev-parse", "HEAD"]), fixture.publicationRevision);
  assert.equal(git(fixture.clone, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
  assertHistoricalGenerationSnapshot(readManifest(fixture.clone).git, fixture.sourceRevision);

  const result = validate(fixture.clone);
  assert.equal(result.status, 0, `clean publication validation\n${output(result)}`);
  assert.match(result.stdout, /measured Git state matches a clean source and evidence-only ancestry/i);
});

test("evidence-only descendant with uncommitted evidence fails closed", () => {
  const { clone } = clonePublication("dirty-evidence-");
  appendFileSync(
    join(clone, "artifacts", "expected-replay-report", "README.md"),
    "\nuncommitted publication drift\n",
    "utf8",
  );

  const result = validate(clone);
  assert.notEqual(result.status, 0, output(result));
  assert.match(output(result), /DIRTY PUBLISHED TREE.*evidence-only descendant.*clean/i);
});

test("an uncommitted evidence-to-source rename is measured as source dirtiness", () => {
  const { clone } = clonePublication("dirty-rename-");
  git(clone, ["config", "status.renames", "true"]);
  git(clone, ["mv", "--", "artifacts/qa/README.md", "src/renamed-qa-readme.md"]);

  const result = validate(clone);
  assert.notEqual(result.status, 0, output(result));
  assert.match(output(result), /DIRTY SOURCE: repository.*outside the evidence-only boundary/i);
});

test("assume-unchanged cannot hide an uncommitted source change", () => {
  const { clone } = clonePublication("assume-unchanged-");
  appendFileSync(join(clone, "README.md"), "\nhidden source change\n", "utf8");
  git(clone, ["update-index", "--assume-unchanged", "--", "README.md"]);
  assert.match(git(clone, ["ls-files", "-v", "--", "README.md"]), /^h /);
  assert.equal(git(clone, ["status", "--porcelain=v1", "--untracked-files=all"]), "");

  const result = validate(clone);
  assert.notEqual(result.status, 0, output(result));
  assert.match(output(result), /HIDDEN INDEX STATE: repository.*nondefault index flags/i);
});

test("skip-worktree cannot hide an uncommitted source change", () => {
  const { clone } = clonePublication("skip-worktree-");
  git(clone, ["update-index", "--skip-worktree", "--", "README.md"]);
  appendFileSync(join(clone, "README.md"), "\nhidden source change\n", "utf8");
  assert.match(git(clone, ["ls-files", "-v", "--", "README.md"]), /^S /);
  assert.equal(git(clone, ["status", "--porcelain=v1", "--untracked-files=all"]), "");

  const result = validate(clone);
  assert.notEqual(result.status, 0, output(result));
  assert.match(output(result), /HIDDEN INDEX STATE: repository.*nondefault index flags/i);
});

test("an evidence-to-source rename in publication history is rejected", () => {
  const { clone } = clonePublication("history-rename-");
  git(clone, ["config", "user.name", "RubricDelta Provenance Test"]);
  git(clone, ["config", "user.email", "provenance@rubricdelta.invalid"]);
  git(clone, ["config", "diff.renames", "true"]);
  const evidencePath = join(clone, "artifacts", "qa", "rename-probe.txt");
  writeFileSync(evidencePath, "rename probe\n", "utf8");
  git(clone, ["add", "--", "artifacts/qa/rename-probe.txt"]);
  git(clone, ["commit", "-m", "add rename probe evidence"]);
  git(clone, ["mv", "--", "artifacts/qa/rename-probe.txt", "src/rename-probe.txt"]);
  git(clone, ["commit", "-m", "move evidence into source"]);
  assert.equal(git(clone, ["status", "--porcelain=v1", "--untracked-files=all"]), "");

  const result = validate(clone);
  assert.notEqual(result.status, 0, output(result));
  assert.match(output(result), /manifest\.git\.revision.*source-to-HEAD commits contain non-evidence changes/i);
});

test("a merge commit in evidence publication history is rejected", () => {
  const { clone } = clonePublication("history-merge-");
  git(clone, ["config", "user.name", "RubricDelta Provenance Test"]);
  git(clone, ["config", "user.email", "provenance@rubricdelta.invalid"]);
  git(clone, ["checkout", "-b", "evidence-side"]);
  writeFileSync(join(clone, "artifacts", "qa", "side.txt"), "side evidence\n", "utf8");
  git(clone, ["add", "--", "artifacts/qa/side.txt"]);
  git(clone, ["commit", "-m", "add side evidence"]);
  git(clone, ["checkout", "main"]);
  writeFileSync(join(clone, "artifacts", "qa", "main.txt"), "main evidence\n", "utf8");
  git(clone, ["add", "--", "artifacts/qa/main.txt"]);
  git(clone, ["commit", "-m", "add main evidence"]);
  git(clone, ["merge", "--no-ff", "evidence-side", "-m", "merge evidence branches"]);

  const result = validate(clone);
  assert.notEqual(result.status, 0, output(result));
  assert.match(output(result), /manifest\.git\.revision.*linear verifiable commit sequence/i);
});

test("an intermediate descendant tree with case-colliding paths is rejected", () => {
  const { clone } = clonePublication("history-portable-collision-");
  git(clone, ["config", "user.name", "RubricDelta Provenance Test"]);
  git(clone, ["config", "user.email", "provenance@rubricdelta.invalid"]);
  git(clone, ["config", "core.ignorecase", "false"]);
  const hashed = command(clone, "git", ["hash-object", "-w", "--stdin"], {
    input: "portable collision probe\n",
  });
  assert.equal(hashed.status, 0, `hash probe\n${output(hashed)}`);
  const blob = hashed.stdout.trim();
  const upper = "artifacts/qa/Portable-Collision.txt";
  const lower = "artifacts/qa/portable-collision.txt";
  git(clone, ["update-index", "--add", "--cacheinfo", `100644,${blob},${upper}`]);
  git(clone, ["commit", "-m", "add upper-case evidence path"]);
  git(clone, ["update-index", "--add", "--cacheinfo", `100644,${blob},${lower}`]);
  git(clone, ["commit", "-m", "add colliding lower-case evidence path"]);
  git(clone, ["update-index", "--force-remove", "--", upper]);
  git(clone, ["commit", "-m", "remove upper-case evidence path"]);
  git(clone, ["update-index", "--force-remove", "--", lower]);
  git(clone, ["commit", "-m", "remove lower-case evidence path"]);
  assert.equal(git(clone, ["status", "--porcelain=v1", "--untracked-files=all"]), "");

  const result = validate(clone);
  assert.notEqual(result.status, 0, output(result));
  assert.match(
    output(result),
    /manifest\.git\.revision.*descendant evidence trees must use portable Git paths/i,
  );
});

test("unsafe evidence mode in publication history is rejected", () => {
  const { clone } = clonePublication("unsafe-mode-");
  git(clone, ["config", "user.name", "RubricDelta Provenance Test"]);
  git(clone, ["config", "user.email", "provenance@rubricdelta.invalid"]);
  const secretLikeName = "sk-DO-NOT-ECHO-PROVENANCE-123456789";
  const relativePath = `artifacts/qa/${secretLikeName}`;
  const absolutePath = join(clone, ...relativePath.split("/"));
  writeFileSync(absolutePath, "README.md", "utf8");
  const blob = git(clone, ["hash-object", "-w", "--", relativePath]);
  git(clone, ["update-index", "--add", "--cacheinfo", `120000,${blob},${relativePath}`]);
  git(clone, ["commit", "-m", "add unsafe evidence mode"]);
  assert.equal(git(clone, ["status", "--porcelain=v1", "--untracked-files=all"]), "");

  const result = validate(clone);
  assert.notEqual(result.status, 0, output(result));
  assert.match(output(result), /manifest\.git\.revision.*unsafe evidence mode.*120000/i);
  assert.equal(output(result).includes(secretLikeName), false, "validator output must not echo a Git filename");
});

test("source change followed by a revert remains rejected from intermediate history", () => {
  const { clone } = clonePublication("source-revert-");
  git(clone, ["config", "user.name", "RubricDelta Provenance Test"]);
  git(clone, ["config", "user.email", "provenance@rubricdelta.invalid"]);
  const readme = join(clone, "README.md");
  const original = readFileSync(readme);
  appendFileSync(readme, "\nintermediate source change\n", "utf8");
  git(clone, ["add", "--", "README.md"]);
  git(clone, ["commit", "-m", "change source"]);
  writeFileSync(readme, original);
  git(clone, ["add", "--", "README.md"]);
  git(clone, ["commit", "-m", "revert source bytes"]);
  assert.equal(git(clone, ["diff", "--quiet", sharedFixture.sourceRevision, "HEAD", "--", "README.md"]), "");

  const result = validate(clone);
  assert.notEqual(result.status, 0, output(result));
  assert.match(output(result), /manifest\.git\.revision.*source-to-HEAD commits contain non-evidence changes/i);
});
