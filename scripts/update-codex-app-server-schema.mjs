#!/usr/bin/env node
/**
 * Regenerate checked-in Codex app-server TypeScript schema.
 *
 * Adapted from Yep Anywhere's MIT-licensed `scripts/update-codex-protocol.mjs`.
 * Original project: https://github.com/kzahel/yepanywhere
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const schemaRoot = join(repoRoot, "src/generated/app-server");
const defaultCodexSchemaVersion = "0.135.0";

function parseMode(argv) {
  return argv.includes("--check") ? "check" : "update";
}

function runCodexGenerate(outDir) {
  const schemaVersion = process.env.CODEX_SCHEMA_CLI_VERSION || defaultCodexSchemaVersion;
  const candidates = [
    { command: "npx", args: ["-y", `@openai/codex@${schemaVersion}`, "app-server", "generate-ts", "--out", outDir] },
  ];
  if (process.env.CODEX_SCHEMA_ALLOW_GLOBAL === "1") {
    candidates.push({ command: "codex", args: ["app-server", "generate-ts", "--out", outDir] });
  }

  const errors = [];
  for (const candidate of candidates) {
    const result = spawnSync(candidate.command, candidate.args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status === 0) {
      const stderr = result.stderr?.trim();
      if (stderr) console.warn(stderr);
      return;
    }
    errors.push(
      [
        `$ ${candidate.command} ${candidate.args.join(" ")}`,
        result.stdout?.trim(),
        result.stderr?.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  throw new Error(`Unable to generate Codex app-server schema.\n\n${errors.join("\n\n")}`);
}

function listFilesRecursively(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".DS_Store" || entry.name.startsWith("._")) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        files.push(relative(root, fullPath));
      }
    }
  };
  if (existsSync(root)) walk(root);
  return files.sort();
}

function snapshotDir(root) {
  const snapshot = new Map();
  for (const relPath of listFilesRecursively(root)) {
    snapshot.set(relPath, readFileSync(join(root, relPath), "utf8"));
  }
  return snapshot;
}

function diffSnapshots(current, generated) {
  const added = [];
  const removed = [];
  const changed = [];

  for (const [file, content] of generated) {
    if (!current.has(file)) added.push(file);
    else if (current.get(file) !== content) changed.push(file);
  }
  for (const file of current.keys()) {
    if (!generated.has(file)) removed.push(file);
  }
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
}

function printDiff(diff) {
  for (const file of diff.added) console.log(`  + ${file}`);
  for (const file of diff.removed) console.log(`  - ${file}`);
  for (const file of diff.changed) console.log(`  ~ ${file}`);
}

function copyGenerated(source, destination) {
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  for (const relPath of listFilesRecursively(source)) {
    const sourcePath = join(source, relPath);
    const destinationPath = join(destination, relPath);
    mkdirSync(dirname(destinationPath), { recursive: true });
    writeFileSync(destinationPath, readFileSync(sourcePath, "utf8"), "utf8");
  }
}

function main() {
  const mode = parseMode(process.argv.slice(2));
  const tempRoot = mkdtempSync(join(tmpdir(), "codex-app-server-schema-"));
  const generatedRoot = join(tempRoot, "types");

  try {
    mkdirSync(generatedRoot, { recursive: true });
    runCodexGenerate(generatedRoot);

    if (mode === "check") {
      const diff = diffSnapshots(snapshotDir(schemaRoot), snapshotDir(generatedRoot));
      const hasDiff = diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0;
      if (hasDiff) {
        console.error("Codex app-server schema is out of date.");
        printDiff(diff);
        console.error("Run `npm run codex:schema` to refresh.");
        process.exit(1);
      }
      console.log("Codex app-server schema is up to date.");
      return;
    }

    copyGenerated(generatedRoot, schemaRoot);
    console.log(`Updated ${listFilesRecursively(schemaRoot).length} Codex app-server schema files.`);
    console.log(`Output: ${relative(repoRoot, schemaRoot)}`);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

main();
