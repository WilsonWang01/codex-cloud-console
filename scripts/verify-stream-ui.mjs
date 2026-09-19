import assert from "node:assert/strict";

export async function verifyConversationStreams({ page, baseUrl, sessions, activeJobs, waitUntil, out }) {
  for (const session of sessions) {
    session.codexSessionId = session.id;
    session.isDraft = false;
    session.draft = { input: "", attachments: [], revision: session.draft.revision + 1 };
  }
  await page.goto(`${baseUrl}#/project/sample-app/thread/sample-app-1`);
  const composer = page.locator(".composer-shell textarea");
  await composer.waitFor();
  // Controlled response bodies exercise real fetch readers and AbortSignals without model calls.
  await page.evaluate(() => {
    const original = window.fetch.bind(window);
    const paths = new Set(["/api/chat/stream", "/api/codex/review/stream", "/api/codex/thread-compact/stream", "/api/chat/job-events"]);
    const harness = { records: [], interrupts: 0, activeFailures: 0 };
    window.__streamHarness = harness;
    window.fetch = async (input, options = {}) => {
      const url = new URL(String(input), location.href);
      if (url.pathname === "/api/codex/turn-interrupt") harness.interrupts += 1;
      if (url.pathname === "/api/chat/active" && harness.activeFailures > 0) {
        harness.activeFailures -= 1;
        throw new Error("验收模拟运行状态查询失败");
      }
      if (!paths.has(url.pathname)) return original(input, options);
      const payload = options.body ? JSON.parse(options.body) : Object.fromEntries(url.searchParams);
      let controller;
      const record = { path: url.pathname, sessionId: payload.sessionId, aborted: false, closed: false };
      const body = new ReadableStream({ start(value) { controller = value; } });
      record.emit = (event, data) => {
        if (record.closed) return false;
        controller.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        return true;
      };
      record.close = () => { if (!record.closed) { record.closed = true; controller.close(); } };
      record.fail = () => { if (!record.closed) { record.closed = true; controller.error(new Error("验收模拟连接断开")); } };
      const abort = () => {
        record.aborted = true;
        if (!record.closed) { record.closed = true; controller.error(new DOMException("Subscription detached", "AbortError")); }
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
      harness.records.push(record);
      record.emit("meta", { sessionId: payload.sessionId, threadId: payload.sessionId });
      return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
    };
  });
  const records = () => page.evaluate(() => window.__streamHarness.records.map(({ path, sessionId, aborted, closed }) => ({ path, sessionId, aborted, closed })));
  const emit = (index, event, data) => page.evaluate(({ index, event, data }) => window.__streamHarness.records[index].emit(event, data), { index, event, data });
  const navigate = async (sessionId, viaSidebar = false) => {
    const repoId = sessionId.replace(/-\d+$/, "");
    if (viaSidebar) await page.locator(".sidebar-session-item").filter({ hasText: sessions.find((session) => session.id === sessionId).title }).click();
    else await page.evaluate((hash) => { location.hash = hash; }, `/project/${repoId}/thread/${sessionId}`);
    await waitUntil(() => page.url().endsWith(`/thread/${sessionId}`));
    const selected = page.locator(".sidebar-session-item.selected").filter({ hasText: sessions.find((session) => session.id === sessionId).title });
    await selected.waitFor();
    await waitUntil(() => selected.isEnabled());
    await waitUntil(async () => await composer.getAttribute("placeholder") === "向云端 Codex 发送消息");
  };
  const command = async (value) => { await composer.fill(value); await composer.press("Enter"); };
  const busy = () => page.getByRole("button", { name: "云端 Codex 正在处理", exact: true });

  await command("/compact");
  await waitUntil(async () => (await records()).length === 1);
  assert.equal((await records())[0].path, "/api/codex/thread-compact/stream");
  await emit(0, "status", { text: "验收压缩运行中" });
  await navigate("sample-app-2", true);
  assert.equal((await records())[0].aborted, true);
  await command("/review");
  await waitUntil(async () => (await records()).length === 2);
  assert.equal((await records())[1].path, "/api/codex/review/stream");
  assert.equal(await emit(0, "done", { ok: true, sessionId: "sample-app-1" }), false);
  await page.waitForTimeout(100);
  assert.equal(await busy().count(), 1);
  assert.match(page.url(), /sample-app-2$/);
  await navigate("sample-app-1");
  assert.equal((await records())[1].aborted, true);
  assert.equal(await page.getByText("主动压缩失败", { exact: true }).count(), 0);
  assert.equal(await page.getByText("Codex review 连接已断开，未收到完成事件。", { exact: true }).count(), 0);

  await command("验收运行中的聊天");
  await waitUntil(async () => (await records()).length === 3);
  assert.equal((await records())[2].path, "/api/chat/stream");
  await emit(2, "accepted", { sessionId: "sample-app-1" });
  await emit(2, "delta", { text: "验收持续生成中" });
  await page.getByText("验收持续生成中", { exact: true }).waitFor();
  assert.equal(await busy().count(), 1);
  assert.equal(await page.locator(".chat-bubble.streaming").filter({ hasText: "验收持续生成中" }).count(), 1);
  await page.screenshot({ path: new URL("desktop-streaming.png", out).pathname, fullPage: true });

  await navigate("sample-app-2");
  assert.equal((await records())[2].aborted, true);
  activeJobs.set("sample-app-1", { id: "fixture-running-job", threadId: "sample-app-1", startedAt: new Date().toISOString() });
  await page.evaluate(() => { window.__streamHarness.activeFailures = 1; });
  // Unlike navigate(), this expects the destination to become busy through auto-attachment.
  await page.evaluate(() => { location.hash = "/project/sample-app/thread/sample-app-1"; });
  await waitUntil(() => page.evaluate(() => window.__streamHarness.activeFailures === 0));
  await page.waitForTimeout(300);
  assert.equal((await records()).length, 3, "状态查询失败后应等待再重试");
  await waitUntil(async () => (await records()).length === 4);
  assert.equal((await records())[3].path, "/api/chat/job-events");
  await emit(3, "delta", { text: "重放输出唯一标记" });
  await navigate("sample-app-2");
  await page.evaluate(() => { location.hash = "/project/sample-app/thread/sample-app-1"; });
  await waitUntil(async () => (await records()).length === 5);
  assert.equal((await records())[3].aborted, true);
  assert.equal((await records())[4].path, "/api/chat/job-events");
  await emit(4, "delta", { text: "重放输出唯一标记" });
  await page.evaluate(() => window.__streamHarness.records[4].fail());
  await page.waitForTimeout(500);
  assert.equal((await records()).length, 5, "重连不应立即循环请求");
  await waitUntil(async () => (await records()).length === 6);
  await emit(5, "delta", { text: "重放输出唯一标记" });
  await page.getByText("重放输出唯一标记", { exact: true }).waitFor();
  assert.equal(await page.getByText("重放输出唯一标记", { exact: true }).count(), 1);
  assert.equal(await page.getByText("验收模拟连接断开重放输出唯一标记", { exact: true }).count(), 0);
  assert.equal(await busy().count(), 1);
  assert.equal(await page.locator(".chat-bubble.streaming").filter({ hasText: "重放输出唯一标记" }).count(), 1);
  await page.screenshot({ path: new URL("desktop-reconnected.png", out).pathname, fullPage: true });
  await navigate("sample-service-1");
  assert.equal((await records())[5].aborted, true);
  activeJobs.clear();
  assert.equal(await page.evaluate(() => window.__streamHarness.interrupts), 0);
  return ["压缩切换会话只取消订阅", "旧流结束不释放新任务", "Review 离开后不污染其他会话", "聊天生成状态持续保留", "回到运行中会话重新订阅", "状态查询失败后自动重试", "重连退避避免请求风暴", "事件重放不重复输出或残留错误", "跨项目离开不终止云端任务"];
}
