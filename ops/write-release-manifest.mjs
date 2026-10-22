#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { readReleaseInfo, releaseManifestName } from "../server/release-info.mjs";

const [sourceRoot, releaseRoot, releaseId] = process.argv.slice(2);
if (!sourceRoot || !releaseRoot || !/^[a-zA-Z0-9_-]{1,100}$/.test(releaseId || "")) {
  throw new Error("Expected source root, release root and release ID");
}
const { source } = readReleaseInfo(sourceRoot);
fs.writeFileSync(path.join(releaseRoot, releaseManifestName), JSON.stringify({
  schemaVersion: 1, source, releaseId, packagedAt: new Date().toISOString(),
}, null, 2) + "\n", { mode: 0o644 });
