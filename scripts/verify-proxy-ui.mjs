import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { chromium } from "playwright";

const root = new URL("../", import.meta.url);
const source = await fs.readFile(new URL("src/App.tsx", root), "utf8");
const fixture = { Date };
vm.createContext(fixture);
const start = source.indexOf("const fallbackRun ="), end = source.indexOf("\nfunction cx(", start);
vm.runInContext(ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText + "\nglobalThis.status = fallbackStatus;", fixture);
const status = JSON.parse(JSON.stringify(fixture.status));
status.health.ok = true;
status.health.layers.appServer = { ok: true, running: true };
status.repos.push({ id: "_personal", name: "个人助理", kind: "personal", runtimeMode: "shared", executionAvailable: true, path: "/tmp/fixture-personal", remote: "", accent: "teal", present: true, branch: "", commit: "", dirty: false, statusText: "个人空间", lastCommit: "非 Git 空间" });
const runtime = { model: "gpt-6-sol", reasoning: "medium", sandbox: "read-only", approval: "on-request", search: true };
const session = { id: "personal-fixture", codexSessionId: "personal-fixture-thread", repoId: "_personal", title: "日常安排", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messageCount: 0, isDraft: false, ...runtime, draft: { input: "", attachments: [], revision: 0 } };
let offline = true;
const dist = await fs.realpath(new URL("dist/", root));
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://fixture.test");
    const send = (data, code = 200) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(data)); };
    if (url.pathname === "/__fixture/network" && req.method === "POST") { offline = url.searchParams.get("offline") !== "0"; return send({ ok: true }); }
    if (url.pathname === "/healthz") return send(status.health);
    if (url.pathname === "/api/status") return send(status);
    if (url.pathname === "/api/chat/sessions") return offline
      ? send({ ok: false, layer: "local-proxy", requestId: "proxy-fixture-00112233", cause: "header-timeout", error: "SECRET-RAW-ERROR" }, 502)
      : send({ ok: true, authoritative: true, repoId: "_personal", activeSessionId: session.id, sessions: [session], messages: [] });
    if (url.pathname === "/api/codex/models") return send({ ok: true, source: "app-server", authoritative: true, models: [{ id: "gpt-6-sol", displayName: "GPT-6 Sol", defaultReasoningEffort: "medium", supportedReasoningEfforts: ["medium"] }] });
    if (url.pathname === "/api/codex/app-status") return send({ ok: true, authoritative: true, partial: false, account: null, auth: { ok: true }, mcpServers: [], plugins: { installed: 0, enabled: 0, available: 0, names: [] }, skills: { enabled: 0, total: 0, names: [], items: [] }, features: { enabled: 0, total: 0, names: [] }, permissionProfiles: [], config: {}, gaps: [] });
    if (url.pathname === "/api/codex/thread-state") return send({ ok: true, source: "app-server", authoritative: true, repoId: "_personal", sessionId: session.id, runtime, config: {} });
    if (url.pathname === `/api/chat/sessions/${session.id}/draft`) {
      if (req.method === "PATCH") {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        session.draft = { input: body.input, attachments: body.attachments, revision: session.draft.revision + 1 };
      }
      return send({ ok: true, repoId: "_personal", sessionId: session.id, draft: session.draft });
    }
    if (url.pathname.startsWith("/api/")) return send({ ok: true, pending: [], entries: [], items: [], sessions: [], runs: [], events: [], matches: [], turn: null, compact: null });
    const filename = path.resolve(dist, `.${decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)}`);
    if (!filename.startsWith(dist + path.sep) || (await fs.lstat(filename)).isSymbolicLink() || !(await fs.realpath(filename)).startsWith(dist + path.sep)) { res.writeHead(404); return res.end(); }
    const bytes = await fs.readFile(filename);
    res.writeHead(200, { "content-type": types[path.extname(filename)] || "application/octet-stream", "cache-control": "no-store" });
    res.end(bytes);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}/`;
const url = `${base}#/project/_personal/thread/${session.id}`;
if (process.argv.includes("--serve")) {
  console.log(`UI_FIXTURE_URL=${url}`);
} else {
  const browser = await chromium.launch({ channel: process.env.CODEX_CLOUD_CHROME_CHANNEL || "chrome", headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const out = new URL("docs/research/acceptance/proxy-diagnostics-2026-10-22/", root);
    await fs.mkdir(out, { recursive: true });
    for (const width of [320, 390, 1280]) {
      const draft = `请帮我整理下周行程 ${width}`;
      await page.setViewportSize({ width, height: width === 1280 ? 900 : 844 });
      offline = false;
      await page.goto(url);
      const input = page.getByPlaceholder("向个人助理发送消息");
      await input.fill(draft);
      await page.waitForFunction((draft) => Object.keys(localStorage).some((key) => key.includes("personal-fixture") && localStorage.getItem(key)?.includes(draft)), draft);
      offline = true;
      await page.reload();
      await page.locator(".chat-degraded-banner").filter({ hasText: "云端连接超时（错误编号：proxy-fixture-00112233）" }).waitFor();
      assert.equal((await page.locator("body").textContent()).includes("SECRET-RAW-ERROR"), false);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      await page.screenshot({ path: new URL(`error-${width}.png`, out).pathname, fullPage: true });
      offline = false;
      await page.reload();
      await page.locator(".session-current[data-session-id='personal-fixture']").waitFor();
      await page.waitForFunction((draft) => document.querySelector('textarea[placeholder="向个人助理发送消息"]')?.value === draft, draft);
      assert.equal(await page.locator(".chat-degraded-banner").isVisible(), false);
      await page.screenshot({ path: new URL(`recovered-${width}.png`, out).pathname, fullPage: true });
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, widths: [320, 390, 1280], errors, checks: ["中文错误原因及编号可见", "不显示原始敏感错误", "恢复后草稿仍保留", "无横向溢出"], screenshots: out.pathname }));
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
