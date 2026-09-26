import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "../server/codex-app-server-client.mjs";
import { personalFileBridgeJson, personalFileSocketPath } from "../server/personal-file-bridge.mjs";
import { appServerRequestScope, personalRuntimeConfig, personalSessionRuntime, personalDeveloperInstructions } from "../server/personal-runtime.mjs";
import { appAuthorizationUrl, readConnectedApps } from "../server/connected-apps.mjs";

const workerPath = fileURLToPath(new URL("../server/personal-worker.mjs", import.meta.url));

test("个人权限保留显式工作区写入，但不继承全权限或关闭审批", () => {
  const original = { model: "gpt-5.6-terra", sandbox: "danger-full-access", approval: "never" };
  assert.equal(personalSessionRuntime(original).sandbox, "read-only");
  assert.equal(original.sandbox, "danger-full-access");
  const writable = personalSessionRuntime({ ...original, sandbox: "workspace-write" });
  assert.equal(writable.sandbox, "workspace-write");
  assert.equal(writable.approval, "on-request");
  assert.match(personalDeveloperInstructions(writable), /allowed writing within this personal workspace/);
  assert.doesNotMatch(personalDeveloperInstructions(writable), /currently has read-only/);
  assert.match(personalDeveloperInstructions(original), /currently has read-only/);
  assert.match(personalDeveloperInstructions(writable), /Before sending an email/);
});

test("服务目录分页、实际可调用状态和授权链接边界", async () => {
  const calls = [];
  const catalog = await readConnectedApps(async (method, params) => {
    calls.push({ method, params });
    if (method === "app/installed") return { ok: true, result: { apps: [{ id: "mail", enabled: true, callable: true }, { id: "disabled", enabled: false, callable: true }] } };
    return { ok: true, result: { data: params.cursor ? [{ id: "disabled", name: "Calendar", isAccessible: true, isEnabled: false }] : [
      { id: "mail", name: "Mail", isAccessible: true, isEnabled: true, installUrl: "https://chatgpt.com/apps/mail/mail" },
      { id: "pending", name: "Docs", isAccessible: true, isEnabled: true, installUrl: "https://evil.test/authorize" },
    ], nextCursor: params.cursor ? null : "page-2" } };
  }, { refresh: true });
  assert.equal(catalog.apps.length, 3);
  assert.equal(catalog.apps[0].callable, true);
  assert.equal(catalog.apps[1].callable, false);
  assert.equal(catalog.apps[1].installUrl, null);
  assert.equal(catalog.apps[2].callable, false);
  assert.equal(calls[0].params.forceRefetch, true);
  assert.equal(calls[1].params.forceRefetch, false);
  for (const url of ["javascript:alert(1)", "http://chatgpt.com/apps/mail", "https://chatgpt.com.evil.test/apps/mail", "https://user@chatgpt.com/apps/mail", "https://chatgpt.com:444/apps/mail", "https://chatgpt.com/other"]) assert.equal(appAuthorizationUrl(url), null);
});

test("服务调用状态不可读取时保留未知，分页异常不返回伪完整目录", async () => {
  const catalog = await readConnectedApps(async (method) => method === "app/installed" ? { ok: false, error: "unsupported" } : { ok: true, result: { data: [{ id: "mail", name: "Mail", isAccessible: true, isEnabled: true }], nextCursor: null } });
  assert.equal(catalog.runtimeVerified, false);
  assert.equal(catalog.apps[0].callable, null);
  await assert.rejects(readConnectedApps(async () => ({ ok: true, result: { data: [], nextCursor: "repeat" } })), /分页未完成/);
  const denied = await readConnectedApps(async (method) => method === "app/list" ? { ok: false, error: "403 Forbidden <html>upstream error</html>" } : { ok: true, result: { apps: [{ id: "installed-mail", runtimeName: "Mail", enabled: true, callable: true }] } });
  assert.match(denied.directoryError, /403/);
  assert.doesNotMatch(denied.directoryError, /<html>/);
  assert.equal(denied.apps[0].callable, true);
  assert.equal(denied.apps[0].installUrl, null);
  const unavailable = await readConnectedApps(async () => ({ ok: false, error: "offline" }));
  assert.equal(unavailable.runtimeVerified, false);
  assert.ok(unavailable.directoryError);
});

test("personal runtime shares the existing account by default and supports explicit modes", () => {
  assert.equal(personalRuntimeConfig({ NODE_ENV: "production" }).mode, "shared");
  const shared = personalRuntimeConfig({ NODE_ENV: "production", CODEX_PERSONAL_WORKER: "1", CODEX_PERSONAL_MODE: "shared" }, "darwin");
  assert.equal(shared.enabled, false);
  assert.equal(shared.mode, "shared");
  assert.equal(personalRuntimeConfig({ CODEX_PERSONAL_MODE: "disabled" }).mode, "disabled");
  assert.throws(() => personalRuntimeConfig({ CODEX_PERSONAL_MODE: "typo" }), /Invalid/);
});

test("personal runtime requires a dedicated Linux home and socket", () => {
  const enabled = personalRuntimeConfig({ NODE_ENV: "production", CODEX_PERSONAL_WORKER: "1" }, "linux");
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.root, "/var/lib/codex-personal/workspace");
  assert.equal(appServerRequestScope({ cwd: [enabled.root] }, enabled.root), "personal");
  assert.equal(appServerRequestScope({ cwds: [enabled.root] }, enabled.root), "personal");
  assert.equal(appServerRequestScope({ roots: [path.join(enabled.root, "notes")] }, enabled.root), "personal");
  assert.equal(appServerRequestScope({ path: path.join(enabled.root, "notes.txt") }, enabled.root), "personal");
  assert.equal(appServerRequestScope({ path: `${enabled.root}-other/notes.txt` }, enabled.root), "work");
  assert.equal(appServerRequestScope({ cwd: ["/home/ubuntu/workspace"] }, enabled.root), "work");
  assert.throws(() => personalRuntimeConfig({ NODE_ENV: "production", CODEX_PERSONAL_WORKER: "1" }, "darwin"), /Linux/);
  assert.throws(() => personalRuntimeConfig({ NODE_ENV: "production", CODEX_PERSONAL_WORKER: "1", CODEX_PERSONAL_ROOT: "/home/ubuntu/workspace" }, "linux"), /dedicated personal home/);
});

test("personal worker bridges app-server over a socket without inherited secrets", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-personal-worker-"));
  const socketPath = path.join(root, "worker.sock");
  const fileSocketPath = personalFileSocketPath(socketPath);
  const fakeCodex = path.join(root, "fake-codex.mjs");
  await fs.mkdir(path.join(root, "workspace"));
  await fs.writeFile(fakeCodex, `#!${process.execPath}
import fs from "node:fs";
let buffer = "";
fs.writeFileSync(process.env.HOME + "/child.pid", String(process.pid));
setInterval(() => {}, 1000);
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    const request = JSON.parse(line);
    process.stdout.write(JSON.stringify({ id: request.id, result: { method: request.method, secretInherited: Boolean(process.env.PERSONAL_TEST_SECRET), home: process.env.HOME } }) + "\\n");
  }
});
`, { mode: 0o755 });
  const worker = spawn(process.execPath, [workerPath], {
    cwd: root,
    env: { ...process.env, HOME: root, CODEX_HOME: path.join(root, ".codex"), CODEX_PERSONAL_SOCKET: socketPath, CODEX_PERSONAL_CODEX_BIN: fakeCodex, PERSONAL_TEST_SECRET: "must-not-leak" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  worker.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  let client;
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await fs.stat(socketPath).catch(() => null) && await fs.stat(fileSocketPath).catch(() => null)) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(await fs.stat(socketPath).catch(() => null), stderr);
    assert.ok(await fs.stat(fileSocketPath).catch(() => null), stderr);
    const fileList = await personalFileBridgeJson(fileSocketPath, "GET", "/files");
    assert.deepEqual(fileList.files, []);
    client = new CodexAppServerClient({ socketPath, initializeTimeoutMs: 2_000 });
    const result = await client.request("ping", {}, 2_000).catch((error) => {
      throw new Error(`${error.message}; worker stderr: ${stderr}`);
    });
    assert.equal(result.method, "ping");
    assert.equal(result.secretInherited, false);
    assert.equal(result.home, root);
    await client.stop({ waitForExit: true });
    assert.equal(client.status().running, false);
    const pid = Number(await fs.readFile(path.join(root, "child.pid"), "utf8"));
    let stopped = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try { process.kill(pid, 0); }
      catch (error) { if (error.code === "ESRCH") { stopped = true; break; } }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(stopped, true, "app-server child must exit when the socket disconnects");
  } finally {
    await client?.stop({ waitForExit: true });
    if (worker.exitCode === null) {
      worker.kill("SIGTERM");
      await new Promise((resolve) => worker.once("close", resolve));
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});
