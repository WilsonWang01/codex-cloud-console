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
    const created = await request("/api/personal/commitments", "POST", { title: "旅行准备", nextStep: "核对车次", waitingReason: "等日期确认", milestones: [{ title: "查路线", done: true }, { title: "预订车票", done: false }] });
    const item = created.body.commitment;
    const route = `/api/personal/commitments/${item.id}/draft`;
    const replies = await Promise.all(Array.from({ length: 3 }, () => request(route, "POST", { revision: item.revision })));
    assert.deepEqual(replies.map((reply) => reply.status), [200, 200, 200]);
    const id = replies[0].body.activeSessionId;
    assert.equal(new Set(replies.map((reply) => reply.body.activeSessionId)).size, 1);
    assert.match(replies[0].body.sessions.find((session) => session.id === id).draft.input, /旅行准备[\s\S]*核对车次/);
    assert.match(replies[0].body.sessions.find((session) => session.id === id).draft.input, /我记录的等待原因：等日期确认[\s\S]*我记录的步骤（已完成）：查路线/);
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
    const progressRead = await request("/api/personal/commitments"); assert.equal(progressRead.body.progressVersion, 1);
    assert.deepEqual(progressRead.body.commitments[0].milestones, item.milestones);

    const legacy = (await request("/api/personal/commitments", "POST", { title: "迁移旧关联" })).body.commitment;
    const migrated = await request(`/api/personal/commitments/${legacy.id}/draft`, "POST", { revision: legacy.revision, pendingSessionId: id });
    assert.equal(migrated.body.activeSessionId, id);
    assert.equal(migrated.body.sessions.find((session) => session.id === id).draft.input, "用户修改的旅行草稿");
    const work = (await request("/api/chat/sessions", "POST", { repoId: "work" })).body.activeSessionId;
    const otherPersonal = (await request("/api/chat/sessions", "POST", { repoId: "_personal", title: "另一段个人跟进" })).body.activeSessionId;
    const current = progressRead.body.commitments[0];
    const progressRoute = `/api/personal/commitments/${item.id}`;
    const preserved = await fs.readFile(path.join(stateRoot, "personal-commitments.json"), "utf8");
    for (const [method, target] of [["POST", "/api/personal/commitments"], ["PATCH", progressRoute]]) {
      for (const ids of [[work], [otherPersonal, work], ["unknown-personal"]]) {
        const rejected = await request(target, method, { title: "禁止串入工作", revision: current.revision, relatedSessionIds: ids });
        assert.equal(rejected.status, 404); assert.equal(await fs.readFile(path.join(stateRoot, "personal-commitments.json"), "utf8"), preserved);
      }
    }
    const linkedProgress = await request(progressRoute, "PATCH", { revision: current.revision, relatedSessionIds: [otherPersonal], waitingReason: "等家人确认" });
    assert.equal(linkedProgress.status, 200); assert.equal(linkedProgress.body.commitment.sessionId, id);
    for (const invalid of [{ sessionId: [otherPersonal] }, { relatedSessionIds: [otherPersonal, otherPersonal] }, { milestones: [{ id: "foreign-step", title: "不能绑定其他目标的步骤", done: true }] }]) {
      assert.equal((await request(progressRoute, "PATCH", { revision: linkedProgress.body.commitment.revision, ...invalid })).status, 400);
    }
    const stale = await request(progressRoute, "PATCH", { revision: current.revision, nextStep: "过时编辑不能覆盖" }); assert.equal(stale.status, 409);
    await stop(); await start();
    const continued = (await request("/api/personal/commitments")).body.commitments.find(entry => entry.id === item.id);
    assert.deepEqual(continued.relatedSessionIds, [otherPersonal]); assert.equal(continued.waitingReason, "等家人确认");
    assert.deepEqual(continued.milestones, item.milestones);
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
