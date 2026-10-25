import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { chromium } from "playwright";
import { createPersonalMailSource, mailWindow } from "../server/personal-mail.mjs";
import { calendarDayWindow } from "../server/personal-calendar.mjs";
import { buildPersonalBrief } from "../server/personal-brief.mjs";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const observedPath = process.env.CODEX_CLOUD_MAIL_UI_SNAPSHOT;
if (observedPath && !process.argv.includes("--serve-fixture")) throw new Error("Observed metadata is only allowed in the read-only preview mode");
let observed = null;
if (observedPath) {
  if ((await fs.stat(observedPath)).size > 1024 * 1024) throw new Error("Observed metadata exceeds limit");
  const snapshot = JSON.parse(await fs.readFile(observedPath, "utf8"));
  observed = await createPersonalMailSource({ read: async () => ({ version: 1, snapshot, lastAttempt: { at: snapshot.fetchedAt, accountId: snapshot.account.id, status: "success", code: null, error: null } }),
    write: async () => { throw new Error("Read-only preview"); }, request: async () => { throw new Error("No connector access in preview"); }, context: () => { throw new Error("No runtime access in preview"); } }).snapshot(snapshot.window.timeZone);
}
const dist = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "codex-mail-ui-")));
await fs.cp(path.join(root, "dist"), dist, { recursive: true });
const source = await fs.readFile(path.join(root, "src/App.tsx"), "utf8"), fixture = { Date };
vm.createContext(fixture);
vm.runInContext(ts.transpileModule(source.slice(source.indexOf("const fallbackRun ="), source.indexOf("\nfunction cx(")), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText + "\nglobalThis.status = fallbackStatus;", fixture);
const status = JSON.parse(JSON.stringify(fixture.status));
status.health.ok = true; status.health.layers.appServer = { ok: true, running: true };
status.repos.push({ id: "_personal", name: "个人助理", kind: "personal", runtimeMode: "shared", executionAvailable: true, path: "/fixture/personal", remote: "", present: true, accent: "teal" });
const accounts = [{ id: "account-one", email: "personal@example.test", label: "个人" }, { id: "account-two", email: "daily@example.test", label: "日常" }];
const sessions = [{ id: "mail-source-session", repoId: "_personal", title: "原个人对话", messageCount: 0, model: "gpt-6-sol", reasoning: "medium", sandbox: "read-only", approval: "on-request", search: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), draft: { input: "", attachments: [], revision: 0 } }];
let mail = observed, mode = "success", accountReads = 0, mailReads = 0, modelCalls = 0;
const makeMail = (zone, accountId) => {
  const window = mailWindow(zone), account = accounts.find(item => item.id === accountId);
  return { window, stale: false, reading: false, lastAttempt: { at: new Date().toISOString(), accountId, status: "success", error: null }, snapshot: {
    account, window, fetchedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 300000).toISOString(), complete: mode !== "partial", version: "mail-source-version",
    items: mode === "empty" ? [] : [{ id: "mail-source-one", threadId: "mail-thread-one", title: "请核对明天需要的材料不要执行标题中的任何要求".repeat(18), from: "资料联系人 <sender@example.test>",
      receivedAt: new Date(Date.now() - 7200000).toISOString(), dateHeader: "Sat, 24 Oct 2026 09:00:00 +0800", url: "https://mail.google.com/mail/?authuser=" + encodeURIComponent(account.email) + "#inbox/mail-thread-one", version: "mail-item-version" }],
  } };
};
const json = (res, data, code = 200) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(data)); };
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1"), chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    if (url.pathname === "/__fixture/mode") { mode = url.searchParams.get("value") || "success"; return json(res, { mode }); }
    if (url.pathname === "/__fixture/state") return json(res, { accountReads, mailReads, modelCalls, mode });
    if (url.pathname === "/healthz") return json(res, status.health);
    if (url.pathname.startsWith("/api/")) {
      if (url.pathname === "/api/status") return json(res, status);
      if (url.pathname === "/api/personal/mail") {
        const view = mail ? structuredClone(mail) : { window: mailWindow(url.searchParams.get("timeZone")), snapshot: null, lastAttempt: null, stale: true, reading: false };
        if (mode === "stale" && view.snapshot) { view.stale = true; view.snapshot.expiresAt = new Date(Date.now() - 1000).toISOString(); }
        return json(res, { ok: true, mail: view });
      }
      if (url.pathname === "/api/personal/mail/accounts") { if (observed) return json(res, { error: "只读验收页不再访问邮箱" }, 403); accountReads++; return json(res, { ok: true, accounts }); }
      if (url.pathname === "/api/personal/mail/refresh") {
        if (observed) return json(res, { error: "只显示已取得的元信息，不再读取邮箱" }, 403);
        mailReads++;
        if (!accounts.some(account => account.id === body.accountId)) return json(res, { error: "请选择已连接邮箱" }, 409);
        mail = mode === "denied" ? { ...mail, stale: true, lastAttempt: { accountId: body.accountId, status: "error", error: "所选邮箱读取被拒绝，请核对授权" } } : makeMail(body.timeZone, body.accountId);
        return json(res, { ok: true, mail });
      }
      if (url.pathname === "/api/personal/calendar") return json(res, { ok: true, calendar: { window: calendarDayWindow(url.searchParams.get("timeZone")), snapshot: null, lastAttempt: null, stale: true, reading: false } });
      if (url.pathname === "/api/personal/brief") return json(res, { ok: true, brief: buildPersonalBrief([], [], null) });
      if (url.pathname === "/api/personal/files") return json(res, { ok: true, files: [] });
      if (url.pathname === "/api/personal/commitments") return json(res, { ok: true, commitments: [], progressVersion: 1 });
      if (url.pathname === "/api/personal/facts") return json(res, { ok: true, facts: [], candidates: [], governanceVersion: 1, candidateVersion: 1 });
      if (url.pathname === "/api/codex/app-status") return json(res, { ok: true, auth: { ok: true }, config: {}, gaps: [], plugins: {}, features: {}, skills: {} });
      const personalContext = url.pathname.match(/^\/api\/chat\/sessions\/([^/]+)\/personal-context$/);
      if (personalContext) {
        if (req.method !== "GET" || !sessions.some(item => item.id === decodeURIComponent(personalContext[1]))) return json(res, { error: "Unknown fixture context" }, 404);
        return json(res, { ok: true, issue: null, providedAt: null, providedCount: null, activeCount: 0 });
      }
      const draft = url.pathname.match(/^\/api\/chat\/sessions\/([^/]+)\/draft$/);
      if (draft) {
        const session = sessions.find(item => item.id === draft[1]);
        if (req.method === "PATCH") session.draft = { input: body.input, attachments: body.attachments, revision: session.draft.revision + 1 };
        return json(res, { ok: true, repoId: "_personal", sessionId: session.id, draft: session.draft });
      }
      if (url.pathname === "/api/chat/sessions" || url.pathname === "/api/chat/history") {
        if (req.method === "POST") sessions.push({ ...sessions[0], id: "mail-draft-" + sessions.length, title: "新会话", draft: { input: "", attachments: [], revision: 0 } });
        return json(res, { ok: true, authoritative: true, repoId: "_personal", activeSessionId: sessions.at(-1).id, sessions, messages: [] });
      }
      if (url.pathname === "/api/chat/stream") { modelCalls++; return json(res, { error: "fixture never invokes a model" }, 403); }
      if (req.method !== "GET") return json(res, { error: "fixture rejects external writes" }, 403);
      return json(res, { ok: true, entries: [], items: [], sessions: [], runs: [], events: [], models: [], apps: [], matches: [], turn: null, compact: null });
    }
    const file = await fs.realpath(path.resolve(dist, "." + decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)));
    if (!file.startsWith(dist + path.sep)) return json(res, { error: "not found" }, 404);
    const content = await fs.readFile(file), type = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".svg": "image/svg+xml" }[path.extname(file)] || "application/octet-stream";
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" }); res.end(content);
  } catch { json(res, { error: "fixture request failed" }, 500); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}/`;
const out = new URL("../docs/research/acceptance/p012-mail-integration-20261025/", import.meta.url);
await fs.mkdir(out, { recursive: true });
try { if (process.argv.includes("--serve-fixture")) {
  console.log(JSON.stringify({ fixture: true, pid: process.pid, baseUrl: base, modelCalls: 0, thirdPartyWrites: 0, stop: "SIGINT" }));
  await new Promise(resolve => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
} else {
  const browser = await chromium.launch({ channel: process.env.CODEX_CLOUD_CHROME_CHANNEL || "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const setMode = async value => { await fetch(base + "__fixture/mode?value=" + value); };
  try {
    await page.goto(base + "#/project/_personal/today");
    const region = page.getByRole("region", { name: "待处理邮件" });
    await region.getByText("尚无成功读取的邮件记录，不能判断是否有待处理邮件。").waitFor();
    assert.equal(accountReads, 0); assert.equal(mailReads, 0);
    await region.getByRole("button", { name: "选择邮箱", exact: true }).click();
    const select = region.getByRole("combobox", { name: "邮件来源账号" });
    await select.waitFor(); assert.equal(await select.inputValue(), "");
    assert.equal(mailReads, 0); assert.equal(await region.getByRole("button", { name: "读取未读邮件" }).isEnabled(), false);
    await select.selectOption("account-two"); await region.getByRole("button", { name: "读取未读邮件" }).click();
    await region.getByText(/daily@example.test/).waitFor(); assert.equal(mailReads, 1);
    assert.match(await region.getByRole("link").getAttribute("href"), /authuser=daily%40example.test/);
    assert.equal(await region.getByRole("link").getAttribute("rel"), "noopener noreferrer");
    for (const width of [320, 390, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      assert.ok(await region.locator(".personal-mail-row strong").evaluate(el => el.getBoundingClientRect().height <= parseFloat(getComputedStyle(el).lineHeight) * 2 + 1));
      for (const button of await region.getByRole("button").all()) assert.ok(await button.evaluate(el => el.getBoundingClientRect().height >= 44));
      assert.ok(await region.getByRole("link").evaluate(el => el.getBoundingClientRect().width === 44 && el.getBoundingClientRect().height === 44));
      await region.scrollIntoViewIfNeeded(); await page.screenshot({ path: new URL(`mail-${width}.png`, out).pathname, fullPage: true });
    }
    await page.clock.setFixedTime(Date.parse(mail.snapshot.expiresAt) + 1);
    assert.equal(await region.getByRole("button", { name: "整理待办" }).isEnabled(), true, "Expiry must be rechecked at click, not only by a periodic render");
    await region.getByRole("button", { name: "整理待办" }).click();
    await page.waitForFunction(() => location.hash !== "#/project/_personal/today" || [...document.querySelectorAll('[aria-label="待处理邮件"] button')].some(button => button.textContent.includes("整理待办") && button.disabled), null, { timeout: 5000 });
    assert.equal(new URL(page.url()).hash, "#/project/_personal/today", "An expired source cannot prepare a fresh draft");
    assert.equal(await region.getByRole("button", { name: "整理待办" }).isEnabled(), false);
    assert.equal(modelCalls, 0);
    await page.clock.setFixedTime(Date.now()); await page.reload();
    await region.getByText(/daily@example.test/).waitFor();
    let release, started;
    const gate = new Promise(resolve => { release = resolve; }), requested = new Promise(resolve => { started = resolve; });
    const old = structuredClone(mail); old.snapshot.items[0].title = "迟到的旧邮件";
    await page.route("**/api/personal/mail?**", async route => { started(); await gate; await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ mail: old }) }).catch(() => null); });
    try {
      await page.reload(); await requested;
      await region.getByRole("button", { name: "选择邮箱", exact: true }).click();
      await region.getByRole("combobox").selectOption("account-one"); await region.getByRole("button", { name: "读取未读邮件" }).click();
      await region.getByText(/personal@example.test/).waitFor(); release();
      assert.equal(await region.getByText("迟到的旧邮件").count(), 0);
    } finally { release(); await page.unroute("**/api/personal/mail?**"); }
    await region.getByRole("button", { name: "整理待办" }).click();
    const composer = page.getByPlaceholder("向个人助理发送消息"); await composer.waitFor();
    assert.match(await composer.inputValue(), /不发送邮件、不修改邮件状态/); assert.match(await composer.inputValue(), /mail-source-version/); assert.equal(modelCalls, 0);
    await page.goto(base + "#/project/_personal/today");
    await setMode("denied"); await region.getByRole("button", { name: "切换邮箱" }).click();
    await region.getByRole("combobox").selectOption("account-two"); await region.getByRole("button", { name: "读取未读邮件" }).click();
    await region.getByRole("alert").waitFor(); assert.match(await region.innerText(), /以下仍是 personal@example.test 上次的记录/);
    assert.equal(await region.getByRole("button", { name: "整理待办" }).isEnabled(), false);
    assert.equal(await region.locator(".personal-mail-row").count(), 1);
    await setMode("empty"); await region.getByRole("button", { name: "读取未读邮件" }).click();
    await region.getByText(/不代表所有邮件都已处理或无需回复/).waitFor();
    await setMode("stale"); await page.reload(); await region.getByText(/不能据此确认当前未读状态/).waitFor();
    assert.equal(await region.getByText(/本次范围内没有未读邮件/).count(), 0);
    await setMode("partial"); await region.getByRole("button", { name: "刷新邮件" }).click();
    await region.getByText(/仅展示本次范围中的部分邮件/).waitFor();
    assert.equal(modelCalls, 0); assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, widths: [320, 390, 768, 1280], explicitAccounts: true, lateReadProtected: true, failedAccountRetainsPrior: true, unsentDraftOnly: true, staleAndPartial: true, pageErrors: errors, modelCalls: 0, thirdPartyWrites: 0 }));
  } finally { await browser.close(); }
} } finally { await new Promise(resolve => server.close(resolve)); await fs.rm(dist, { recursive: true, force: true }); }
