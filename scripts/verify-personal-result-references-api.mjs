import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { personalFeedbackConsole } from "./fixtures/personal-feedback-console.mjs";

test("真实隔离 HTTP 将事项绑定到具体原回复，来源变化/失败、冲突及重启不误报或覆盖", { timeout: 30000 }, async t => {
  const f = await personalFeedbackConsole(); t.after(f.stop);
  const { request, control, state } = f;
  const candidates = "/api/personal/sessions/personal-a/reply-results";
  const listed = await request(candidates); assert.equal(listed.status, 200); assert.equal(listed.body.results.length, 1);
  const original = listed.body.results[0], source = original.source;
  assert.equal(original.text, "合成建议 A：先核对日期，没有预订或付款。");
  assert.equal(source.sessionId, "personal-a"); assert.equal(source.threadId, "feedback-thread-a");
  for (const id of ["work-history", "work-thread", "app-work-thread", "unknown-personal"]) assert.equal((await request(`/api/personal/sessions/${id}/reply-results`)).status, 404);
  const created = await request("/api/personal/commitments", "POST", { title: "行程跟进", nextStep: "核对原结果后确认日期" });
  let item = created.body.commitment;
  const route = `/api/personal/commitments/${item.id}/result-references`, file = path.join(state, "personal-commitments.json");
  assert.equal((await request("/api/personal/commitments")).body.resultsVersion, 1);
  assert.deepEqual((await request(route)).body.results, []);
  const empty = await fs.readFile(file, "utf8");
  assert.equal((await request(route, "POST", { revision: item.revision, source }, { origin: "https://untrusted.example" })).status, 403);
  for (const forged of [{ ...source, sessionId: "work-history" }, { ...source, threadId: "feedback-thread-b" }, { ...source, contentDigest: "f".repeat(64) }, { ...source, messageId: "commentary" }]) {
    assert.ok([404, 409].includes((await request(route, "POST", { revision: item.revision, source: forged })).status));
    assert.equal(await fs.readFile(file, "utf8"), empty);
  }
  for (const [url, method] of [["/api/personal/commitments", "POST"], [`/api/personal/commitments/${item.id}`, "PATCH"]]) {
    assert.equal((await request(url, method, { title: "不能绕过来源", revision: item.revision, resultReferences: [source] })).status, 400);
    assert.equal(await fs.readFile(file, "utf8"), empty);
  }
  item = (await request(route, "POST", { revision: item.revision, source })).body.commitment;
  assert.deepEqual(item.resultReferences, [source]); assert.equal(item.status, "active"); assert.equal(item.revision, 2);
  const saved = await fs.readFile(file, "utf8"); assert.equal(saved.includes(original.text), false);
  assert.equal((await request(route, "POST", { revision: item.revision, source })).body.commitment.revision, item.revision);
  assert.equal(await fs.readFile(file, "utf8"), saved);
  assert.equal((await request(route, "POST", { revision: 1, source })).status, 409);
  const view = await request(route); assert.equal(view.body.results[0].state, "available"); assert.equal(view.body.results[0].text, original.text);
  const config = JSON.parse(await fs.readFile(control, "utf8"));
  for (const change of [{ text: "合成原回复已更正" }, { status: "inProgress" }, { unavailable: true }]) {
    await fs.writeFile(control, JSON.stringify({ ...config, a: { ...config.a, ...change } }));
    const read = await request(route); assert.equal(read.status, 200);
    assert.equal(read.body.results[0].state, change.unavailable ? "unavailable" : "changed");
    assert.equal(read.body.results[0].text, undefined); assert.equal(read.body.results[0].preview, undefined);
    assert.equal(await fs.readFile(file, "utf8"), saved);
  }
  await fs.writeFile(control, JSON.stringify(config));
  await f.restart();
  assert.equal((await request(route)).body.results[0].state, "available");
  assert.equal((await request(route)).body.commitment.revision, 2);
  assert.equal((await request(route, "DELETE", { revision: 2, source: { ...source, sessionId: "work-history" } })).body.commitment.resultReferences.length, 1);
  assert.equal(await fs.readFile(file, "utf8"), saved);
  const other = (await request("/api/personal/sessions/personal-b/reply-results")).body.results[0].source;
  const concurrent = (await request("/api/personal/commitments", "POST", { title: "并发结果" })).body.commitment;
  const competing = await Promise.all([source, other].map(ref => request(`/api/personal/commitments/${concurrent.id}/result-references`, "POST", { revision: concurrent.revision, source: ref })));
  assert.deepEqual(competing.map(reply => reply.status).sort(), [200, 409]);
  const beforeRemove = JSON.parse(await fs.readFile(path.join(state, "chat-history.json"), "utf8"));
  const removed = await request(route, "DELETE", { revision: 2, source }); assert.equal(removed.status, 200); assert.deepEqual(removed.body.commitment.resultReferences, []);
  const afterRemove = JSON.parse(await fs.readFile(path.join(state, "chat-history.json"), "utf8"));
  assert.deepEqual(afterRemove.sessions["personal-a"].draft, beforeRemove.sessions["personal-a"].draft);
  assert.equal(afterRemove.sessions["personal-a"].model, "gpt-6-astra"); assert.equal(afterRemove.sessions["personal-a"].reasoning, "ultra");
  assert.equal((await request(candidates)).body.results[0].text, original.text);
  await assert.rejects(fs.access(path.join(state, "personal-message-feedback.json")), { code: "ENOENT" });
  const rpc = (await fs.readFile(f.rpcCapture, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(rpc.some(item => ["turn/start", "thread/start", "mcpServer/tool/call", "feedback/upload", "command/exec"].includes(item.method)), false);
});
