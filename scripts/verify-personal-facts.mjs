import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import test from "node:test";
import { createPersonalFactsStore } from "../server/personal-facts.mjs";
import { personalDeveloperInstructions } from "../server/personal-runtime.mjs";

test("explicit personal facts can be corrected and removed from new task context", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-personal-facts-"));
  try {
    const store = createPersonalFactsStore(path.join(root, "state", "facts.json"));
    const fact = await store.create({ label: "称呼", value: "小王" });
    assert.equal(fact.source, "user");
    assert.match(personalDeveloperInstructions({ sandbox: "read-only" }, await store.list()), /小王/);
    const corrected = await store.update(fact.id, { label: "称呼", value: "小李", revision: fact.revision });
    const updated = personalDeveloperInstructions({ sandbox: "read-only" }, await store.list());
    assert.match(updated, /小李/);
    assert.doesNotMatch(updated, /小王/);
    await store.remove(fact.id, { revision: corrected.revision });
    assert.doesNotMatch(personalDeveloperInstructions({ sandbox: "read-only" }, await store.list()), /小李/);
    await assert.rejects(store.create({ label: "", value: "bad" }));
    assert.deepEqual(await store.list(), []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("personal fact revisions reject stale edits and deletion across restart", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-personal-facts-revisions-"));
  try {
    const file = path.join(root, "facts.json");
    const store = createPersonalFactsStore(file);
    const fact = await store.create({ label: "出行偏好", value: "火车" });
    const mutations = await Promise.allSettled([
      store.update(fact.id, { label: "出行偏好", value: "高铁", revision: 1 }),
      store.update(fact.id, { label: "出行偏好", value: "飞机", revision: 1 }),
      store.remove(fact.id, { revision: 1 }),
    ]);
    assert.equal(mutations[0].status, "fulfilled");
    for (const result of mutations.slice(1)) { assert.equal(result.status, "rejected"); assert.equal(result.reason.statusCode, 409); }
    const restored = createPersonalFactsStore(file);
    assert.deepEqual((await restored.list()).map(({ value, revision }) => ({ value, revision })), [{ value: "高铁", revision: 2 }]);
    const saved = await fs.readFile(file, "utf8");
    for (const revision of [undefined, 1, "2", null, 0, 1.5]) {
      await assert.rejects(restored.update(fact.id, { label: "出行偏好", value: "陈旧内容", revision }), (error) => error.statusCode === (revision === undefined ? 428 : revision === 1 ? 409 : 400));
      await assert.rejects(restored.remove(fact.id, { revision }));
    }
    assert.equal(await fs.readFile(file, "utf8"), saved);
    await assert.rejects(restored.update(fact.id, { label: "", value: "新内容", revision: 2 }));
    assert.equal(await fs.readFile(file, "utf8"), saved);
    const corrected = await restored.update(fact.id, { label: "出行偏好", value: "步行", revision: 2 });
    assert.equal(corrected.revision, 3);
    await restored.remove(fact.id, { revision: 3 });
    await assert.rejects(restored.update(fact.id, { label: "出行偏好", value: "旧事实", revision: 3 }), (error) => error.statusCode === 404);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("legacy facts acquire revisions only on a successful write; malformed storage is never replaced", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-personal-facts-legacy-"));
  try {
    const file = path.join(root, "facts.json");
    const legacy = { id: "legacy", label: "称呼", value: "小王", source: "user", createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z", customMetadata: { retained: true } };
    const original = JSON.stringify({ version: 1, facts: [legacy] });
    await fs.writeFile(file, original);
    const store = createPersonalFactsStore(file);
    assert.equal((await store.list())[0].revision, 1);
    assert.equal(await fs.readFile(file, "utf8"), original);
    await assert.rejects(store.remove("legacy"), (error) => error.statusCode === 428);
    assert.equal(await fs.readFile(file, "utf8"), original);
    const updated = await store.update("legacy", { label: "称呼", value: "小李", revision: 1 });
    assert.equal(updated.revision, 2);
    assert.equal(updated.createdAt, legacy.createdAt);
    assert.deepEqual(updated.customMetadata, legacy.customMetadata);
    for (const contents of ["{", JSON.stringify({ facts: [] }), JSON.stringify({ version: 1, facts: [legacy, legacy] }), JSON.stringify({ version: 1, facts: [{ ...legacy, revision: "1" }] }), JSON.stringify({ version: 1, facts: [{ ...legacy, revision: null }] })]) {
      await fs.writeFile(file, contents);
      await assert.rejects(store.create({ label: "不能覆盖", value: "原数据" }));
      assert.equal(await fs.readFile(file, "utf8"), contents);
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("personal fact HTTP mutations require the observed revision and preserve data on rejected requests", { timeout: 20_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-personal-facts-api-"));
  const state = path.join(root, "state");
  const work = path.join(root, "work");
  await fs.mkdir(work);
  const port = await new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => { const port = listener.address().port; listener.close(() => resolve(port)); });
  });
  let logs = "";
  const server = spawn(process.execPath, [new URL("../server/index.mjs", import.meta.url).pathname], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH, HOME: root, NODE_ENV: "production", HOST: "127.0.0.1", PORT: String(port),
      CODEX_CLOUD_ROOT: root, CODEX_STATE_ROOT: state, CODEX_HOME: path.join(root, "codex-home"),
      CODEX_PERSONAL_MODE: "shared", CODEX_PERSONAL_ROOT: path.join(root, "personal"),
      CODEX_CLOUD_REPOS_CONFIG_B64: Buffer.from(JSON.stringify([{ id: "work", name: "work", path: work }])).toString("base64") },
  });
  server.stdout.on("data", (chunk) => { logs += chunk; });
  server.stderr.on("data", (chunk) => { logs += chunk; });
  const request = async (route, method = "GET", body) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/personal/facts${route}`, {
      method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    for (let attempt = 0; attempt < 100 && !logs.includes("listening on"); attempt += 1) {
      if (server.exitCode !== null) throw new Error(logs);
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.match(logs, /listening on/);
    const created = await request("", "POST", { label: "习惯", value: "早睡" });
    assert.equal(created.status, 201);
    assert.equal(created.body.fact.revision, 1);
    const route = `/${created.body.fact.id}`;
    const changed = await request(route, "PATCH", { label: "习惯", value: "早起", revision: 1 });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.fact.revision, 2);
    const contents = await fs.readFile(path.join(state, "personal-facts.json"), "utf8");
    assert.equal((await request(route, "PATCH", { label: "习惯", value: "晚睡", revision: 1 })).status, 409);
    assert.equal((await request(route, "DELETE", { revision: 1 })).status, 409);
    assert.equal((await request(route, "DELETE")).status, 428);
    assert.equal((await request(route, "PATCH", { label: "习惯", value: "晚睡" })).status, 428);
    assert.equal(await fs.readFile(path.join(state, "personal-facts.json"), "utf8"), contents);
    assert.equal((await request("")).body.facts[0].value, "早起");
    assert.equal((await request(route, "DELETE", { revision: 2 })).status, 200);
    assert.equal((await request(route, "PATCH", { label: "习惯", value: "复活", revision: 2 })).status, 404);
    assert.deepEqual((await request("")).body.facts, []);
  } finally {
    if (server.exitCode === null) {
      const closed = new Promise((resolve) => server.once("close", resolve));
      server.kill("SIGTERM"); await closed;
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("failed fact replacement preserves the previous version and permits a safe retry", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-personal-facts-io-"));
  const file = path.join(root, "facts.json");
  const rename = fs.rename;
  try {
    const store = createPersonalFactsStore(file);
    const fact = await store.create({ label: "称呼", value: "原始内容" });
    const before = await fs.readFile(file, "utf8");
    fs.rename = async (source, target) => {
      if (target === file) throw Object.assign(new Error("injected replacement failure"), { code: "EIO" });
      return rename(source, target);
    };
    await assert.rejects(store.update(fact.id, { label: "称呼", value: "新内容", revision: 1 }), /injected/);
    assert.equal(await fs.readFile(file, "utf8"), before);
    assert.deepEqual(await fs.readdir(root), ["facts.json"]);
    fs.rename = rename;
    const saved = await store.update(fact.id, { label: "称呼", value: "新内容", revision: 1 });
    assert.equal(saved.revision, 2);
  } finally { fs.rename = rename; await fs.rm(root, { recursive: true, force: true }); }
});
