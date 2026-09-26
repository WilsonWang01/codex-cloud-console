import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "../server/codex-app-server-client.mjs";
import { appServerRequestScope, personalRuntimeConfig } from "../server/personal-runtime.mjs";

const workerPath = fileURLToPath(new URL("../server/personal-worker.mjs", import.meta.url));

test("personal runtime requires a dedicated Linux home and socket", () => {
  const enabled = personalRuntimeConfig({ NODE_ENV: "production", CODEX_PERSONAL_WORKER: "1" }, "linux");
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.root, "/var/lib/codex-personal/workspace");
  assert.equal(appServerRequestScope({ cwd: [enabled.root] }, enabled.root), "personal");
  assert.equal(appServerRequestScope({ cwd: ["/home/ubuntu/workspace"] }, enabled.root), "work");
  assert.throws(() => personalRuntimeConfig({ NODE_ENV: "production", CODEX_PERSONAL_WORKER: "1" }, "darwin"), /Linux/);
  assert.throws(() => personalRuntimeConfig({ NODE_ENV: "production", CODEX_PERSONAL_WORKER: "1", CODEX_PERSONAL_ROOT: "/home/ubuntu/workspace" }, "linux"), /dedicated personal home/);
});

test("personal worker bridges app-server over a socket without inherited secrets", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-personal-worker-"));
  const socketPath = path.join(root, "worker.sock");
  const fakeCodex = path.join(root, "fake-codex.mjs");
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
      if (await fs.stat(socketPath).catch(() => null)) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(await fs.stat(socketPath).catch(() => null), stderr);
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
