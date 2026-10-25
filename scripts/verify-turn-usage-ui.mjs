import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { chromium } from "playwright";

const base = new URL(process.env.CODEX_CLOUD_SAFETY_UI_URL || "http://127.0.0.1:5174/");
assert.equal(base.hostname, "127.0.0.1"); assert.equal(base.protocol, "http:");
const target = new URL("scripts/fixtures/turn-usage.html", base);
assert.equal((await fetch(target)).status, 200);
const out = new URL("../docs/research/acceptance/f07-turn-usage-20261025/", import.meta.url);
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: process.env.CODEX_CLOUD_CHROME_CHANNEL || "chrome", headless: true });
const errors = [];
try {
  const page = await browser.newPage();
  page.on("pageerror", error => errors.push(error.message));
  for (const [width, height] of [[1280, 900], [390, 844], [320, 800]]) {
    await page.setViewportSize({ width, height });
    await page.goto(target.href);
    await page.getByText("2 次运行用量未知", { exact: true }).waitFor();
    const rows = page.locator(".usage-requests .usage-request");
    assert.equal(await rows.count(), 3);
    for (let index = 0; index < 3; index++) await rows.nth(index).locator("summary").click();
    assert.match(await rows.nth(0).innerText(), /Token 40/);
    assert.match(await rows.nth(1).innerText(), /独立协作或后续回合/);
    assert.match(await rows.nth(2).innerText(), /历史快照只记录末次模型请求/);
    for (let index = 1; index < 3; index++) assert.match(await rows.nth(index).innerText(), /Token 未知，未计为零/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    const broken = await rows.evaluateAll(items => items.filter(item => {
      const summary = item.querySelector("summary").getBoundingClientRect();
      const detail = item.querySelector(".usage-request-expanded").getBoundingClientRect();
      return detail.top < summary.bottom - 1 || detail.width < summary.width - 1;
    }).length);
    assert.equal(broken, 0, "Expanded details must flow below full-width summaries");
    await page.screenshot({ path: new URL(`usage-${width}.png`, out).pathname, fullPage: true });
    await page.goto(target.href + "?long=1");
    await page.locator(".usage-requests .usage-request").nth(2).locator("summary").click();
    await page.getByText(/^用量核对：模拟核对标识_/).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.screenshot({ path: new URL(`usage-long-${width}.png`, out).pathname, fullPage: true });
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, widths: [1280, 390, 320], syntheticRecords: true, productionCalls: 0, modelCalls: 0, screenshots: out.pathname }));
} finally { await browser.close(); }
