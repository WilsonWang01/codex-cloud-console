#!/usr/bin/env node

import { chromium } from "playwright";

const baseUrl = new URL(process.env.CODEX_CLOUD_SMOKE_URL || process.env.CODEX_CLOUD_CONSOLE_URL || "http://127.0.0.1:18787/");
const waitMs = Math.max(1_000, Number(process.env.CODEX_CLOUD_SMOKE_UI_WAIT_MS || 10_000));
const allowLoading = process.env.CODEX_CLOUD_SMOKE_UI_ALLOW_LOADING === "1";
const badNeedles = [
  "连接断开",
  "Local mock",
  "本地模拟",
  "模拟响应",
  "模拟日志",
  "Preparing 隔离工作区 (detached HEAD",
  "云端 Codex exited (SIGTERM)",
  "/bin/bash -lc",
  "app-server-command",
  "/home/ubuntu/codex-cloud/worktrees",
  "detached-worktree",
  "repo-cwd",
  "控制台重启时云端自动化仍在运行",
];

const pages = [
  ["inbox-desktop", "#/inbox", { width: 1440, height: 940 }],
  ["cli-desktop", "#/project/invest-dashboard", { width: 1440, height: 940 }],
  ["settings-desktop", "#/settings", { width: 1440, height: 940 }],
  ["automations-desktop", "#/automations/invest-dashboard/invest-daily-update", { width: 1440, height: 940 }],
  ["inbox-mobile", "#/inbox", { width: 390, height: 844 }],
  ["cli-mobile", "#/project/invest-dashboard", { width: 390, height: 844 }],
];

function pageUrl(hash) {
  const url = new URL(baseUrl.href);
  url.searchParams.set("v", `smoke-${Date.now()}`);
  url.hash = hash;
  return url.href;
}

async function inspectPage(page, needles) {
  return page.evaluate((badNeedles) => {
    const text = document.body.innerText;
    const html = document.body.innerHTML;
    const visibleElements = [...document.querySelectorAll("body *")].filter((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    });
    const overflows = visibleElements
      .map((element) => {
        const rect = element.getBoundingClientRect();
        if (rect.left < -2 || rect.right > window.innerWidth + 2) {
          return {
            tag: element.tagName,
            className: String(element.className).slice(0, 80),
            left: Math.round(rect.left),
            right: Math.round(rect.right),
            text: (element.innerText || "").slice(0, 80),
          };
        }
        return null;
      })
      .filter(Boolean)
      .slice(0, 8);
    const unnamedButtons = visibleElements
      .filter((element) => element.tagName === "BUTTON")
      .map((button) => {
        const textValue = (button.innerText || button.textContent || "").trim().replace(/\s+/g, " ");
        const aria = button.getAttribute("aria-label") || "";
        const title = button.getAttribute("title") || "";
        if (textValue || aria || title) return null;
        const rect = button.getBoundingClientRect();
        return {
          className: String(button.className || "").slice(0, 80),
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          html: button.outerHTML.slice(0, 160),
        };
      })
      .filter(Boolean)
      .slice(0, 8);
    return {
      visibleHits: badNeedles.filter((needle) => text.includes(needle)),
      domHits: badNeedles.filter((needle) => html.includes(needle)),
      overflowX: document.documentElement.scrollWidth > window.innerWidth + 2,
      overflows,
      unnamedButtons,
      loading: ["正在读取", "读取中", "正在加载", "同步中", "同步会话中", "同步收件箱中", "等待云端状态同步"].filter((needle) => text.includes(needle)),
      sample: text.slice(0, 600),
    };
  }, needles);
}

async function inspectSlashCommandCenter(page, needles) {
  const textarea = page.locator(".composer-shell textarea");
  const textareaCount = await textarea.count();
  if (textareaCount !== 1) {
    return { ok: false, reason: `expected one composer textarea, got ${textareaCount}` };
  }
  await textarea.fill("/");
  await page.waitForTimeout(250);
  return page.evaluate((badNeedles) => {
    const menu = document.querySelector('[data-testid="slash-command-center"]');
    const text = document.body.innerText;
    const menuText = menu?.innerText || "";
    const rect = menu?.getBoundingClientRect();
    const requiredCommands = ["状态", "会话", "模型", "推理模式", "压缩", "MCP"];
    const missingCommands = requiredCommands.filter((command) => !menuText.includes(command));
    const overflowX = document.documentElement.scrollWidth > window.innerWidth + 2;
    const visibleButtons = [...document.querySelectorAll('[data-testid="slash-command-center"] button')]
      .map((button) => (button.innerText || "").trim().replace(/\s+/g, " "))
      .filter(Boolean)
      .slice(0, 12);
    return {
      ok: Boolean(menu) && missingCommands.length === 0 && !overflowX,
      open: Boolean(menu),
      missingCommands,
      visibleButtons,
      badText: badNeedles.filter((needle) => text.includes(needle)),
      overflowX,
      rect: rect
        ? {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            right: Math.round(rect.right),
            bottom: Math.round(rect.bottom),
            inViewport: rect.left >= -2 && rect.top >= -2 && rect.right <= window.innerWidth + 2 && rect.bottom <= window.innerHeight + 2,
          }
        : null,
    };
  }, needles);
}

const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const [name, hash, viewport] of pages) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error.message || error)));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });

    let result;
    try {
      await page.goto(pageUrl(hash), { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForSelector(".app-shell", { timeout: 20_000 });
      await page.waitForTimeout(waitMs);
      result = await inspectPage(page, badNeedles);
      if (name.startsWith("cli-")) {
        result.slashCommand = await inspectSlashCommandCenter(page, badNeedles);
      }
    } catch (error) {
      result = { fatal: String(error.message || error), visibleHits: [], domHits: [], overflowX: true, overflows: [], unnamedButtons: [], loading: [] };
    }
    results.push({ name, errors, ...result });
    await page.close();
  }
} finally {
  await browser.close();
}

const failures = results.filter(
  (item) =>
    item.fatal ||
    item.errors.length ||
    item.visibleHits.length ||
    item.domHits.length ||
    item.overflowX ||
    item.overflows.length ||
    item.unnamedButtons?.length ||
    (item.slashCommand && (!item.slashCommand.ok || item.slashCommand.badText?.length || item.slashCommand.overflowX || item.slashCommand.rect?.inViewport === false)) ||
    (!allowLoading && item.loading.length),
);

console.log(JSON.stringify({ ok: failures.length === 0, baseUrl: baseUrl.href, waitMs, allowLoading, results }, null, 2));
if (failures.length) process.exit(1);
