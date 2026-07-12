#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const baseUrl = new URL(process.env.CODEX_CLOUD_E2E_URL || process.env.CODEX_CLOUD_SMOKE_URL || process.env.CODEX_CLOUD_CONSOLE_URL || "http://127.0.0.1:18787/");
const repoId = process.env.CODEX_CLOUD_E2E_REPO || process.env.CODEX_CLOUD_SMOKE_REPO || "invest-dashboard";
const runId = process.env.CODEX_CLOUD_E2E_RUN_ID || new Date().toISOString().replace(/[:.]/g, "-");
const artifactRoot = path.resolve(projectRoot, process.env.CODEX_CLOUD_E2E_ARTIFACT_DIR || path.join("docs", "research", "acceptance", "frontend-e2e", runId));
const screenshotDir = path.join(artifactRoot, "screenshots");
const fixtureDir = path.join(artifactRoot, "fixtures");
const tracePath = path.join(artifactRoot, "trace.zip");
const waitMs = Math.max(500, Number(process.env.CODEX_CLOUD_E2E_WAIT_MS || process.env.CODEX_CLOUD_SMOKE_UI_WAIT_MS || 2_000));
const apiTimeoutMs = Math.max(1_000, Number(process.env.CODEX_CLOUD_E2E_API_TIMEOUT_MS || 30_000));
const turnTimeoutMs = Math.max(10_000, Number(process.env.CODEX_CLOUD_E2E_TURN_TIMEOUT_MS || 240_000));
const compactTimeoutMs = Math.max(10_000, Number(process.env.CODEX_CLOUD_E2E_COMPACT_TIMEOUT_MS || 240_000));
const runRealTurn = process.env.CODEX_CLOUD_E2E_REAL_TURN === "1";
const runCompact = runRealTurn && process.env.CODEX_CLOUD_E2E_COMPACT === "1";
const headless = process.env.CODEX_CLOUD_E2E_HEADLESS !== "0";
const strictDom = process.env.CODEX_CLOUD_E2E_STRICT_DOM === "1";
const allowPartialStatus = process.env.CODEX_CLOUD_E2E_ALLOW_PARTIAL_STATUS === "1";

const desktopViewport = { width: 1440, height: 940 };
const mobileViewport = { width: 390, height: 844 };
const requiredSlashCommands = ["状态", "会话", "模型", "推理模式", "压缩", "MCP"];
const badChromeNeedles = [
  "连接断开",
  "Local mock",
  "本地模拟",
  "模拟响应",
  "模拟日志",
  "Cloud console proxy error",
  "Preparing 隔离工作区 (detached HEAD",
  "云端 Codex exited (SIGTERM)",
  "app-server-command",
  "detached-worktree",
  "repo-cwd",
  "控制台重启时云端自动化仍在运行",
];
const badDomNeedles = [
  '"mocked":true',
  '"source":"local-fallback"',
  '"source":"local-mock"',
  '"source":"mock"',
  '"source":"app-server-unavailable"',
  "mock snapshot",
];

const steps = [];
const screenshots = [];
const consoleErrors = [];
const failedResponses = [];
let testSessionId = "";
let testSessionTitle = "";
let testUploadPaths = [];

function pageUrl(hash) {
  const url = new URL(baseUrl.href);
  url.searchParams.set("v", `frontend-e2e-${runId}`);
  url.hash = hash;
  return url.href;
}

function apiUrl(pathname) {
  return new URL(pathname, baseUrl).href;
}

function safeName(value) {
  return String(value || "artifact").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "artifact";
}

async function ensureDirs() {
  await fs.mkdir(screenshotDir, { recursive: true });
  await fs.mkdir(fixtureDir, { recursive: true });
}

async function fetchText(pathname, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timeout after ${apiTimeoutMs}ms`)), apiTimeoutMs);
  const started = Date.now();
  try {
    const response = await fetch(apiUrl(pathname), {
      ...options,
      signal: controller.signal,
      headers: {
        accept: "application/json,text/plain,*/*",
        ...(options.headers || {}),
      },
    });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      ms: Date.now() - started,
      text,
      headers: Object.fromEntries(response.headers.entries()),
      fallback: response.headers.get("x-codex-cloud-proxy-fallback") || "",
    };
  } finally {
    clearTimeout(timer);
  }
}

function parseJson(result, label) {
  try {
    return JSON.parse(result.text);
  } catch (error) {
    throw new Error(`${label} did not return JSON: ${error.message}; body=${result.text.slice(0, 400)}`);
  }
}

function assertNoDegradedPayload(result, label) {
  if (result.fallback) throw new Error(`${label} used proxy fallback: ${result.fallback}`);
  const hits = badDomNeedles.filter((needle) => result.text.includes(needle));
  if (hits.length) throw new Error(`${label} returned degraded payload: ${hits.join(", ")}`);
}

async function apiJson(pathname, label, predicate = null, options = {}) {
  const result = await fetchText(pathname, options);
  if (!result.ok) throw new Error(`${label} failed with HTTP ${result.status}: ${result.text.slice(0, 500)}`);
  assertNoDegradedPayload(result, label);
  const data = parseJson(result, label);
  if (predicate && !predicate(data)) throw new Error(`${label} returned unexpected payload: ${JSON.stringify(data).slice(0, 1200)}`);
  return { data, ms: result.ms };
}

async function writeFixtureFiles() {
  const suffix = crypto.createHash("sha256").update(String(runId)).digest("hex").slice(0, 16);
  const uploadName = `frontend-e2e-upload-${suffix}.txt`;
  const imageName = `frontend-e2e-paste-${suffix}.png`;
  const uploadPath = path.join(fixtureDir, uploadName);
  const imagePath = path.join(fixtureDir, imageName);
  await fs.writeFile(uploadPath, `frontend e2e upload ${runId}\n`, "utf8");
  await fs.writeFile(
    imagePath,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAIAAAACUFjqAAAAJklEQVR4nGNk+M+ABzAyMjL8Z2BgYGBgqGJkYGBgQhYGBgAAB1IBAv2MX1EAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  return { uploadPath, uploadName, imagePath, imageName };
}

async function capture(page, name, options = {}) {
  const file = path.join(screenshotDir, `${String(screenshots.length + 1).padStart(2, "0")}-${safeName(name)}.png`);
  const buffer = await page.screenshot({ path: file, fullPage: options.fullPage !== false });
  if (buffer.length < 1_000) throw new Error(`${name} screenshot appears blank or too small (${buffer.length} bytes)`);
  screenshots.push(path.relative(projectRoot, file));
  return file;
}

async function inspectPage(page, label) {
  const result = await page.evaluate(
    ({ label: pageLabel, badChromeNeedles: chromeNeedles, badDomNeedles: domNeedles, strictDomCheck }) => {
      const visible = [...document.querySelectorAll("body *")].filter((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      });
      const isInsideIgnoredText = (element) => Boolean(element.closest(".chat-window, textarea, .timeline-pre"));
      const chromeText = visible
        .filter((element) => !isInsideIgnoredText(element))
        .map((element) => element.innerText || element.textContent || "")
        .filter(Boolean)
        .join("\n");
      const bodyText = document.body.innerText || "";
      const html = document.body.innerHTML || "";
      const overflows = visible
        .map((element) => {
          const scrollContainer = element.closest(".slash-menu, .command-panel, .chat-window, .session-manager-list");
          if (scrollContainer && scrollContainer !== element) return null;
          const rect = element.getBoundingClientRect();
          if (rect.left < -2 || rect.right > window.innerWidth + 2 || rect.top < -120 || rect.bottom > window.innerHeight + 320) {
            return {
              tag: element.tagName,
              className: String(element.className || "").slice(0, 100),
              left: Math.round(rect.left),
              top: Math.round(rect.top),
              right: Math.round(rect.right),
              bottom: Math.round(rect.bottom),
              text: (element.innerText || element.textContent || "").replace(/\s+/g, " ").slice(0, 100),
            };
          }
          return null;
        })
        .filter(Boolean)
        .slice(0, 10);
      const unnamedButtons = visible
        .filter((element) => element.tagName === "BUTTON")
        .map((button) => {
          const textValue = (button.innerText || button.textContent || "").trim().replace(/\s+/g, " ");
          const aria = button.getAttribute("aria-label") || "";
          const title = button.getAttribute("title") || "";
          if (textValue || aria || title) return null;
          const rect = button.getBoundingClientRect();
          return {
            className: String(button.className || "").slice(0, 100),
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            html: button.outerHTML.slice(0, 180),
          };
        })
        .filter(Boolean)
        .slice(0, 10);
      const controlRects = [...document.querySelectorAll(".composer button, .composer-footer button, .session-actions button, .thread-actions button")]
        .filter((element) => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        })
        .map((element, index) => {
          const rect = element.getBoundingClientRect();
          return {
            index,
            label: (element.getAttribute("aria-label") || element.getAttribute("title") || element.innerText || element.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80),
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height,
          };
        });
      const overlaps = [];
      for (let i = 0; i < controlRects.length; i += 1) {
        for (let j = i + 1; j < controlRects.length; j += 1) {
          const a = controlRects[i];
          const b = controlRects[j];
          const x = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
          const y = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
          const area = x * y;
          const minArea = Math.max(1, Math.min(a.width * a.height, b.width * b.height));
          if (area / minArea > 0.25) {
            overlaps.push({
              a: a.label || `button ${a.index}`,
              b: b.label || `button ${b.index}`,
              ratio: Number((area / minArea).toFixed(2)),
            });
          }
        }
      }
      const badChrome = chromeNeedles.filter((needle) => chromeText.includes(needle));
      const badDom = strictDomCheck ? domNeedles.filter((needle) => html.includes(needle)) : [];
      return {
        label: pageLabel,
        title: document.title,
        badChrome,
        badDom,
        overflowX: document.documentElement.scrollWidth > window.innerWidth + 2,
        overflows,
        unnamedButtons,
        overlaps: overlaps.slice(0, 10),
        loading: ["正在读取", "读取中", "正在加载"].filter((needle) => bodyText.includes(needle)),
        chromeSample: chromeText.slice(0, 600),
      };
    },
    { label, badChromeNeedles, badDomNeedles, strictDomCheck: strictDom },
  );
  const failures = [];
  if (result.badChrome.length) failures.push(`bad visible chrome text: ${result.badChrome.join(", ")}`);
  if (result.badDom.length) failures.push(`bad DOM text: ${result.badDom.join(", ")}`);
  if (result.overflowX) failures.push("horizontal overflow");
  if (result.overflows.length) failures.push(`out-of-viewport elements: ${JSON.stringify(result.overflows)}`);
  if (result.unnamedButtons.length) failures.push(`unnamed buttons: ${JSON.stringify(result.unnamedButtons)}`);
  if (result.overlaps.length) failures.push(`overlapping controls: ${JSON.stringify(result.overlaps)}`);
  if (result.loading.length) failures.push(`loading dead text: ${result.loading.join(", ")}`);
  if (failures.length) throw new Error(`${label} failed visual inspection: ${failures.join("; ")}`);
  return result;
}

async function waitForShell(page) {
  await page.waitForSelector(".app-shell", { timeout: 30_000 });
  await page.waitForSelector(".composer-shell textarea", { timeout: 30_000 });
  await page.waitForTimeout(waitMs);
}

async function runStep(name, fn) {
  const started = Date.now();
  try {
    const data = await fn();
    steps.push({ name, ok: true, ms: Date.now() - started, data: data || null });
    return data;
  } catch (error) {
    steps.push({ name, ok: false, ms: Date.now() - started, error: error.message || String(error) });
    throw error;
  }
}

async function openSlashCommand(page, label) {
  const textarea = page.locator(".composer-shell textarea");
  await textarea.fill("/");
  const menu = page.locator('[data-testid="slash-command-center"]');
  await menu.waitFor({ state: "visible", timeout: 10_000 });
  if (label) {
    const button = menu.locator("button", { hasText: label }).first();
    await button.waitFor({ state: "visible", timeout: 5_000 });
    await button.click();
  }
}

async function assertPanel(page, title, requiredText = []) {
  const panel = page.locator(".command-panel");
  await panel.waitFor({ state: "visible", timeout: 10_000 });
  await panel.locator(".command-panel-head strong").waitFor({ state: "visible", timeout: 10_000 });
  const text = await panel.innerText();
  if (!text.includes(title)) throw new Error(`expected panel title ${title}; got ${text.slice(0, 300)}`);
  const missing = requiredText.filter((item) => !text.includes(item));
  if (missing.length) throw new Error(`${title} panel missing text: ${missing.join(", ")}`);
}

async function closePanel(page) {
  const button = page.locator(".command-panel .command-panel-head button").first();
  if (await button.count()) await button.click();
}

async function pasteImageIntoComposer(page, imagePath, imageName) {
  const bytes = await fs.readFile(imagePath);
  await page.locator(".composer-shell textarea").focus();
  await page.evaluate(
    ({ base64, name }) => {
      const binary = atob(base64);
      const array = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) array[index] = binary.charCodeAt(index);
      const file = new File([array], name, { type: "image/png" });
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      const textarea = document.querySelector(".composer-shell textarea");
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: dataTransfer });
      textarea?.dispatchEvent(event);
    },
    { base64: bytes.toString("base64"), name: imageName },
  );
}

async function verifySlashMenu(page) {
  await openSlashCommand(page);
  const menu = page.locator('[data-testid="slash-command-center"]');
  const menuText = await menu.innerText();
  const box = await menu.boundingBox();
  const viewport = page.viewportSize() || desktopViewport;
  if (!box || box.x < -2 || box.y < -2 || box.x + box.width > viewport.width + 2 || box.y + box.height > viewport.height + 2) {
    throw new Error(`slash command center is outside viewport: ${JSON.stringify(box)}`);
  }
  const missing = requiredSlashCommands.filter((command) => !menuText.includes(command));
  if (missing.length) throw new Error(`slash menu missing commands: ${missing.join(", ")}`);
  await capture(page, "desktop-slash-menu");
  await inspectPage(page, "desktop slash menu");
  await page.locator(".composer-shell textarea").press("Escape");
}

async function verifyPanels(page) {
  await openSlashCommand(page, "状态");
  await assertPanel(page, "状态", ["连接", "云端 Codex", "主动压缩"]);
  await capture(page, "desktop-status-panel");
  await closePanel(page);

  await page.locator('.composer-footer-right button[aria-label^="模型"]').click();
  await assertPanel(page, "模型");
  const modelButtons = await page.locator(".command-panel .choice-list button").count();
  if (modelButtons < 1) throw new Error("model panel has no model choices");
  await capture(page, "desktop-model-panel");
  await closePanel(page);

  await page.locator('.composer-footer-right button[aria-label^="推理深度"]').click();
  await assertPanel(page, "推理模式", ["低", "中", "高", "超高"]);
  await capture(page, "desktop-reasoning-panel");
  await closePanel(page);

  await page.locator(".composer-footer-left .footer-permission-chip").click();
  await assertPanel(page, "权限");
  const permissionButtons = await page.locator(".command-panel .choice-list button").count();
  if (permissionButtons < 1) throw new Error("permissions panel has no permission choices");
  await capture(page, "desktop-permissions-panel");
  await closePanel(page);

  await page.locator(".session-current").click();
  await assertPanel(page, "会话", ["新会话"]);
  await page.locator('.command-panel .session-search input[placeholder="搜索会话"]').waitFor({ state: "visible", timeout: 5_000 });
  await capture(page, "desktop-sessions-panel");
  await closePanel(page);
}

async function createTestSession(page) {
  testSessionTitle = `E2E ${crypto.createHash("sha256").update(String(runId)).digest("hex").slice(0, 12)}`;
  const created = await apiJson(
    "/api/chat/sessions",
    "create isolated e2e session",
    (data) => data?.ok === true && Boolean(data?.activeSessionId),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoId, title: testSessionTitle }),
    },
  );
  testSessionId = String(created.data.activeSessionId);
  await page.goto(pageUrl(`#/project/${repoId}/thread/${encodeURIComponent(testSessionId)}`), { waitUntil: "domcontentloaded", timeout: 30_000 });
  await waitForShell(page);
  await page.waitForFunction(
    ({ sessionId }) =>
      window.location.hash.includes(encodeURIComponent(sessionId)) &&
      document.querySelector(".session-current")?.getAttribute("data-session-id") === sessionId,
    { sessionId: testSessionId },
    { timeout: 30_000 },
  );
  if (await page.locator(".attachment-chip").count()) throw new Error("isolated e2e session inherited attachment chips");
  return testSessionId;
}

async function verifyUploadAndPaste(page, fixtures) {
  await createTestSession(page);
  const textUploadResponse = page.waitForResponse(
    (response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/uploads",
    { timeout: 30_000 },
  );
  await page.locator('input[type="file"].hidden-file-input').setInputFiles(fixtures.uploadPath);
  const textUpload = await (await textUploadResponse).json();
  await page.locator(".attachment-chip", { hasText: fixtures.uploadName }).waitFor({ state: "visible", timeout: 30_000 });
  const imageUploadResponse = page.waitForResponse(
    (response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/uploads",
    { timeout: 30_000 },
  );
  await pasteImageIntoComposer(page, fixtures.imagePath, fixtures.imageName);
  const imageUpload = await (await imageUploadResponse).json();
  await page.locator(".attachment-chip.image", { hasText: fixtures.imageName }).waitFor({ state: "visible", timeout: 30_000 });
  const attachments = [...(textUpload.files || []), ...(imageUpload.files || [])];
  testUploadPaths = attachments.map((attachment) => String(attachment.path || "")).filter(Boolean);
  const draft = await apiJson(
    `/api/chat/sessions/${encodeURIComponent(testSessionId)}/draft`,
    "persisted e2e attachment draft",
    (data) => data?.ok === true && data?.sessionId === testSessionId && Array.isArray(data?.draft?.attachments) && data.draft.attachments.length >= 2,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoId, input: "", attachments }),
    },
  );
  await capture(page, "desktop-upload-and-paste-attachments");
  await inspectPage(page, "desktop upload and paste");
  return { sessionId: testSessionId, attachmentCount: draft.data.draft.attachments.length };
}

async function cleanupTestSession() {
  if (!testSessionId) return { skipped: true };
  const deleted = await fetchText(`/api/chat/sessions/${encodeURIComponent(testSessionId)}?repoId=${encodeURIComponent(repoId)}&force=1`, { method: "DELETE" });
  if (!deleted.ok) throw new Error(`cleanup draft session failed with HTTP ${deleted.status}: ${deleted.text.slice(0, 500)}`);
  const data = parseJson(deleted, "cleanup e2e session");
  if (data?.deletedSessionId !== testSessionId) throw new Error(`cleanup deleted unexpected session: ${data?.deletedSessionId || "none"}`);
  if (Array.isArray(data?.uploadCleanup?.errors) && data.uploadCleanup.errors.length) {
    throw new Error(`cleanup upload files failed: ${data.uploadCleanup.errors.join("; ")}`);
  }
  const deletedUploads = Array.isArray(data?.uploadCleanup?.deleted) ? data.uploadCleanup.deleted : [];
  const missingDeletes = testUploadPaths.filter((filePath) => !deletedUploads.includes(filePath));
  if (missingDeletes.length) throw new Error(`cleanup did not delete e2e uploads: ${missingDeletes.join(", ")}`);
  return { sessionId: testSessionId, deletedUploads };
}

async function verifyRealTurn(page) {
  const marker = `FRONTEND_E2E_OK_${safeName(runId).slice(0, 18)}`;
  const textarea = page.locator(".composer-shell textarea");
  await textarea.fill(`只回复 ${marker}，不要执行命令，不要读取附件。`);
  await page.locator(".send-button").click();
  await page.locator(".chat-bubble.codex", { hasText: marker }).waitFor({ state: "visible", timeout: turnTimeoutMs });
  await capture(page, "desktop-real-turn-complete");
  const active = await apiJson(`/api/chat/active?repoId=${encodeURIComponent(repoId)}`, "chat active after real turn", (data) => data?.ok === true && data?.source === "app-server" && Boolean(data?.threadId));
  const thread = await apiJson(
    `/api/codex/thread-read?repoId=${encodeURIComponent(repoId)}&sessionId=${encodeURIComponent(active.data.sessionId)}`,
    "thread read after real turn",
    (data) => JSON.stringify(data).includes(marker),
  );
  return { marker, sessionId: active.data.sessionId, threadId: thread.data.threadId };
}

async function verifyCompact(page, turnData) {
  await openSlashCommand(page, "状态");
  await assertPanel(page, "状态", ["主动压缩"]);
  await page.locator(".context-status-actions .command-button", { hasText: "主动压缩" }).click();
  await page.getByText(/正在|压缩|上下文/).first().waitFor({ state: "visible", timeout: 20_000 }).catch(() => null);
  await capture(page, "desktop-compact-running");
  const started = Date.now();
  let state = null;
  while (Date.now() - started < compactTimeoutMs) {
    const active = await apiJson(`/api/chat/active?repoId=${encodeURIComponent(repoId)}&sessionId=${encodeURIComponent(turnData.sessionId)}`, "chat active during compact");
    state = active.data;
    if (!state.compact || state.compact.completed) break;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  if (state?.compact && !state.compact.completed) throw new Error("compact did not complete before timeout");
  await page.waitForTimeout(1_000);
  await capture(page, "desktop-compact-complete");
  return { compact: state?.compact || null };
}

async function verifyMobile(browser) {
  const mobileContext = await browser.newContext({ viewport: mobileViewport });
  const page = await mobileContext.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error.message || error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto(pageUrl(`#/project/${repoId}`), { waitUntil: "domcontentloaded", timeout: 30_000 });
  await waitForShell(page);
  await capture(page, "mobile-project");
  await inspectPage(page, "mobile project");
  await openSlashCommand(page);
  const menu = page.locator('[data-testid="slash-command-center"]');
  const box = await menu.boundingBox();
  if (!box || box.x < -2 || box.y < -2 || box.x + box.width > mobileViewport.width + 2 || box.y + box.height > mobileViewport.height + 2) {
    throw new Error(`mobile slash menu is outside viewport: ${JSON.stringify(box)}`);
  }
  await capture(page, "mobile-slash-menu");
  await inspectPage(page, "mobile slash menu");
  if (errors.length) throw new Error(`mobile page errors: ${errors.join("; ")}`);
  await mobileContext.close();
}

function summaryMarkdown(report) {
  const ok = report.ok ? "通过" : "失败";
  const lines = [
    `# Frontend E2E Acceptance ${runId}`,
    "",
    `结论：${ok}`,
    "",
    `入口：${baseUrl.href}`,
    `仓库：${repoId}`,
    `真实 turn：${runRealTurn ? "开启" : "关闭"}`,
    `主动压缩：${runCompact ? "开启" : "关闭"}`,
    "",
    "## Steps",
    "",
    ...report.steps.map((step) => `- ${step.ok ? "PASS" : "FAIL"} ${step.name} (${step.ms}ms)${step.error ? `: ${step.error}` : ""}`),
    "",
    "## Artifacts",
    "",
    `- Trace: ${path.relative(projectRoot, tracePath)}`,
    ...report.screenshots.map((item) => `- Screenshot: ${item}`),
  ];
  if (report.consoleErrors.length) {
    lines.push("", "## Console Errors", "", ...report.consoleErrors.map((item) => `- ${item.slice(0, 300)}`));
  }
  return `${lines.join("\n")}\n`;
}

await ensureDirs();
const fixtures = await writeFixtureFiles();
const launchOptions = {
  headless,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
};
if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
  launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
}

const browser = await chromium.launch(launchOptions);
const context = await browser.newContext({ viewport: desktopViewport });
await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
const page = await context.newPage();
page.on("pageerror", (error) => consoleErrors.push(String(error.message || error)));
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("response", (response) => {
  if (response.status() < 400) return;
  failedResponses.push({ method: response.request().method(), status: response.status(), url: response.url() });
});

let fatalError = null;
try {
  await runStep("api preflight", async () => {
    const healthyEnough = (data) =>
      data?.ok === true ||
      (allowPartialStatus && data?.layers?.ec2Console?.ok === true && (data?.layers?.appServer?.ok === true || data?.layers?.codexAuth?.ok === true));
    const statusHealthyEnough = (data) =>
      data?.health?.ok === true ||
      (allowPartialStatus && data?.health?.layers?.ec2Console?.ok === true && (data?.health?.layers?.appServer?.ok === true || data?.health?.layers?.codexAuth?.ok === true));
    const health = await apiJson("/healthz", "healthz", healthyEnough);
    const status = await apiJson("/api/status", "status", statusHealthyEnough);
    const models = await apiJson("/api/codex/models", "codex models", (data) => data?.ok === true && data?.source === "app-server" && Array.isArray(data?.models) && data.models.length > 0);
    const appStatus = await apiJson(`/api/codex/app-status?repoId=${encodeURIComponent(repoId)}`, "codex app status", (data) => data?.ok === true && data?.source === "app-server" && data?.authoritative === true);
    if (runRealTurn && appStatus.data.usageLimit) {
      throw new Error(`real turn blocked by Codex usage limit: ${appStatus.data.usageLimit.message || appStatus.data.usageLimit.code || "usage limit reached"}`);
    }
    const sessions = await apiJson(
      `/api/chat/sessions?repoId=${encodeURIComponent(repoId)}&sync=1`,
      "authoritative chat sessions",
      (data) => data?.ok === true && data?.source === "app-server" && data?.authoritative === true && Array.isArray(data?.sessions),
    );
    if (sessions.data.activeSessionId) {
      await apiJson(
        `/api/chat/active?repoId=${encodeURIComponent(repoId)}&sessionId=${encodeURIComponent(sessions.data.activeSessionId)}`,
        "authoritative active chat session",
        (data) => data?.ok === true && data?.source === "app-server" && data?.authoritative === true,
      );
      await apiJson(
        `/api/codex/thread-state?repoId=${encodeURIComponent(repoId)}&sessionId=${encodeURIComponent(sessions.data.activeSessionId)}&sync=1`,
        "authoritative thread state",
        (data) => data?.ok === true && data?.source === "app-server" && data?.authoritative === true,
      );
    }
    return {
      healthMs: health.ms,
      statusMs: status.ms,
      modelCount: models.data.models.length,
      appStatusMs: appStatus.ms,
      sessionCount: sessions.data.sessions.length,
      partialAllowed: allowPartialStatus,
    };
  });

  await runStep("desktop project render", async () => {
    await page.goto(pageUrl(`#/project/${repoId}`), { waitUntil: "domcontentloaded", timeout: 30_000 });
    await waitForShell(page);
    await capture(page, "desktop-project");
    return await inspectPage(page, "desktop project");
  });

  await runStep("slash command center", async () => verifySlashMenu(page));
  await runStep("command panels", async () => verifyPanels(page));
  await runStep("upload and paste attachments", async () => verifyUploadAndPaste(page, fixtures));

  let turnData = null;
  if (runRealTurn) {
    turnData = await runStep("real codex turn", async () => verifyRealTurn(page));
  }
  if (runCompact && turnData) {
    await runStep("compact status flow", async () => verifyCompact(page, turnData));
  }

  await runStep("mobile responsive flow", async () => verifyMobile(browser));

  if (consoleErrors.length) {
    throw new Error(`browser console/page errors: ${consoleErrors.slice(0, 5).join("; ")}`);
  }
} catch (error) {
  fatalError = error;
  if (!steps.some((step) => step.ok === false)) {
    steps.push({ name: "uncaught failure", ok: false, ms: 0, error: error.message || String(error) });
  }
} finally {
  await context.tracing.stop({ path: tracePath }).catch(() => null);
  await browser.close().catch(() => null);
  const cleanupStartedAt = Date.now();
  try {
    const cleanup = await cleanupTestSession();
    steps.push({ name: "cleanup e2e session and uploads", ok: true, ms: Date.now() - cleanupStartedAt, result: cleanup });
  } catch (error) {
    steps.push({ name: "cleanup e2e session and uploads", ok: false, ms: Date.now() - cleanupStartedAt, error: error.message || String(error) });
    if (!fatalError) fatalError = error;
  }
}

const report = {
  ok: !fatalError && steps.every((step) => step.ok) && consoleErrors.length === 0,
  runId,
  baseUrl: baseUrl.href,
  repoId,
  realTurn: runRealTurn,
  compact: runCompact,
  artifactRoot: path.relative(projectRoot, artifactRoot),
  trace: path.relative(projectRoot, tracePath),
  screenshots,
  steps,
  consoleErrors,
  failedResponses,
  error: fatalError ? fatalError.message || String(fatalError) : null,
};

await fs.writeFile(path.join(artifactRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
await fs.writeFile(path.join(artifactRoot, "summary.md"), summaryMarkdown(report), "utf8");

console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exit(1);
