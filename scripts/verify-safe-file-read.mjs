import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { readRootedFile } from "../server/safe-file-read.mjs";

async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "rooted-read-"));
  const root = path.join(temp, "workspace");
  const outside = path.join(temp, "outside");
  await fs.mkdir(path.join(root, "results"), { recursive: true });
  await fs.mkdir(outside);
  await fs.writeFile(path.join(root, "results/report.txt"), "inside");
  await fs.writeFile(path.join(outside, "report.txt"), "SECRET");
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  return { temp, root, outside };
}

test("rooted read keeps exact bytes, supports trusted root aliases and enforces limits", async t => {
  const { root, temp } = await fixture(t);
  const result = await readRootedFile(root, "results\\report.txt", 6);
  assert.equal(result.buffer.toString(), "inside");
  assert.equal(result.stat.size, 6);
  assert.equal(result.relativePath, "results/report.txt");
  assert.ok(result.stat.mtime instanceof Date);
  await fs.symlink(root, path.join(temp, "root-alias"));
  assert.equal((await readRootedFile(path.join(temp, "root-alias"), "results/report.txt", 6)).buffer.toString(), "inside");
  await fs.writeFile(path.join(root, "empty"), "");
  assert.equal((await readRootedFile(root, "empty", 0)).buffer.length, 0);
  await assert.rejects(readRootedFile(root, "results/report.txt", 5), { statusCode: 413, code: "file_too_large" });
  for (const limit of [-1, Infinity, NaN, 2.5, Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(readRootedFile(root, "empty", limit), RangeError);
  for (const value of ["", "/results/report.txt", "../outside/report.txt", "results/../report.txt", "./empty", "results//report.txt", "C:/report.txt", "C:\\report.txt", "results/report.txt\0", "results/\nreport.txt", "x".repeat(4097), Array(65).fill("dir").join("/"), {}, null]) {
    await assert.rejects(readRootedFile(root, value, 10), { statusCode: 400 });
  }
  await assert.rejects(readRootedFile(root, "missing", 10), { statusCode: 404 });
  await assert.rejects(readRootedFile(root, "results", 10), { statusCode: 403 });
});

test("replacement with a FIFO between lstat and open cannot block the reader", { timeout: 5000 }, async t => {
  const { root } = await fixture(t);
  const targetFile = path.join(root, "results/report.txt");
  const open = fs.open;
  fs.open = async function (target, ...args) {
    if (String(target).endsWith("/report.txt")) {
      await fs.rename(targetFile, `${targetFile}.original`);
      await promisify(execFile)("mkfifo", [targetFile]);
    }
    return open.call(this, target, ...args);
  };
  try { await assert.rejects(readRootedFile(root, "results/report.txt", 10), { statusCode: 409 }); }
  finally { fs.open = open; }
});

test("rooted read refuses internal and external symlinks, hard links and FIFO files", async t => {
  const { root, outside } = await fixture(t);
  await fs.symlink(path.join(outside, "report.txt"), path.join(root, "external"));
  await fs.symlink(path.join(root, "results/report.txt"), path.join(root, "internal"));
  await fs.symlink(outside, path.join(root, "external-dir"));
  await fs.symlink(path.join(root, "results"), path.join(root, "internal-dir"));
  await fs.symlink(path.join(outside, "missing"), path.join(root, "dangling"));
  await fs.link(path.join(outside, "report.txt"), path.join(root, "hardlink"));
  await promisify(execFile)("mkfifo", [path.join(root, "fifo")]);
  for (const value of ["external", "internal", "external-dir/report.txt", "internal-dir/report.txt", "dangling", "hardlink", "fifo"]) {
    await assert.rejects(readRootedFile(root, value, 10), { statusCode: 403 });
  }
  assert.equal(await fs.readFile(path.join(outside, "report.txt"), "utf8"), "SECRET");
});

test("parent replacement between validation and open cannot read outside bytes", async t => {
  const { root, outside } = await fixture(t);
  const open = fs.open;
  let replaced = false;
  let reads = 0;
  fs.open = async function (target, flags, ...rest) {
    if (String(target).endsWith("/report.txt")) {
      await fs.rename(path.join(root, "results"), path.join(root, "held-results"));
      await fs.symlink(outside, path.join(root, "results"));
      replaced = true;
    }
    const handle = await open.call(this, target, flags, ...rest);
    const read = handle.read;
    handle.read = function (...args) { reads++; return read.apply(this, args); };
    return handle;
  };
  try {
    await assert.rejects(readRootedFile(root, "results/report.txt", 10), { statusCode: 409 });
    assert.equal(replaced, true);
    assert.equal(reads, 0, "no bytes may be read before the opened path is verified");
  } finally { fs.open = open; }
});

test("leaf replacement between lstat and open is rejected before reading", async t => {
  const { root } = await fixture(t);
  const targetFile = path.join(root, "results/report.txt");
  const open = fs.open;
  let reads = 0;
  fs.open = async function (target, ...args) {
    if (String(target).endsWith("/report.txt")) {
      await fs.rename(targetFile, `${targetFile}.original`);
      await fs.writeFile(targetFile, "CHANGE");
    }
    const handle = await open.call(this, target, ...args);
    const read = handle.read;
    handle.read = function (...readArgs) { reads++; return read.apply(this, readArgs); };
    return handle;
  };
  try {
    await assert.rejects(readRootedFile(root, "results/report.txt", 10), { statusCode: 409 });
    assert.equal(reads, 0);
  } finally { fs.open = open; }
});

test("same-size mutation, truncation and rename during read fail before a buffer is returned", async t => {
  const { root } = await fixture(t);
  const targetFile = path.join(root, "results/report.txt");
  for (const mutate of [
    () => fs.writeFile(targetFile, "CHANGE"),
    () => fs.truncate(targetFile, 0),
    () => fs.rename(targetFile, `${targetFile}.moved`),
    async () => { await fs.rename(path.join(root, "results"), path.join(root, "moved")); },
  ]) {
    await fs.mkdir(path.dirname(targetFile), { recursive: true });
    await fs.writeFile(targetFile, "inside");
    const open = fs.open;
    let opened = 0;
    let closed = 0;
    fs.open = async function (...args) {
      const handle = await open.apply(this, args);
      opened++;
      const close = handle.close;
      handle.close = async function () { try { return await close.call(this); } finally { closed++; } };
      if (String(args[0]).endsWith("/report.txt")) {
        const read = handle.read;
        handle.read = async function (...readArgs) {
          const result = await read.apply(this, readArgs);
          await mutate();
          return result;
        };
      }
      return handle;
    };
    try {
      await assert.rejects(readRootedFile(root, "results/report.txt", 10), err => [404, 409].includes(err.statusCode));
      assert.equal(closed, opened, "every directory and file descriptor must close on failure");
    } finally { fs.open = open; }
  }
});

test("errors never expose an absolute private filename", async t => {
  const { root } = await fixture(t);
  try { await readRootedFile(root, "does-not-exist", 1); assert.fail("expected failure"); }
  catch (error) {
    assert.equal(error.statusCode, 404);
    assert.equal(error.message.includes(root), false);
    assert.equal(error.path, undefined);
  }
});
