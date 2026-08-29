import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep, win32 } from "node:path";
import { randomUUID } from "node:crypto";

const RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;
const DEFAULT_OPERATIONS = Object.freeze({ lstat, mkdir, readFile, realpath, rename, unlink, writeFile });
function fail(message) { throw new Error(`Invalid artifact path: ${message}`); }
function nonblank(value) { return typeof value === "string" && value.trim().length > 0; }
function samePath(left, right) { return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right; }
function contained(root, target) { const item = relative(root, target); return item !== "" && item !== ".." && !item.startsWith(`..${sep}`) && !isAbsolute(item); }
function validateRequestedPath(requestedPath) {
  if (!nonblank(requestedPath) || requestedPath.includes("\0") || isAbsolute(requestedPath) || win32.isAbsolute(requestedPath) || posix.isAbsolute(requestedPath) || /^[a-zA-Z]:/.test(requestedPath)) fail("path must be a nonblank relative path");
  const normalized = requestedPath.replace(/[\\/]+/g, sep); const components = normalized.split(sep);
  if (components.some((part) => !part || part === "." || part === ".." || part.includes(":") || /[. ]$/.test(part) || RESERVED.test(part))) fail("path contains a forbidden component");
  return components;
}
function operationsFor(overrides = {}) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides) || Object.getPrototypeOf(overrides) !== Object.prototype || Object.keys(overrides).some((key) => !Object.hasOwn(DEFAULT_OPERATIONS, key) || typeof overrides[key] !== "function")) throw new Error("Invalid artifact operations");
  return { ...DEFAULT_OPERATIONS, ...overrides };
}
function missing(error) { return error?.code === "ENOENT"; }
function validContent(content) { return typeof content === "string" || Buffer.isBuffer(content) || content instanceof Uint8Array; }
export function createArtifactStore(root, { operations: operationOverrides = {} } = {}) {
  if (!nonblank(root)) throw new Error("Invalid artifact root: root must be a nonblank path"); const configuredRoot = resolve(root); const operations = operationsFor(operationOverrides);
  async function canonicalRoot() {
    await operations.mkdir(configuredRoot, { recursive: true }); const stat = await operations.lstat(configuredRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("artifact root must be a real directory"); return operations.realpath(configuredRoot);
  }
  async function safeDirectory(path, rootPath, create) {
    let stat;
    try { stat = await operations.lstat(path); } catch (error) { if (!create || !missing(error)) throw error; await operations.mkdir(path); stat = await operations.lstat(path); }
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("path traverses a symlink or non-directory"); const actual = await operations.realpath(path);
    if (!contained(rootPath, actual) && !samePath(rootPath, actual)) fail("path escapes the artifact root"); return actual;
  }
  async function prepare(requestedPath, createParent) {
    const components = validateRequestedPath(requestedPath); const rootPath = await canonicalRoot(); let parent = rootPath;
    for (const component of components.slice(0, -1)) parent = await safeDirectory(join(parent, component), rootPath, createParent);
    return { rootPath, parent, target: join(parent, components.at(-1)) };
  }
  async function safeTarget(target, rootPath, required) {
    try {
      const stat = await operations.lstat(target); if (stat.isSymbolicLink() || stat.isDirectory()) fail("target must be a normal file"); const actual = await operations.realpath(target); if (!contained(rootPath, actual)) fail("target escapes the artifact root");
    } catch (error) { if (missing(error) && !required) return; throw error; }
  }
  async function cleanupTemporary(temporary, original) {
    try { await operations.unlink(temporary); } catch (error) { if (!missing(error)) { const cleanup = new Error("Artifact write failed and temporary cleanup failed"); cleanup.cause = original; throw cleanup; } }
  }
  async function write(requestedPath, content) {
    if (!validContent(content)) throw new Error("Artifact content must be a string or byte array"); const { rootPath, parent, target } = await prepare(requestedPath, true); await safeTarget(target, rootPath, false);
    const temporary = join(parent, `.${basename(target)}.${randomUUID()}.tmp`); if (dirname(temporary) !== parent) throw new Error("Artifact temporary path escaped its target directory");
    try { await operations.writeFile(temporary, content, { flag: "wx" }); await safeDirectory(parent, rootPath, false); await safeTarget(target, rootPath, false); await operations.rename(temporary, target); }
    catch (error) { await cleanupTemporary(temporary, error); throw error; }
    return target;
  }
  async function read(requestedPath, options = "utf8") { const { rootPath, target } = await prepare(requestedPath, false); await safeTarget(target, rootPath, true); return operations.readFile(target, options); }
  return { root: configuredRoot, pathFor(requestedPath) { const components = validateRequestedPath(requestedPath); const target = resolve(configuredRoot, ...components); if (!contained(configuredRoot, target)) fail("path escapes the artifact root"); return target; }, read, write };
}
