import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";
import { chromium } from "playwright";
import { verifyConversationStreams } from "./verify-stream-ui.mjs";

const source = await fs.readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const fixtureContext = { Date };
vm.createContext(fixtureContext);
const start = source.indexOf("const fallbackRun =");
const end = source.indexOf("\nfunction cx(", start);
vm.runInContext(ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText + "\nglobalThis.statusFixture = fallbackStatus;", fixtureContext);
const status = JSON.parse(JSON.stringify(fixtureContext.statusFixture));
status.health.ok = true;
status.health.layers.appServer = { ok: true, running: true };
const runtime = { model: "gpt-5.6-terra", reasoning: "medium", sandbox: "workspace-write", approval: "never", search: true };
const sessions = status.repos.flatMap((repo) => [1, 2].map((n) => ({ id: `${repo.id}-${n}`, repoId: repo.id, title: `验收会话 ${repo.id} ${n}`, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messageCount: 0, isDraft: true, ...runtime, draft: { input: "", attachments: [], revision: 0 } })));
const active = Object.fromEntries(status.repos.map((repo) => [repo.id, `${repo.id}-1`]));
const activeJobs = new Map();
const writes = [];
const errors = [];
let releaseUpload;
const uploadGate = new Promise((resolve) => { releaseUpload = resolve; });
let uploadStarted = false;
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
let createGate = null;
let createStarted = false;
let submissionGate = null;
let submissionStatus = 503;
let streamRejected = false;
let draftReadGate = null;
let draftReadStarted = false;
let submissions = 0;
let steers = 0;
const browser = await chromium.launch({ channel: process.env.CODEX_CLOUD_CHROME_CHANNEL || "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.route("**/healthz", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(status.health) }));
await context.route("**/api/**", async (route) => {
  const req = route.request(); const url = new URL(req.url());
  const body = req.postDataJSON() || {};
  const repoId = body.repoId || url.searchParams.get("repoId") || "sample-app";
  const send = (data, code = 200) => route.fulfill({ status: code, contentType: "application/json", body: JSON.stringify(data) });
  if (url.pathname === "/api/status") return send(status);
  if (url.pathname === "/api/codex/app-status") return send({ ok: true, authoritative: true, partial: false, account: null, mcpServers: [], plugins: { installed: 0, enabled: 0, available: 0, names: [] }, skills: { enabled: 0, total: 0, names: [], items: [] }, features: { enabled: 0, total: 0, names: [] }, permissionProfiles: [], config: runtime, gaps: [], auth: { ok: true } });
  if (url.pathname === "/api/codex/models") return send({ ok: true, models: [{ id: runtime.model, label: "GPT-5.6-Terra", supportedReasoningEfforts: ["medium"] }] });
  if (url.pathname === "/api/files/tree") return send({ ok: true, repoId, path: ".", entries: [{ name: "README.md", path: "README.md", type: "file", size: 12 }] });
  if (url.pathname === "/api/files/read") return send({ ok: true, repoId, path: "README.md", content: `${repoId} 原内容`, contentHash: `hash-${repoId}`, size: 12 });
  if (url.pathname === "/api/files/write") { writes.push(body); return send({ ok: true, ...body, contentHash: "saved" }); }
  if (url.pathname === "/api/chat/stream") {
    submissions += 1;
    await submissionGate?.promise;
    if (submissionStatus !== 200) return send({ ok: false, error: "验收模拟请求失败" }, submissionStatus);
    if (streamRejected) return route.fulfill({ status: 200, contentType: "text/event-stream", body: 'event: error\ndata: {"message":"初始化失败"}\n\nevent: done\ndata: {"ok":false}\n\n' });
    return route.fulfill({ status: 200, contentType: "text/event-stream", body: `event: meta\ndata: ${JSON.stringify({ sessionId: body.sessionId })}\n\nevent: done\ndata: ${JSON.stringify({ ok: true, sessionId: body.sessionId })}\n\n` });
  }
  if (url.pathname === "/api/codex/turn-steer") { steers += 1; return send({ ok: false, error: "当前没有运行任务" }, 409); }
  if (url.pathname === "/api/uploads") {
    uploadStarted = true; await uploadGate;
    return send({ ok: true, files: [{ name: "delayed.txt", path: ".codex-cloud/uploads/test/delayed.txt", mimeType: "text/plain", kind: "file", size: 3 }] });
  }
  const draftRoute = url.pathname.match(/^\/api\/chat\/sessions\/([^/]+)\/draft(\/attachments)?$/);
  if (draftRoute) {
    const session = sessions.find((item) => item.id === decodeURIComponent(draftRoute[1]));
    if (req.method() === "GET" && draftReadGate) { draftReadStarted = true; await draftReadGate.promise; }
    if (draftRoute[2]) {
      session.draft.attachments.push(...body.attachments); session.draft.revision += 1;
    } else if (req.method() === "PATCH") {
      if (body.expectedRevision !== session.draft.revision) return send({ ok: false, error: "草稿已在其他页面修改" }, 409);
      if (JSON.stringify([session.draft.input, session.draft.attachments]) !== JSON.stringify([body.input, body.attachments])) {
        session.draft = { input: body.input, attachments: body.attachments, revision: session.draft.revision + 1 };
      }
    }
    return send({ ok: true, repoId, sessionId: session.id, draft: session.draft });
  }
  const select = url.pathname.match(/^\/api\/chat\/sessions\/([^/]+)\/select$/);
  if (select) active[repoId] = decodeURIComponent(select[1]);
  if (url.pathname === "/api/chat/sessions" || select || url.pathname === "/api/chat/history") {
    if (url.pathname === "/api/chat/sessions" && req.method() === "POST") {
      createStarted = true;
      await createGate?.promise;
      const session = { ...sessions.find((s) => s.repoId === repoId), id: `${repoId}-new`, title: "新会话", draft: { input: "", attachments: [], revision: 0 } };
      sessions.push(session); active[repoId] = session.id;
    }
    const requested = url.searchParams.get("sessionId");
    if (requested) active[repoId] = requested;
    return send({ ok: true, authoritative: true, repoId, activeSessionId: active[repoId], sessions: sessions.filter((s) => s.repoId === repoId), messages: [] });
  }
  if (url.pathname === "/api/chat/active") return send({ ok: true, turn: activeJobs.get(url.searchParams.get("sessionId")) || null, compact: null });
  return send({ ok: true, ...runtime, entries: [], items: [], sessions: [], runs: [], events: [], matches: [], runtime });
});
const page = await context.newPage();
page.on("pageerror", (error) => errors.push(error.message));
page.on("dialog", (dialog) => dialog.accept());
const waitUntil = async (check) => { for (let n = 0; n < 100; n++) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 50)); } throw new Error("验收等待超时"); };
const baseUrl = process.env.CODEX_CLOUD_SAFETY_UI_URL || "http://127.0.0.1:5174/";
const out = new URL("../docs/research/acceptance/safety-ui-2026-09-19/", import.meta.url);
await fs.mkdir(out, { recursive: true });
try {
  await page.goto(`${baseUrl}#/agent`);
  await page.getByRole("button", { name: /README.md/ }).click();
  const editor = page.locator(".file-editor-card textarea");
  await editor.fill("A 项目的未保存修改");
  await page.locator(".sidebar").getByRole("button", { name: "sample-service", exact: true }).click();
  await page.getByRole("button", { name: "Agent", exact: true }).click();
  await waitUntil(() => page.locator(".file-editor-card button").isDisabled());
  assert.equal(await editor.inputValue(), "");
  assert.equal(writes.length, 0);
  await page.screenshot({ path: new URL("desktop-editor.png", out).pathname, fullPage: true });
  await page.goto(`${baseUrl}#/project/sample-app/thread/sample-app-1`);
  const composer = page.locator(".composer-shell textarea");
  await composer.waitFor();
  await page.locator('input[type="file"]').setInputFiles({ name: "delayed.txt", mimeType: "text/plain", buffer: Buffer.from("abc") });
  await waitUntil(() => uploadStarted);
  await page.evaluate(() => { location.hash = "/project/sample-app/thread/sample-app-2"; });
  await waitUntil(() => active["sample-app"] === "sample-app-2");
  releaseUpload();
  await waitUntil(() => sessions.find((s) => s.id === "sample-app-1").draft.attachments.length === 1);
  assert.equal(sessions.find((s) => s.id === "sample-app-2").draft.attachments.length, 0);
  assert.equal(await page.locator(".attachment-chip").count(), 0);
  await composer.fill("本机保留的草稿");
  await waitUntil(() => sessions.find((s) => s.id === "sample-app-2").draft.input === "本机保留的草稿");
  const current = sessions.find((s) => s.id === "sample-app-2");
  current.draft = { input: "其他页面的草稿", attachments: [], revision: current.draft.revision + 1 };
  await composer.fill("发生冲突后仍保留的草稿");
  await page.getByRole("button", { name: "载入云端草稿", exact: true }).waitFor();
  assert.equal(await composer.inputValue(), "发生冲突后仍保留的草稿");
  await page.screenshot({ path: new URL("desktop-conflict.png", out).pathname, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: new URL("mobile-conflict.png", out).pathname, fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  draftReadGate = deferred();
  await page.getByRole("button", { name: "载入云端草稿", exact: true }).click();
  await waitUntil(() => draftReadStarted);
  await composer.fill("解决冲突期间的新输入");
  draftReadGate.resolve();
  await waitUntil(async () => await page.getByRole("button", { name: "载入云端草稿", exact: true }).isEnabled());
  assert.equal(await composer.inputValue(), "解决冲突期间的新输入");
  draftReadGate = null;
  await page.getByRole("button", { name: "载入云端草稿", exact: true }).click();
  await waitUntil(async () => await composer.inputValue() === "其他页面的草稿");
  assert.equal(await page.locator(".draft-conflict").count(), 0);

  await page.setViewportSize({ width: 1440, height: 1000 });
  createGate = deferred();
  await page.getByRole("button", { name: "新会话", exact: true }).click();
  await waitUntil(() => createStarted);
  await page.locator(".sidebar").getByRole("button", { name: "sample-service", exact: true }).click();
  await waitUntil(() => page.url().includes("/sample-service/thread/sample-service-1"));
  await composer.fill("B 项目不能被迟到响应覆盖");
  createGate.resolve();
  await waitUntil(() => sessions.some((s) => s.id === "sample-app-new"));
  await page.waitForTimeout(650);
  assert.equal(await composer.inputValue(), "B 项目不能被迟到响应覆盖");
  assert.match(page.url(), /sample-service/);

  submissionGate = deferred();
  await composer.fill("发送失败后保留的输入");
  await composer.press("Enter");
  await waitUntil(() => submissions === 1);
  await composer.press("Enter");
  await page.waitForTimeout(650);
  assert.equal(await composer.inputValue(), "发送失败后保留的输入");
  assert.equal(steers, 0);
  submissionGate.resolve();
  await page.getByRole("button", { name: "发送消息", exact: true }).waitFor();
  assert.equal(await composer.inputValue(), "发送失败后保留的输入");
  assert.equal(sessions.find((s) => s.id === active["sample-service"]).draft.input, "发送失败后保留的输入");

  submissionStatus = 200;
  streamRejected = true;
  submissionGate = null;
  await composer.press("Enter");
  await waitUntil(() => submissions === 2);
  await page.getByRole("button", { name: "发送消息", exact: true }).waitFor();
  assert.equal(await composer.inputValue(), "发送失败后保留的输入");
  streamRejected = false;
  submissionGate = deferred();
  await composer.press("Enter");
  await waitUntil(() => submissions === 3);
  await composer.fill("等待期间编辑的新输入");
  submissionGate.resolve();
  await page.getByRole("button", { name: "发送消息", exact: true }).waitFor();
  assert.equal(await composer.inputValue(), "等待期间编辑的新输入");
  await waitUntil(() => sessions.find((s) => s.id === active["sample-service"]).draft.input === "等待期间编辑的新输入");
  await page.screenshot({ path: new URL("desktop-send-safety.png", out).pathname, fullPage: true });
  submissionGate = null;
  await composer.press("Enter");
  await waitUntil(() => submissions === 4);
  await waitUntil(async () => await composer.inputValue() === "");
  await waitUntil(() => sessions.find((s) => s.id === active["sample-service"]).draft.input === "");
  const streamChecks = await verifyConversationStreams({ page, baseUrl, sessions, activeJobs, waitUntil, out });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, checks: ["跨项目文件保护", "延迟上传归属", "草稿冲突保留与解决", "桌面与移动端无横向溢出", "迟到会话操作不覆盖新项目", "发送失败保留草稿", "等待接受期间禁止重复提交", "发送成功保留等待期间的新输入", "流式初始化失败保留草稿", "成功发送后清空已提交草稿", "冲突处理不覆盖期间的新输入", ...streamChecks], screenshots: out.pathname }, null, 2));
} finally {
  releaseUpload(); createGate?.resolve(); submissionGate?.resolve(); draftReadGate?.resolve(); await browser.close();
}
