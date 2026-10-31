import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { personalFeedbackConsole } from "./fixtures/personal-feedback-console.mjs";

const fixture = await personalFeedbackConsole();
const output = path.join(fixture.project, "docs/research/acceptance/e19-reading-20261025");
await fs.mkdir(output, { recursive: true });
const control = JSON.parse(await fs.readFile(fixture.control, "utf8"));
for (const name of ["a", "b"]) control[name].history = Array.from({ length: 60 }, (_, index) => ({
  id: `reading-${name}-turn-${index}`, status: "completed", items: [{ id: `reading-${name}-message-${index}`, type: "agentMessage", phase: "final_answer",
    text: `阅读位置验收 ${name.toUpperCase()} 第 ${index} 段。${"这是保存在独立临时目录中的合成记录，不涉及真实邮件、日历或模型。".repeat(index === 19 ? 20 : 4)}` }],
}));
await fs.writeFile(fixture.control, JSON.stringify(control));
let browser, page;
const errors = [], evidence = {};
const wait = async (check, description) => {
  const deadline = Date.now() + 10000;
  while (!await check()) { if (Date.now() >= deadline) throw new Error(description); await new Promise(resolve => setTimeout(resolve, 40)); }
};
try {
  if (process.argv.includes("--serve")) {
    console.log(JSON.stringify({ url: `${fixture.base}/#/project/_personal/thread/personal-a`, root: fixture.root, model: "refused", stop: "SIGTERM this process" }));
    await new Promise(resolve => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
  } else {
    browser = await chromium.launch({ channel: process.env.CODEX_CLOUD_CHROME_CHANNEL || "chrome", headless: true });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
    const chat = page.locator(".chat-window");
    const ready = async name => {
      await wait(async () => page.url().endsWith(`/thread/feedback-thread-${name}`), "native conversation address did not settle");
      await page.getByText(control[name].text, { exact: true }).waitFor();
      await wait(async () => await chat.getAttribute("aria-busy") === "false" && await page.locator(".composer-shell textarea").isEnabled(), "history did not become ready");
      await page.getByText(control[name].history[20].items[0].text, { exact: true }).waitFor();
    };
    const position = () => chat.evaluate((node, text) => {
      const element = [...node.querySelectorAll("p")].find(item => item.textContent === text);
      return { offset: element.getBoundingClientRect().top - node.getBoundingClientRect().top, top: node.scrollTop, height: node.scrollHeight };
    }, control.a.history[20].items[0].text);
    const anchor = () => chat.evaluate(node => {
      const top = node.getBoundingClientRect().top;
      const item = [...node.querySelectorAll("[data-chat-message-id]")].find(item => item.getBoundingClientRect().bottom > top + 1);
      return { id: item?.getAttribute("data-chat-message-id"), offset: item?.getBoundingClientRect().top - top };
    });
    // Markdown rehydration can replace paragraphs during actionability waits.
    const reveal = (id, text) => page.evaluate(({ id, text }) => {
      const message = document.querySelector(`[data-chat-message-id="${id}"]`);
      const paragraph = [...(message?.querySelectorAll("p") || [])].find(node => node.textContent === text);
      if (!paragraph) throw new Error("Reading target is missing from the current message tree");
      paragraph.scrollIntoView({ block: "nearest" });
    }, { id, text });
    await page.goto(`${fixture.base}/#/project/_personal/thread/personal-a`); await ready("a");
    await chat.hover();
    await reveal("reading-a-message-20", control.a.history[20].items[0].text);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    evidence.before = await position();
    assert.ok(evidence.before.top > 500 && evidence.before.offset >= -5 && evidence.before.offset < 350);
    await page.screenshot({ path: path.join(output, "before-switch.png"), fullPage: true });
    await page.evaluate(() => { location.hash = "/project/_personal/thread/personal-b"; }); await ready("b");
    await page.evaluate(() => { location.hash = "/project/_personal/thread/personal-a"; }); await ready("a");
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    evidence.after = await position();
    assert.ok(Math.abs(evidence.after.offset - evidence.before.offset) <= 8, `returning to the same conversation must restore the reading anchor: ${JSON.stringify(evidence)}`);
    await page.reload(); await ready("a");
    await wait(async () => Math.abs((await position()).offset - evidence.before.offset) <= 8, "reload did not recover the same reading position");
    evidence.reloaded = await position();
    const portrait = await anchor();
    evidence.viewports = [];
    for (const size of [{ width: 1126, height: 753 }, { width: 1024, height: 768 }, { width: 821, height: 753 },
      { width: 1180, height: 900 }, { width: 1181, height: 900 }, { width: 320, height: 480 }, { width: 1280, height: 900 },
      { width: 768, height: 900 }, { width: 820, height: 900 }]) {
      await page.setViewportSize(size);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const layout = await page.evaluate(() => {
        const chat = document.querySelector('.chat-window'), composer = document.querySelector('.composer-shell textarea');
        const box = composer.getBoundingClientRect();
        return { width: innerWidth, height: innerHeight, pageHeight: document.documentElement.scrollHeight,
          chatHeight: chat.clientHeight, chatContentHeight: chat.scrollHeight, inputTop: box.top, inputBottom: box.bottom };
      });
      evidence.viewports.push(layout);
      assert.ok(layout.chatHeight > 0 && layout.chatHeight < size.height, `聊天区应限制在可视高度：${JSON.stringify(layout)}`);
      assert.ok(layout.inputTop >= 0 && layout.inputBottom <= size.height + 1, `输入框应保持可见：${JSON.stringify(layout)}`);
      assert.ok(layout.pageHeight <= size.height + 1, `长消息不应撑高整个页面：${JSON.stringify(layout)}`);
      assert.ok(layout.chatContentHeight > layout.chatHeight, '长历史应在聊天区内独立滚动');
      await wait(async () => (await anchor()).id === portrait.id, `resize ${size.width} lost the reading message`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      await page.screenshot({ path: path.join(output, `reading-${size.width}-${size.height}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await wait(async () => Math.abs((await position()).offset - evidence.before.offset) <= 8, "returning to the original viewport lost the reading position");
    await page.evaluate(() => { location.hash = "/project/_personal/thread/personal-b"; }); await ready("b");
    await chat.hover();
    await reveal("reading-b-message-40", control.b.history[40].items[0].text);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const bTop = await chat.evaluate(node => node.scrollTop);
    await page.evaluate(() => { location.hash = "/project/_personal/thread/personal-a"; }); await ready("a");
    await wait(async () => Math.abs((await position()).offset - evidence.before.offset) <= 8, "B's separate position overwrote A");
    await page.evaluate(() => { location.hash = "/project/_personal/thread/personal-b"; }); await ready("b");
    await wait(async () => Math.abs(await chat.evaluate(node => node.scrollTop) - bTop) <= 8, "B's own reading position was lost");
    await page.evaluate(() => { location.hash = "/project/_personal/thread/personal-a"; }); await ready("a");
    await wait(async () => Math.abs((await position()).offset - evidence.before.offset) <= 8, "A's position did not survive repeated switching");

    const draft = "合成离线草稿 A，尚未发送，不得自动运行。";
    const composer = page.locator(".composer-shell textarea");
    await context.setOffline(true);
    assert.equal(await page.evaluate(() => navigator.onLine), false);
    await composer.fill(draft);
    await wait(() => page.evaluate(text => Object.keys(localStorage).filter(key => key.startsWith("codex-cloud-draft:")).some(key => {
      try { return JSON.parse(localStorage.getItem(key)).input === text; } catch { return false; }
    }), draft), "offline edit was not kept locally");
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    });
    assert.equal(await composer.inputValue(), draft);
    await context.setOffline(false);
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.reload(); await ready("a");
    await wait(async () => await composer.inputValue() === draft && Math.abs((await position()).offset - evidence.before.offset) <= 8, "online return/reload lost the draft or reading position");
    assert.ok(page.url().endsWith("/thread/feedback-thread-a"), "return/reload must retain the accepted native conversation identifier");
    evidence.onlineReturn = await position();
    await page.screenshot({ path: path.join(output, "online-return.png"), fullPage: true });

    control.a.text += " 新增的合成进展，不应抢走正在阅读的位置。";
    await fs.writeFile(fixture.control, JSON.stringify(control));
    await page.reload(); await ready("a");
    await page.getByRole("button", { name: "有新进展", exact: false }).waitFor();
    await wait(async () => Math.abs((await position()).offset - evidence.before.offset) <= 8, "new output stole the reading position");
    await page.getByRole("button", { name: "有新进展", exact: false }).click();
    await wait(() => chat.evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight < 2), "explicit jump did not reach latest output");
    assert.equal(await page.getByRole("button", { name: "有新进展", exact: false }).count(), 0);
    assert.equal(await composer.inputValue(), draft);

    await page.goto(`${fixture.base}/#/project/work/thread/work-history`);
    await wait(async () => page.url().endsWith("/thread/work-thread") && await chat.getAttribute("aria-busy") === "false" && await composer.isEnabled(), "work conversation did not become ready");
    await page.getByText(control.a.text, { exact: true }).waitFor();
    assert.equal(await composer.inputValue(), "合成工作草稿");
    evidence.workViewports = [];
    for (const size of [{ width: 390, height: 844 }, { width: 320, height: 480 }, { width: 360, height: 640 },
      { width: 430, height: 932 }, { width: 768, height: 900 }, { width: 844, height: 390 },
      { width: 820, height: 900 }, { width: 821, height: 753 }, { width: 1024, height: 768 }, { width: 1280, height: 720 }]) {
      await page.setViewportSize(size);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const layout = await page.evaluate(() => {
        const chat = document.querySelector(".chat-window"), panel = document.querySelector(".chat-panel");
        const panelBox = panel.getBoundingClientRect();
        const controls = [...document.querySelectorAll(".composer-shell textarea, .composer-shell button")].map(node => {
          const box = node.getBoundingClientRect();
          return { label: node.getAttribute("aria-label") || node.getAttribute("title") || node.textContent || node.tagName,
            footer: Boolean(node.closest(".composer-footer")),
            top: box.top, bottom: box.bottom, left: box.left, right: box.right, width: box.width, height: box.height };
        }).filter(box => box.width > 0 && box.height > 0);
        return { width: innerWidth, height: innerHeight, pageHeight: document.documentElement.scrollHeight,
          pageWidth: document.documentElement.scrollWidth, panelBottom: panelBox.bottom,
          chatHeight: chat.clientHeight, chatContentHeight: chat.scrollHeight, controls };
      });
      evidence.workViewports.push(layout);
      assert.ok(layout.chatHeight > 0 && layout.chatContentHeight > layout.chatHeight, `工作长历史应在聊天区内滚动：${JSON.stringify(layout)}`);
      assert.ok(layout.pageWidth <= size.width + 1 && layout.pageHeight <= size.height + 1, `工作聊天不能撑大页面：${JSON.stringify(layout)}`);
      assert.ok(layout.controls.some(item => item.label === "上传截图或文件") && layout.controls.some(item => item.label === "发送消息"), "工作输入区应包含附件和发送控件");
      for (const box of layout.controls) assert.ok(box.top >= 0 && box.bottom <= Math.min(size.height, layout.panelBottom) + 1 && box.left >= 0 && box.right <= size.width + 1,
        `工作输入区的全部可见控件应位于面板和视口内：${JSON.stringify({ size, box, layout })}`);
      if (size.width <= 820) for (const box of layout.controls.filter(item => item.footer)) {
        assert.ok(box.width >= 44 && box.height >= 44, `手机工作设置入口应至少 44×44：${JSON.stringify({ size, box })}`);
      }
      if (size.width <= 820) {
        const settings = page.getByRole("button", { name: /^会话设置：GPT-6 Sol.*推理深度中$/ });
        await settings.click();
        await page.getByRole("dialog", { name: "会话设置", exact: true }).waitFor();
        await page.locator(".personal-session-settings").getByRole("button", { name: /^工作区权限/ }).click();
        await page.locator(".command-panel-head").getByText("权限", { exact: true }).waitFor();
        await wait(() => page.locator(".command-panel").evaluate(node => node.contains(document.activeElement)), "子面板应接管键盘焦点");
        await page.keyboard.press("Escape");
        await page.locator(".command-panel").waitFor({ state: "hidden" });
        assert.equal(await settings.evaluate(node => node === document.activeElement), true, "关闭子面板后焦点应回到工作会话设置入口");
        assert.equal(await composer.inputValue(), "合成工作草稿", "浏览设置不能覆盖未发送草稿");
      }
      if (size.width > 820) {
        await page.locator(".sidebar .account-card").scrollIntoViewIfNeeded();
        const account = await page.locator(".sidebar .account-card").boundingBox();
        assert.ok(account && account.y >= 0 && account.y + account.height <= size.height + 1, "聊天侧栏独立滚动后仍应能查看底部账号");
      }
      await page.screenshot({ path: path.join(output, `work-${size.width}-${size.height}.png`), fullPage: true });
    }
    const workDraft = "合成工作离线恢复草稿，未发送。";
    await composer.fill(workDraft);
    await wait(async () => (await fixture.request("/api/chat/sessions?repoId=work")).body.sessions?.some(session => session.draft?.input === workDraft), "work draft was not persisted");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await wait(async () => page.url().endsWith("/thread/work-thread") && await composer.isEnabled() && await composer.inputValue() === workDraft, "work reload lost the draft or native conversation");
    await page.getByRole("button", { name: /^会话设置：GPT-6[- ]Sol.*推理深度中$/ }).waitFor();
    const reloadedSend = await page.getByRole("button", { name: "发送消息", exact: true }).boundingBox();
    assert.ok(reloadedSend && reloadedSend.y >= 0 && reloadedSend.y + reloadedSend.height <= 844, "工作聊天刷新后发送按钮仍应完整可见");
    await page.screenshot({ path: path.join(output, "work-reloaded.png"), fullPage: true });
    const rpc = (await fs.readFile(fixture.rpcCapture, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(rpc.some(item => ["turn/start", "thread/start", "mcpServer/tool/call", "feedback/upload", "command/exec"].includes(item.method)), false);
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(output, "result.json"), JSON.stringify({ ok: true, evidence }, null, 2));
    console.log(JSON.stringify({ ok: true, evidence }));
  }
} catch (error) {
  if (page) evidence.failedLayout = await page.locator(".chat-window").evaluate(node => ({ top: node.scrollTop, height: node.scrollHeight, viewport: node.clientHeight, gap: node.scrollHeight - node.scrollTop - node.clientHeight,
    saved: sessionStorage.getItem("codex-cloud-chat-reading-v1") })).catch(() => null);
  if (page) await page.screenshot({ path: path.join(output, "failure.png"), fullPage: true }).catch(() => null);
  await fs.writeFile(path.join(output, "failure.json"), JSON.stringify({ error: error.message, evidence, pageErrors: errors }, null, 2));
  throw error;
} finally { await browser?.close(); await fixture.stop(); }
