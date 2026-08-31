import assert from "node:assert/strict";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const validator = join(root, "scripts", "validate-submission.js");
const sourceContractPath = "tests/task8-source-contract.test.js";
const sourceContractSha256 = "a0e45636de72ac3e0e1bdc66869cee6487b81e85cf6f81bca21f8e86b6d9f01b";

function fixture(t) {
  const destination = join(mkdtempSync(join(tmpdir(), "rubricdelta-inventory-validator-")), "repo");
  t.after(() => rmSync(dirname(destination), { recursive: true, force: true }));
  cpSync(root, destination, {
    recursive: true,
    filter(source) {
      const relative = source.slice(root.length).replaceAll("\\", "/");
      return !relative.startsWith("/.git")
        && !relative.startsWith("/.superpowers")
        && !relative.startsWith("/tmp")
        && !relative.startsWith("/artifacts/runs");
    },
  });
  return destination;
}

test("Task 8 validator hash-binds and executes the deterministic source contract", (t) => {
  const source = readFileSync(validator, "utf8");
  assert.match(source, new RegExp(sourceContractPath.replaceAll("/", "\\/")));
  assert.match(source, new RegExp(sourceContractSha256));

  const project = fixture(t);
  writeFileSync(join(project, ...sourceContractPath.split("/")), "throw new Error('SOURCE_CONTRACT_INVENTORY_MUTATION');\n", "utf8");
  const command = spawnSync(process.execPath, [validator, "--mode", "build", "--root", project], {
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const output = `${command.stdout ?? ""}\n${command.stderr ?? ""}`;
  assert.notEqual(command.status, 0, output);
  assert.match(output, /\[FAIL\].*(?:PROVIDER|WORKFLOW|TASK 8).*TEST/i);
});
