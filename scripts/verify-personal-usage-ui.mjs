import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";
import { chromium } from "playwright";

const source = await fs.readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const fixture = { Date };
vm.createContext(fixture);
const start = source.indexOf("const fallbackRun =");
const end = source.indexOf("\nfunction cx(", start);
vm.runInContext(ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText + "\nglobalThis.statusFixture = fallbackStatus;", fixture);
const status = JSON.parse(JSON.stringify(fixture.statusFixture));
status.health.ok = true;
status.health.layers.appServer = { ok: true, running: true };
status.repos.push({ id: "_personal", name: "个人助理", kind: "personal", runtimeMode: "shared", executionAvailable: true, path: "/tmp/personal", remote: "", accent: "teal", present: true, branch: "", commit: "", dirty: false, statusText: "个人空间 · 共用账号", lastCommit: "非 Git 空间" });
status.diagnostics = { repoId: "sample-app", generatedAt: new Date().toISOString(), ok: false, summary: { total: 1, ok: 0, warn: 0, danger: 1 }, checks: [{ id: "old-work-auth", label: "其他项目的历史诊断", tone: "danger", ok: false, summary: "旧登录错误", detail: "", durationMs: 0 }] };
const sessions = ["sample-app", "_personal"].map((repoId) => ({
  id: `${repoId}-session`, repoId, title: `${repoId} 对话`, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  messageCount: 0, isDraft: true, draft: { input: "", attachments: [], revision: 0 }, model: "gpt-5.6-terra", reasoning: "medium",
  sandbox: repoId === "_personal" ? "read-only" : "danger-full-access", approval: repoId === "_personal" ? "on-request" : "never", search: true,
}));
let pending = [{
  id: "approval-test", method: "item/commandExecution/requestApproval", digest: "digest-test", owner: { repoId: "sample-app", sessionId: "sample-app-session" },
  createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), params: { command: "echo approval-check", cwd: "/tmp" },
}];
let decision = null;
let createdToken = "";
let personalLoginFlow = null;
let includeNewModel = false;
let selectedRuntime = null;
let appsFailure = false;
let submittedMessages = 0;
const errors = [];
const browser = await chromium.launch({ channel: process.env.CODEX_CLOUD_CHROME_CHANNEL || "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await context.route("**/healthz", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(status.health) }));
await context.route("**/api/**", async (route) => {
  const req = route.request();
  const url = new URL(req.url());
  const body = req.postDataJSON() || {};
  const repoId = body.repoId || url.searchParams.get("repoId") || "sample-app";
  const send = (data, code = 200) => route.fulfill({ status: code, contentType: "application/json", body: JSON.stringify(data) });
  if (url.pathname === "/api/status") return send(status);
  if (url.pathname === "/api/codex/apps") return appsFailure ? send({ ok: false, error: "服务暂不可用" }, 502) : send({ ok: true, runtimeVerified: true, runtimeScope: "shared", apps: [
    { id: "mail", name: "Gmail", description: "整理邮件", installUrl: "https://chatgpt.com/apps/gmail/mail", accessible: false, enabled: true, callable: false },
    { id: "calendar", name: "Calendar", description: "查看日程", installUrl: "https://chatgpt.com/apps/calendar/cal", accessible: true, enabled: true, callable: true },
    { id: "invalid", name: "Untrusted", description: "不可信授权链接", installUrl: "javascript:alert(1)", accessible: false, enabled: false, callable: null },
  ] });
  if (url.pathname === "/api/approvals") return send({ ok: true, pending });
  if (url.pathname === "/api/approvals/approval-test/decision") { decision = body; pending = []; return send({ ok: true }); }
  if (url.pathname === "/api/clients") {
    if (req.method() === "POST") { createdToken = "ccc_test-token-only-once"; return send({ ok: true, token: createdToken, client: { id: "new", name: body.name } }, 201); }
    return send({ ok: true, clients: [{ id: "client-a", name: "研究服务", tokenPrefix: "ccc_test", automationIds: [status.automations[0].id], createdAt: new Date().toISOString(), expiresAt: null, revokedAt: null, lastUsedAt: new Date().toISOString() }] });
  }
  if (url.pathname === "/api/clients/usage") return send({ ok: true, droppedRequests: 0,
    buckets: [{ hour: new Date().toISOString().slice(0, 13) + ":00:00Z", clientId: "client-a", requests: 2, accepted: 1, errors: 0, replayed: 1, polls: 3, controls: 1 }],
    runBuckets: [{ hour: new Date().toISOString().slice(0, 13) + ":00:00Z", clientId: "client-a", runs: 2, completed: 1, failed: 0, knownRuns: 1, unknownRuns: 1, inputTokens: 100, outputTokens: 20, totalTokens: 120 }],
    requests: [{ id: "request-1", clientId: "client-a", automationId: status.automations[0].id, trigger: "webhook", status: 200, runId: "run-1", deduplicated: false, durationMs: 5, time: new Date().toISOString() }],
  });
  if (url.pathname === "/api/codex/account/login") {
    personalLoginFlow = { loginId: "personal-login", type: "chatgptDeviceCode", status: "pending", userCode: "TEST-CODE", verificationUrl: "https://login.example.test/device" };
    return send({ ok: true, flow: personalLoginFlow, accountLogin: { active: personalLoginFlow, latest: personalLoginFlow, flows: [personalLoginFlow] } });
  }
  if (url.pathname === "/api/codex/app-status") return send({ ok: true, source: "app-server", authoritative: true, partial: false, account: { type: "chatgpt", email: "fixture@example.test", planType: "plus" }, auth: { ok: true }, accountLogin: { active: personalLoginFlow, latest: personalLoginFlow, flows: personalLoginFlow ? [personalLoginFlow] : [] }, mcpServers: [], plugins: { installed: 0, enabled: 0, available: 0, names: [] }, skills: { enabled: 0, total: 0, names: [], items: [] }, features: { enabled: 0, total: 0, names: [] }, permissionProfiles: [], config: {}, gaps: [] });
  if (url.pathname === "/api/codex/models") return send({ ok: true, source: "app-server", authoritative: true, models: [{ id: "gpt-5.6-terra", displayName: "GPT-5.6-Terra", defaultReasoningEffort: "medium", supportedReasoningEfforts: ["medium"] }, ...(includeNewModel ? [{ id: "gpt-6-astra", displayName: "GPT-6 Astra", defaultReasoningEffort: "medium", supportedReasoningEfforts: ["medium", "ultra"] }] : [])] });
  if (url.pathname.endsWith("/runtime") && req.method() === "PATCH") {
    selectedRuntime = body;
    Object.assign(sessions.find((item) => item.repoId === repoId), body);
    return send({ ok: true, runtime: body });
  }
  const draft = url.pathname.match(/^\/api\/chat\/sessions\/([^/]+)\/draft$/);
  if (draft) {
    const session = sessions.find((item) => item.id === decodeURIComponent(draft[1]));
    if (!session || session.repoId !== repoId) return send({ ok: false, error: "wrong space" }, 404);
    if (req.method() === "PATCH") session.draft = { input: body.input, attachments: body.attachments, revision: session.draft.revision + 1 };
    return send({ ok: true, repoId, sessionId: session.id, draft: session.draft });
  }
  if (url.pathname === "/api/chat/sessions" || url.pathname === "/api/chat/history") return send({ ok: true, authoritative: true, repoId, activeSessionId: `${repoId}-session`, sessions: sessions.filter((item) => item.repoId === repoId), messages: [] });
  if (url.pathname === "/api/chat/active") return send({ ok: true, turn: null, compact: null });
  if (url.pathname === "/api/chat/stream") { submittedMessages += 1; return send({ ok: false, error: "personal execution unavailable" }, 503); }
  return send({ ok: true, entries: [], items: [], sessions: [], runs: [], events: [], matches: [] });
});

const page = await context.newPage();
page.on("pageerror", (error) => errors.push(error.message));
const out = new URL("../docs/research/acceptance/personal-usage-2026-09-26/", import.meta.url);
await fs.mkdir(out, { recursive: true });
try {
  const baseUrl = process.env.CODEX_CLOUD_SAFETY_UI_URL || "http://127.0.0.1:5174/";
  await page.goto(`${baseUrl}#/project/sample-app/thread/sample-app-session`);
  await page.locator(".space-switch").getByRole("button", { name: "个人" }).click();
  await page.locator(".personal-scope-notice").waitFor();
  await page.locator(".session-current[data-session-id='_personal-session']").waitFor();
  assert.match(page.url(), /_personal/);
  assert.equal(await page.locator(".send-button").isDisabled(), true);
  const composer = page.locator(".composer-shell textarea");
  await page.getByRole("button", { name: /整理邮件待办/ }).click();
  assert.match(await composer.inputValue(), /不要代我发送邮件/);
  assert.equal(submittedMessages, 0);
  await page.getByRole("button", { name: "任务建议", exact: true }).click();
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.locator(".command-panel").getByRole("button", { name: /调研一个问题/ }).click();
  assert.match(await composer.inputValue(), /不要代我发送邮件/);
  await page.getByRole("button", { name: "关闭面板" }).click();
  await page.getByRole("button", { name: /^权限：/ }).click();
  assert.equal(await page.locator(".choice-list").getByRole("button", { name: /全权限/ }).count(), 0);
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: /^允许写入个人工作区/ }).click();
  assert.equal(selectedRuntime, null);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: /^允许写入个人工作区/ }).click();
  await page.getByRole("button", { name: /^权限：工作区写入/ }).waitFor();
  assert.equal(selectedRuntime.sandbox, "workspace-write");
  assert.equal(selectedRuntime.approval, "on-request");
  await page.getByRole("button", { name: "连接服务", exact: true }).click();
  const mailAuthorization = page.getByRole("link", { name: "连接Gmail" });
  await mailAuthorization.waitFor();
  assert.equal(await mailAuthorization.getAttribute("href"), "https://chatgpt.com/apps/gmail/mail");
  assert.equal(await mailAuthorization.getAttribute("rel"), "noopener noreferrer");
  assert.match(await page.locator(".connected-service-row").filter({ hasText: "Calendar" }).innerText(), /可调用/);
  assert.equal(await page.getByRole("link", { name: "连接Untrusted" }).count(), 0);
  await page.getByRole("textbox", { name: "搜索服务" }).fill("Gmail");
  assert.equal(await page.locator(".connected-service-row").count(), 1);
  await page.getByRole("textbox", { name: "搜索服务" }).fill("");
  await page.screenshot({ path: new URL("connections-desktop.png", out).pathname, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await page.screenshot({ path: new URL("connections-390.png", out).pathname, fullPage: true });
  appsFailure = true;
  await page.getByRole("button", { name: "刷新连接" }).click();
  await page.getByText("服务暂不可用", { exact: true }).waitFor();
  assert.equal(await page.locator(".connected-service-row").count(), 0);
  appsFailure = false;
  await page.getByRole("button", { name: "刷新连接" }).click();
  await mailAuthorization.waitFor();
  await page.getByRole("button", { name: "关闭面板" }).click();
  await page.setViewportSize({ width: 1280, height: 900 });
  await composer.fill("独立个人草稿");
  assert.equal(await page.locator(".send-button").isEnabled(), true);
  await page.locator(".space-switch").getByRole("button", { name: "工作" }).click();
  await page.locator(".session-current[data-session-id='sample-app-session']").waitFor();
  assert.equal(await composer.inputValue(), "");
  await page.locator(".space-switch").getByRole("button", { name: "个人" }).click();
  await page.locator(".session-current[data-session-id='_personal-session']").waitFor();
  assert.equal(await composer.inputValue(), "独立个人草稿");
  includeNewModel = true;
  await page.getByRole("button", { name: "模型：GPT-5.6-Terra", exact: true }).click();
  await page.getByRole("button", { name: /GPT-6 Astra gpt-6-astra/ }).click();
  await page.getByRole("button", { name: "模型：GPT-6 Astra", exact: true }).waitFor();
  assert.equal(selectedRuntime?.model, "gpt-6-astra");
  assert.equal(selectedRuntime?.reasoning, "medium");
  await page.getByRole("button", { name: "同意本次" }).click();
  assert.deepEqual(decision, { decision: "accept", digest: "digest-test" });
  await page.screenshot({ path: new URL("personal-desktop.png", out).pathname, fullPage: true });

  await page.locator(".space-switch").getByRole("button", { name: "工作" }).click();
  await page.getByRole("button", { name: /调用与用量/ }).click();
  await page.getByRole("heading", { name: "调用与用量" }).waitFor();
  assert.match(await page.locator(".usage-summary").innerText(), /120/);
  assert.match(await page.locator(".usage-view").innerText(), /1 次运行用量未知/);
  assert.match(await page.locator(".usage-summary").innerText(), /结果查询\s*3/);
  await page.getByRole("group", { name: "曲线指标" }).getByRole("button", { name: "查询" }).click();
  await page.getByRole("img", { name: "查询 趋势" }).waitFor();
  assert.ok(await page.locator('.usage-chart-column[title$=": 3"]').count());
  await page.getByRole("textbox", { name: "调用方名称" }).fill("第二个服务");
  await page.locator(".usage-scopes input[type='checkbox']").first().check();
  await page.getByRole("button", { name: "创建令牌" }).click();
  await page.getByText(createdToken).waitFor();
  await page.screenshot({ path: new URL("usage-desktop.png", out).pathname, fullPage: true });
  for (const width of [320, 360, 390, 430, 768, 820, 1280]) {
    await page.setViewportSize({ width, height: width <= 430 ? 800 : 900 });
    if (width <= 820) await page.getByRole("button", { name: "打开侧边栏" }).click();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    assert.equal(overflow, false, `horizontal overflow at ${width}px`);
    if (width <= 820) {
      await page.locator(".mobile-sidebar-close").click();
      const undersized = await page.locator(".usage-header .icon-button, .usage-client .icon-button, .usage-token button, .usage-filters button, .usage-filters select, .usage-section-head .usage-segmented button").evaluateAll((buttons) => buttons.filter((button) => {
        const rect = button.getBoundingClientRect();
        return rect.width < 44 || rect.height < 44;
      }).map((button) => button.outerHTML.slice(0, 160)));
      assert.deepEqual(undersized, [], `undersized usage controls at ${width}px`);
      await page.screenshot({ path: new URL(`usage-${width}.png`, out).pathname, fullPage: true });
      if (width === 390) {
        await page.getByRole("button", { name: "打开侧边栏" }).click();
        await page.locator(".space-switch").getByRole("button", { name: "个人" }).click();
        await page.locator(".session-current[data-session-id='_personal-session']").waitFor();
        await page.getByText("个人助理 · 共用账号 · 独立对话", { exact: true }).waitFor();
        await page.screenshot({ path: new URL("personal-390.png", out).pathname, fullPage: true });
        await page.getByRole("button", { name: "打开侧边栏" }).click();
        await page.locator(".space-switch").getByRole("button", { name: "工作" }).click();
        await page.getByRole("button", { name: "打开侧边栏" }).click();
        await page.getByRole("button", { name: /调用与用量/ }).click();
        await page.getByRole("heading", { name: "调用与用量" }).waitFor();
      }
    }
  }
  await page.goto(`${baseUrl}#/inbox`);
  await page.evaluate(() => localStorage.setItem("codex-cloud-last-space-repo", "_personal"));
  await page.reload();
  await page.locator(".personal-scope-notice").waitFor();
  await page.locator(".session-current[data-session-id='_personal-session']").waitFor();
  assert.match(page.url(), /#\/project\/_personal/);
  assert.equal(await page.getByText("仅草稿", { exact: true }).count(), 0);
  await page.evaluate(() => { window.open = () => null; });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByText("登录有效 · 与工作空间共用账号", { exact: true }).waitFor();
  assert.equal(await page.getByText("其他项目的历史诊断", { exact: true }).count(), 0);
  await page.getByRole("button", { name: "重新登录" }).first().click();
  const authorizationLink = page.getByRole("link", { name: "打开授权页" }).first();
  await authorizationLink.waitFor();
  assert.equal(await authorizationLink.getAttribute("href"), "https://login.example.test/device");
  assert.equal(await authorizationLink.getAttribute("rel"), "noopener noreferrer");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, checks: ["个人/工作切换与草稿保留", "个人空间共用登录且可发送", "打开模型列表发现新增模型并保留 medium", "一次性审批决定", "调用/token 摘要、查询趋势与未知用量", "新客户端令牌仅显示一次", "7 个宽度无横向溢出及移动触控尺寸", "390px 个人/工作侧栏切换", "个人空间刷新旧工作页深链回到个人对话", "不展示其他项目的历史诊断", "弹窗被拦截时仍可打开账号授权链接"], screenshots: out.pathname }, null, 2));
} finally { await browser.close(); }
