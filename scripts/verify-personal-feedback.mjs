import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPersonalFeedbackStore, personalFeedbackDigest, personalFeedbackSummary, personalFeedbackTarget } from "../server/personal-feedback.mjs";

const session = { id: "personal-session", repoId: "_personal", codexSessionId: "personal-thread" };
const message = { id: "reply-1", turnId: "turn-1", turnStatus: "completed", role: "codex", text: "合成建议：先核对日期，没有预订或付款。", messageType: "agentMessage", details: { phase: "final_answer" } };
const snapshot = () => ({ ok: true, thread: { id: session.codexSessionId, turns: [{ id: "turn-1", status: "completed" }] }, messages: [structuredClone(message)] });
const input = (extra = {}) => ({ turnId: message.turnId, messageId: message.id, contentDigest: personalFeedbackDigest(message.text), decision: "helpful", expectedRevision: 0, ...extra });
const source = () => personalFeedbackTarget(session, snapshot(), input());
const fixture = async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "personal-feedback-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "feedback.json");
  let time = Date.parse("2026-10-25T02:00:00.000Z");
  return { file, now: () => time, advance: ms => { time += ms; }, store: createPersonalFeedbackStore(file, { now: () => time }) };
};

test("personal feedback binds one completed native personal reply and rejects ambiguous or changed sources", () => {
  assert.deepEqual(source(), { sessionId: session.id, threadId: session.codexSessionId, turnId: message.turnId, messageId: message.id, contentDigest: input().contentDigest });
  for (const repoId of ["work", "_other"]) assert.throws(() => personalFeedbackTarget({ ...session, repoId }, snapshot(), input()), { statusCode: 404 });
  for (const status of ["inProgress", "failed", "interrupted"]) {
    const value = snapshot(); value.thread.turns[0].status = status;
    assert.throws(() => personalFeedbackTarget(session, value, input()), { statusCode: 409 });
  }
  for (const change of [value => { value.ok = false; }, value => { value.thread.id = "work-thread"; }, value => { delete value.thread.turns; }]) {
    const value = snapshot(); change(value); assert.throws(() => personalFeedbackTarget(session, value, input()), { statusCode: 503 });
  }
  for (const patch of [{ id: "other-reply" }, { role: "user" }, { text: "已变化" }, { mocked: true }, { messageType: "commandExecution" }, { details: { phase: "commentary" } }]) {
    const value = snapshot(); Object.assign(value.messages[0], patch);
    assert.throws(() => personalFeedbackTarget(session, value, input()), { statusCode: 409 });
  }
  const duplicate = snapshot(); duplicate.thread.turns.push({ ...duplicate.thread.turns[0] });
  assert.throws(() => personalFeedbackTarget(session, duplicate, input()), { statusCode: 409 });
  const later = snapshot(); later.messages.push({ ...message, id: "later-answer" });
  assert.throws(() => personalFeedbackTarget(session, later, input()), { statusCode: 409 });
});

test("personal feedback persists without storing the reply body and response-loss replay does not inflate revisions or dates", async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.store.list(), []);
  await assert.rejects(fs.access(f.file), { code: "ENOENT" });
  const saved = await f.store.set(source(), input());
  assert.equal(saved.revision, 1); assert.equal(saved.source, "user");
  const bytes = await fs.readFile(f.file, "utf8");
  assert.equal(bytes.includes(message.text), false);
  assert.equal((await fs.stat(f.file)).mode & 0o777, 0o600);
  f.advance(86400_000);
  assert.deepEqual(await f.store.set(source(), input()), saved);
  assert.equal(await fs.readFile(f.file, "utf8"), bytes);
  await assert.rejects(f.store.set(source(), input({ expectedRevision: 99 })), { statusCode: 409 });
  const reopened = createPersonalFeedbackStore(f.file, { now: f.now });
  assert.deepEqual(await reopened.list(session.codexSessionId), [saved]);
  assert.deepEqual(await reopened.list("other-thread"), []);
});

test("concurrent personal votes use observed revisions and explicit withdrawal is not counted as satisfaction", async t => {
  const f = await fixture(t);
  const results = await Promise.allSettled([f.store.set(source(), input()), f.store.set(source(), input({ decision: "not_helpful" }))]);
  assert.equal(results.filter(item => item.status === "fulfilled").length, 1);
  assert.equal(results.find(item => item.status === "rejected").reason.statusCode, 409);
  const saved = (await f.store.list())[0];
  const changed = await f.store.set(source(), input({ decision: "not_helpful", expectedRevision: saved.revision }));
  const withdrawn = await f.store.set(source(), input({ decision: null, expectedRevision: changed.revision }));
  assert.equal(withdrawn.decision, null);
  assert.equal((await f.store.list()).length, 1);
  const summary = await f.store.summary();
  assert.equal(summary.ratedCount, 0); assert.equal(summary.helpfulRatio, null);
  assert.deepEqual(await f.store.set(source(), input({ decision: null, expectedRevision: changed.revision })), withdrawn);
});

test("feedback authorization and digest mismatches fail without changing prior records", async t => {
  const f = await fixture(t);
  const before = await f.store.set(source(), input());
  const bytes = await fs.readFile(f.file, "utf8");
  for (const patch of [{ turnId: "other-turn" }, { messageId: "other-message" }, { contentDigest: "a".repeat(64) }]) {
    await assert.rejects(f.store.set(source(), input({ ...patch, expectedRevision: before.revision })), { statusCode: 409 });
  }
  await assert.rejects(f.store.set(source(), input({ decision: "not_helpful", expectedRevision: before.revision }), async () => false), { statusCode: 409 });
  assert.equal(await fs.readFile(f.file, "utf8"), bytes);
});

test("unknown, corrupt, duplicate or linked feedback storage never becomes an empty success or gets overwritten", async t => {
  const f = await fixture(t);
  const saved = await f.store.set(source(), input());
  for (const data of ["{broken", JSON.stringify({ version: 2, entries: [] }), JSON.stringify({ version: 1, entries: [saved, saved] })]) {
    await fs.writeFile(f.file, data);
    await assert.rejects(f.store.summary(), { statusCode: 503 });
    await assert.rejects(f.store.set(source(), input()), { statusCode: 503 });
    assert.equal(await fs.readFile(f.file, "utf8"), data);
  }
  const target = f.file + ".protected";
  await fs.writeFile(target, "protected"); await fs.unlink(f.file); await fs.symlink(target, f.file);
  await assert.rejects(f.store.set(source(), input()), { statusCode: 503 });
  assert.equal(await fs.readFile(target, "utf8"), "protected");
  assert.equal((await fs.lstat(f.file)).isSymbolicLink(), true);
});

test("seven-day feedback summaries count only explicit current votes, not missing, withdrawn or future rows", () => {
  const now = Date.parse("2026-10-25T02:00:00.000Z");
  const rows = [
    { decision: "helpful", updatedAt: new Date(now).toISOString() },
    { decision: "not_helpful", updatedAt: new Date(now - 86400_000).toISOString() },
    { decision: null, updatedAt: new Date(now).toISOString() },
    { decision: "helpful", updatedAt: new Date(now - 8 * 86400_000).toISOString() },
    { decision: "helpful", updatedAt: new Date(now + 1).toISOString() },
  ];
  const summary = personalFeedbackSummary(rows, now);
  assert.equal(summary.ratedCount, 2); assert.equal(summary.helpfulCount, 1); assert.equal(summary.notHelpfulCount, 1); assert.equal(summary.helpfulRatio, 0.5);
  assert.equal(personalFeedbackSummary([], now).helpfulRatio, null);
});

test("feedback capacity keeps every existing row and still allows correcting an existing evaluation", async t => {
  const f = await fixture(t), saved = await f.store.set(source(), input());
  const entries = Array.from({ length: 1000 }, (_, index) => {
    const turnId = index ? `other-turn-${index}` : saved.turnId;
    return { ...saved, turnId, key: crypto.createHash("sha256").update(JSON.stringify([saved.threadId, turnId])).digest("hex") };
  });
  await fs.writeFile(f.file, JSON.stringify({ version: 1, entries }));
  const before = await fs.readFile(f.file, "utf8");
  await assert.rejects(f.store.set({ ...source(), turnId: "new-turn" }, input({ turnId: "new-turn" })), { statusCode: 503 });
  assert.equal(await fs.readFile(f.file, "utf8"), before);
  const updated = await f.store.set(source(), input({ decision: "not_helpful", expectedRevision: 1 }));
  assert.equal(updated.revision, 2); assert.equal((await f.store.list()).length, 1000);
  assert.deepEqual((await f.store.list()).slice(1), entries.slice(1));
});

test("an uncertain directory flush can be checked and replayed without creating a second evaluation", async t => {
  const f = await fixture(t), open = fs.open;
  fs.open = async (...args) => {
    const handle = await open(...args);
    if (args[0] === path.dirname(f.file) && args[1] === "r") handle.sync = async () => { throw Object.assign(new Error("synthetic directory flush failure"), { code: "EIO" }); };
    return handle;
  };
  try { await assert.rejects(f.store.set(source(), input()), { code: "EIO" }); }
  finally { fs.open = open; }
  const [saved] = await f.store.list();
  assert.equal(saved.revision, 1); assert.equal(saved.decision, "helpful");
  assert.deepEqual(await f.store.set(source(), input()), saved);
});
