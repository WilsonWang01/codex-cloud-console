import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPersonalFileBridgeServer, personalFileBridgeJson, personalFileBridgeStream } from "../server/personal-file-bridge.mjs";

test("dedicated file bridge keeps uploads and outputs inside the personal workspace", async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-personal-bridge-"));
  const root = path.join(temp, "workspace");
  const socketPath = path.join(temp, "files.sock");
  await fs.mkdir(path.join(root, "results"), { recursive: true });
  await fs.writeFile(path.join(root, "results", "summary.md"), "verified result");
  await fs.writeFile(path.join(root, ".secret"), "private");
  await fs.symlink(path.join(root, ".secret"), path.join(root, "results", "linked.txt"));
  const bridge = createPersonalFileBridgeServer({ root, socketPath, maxBytes: 1024 });
  t.after(async () => { await bridge.close(); await fs.rm(temp, { recursive: true, force: true }); });
  await assert.rejects(personalFileBridgeJson(socketPath, "GET", "/files"), { statusCode: 503 });
  await bridge.listen();
  await assert.rejects(personalFileBridgeJson(socketPath, "POST", "/uploads", {
    name: "too-large.txt", mimeType: "text/plain", dataBase64: Buffer.alloc(1025).toString("base64"),
  }), { statusCode: 413 });
  const uploaded = await personalFileBridgeJson(socketPath, "POST", "/uploads", {
    name: "notes.txt", mimeType: "text/plain", dataBase64: Buffer.from("user supplied").toString("base64"),
  });
  assert.match(uploaded.file.path, /^\.codex-cloud\/uploads\/\d{4}-\d{2}-\d{2}\//);
  assert.equal(await fs.readFile(path.join(root, uploaded.file.path), "utf8"), "user supplied");
  const listed = await personalFileBridgeJson(socketPath, "GET", "/files");
  assert.equal(listed.files.some((file) => file.path === uploaded.file.path && file.kind === "input"), true);
  assert.equal(listed.files.some((file) => file.path === "results/summary.md" && file.kind === "output"), true);
  assert.equal(listed.files.some((file) => file.name === ".secret" || file.name === "linked.txt"), false);
  const content = await personalFileBridgeStream(socketPath, "GET", `/files/content?path=${encodeURIComponent(uploaded.file.path)}&preview=1`);
  assert.equal(content.statusCode, 200);
  assert.match(String(content.headers["content-disposition"]), /^inline;/);
  const chunks = [];
  for await (const chunk of content) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), "user supplied");
  assert.deepEqual(await personalFileBridgeJson(socketPath, "POST", "/validate", { path: uploaded.file.path }), { ok: true });
  await assert.rejects(personalFileBridgeJson(socketPath, "POST", "/validate", { path: "results/linked.txt" }), { statusCode: 403 });
  await assert.rejects(personalFileBridgeJson(socketPath, "GET", `/files/content?path=${encodeURIComponent("results/linked.txt")}`), { statusCode: 403 });
  await assert.rejects(personalFileBridgeJson(socketPath, "GET", `/files/content?path=${encodeURIComponent("../outside")}`), { statusCode: 400 });
  await assert.rejects(personalFileBridgeJson(socketPath, "GET", `/files/content?path=${encodeURIComponent(".secret")}`), { statusCode: 400 });
  await personalFileBridgeJson(socketPath, "DELETE", `/uploads?path=${encodeURIComponent(uploaded.file.path)}`);
  await assert.rejects(fs.stat(path.join(root, uploaded.file.path)), { code: "ENOENT" });
  const oldLargePath = `${path.dirname(uploaded.file.path)}/old-large.txt`;
  await fs.mkdir(path.join(root, path.dirname(oldLargePath)), { recursive: true });
  await fs.writeFile(path.join(root, oldLargePath), Buffer.alloc(2048));
  await assert.rejects(personalFileBridgeJson(socketPath, "GET", `/files/content?path=${encodeURIComponent(oldLargePath)}`), { statusCode: 413 });
  await personalFileBridgeJson(socketPath, "DELETE", `/uploads?path=${encodeURIComponent(oldLargePath)}`);
  await assert.rejects(fs.stat(path.join(root, oldLargePath)), { code: "ENOENT" });
  await assert.rejects(personalFileBridgeJson(socketPath, "DELETE", "/uploads?path=results%2Fsummary.md"), { statusCode: 400 });
  assert.equal(await fs.readFile(path.join(root, "results", "summary.md"), "utf8"), "verified result");
});
