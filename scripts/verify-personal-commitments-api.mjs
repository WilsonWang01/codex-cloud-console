import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("personal draft HTTP retries, restart and legacy migration preserve one unsent draft", { timeout: 20_000 }, async () => {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-personal-draft-api-"));
  const stateRoot = path.join(root, "state");
  const workRoot = path.join(root, "work");
  await fs.mkdir(workRoot);
  const port = await new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const { port } = listener.address();
      listener.close(() => resolve(port));
    });
  });
  let server;
  let logs = "";
  const stop = async () => {
    if (!server || server.exitCode !== null) return;
    const stopped = new Promise((resolve) => server.once("close", resolve));
    server.kill("SIGTERM");
    await stopped;
  };
  const start = async () => {
    logs = "";
    server = spawn(process.execPath, [path.join(projectRoot, "server/index.mjs")], {
      cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH, HOME: root, NODE_ENV: "production", HOST: "127.0.0.1", PORT: String(port),
        CODEX_CLOUD_ROOT: root, CODEX_STATE_ROOT: stateRoot, CODEX_HOME: path.join(root, "codex-home"),
        CODEX_PERSONAL_MODE: "shared", CODEX_PERSONAL_ROOT: path.join(root, "personal"),
        CODEX_CLOUD_REPOS_CONFIG_B64: Buffer.from(JSON.stringify([{ id: "work", name: "work", path: workRoot }])).toString("base64"),
      },
    });
    server.stdout.on("data", (chunk) => { logs += chunk; });
    server.stderr.on("data", (chunk) => { logs += chunk; });
    for (let attempt = 0; attempt < 100 && !logs.includes("listening on"); attempt += 1) {
      if (server.exitCode !== null) throw new Error(logs);
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.match(logs, /listening on/);
  };
  const request = async (route, method = "GET", body) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    await start();
    const created = await request("/api/personal/commitments", "POST", { title: "旅行准备", nextStep: "核对车次" });
    const item = created.body.commitment;
    const route = `/api/personal/commitments/${item.id}/draft`;
    const replies = await Promise.all(Array.from({ length: 3 }, () => request(route, "POST", { revision: item.revision })));
    assert.deepEqual(replies.map((reply) => reply.status), [200, 200, 200]);
    const id = replies[0].body.activeSessionId;
    assert.equal(new Set(replies.map((reply) => reply.body.activeSessionId)).size, 1);
    assert.match(replies[0].body.sessions.find((session) => session.id === id).draft.input, /旅行准备[\s\S]*核对车次/);
    const saved = await request(`/api/chat/sessions/${id}/draft`, "PATCH", { repoId: "_personal", input: "用户修改的旅行草稿", attachments: [], expectedRevision: 1 });
    assert.equal(saved.status, 200);
    await stop();
    await start();
    const replay = await request(route, "POST", { revision: item.revision });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.activeSessionId, id);
    assert.equal(replay.body.sessions.find((session) => session.id === id).draft.input, "用户修改的旅行草稿");
    const chat = JSON.parse(await fs.readFile(path.join(stateRoot, "chat-history.json"), "utf8"));
    assert.equal(Object.keys(chat.sessions).length, 1);
    assert.equal(chat.sessions[id].codexSessionId, null);
    assert.deepEqual(chat.sessions[id].messages, []);

    const legacy = (await request("/api/personal/commitments", "POST", { title: "迁移旧关联" })).body.commitment;
    const migrated = await request(`/api/personal/commitments/${legacy.id}/draft`, "POST", { revision: legacy.revision, pendingSessionId: id });
    assert.equal(migrated.body.activeSessionId, id);
    assert.equal(migrated.body.sessions.find((session) => session.id === id).draft.input, "用户修改的旅行草稿");
    const work = (await request("/api/chat/sessions", "POST", { repoId: "work" })).body.activeSessionId;
    const separate = (await request("/api/personal/commitments", "POST", { title: "工作空间候选不能复用" })).body.commitment;
    const isolated = await request(`/api/personal/commitments/${separate.id}/draft`, "POST", { revision: separate.revision, pendingSessionId: work });
    assert.equal(isolated.status, 200);
    assert.notEqual(isolated.body.activeSessionId, work);
    assert.equal(isolated.body.repoId, "_personal");
    const completed = await request(`/api/personal/commitments/${separate.id}`, "PATCH", { revision: isolated.body.commitment.revision, status: "done" });
    assert.equal((await request(`/api/personal/commitments/${separate.id}/draft`, "POST", { revision: completed.body.commitment.revision })).status, 409);
  } finally {
    await stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});
