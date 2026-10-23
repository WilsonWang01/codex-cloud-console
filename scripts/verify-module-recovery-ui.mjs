import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { build } from "vite";
import { chromium } from "playwright";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const source = await fs.readFile(path.join(root, "src/App.tsx"), "utf8");
assert.equal((source.match(/recoverableLazy\(\(\) => import\(/g) || []).length, 12);
assert.doesNotMatch(source, /\blazy\(\(\) => import\(/);
const fixture = { Date };
vm.createContext(fixture);
vm.runInContext(ts.transpileModule(source.slice(source.indexOf("const fallbackRun ="), source.indexOf("\nfunction cx(")), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText + "\nglobalThis.status = fallbackStatus;", fixture);
const status = JSON.parse(JSON.stringify(fixture.status));
status.health.ok = true;
status.health.layers.appServer = { ok: true, running: true };
status.repos.push({ id: "_personal", name: "个人助理", kind: "personal", runtimeMode: "shared", executionAvailable: true, path: "/tmp/fixture-personal", remote: "", present: true, accent: "teal" });
const session = { id: "recovery-session", codexSessionId: "recovery-thread", repoId: "_personal", title: "资源恢复验收会话", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messageCount: 0, model: "gpt-6-sol", reasoning: "medium", sandbox: "read-only", approval: "on-request", search: true, draft: { input: "", attachments: [], revision: 0 } };
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "codex-module-recovery-"));
const directories = {};
for (const release of ["A", "B"]) {
  directories[release] = path.join(temporary, release);
  await build({ root, logLevel: "error", plugins: [{ name: "acceptance-release", renderChunk: code => ({ code: code + `\n;globalThis.__codexRecoveryBuild = ${JSON.stringify(release)};`, map: null }) }], build: { outDir: directories[release], emptyOutDir: true } });
  directories[release] = await fs.realpath(directories[release]);
}
const chunkNames = {};
for (const release of ["A", "B"]) chunkNames[release] = (await fs.readdir(path.join(directories[release], "assets"))).find(name => /^PersonalFiles-.*\.js$/.test(name));
assert.ok(chunkNames.A && chunkNames.B && chunkNames.A !== chunkNames.B, "the two builds must have genuinely different chunk URLs");
let release = "A";
const missing = [], writes = [];
const json = (res, value, code = 200) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(value)); };
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/__acceptance/release" && req.method === "POST") {
      release = url.searchParams.get("value") === "A" ? "A" : "B";
      return json(res, { release });
    }
    if (url.pathname === "/healthz") return json(res, status.health);
    if (url.pathname.startsWith("/api/")) {
      if (req.method !== "GET") {
        writes.push({ method: req.method, path: url.pathname });
        if (url.pathname.endsWith("/draft")) return json(res, { error: "验收模拟草稿尚未同步" }, 503);
        if (!url.pathname.endsWith("/select")) return json(res, { error: "验收禁止执行模型或第三方写入" }, 403);
      }
      if (url.pathname === "/api/status") return json(res, status);
      if (url.pathname === "/api/chat/sessions" || url.pathname.endsWith("/select")) return json(res, { ok: true, authoritative: true, repoId: "_personal", activeSessionId: session.id, sessions: [session], messages: [] });
      if (url.pathname.endsWith("/draft")) return json(res, { ok: true, draft: session.draft });
      if (url.pathname === "/api/personal/files") return json(res, { ok: true, files: [] });
      if (url.pathname === "/api/codex/thread-state") return json(res, { ok: true, authoritative: true, repoId: "_personal", sessionId: session.id, runtime: session });
      if (url.pathname === "/api/codex/app-status") return json(res, { ok: true, auth: { ok: true }, config: {}, gaps: [], plugins: {}, features: {}, skills: {} });
      return json(res, { ok: true, entries: [], items: [], sessions: [], runs: [], events: [], models: [], apps: [], matches: [], turn: null });
    }
    const directory = directories[release];
    const file = path.resolve(directory, "." + decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname));
    if (!file.startsWith(directory + path.sep)) return json(res, { error: "not found" }, 404);
    const real = await fs.realpath(file);
    if (!real.startsWith(directory + path.sep)) return json(res, { error: "not found" }, 404);
    const content = await fs.readFile(real);
    const type = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".svg": "image/svg+xml" }[path.extname(file)] || "application/octet-stream";
    res.writeHead(200, { "content-type": type, "cache-control": "no-cache" }); res.end(content);
  } catch (error) {
    if (error.code === "ENOENT") missing.push({ release, path: req.url });
    json(res, { error: "not found" }, 404);
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/`;
const out = new URL("../docs/research/acceptance/module-recovery-20261023/", import.meta.url);
await fs.mkdir(out, { recursive: true });
if (process.argv.includes("--serve-fixture")) {
  console.log(JSON.stringify({ fixture: true, baseUrl, release, switchRelease: new URL("__acceptance/release?value=B", baseUrl).href, stop: "SIGINT", modelCalls: 0, thirdPartyWrites: 0 }));
  await new Promise(resolve => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
  await new Promise(resolve => server.close(resolve));
  await fs.rm(temporary, { recursive: true });
} else {
  const browser = await chromium.launch({ channel: process.env.CODEX_CLOUD_CHROME_CHANNEL || "chrome", headless: true });
  const checks = [];
  try {
    for (const width of [320, 390, 1280]) {
      release = "A";
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const page = await context.newPage(), errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(baseUrl + "#/project/_personal/thread/recovery-thread");
      const composer = page.locator(".composer-shell textarea");
      await composer.waitFor({ timeout: 10000 }).catch(async error => {
        await page.screenshot({ path: new URL(`initial-failure-${width}.png`, out).pathname });
        throw new Error(JSON.stringify({ stage: "initial-composer", errors, body: (await page.locator("body").innerText()).slice(0, 5000) }), { cause: error });
      });
      await page.getByLabel("同步会话中", { exact: true }).waitFor({ state: "hidden" });
      await composer.fill("版本切换后仍须保留，不能自动发送");
      await page.waitForFunction(() => localStorage.getItem("codex-cloud-draft:_personal:recovery-session")?.includes("不能自动发送"));
      release = "B";
      await page.goto(baseUrl + "#/project/_personal/materials");
      const recovery = page.locator(".module-load-failure");
      await recovery.waitFor({ timeout: 10000 }).catch(async error => {
        await page.screenshot({ path: new URL(`transition-failure-${width}.png`, out).pathname });
        throw new Error(JSON.stringify({ stage: "removed-chunk", errors, missing, url: page.url(), body: (await page.locator("body").innerText()).slice(0, 5000) }), { cause: error });
      });
      assert.ok(missing.some(item => item.release === "B" && /PersonalFiles-.*\.js/.test(item.path)), "must reject the actual removed build-A chunk");
      assert.equal(await page.getByRole("heading", { name: "资料", exact: true }).count(), 0);
      assert.equal(await page.locator(".topbar").count(), 1, "application shell remains mounted");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      const reload = recovery.getByRole("button", { name: "重新加载页面", exact: true });
      assert.ok((await reload.boundingBox()).height >= 44);
      await page.screenshot({ path: new URL(`upgrade-failure-${width}.png`, out).pathname });
      let confirmation = "";
      page.once("dialog", dialog => { confirmation = dialog.message(); void dialog.dismiss(); });
      await reload.click();
      assert.match(confirmation, /未提交的表单/);
      await recovery.waitFor();
      assert.equal(await page.getByRole("heading", { name: "资料", exact: true }).count(), 0);
      await page.evaluate(() => {
        const set = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, value) {
          if (key.startsWith("codex-cloud-draft:")) throw new Error("acceptance storage full");
          return set.call(this, key, value);
        };
      });
      page.once("dialog", dialog => void dialog.accept());
      await reload.click();
      await recovery.getByText(/无法保存聊天草稿/).waitFor();
      assert.equal(await page.getByRole("heading", { name: "资料", exact: true }).count(), 0, "storage failure must not reload");
      await page.screenshot({ path: new URL(`storage-blocked-${width}.png`, out).pathname });
      // A fresh document restores the browser's native Storage method.
      await page.reload();
      await page.getByRole("heading", { name: "资料", exact: true }).waitFor();
      await page.goto(baseUrl + "#/project/_personal/thread/recovery-thread");
      await composer.waitFor();
      await composer.filter({ visible: true }).waitFor();
      await page.waitForFunction(() => document.querySelector(".composer-shell textarea")?.value === "版本切换后仍须保留，不能自动发送");
      assert.equal(await composer.inputValue(), "版本切换后仍须保留，不能自动发送");
      // Switch back to A only for a new document, then repeat B and the actual guarded button.
      release = "A";
      await page.reload(); await composer.waitFor();
      await page.getByLabel("同步会话中", { exact: true }).waitFor({ state: "hidden" });
      release = "B";
      await page.goto(baseUrl + "#/project/_personal/materials"); await recovery.waitFor();
      page.once("dialog", dialog => void dialog.accept());
      await reload.click();
      await page.getByRole("heading", { name: "资料", exact: true }).waitFor();
      assert.equal(await recovery.count(), 0);
      await page.goto(baseUrl + "#/project/_personal/thread/recovery-thread");
      await page.waitForFunction(() => document.querySelector(".composer-shell textarea")?.value === "版本切换后仍须保留，不能自动发送");
      await page.screenshot({ path: new URL(`draft-recovered-${width}.png`, out).pathname });
      assert.deepEqual(errors, [], "import failures must not become uncaught render errors");
      checks.push({ width, missingChunkHandled: true, canceledReloadRetained: true, storageFailureBlocked: true, guardedReloadRecovered: true, draftRetained: true });
      await context.close();
    }
    assert.ok(writes.every(item => item.path.endsWith("/draft") || item.path.endsWith("/select")), "must never submit a model/task/external write");
    console.log(JSON.stringify({ ok: true, checks, removedChunksObserved: missing.length, fixtureWrites: writes.length, modelCalls: 0, thirdPartyWrites: 0, screenshots: out.pathname }, null, 2));
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(temporary, { recursive: true });
  }
}
