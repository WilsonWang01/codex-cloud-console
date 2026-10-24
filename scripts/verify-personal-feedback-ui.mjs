import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { personalFeedbackConsole } from "./fixtures/personal-feedback-console.mjs";

const fixture = await personalFeedbackConsole();
const out = path.join(fixture.project, "docs/research/acceptance/p05-feedback-20261025");
await fs.mkdir(out, { recursive: true });
let browser, page, closing = false, releaseHeld = () => {};
const errors = [], requests = [];
const wait = async (condition, label) => {
  const until = Date.now() + 8000;
  while (!await condition()) { if (Date.now() > until) throw Error(label); await new Promise(resolve => setTimeout(resolve, 30)); }
};
try {
  if (process.argv.includes("--serve")) {
    console.log(JSON.stringify({ url: `${fixture.base}/#/project/_personal/thread/personal-a`, state: "isolated synthetic", stop: "SIGTERM this process", model: "refused", root: fixture.root }));
    await new Promise(resolve => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
  } else {
    assert.equal((await fetch(fixture.base)).status, 200);
    browser = await chromium.launch({ channel: process.env.CODEX_CLOUD_CHROME_CHANNEL || "chrome", headless: true });
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on("pageerror", error => errors.push(error.message));
    const thumb = name => page.getByRole("button", { name, exact: true });
    const selected = name => thumb(name).getAttribute("aria-pressed");
    let aPosts = 0, holdStarted, loseNextA = false;
    const heldStarted = new Promise(resolve => { holdStarted = resolve; });
    const held = new Promise(resolve => { releaseHeld = resolve; });
    await page.route("**/api/personal/sessions/*/feedback", async route => {
      const request = route.request(), url = new URL(request.url());
      requests.push({ method: request.method(), path: url.pathname, body: request.postDataJSON() });
      if (request.method() === "POST" && url.pathname.endsWith("/personal-a/feedback") && loseNextA) {
        loseNextA = false; aPosts++; await route.fetch(); return route.abort("failed");
      }
      if (request.method() === "POST" && url.pathname.endsWith("/personal-a/feedback") && ++aPosts === 1) {
        const response = await route.fetch(), body = await response.json(); holdStarted(); await held;
        try { return await route.fulfill({ status: response.status(), contentType: "application/json", body: JSON.stringify(body) }); }
        catch (error) { if (!closing) throw error; return; }
      }
      return route.continue();
    });
    const open = async name => {
      await page.getByRole("button", { name: new RegExp(`^合成个人对话 ${name} `) }).click();
      await page.getByText(`合成建议 ${name}：`, { exact: false }).waitFor();
      await wait(() => thumb("有帮助").isEnabled(), `${name} feedback did not become ready`);
    };
    await page.goto(`${fixture.base}/#/project/_personal/thread/personal-a`);
    await thumb("有帮助").waitFor();
    await wait(() => thumb("有帮助").isEnabled(), "initial feedback not ready");
    assert.equal(await thumb("有帮助").count(), 1, "only the final completed reply receives controls");
    await page.mouse.move(1, 1);
    const idle = await thumb("有帮助").boundingBox();
    await page.mouse.move(idle.x + idle.width / 2, idle.y + idle.height / 2);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal((await thumb("有帮助").boundingBox()).y, idle.y, "revealing reply details on hover cannot push the rating target away");
    await thumb("有帮助").click(); await heldStarted;
    await open("B");
    assert.equal(await selected("有帮助"), "false", "same item and turn IDs in another thread must not reuse A feedback");
    await thumb("有帮助").click();
    await wait(async () => await selected("有帮助") === "true" && await thumb("没有帮助").isEnabled(), "B save did not finish");
    await open("A");
    assert.equal(await selected("有帮助"), "true", "a fresh read sees A's already persisted first vote");
    await thumb("没有帮助").click();
    await wait(async () => await selected("没有帮助") === "true" && await thumb("有帮助").isEnabled(), "new A vote did not finish");
    const lateResponse = page.waitForResponse(response => response.url().endsWith("/api/personal/sessions/personal-a/feedback") && response.request().method() === "POST");
    releaseHeld();
    await (await lateResponse).finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.getByRole("button", { name: "没有帮助", exact: true }).waitFor();
    await wait(async () => {
      const actual = (await fixture.request("/api/personal/sessions/personal-a/feedback")).body.feedback[0];
      return actual.revision === 2 && actual.decision === "not_helpful";
    }, "backend must retain the newer A vote");
    assert.equal(await selected("没有帮助"), "true", "late A response after A→B→A must not overwrite the newer evaluation");
    assert.equal(aPosts, 2, "each explicit A click submits once; no implicit retries");
    await page.screenshot({ path: path.join(out, "accepted-desktop.png"), fullPage: true });

    await page.reload(); await wait(async () => await selected("没有帮助") === "true" && await thumb("没有帮助").isEnabled(), "vote did not survive reload");
    await thumb("没有帮助").click();
    await wait(async () => await selected("没有帮助") === "false" && await thumb("有帮助").isEnabled(), "withdrawal did not finish");
    const summary = (await fixture.request("/api/personal/feedback")).body.summary;
    assert.equal(summary.ratedCount, 1); assert.equal(summary.helpfulCount, 1, "withdrawn A is excluded; only explicitly rated B remains");
    await thumb("有帮助").click();
    await wait(async () => await selected("有帮助") === "true" && await thumb("没有帮助").isEnabled(), "new vote did not save");
    await fixture.restart();
    await page.reload(); await wait(async () => await selected("有帮助") === "true" && await thumb("没有帮助").isEnabled(), "vote did not survive actual backend restart");

    const file = path.join(fixture.state, "personal-message-feedback.json"), saved = await fs.readFile(file, "utf8");
    await fs.writeFile(file, "{synthetic-corruption");
    await page.reload(); await page.getByRole("button", { name: "重试读取评价", exact: true }).waitFor();
    assert.equal(await thumb("有帮助").isEnabled(), false);
    const failed = await fixture.request("/api/personal/feedback"); assert.equal(failed.status, 503); assert.equal(failed.body.summary, undefined);
    await fs.writeFile(file, saved);
    await page.getByRole("button", { name: "重试读取评价", exact: true }).click();
    await wait(async () => await selected("有帮助") === "true" && await thumb("没有帮助").isEnabled(), "failed read did not recover");

    const control = JSON.parse(await fs.readFile(fixture.control, "utf8"));
    control.a.text = "合成建议 A：内容更新后应重新核对评价。"; await fs.writeFile(fixture.control, JSON.stringify(control));
    await page.reload(); await wait(() => thumb("有帮助").isEnabled(), "changed reply did not load");
    assert.equal(await selected("有帮助"), "false", "a changed reply cannot inherit a prior content rating");
    const current = (await fixture.request("/api/personal/sessions/personal-a/feedback")).body.feedback[0];
    const { personalFeedbackDigest } = await import("../server/personal-feedback.mjs");
    const changedInput = { turnId: current.turnId, messageId: current.messageId, contentDigest: personalFeedbackDigest(control.a.text), decision: "not_helpful", expectedRevision: current.revision };
    assert.equal((await fixture.request("/api/personal/sessions/personal-a/feedback", "POST", changedInput)).status, 200);
    const beforeConflict = aPosts;
    await thumb("有帮助").click();
    await wait(async () => await selected("没有帮助") === "true" && await thumb("有帮助").isEnabled(), "conflicting page must refresh, not resubmit");
    assert.equal(aPosts, beforeConflict + 1);
    await thumb("有帮助").click();
    await wait(async () => await selected("有帮助") === "true" && await thumb("没有帮助").isEnabled(), "explicit correction after conflict did not save");
    const beforeLost = aPosts; loseNextA = true;
    await thumb("没有帮助").click();
    await page.getByText("评价请求未能核对，请刷新查看保存结果；未自动重复提交", { exact: true }).waitFor();
    assert.equal(aPosts, beforeLost + 1, "lost receipts must not automatically repeat writes");
    assert.equal((await fixture.request("/api/personal/sessions/personal-a/feedback")).body.feedback[0].decision, "not_helpful");
    await page.reload(); await wait(async () => await selected("没有帮助") === "true" && await thumb("有帮助").isEnabled(), "refresh must recover the saved evaluation after a lost receipt");
    const before = await fs.readFile(file, "utf8");
    for (const viewport of [{ width: 320, height: 800 }, { width: 390, height: 844 }, { width: 768, height: 900 }, { width: 1280, height: 900 }, { width: 320, height: 480 }]) {
      await page.setViewportSize(viewport);
      await thumb("有帮助").scrollIntoViewIfNeeded();
      const geometry = await page.evaluate(() => {
        const targets = [...document.querySelectorAll('.personal-message-feedback button')].map(button => {
          const rect = button.getBoundingClientRect(); return { width: rect.width, height: rect.height, left: rect.left, right: rect.right };
        });
        return { targets, overflow: document.documentElement.scrollWidth > innerWidth, width: innerWidth };
      });
      assert.equal(geometry.overflow, false);
      assert.equal(geometry.targets.length, 2);
      assert.ok(geometry.targets.every(rect => rect.width >= 44 && rect.height >= 44 && rect.left >= 0 && rect.right <= geometry.width));
      await page.screenshot({ path: path.join(out, `feedback-${viewport.width}-${viewport.height}.png`), fullPage: true });
    }
    assert.equal(await fs.readFile(file, "utf8"), before, "view changes do not submit ratings");
    control.a.status = "inProgress"; await fs.writeFile(fixture.control, JSON.stringify(control));
    await page.reload(); await page.getByText(control.a.text, { exact: true }).waitFor();
    assert.equal(await thumb("有帮助").count(), 0, "in-progress answers cannot be rated");
    await page.goto(`${fixture.base}/#/project/work/thread/work-history`);
    await page.getByRole("heading", { name: "云端 Codex" }).waitFor();
    assert.equal(await thumb("有帮助").count(), 0, "work conversations do not expose personal ratings");
    const rpc = (await fs.readFile(fixture.rpcCapture, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(rpc.some(item => ["turn/start", "thread/start", "mcpServer/tool/call", "feedback/upload", "command/exec"].includes(item.method)), false);
    assert.deepEqual(errors, []);
    console.log("个人回复评价 UI 验收通过：真实隔离后端、切换/迟到响应、刷新/重启、撤销、异常恢复及五种视口；无模型或第三方调用。");
  }
} catch (error) {
  if (page) {
    await page.screenshot({ path: path.join(out, "failure.png"), fullPage: true }).catch(() => null);
    await fs.writeFile(path.join(out, "failure.json"), JSON.stringify({ error: error.message, url: page.url(), text: await page.locator("body").innerText().catch(() => ""), requests, pageErrors: errors }, null, 2));
  }
  throw error;
} finally { closing = true; releaseHeld(); await browser?.close(); await fixture.stop(); }
