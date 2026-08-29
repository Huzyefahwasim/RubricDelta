import assert from "node:assert/strict";
import test from "node:test";
import { canonicalTextSha256 } from "../src/evaluation/evidence-hash.js";

test("canonical evidence hashes are identical for LF and CRLF text but change with content", () => {
  const lf = "{\n  \"benchmark\": \"v1\"\n}\n";
  const crlf = lf.replaceAll("\n", "\r\n");
  assert.equal(canonicalTextSha256(lf), canonicalTextSha256(Buffer.from(crlf, "utf8")));
  assert.notEqual(canonicalTextSha256(lf), canonicalTextSha256(lf.replace("v1", "v2")));
});
