import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
const issue = { number: 42, title: "Repair mobile navigation", body: "The mobile menu overlaps content.", url: "https://github.com/acme/project/issues/42", state: "OPEN", updatedAt: new Date().toISOString(), author: "reporter", labels: ["bug"], comments: [] };
const connection = { ghInstalled: true, authenticated: true, account: "alice", accessible: true, issuesEnabled: true, archived: false, reason: "", repo: { slug: "acme/project", url: "https://github.com/acme/project", permission: "WRITE", defaultBranch: "main" } };
const sessions = [{ id: "sample-app-session", repoId: "sample-app", title: "Previous task", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messageCount: 0, isDraft: true, draft: { input: "", attachments: [], revision: 0 }, model: "gpt-5.6-terra", reasoning: "medium", sandbox: "danger-full-access", approval: "never", search: true }];
let previewCalls = 0;
let publishCalls = 0;
let prepareCalls = 0;
let modelCalls = 0;
const errors = [];
const browser = await chromium.launch({ channel: process.env.CODEX_CLOUD_CHROME_CHANNEL || "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await context.route("**/healthz", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(status.health) }));
await context.route("**/api/**", async (route) => {
  const req = route.request();
  const url = new URL(req.url());
  const body = req.postData() ? req.postDataJSON() : {};
  const send = (data, code = 200) => route.fulfill({ status: code, contentType: "application/json", body: JSON.stringify(data) });
  if (url.pathname === "/api/status") return send(status);
  if (url.pathname === "/api/github/connection") return send({ ok: true, repoId: "sample-app", connection });
  if (url.pathname === "/api/github/issues" && req.method() === "GET") return send({ ok: true, repoId: "sample-app", connection, issues: url.searchParams.get("state") === "open" ? [issue] : [] });
  if (url.pathname === "/api/github/issues/42" && req.method() === "GET") return send({ ok: true, repoId: "sample-app", connection, issue });
  if (url.pathname === "/api/github/issues/42/prepare") {
    prepareCalls += 1;
    const session = { ...sessions[0], id: "issue-42-session", title: "Issue #42: Repair mobile navigation", sandbox: "workspace-write", approval: "on-request", draft: { input: "请处理 acme/project 的 GitHub Issue #42。", attachments: [], revision: 0 } };
    sessions.push(session);
    return send({ ok: true, repoId: "sample-app", activeSessionId: session.id, sessions, messages: [] });
  }
  if (url.pathname === "/api/github/issues/42/publish-preview") {
    previewCalls += 1;
    return send({ ok: true, repoId: "sample-app", preview: { previewId: "a".repeat(48), slug: "acme/project", branch: "codex/issue-42-navigation", baseBranch: "main", headSha: "b".repeat(40), remoteSha: "", commitCount: 1, commits: ["bbbbbbb Fix mobile navigation"], changedFileCount: 2, changedFiles: ["src/App.tsx", "src/styles.css"], title: "Fix #42: Repair mobile navigation", body: "Closes #42" } });
  }
  if (url.pathname === "/api/github/publish") { publishCalls += 1; assert.equal(body.previewId, "a".repeat(48)); return send({ ok: true, published: { url: "https://github.com/acme/project/pull/7" } }); }
  if (url.pathname === "/api/chat/sessions" && req.method() === "GET") return send({ ok: true, repoId: "sample-app", activeSessionId: sessions.at(-1).id, sessions, messages: [] });
  if (url.pathname === "/api/chat/sessions" && req.method() === "POST") return send({ ok: true, repoId: "sample-app", activeSessionId: sessions[0].id, sessions, messages: [] });
  if (url.pathname.match(/^\/api\/chat\/sessions\/[^/]+\/draft$/u)) return send({ ok: true, repoId: "sample-app", sessionId: url.pathname.split("/")[4], draft: sessions.at(-1).draft });
  if (url.pathname === "/api/chat/stream") { modelCalls += 1; return send({ ok: false, error: "model call is disabled in this test" }, 503); }
  if (url.pathname === "/api/chat/active") return send({ ok: true, turn: null, compact: null, queuedTurn: null });
  if (url.pathname === "/api/codex/app-status") return send({ ok: true, source: "app-server", authoritative: true, partial: false, account: { type: "chatgpt", email: "fixture@example.test" }, auth: { ok: true }, mcpServers: [], plugins: { installed: 0, enabled: 0, available: 0, names: [] }, skills: { enabled: 0, total: 0, names: [], items: [] }, features: { enabled: 0, total: 0, names: [] }, permissionProfiles: [], config: {}, gaps: [] });
  if (url.pathname === "/api/codex/models") return send({ ok: true, source: "app-server", authoritative: true, models: [{ id: "gpt-5.6-terra", displayName: "GPT-5.6-Terra", defaultReasoningEffort: "medium", supportedReasoningEfforts: ["medium"] }] });
  return send({ ok: true, sessions: [], runs: [], entries: [], items: [], events: [] });
});

const page = await context.newPage();
page.on("pageerror", (error) => errors.push(error.message));
const baseUrl = process.env.CODEX_CLOUD_SAFETY_UI_URL || "http://127.0.0.1:5175/";
const screenshots = await fs.mkdtemp(path.join(os.tmpdir(), "codex-github-ui-"));
try {
  await page.goto(`${baseUrl}#/project/sample-app/issues`);
  await page.getByRole("heading", { name: "GitHub Issues" }).waitFor();
  await page.getByRole("button", { name: /#42 Repair mobile navigation/u }).click();
  await page.getByText("The mobile menu overlaps content.").waitFor();
  await page.screenshot({ path: path.join(screenshots, "desktop.png"), fullPage: true });
  await page.getByRole("button", { name: "预览发布 PR" }).click();
  await page.getByRole("dialog", { name: "确认发布 GitHub PR" }).waitFor();
  await page.getByText("src/App.tsx", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(screenshots, "publish-preview.png"), fullPage: false });
  assert.equal(publishCalls, 0);
  assert.equal(await page.getByRole("button", { name: "确认发布" }).isDisabled(), true);
  await page.keyboard.press("Shift+Tab");
  assert.equal(await page.getByRole("button", { name: "取消" }).evaluate((element) => document.activeElement === element), true);
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("dialog", { name: "确认发布 GitHub PR" }).count(), 0);
  await page.getByRole("button", { name: "预览发布 PR" }).click();
  await page.getByRole("checkbox", { name: /我已核对/u }).check();
  await page.getByRole("button", { name: "确认发布" }).click();
  await page.getByRole("link", { name: /查看 PR/u }).waitFor();
  assert.equal(previewCalls, 2);
  assert.equal(publishCalls, 1);
  await page.getByRole("button", { name: "建立开发任务" }).click();
  await page.locator(".composer-shell textarea").waitFor();
  assert.match(await page.locator(".composer-shell textarea").inputValue(), /Issue #42/u);
  assert.equal(prepareCalls, 1);
  assert.equal(modelCalls, 0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}#/project/sample-app/issues`);
  await page.getByRole("heading", { name: "GitHub Issues" }).waitFor();
  await page.getByText("The mobile menu overlaps content.").waitFor();
  await page.screenshot({ path: path.join(screenshots, "mobile.png"), fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 1, `mobile horizontal overflow: ${overflow}px`);
  await page.getByRole("button", { name: "预览发布 PR" }).click();
  const mobileDialog = page.getByRole("dialog", { name: "确认发布 GitHub PR" });
  await mobileDialog.waitFor();
  const bounds = await mobileDialog.boundingBox();
  assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 391, `mobile dialog exceeds viewport: ${JSON.stringify(bounds)}`);
  await page.screenshot({ path: path.join(screenshots, "publish-preview-mobile.png"), fullPage: false });
  assert.deepEqual(errors, []);
  process.stdout.write(`GitHub UI acceptance passed. Screenshots: ${screenshots}\n`);
} finally {
  await browser.close();
}
