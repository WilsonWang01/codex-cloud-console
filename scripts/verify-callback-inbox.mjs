import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { openCallbackInbox, createCallbackInboxServer } from "./callback-inbox-example.mjs";

const secret = "synthetic-private-receiver-key-not-an-account-credential", automationId = "research";
const command = fileURLToPath(new URL("./callback-inbox-example.mjs", import.meta.url));
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const event = (patch = {}) => ({ id: randomUUID(), type: "automation.run.terminal", created_at: new Date().toISOString(),
  data: { run_id: "run-synthetic-1", automation_id: automationId, status: "completed", result_path: "/api/automations/research/runs/run-synthetic-1" }, ...patch });
function signed(value, key = secret) {
  const rawBody = Buffer.from(typeof value === "string" ? value : JSON.stringify(value)), timestamp = String(Math.floor(Date.now() / 1000));
  return { rawBody, headers: { "content-type": "application/json", "x-codex-event-id": typeof value === "string" ? "invalid" : value.id,
    "x-codex-timestamp": timestamp, "x-codex-signature": "v1=" + createHmac("sha256", key).update(timestamp + ".").update(rawBody).digest("hex") } };
}
async function fixture(check) {
  const root = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), "callback-inbox-")); fs.chmodSync(root, 0o700);
  const file = path.join(root, "inbox.sqlite"), open = extra => openCallbackInbox({ file, secret, automationId, ...extra });
  try { await check({ root, file, open }); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test("回调先持久保存再确认，重启去重且容量满时仍确认原事件", () => fixture(({ open }) => {
  let inbox = open({ capacity: 2 });
  const first = signed(event()), second = signed(event()), third = signed(event());
  try {
    assert.equal(inbox.receive(first).duplicate, false);
    const before = inbox.list(); assert.equal(before.items.length, 1);
    inbox.close(); inbox = open({ capacity: 2 });
    assert.equal(inbox.receive(first).duplicate, true); assert.deepEqual(inbox.list(), before);
    const timestamp = String(Number(first.headers["x-codex-timestamp"]) + 1);
    assert.equal(inbox.receive({ rawBody: first.rawBody, headers: { ...first.headers, "x-codex-timestamp": timestamp,
      "x-codex-signature": "v1=" + createHmac("sha256", secret).update(timestamp + ".").update(first.rawBody).digest("hex") } }).duplicate, true);
    assert.throws(() => inbox.receive(signed({ ...before.items[0].event, data: { ...before.items[0].event.data, status: "failed" } })), { statusCode: 409 });
    assert.deepEqual(inbox.list(), before);
    assert.equal(inbox.receive(second).duplicate, false);
    assert.throws(() => inbox.receive(third), { statusCode: 503 });
    assert.equal(inbox.receive(first).duplicate, true); assert.equal(inbox.list().items.length, 2);
    const page = inbox.list({ limit: 1 });
    assert.equal(page.items[0].event.id, before.items[0].event.id);
    assert.equal(inbox.list({ after: page.nextCursor }).items.length, 1);
    page.items[0].event.data.status = "failed";
    assert.equal(inbox.list().items[0].event.data.status, "completed");
    for (const input of [{ after: -1 }, { after: "1" }, { limit: 0 }, { limit: 101 }]) assert.throws(() => inbox.list(input));
  } finally { inbox.close(); }
}));

test("接收端拒绝错误签名、其他自动化和不安全编号，不写入事件", () => fixture(({ open }) => {
  const inbox = open();
  try {
    assert.throws(() => inbox.receive(signed(event(), secret + "wrong")), { statusCode: 401 });
    for (const [id, run] of [["other", "run-1"], [automationId, ".."], [automationId, "line\nbreak"]]) {
      const value = event({ data: { automation_id: id, run_id: run, status: "completed", result_path: `/api/automations/${encodeURIComponent(id)}/runs/${encodeURIComponent(run)}` } });
      assert.throws(() => inbox.receive(signed(value)), { statusCode: 401 });
    }
    assert.equal(inbox.list().items.length, 0);
  } finally { inbox.close(); }
}));

test("未知数据库、范围变化、权限与链接均拒绝，不覆盖原数据", () => fixture(({ root, file, open }) => {
  const foreign = new DatabaseSync(file); foreign.exec("CREATE TABLE user_data(value TEXT); INSERT INTO user_data VALUES ('synthetic-keep')"); foreign.close();
  fs.chmodSync(file, 0o600); const original = digest(fs.readFileSync(file));
  assert.throws(() => open()); assert.equal(digest(fs.readFileSync(file)), original);
  const own = path.join(root, "known.sqlite"), inbox = open({ file: own }); inbox.close();
  const before = digest(fs.readFileSync(own));
  assert.throws(() => open({ file: own, automationId: "other" })); assert.equal(digest(fs.readFileSync(own)), before);
  const link = path.join(root, "alias.sqlite"); fs.symlinkSync(own, link);
  assert.throws(() => open({ file: link })); assert.equal(digest(fs.readFileSync(own)), before);
  fs.linkSync(own, link + ".hard"); assert.throws(() => open({ file: own })); fs.unlinkSync(link + ".hard");
  fs.chmodSync(own, 0o644); assert.throws(() => open({ file: own })); fs.chmodSync(own, 0o600);
  fs.chmodSync(root, 0o770); assert.throws(() => open({ file: path.join(root, "must-not-create.sqlite") })); fs.chmodSync(root, 0o700);
  assert.equal(fs.existsSync(path.join(root, "must-not-create.sqlite")), false);
  const absent = path.join(root, "absent.sqlite"); assert.throws(() => open({ file: absent, readOnly: true })); assert.equal(fs.existsSync(absent), false);
  const reader = open({ file: own, readOnly: true, secret: undefined });
  try { assert.deepEqual(reader.list().items, []); assert.throws(() => reader.receive(signed(event()))); }
  finally { reader.close(); }
  assert.equal(digest(fs.readFileSync(own)), before);
  for (const input of [{ secret: "short" }, { automationId: 7 }, { file: "relative.sqlite" }, { capacity: 4097 }]) assert.throws(() => open(input));
}));

test("真实 HTTP 接收端限制入口、正文与类型，确认与拒绝不混淆", () => fixture(async ({ open }) => {
  const inbox = open(), server = createCallbackInboxServer(inbox);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/codex/completed`, value = event(), request = signed(value);
  const post = async (input, extra = {}) => {
    const response = await fetch(url, { method: "POST", headers: input.headers, body: input.rawBody, ...extra, signal: AbortSignal.timeout(5000) });
    const body = await response.json(); return { code: response.status, body };
  };
  try {
    assert.equal((await post(request)).code, 202);
    assert.deepEqual(await post(request), { code: 200, body: { ok: true, duplicate: true, eventId: value.id } });
    assert.equal((await post(signed({ ...value, data: { ...value.data, status: "failed" } }))).code, 409);
    assert.equal((await post(signed(event(), secret + "wrong"))).code, 401);
    assert.equal((await post(signed(event({ data: { ...value.data, run_id: "\ud800", result_path: "/invalid" } })))).code, 401);
    assert.equal((await post(request, { headers: { ...request.headers, "content-encoding": "gzip" } })).code, 415);
    assert.equal((await post(request, { headers: { ...request.headers, "content-type": "text/plain" } })).code, 415);
    assert.equal((await post({ ...request, rawBody: Buffer.alloc(2049, 32) })).code, 413);
    const missing = await fetch(url, { signal: AbortSignal.timeout(5000) }); assert.equal(missing.status, 404); await missing.arrayBuffer();
    assert.equal(inbox.list().items.length, 1);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); inbox.close(); }
}));

test("实际存储不可用时返回失败，不把验签成功当作已接收", () => fixture(async ({ open }) => {
  const inbox = open(); inbox.close();
  const server = createCallbackInboxServer(inbox); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const input = signed(event()), response = await fetch(`http://127.0.0.1:${server.address().port}/codex/completed`, {
      method: "POST", headers: input.headers, body: input.rawBody, signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 503); const body = await response.json(); assert.equal(body.ok, false); assert.equal(JSON.stringify(body).includes(secret), false);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}));

test("独立接收进程并发及强制重启只保存一个事件，命令行可分页读取", () => fixture(async ({ root, file }) => {
  const env = { PATH: process.env.PATH, HOME: root, CODEX_CALLBACK_RECEIVER_STATE: file, CODEX_CALLBACK_RECEIVER_SECRET: secret,
    CODEX_CALLBACK_RECEIVER_AUTOMATION_ID: automationId, CODEX_CALLBACK_RECEIVER_PORT: "0" };
  const children = [];
  const start = async () => {
    const child = spawn(process.execPath, [command], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", stderr = ""; child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    const closed = new Promise(resolve => child.once("close", resolve)); const handle = { child, closed }; children.push(handle);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const line = output.split("\n").find(line => line.startsWith("{"));
      if (line) { const ready = JSON.parse(line); assert.equal(ready.ok, true); assert.equal(output.includes(secret), false); return { ...handle, url: ready.url }; }
      if (child.exitCode !== null) throw new Error(`接收端提前退出：${stderr}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`接收端未启动：${stderr}`);
  };
  const post = async (url, value) => { const input = signed(value), response = await fetch(url, { method: "POST", headers: input.headers, body: input.rawBody, signal: AbortSignal.timeout(5000) }); await response.arrayBuffer(); return response.status; };
  try {
    const one = await start(), two = await start(), value = event();
    const codes = await Promise.all(Array.from({ length: 20 }, (_, i) => post(i % 2 ? one.url : two.url, value)));
    assert.equal(codes.filter(code => code === 202).length, 1); assert.equal(codes.filter(code => code === 200).length, 19);
    one.child.kill("SIGKILL"); await one.closed;
    const restarted = await start(); assert.equal(await post(restarted.url, value), 200);
    assert.equal(await post(restarted.url, event()), 202);
    const list = async args => {
      const { CODEX_CALLBACK_RECEIVER_SECRET: _secret, ...readEnv } = env;
      const child = spawn(process.execPath, [command, "--list", ...args], { env: readEnv, stdio: ["ignore", "pipe", "pipe"] });
      let output = "", stderr = ""; child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
      assert.equal(await new Promise(resolve => child.once("close", resolve)), 0, stderr); assert.equal(output.includes(secret), false); return JSON.parse(output);
    };
    const first = await list(["--limit", "1"]); assert.equal(first.items.length, 1); assert.equal(first.items[0].event.id, value.id);
    const second = await list(["--after", String(first.nextCursor)]); assert.equal(second.items.length, 1); assert.notEqual(second.items[0].event.id, value.id);
    const writer = new DatabaseSync(file); writer.exec("BEGIN EXCLUSIVE");
    let waiting;
    try {
      waiting = list([]).then(value => ({ value }), error => ({ error }));
      await new Promise(resolve => setTimeout(resolve, 200));
    } finally { writer.exec("ROLLBACK"); writer.close(); }
    const result = await waiting; if (result.error) throw result.error;
    assert.equal(result.value.items.length, 2);
  } finally {
    for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await Promise.all(children.map(item => item.closed));
  }
}));
