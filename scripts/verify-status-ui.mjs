import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";
import { chromium } from "playwright";

const source = await fs.readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const fixture = { Date };
vm.createContext(fixture);
vm.runInContext(ts.transpileModule(source.slice(source.indexOf("const fallbackRun ="), source.indexOf("\nfunction cx(")), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText + "\nglobalThis.status = fallbackStatus;", fixture);
const status = JSON.parse(JSON.stringify(fixture.status));
status.generatedAt = "2026-10-22T08:00:00Z";
status.health.ok = true;
status.health.layers.appServer = { ok: true, running: true };
status.repos.push({ id: "_personal", name: "个人助理", kind: "personal", runtimeMode: "shared", executionAvailable: true, path: "/tmp/personal", present: true, accent: "teal" });
const out = new URL("../docs/research/acceptance/status-recovery-2026-10-22/", import.meta.url);
await fs.mkdir(out, { recursive: true });
const baseUrl = process.env.CODEX_CLOUD_UI_URL || "http://127.0.0.1:5174/";
const browser = await chromium.launch({ channel: process.env.CODEX_CLOUD_CHROME_CHANNEL || "chrome", headless: true });
const errors = [];
const writes = [];
const checks = [];
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
let healthGate = null;
let statusGate = null;
let statusFailure = false;
let healthFailure = false;
const requests = [];
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route("**/healthz", async (route) => {
    requests.push({ path: "/healthz", syncId: route.request().headers()["x-codex-cloud-sync-id"] });
    if (healthGate) await healthGate.promise;
    const health = structuredClone(status.health);
    if (healthFailure) { health.ok = false; health.layers.appServer.ok = false; }
    await route.fulfill({ status: healthFailure ? 503 : 200, contentType: "application/json", body: JSON.stringify(health) });
  });
  await context.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== "GET") writes.push({ method: request.method(), path: url.pathname });
    const send = (body, code = 200) => route.fulfill({ status: code, contentType: "application/json", body: JSON.stringify(body) });
    if (url.pathname === "/api/status") {
      requests.push({ path: url.pathname, syncId: request.headers()["x-codex-cloud-sync-id"] });
      const snapshot = structuredClone(status);
      const failure = statusFailure;
      if (statusGate) await statusGate.promise;
      return failure ? send({ error: "模拟状态接口不可用" }, 503) : send(snapshot);
    }
    if (url.pathname === "/api/chat/sessions") return send({ ok: true, repoId: "_personal", sessions: [], messages: [], activeSessionId: null, authoritative: true });
    if (url.pathname === "/api/personal/files") return send({ ok: true, files: [] });
    if (url.pathname === "/api/personal/brief") return send({ ok: true, brief: { items: [], total: 0, reviewedAt: null, until: status.generatedAt } });
    if (url.pathname === "/api/personal/commitments") return send({ ok: true, commitments: [] });
    if (url.pathname === "/api/codex/app-status") return send({ ok: true, source: "app-server", auth: { ok: true }, config: {}, gaps: [], plugins: {}, features: {}, skills: {} });
    return send({ ok: true, entries: [], items: [], sessions: [], runs: [], events: [], requests: [], matches: [], turn: null, apps: [], models: [], authoritative: true });
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  const ready = () => page.getByRole("heading", { name: "今日", exact: true }).waitFor({ timeout: 3_000 });
  const recovery = page.locator(".console-sync-state");
  const retry = () => page.getByRole("button", { name: "重新读取状态", exact: true }).click();

  healthGate = deferred();
  await page.goto(new URL("#/project/_personal/today", baseUrl).href);
  await ready();
  assert.ok(requests.some((r) => r.path === "/api/status"), "a stalled health request must not delay the page request");
  healthGate.resolve(); healthGate = null;
  await page.screenshot({ path: new URL("health-stalled-desktop.png", out).pathname });
  checks.push("stalled health does not block page data");

  statusFailure = true;
  await page.reload();
  await recovery.getByText("暂时无法读取页面数据", { exact: true }).waitFor();
  await recovery.getByText("错误详情", { exact: true }).click();
  assert.match(await recovery.innerText(), /同步编号：sync-[a-f0-9-]{36}/);
  assert.equal(await page.getByText("连接断开", { exact: true }).count(), 0, "successful health must not be reported as disconnected");
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `recovery overflow at ${width}`);
    assert.ok((await recovery.boundingBox()).height < 350, `recovery should not stretch into a full page at ${width}`);
    await page.screenshot({ path: new URL(`initial-failure-${width}.png`, out).pathname });
  }
  statusFailure = false;
  await retry();
  await ready();
  assert.equal(await recovery.count(), 0);
  checks.push("first failure exposes detail and retry at four widths; retry recovers");

  statusFailure = true;
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await recovery.getByText("状态暂未更新", { exact: true }).waitFor();
  assert.match(await recovery.innerText(), /上次成功同步/);
  await ready();
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok((await page.getByRole("heading", { name: "今日", exact: true }).boundingBox()).y < 500, "recovery must not push existing page below the viewport");
    await page.screenshot({ path: new URL(`retained-page-${width}.png`, out).pathname });
  }
  statusFailure = false;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await recovery.waitFor({ state: "detached" });
  checks.push("partial failure retains page and timestamp; online event recovers");

  healthFailure = true;
  statusFailure = true;
  await page.reload();
  await recovery.getByText("暂时无法读取页面数据", { exact: true }).waitFor();
  assert.equal(await page.getByText("连接断开", { exact: true }).count(), 0, "valid degraded health is not a disconnected service");
  healthFailure = false; statusFailure = false;
  await retry(); await ready();
  checks.push("HTTP 503 health retains known degraded connectivity");

  statusGate = deferred();
  const oldGate = statusGate;
  await page.reload();
  await recovery.getByText("正在同步云端状态", { exact: true }).waitFor();
  statusGate = null;
  status.generatedAt = "2026-10-22T09:00:00Z";
  await retry(); await ready();
  oldGate.resolve();
  statusFailure = true;
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await recovery.getByText("状态暂未更新", { exact: true }).waitFor();
  assert.equal(await recovery.locator("time").getAttribute("datetime"), status.generatedAt);
  statusFailure = false;
  checks.push("superseded requests cannot overwrite newer status");

  statusGate = deferred();
  const timeoutGate = statusGate;
  await retry();
  await recovery.getByText("状态暂未更新", { exact: true }).waitFor({ timeout: 18_000 });
  await recovery.getByText("错误详情", { exact: true }).click();
  assert.match(await recovery.innerText(), /请求超时/);
  statusGate = null; timeoutGate.resolve();
  await retry(); await ready();
  checks.push("hanging status times out and remains recoverable");

  for (let index = 0; index < 30; index++) {
    await page.reload(); await ready();
  }
  assert.equal(writes.length, 0, "recovery must not submit tasks or mutate drafts");
  assert.deepEqual(errors, []);
  for (const request of requests) assert.match(request.syncId, /^sync-[a-f0-9-]{36}$/);
  checks.push("30 reloads without permanent loading, JavaScript errors or writes");
  console.log(JSON.stringify({ ok: true, checks, requests: requests.length, writes: writes.length, screenshots: out.pathname }, null, 2));
} finally {
  healthGate?.resolve(); statusGate?.resolve();
  await browser.close();
}
