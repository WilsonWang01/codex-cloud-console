import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { approvalDigest, createApprovalBroker, declineAppServerRequest } from "../server/approval-broker.mjs";
import { CodexAppServerClient } from "../server/codex-app-server-client.mjs";

test("双向协议保留零编号请求，服务器同号请求不能吞掉客户端等待的响应", async () => {
  const seen = [], writes = [];
  const child = {};
  const client = new CodexAppServerClient({ cwd: "/tmp", onServerRequest: async (method, params, message) => { seen.push({ method, params, id: message.id }); return { decision: "decline" }; } });
  client.child = child; client.generation = 1;
  client.write = message => writes.push(message);
  let resolved = false;
  client.pending.set(7, { child, generation: 1, resolve: () => { resolved = true; }, reject: assert.fail });
  client.handleMessage({ id: 0, method: "item/tool/call", params: { tool: "candidate" } }, child, 1);
  client.handleMessage({ id: 7, method: "item/fileChange/requestApproval", params: { reason: "synthetic" } }, child, 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(resolved, false); assert.equal(client.pending.has(7), true);
  assert.deepEqual(seen.map(item => item.id), [0, 7]);
  assert.deepEqual(writes, [{ id: 0, result: { decision: "decline" } }, { id: 7, result: { decision: "decline" } }]);
  client.handleMessage({ id: 7, result: { ok: true } }, child, 1);
  assert.equal(resolved, true); assert.equal(client.pending.size, 0);
  client.child = null;
});

test("approval is bound to exact request and can only be decided once", async () => {
  const broker = createApprovalBroker();
  const params = { threadId: "thread-a", turnId: "turn-a", command: "echo safe", cwd: "/tmp" };
  const answer = broker.request("item/commandExecution/requestApproval", params, { repoId: "work" });
  const [item] = broker.list();
  assert.equal(item.owner.repoId, "work");
  assert.equal(item.digest, approvalDigest("item/commandExecution/requestApproval", params));
  assert.throws(() => broker.decide(item.id, { decision: "accept", digest: approvalDigest("item/commandExecution/requestApproval", { ...params, command: "rm -rf /" }) }), /changed/);
  assert.equal(broker.list().length, 1);
  broker.decide(item.id, { decision: "accept", digest: item.digest });
  assert.deepEqual(await answer, { decision: "accept" });
  assert.throws(() => broker.decide(item.id, { decision: "accept", digest: item.digest }), /missing or expired/);
});

test("decline, timeout, and disconnect fail closed", async () => {
  const broker = createApprovalBroker();
  const file = broker.request("item/fileChange/requestApproval", { threadId: "t", itemId: "i" });
  const [item] = broker.list();
  broker.decide(item.id, { decision: "decline", digest: item.digest });
  assert.deepEqual(await file, { decision: "decline" });

  const timeoutBroker = createApprovalBroker({ timeoutMs: 40 });
  const timedOut = timeoutBroker.request("execCommandApproval", { command: ["echo", "test"] });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(await timedOut, { decision: { denied: { rejection: "Approval timed out" } } });
  assert.equal(timeoutBroker.list().length, 0);

  const permission = broker.request("item/permissions/requestApproval", { permissions: { network: { enabled: true } } });
  broker.closeAll();
  await assert.rejects(permission, /App-server disconnected/);
  assert.equal(broker.list().length, 0);
});

test("personal worker disconnect declines only personal approvals", async () => {
  const broker = createApprovalBroker();
  const personal = broker.request("item/fileChange/requestApproval", { threadId: "personal" }, { repoId: "_personal" });
  const work = broker.request("item/fileChange/requestApproval", { threadId: "work" }, { repoId: "sample-app" });
  broker.closeForRepo("_personal", "Personal worker disconnected");
  assert.deepEqual(await personal, { decision: "decline" });
  assert.equal(broker.list().length, 1);
  assert.equal(broker.list()[0].owner.repoId, "sample-app");
  const [item] = broker.list();
  broker.decide(item.id, { decision: "accept", digest: item.digest });
  assert.deepEqual(await work, { decision: "accept" });
});

test("grants contain only the requested permission and only this turn", async () => {
  const broker = createApprovalBroker();
  const params = { permissions: { network: { enabled: true }, fileSystem: null } };
  const result = broker.request("item/permissions/requestApproval", params);
  const [item] = broker.list();
  broker.decide(item.id, { decision: "accept", digest: item.digest });
  assert.deepEqual(await result, { permissions: { network: { enabled: true } }, scope: "turn" });
});

test("user input cannot be silently answered with an empty payload", async () => {
  const broker = createApprovalBroker();
  const params = { questions: [{ id: "choice", question: "Choose one" }] };
  const result = broker.request("item/tool/requestUserInput", params);
  const [item] = broker.list();
  assert.throws(() => broker.decide(item.id, { decision: "accept", digest: item.digest, answers: {} }), /required/);
  broker.decide(item.id, { decision: "accept", digest: item.digest, answers: { choice: ["first"] } });
  assert.deepEqual(await result, { answers: { choice: { answers: ["first"] } } });
});

test("unattended personal schedules decline approvals before they enter the pending queue", async () => {
  const source = fs.readFileSync(new URL("../server/index.mjs", import.meta.url), "utf8");
  const start = source.indexOf("async function appServerRequestResult(");
  const end = source.indexOf("\nfunction personalAppServerNotification(", start);
  assert.ok(start >= 0 && end > start);
  const job = { repoId: "_personal", sessionId: "scheduled", unattendedPersonalSchedule: true, unattendedApprovalDenied: false };
  const decisions = [];
  const events = [];
  let brokerCalls = 0;
  const context = vm.createContext({
    personalSources: [{ ownsThread: () => false }, { ownsThread: () => false }],
    personalCalendarActions: { ownsThread: () => false },
    findTurnJob: () => job,
    ownerFromParams: params => ({ turnId: params.turnId }),
    findCompactJob: () => null,
    personalRepoId: "_personal",
    recordAppServerRequestDecision: (_method, _params, decision) => decisions.push(decision),
    emitJobEvent: (_job, kind, data) => events.push({ kind, data }),
    declineAppServerRequest,
    approvalBroker: { request: async () => { brokerCalls += 1; return { decision: "accept" }; } },
  });
  vm.runInContext(`${source.slice(start, end)}\nglobalThis.handlers = { appServerRequestResult, personalAppServerRequestResult };`, context);
  const { appServerRequestResult, personalAppServerRequestResult } = context.handlers;
  for (const handler of [appServerRequestResult, personalAppServerRequestResult]) {
    const answer = await handler("item/commandExecution/requestApproval", { threadId: "personal-thread", turnId: "personal-turn" });
    assert.equal(answer.decision, "decline");
  }
  assert.equal(job.unattendedApprovalDenied, true);
  assert.equal(brokerCalls, 0);
  assert.deepEqual(decisions, ["declined-unattended", "declined-unattended"]);
  assert.equal(events.length, 2);
  await assert.rejects(appServerRequestResult("item/tool/requestUserInput", { threadId: "personal-thread", turnId: "personal-turn" }), /无人值守/);
  assert.equal(brokerCalls, 0);
  job.unattendedPersonalSchedule = false;
  const interactive = await appServerRequestResult("item/commandExecution/requestApproval", { threadId: "personal-thread", turnId: "personal-turn" });
  assert.equal(interactive.decision, "accept");
  assert.equal(brokerCalls, 1);
  for (let index = 0; index < context.personalSources.length; index++) {
    context.personalSources.forEach((source, other) => { source.ownsThread = id => index === other && id === "source-thread"; });
    for (const handler of [appServerRequestResult, personalAppServerRequestResult]) {
      await assert.rejects(handler("item/commandExecution/requestApproval", { threadId: "source-thread" }), /既定只读/);
      await assert.rejects(handler("mcpServer/elicitation/request", { threadId: "source-thread" }), /既定只读/);
    }
  }
  assert.equal(brokerCalls, 1, "calendar and mail refresh never prompt the user to grant runtime permissions");
});

test("回合结束只关闭本次审批，旧审批和取消竞态不能继续批准权限", async () => {
  const broker = createApprovalBroker();
  const owner = { repoId: "repo", sessionId: "session", turnId: "old" };
  const old = broker.request("item/commandExecution/requestApproval", {}, owner);
  const current = broker.request("item/commandExecution/requestApproval", {}, { ...owner, turnId: "new" });
  const other = broker.request("item/commandExecution/requestApproval", {}, { ...owner, sessionId: "other" });
  const original = broker.list().find(item => item.owner.turnId === "old" && item.owner.sessionId === "session");
  broker.closeForTurn(owner);
  assert.equal((await old).decision, "decline"); assert.equal(broker.list().length, 2);
  assert.throws(() => broker.decide(original.id, { decision: "accept", digest: original.digest }), { statusCode: 410 });
  broker.closeAll(); await current; await other;
  const source = fs.readFileSync(new URL("../server/index.mjs", import.meta.url), "utf8");
  const job = { repoId: "repo", sessionId: "s", turnId: "turn" };
  const context = vm.createContext({ personalSources: [{ ownsThread: () => false }, { ownsThread: () => false }], ownerFromParams: () => ({ turnId: "turn" }),
    personalCalendarActions: { ownsThread: () => false },
    findTurnJob: () => job, findCompactJob: () => null, recordAppServerRequestDecision: () => {}, declineAppServerRequest,
    approvalBroker: { request: async () => { job.cancelRequested = true; return { decision: "accept" }; } },
  });
  vm.runInContext(source.slice(source.indexOf("async function appServerRequestResult("), source.indexOf("\nfunction personalAppServerRequestResult(")), context);
  assert.equal((await context.appServerRequestResult("item/commandExecution/requestApproval", {})).decision, "decline");
});

test("日程动作所属线程只把既定人工表单交给审批，其他线程仍按回合归属拒绝", async () => {
  const source = fs.readFileSync(new URL("../server/index.mjs", import.meta.url), "utf8"), calls = [];
  const context = vm.createContext({
    personalSources: [{ ownsThread: () => false }], personalRepoId: "_personal",
    personalCalendarActions: { ownsThread: id => id === "calendar-owned", canApprove: (method, params) => method === "mcpServer/elicitation/request" && params.serverName === "codex_apps" && params.mode === "form" },
    findTurnJob: () => null, findCompactJob: () => null, ownerFromParams: () => ({}), recordAppServerRequestDecision() {}, declineAppServerRequest,
    approvalBroker: { request: async (method, params, owner) => { calls.push({ method, params, owner }); return { action: "accept" }; } },
  });
  vm.runInContext(source.slice(source.indexOf("async function appServerRequestResult("), source.indexOf("\nfunction personalAppServerNotification(")), context);
  const params = { threadId: "calendar-owned", serverName: "codex_apps", mode: "form" };
  for (const handler of [context.appServerRequestResult, context.personalAppServerRequestResult]) {
    assert.equal((await handler("mcpServer/elicitation/request", params)).action, "accept");
    for (const patch of [{ mode: "url" }, { serverName: "other" }]) await assert.rejects(handler("mcpServer/elicitation/request", { ...params, ...patch }), /不允许扩权/);
    await assert.rejects(handler("item/permissions/requestApproval", params), /不允许扩权/);
  }
  assert.equal((await context.appServerRequestResult("mcpServer/elicitation/request", { ...params, threadId: "unrelated" })).action, "decline");
  assert.equal(calls.length, 2); assert.equal(calls.every(call => call.owner.repoId === "_personal" && call.params.threadId === "calendar-owned"), true);
});

test("immediate decline follows each supported app-server response shape", () => {
  assert.deepEqual(declineAppServerRequest("item/fileChange/requestApproval", "blocked"), { decision: "decline" });
  assert.deepEqual(declineAppServerRequest("execCommandApproval", "blocked"), { decision: { denied: { rejection: "blocked" } } });
  assert.deepEqual(declineAppServerRequest("mcpServer/elicitation/request", "blocked"), { action: "decline", content: null, _meta: null });
  assert.throws(() => declineAppServerRequest("item/permissions/requestApproval", "blocked"), /blocked/);
});
