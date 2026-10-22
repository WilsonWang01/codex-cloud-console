import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

export const releaseManifestName = ".codex-cloud-release.json";

export function readReleaseInfo(root) {
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(path.join(root, releaseManifestName), "utf8")); } catch {}
  if (manifest?.schemaVersion !== 1) manifest = null;
  const source = { revision: null, branch: null, dirty: null };
  if (fs.existsSync(path.join(root, ".git"))) {
    const git = (...args) => execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8", timeout: 2_000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    try {
      source.revision = git("rev-parse", "HEAD");
      source.branch = git("branch", "--show-current") || null;
      source.dirty = Boolean(git("status", "--porcelain", "--untracked-files=normal"));
    } catch {}
  } else if (manifest?.schemaVersion === 1) {
    source.revision = manifest.source?.revision;
    source.branch = manifest.source?.branch;
    source.dirty = manifest.source?.dirty;
  }
  source.revision = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(source.revision || "") ? source.revision : null;
  source.branch = /^[a-zA-Z0-9_./-]{1,160}$/.test(source.branch || "") ? source.branch : null;
  source.dirty = typeof source.dirty === "boolean" ? source.dirty : null;
  const entrypoints = Object.fromEntries([
    "server/index.mjs", "scripts/local-cloud-console-proxy.mjs", "package-lock.json", "dist/index.html",
  ].map((name) => {
    try { return [name, createHash("sha256").update(fs.readFileSync(path.join(root, name))).digest("hex")]; }
    catch { return [name, null]; }
  }));
  return {
    schemaVersion: 1,
    source,
    releaseId: /^[a-zA-Z0-9_-]{1,100}$/.test(manifest?.releaseId || "") ? manifest.releaseId : null,
    packagedAt: manifest?.schemaVersion === 1 && Number.isFinite(Date.parse(manifest.packagedAt))
      ? new Date(manifest.packagedAt).toISOString() : null,
    observedAt: new Date().toISOString(),
    node: process.version,
    entrypoints,
  };
}
