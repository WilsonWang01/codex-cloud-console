import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import http from "node:http";
import express from "express";
import { personalResultReferencesRouter } from "../server/personal-result-references.mjs";
import { createPersonalCommitmentsStore } from "../server/personal-commitments.mjs";
import { personalReplyDigest, personalReplyCandidates, personalReplyReferenceList, personalReplyTarget, personalReplyView } from "../server/personal-reply-source.mjs";

const session = { id: "personal", repoId: "_personal", codexSessionId: "thread" };
const message = { id: "reply", turnId: "turn", role: "codex", messageType: "agentMessage", text: "合成结果：已整理路线，尚未预订。", details: { phase: "final_answer" }, time: "2026-10-25T02:00:00.000Z" };
const snapshot = () => ({ ok: true, thread: { id: "thread", turns: [{ id: "turn", status: "completed", completedAt: Date.parse(message.time) / 1000 }] }, messages: [structuredClone(message)] });
const input = () => ({ turnId: message.turnId, messageId: message.id, contentDigest: personalReplyDigest(message.text) });
const source = () => personalReplyTarget(session, snapshot(), input());

test("结果显示必须与已核对的最后一条最终回复完全一致，不能混入同编号过程记录", () => {
  const value = snapshot(); value.messages.unshift({ ...message, text: "过程记录，不是最终结果", details: { phase: "commentary" } });
  assert.equal(personalReplyView(session, value, input()).text, message.text);
});

test("候选只包含已完成回合的最终回复，保留完整指纹并明确预览截断", () => {
  const value = snapshot(); value.messages[0].text = "合成长结果".repeat(1000);
  value.messages.unshift({ ...message, text: "过程记录", details: { phase: "commentary" } });
  value.messages.push({ ...message, id: "pending-reply", turnId: "pending" }); value.thread.turns.push({ id: "pending", status: "inProgress" });
  const list = personalReplyCandidates(session, value); assert.equal(list.results.length, 1); assert.equal(list.hasMore, false);
  assert.equal(list.results[0].source.contentDigest, personalReplyDigest(value.messages[1].text));
  assert.equal(list.results[0].text.length, 4000); assert.equal(list.results[0].truncated, true);
  assert.equal(list.results[0].time, message.time);
  delete value.thread.turns[0].completedAt;
  assert.equal(personalReplyCandidates(session, value).results[0].time, null, "thread update times cannot masquerade as the reply completion time");
  const many = snapshot(); many.messages = []; many.thread.turns = [];
  for (let n = 0; n < 21; n++) { many.messages.push({ ...message, id: `reply-${n}`, turnId: `turn-${n}` }); many.thread.turns.push({ id: `turn-${n}`, status: "completed" }); }
  assert.equal(personalReplyCandidates(session, many).results.length, 20); assert.equal(personalReplyCandidates(session, many).hasMore, true);
});

test("个人归属、完整线程、版本和八条上限均严格校验", () => {
  assert.throws(() => personalReplyCandidates({ ...session, repoId: "work" }, snapshot()), { statusCode: 404 });
  for (const value of [{ ...snapshot(), ok: false }, { ...snapshot(), thread: { id: "other", turns: [] } }, { ...snapshot(), messages: null }]) {
    assert.throws(() => personalReplyCandidates(session, value), { statusCode: 503 });
  }
  const duplicate = snapshot(); duplicate.thread.turns.push(duplicate.thread.turns[0]);
  assert.throws(() => personalReplyCandidates(session, duplicate), { statusCode: 409 });
  for (const itemsView of ["summary", "notLoaded", "future-mode"]) {
    const partial = snapshot(); partial.thread.turns[0].itemsView = itemsView;
    assert.throws(() => personalReplyCandidates(session, partial), { statusCode: 503 });
    assert.throws(() => personalReplyTarget(session, partial, input()), { statusCode: 503 });
  }
  const full = snapshot(); full.thread.turns[0].itemsView = "full";
  assert.equal(personalReplyView(session, full, input()).text, message.text);
  const value = source();
  assert.throws(() => personalReplyReferenceList.parse([value, value]));
  assert.throws(() => personalReplyReferenceList.parse([{ ...value, unexpected: true }]));
  assert.throws(() => personalReplyReferenceList.parse(Array.from({ length: 9 }, (_, n) => ({ ...value, turnId: `turn-${n}` }))));
});

test("旧事项和未知字段保持，结果关联只存来源；撤销上下文、版本冲突及损坏均不改写", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-result-references-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "commitments.json"), legacy = { id: "old", title: "合成行程", nextStep: "等日期确认", dueAt: null, status: "active", sessionId: null,
    source: "user", revision: 3, createdAt: message.time, updatedAt: message.time, completedAt: null, retainedUnknown: "preserve" };
  await fs.writeFile(file, JSON.stringify({ version: 1, commitments: [legacy] }));
  const store = createPersonalCommitmentsStore(file), before = await fs.readFile(file, "utf8");
  assert.deepEqual(await store.list(), [legacy]); assert.equal(await fs.readFile(file, "utf8"), before);
  await assert.rejects(store.update("old", { revision: 3, resultReferences: [source()] }, async () => false), { statusCode: 409 });
  assert.equal(await fs.readFile(file, "utf8"), before);
  const linked = await store.update("old", { revision: 3, resultReferences: [source()] });
  assert.equal(linked.retainedUnknown, "preserve"); assert.equal(linked.revision, 4); assert.equal(linked.status, "active");
  assert.equal((await fs.readFile(file, "utf8")).includes(message.text), false);
  await assert.rejects(store.update("old", { revision: 3, resultReferences: [] }), { statusCode: 409 });
  const preserved = await fs.readFile(file, "utf8");
  for (const refs of [null, [source(), source()], [{ ...source(), contentDigest: "invalid" }]]) {
    await fs.writeFile(file, JSON.stringify({ version: 1, commitments: [{ ...linked, resultReferences: refs }] }));
    const corrupt = await fs.readFile(file, "utf8"); await assert.rejects(store.list(), /原记录未改写/);
    await assert.rejects(store.update("old", { revision: 4, nextStep: "不能覆盖" })); assert.equal(await fs.readFile(file, "utf8"), corrupt);
  }
  await fs.writeFile(file, preserved);
  assert.deepEqual((await createPersonalCommitmentsStore(file).list())[0].resultReferences, [source()]);
  await fs.writeFile(file, JSON.stringify({ version: 1, commitments: [{ ...linked, revision: Number.MAX_SAFE_INTEGER }] }));
  const capacity = await fs.readFile(file, "utf8");
  await assert.rejects(store.update("old", { revision: Number.MAX_SAFE_INTEGER, resultReferences: [] }), { statusCode: 503 });
  assert.equal(await fs.readFile(file, "utf8"), capacity);
});

test("读取期间失去个人归属时，不返回原回复正文，也不把已有绑定当作新核对成功", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-result-owner-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "commitments.json"), store = createPersonalCommitmentsStore(file);
  const item = await store.create({ title: "归属竞态" });
  const linked = await store.update(item.id, { revision: item.revision, resultReferences: [source()] });
  const before = await fs.readFile(file, "utf8"); let current;
  const app = express(); app.use(express.json()); app.use("/api/personal", personalResultReferencesRouter({ store,
    resolveSession: async () => current, readThread: async () => { current = { ...session, repoId: "work" }; return snapshot(); } }));
  const server = http.createServer(app); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}/api/personal`;
  current = session;
  const candidates = await fetch(`${base}/sessions/personal/reply-results`); assert.equal(candidates.status, 404); assert.equal((await candidates.text()).includes(message.text), false);
  current = session;
  const view = await (await fetch(`${base}/commitments/${item.id}/result-references`)).json();
  assert.equal(view.results[0].state, "missing"); assert.equal(view.results[0].text, undefined);
  current = session;
  const duplicate = await fetch(`${base}/commitments/${item.id}/result-references`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: linked.revision, source: source() }) });
  assert.equal(duplicate.status, 404); assert.equal(await fs.readFile(file, "utf8"), before);
});

test("读取期间事项版本变化时，关联读取及重复绑定不能返回旧版本的核对成功", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-result-revision-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = createPersonalCommitmentsStore(path.join(root, "commitments.json"));
  let item = await store.create({ title: "版本竞态" });
  item = await store.update(item.id, { revision: item.revision, resultReferences: [source()] });
  const app = express(); app.use(express.json()); app.use("/api/personal", personalResultReferencesRouter({ store,
    resolveSession: async () => session, readThread: async () => {
      item = await store.update(item.id, { revision: item.revision, nextStep: `其他页面修改 ${item.revision}` }); return snapshot();
    } }));
  const server = http.createServer(app); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}/api/personal/commitments/${item.id}/result-references`;
  const read = await fetch(url); assert.equal(read.status, 409); assert.equal((await read.text()).includes(message.text), false);
  const duplicate = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: item.revision, source: source() }) });
  assert.equal(duplicate.status, 409); assert.equal((await duplicate.json()).ok, false);
  assert.deepEqual((await store.list())[0].resultReferences, [source()]);
});
