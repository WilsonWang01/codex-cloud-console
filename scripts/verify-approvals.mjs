import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { approvalDigest, createApprovalBroker, declineAppServerRequest } from "../server/approval-broker.mjs";

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
    findTurnJob: () => job,
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
    const answer = await handler("item/commandExecution/requestApproval", { threadId: "personal-thread" });
    assert.equal(answer.decision, "decline");
  }
  assert.equal(job.unattendedApprovalDenied, true);
  assert.equal(brokerCalls, 0);
  assert.deepEqual(decisions, ["declined-unattended", "declined-unattended"]);
  assert.equal(events.length, 2);
  await assert.rejects(appServerRequestResult("item/tool/requestUserInput", { threadId: "personal-thread" }), /无人值守/);
  assert.equal(brokerCalls, 0);
  job.unattendedPersonalSchedule = false;
  const interactive = await appServerRequestResult("item/commandExecution/requestApproval", { threadId: "personal-thread" });
  assert.equal(interactive.decision, "accept");
  assert.equal(brokerCalls, 1);
});

test("immediate decline follows each supported app-server response shape", () => {
  assert.deepEqual(declineAppServerRequest("item/fileChange/requestApproval", "blocked"), { decision: "decline" });
  assert.deepEqual(declineAppServerRequest("execCommandApproval", "blocked"), { decision: { denied: { rejection: "blocked" } } });
  assert.deepEqual(declineAppServerRequest("mcpServer/elicitation/request", "blocked"), { action: "decline", content: null, _meta: null });
  assert.throws(() => declineAppServerRequest("item/permissions/requestApproval", "blocked"), /blocked/);
});
