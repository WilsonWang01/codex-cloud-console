import assert from "node:assert/strict";

export async function verifyNavigationPerformance({ page, baseUrl, sessions, navigation, waitUntil, out }) {
  navigation.messages = Array.from({ length: 120 }, (_, i) => ({
    id: `perf-message-${i}`, role: "codex", time: new Date().toISOString(),
    text: `性能验收消息 ${i}\n\n| 项目 | 状态 |\n| --- | --- |\n| 切换 | 已验证 |\n\n${"包含 **格式化内容** 与 `代码片段`。\n".repeat(8)}`,
  }));
  const composer = page.locator(".composer-shell textarea");
  const ready = async (id) => {
    await page.locator(`.session-current[data-session-id="${id}"]`).waitFor();
    await waitUntil(() => composer.isEnabled());
  };
  const route = async (id) => page.evaluate((id) => { location.hash = `/project/sample-app/thread/${id}`; }, id);
  const histories = (id) => navigation.requests.filter((r) => r.path === "/api/chat/sessions" && r.method === "GET" && r.sessionId === id);
  await page.goto(`${baseUrl}#/project/sample-app/thread/sample-app-1`);
  await ready("sample-app-1");
  await page.locator(".chat-markdown table").first().waitFor();
  assert.equal(await page.locator(".chat-bubble.codex").count(), 120);
  const panelClose = page.locator(".command-panel-head button");
  if (await panelClose.count()) await panelClose.click();
  const client = await page.context().newCDPSession(page);
  await client.send("Profiler.enable");
  await client.send("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
  navigation.requests.length = 0;
  await route("sample-app-2");
  await ready("sample-app-2");
  await page.waitForTimeout(600);
  assert.equal(histories("sample-app-2").length, 1, "一次路由切换只能加载一次历史");
  assert.equal(navigation.requests.filter((r) => r.method === "PATCH" && r.path.endsWith("/draft")).length, 0, "未编辑的草稿不应重复写入");

  // A slow, obsolete response must neither retry nor clear the newer route intent.
  navigation.requests.length = 0;
  navigation.delays.set("sample-app-1", 900);
  await route("sample-app-1");
  await waitUntil(() => histories("sample-app-1").length === 1);
  assert.equal(await composer.isDisabled(), true);
  assert.equal(await page.locator('input[type="file"]').isDisabled(), true);
  await page.getByLabel("同步会话中", { exact: true }).waitFor();
  await route("sample-app-2");
  await ready("sample-app-2");
  await page.waitForTimeout(1200);
  assert.equal(histories("sample-app-1").length, 1);
  assert.equal(histories("sample-app-2").length, 1);
  assert.match(page.url(), /sample-app-2$/);
  assert.equal(await page.locator(".session-current").getAttribute("data-session-id"), "sample-app-2");
  navigation.delays.clear();

  const messageFunctions = (result) => result.flatMap((script) => script.functions).filter((fn) => /^ChatTimelineMessage\d*$/.test(fn.functionName));
  const renderCount = (result) => messageFunctions(result).reduce((sum, fn) => sum + fn.ranges[0].count, 0);
  const baseline = await client.send("Profiler.takePreciseCoverage");
  assert(renderCount(baseline.result) >= 120, "需要在未压缩的 Vite 验收服务上观察到消息渲染");
  await composer.fill("长对话输入不应重绘历史消息");
  await composer.pressSequentially("1234567890");
  await waitUntil(() => sessions.find((session) => session.id === "sample-app-2").draft.input.endsWith("1234567890"));
  const { result } = await client.send("Profiler.takePreciseCoverage");
  assert.equal(renderCount(result), 0, "输入不应重新解析历史消息");
  await client.send("Profiler.stopPreciseCoverage");
  await client.detach();
  await page.screenshot({ path: new URL("desktop-long-conversation.png", out).pathname, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await page.screenshot({ path: new URL("mobile-long-conversation.png", out).pathname, fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await composer.fill("");
  await waitUntil(() => sessions.find((session) => session.id === "sample-app-2").draft.input === "");
  navigation.messages = [];
  navigation.requests.length = 0;
  await composer.fill("跨项目切换前的草稿");
  await page.evaluate(() => { location.hash = "/project/sample-service/thread/sample-service-1"; });
  await ready("sample-service-1");
  await waitUntil(() => sessions.find((session) => session.id === "sample-app-2").draft.input === "跨项目切换前的草稿");
  const draftRequests = navigation.requests.filter((request) => request.path.includes("/sample-app-2/draft"));
  assert(draftRequests.length > 0);
  assert(draftRequests.every((request) => request.repoId === "sample-app"), "跨项目切换只能向原项目保存旧草稿");
  return ["每次路由切换只加载一次历史", "未编辑草稿切换时不写入", "快速切换取消旧请求且不重试", "历史加载期间保护输入", "120 条消息下输入不重绘历史", "跨项目路由保留草稿且不串项目"];
}
