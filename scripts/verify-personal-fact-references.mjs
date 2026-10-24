import assert from "node:assert/strict";
import test from "node:test";
import { personalFactSnapshot } from "../server/personal-facts.mjs";
import { personalDeveloperInstructions } from "../server/personal-runtime.mjs";
import { handlePersonalFactReferenceCall, personalFactReferenceTool, personalFactReferenceMessages } from "../server/personal-fact-references.mjs";
import { normalizeAppServerThreadMessages } from "../server/app-server-normalizers.mjs";

const now = Date.parse("2026-10-24T00:00:00.000Z");
const facts = [{ id: "fact-1", label: "合成出行偏好", value: "合成用户明确确认：火车优先", revision: 1, source: "user", enabled: true, expiresAt: null }];
const job = { kind: "turn", repo: { kind: "personal" }, sessionId: "personal-session", threadId: "thread-1", turnId: "turn-1", personalFactSnapshot: personalFactSnapshot(facts, now) };
const params = { tool: personalFactReferenceTool.name, namespace: null, threadId: job.threadId, turnId: job.turnId, callId: "reference-call", arguments: { factIds: [facts[0].id] } };
const call = (p = params, j = job) => handlePersonalFactReferenceCall(p, j);
function messages(result = call(), p = params) {
  return normalizeAppServerThreadMessages({ id: p.threadId, turns: [{ id: p.turnId, items: [{ id: p.callId, type: "dynamicToolCall", tool: p.tool, namespace: p.namespace,
    arguments: p.arguments, status: "completed", ...result }] }] });
}
const view = (current = facts, source = messages()) => personalFactReferenceMessages(source, job.threadId, current, now)[0];

test("引用只接受当前个人回合的已提供 ID，不修改事实、不复制正文或接受候选", () => {
  const before = JSON.stringify(job);
  const result = call(); assert.equal(result.success, true);
  const receipt = JSON.parse(result.contentItems[0].text);
  assert.deepEqual(receipt.facts, job.personalFactSnapshot.context.facts);
  assert.equal(receipt.threadId, job.threadId); assert.equal(receipt.turnId, job.turnId); assert.equal(receipt.callId, params.callId);
  assert.equal(receipt.source, "model_report");
  assert.doesNotMatch(result.contentItems[0].text, /火车优先|合成出行偏好/);
  assert.equal(JSON.stringify(job), before);
  const accepted = view(); assert.match(accepted.text, /模型报告引用了 1 条/);
  assert.equal(accepted.details.personalFactReferences.references[0].label, facts[0].label);
  assert.equal(accepted.details.personalFactReferences.references[0].value, facts[0].value);
  assert.equal(accepted.details.personalFactReferences.references[0].state, "active");
  assert.equal(accepted.details.personalFactReferences.checkedAt, new Date(now).toISOString());
  const prompt = personalDeveloperInstructions({ sandbox: "read-only" }, facts);
  assert.match(prompt, /"id":"fact-1"/); assert.match(prompt, /personal_facts_reference/);
});

test("工作、错回合、命名空间、缺失快照和非法输入不能伪造引用；后台只读登记不扩大权限", () => {
  for (const patch of [{ repo: { kind: "work" } }, { kind: "compact" }, { completed: true }, { finishing: true }, { cancelRequested: true }, { threadId: "wrong" }, { turnId: "wrong" }, { personalFactSnapshot: null }]) {
    assert.equal(call(params, { ...job, ...patch }).success, false);
  }
  assert.equal(call(params, null).success, false);
  assert.equal(call(null).success, false);
  for (const patch of [{ namespace: "other" }, { tool: "arbitrary" }, { callId: "" }, { callId: "x".repeat(201) }]) assert.equal(call({ ...params, ...patch }).success, false);
  for (const input of [null, {}, [], { factIds: [] }, { factIds: ["unknown"] }, { factIds: ["fact-1", "unknown"] }, { factIds: ["fact-1", "fact-1"] }, { factIds: ["fact-1"], value: "injected" }, { factIds: Array(51).fill("fact-1") }, { factIds: [1] }]) {
    assert.equal(call({ ...params, arguments: input }).success, false);
  }
  assert.equal(call(params, { ...job, unattendedPersonalSchedule: true }).success, true);
});

test("更正、停用、到期、删除、再次确认及存储不可读均按读取时状态展示，不保存旧正文", () => {
  for (const [current, state] of [
    [[{ ...facts[0], label: "已更正名称", value: "不同内容", revision: 2 }], "changed"],
    [[{ ...facts[0], enabled: false, revision: 2 }], "disabled"],
    [[{ ...facts[0], source: "model" }], "unconfirmed"],
    [[{ ...facts[0], expiresAt: new Date(now).toISOString() }], "expired"],
    [[{ ...facts[0], revision: 2 }], "reconfirmed"], [[], "removed"], [null, "unavailable"],
  ]) {
    const reference = view(current).details.personalFactReferences.references[0];
    assert.equal(reference.state, state); assert.equal(reference.revision, 1);
    assert.equal(reference.label, ["changed", "removed", "unavailable"].includes(state) ? undefined : facts[0].label);
    assert.equal(reference.value, ["changed", "removed", "unavailable"].includes(state) ? undefined : facts[0].value);
  }
});

test("普通文本、失败或未完成的工具、异会话/回合/调用号、异体参数及损坏回执不升级为来源证据", () => {
  const source = messages()[0], receipt = JSON.parse(source.details.contentItems[0].text);
  const altered = change => ({ ...source, details: { ...source.details, contentItems: [{ type: "inputText", text: JSON.stringify({ ...receipt, ...change }) }] } });
  const invalid = [
    { ...source, messageType: "agentMessage" }, { ...source, messageType: "userMessage" }, { ...source, id: "other" }, { ...source, turnId: "other" },
    ...[{ tool: "other" }, { namespace: "other" }, { success: false }, { success: null }, { status: "inProgress" }, { contentItems: [] }, { contentItems: [{ type: "inputText", text: "not-json" }] }, { arguments: { factIds: ["other"] } }].map(change => ({ ...source, details: { ...source.details, ...change } })),
    ...[{ type: "wrong" }, { version: 2 }, { source: "user" }, { threadId: "fork-or-other-thread" }, { turnId: "other" }, { callId: "other" }, { facts: [] }, { facts: [{ ...receipt.facts[0], digest: "bad" }] }, { recordedAt: "yesterday" }].map(altered),
  ];
  for (const item of invalid) {
    assert.equal(personalFactReferenceMessages([item], job.threadId, facts, now)[0], item);
  }
  assert.equal(personalFactReferenceMessages([source], "forked-thread", facts, now)[0], source);
});

test("最多 50 条长 ID 回执仍能正常读取，未提供的停用/到期资料不能登记", () => {
  const large = Array.from({ length: 50 }, (_, n) => ({ ...facts[0], id: String(n).padStart(200, "x") }));
  const snapshot = personalFactSnapshot(large, now), p = { ...params, arguments: { factIds: large.map(f => f.id) } };
  const result = call(p, { ...job, personalFactSnapshot: snapshot }); assert.equal(result.success, true);
  const resultView = personalFactReferenceMessages(messages(result, p), job.threadId, large, now)[0];
  assert.equal(resultView.details.personalFactReferences.references.length, 50);
  for (const fact of [{ ...facts[0], enabled: false }, { ...facts[0], expiresAt: new Date(now).toISOString() }]) {
    assert.equal(call(params, { ...job, personalFactSnapshot: personalFactSnapshot([fact], now) }).success, false);
  }
});
