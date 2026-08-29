import { createHash } from "node:crypto";

export function canonicalLfBytes(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
  return Buffer.from(bytes.toString("utf8").replace(/\r\n?/g, "\n"), "utf8");
}

export function canonicalTextSha256(value) {
  return createHash("sha256").update(canonicalLfBytes(value)).digest("hex");
}
