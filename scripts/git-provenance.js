import { Buffer } from "node:buffer";

function nulRecords(source) {
  if (source === "") return [];
  if (typeof source !== "string" || !source.endsWith("\0")) return null;
  return source.slice(0, -1).split("\0");
}

export function isGitObjectId(value) {
  return typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
}

const FORBIDDEN_PORTABLE_SEGMENT = /[<>:"\\|?*\p{Cc}\p{Cf}\p{Cs}]/u;
const WINDOWS_DEVICE_BASENAME = /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com(?:[1-9]|[¹²³])|lpt(?:[1-9]|[¹²³]))$/iu;

function portableGitSegment(segment) {
  if (segment === "" || segment === "." || segment === "..") return false;
  if (segment !== segment.normalize("NFC") || segment.includes("\uFFFD")) return false;
  if (segment.length > 255 || Buffer.byteLength(segment, "utf8") > 255) return false;
  if (FORBIDDEN_PORTABLE_SEGMENT.test(segment) || /[. ]$/u.test(segment)) return false;
  return !WINDOWS_DEVICE_BASENAME.test(segment.split(".", 1)[0]);
}

export function portableGitPathSet(paths) {
  if (!Array.isArray(paths)) return false;
  const siblingsByParent = new Map();

  for (const path of paths) {
    if (typeof path !== "string" || path === "" || path.includes("\\")
      || path.startsWith("/") || path.endsWith("/")) return false;
    const segments = path.split("/");
    if (!segments.every(portableGitSegment)) return false;

    let parent = "";
    for (const segment of segments) {
      let siblings = siblingsByParent.get(parent);
      if (!siblings) {
        siblings = new Map();
        siblingsByParent.set(parent, siblings);
      }
      const identity = segment
        .normalize("NFC")
        .toUpperCase()
        .normalize("NFC")
        .toLowerCase()
        .normalize("NFC");
      const prior = siblings.get(identity);
      if (prior !== undefined && prior !== segment) return false;
      siblings.set(identity, segment);
      parent = parent === "" ? segment : `${parent}/${segment}`;
    }
  }

  return true;
}

export function parseGitStatus(source) {
  const records = nulRecords(source);
  if (!records) return null;
  const status = [];
  for (const record of records) {
    if (record.length < 4 || record[2] !== " ") return null;
    const path = record.slice(3);
    status.push({
      code: record.slice(0, 2),
      path,
    });
  }
  return portableGitPathSet(status.map((entry) => entry.path)) ? status : null;
}

export function parseGitIndexState(source) {
  const records = nulRecords(source);
  if (!records) return null;
  let hasNonDefaultFlags = false;
  const paths = [];
  for (const record of records) {
    if (record.length < 3 || record[1] !== " ") return null;
    const path = record.slice(2);
    paths.push(path);
    if (record[0] !== "H") hasNonDefaultFlags = true;
  }
  return portableGitPathSet(paths) ? { hasNonDefaultFlags, paths } : null;
}

export function parseGitPathList(source) {
  const paths = nulRecords(source);
  return paths && portableGitPathSet(paths) ? paths : null;
}

export function parseRawCommitChanges(source) {
  const fields = nulRecords(source);
  if (!fields || fields.length % 2 !== 0) return null;
  const entries = [];
  const metadataPattern = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])$/;
  for (let index = 0; index < fields.length; index += 2) {
    const match = metadataPattern.exec(fields[index]);
    const path = fields[index + 1];
    if (!match || !isGitObjectId(match[3]) || !isGitObjectId(match[4])) return null;
    entries.push({
      oldMode: match[1],
      newMode: match[2],
      status: match[5],
      path,
    });
  }
  return portableGitPathSet(entries.map((entry) => entry.path)) ? entries : null;
}
