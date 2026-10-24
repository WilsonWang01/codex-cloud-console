import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const project = new URL("../", import.meta.url).pathname;
const fixture = spawn(process.execPath, ["scripts/verify-personal-facts-ui.mjs", "--serve", "--goal-progress"], { cwd: project, stdio: ["ignore", "pipe", "pipe"] });
let output = "", browser;
fixture.stdout.on("data", chunk => { output += chunk; }); fixture.stderr.on("data", chunk => { output += chunk; });
try {
  let ready;
  for (let n = 0; n < 200 && !ready; n++) {
    if (fixture.exitCode !== null) throw new Error(output);
    ready = output.split("\n").filter(line => line.startsWith("{")).map(line => { try { return JSON.parse(line); } catch { return null; } }).find(item => item?.url);
    if (!ready) await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(ready, output);
  const base = new URL(ready.url).origin;
  const request = async (route, method = "GET", body) => {
    const response = await fetch(base + route, { method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
    const data = await response.json(); assert.equal(response.status, 200, JSON.stringify(data)); return data;
  };
  browser = await chromium.launch({ channel: process.env.CODEX_CLOUD_CHROME_CHANNEL || "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  const out = path.join(project, "docs/research/acceptance/p034-progress-20261024"); await fs.mkdir(out, { recursive: true });
  const today = base + "/#/project/_personal/today";
  await page.goto(today);
  let section = page.getByRole("region", { name: "个人关注事项", exact: true });
  await section.getByRole("button", { name: "添加", exact: true }).click();
  await page.getByLabel("事项名称", { exact: true }).fill("跨日行程准备（合成）");
  await page.getByLabel("下一步", { exact: true }).fill("确认出行日期后继续安排");
  await page.getByLabel("等待原因", { exact: true }).fill("等家人确认日期");
  for (const title of ["已整理可选车次", "确认出行日期"]) {
    await page.getByRole("button", { name: "添加步骤", exact: true }).click();
    await page.getByLabel(`步骤 ${title === "已整理可选车次" ? 1 : 2} 名称`, { exact: true }).fill(title);
  }
  await page.getByLabel("步骤 1 已完成", { exact: true }).check();
  await page.getByLabel("选择关联个人对话", { exact: true }).selectOption("goal-result");
  await page.getByRole("button", { name: "关联对话", exact: true }).click();
  await page.getByRole("button", { name: "添加事项", exact: true }).click();
  await section.getByText("等待：等家人确认日期", { exact: true }).waitFor();
  const openProgress = async () => {
    const details = section.locator(".personal-commitment-progress").first();
    await details.locator("summary").waitFor();
    if (!await details.evaluate(element => element.open)) await details.locator("summary").click();
    return details;
  };
  await openProgress();
  await section.getByRole("button", { name: /合成昨日车次结果.*查看原对话与结果/ }).click();
  await page.getByText("合成昨日结果：已整理可选车次，等待确认出行日期；没有预订或付款。", { exact: true }).waitFor();
  assert.ok(page.url().includes("goal-result-thread"));
  await page.getByRole("button", { name: "今日", exact: true }).click();
  section = page.getByRole("region", { name: "个人关注事项", exact: true });
  await section.getByRole("button", { name: "编辑 跨日行程准备（合成）", exact: true }).click();
  await page.getByLabel("事项名称", { exact: true }).fill("本机未提交的行程目标");
  await page.getByLabel("下一步", { exact: true }).fill("保留本机填写的下一步");
  let item = (await request("/api/personal/commitments")).commitments[0];
  await request(`/api/personal/commitments/${item.id}`, "PATCH", { revision: item.revision, waitingReason: "另一台设备更新的等待原因" });
  await section.getByRole("button", { name: "刷新关注事项", exact: true }).click();
  await section.getByText("等待：另一台设备更新的等待原因", { exact: true }).waitFor();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByRole("region", { name: "个人事项冲突", exact: true }).waitFor();
  assert.equal(await page.getByLabel("事项名称", { exact: true }).inputValue(), "本机未提交的行程目标");
  assert.equal(await page.getByLabel("下一步", { exact: true }).inputValue(), "保留本机填写的下一步");
  assert.equal(await page.getByRole("button", { name: "保存", exact: true }).isDisabled(), true);
  await page.getByRole("button", { name: "保留我的修改继续编辑", exact: true }).click();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await section.getByText("本机未提交的行程目标", { exact: true }).waitFor();
  await openProgress();
  await page.getByLabel("完成步骤 确认出行日期", { exact: true }).check();
  await section.locator("summary").getByText("步骤 2/2 · 1 个对话", { exact: true }).waitFor();
  item = (await request("/api/personal/commitments")).commitments[0];
  assert.equal(item.status, "active"); assert.equal(item.waitingReason, "等家人确认日期");
  for (const failure of [{ status: 503, contentType: "application/json", body: JSON.stringify({ error: "合成保存失败" }) }, { status: 200, contentType: "text/html", body: "<h1>Synthetic proxy response</h1>" }]) {
    let releaseFailure;
    const failureRequest = new Promise(resolve => { releaseFailure = resolve; });
    const failureRoute = async route => { if (route.request().method() === "PATCH") releaseFailure(route); else await route.continue(); };
    await page.route(base + `/api/personal/commitments/${item.id}`, failureRoute);
    await page.getByLabel("完成步骤 确认出行日期", { exact: true }).uncheck();
    await section.getByText("保存中…", { exact: true }).waitFor();
    await (await failureRequest).fulfill(failure);
    await section.getByRole("alert").getByText(/已还原显示，请刷新核对保存结果/).waitFor();
    assert.equal(await page.getByLabel("完成步骤 确认出行日期", { exact: true }).isChecked(), true);
    assert.equal((await request("/api/personal/commitments")).commitments[0].milestones[1].done, true);
    await page.unroute(base + `/api/personal/commitments/${item.id}`, failureRoute);
  }
  await page.reload(); await section.getByText("等待：等家人确认日期", { exact: true }).waitFor();
  await openProgress();
  for (const [width, height] of [[1280, 900], [768, 900], [390, 640], [320, 640]]) {
    await page.setViewportSize({ width, height });
    await section.scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    for (const control of await section.locator("button, summary, .personal-commitment-progress label").all()) {
      if (!await control.isVisible()) continue;
      const box = await control.boundingBox(); assert.ok(box && box.height >= 43 && box.x >= 0 && box.x + box.width <= width + 1);
    }
    await section.screenshot({ path: path.join(out, `progress-${width}.png`) });
    await section.getByRole("button", { name: "编辑 本机未提交的行程目标", exact: true }).click();
    await page.getByLabel("步骤 1 名称", { exact: true }).waitFor();
    assert.equal(await page.getByLabel("步骤 2 已完成", { exact: true }).isChecked(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await section.locator(".personal-commitment-editor").screenshot({ path: path.join(out, `editor-${width}.png`) });
    await section.getByRole("button", { name: "取消", exact: true }).click();
  }
  await section.getByRole("button", { name: "完成 本机未提交的行程目标", exact: true }).click();
  await section.locator(".personal-completed > summary").click(); await openProgress();
  await section.getByRole("button", { name: /合成昨日车次结果.*查看原对话与结果/ }).waitFor();
  await section.getByRole("button", { name: "重新跟进 本机未提交的行程目标", exact: true }).click();
  item = (await request("/api/personal/commitments")).commitments[0];
  assert.equal(item.status, "active"); assert.deepEqual(item.relatedSessionIds, ["goal-result"]); assert.equal(item.milestones.every(step => step.done), true);
  const legacy = await browser.newPage();
  await legacy.route("**/api/personal/commitments", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, commitments: [item] }) }));
  await legacy.goto(today);
  await legacy.getByRole("button", { name: "编辑 本机未提交的行程目标", exact: true }).click();
  await legacy.getByText("服务器暂不支持步骤、等待原因与多段对话关联，请先更新服务器。", { exact: true }).waitFor();
  assert.equal(await legacy.getByLabel("等待原因", { exact: true }).count(), 0); await legacy.close();
  const rpc = (await fs.readFile(ready.rpcCapture, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(rpc.some(item => ["turn/start", "mcpServer/tool/call", "account/login/start"].includes(item.method)), false);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, backend: "actual isolated console", externalModelCalls: 0, thirdPartyWrites: 0,
    checks: ["步骤/等待原因/原生昨日结果关联", "刷新和导航不丢进度", "实际版本冲突与输入保留", "步骤保存待确认/失败还原且不自动重试", "步骤完成不自动完成目标", "四宽度44px与编辑器无横溢", "完成与重新跟进保留原结果", "旧后端不冒充已支持进度"] }));
} finally {
  await browser?.close();
  if (fixture.exitCode === null) { const closed = new Promise(resolve => fixture.once("close", resolve)); fixture.kill("SIGTERM"); await closed; }
}
