import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPersonalCommitmentsStore } from "../server/personal-commitments.mjs";
import { personalDeveloperInstructions } from "../server/personal-runtime.mjs";

test("personal commitments persist, reject stale edits and only expose active bounded context", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-personal-commitments-"));
  try {
    const file = path.join(root, "state", "commitments.json");
    const store = createPersonalCommitmentsStore(file);
    const later = await store.create({ title: "准备旅行", nextStep: "核对路线", dueAt: "2026-10-02T09:00:00.000Z" });
    const sooner = await store.create({ title: "提交资料", nextStep: "检查材料", dueAt: "2026-09-28T09:00:00.000Z" });
    const undated = await store.create({ title: "不设到期时间" });
    assert.equal(undated.dueAt, null);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    assert.equal((await createPersonalCommitmentsStore(file).list()).length, 3);
    const instructions = personalDeveloperInstructions({ sandbox: "read-only" }, [], await store.list());
    assert.ok(instructions.indexOf("提交资料") < instructions.indexOf("准备旅行"));
    await assert.rejects(store.update(sooner.id, { revision: 0, title: "错误覆盖" }), { statusCode: 409 });
    await assert.rejects(store.create({ title: "非法日期", dueAt: "2026-02-30T00:00:00.000Z" }), { statusCode: 400 });
    const linked = await store.update(later.id, { revision: later.revision, sessionId: "personal-session" });
    assert.equal(linked.sessionId, "personal-session");
    const completed = await store.update(sooner.id, { revision: sooner.revision, status: "done" });
    assert.equal(completed.completedAt !== null, true);
    assert.doesNotMatch(personalDeveloperInstructions({ sandbox: "read-only" }, [], await store.list()), /提交资料/);
    await assert.rejects(store.remove(later.id, later.revision), { statusCode: 409 });
    await store.remove(later.id, linked.revision);
    assert.deepEqual((await store.list()).map((item) => item.id), [sooner.id, undated.id]);
    assert.equal((await store.list())[0].status, "done");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("draft reservations survive failed linking and restart, concurrent retries reuse the draft", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-personal-draft-"));
  try {
    const file = path.join(root, "commitments.json");
    let store = createPersonalCommitmentsStore(file);
    const item = await store.create({ title: "核对行程" });
    const sessions = new Map();
    let creations = 0;
    const callbacks = {
      getSession: async (id) => sessions.get(id) || null,
      ensureSession: async (id) => {
        if (!sessions.has(id)) { sessions.set(id, { id, draft: "用户草稿" }); creations += 1; }
        return sessions.get(id);
      },
    };
    const rename = fs.rename.bind(fs);
    let writes = 0;
    const failedWrite = t.mock.method(fs, "rename", async (...args) => {
      if (++writes === 2) throw new Error("interrupted after creating draft");
      return rename(...args);
    });
    await assert.rejects(store.startDraft(item.id, item.revision, callbacks), /interrupted/);
    failedWrite.mock.restore();
    const reserved = (await store.list())[0];
    assert.equal(reserved.sessionId, null);
    assert.equal(reserved.pendingDraftSessionId, [...sessions.keys()][0]);
    assert.equal(reserved.revision, item.revision);
    store = createPersonalCommitmentsStore(file);
    const results = await Promise.all(Array.from({ length: 3 }, () => store.startDraft(item.id, item.revision, callbacks)));
    assert.equal(new Set(results.map((result) => result.session.id)).size, 1);
    assert.equal(creations, 1);
    assert.equal((await store.list())[0].pendingDraftSessionId, undefined);
    assert.equal(results[0].commitment.revision, item.revision + 1);
    assert.equal(results[0].session.draft, "用户草稿");
    sessions.clear();
    await assert.rejects(store.startDraft(item.id, item.revision, callbacks), { statusCode: 409 });
    const replaced = await store.startDraft(item.id, results[0].commitment.revision, callbacks);
    assert.notEqual(replaced.session.id, results[0].session.id);
    assert.equal(creations, 2);
    const completed = await store.update(item.id, { revision: replaced.commitment.revision, status: "done" });
    await assert.rejects(store.startDraft(item.id, completed.revision, callbacks), { statusCode: 409 });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("old browser pending links reuse a personal draft and first-write failure cannot create a draft", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-personal-draft-legacy-"));
  try {
    const file = path.join(root, "commitments.json");
    const store = createPersonalCommitmentsStore(file);
    const item = await store.create({ title: "整理资料" });
    const legacy = { id: "legacy-personal", draft: "用户修改后的草稿" };
    let ensuredId;
    const result = await store.startDraft(item.id, item.revision, {
      pendingSessionId: legacy.id,
      getSession: async (id) => id === legacy.id ? legacy : null,
      ensureSession: async (id) => { ensuredId = id; return legacy; },
    });
    assert.equal(ensuredId, legacy.id);
    assert.equal(result.session.draft, legacy.draft);
    const failing = await store.create({ title: "不应创建" });
    t.mock.method(fs, "rename", async () => { throw new Error("reservation write failed"); });
    let called = false;
    await assert.rejects(store.startDraft(failing.id, failing.revision, { getSession: async () => null, ensureSession: async () => { called = true; } }));
    assert.equal(called, false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
