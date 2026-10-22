import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listPersonalFiles, readPersonalFile, resolvePersonalFile, sendPersonalFile } from "../server/personal-files.mjs";

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
    const result = await readPersonalFile(root, "results/总结.md");
    assert.equal(result.buffer.toString(), "result");
    assert.equal(result.mimeType, "text/plain; charset=utf-8");
    assert.equal(result.input, false);
    for (const candidate of ["../secret.txt", ".secret", "results/linked.txt", "results/hidden-link.txt", ".codex-cloud/config.json"]) {
      await assert.rejects(resolvePersonalFile(root, candidate));
      await assert.rejects(readPersonalFile(root, candidate));
    }
    await assert.rejects(resolvePersonalFile(root, "results/总结.md", 1), /too large/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("a disconnected download retains its slot until the pending file read settles", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "personal-disconnect-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "result.md"), "result");
  const response = () => Object.assign(new EventEmitter(), { destroyed: false, setHeader() {}, end() { assert.fail("closed responses cannot send a body"); } });
  const open = fs.open;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  fs.open = async function (...args) { await gate; return open.apply(this, args); };
  const first = response();
  const second = response();
  const a = sendPersonalFile(first, root, "result.md");
  const b = sendPersonalFile(second, root, "result.md");
  first.destroyed = second.destroyed = true;
  first.emit("close");
  second.emit("close");
  try { await assert.rejects(sendPersonalFile(response(), root, "result.md"), { statusCode: 503 }); }
  finally { release(); await Promise.all([a, b]); fs.open = open; }
});

test("buffered personal downloads are limited until the response finishes, closes or fails", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "personal-response-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "result.md"), "result");
  const response = () => Object.assign(new EventEmitter(), {
    headers: {}, destroyed: false,
    setHeader(name, value) { this.headers[name] = value; },
    end(buffer) { this.buffer = buffer; this.emit("ended"); },
  });
  const first = response();
  const second = response();
  const firstEnded = new Promise(resolve => first.once("ended", resolve));
  const secondEnded = new Promise(resolve => second.once("ended", resolve));
  const a = sendPersonalFile(first, root, "result.md");
  const b = sendPersonalFile(second, root, "result.md");
  try {
    await Promise.all([firstEnded, secondEnded]);
    assert.equal(first.buffer.toString(), "result");
    const busy = response();
    await assert.rejects(sendPersonalFile(busy, root, "result.md"), { statusCode: 503 });
    assert.equal(busy.headers["Retry-After"], "1");
    first.emit("finish");
    await a;
    assert.equal(first.listenerCount("close"), 0);
    await assert.rejects(sendPersonalFile(response(), root, "missing.md"), { statusCode: 404 });
    const closed = response();
    closed.destroyed = true;
    await sendPersonalFile(closed, root, "result.md");
    assert.equal(closed.buffer, undefined);
  } finally {
    first.emit("close");
    second.emit("close");
    await Promise.all([a, b]);
  }
  const available = response();
  available.end = function (buffer) { this.buffer = buffer; this.emit("finish"); };
  await sendPersonalFile(available, root, "result.md", { preview: true });
  assert.equal(available.headers["Content-Type"], "text/plain; charset=utf-8");
  assert.equal(available.listenerCount("finish"), 0);
});

test("a stalled personal response closes at its deadline and releases its slot", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "personal-slow-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "result.md"), "result");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let ended;
  const sent = new Promise(resolve => { ended = resolve; });
  const response = Object.assign(new EventEmitter(), {
    destroyed: false, setHeader() {}, end() { ended(); },
    destroy() { this.destroyed = true; this.emit("close"); },
  });
  const task = sendPersonalFile(response, root, "result.md");
  await sent;
  t.mock.timers.tick(120_000);
  await task;
  assert.equal(response.destroyed, true);
  assert.equal(response.listenerCount("close"), 0);
});
