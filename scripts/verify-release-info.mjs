import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readReleaseInfo, releaseManifestName } from "../server/release-info.mjs";

test("release snapshots distinguish clean, dirty and packaged code without private data", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-release-"));
  try {
    fs.mkdirSync(path.join(root, "server"));
    fs.writeFileSync(path.join(root, "server/index.mjs"), "original\n");
    const git = (...args) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
    git("init", "-q");
    git("add", ".");
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture");
    const clean = readReleaseInfo(root);
    assert.equal(clean.source.dirty, false);
    assert.match(clean.source.revision, /^[a-f0-9]{40,64}$/);
    assert.match(clean.entrypoints["server/index.mjs"], /^[a-f0-9]{64}$/);
    assert.equal(clean.entrypoints["dist/index.html"], null);
    fs.writeFileSync(path.join(root, "server/index.mjs"), "changed\n");
    fs.writeFileSync(path.join(root, "PRIVATE-TOKEN"), "PRIVATE-CONTENT");
    const dirty = readReleaseInfo(root);
    assert.equal(dirty.source.dirty, true);
    assert.notEqual(dirty.entrypoints["server/index.mjs"], clean.entrypoints["server/index.mjs"]);
    assert.equal(clean.source.dirty, false, "previous snapshots remain unchanged");
    assert.equal(JSON.stringify(dirty).includes(root), false);
    assert.doesNotMatch(JSON.stringify(dirty), /PRIVATE-TOKEN|PRIVATE-CONTENT/);
    const packaged = path.join(root, "packaged");
    fs.mkdirSync(packaged);
    execFileSync(process.execPath, [fileURLToPath(new URL("../ops/write-release-manifest.mjs", import.meta.url)), root, packaged, "test-release"]);
    const release = readReleaseInfo(packaged);
    assert.deepEqual(release.source, dirty.source);
    assert.equal(release.releaseId, "test-release");
    assert.ok(release.packagedAt);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("old exports and invalid manifests remain explicitly unknown", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-release-unknown-"));
  try {
    assert.deepEqual(readReleaseInfo(root).source, { revision: null, branch: null, dirty: null });
    fs.writeFileSync(path.join(root, releaseManifestName), "{broken");
    assert.equal(readReleaseInfo(root).releaseId, null);
    fs.writeFileSync(path.join(root, releaseManifestName), JSON.stringify({ schemaVersion: 2, releaseId: "future-release" }));
    assert.equal(readReleaseInfo(root).releaseId, null, "unknown manifest schemas are not interpreted");
    fs.writeFileSync(path.join(root, releaseManifestName), JSON.stringify({
      schemaVersion: 1, source: { revision: "/private/path", branch: "SECRET\nCONTENT", dirty: "false" },
      releaseId: "/private/path", packagedAt: "not-a-date", token: "PRIVATE-TOKEN",
    }));
    const info = readReleaseInfo(root);
    assert.deepEqual(info.source, { revision: null, branch: null, dirty: null });
    assert.equal(info.releaseId, null);
    assert.equal(info.packagedAt, null);
    assert.doesNotMatch(JSON.stringify(info), /PRIVATE-TOKEN|private|SECRET/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
