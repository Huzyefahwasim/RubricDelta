import assert from "node:assert/strict";
import test from "node:test";
import { classifyGitState } from "../scripts/evaluation-artifacts.js";

const revision = "a".repeat(40);
const provenanceNote = "revision identifies the clean source commit; generated evidence is added by the subsequent packaging commit";

test("clean source and whole tree record the exact source revision", () => {
  const state = classifyGitState({
    baseRevision: revision,
    branch: "feature/test",
    trackedStatus: "",
    wholeStatus: "",
    sourceTrackedStatus: "",
    sourceUntrackedStatus: "",
    managedStatus: "",
    managedArtifactPaths: ["artifacts/evaluation"],
  });

  assert.deepEqual(state, {
    revision,
    baseRevision: revision,
    branch: "feature/test",
    trackedWorkingTreeDirty: false,
    wholeWorkingTreeDirty: false,
    sourceTrackedWorkingTreeDirty: false,
    sourceUntrackedWorkingTreeDirty: false,
    sourceWorkingTreeDirty: false,
    managedArtifactDirty: false,
    packagingCommit: null,
    provenanceNote,
    sourceState: "clean-commit",
  });
});

test("managed output changes preserve a clean source revision while disclosing whole-tree dirtiness", () => {
  const state = classifyGitState({
    baseRevision: revision,
    branch: "feature/test",
    trackedStatus: " M artifacts/evaluation/manifest.json",
    wholeStatus: " M artifacts/evaluation/manifest.json\n?? artifacts/evaluation/new.json",
    sourceTrackedStatus: "",
    sourceUntrackedStatus: "",
    managedStatus: " M artifacts/evaluation/manifest.json\n?? artifacts/evaluation/new.json",
    managedArtifactPaths: ["artifacts/evaluation"],
  });

  assert.equal(state.revision, revision);
  assert.equal(state.trackedWorkingTreeDirty, true);
  assert.equal(state.wholeWorkingTreeDirty, true);
  assert.equal(state.sourceWorkingTreeDirty, false);
  assert.equal(state.managedArtifactDirty, true);
  assert.equal(state.sourceState, "clean-source-managed-artifacts-dirty");
});

test("tracked or untracked source dirtiness withholds the source revision", () => {
  for (const input of [
    { sourceTrackedStatus: " M README.md", sourceUntrackedStatus: "" },
    { sourceTrackedStatus: "", sourceUntrackedStatus: "untracked-source.js" },
  ]) {
    const state = classifyGitState({
      baseRevision: revision,
      branch: "feature/test",
      trackedStatus: input.sourceTrackedStatus,
      wholeStatus: input.sourceTrackedStatus || `?? ${input.sourceUntrackedStatus}`,
      sourceTrackedStatus: input.sourceTrackedStatus,
      sourceUntrackedStatus: input.sourceUntrackedStatus,
      managedStatus: "",
      managedArtifactPaths: ["artifacts/evaluation"],
    });
    assert.equal(state.revision, null);
    assert.equal(state.sourceWorkingTreeDirty, true);
    assert.equal(state.sourceTrackedWorkingTreeDirty, Boolean(input.sourceTrackedStatus));
    assert.equal(state.sourceUntrackedWorkingTreeDirty, Boolean(input.sourceUntrackedStatus));
    assert.equal(state.sourceState, "source-working-tree-dirty");
  }
});
