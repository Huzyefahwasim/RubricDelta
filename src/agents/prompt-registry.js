import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const promptRoot = resolve(moduleDirectory, "../../prompts");
const ROLE_FILES = Object.freeze([
  ["rule-compiler", "rule-compiler.v1.md"],
  ["change-analyst", "change-analyst.v1.md"],
  ["impact-investigator", "impact-investigator.v1.md"],
  ["independent-verifier", "independent-verifier.v1.md"],
  ["direct-baseline", "direct-baseline.v1.md"],
]);

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const prompts = ROLE_FILES.map(([id, filename]) => {
  const instruction = readFileSync(resolve(promptRoot, filename), "utf8").replaceAll("\r\n", "\n");
  return Object.freeze({ id, version: "v1", filename, sha256: sha256(instruction), instruction });
});
const byId = new Map(prompts.map((item) => [item.id, item]));

export function getPrompt(role) {
  const item = byId.get(role);
  if (!item) throw new Error(`Unknown prompt role: ${String(role)}`);
  return structuredClone(item);
}

export function listPrompts() {
  return structuredClone(prompts);
}

export function promptRegistryBinding() {
  return Object.fromEntries(prompts.map((item) => [item.id, {
    version: item.version,
    filename: item.filename,
    sha256: item.sha256,
  }]));
}
