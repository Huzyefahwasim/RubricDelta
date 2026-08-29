import assert from "node:assert/strict";
import test from "node:test";
import { createGitState } from "../scripts/evaluation-artifacts.js";

test("clean empty porcelain status records the exact source revision", () => {
  const revision = "a".repeat(40);
  const outputs = new Map([
    ["rev-parse HEAD", revision],
    ["status --porcelain --untracked-files=no", ""],
    ["branch --show-current", "feature/test"],
  ]);

  const state = createGitState((args) => outputs.get(args.join(" ")));

  assert.deepEqual(state, {
    revision,
    baseRevision: revision,
    branch: "feature/test",
    trackedWorkingTreeDirty: false,
    packagingCommit: null,
    provenanceNote: "revision identifies the clean source commit; generated evidence is added by the subsequent packaging commit",
    sourceState: "clean-commit",
  });
});
