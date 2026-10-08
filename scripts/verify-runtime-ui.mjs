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
vm.runInContext(ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText + "\nglobalThis.status = fallbackStatus;", fixture);
const status = JSON.parse(JSON.stringify(fixture.status));
status.health.ok = true;
status.health.layers.appServer = { ok: true, running: true };
status.repos.push({ id: "_personal", name: "个人助理", kind: "personal", runtimeMode: "shared", executionAvailable: true, path: "/tmp/personal", remote: "", accent: "teal", present: true, branch: "", commit: "", dirty: false, statusText: "个人空间", lastCommit: "非 Git 空间" });
const runtime = (n) => ({ model: n === 1 ? "gpt-6-sol" : "gpt-6-luna", reasoning: n === 1 ? "medium" : "low", sandbox: n === 1 ? "workspace-write" : "read-only", approval: "on-request", search: true });
const sessions = ["sample-app", "_personal"].flatMap((repoId) => [1, 2].map((n) => ({
  id: `${repoId}-${n}`, codexSessionId: `${repoId}-thread-${n}`, repoId, title: `对话 ${n}`,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messageCount: 0, isDraft: false,
  ...runtime(n), draft: { input: "", attachments: [], revision: 0 },
})));
const active = { "sample-app": "sample-app-1", "_personal": "_personal-1" };
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
let historyGate = null;
let saveGate = null;
const writes = [];
const errors = [];
const baseUrl = process.env.CODEX_CLOUD_UI_URL || "http://127.0.0.1:5174/";
const out = new URL("../docs/research/acceptance/runtime-switch-2026-10-08/", import.meta.url);
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: process.env.CODEX_CLOUD_CHROME_CHANNEL || "chrome", headless: true });
try {
  const context = await browser.newContext();
  await context.route("**/healthz", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(status.health) }));
  await context.route("**/api/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const body = req.postDataJSON() || {};
    const repoId = body.repoId || url.searchParams.get("repoId") || "sample-app";
    const send = (data, code = 200) => route.fulfill({ status: code, contentType: "application/json", body: JSON.stringify(data) });
    if (url.pathname === "/api/status") return send(status);
    if (url.pathname === "/api/codex/app-status") return send({ ok: true, authoritative: true, partial: false, account: null, auth: { ok: true }, mcpServers: [], plugins: { installed: 0, enabled: 0, available: 0, names: [] }, skills: { enabled: 0, total: 0, names: [], items: [] }, features: { enabled: 0, total: 0, names: [] }, permissionProfiles: [], config: {}, gaps: [] });
    if (url.pathname === "/api/codex/models") return send({ ok: true, source: "app-server", authoritative: true, models: [
      { id: "gpt-6-sol", displayName: "GPT-6 Sol", supportedReasoningEfforts: ["medium", "high"], defaultReasoningEffort: "medium" },
      { id: "gpt-6-luna", displayName: "GPT-6 Luna", supportedReasoningEfforts: ["low", "medium"], defaultReasoningEffort: "low" },
      { id: "gpt-6-astra", displayName: "GPT-6 Astra", supportedReasoningEfforts: ["medium", "high"], defaultReasoningEffort: "medium" },
    ] });
    const patch = url.pathname.match(/^\/api\/chat\/sessions\/([^/]+)\/runtime$/);
    if (patch) {
      const session = sessions.find((s) => s.id === decodeURIComponent(patch[1]));
      assert.equal(session.repoId, repoId);
      writes.push({ sessionId: session.id, ...body });
      Object.assign(session, body);
      const response = { ok: true, runtime: { ...body } };
      if (saveGate) { const gate = saveGate; gate.started.resolve(); await gate.release.promise; }
      return send(response);
    }
    const select = url.pathname.match(/^\/api\/chat\/sessions\/([^/]+)\/select$/);
    if (url.pathname === "/api/chat/sessions" || select) {
      const requested = select ? decodeURIComponent(select[1]) : url.searchParams.get("sessionId");
      if (historyGate && (!historyGate.target || requested === historyGate.target)) {
        const gate = historyGate;
        gate.started.resolve();
        await gate.release.promise;
        if (gate.fail) return send({ error: "模拟切换失败" }, 503);
      }
      if (requested) {
        const session = sessions.find((s) => s.repoId === repoId && (s.id === requested || s.codexSessionId === requested));
        if (session) active[repoId] = session.id;
      }
      return send({ ok: true, authoritative: true, repoId, activeSessionId: active[repoId], sessions: sessions.filter((s) => s.repoId === repoId), messages: [] });
    }
    if (url.pathname === "/api/codex/thread-state") {
      const session = sessions.find((s) => s.id === url.searchParams.get("sessionId"));
      const value = session && Object.fromEntries(["model", "reasoning", "sandbox", "approval", "search"].map((key) => [key, session[key]]));
      return send({ ok: true, source: "app-server", authoritative: true, repoId, sessionId: session?.id, runtime: value, config: {} });
    }
    const draft = url.pathname.match(/^\/api\/chat\/sessions\/([^/]+)\/draft$/);
    if (draft) {
      const session = sessions.find((s) => s.id === decodeURIComponent(draft[1]));
      if (req.method() === "PATCH") session.draft = { input: body.input, attachments: body.attachments, revision: session.draft.revision + 1 };
      return send({ ok: true, repoId, sessionId: session.id, draft: session.draft });
    }
    return send({ ok: true, entries: [], items: [], sessions: [], runs: [], events: [], matches: [], turn: null, compact: null });
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  const settings = () => page.getByRole("button", { name: /^会话设置：/ });
  const ready = async (repoId, n) => {
    await page.locator(`.session-current[data-session-id='${repoId}-${n}']`).waitFor();
    await page.getByLabel("同步会话中", { exact: true }).waitFor({ state: "hidden" });
    const expected = n === 1 ? "GPT-6 Sol" : "GPT-6 Luna";
    if (repoId === "_personal") await settings().filter({ hasText: expected }).waitFor();
    else await page.getByRole("button", { name: `模型：${expected}`, exact: true }).waitFor();
  };
  const openModel = async (repoId) => {
    if (repoId === "_personal") {
      await settings().click();
      await page.locator(".personal-session-settings").getByRole("button", { name: /模型/ }).click();
    } else await page.getByRole("button", { name: /^模型：/ }).click();
  };
  const assertLoading = async (repoId) => {
    await page.getByLabel("同步会话中", { exact: true }).waitFor();
    if (repoId === "_personal") {
      assert.equal(await settings().isDisabled(), true, "同步中的个人会话不能修改设置");
      assert.doesNotMatch(await settings().textContent(), /GPT|工作区写入|只读/);
    } else {
      for (const name of [/^模型：/, /^权限：/, /^推理深度：/]) {
        const button = page.getByRole("button", { name });
        assert.equal(await button.isDisabled(), true, "同步中的工作会话不能修改设置");
        assert.doesNotMatch(await button.textContent(), /GPT|工作区写入|只读/);
      }
    }
    assert.equal(await page.locator(".command-panel").isVisible(), false, "切换时立即隐藏已打开的旧设置");
  };
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: width === 1280 ? 900 : 844 });
    for (const repoId of ["_personal", "sample-app"]) {
      for (const n of [1, 2]) Object.assign(sessions.find((s) => s.id === `${repoId}-${n}`), runtime(n));
      active[repoId] = `${repoId}-1`;
      historyGate = { target: `${repoId}-thread-1`, started: deferred(), release: deferred() };
      await page.goto(`${baseUrl}#/project/${repoId}/thread/${repoId}-thread-1`);
      await historyGate.started.promise;
      await assertLoading(repoId);
      historyGate.release.resolve();
      historyGate = null;
      await ready(repoId, 1);
      await openModel(repoId);
      const before = writes.length;
      historyGate = { target: `${repoId}-thread-2`, started: deferred(), release: deferred() };
      await page.evaluate((hash) => { location.hash = hash; }, `/project/${repoId}/thread/${repoId}-thread-2`);
      await historyGate.started.promise;
      await assertLoading(repoId);
      assert.equal(writes.length, before);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      await page.screenshot({ path: new URL(`${repoId}-loading-${width}.png`, out).pathname, fullPage: true });
      historyGate.release.resolve();
      historyGate = null;
      await ready(repoId, 2);
      await openModel(repoId);
      await page.locator(".command-panel").getByRole("button", { name: "关闭面板", exact: true }).click();

      // An earlier successful save must not update the new conversation's UI.
      saveGate = { started: deferred(), release: deferred() };
      await openModel(repoId);
      await page.getByRole("button", { name: /GPT-6 Astra gpt-6-astra/ }).click();
      await saveGate.started.promise;
      await page.evaluate((hash) => { location.hash = hash; }, `/project/${repoId}/thread/${repoId}-thread-1`);
      await ready(repoId, 1);
      const response = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith("/runtime"));
      saveGate.release.resolve();
      saveGate = null;
      await (await response).finished();
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await ready(repoId, 1);
      await page.reload();
      await ready(repoId, 1);
      assert.equal(sessions.find((s) => s.id === `${repoId}-1`).model, "gpt-6-sol");
      assert.equal(sessions.find((s) => s.id === `${repoId}-2`).model, "gpt-6-astra");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      await page.screenshot({ path: new URL(`${repoId}-ready-${width}.png`, out).pathname, fullPage: true });
      Object.assign(sessions.find((s) => s.id === `${repoId}-2`), runtime(2));
      historyGate = { target: `${repoId}-2`, started: deferred(), release: deferred() };
      await page.locator(".session-current").click();
      await page.getByRole("tab", { name: /^对话 2/ }).click();
      await historyGate.started.promise;
      const beforeSelect = writes.length;
      await assertLoading(repoId);
      assert.equal(writes.length, beforeSelect);
      historyGate.release.resolve();
      historyGate = null;
      await ready(repoId, 2);
    }
  }
  historyGate = { target: "_personal-thread-2", started: deferred(), release: deferred(), fail: true };
  const beforeFailure = writes.length;
  await page.goto(`${baseUrl}#/project/_personal/thread/_personal-thread-1`);
  await ready("_personal", 1);
  await page.evaluate(() => { location.hash = "/project/_personal/thread/_personal-thread-2"; });
  await historyGate.started.promise;
  historyGate.release.resolve();
  await settings().filter({ hasText: "暂不可用" }).waitFor();
  assert.equal(await settings().isDisabled(), true, "加载失败不能修改目标未确定的会话");
  assert.equal(writes.length, beforeFailure);
  historyGate = null;
  await page.evaluate(() => { location.hash = "/project/_personal/thread/_personal-thread-1"; });
  await ready("_personal", 1);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, widths: [320, 390, 1280], spaces: ["personal", "work"], checks: ["加载时不显示旧模型/权限且设置禁用", "切换关闭已打开的旧设置", "目标会话加载后恢复设置", "旧保存响应不串到新会话", "刷新保留各自设置", "加载失败设置禁用且可恢复", "无页面错误或横向溢出"], screenshots: out.pathname }, null, 2));
} finally {
  historyGate?.release.resolve();
  saveGate?.release.resolve();
  await browser.close();
}
