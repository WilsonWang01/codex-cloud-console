import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listPersonalFiles, resolvePersonalFile } from "../server/personal-files.mjs";

test("personal file view lists material and output without exposing system paths", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-personal-files-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "codex-outside-files-"));
  try {
    await fs.mkdir(path.join(root, ".codex-cloud", "uploads", "2026-09-26"), { recursive: true });
    await fs.mkdir(path.join(root, "results"), { recursive: true });
    await fs.writeFile(path.join(root, ".codex-cloud", "uploads", "2026-09-26", "123-abcdef-notes.txt"), "input");
    await fs.writeFile(path.join(root, "results", "总结.md"), "result");
    await fs.writeFile(path.join(root, ".secret"), "hidden");
    await fs.writeFile(path.join(outside, "secret.txt"), "outside");
    await fs.symlink(path.join(outside, "secret.txt"), path.join(root, "results", "linked.txt"));
    await fs.symlink(path.join(root, ".secret"), path.join(root, "results", "hidden-link.txt"));
    const files = await listPersonalFiles(root);
    assert.equal(files.length, 2);
    assert.equal(files.find((file) => file.kind === "input")?.name, "notes.txt");
    assert.equal(files.find((file) => file.kind === "output")?.name, "总结.md");
    assert.equal((await resolvePersonalFile(root, "results/总结.md")).mimeType, "text/plain; charset=utf-8");
    for (const candidate of ["../secret.txt", ".secret", "results/linked.txt", "results/hidden-link.txt", ".codex-cloud/config.json"]) {
      await assert.rejects(resolvePersonalFile(root, candidate));
    }
    await assert.rejects(resolvePersonalFile(root, "results/总结.md", 1), /too large/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});
