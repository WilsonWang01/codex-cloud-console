import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { personalFeedbackConsole } from "./fixtures/personal-feedback-console.mjs";

test("历史按需扩展到 500 条，不改原生记录、显式模型和草稿，非法数量及跨空间读取拒绝", async () => {
  const fixture = await personalFeedbackConsole();
  try {
    const control = JSON.parse(await fs.readFile(fixture.control, "utf8"));
    control.a.history = Array.from({ length: 497 }, (_, index) => ({ id: `old-turn-${index}`, status: "completed",
      items: [{ id: `old-message-${index}`, type: "agentMessage", phase: "final_answer", text: `合成历史 ${index}` }] }));
    await fs.writeFile(fixture.control, JSON.stringify(control));
    const rawBefore = await fs.readFile(fixture.control, "utf8");
    const base = "/api/chat/sessions?repoId=_personal&sessionId=personal-a";
    for (const [limit, count] of [[undefined, 80], [160, 160], [560, 500], [2000, 500]]) {
      const result = await fixture.request(base + (limit ? `&limit=${limit}` : ""));
      assert.equal(result.status, 200); assert.equal(result.body.ok, true);
      assert.equal(result.body.messages.length, count);
      assert.deepEqual(result.body.history, { total: 500, limit: limit || 80, hasMore: count < 500 });
      assert.equal(result.body.messages[0].text, `合成历史 ${500 - count}`);
      const active = result.body.sessions.find(item => item.id === result.body.activeSessionId);
      assert.equal(active.model, "gpt-6-astra"); assert.equal(active.reasoning, "ultra");
      assert.equal(active.draft.input, "合成未发送草稿 A");
    }
    for (const limit of ["0", "-1", "1.5", "1e3", "2001", "foo", "80&limit=160"]) {
      const result = await fixture.request(`${base}&limit=${limit}`);
      assert.equal(result.status, 400); assert.equal(result.body.ok, false);
    }
    const beforeBadSelect = await fs.readFile(fixture.state + "/chat-history.json", "utf8");
    for (const limit of [[80], true, null, {}]) {
      const result = await fixture.request("/api/chat/sessions/personal-b/select", "POST", { repoId: "_personal", limit });
      assert.equal(result.status, 400);
      assert.equal(await fs.readFile(fixture.state + "/chat-history.json", "utf8"), beforeBadSelect);
    }
    const wrong = await fixture.request("/api/chat/sessions?repoId=work&sessionId=personal-a&limit=560");
    assert.equal(wrong.status, 404);
    const history = await fixture.request("/api/chat/history?repoId=_personal&sessionId=personal-a&limit=560");
    assert.equal(history.body.messages.length, 500);
    const native = await fixture.request("/api/codex/thread-read?repoId=_personal&sessionId=personal-a");
    assert.equal(native.body.messages.length, 500);
    assert.equal(await fs.readFile(fixture.control, "utf8"), rawBefore);
    for (const anchor of ["", "x".repeat(513), "one&anchor=two"]) {
      assert.equal((await fixture.request(`${base}&anchor=${anchor}`)).status, 400);
    }
    for (const [extra, expected, retained] of [[100, 600, true], [1800, 2000, false]]) {
      control.a.history = [...control.a.history.slice(0, 497), ...Array.from({ length: extra }, (_, index) => ({ id: `extra-turn-${index}`, status: "completed",
        items: [{ id: `extra-message-${index}`, type: "agentMessage", text: `后续合成记录 ${index}` }] }))];
      await fs.writeFile(fixture.control, JSON.stringify(control));
      const result = await fixture.request(`${base}&limit=500&anchor=old-message-0`);
      assert.equal(result.body.messages.length, expected);
      assert.equal(result.body.history.anchorRetained, retained);
      assert.equal(result.body.history.hasMore, !retained);
    }
    await fs.writeFile(fixture.control, rawBefore);
    const stored = JSON.parse(await fs.readFile(fixture.state + "/chat-history.json", "utf8"));
    assert.equal(Object.values(stored.sessions).every(session => session.messages.length <= 80), true);
    const rpc = (await fs.readFile(fixture.rpcCapture, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(rpc.some(item => ["turn/start", "thread/start", "mcpServer/tool/call", "command/exec"].includes(item.method)), false);
  } finally { await fixture.stop(); }
});
