import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { createPersonalFactsStore } from "../server/personal-facts.mjs";
import { handlePersonalMemoryCall, personalMemoryTool } from "../server/personal-memory.mjs";

const origin = { sessionId: "personal-session", threadId: "personal-thread", turnId: "personal-turn", callId: "memory-call" };
const input = { label: "出行偏好", value: "合成验收：偏好火车", reason: "本次对话中明确提到" };
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-personal-memory-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "personal-facts.json");
  return { root, file, store: createPersonalFactsStore(file) };
}

test("模型建议先候选，用户更正接受后才进入事实；拒绝和清理不改变事实", async t => {
  const { file, store } = await fixture(t);
  const candidate = await store.propose(input, origin);
  assert.equal(candidate.status, "pending"); assert.deepEqual(candidate.origin, origin);
  assert.deepEqual((await store.snapshot()).facts, []);
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).version, 3);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  const accepted = await store.reviewCandidate(candidate.id, { decision: "accept", revision: 1, value: "用户更正：高铁优先", source: "spoof", confirmedAt: "spoof" });
  assert.equal(accepted.fact.source, "user"); assert.notEqual(accepted.fact.confirmedAt, "spoof");
  assert.equal(accepted.fact.value, "用户更正：高铁优先"); assert.equal(accepted.fact.origin.candidateId, candidate.id);
  assert.equal(accepted.candidate.status, "accepted"); assert.equal(accepted.candidate.revision, 2);
  assert.equal((await store.snapshot()).facts.length, 1);
  await assert.rejects(store.reviewCandidate(candidate.id, { decision: "accept", revision: 1 }), e => e.statusCode === 409);
  assert.equal((await store.list()).length, 1);
  const denied = await store.propose({ ...input, value: "不应使用的模型猜测" }, { ...origin, callId: "rejected" });
  await store.reviewCandidate(denied.id, { decision: "reject", revision: 1 });
  assert.equal((await store.snapshot()).facts.length, 1);
  const restarted = createPersonalFactsStore(file);
  assert.equal((await restarted.overview()).candidates[1].status, "rejected");
  await restarted.removeCandidate(candidate.id, { revision: 2 });
  assert.equal((await restarted.list())[0].value, accepted.fact.value);
  assert.equal((await restarted.overview()).candidates.length, 1);
  const corrected = await restarted.update(accepted.fact.id, { label: "出行偏好", value: "已停用", enabled: false, revision: 1 });
  assert.equal(corrected.enabled, false); assert.equal((await restarted.snapshot()).facts.length, 0);
});

test("同调用内容去重、异体拒绝，双页面接受/拒绝只成功一次", async t => {
  const { file, store } = await fixture(t);
  const candidate = await store.propose(input, origin);
  assert.equal((await store.propose(input, origin)).id, candidate.id);
  await assert.rejects(store.propose({ ...input, value: "changed" }, origin), e => e.statusCode === 409);
  const b = createPersonalFactsStore(file);
  const results = await Promise.allSettled([
    store.reviewCandidate(candidate.id, { revision: 1, decision: "accept" }),
    b.reviewCandidate(candidate.id, { revision: 1, decision: "reject" }),
  ]);
  assert.equal(results[0].status, "fulfilled"); assert.equal(results[1].reason.statusCode, 409);
  assert.equal((await store.list()).length, 1);
  assert.equal((await store.propose(input, origin)).status, "accepted");
  await assert.rejects(store.removeCandidate(candidate.id, {}), e => e.statusCode === 428);
  await assert.rejects(store.reviewCandidate(candidate.id, { revision: 2, decision: "reject" }), e => e.statusCode === 409);
});

test("候选上限与失效、参数校验；无效请求、满事实库和写失败均不丢数据", async t => {
  const { file, store } = await fixture(t);
  for (const payload of [{ ...input, source: "user" }, { ...input, label: "" }, { ...input, reason: "x".repeat(301) }, { ...input, expiresAt: "tomorrow" }]) {
    await assert.rejects(store.propose(payload, origin));
    await assert.rejects(fs.access(file));
  }
  for (let n = 0; n < 3; n++) await store.propose(input, { ...origin, callId: String(n) });
  await assert.rejects(store.propose(input, { ...origin, callId: "4" }), e => e.statusCode === 429);
  for (let n = 3; n < 20; n++) await store.propose(input, { ...origin, turnId: String(n) });
  await assert.rejects(store.propose(input, { ...origin, turnId: "full" }), e => e.statusCode === 409);
  const { candidates } = await store.overview();
  for (const item of candidates) await store.reviewCandidate(item.id, { revision: 1, decision: "reject" });
  const expired = await store.propose({ ...input, expiresAt: "2026-01-01T00:00:00.000Z" }, { ...origin, turnId: "expired" });
  await store.reviewCandidate(expired.id, { revision: 1, decision: "accept" });
  assert.deepEqual((await store.snapshot()).facts, []);
  for (let n = 1; n < 50; n++) await store.create({ label: String(n), value: "合成事实" });
  const pending = await store.propose(input, { ...origin, turnId: "capacity" });
  const before = await fs.readFile(file, "utf8");
  await assert.rejects(store.reviewCandidate(pending.id, { revision: 1, decision: "accept" }), e => e.statusCode === 409);
  assert.equal(await fs.readFile(file, "utf8"), before);
  const rename = fs.rename;
  try {
    fs.rename = async (source, target) => { if (target === file) throw new Error("injected write failure"); return rename(source, target); };
    await assert.rejects(store.reviewCandidate(pending.id, { revision: 1, decision: "reject" }), /injected/);
    assert.equal(await fs.readFile(file, "utf8"), before);
    assert.deepEqual(await fs.readdir(path.dirname(file)), [path.basename(file)]);
  } finally { fs.rename = rename; }
  const document = JSON.parse(await fs.readFile(file, "utf8"));
  document.candidates = Array.from({ length: 100 }, (_, n) => ({ ...document.candidates[0], id: String(n), status: "rejected", reviewedAt: new Date().toISOString(), revision: 2, origin: { ...origin, turnId: `old-${n}` } }));
  await fs.writeFile(file, JSON.stringify(document));
  await assert.rejects(store.propose(input, { ...origin, turnId: "total-limit" }), e => e.statusCode === 409);
  await store.removeCandidate("0", { revision: 2 });
  await store.propose(input, { ...origin, turnId: "after-explicit-cleanup" });
  assert.equal((await store.overview()).candidates.length, 100);
  const maximum = JSON.parse(await fs.readFile(file, "utf8"));
  const last = maximum.candidates.at(-1); last.revision = Number.MAX_SAFE_INTEGER;
  await fs.writeFile(file, JSON.stringify(maximum));
  const unchanged = await fs.readFile(file, "utf8");
  await assert.rejects(store.reviewCandidate(last.id, { revision: last.revision, decision: "reject" }), e => e.statusCode === 409);
  assert.equal(await fs.readFile(file, "utf8"), unchanged);
});

test("旧格式按需升级并保留元数据；未知候选、损坏和不兼容回退均保护原数据", async t => {
  const { root, file, store } = await fixture(t);
  const legacy = JSON.stringify({ version: 1, facts: [], custom: "preserve" });
  await fs.writeFile(file, legacy);
  assert.deepEqual((await store.overview()).candidates, []); assert.equal(await fs.readFile(file, "utf8"), legacy);
  await store.propose(input, origin); assert.equal(JSON.parse(await fs.readFile(file, "utf8")).custom, "preserve");
  const written = await fs.readFile(file, "utf8");
  const previous = path.join(root, "previous"); await fs.mkdir(path.join(previous, "server"), { recursive: true });
  await fs.writeFile(path.join(previous, "server/personal-facts.mjs"), "export const personalFactsFormatVersion = 2;\n");
  const rollback = new URL("../ops/check-task-rollback.mjs", import.meta.url).pathname;
  assert.throws(() => execFileSync(process.execPath, [rollback, root, previous], { stdio: "pipe" }), e => /不能自动回退/.test(String(e.stderr)));
  assert.equal(await fs.readFile(file, "utf8"), written);
  for (const document of [{ version: 3, facts: [], candidates: [{}] }, { version: 3, facts: [], candidates: null }, { version: 2, facts: [], candidates: { future: true } }]) {
    const original = JSON.stringify(document); await fs.writeFile(file, original);
    await assert.rejects(store.propose(input, origin)); assert.equal(await fs.readFile(file, "utf8"), original);
  }
});

test("动态工具仅允许精确匹配的前台个人回合，工作/过期/后台/未知工具均拒绝", async t => {
  const { store } = await fixture(t);
  const job = { kind: "turn", repo: { kind: "personal" }, sessionId: origin.sessionId, threadId: origin.threadId, turnId: origin.turnId };
  const params = { tool: personalMemoryTool.name, namespace: null, ...origin, arguments: input };
  for (const change of [{ repo: { kind: "work" } }, { completed: true }, { finishing: true }, { cancelRequested: true }, { unattendedPersonalSchedule: true }, { kind: "compact" }, { turnId: "other-turn" }, { threadId: "other-thread" }]) {
    assert.equal((await handlePersonalMemoryCall(params, { ...job, ...change }, store)).success, false);
  }
  assert.equal((await handlePersonalMemoryCall(params, null, store)).success, false);
  assert.equal((await handlePersonalMemoryCall({ ...params, tool: "arbitrary_tool" }, job, store)).success, false);
  assert.equal((await handlePersonalMemoryCall({ ...params, namespace: "other" }, job, store)).success, false);
  assert.deepEqual((await store.overview()).candidates, []);
  const result = await handlePersonalMemoryCall(params, job, store);
  assert.equal(result.success, true); assert.equal(JSON.parse(result.contentItems[0].text).status, "pending");
  assert.equal((await store.snapshot()).facts.length, 0);
  const brokenStore = { propose: async () => { throw new Error("private /server/path"); } };
  assert.doesNotMatch(JSON.stringify(await handlePersonalMemoryCall(params, job, brokenStore)), /private|server\/path/);
});
