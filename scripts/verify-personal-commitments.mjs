import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPersonalCommitmentsStore, personalCommitmentDraft } from "../server/personal-commitments.mjs";
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

test("跨天进度复用旧事项格式，步骤编号、等待原因和原对话关联重启后保持", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-personal-progress-"));
  try {
    const file = path.join(root, "commitments.json"), time = "2026-10-22T09:00:00.000Z";
    const legacy = { id: "old", title: "旅行准备", nextStep: "等日期确认", dueAt: null, status: "active", sessionId: "original-result", source: "user", revision: 3, createdAt: time, updatedAt: time, completedAt: null, retainedUnknown: "preserve" };
    const bytes = JSON.stringify({ version: 1, commitments: [legacy] });
    await fs.writeFile(file, bytes);
    const store = createPersonalCommitmentsStore(file);
    assert.deepEqual(await store.list(), [legacy]); assert.equal(await fs.readFile(file, "utf8"), bytes);
    const progress = await store.update("old", { revision: 3, waitingReason: "等家人确认日期", milestones: [{ title: "已查车次", done: true }, { title: "预订车票", done: false }], relatedSessionIds: ["follow-up"] });
    assert.equal(progress.status, "active"); assert.equal(progress.sessionId, "original-result"); assert.equal(progress.retainedUnknown, "preserve");
    assert.equal(progress.completedAt, null); assert.equal(progress.milestones.length, 2);
    assert.notEqual(progress.milestones[0].id, progress.milestones[1].id);
    const reopened = (await createPersonalCommitmentsStore(file).list())[0]; assert.deepEqual(reopened, progress);
    const text = personalDeveloperInstructions({ sandbox: "read-only" }, [], [reopened]);
    assert.match(text, /等家人确认日期/); assert.match(text, /"title":"已查车次","done":true/); assert.match(text, /not proof of successful external actions/);
    assert.doesNotMatch(text, /original-result|follow-up/);
    assert.match(personalCommitmentDraft(reopened), /我记录的步骤（已完成）：已查车次/);
    assert.match(personalCommitmentDraft(reopened), /我记录的等待原因：等家人确认日期/);
    assert.match(personalCommitmentDraft(reopened), /先展示具体动作并征得我确认/);
    const advanced = await store.update("old", { revision: reopened.revision, milestones: reopened.milestones.map(step => ({ ...step, done: true })), waitingReason: "" });
    assert.deepEqual(advanced.milestones.map(step => step.id), reopened.milestones.map(step => step.id));
    assert.equal(advanced.status, "active", "勾完步骤不自动完成目标");
    const done = await store.update("old", { revision: advanced.revision, status: "done" });
    assert.deepEqual(done.milestones, advanced.milestones); assert.deepEqual(done.relatedSessionIds, ["follow-up"]);
    assert.doesNotMatch(personalDeveloperInstructions({}, [], [done]), /旅行准备|已查车次/);
    assert.equal(JSON.parse(await fs.readFile(file, "utf8")).version, 1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("进度边界与并发失败不改原记录，不接受未知步骤编号或伪造状态", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-personal-progress-invalid-"));
  try {
    const file = path.join(root, "commitments.json"), store = createPersonalCommitmentsStore(file);
    const item = await store.create({ title: "进度边界", milestones: [{ title: "第一步", done: false }], relatedSessionIds: ["personal-a"] });
    const before = await fs.readFile(file, "utf8");
    for (const payload of [
      { waitingReason: null }, { waitingReason: true }, { waitingReason: "x".repeat(301) },
      { milestones: null }, { milestones: Array.from({ length: 13 }, () => ({ title: "步骤", done: false })) },
      { milestones: [{ title: "步骤", done: "true" }] }, { milestones: [{ title: "步骤", done: true, completedAt: "forged" }] },
      { milestones: [{ id: "other-goal-step", title: "步骤", done: true }] }, { milestones: [item.milestones[0], item.milestones[0]] },
      { relatedSessionIds: Array.from({ length: 9 }, (_, n) => `s${n}`) }, { relatedSessionIds: ["same", "same"] }, { relatedSessionIds: [""] }, { relatedSessionIds: [1] },
    ]) {
      await assert.rejects(store.update(item.id, { revision: item.revision, title: "不能部分保存", ...payload }), { statusCode: 400 });
      await assert.rejects(store.create({ title: "不能创建无效进度", ...payload }), { statusCode: 400 });
      assert.equal(await fs.readFile(file, "utf8"), before);
    }
    const results = await Promise.allSettled(["设备 A", "设备 B"].map(waitingReason => store.update(item.id, { revision: item.revision, waitingReason })));
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(results.filter(result => result.status === "rejected" && result.reason.statusCode === 409).length, 1);
    const saved = (await store.list())[0]; assert.equal(saved.waitingReason, "设备 A"); assert.equal(saved.milestones[0].done, false);
    const limited = await store.update(saved.id, { revision: saved.revision, waitingReason: "x".repeat(300), milestones: Array.from({ length: 12 }, (_, n) => ({ title: "步骤" + n, done: n % 2 === 0 })), relatedSessionIds: Array.from({ length: 8 }, (_, n) => `s${n}`) });
    assert.equal(limited.milestones.length, 12); assert.equal(limited.relatedSessionIds.length, 8);
    for (const corrupt of [{ milestones: [{ title: "缺编号", done: false }] }, { milestones: [{ id: "broken", title: "错误状态", done: "yes" }] }, { waitingReason: null }, { relatedSessionIds: ["same", "same"] }]) {
      const raw = JSON.stringify({ version: 1, commitments: [{ ...limited, ...corrupt }] }); await fs.writeFile(file, raw);
      await assert.rejects(createPersonalCommitmentsStore(file).list(), { statusCode: 500 });
      await assert.rejects(store.update(limited.id, { revision: limited.revision, nextStep: "不能覆盖损坏记录" }), { statusCode: 500 });
      assert.equal(await fs.readFile(file, "utf8"), raw);
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
