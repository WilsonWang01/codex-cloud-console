import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const project = new URL("../", import.meta.url).pathname;
const fixture = spawn(process.execPath, ["scripts/verify-personal-facts-ui.mjs", "--serve", "--memory", "--large-directory"], { cwd: project, stdio: ["ignore", "pipe", "pipe"] });
let output = "", browser;
fixture.stdout.on("data", chunk => { output += chunk; }); fixture.stderr.on("data", chunk => { output += chunk; });
try {
  let ready;
  for (let n = 0; n < 200 && !ready; n++) {
    if (fixture.exitCode !== null) throw new Error(output);
    ready = output.split("\n").filter(line => line.startsWith("{")).map(line => { try { return JSON.parse(line); } catch { return null; } }).find(item => item?.url);
    if (!ready) await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(ready, output); assert.equal((await fetch(ready.url)).status, 200);
  browser = await chromium.launch({ channel: process.env.CODEX_CLOUD_CHROME_CHANNEL || "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  let catalogRequests = 0; page.on("request", request => { if (new URL(request.url()).pathname === "/api/codex/apps") catalogRequests++; });
  await page.goto(ready.url); await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByText("13 项服务可调用", { exact: true }).waitFor();
  const services = page.locator(".connected-services"), rows = services.locator(".connected-service-row");
  await rows.nth(12).waitFor(); assert.equal(await rows.count(), 13);
  const description = rows.filter({ hasText: "Gmail" }).locator(".connected-service-description");
  assert.equal(await description.evaluate(element => element.open), false);
  await description.locator("summary").click(); assert.equal(await description.evaluate(element => element.open), true);
  await description.locator("summary").click(); assert.equal(await description.evaluate(element => element.open), false);
  assert.equal(await services.getByRole("button", { name: "当前可用", exact: true }).getAttribute("aria-pressed"), "true");
  assert.equal(await services.getByRole("button", { name: "下一页服务", exact: true }).count(), 0);
  const headings = await page.locator(".personal-settings").getByRole("heading", { level: 2 }).allTextContents();
  assert.ok(headings.indexOf("偏好与事实") < headings.indexOf("连接服务"));
  await page.getByRole("button", { name: "核对 合成出行偏好", exact: true }).waitFor();
  const out = path.join(project, "docs/research/acceptance/services-directory-20261024"); await fs.mkdir(out, { recursive: true });
  await services.getByRole("button", { name: "服务目录", exact: true }).click();
  assert.equal(await rows.count(), 20);
  assert.match(await services.locator(".connected-service-pagination").innerText(), /1–20.*2,000/s);
  assert.equal(await services.getByRole("button", { name: "上一页服务" }).isDisabled(), true);
  const first = await rows.locator("strong").allTextContents();
  await services.getByRole("button", { name: "下一页服务" }).click();
  assert.match(await services.locator(".connected-service-pagination").innerText(), /21–40/);
  assert.equal(await rows.count(), 20); assert.equal((await rows.locator("strong").allTextContents()).some(name => first.includes(name)), false);
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "服务列表");
  const position = await services.getByRole("region", { name: "服务列表" }).boundingBox(); assert.ok(position && position.y >= 0 && position.y < 450);
  await fs.writeFile(ready.directoryControl, "16");
  await services.getByRole("button", { name: "刷新连接" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".connected-service-row").length === 16);
  assert.equal(await services.getByRole("button", { name: "下一页服务" }).count(), 0);
  await fs.writeFile(ready.directoryControl, "2013");
  await services.getByRole("button", { name: "刷新连接" }).click();
  await services.getByRole("button", { name: "下一页服务" }).waitFor();
  assert.match(await services.locator(".connected-service-pagination").innerText(), /1–20.*2,000/s);
  const search = services.getByRole("textbox", { name: "搜索服务" });
  await search.fill("合成目录 1999"); await rows.getByText("合成目录 1999", { exact: true }).waitFor(); assert.equal(await rows.count(), 1);
  await search.fill("合成目录 1998"); await rows.getByText("合成目录 1998", { exact: true }).waitFor();
  assert.equal(await rows.getByRole("link").getAttribute("href"), "https://chatgpt.com/apps");
  await services.getByRole("button", { name: "当前可用", exact: true }).click();
  await services.getByText("没有匹配的服务。", { exact: true }).waitFor();
  await search.fill(""); await rows.nth(12).waitFor(); assert.equal(await rows.count(), 13);
  assert.equal(catalogRequests, 3, "filters, searching and paging must not refetch or authorize services");
  for (const width of [1280, 768, 390, 320]) {
    await page.setViewportSize({ width, height: width <= 390 ? 640 : 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.getByRole("heading", { name: "偏好与事实", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(out, `memory-${width}.png`), fullPage: true });
    await services.getByRole("button", { name: "服务目录", exact: true }).click();
    assert.equal(await rows.count(), 20);
    await services.getByRole("button", { name: "下一页服务", exact: true }).click();
    for (const button of await services.locator(".connected-service-scope button, .connected-service-pagination button").all()) {
      const box = await button.boundingBox(); assert.ok(box && box.height >= 44 && box.width >= 44);
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.screenshot({ path: path.join(out, `directory-${width}.png`) });
    await services.getByRole("button", { name: "当前可用", exact: true }).click();
  }
  await page.setViewportSize({ width: 390, height: 640 });
  await page.goto(ready.url);
  await page.getByRole("button", { name: "连接服务", exact: true }).click();
  const panel = page.locator(".command-panel");
  await panel.getByText("13 项服务可调用", { exact: true }).waitFor();
  assert.equal(await panel.getByRole("button", { name: "服务目录", exact: true }).getAttribute("aria-pressed"), "true");
  assert.equal(await panel.locator(".connected-service-row").count(), 20);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await page.screenshot({ path: path.join(out, "connection-panel-390.png") });
  await panel.getByRole("button", { name: "关闭面板", exact: true }).click();
  const rpc = (await fs.readFile(ready.rpcCapture, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(rpc.some(item => ["turn/start", "turn/steer", "mcpServer/tool/call", "account/login/start"].includes(item.method)), false);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, loaded: 2000, callable: 13, maximumRendered: 20, catalogRequests, checks: ["默认可用与全目录切换", "完整已载入目录搜索", "分页焦点和位置", "刷新目录缩小不留空页", "危险授权链接拒绝", "记忆先于连接入口", "四宽度与44px触控", "零模型、业务工具或登录调用"] }));
} finally {
  await browser?.close();
  if (fixture.exitCode === null) { const closed = new Promise(resolve => fixture.once("close", resolve)); fixture.kill("SIGTERM"); await closed; }
}
