import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { personalFeedbackConsole } from "./fixtures/personal-feedback-console.mjs";

const fixture = await personalFeedbackConsole();
const out = path.join(fixture.project, "docs/research/acceptance/chat-history-window-20261025");
await fs.mkdir(out, { recursive: true });
const control = JSON.parse(await fs.readFile(fixture.control, "utf8"));
for (const name of ["a", "b"]) control[name].history = Array.from({ length: 497 }, (_, index) => ({
  id: `window-${name}-turn-${index}`, status: "completed", items: [{ id: `window-${name}-message-${index}`, type: "agentMessage", phase: "final_answer",
    text: `合成历史 ${name.toUpperCase()} ${index}\n\n${"只用于临时隔离验收，不涉及真实邮件、日历或模型。".repeat(3)}` }],
}));
await fs.writeFile(fixture.control, JSON.stringify(control));
let browser;
const evidence = { realModelCalls: 0, thirdPartyCalls: 0, viewports: [] };
try {
  if (process.argv.includes("--serve")) {
    console.log(JSON.stringify({ url: `${fixture.base}/#/project/_personal/thread/personal-a`, stop: "SIGTERM this process", realModelCalls: 0 }));
    await new Promise(resolve => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
  } else {
    browser = await chromium.launch({ channel: process.env.CODEX_CLOUD_CHROME_CHANNEL || "chrome", headless: true });
    for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
      const coldSamples = [];
      for (let index = 0; index < 30; index++) {
        const context = await browser.newContext({ viewport }), page = await context.newPage(), errors = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.goto(`${fixture.base}/#/project/_personal/thread/personal-a`);
        await page.waitForFunction(() => document.querySelector('.chat-window')?.getAttribute('aria-busy') === 'false'
          && document.querySelectorAll('.chat-bubble').length === 80 && document.querySelector('.composer-shell textarea')?.disabled === false);
        coldSamples.push(await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => resolve(performance.now())))));
        assert.deepEqual(errors, []); await context.close();
      }
      const coldSorted = [...coldSamples].sort((a, b) => a - b);
      const cold = { samples: coldSamples, p50: coldSorted[14], p95: coldSorted[28], max: coldSorted[29], goalMet: coldSorted[29] <= 2500 };
      const context = await browser.newContext({ viewport }), errors = [];
      await context.addInitScript(() => {
        window.__feedbackContentChecks = 0;
        const digest = crypto.subtle.digest.bind(crypto.subtle);
        crypto.subtle.digest = (...args) => { window.__feedbackContentChecks++; return digest(...args); };
      });
      let page = await context.newPage();
      page.on("pageerror", error => errors.push(error.message));
      let chat = page.locator(".chat-window"), composer = page.locator(".composer-shell textarea");
      const ready = async (name, count) => {
        await page.waitForFunction(({ text, count }) => document.querySelector('.chat-window')?.getAttribute('aria-busy') === 'false'
          && document.querySelector('.chat-window')?.textContent.includes(text) && document.querySelectorAll('.chat-bubble').length === count
          && document.querySelector('.composer-shell textarea')?.disabled === false, { text: control[name].text, count });
      };
      const route = name => page.evaluate(name => { location.hash = `/project/_personal/thread/personal-${name}`; }, name);
      const position = () => chat.evaluate(node => {
        const top = node.getBoundingClientRect().top;
        const anchor = [...node.querySelectorAll('[data-chat-message-id]')].find(item => item.getBoundingClientRect().bottom > top + 1);
        return { id: anchor?.getAttribute('data-chat-message-id'), offset: anchor?.getBoundingClientRect().top - top };
      });
      await page.goto(`${fixture.base}/#/project/_personal/thread/personal-a`); await ready("a", 80);
      await page.getByText("显示最近 80 条，共 500 条", { exact: true }).waitFor();
      const drafts = { a: `合成草稿 A ${viewport.width}，未发送`, b: `合成草稿 B ${viewport.width}，未发送` };
      for (const name of ["a", "b"]) {
        if (name === "b") { await route(name); await ready(name, 80); }
        await composer.fill(drafts[name]);
        for (const count of [160, 240, 320, 400, 480, 500]) {
          const button = page.getByRole("button", { name: "加载更早的消息", exact: true });
          assert.ok((await button.boundingBox()).height >= 44);
          await button.click(); await ready(name, count);
          assert.equal(await composer.inputValue(), drafts[name]);
        }
        assert.equal(await page.getByRole("button", { name: "加载更早的消息", exact: true }).count(), 0);
        await chat.hover();
        await page.locator(`[data-chat-message-id="window-${name}-message-20"]`).scrollIntoViewIfNeeded();
        await page.getByText(control[name].history[20].items[0].text, { exact: true }).scrollIntoViewIfNeeded();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        evidence[`anchor-${viewport.width}-${name}`] = await position();
      }
      await route("a"); await ready("a", 500);
      assert.equal(await composer.inputValue(), drafts.a);
      const before = evidence[`anchor-${viewport.width}-a`];
      const restored = await position();
      assert.equal(restored.id, before.id); assert.ok(Math.abs(restored.offset - before.offset) <= 8);
      await page.reload(); await ready("a", 500);
      const reloaded = await position();
      assert.equal(reloaded.id, before.id); assert.ok(Math.abs(reloaded.offset - before.offset) <= 8);
      assert.equal(await composer.inputValue(), drafts.a);

      const samples = [];
      await page.evaluate(() => { window.__feedbackContentChecks = 0; });
      for (let index = 0; index < 32; index++) {
        const name = index % 2 ? "a" : "b";
        const ms = await page.evaluate(({ name, text }) => new Promise((resolve, reject) => {
          const start = performance.now(); location.hash = `/project/_personal/thread/personal-${name}`;
          const check = () => {
            const node = document.querySelector('.chat-window');
            if (node?.getAttribute('aria-busy') === 'false' && node.textContent.includes(text)
                && document.querySelectorAll('.chat-bubble').length === 500 && document.querySelector('.composer-shell textarea')?.disabled === false) {
              requestAnimationFrame(() => resolve(performance.now() - start)); return;
            }
            if (performance.now() - start > 15000) { reject(new Error('500-message navigation timed out')); return; }
            requestAnimationFrame(check);
          }; requestAnimationFrame(check);
        }), { name, text: control[name].text });
        if (index >= 2) samples.push(ms);
      }
      const sorted = [...samples].sort((a, b) => a - b);
      const contentChecks = await page.evaluate(() => window.__feedbackContentChecks);
      assert.ok(contentChecks < 640, `screen-off feedback must not hash all 500 replies on each switch: ${contentChecks}`);
      const measured = { viewport, cold, samples, contentChecks, p50: sorted[14], p95: sorted[28], max: sorted[29], warmGoalMet: sorted[28] <= 200 };
      evidence.viewports.push(measured);
      await fs.writeFile(path.join(out, "in-progress.json"), JSON.stringify(evidence, null, 2));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      await page.screenshot({ path: path.join(out, `history-${viewport.width}.png`), fullPage: true });
      control.a.history.push(...Array.from({ length: 100 }, (_, index) => ({ id: `new-a-turn-${index}`, status: "completed",
        items: [{ id: `new-a-message-${index}`, type: "agentMessage", text: `合成后续进展 ${index}` }] })));
      await fs.writeFile(fixture.control, JSON.stringify(control));
      await page.reload(); await ready("a", 581);
      const advanced = await position();
      assert.equal(advanced.id, before.id); assert.ok(Math.abs(advanced.offset - before.offset) <= 8);
      control.a.history.splice(497); await fs.writeFile(fixture.control, JSON.stringify(control));
      Object.assign(measured, { readingAnchorRetainedAfterNewMessages: true });
      await page.close(); page = await context.newPage();
      page.on("pageerror", error => errors.push(error.message));
      chat = page.locator(".chat-window"); composer = page.locator(".composer-shell textarea");
      await page.goto(`${fixture.base}/#/project/_personal/thread/personal-a`); await ready("a", 80);
      let rejected = 0;
      const failedPage = async route => {
        if (new URL(route.request().url()).searchParams.get("limit") === "160") {
          rejected++; await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ ok: false, error: "合成历史暂不可用" }) });
        } else await route.continue();
      };
      await context.route("**/api/chat/sessions?*", failedPage);
      await page.getByRole("button", { name: "加载更早的消息", exact: true }).click();
      await page.locator('.chat-degraded-banner').getByText("合成历史暂不可用", { exact: true }).waitFor();
      assert.equal(await page.locator('.chat-bubble').count(), 80);
      assert.equal(await composer.inputValue(), drafts.a);
      assert.ok(rejected >= 1 && rejected <= 5);
      await context.unroute("**/api/chat/sessions?*", failedPage);
      let release, captured;
      const started = new Promise(resolve => { captured = resolve; });
      const gate = new Promise(resolve => { release = resolve; });
      const latePage = async route => {
        if (new URL(route.request().url()).searchParams.get("limit") !== "160") return route.continue();
        const response = await route.fetch(); captured(); await gate;
        await route.fulfill({ response }).catch(() => {});
      };
      await context.route("**/api/chat/sessions?*", latePage);
      await page.getByRole("button", { name: "加载更早的消息", exact: true }).click();
      await started;
      await route("b"); await ready("b", 80); release();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await composer.inputValue(), drafts.b);
      assert.equal(await page.locator('.chat-bubble').count(), 80);
      assert.equal(await page.locator('.chat-degraded-banner').count(), 0);
      await context.unroute("**/api/chat/sessions?*", latePage);
      const saved = structuredClone(control.a.history[20]);
      control.a.history[20].items[0].text = "长消息验收。".repeat(250) + "\n\n```js\nconst preview = 'synthetic';\n```\n\n| 项目 | 状态 |\n| --- | --- |\n| 历史 | 已保留 |";
      control.a.history[20].items.push({ id: "perf-image", type: "imageView", path: "perf-preview.png" });
      await fs.writeFile(fixture.control, JSON.stringify(control));
      const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");
      await context.route("**/api/files/blob?*", async route => {
        const url = new URL(route.request().url());
        assert.equal(url.searchParams.get("repoId"), "_personal"); assert.equal(url.searchParams.get("path"), "perf-preview.png");
        await route.fulfill({ contentType: "image/png", body: png });
      });
      await route("a"); await ready("a", 80);
      for (const count of [160, 240, 320, 400, 480, 501]) {
        await page.getByRole("button", { name: "加载更早的消息", exact: true }).click(); await ready("a", count);
      }
      const long = page.locator('[data-chat-message-id="window-a-message-20"]');
      await long.scrollIntoViewIfNeeded();
      await long.getByRole("button", { name: "展开全文", exact: true }).click();
      assert.match(await long.locator(".markdown-code-block code").textContent(), /const preview = 'synthetic'/);
      assert.equal(await long.locator("table").count(), 1);
      await long.getByRole("button", { name: "收起", exact: true }).click();
      const imageItem = page.locator('[data-chat-message-id="perf-image"]');
      await imageItem.scrollIntoViewIfNeeded();
      await page.waitForFunction(() => { const img = document.querySelector('[data-chat-message-id="perf-image"] img'); return img?.complete && img.naturalWidth === 1; });
      assert.equal(await page.locator('.chat-bubble').count(), 501);
      assert.equal(await composer.inputValue(), drafts.a);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      await page.screenshot({ path: path.join(out, `rich-history-${viewport.width}.png`), fullPage: true });
      control.a.history[20] = saved; await fs.writeFile(fixture.control, JSON.stringify(control));
      Object.assign(measured, { longMessageCodeAndImageVisible: true });
      assert.deepEqual(errors, []);
      Object.assign(measured, { failedLoadPreservedDraft: true, obsoletePageIgnored: true });
      await context.close();
    }
    const rpc = (await fs.readFile(fixture.rpcCapture, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(rpc.some(item => ["turn/start", "thread/start", "mcpServer/tool/call", "command/exec"].includes(item.method)), false);
    await fs.writeFile(path.join(out, "result.json"), JSON.stringify(evidence, null, 2));
    const performanceOk = evidence.viewports.every(item => item.warmGoalMet && item.cold.goalMet);
    console.log(JSON.stringify({ functionalOk: true, performanceOk, ...evidence }));
    if (process.argv.includes("--enforce-performance") && !performanceOk) process.exitCode = 1;
  }
} finally { await browser?.close(); await fixture.stop(); }
