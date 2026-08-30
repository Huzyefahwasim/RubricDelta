import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
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

function fixture(t) {
  const destination = join(mkdtempSync(join(tmpdir(), "rubricdelta-canonical-validator-")), "repo");
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

function write(project, relativePath, value) {
  const path = join(project, ...relativePath.split("/"));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

function writeJson(project, relativePath, value) {
  write(project, relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(project, relativePath) {
  return JSON.parse(readFileSync(join(project, ...relativePath.split("/")), "utf8"));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function run(project) {
  return spawnSync(process.execPath, [validator, "--mode", "final-strict", "--root", project], {
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

function output(command) {
  return `${command.stdout ?? ""}\n${command.stderr ?? ""}`;
}

function failLines(command) {
  return output(command).split(/\r?\n/).filter((line) => line.startsWith("[FAIL]")).join("\n");
}

function passLines(command) {
  return output(command).split(/\r?\n/).filter((line) => line.startsWith("[PASS]")).join("\n");
}

function box(type, ...payloads) {
  const payload = Buffer.concat(payloads);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(header.length + payload.length, 0);
  header.write(type, 4, "ascii");
  return Buffer.concat([header, payload]);
}

function superficialVideoWithGarbageSamples() {
  const ftyp = box("ftyp", Buffer.from("isom", "ascii"), Buffer.alloc(4));
  const mvhd = Buffer.alloc(20);
  mvhd.writeUInt32BE(1_000, 12);
  mvhd.writeUInt32BE(1_000, 16);
  const hdlr = Buffer.alloc(12);
  hdlr.write("vide", 8, "ascii");

  const sampleEntry = Buffer.alloc(86);
  sampleEntry.writeUInt32BE(95, 0);
  sampleEntry.write("avc1", 4, "ascii");
  sampleEntry.writeUInt16BE(320, 32);
  sampleEntry.writeUInt16BE(180, 34);
  const config = box("avcC", Buffer.from([1]));
  const stsdHeader = Buffer.alloc(8);
  stsdHeader.writeUInt32BE(1, 4);
  const stsd = box("stsd", stsdHeader, sampleEntry, config);

  const sttsPayload = Buffer.alloc(16);
  sttsPayload.writeUInt32BE(1, 4);
  sttsPayload.writeUInt32BE(1, 8);
  sttsPayload.writeUInt32BE(1_000, 12);
  const stscPayload = Buffer.alloc(20);
  stscPayload.writeUInt32BE(1, 4);
  stscPayload.writeUInt32BE(1, 8);
  stscPayload.writeUInt32BE(1, 12);
  stscPayload.writeUInt32BE(1, 16);
  const stszPayload = Buffer.alloc(12);
  stszPayload.writeUInt32BE(1_024, 4);
  stszPayload.writeUInt32BE(1, 8);
  const stcoPayload = Buffer.alloc(12);
  stcoPayload.writeUInt32BE(1, 4);
  stcoPayload.writeUInt32BE(1, 8);

  const stbl = box("stbl", stsd, box("stts", sttsPayload), box("stsc", stscPayload), box("stsz", stszPayload), box("stco", stcoPayload));
  const mdia = box("mdia", box("hdlr", hdlr), box("minf", stbl));
  const moov = box("moov", box("mvhd", mvhd), box("trak", box("tkhd"), mdia));
  const value = Buffer.concat([ftyp, moov, box("mdat", Buffer.alloc(1_024, 0x41))]);
  const stcoTypeOffset = value.indexOf(Buffer.from("stco", "ascii"));
  value.writeUInt32BE(ftyp.length + moov.length + 8, stcoTypeOffset + 12);
  return value;
}

test("final release revision must equal the deterministic source revision", (t) => {
  const project = fixture(t);
  const manifest = readJson(project, "artifacts/evaluation/manifest.json");
  manifest.git = { ...(manifest.git ?? {}), revision: "1".repeat(40) };
  writeJson(project, "artifacts/evaluation/manifest.json", manifest);
  writeJson(project, "artifacts/qa/release.json", {
    schemaVersion: 1,
    artifactKind: "rubricdelta-release-qa",
    revision: "2".repeat(40),
    categories: {},
    commands: [],
  });

  const command = run(project);
  assert.notEqual(command.status, 0, output(command));
  assert.match(failLines(command), /RELEASE QA.*revision.*(?:deterministic|manifest)|revision.*manifest\.git/i);
  assert.doesNotMatch(passLines(command), /release QA|Git provenance/i);
});

test("development trajectory cannot traverse outside its dedicated evidence root", (t) => {
  const project = fixture(t);
  const target = "artifacts/representative-trajectories/validator-outside.jsonl";
  const bytes = Buffer.from(`${JSON.stringify({ sequence: 1, type: "instruction" })}\n`);
  write(project, target, bytes);
  writeJson(project, "artifacts/development-agent/manifest.json", {
    schemaVersion: 1,
    artifactKind: "rubricdelta-development-agent-evidence",
    privacyReview: {
      status: "PASS",
      reviewer: { kind: "participant" },
      reviewedAt: "2026-08-30T00:00:00.000Z",
      sourceSha256: sha256(bytes),
    },
    source: "codex-export",
    agent: "codex",
    runId: "validator-codex-run",
    eventCount: 5,
    trajectoryPath: "artifacts/development-agent/../representative-trajectories/validator-outside.jsonl",
    trajectorySha256: sha256(bytes),
  });

  const command = run(project);
  assert.notEqual(command.status, 0, output(command));
  assert.match(failLines(command), /DEVELOPMENT TRAJECTORY.*(?:canonical|contain|escape|dedicated)/i);
  assert.doesNotMatch(passLines(command), /development-agent trajectory/i);
});

test("plausible MP4 tables cannot point at headers or unrelated garbage", (t) => {
  const project = fixture(t);
  write(project, "artifacts/submission/demo.mp4", superficialVideoWithGarbageSamples());

  const command = run(project);
  assert.notEqual(command.status, 0, output(command));
  assert.match(failLines(command), /INVALID VIDEO.*(?:sample|chunk|offset|range|media)/i);
  assert.doesNotMatch(passLines(command), /validated .* video/i);
});

test("QA categories require unique category-specific structured PASS files", (t) => {
  const project = fixture(t);
  write(project, "artifacts/qa/README.md", `# Release QA\n\n${"Release evidence passed browser, keyboard, accessibility, responsive, security, clean checkout, human review, video, and automated checks. ".repeat(4)}\n`);
  const evidence = Buffer.from('{"status":"NOT RUN"}\n');
  write(project, "artifacts/qa/shared.json", evidence);
  const revision = "a".repeat(40);
  const categories = Object.fromEntries([
    "automated", "browser", "keyboard", "accessibility", "responsive", "security",
    "cleanCheckout", "humanReview", "video", "developmentAgent", "release",
  ].map((category) => [category, {
    status: "PASS",
    revision,
    evidencePath: "artifacts/qa/shared.json",
    evidenceSha256: sha256(evidence),
  }]));
  writeJson(project, "artifacts/qa/release.json", {
    schemaVersion: 1,
    artifactKind: "rubricdelta-release-qa",
    revision,
    categories,
    commands: [],
    decision: { value: "approve release", actor: "participant" },
  });

  const command = run(project);
  assert.notEqual(command.status, 0, output(command));
  assert.match(failLines(command), /RELEASE QA.*(?:category-specific|unique|structured category|NOT RUN)/i);
  assert.doesNotMatch(passLines(command), /structured release QA/i);
});
