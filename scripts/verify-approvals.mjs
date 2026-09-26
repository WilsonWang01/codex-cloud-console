import assert from "node:assert/strict";
import test from "node:test";
import { approvalDigest, createApprovalBroker } from "../server/approval-broker.mjs";

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
  const broker = createApprovalBroker({ timeoutMs: 15 });
  const file = broker.request("item/fileChange/requestApproval", { threadId: "t", itemId: "i" });
  const [item] = broker.list();
  broker.decide(item.id, { decision: "decline", digest: item.digest });
  assert.deepEqual(await file, { decision: "decline" });

  const timedOut = broker.request("execCommandApproval", { command: ["echo", "test"] });
  assert.deepEqual(await timedOut, { decision: { denied: { rejection: "Approval timed out" } } });
  assert.equal(broker.list().length, 0);

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
