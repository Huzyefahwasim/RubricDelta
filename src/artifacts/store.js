import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, posix, relative, resolve, sep, win32 } from "node:path";
import { randomUUID } from "node:crypto";

function fail(message) {
  throw new Error(`Invalid artifact path: ${message}`);
}

function nonblank(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function resolveArtifactPath(root, requestedPath) {
  if (!nonblank(requestedPath) || requestedPath.includes("\0")) fail("path must be a nonblank relative path");
  if (isAbsolute(requestedPath) || win32.isAbsolute(requestedPath) || posix.isAbsolute(requestedPath) || /^[a-zA-Z]:/.test(requestedPath)) fail("absolute paths are not allowed");
  const normalized = requestedPath.replace(/[\\/]+/g, sep);
  if (normalized.split(sep).includes("..")) fail("parent traversal is not allowed");
  const target = resolve(root, normalized);
  const relativeTarget = relative(root, target);
  if (relativeTarget === "" || relativeTarget === ".." || relativeTarget.startsWith(`..${sep}`) || isAbsolute(relativeTarget)) fail("path escapes the artifact root");
  return target;
}

function validContent(content) {
  return typeof content === "string" || Buffer.isBuffer(content) || content instanceof Uint8Array;
}

export function createArtifactStore(root) {
  if (!nonblank(root)) throw new Error("Invalid artifact root: root must be a nonblank path");
  const resolvedRoot = resolve(root);

  async function write(requestedPath, content) {
    const target = resolveArtifactPath(resolvedRoot, requestedPath);
    if (!validContent(content)) throw new Error("Artifact content must be a string or byte array");
    const targetDirectory = dirname(target);
    await mkdir(targetDirectory, { recursive: true });
    const temporary = resolve(targetDirectory, `.${basename(target)}.${randomUUID()}.tmp`);
    if (dirname(temporary) !== targetDirectory) throw new Error("Artifact temporary path escaped its target directory");
    try {
      await writeFile(temporary, content, { flag: "wx" });
      await rename(temporary, target);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
    return target;
  }

  return {
    root: resolvedRoot,
    pathFor(requestedPath) { return resolveArtifactPath(resolvedRoot, requestedPath); },
    read(requestedPath, options = "utf8") { return readFile(resolveArtifactPath(resolvedRoot, requestedPath), options); },
    write,
  };
}
