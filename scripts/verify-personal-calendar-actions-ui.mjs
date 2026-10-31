import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const project = new URL("../", import.meta.url).pathname;
const model = process.argv.includes("--model-proposals");
const fixture = spawn(process.execPath, ["scripts/verify-personal-facts-ui.mjs", "--serve", model ? "--calendar-model" : "--calendar-actions"], { cwd: project, stdio: ["ignore", "pipe", "pipe"] });
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
  const base = new URL(ready.url).origin, route = "/api/personal/calendar-proposals";
  const csrf = await fetch(base + route, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://untrusted.example.test" }, body: "{}" });
  assert.equal(csrf.status, 403);
  const request = async (url = route, method = "GET", body) => {
    const response = await fetch(base + url, { method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
    return { status: response.status, data: await response.json() };
  };
  const control = value => fs.writeFile(ready.calendarControl, JSON.stringify(value));
  browser = await chromium.launch({ channel: process.env.CODEX_CLOUD_CHROME_CHANNEL || "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  if (model) {
    await page.goto(ready.url);
    await page.getByRole("region", { name: "日程提案", exact: true }).getByRole("button", { name: "让助理起草", exact: true }).click();
    const composer = page.getByRole("textbox", { name: "向个人助理发送消息", exact: true });
    await composer.waitFor(); assert.match(await composer.inputValue(), /不创建或修改日历/);
    assert.equal((await fs.readFile(ready.rpcCapture, "utf8")).includes('"method":"turn/start"'), false);
    await composer.fill("合成日程起草验收"); await page.getByRole("button", { name: "发送消息", exact: true }).click();
    const link = page.getByRole("link", { name: "查看日程提案", exact: true }); await link.waitFor();
    let item = (await request()).data.proposals[0]; assert.equal(item.source, "assistant"); assert.equal(item.attempted, false); assert.equal(item.preview, null);
    assert.equal(JSON.parse(await fs.readFile(ready.calendarEvents, "utf8")).length, 0);
    const out = path.resolve(process.env.CODEX_CALENDAR_UI_OUTPUT || path.join(project, "docs/research/acceptance/p022-model-proposals-20261024")); await fs.mkdir(out, { recursive: true });
    for (const [width, height] of [[1280, 900], [768, 900], [390, 640], [320, 480]]) {
      await page.setViewportSize({ width, height }); await link.scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      const box = await link.boundingBox(); assert.ok(box && box.height >= 44 && box.x >= 0 && box.x + box.width <= width + 1);
      await page.screenshot({ path: path.join(out, `chat-${width}.png`), fullPage: true });
    }
    await link.click(); const section = page.getByRole("region", { name: "日程提案", exact: true });
    await section.getByText("合成对话日程提案", { exact: true }).waitFor();
    await page.getByText("1 项需要你处理", { exact: true }).waitFor();
    await page.getByRole("button", { name: /1 条日程提案待核对/ }).waitFor();
    await section.getByText("初始提案来源", { exact: true }).click();
    await section.getByText("助理说明：合成用户在当前个人对话中明确要求起草", { exact: true }).waitFor();
    for (const width of [1280, 768, 390, 320]) {
      await page.setViewportSize({ width, height: width < 400 ? 640 : 900 }); await section.scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      await section.screenshot({ path: path.join(out, `source-${width}.png`) });
    }
    await section.getByRole("button", { name: "查看来源对话", exact: true }).click(); await link.waitFor();
    await page.reload(); await link.waitFor(); await link.click();
    await section.getByRole("button", { name: "编辑日程 合成对话日程提案", exact: true }).click();
    await section.getByLabel("日程标题", { exact: true }).fill("用户更正后的日程草稿"); await section.getByRole("button", { name: "保存草稿", exact: true }).click();
    await section.getByText("用户更正后的日程草稿", { exact: true }).waitFor();
    item = (await request()).data.proposals[0]; assert.equal(item.origin.callId, "reference-runtime-call");
    await section.getByRole("button", { name: "拒绝日程 用户更正后的日程草稿", exact: true }).click();
    await page.reload(); await section.locator("details.personal-completed > summary").click(); await section.getByText("初始提案来源", { exact: true }).click();
    await section.getByRole("button", { name: "查看来源对话", exact: true }).click(); await link.waitFor();
    const updatedProposal = page.locator(".chat-window").getByText("日程提案已保存：用户更正后的日程草稿", { exact: true });
    await updatedProposal.scrollIntoViewIfNeeded();
    await updatedProposal.screenshot({ path: path.join(out, "updated-proposal.png") });
    assert.equal(await updatedProposal.innerText(), "日程提案已保存：用户更正后的日程草稿");
    const current = (await request()).data.proposals[0]; assert.equal(current.status, "rejected"); assert.equal(current.attempted, false);
    await link.click(); await page.getByText("1 项需要你处理", { exact: true }).waitFor({ state: "detached" });
    const rpc = (await fs.readFile(ready.rpcCapture, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(rpc.filter(item => item.method === "turn/start").length, 1); assert.equal(rpc.some(item => ["google_calendar.search", "google_calendar.fetch", "google_calendar.read_event", "google_calendar.create_event"].includes(item.params?.tool)), false);
    assert.ok(rpc.find(item => item.method === "thread/start" && item.params?.serviceName === "codex_cloud_console").params.dynamicTools.some(tool => tool.name === "personal_calendar_propose"));
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, backend: "actual isolated console", syntheticTurns: 1, realModelCalls: 0, realCalendarWrites: 0, checks: ["今日入口仅准备消息", "原生工具到持久草稿", "聊天到提案及回源", "四宽度短屏", "重载不重复运行", "编辑拒绝保留来源"] }));
  } else {
  await page.goto(ready.url);
  const section = page.getByRole("region", { name: "日程提案", exact: true });
  await section.getByRole("button", { name: "新增草稿", exact: true }).click();
  const date = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  await section.getByLabel("日程标题", { exact: true }).fill("合成日程：核对申请材料");
  await section.getByLabel("开始", { exact: true }).fill(date + "T10:00");
  await section.getByLabel("结束", { exact: true }).fill(date + "T10:30");
  await section.getByLabel("时区", { exact: true }).fill("Asia/Shanghai");
  await section.getByLabel("说明", { exact: true }).fill("合成草稿，不连接真实 Google 账号。");
  await page.reload(); await section.getByLabel("日程标题", { exact: true }).waitFor();
  assert.equal(await section.getByLabel("日程标题", { exact: true }).inputValue(), "合成日程：核对申请材料");
  const out = path.resolve(process.env.CODEX_CALENDAR_UI_OUTPUT || path.join(project, "docs/research/acceptance/p02-calendar-actions-20261024")); await fs.mkdir(out, { recursive: true });
  const heading = section.getByRole("heading", { name: /^日程提案/ });
  const singleLineHeight = (await heading.boundingBox()).height;
  const assertHeadingFits = async width => assert.ok((await heading.boundingBox()).height <= singleLineHeight + 1, `日程标题被工具栏挤压：${width}px`);
  for (const [width, height] of [[1280, 900], [768, 900], [390, 640], [320, 640]]) {
    await page.setViewportSize({ width, height }); await section.scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await assertHeadingFits(width);
    for (const input of await section.locator("input, textarea, button").all()) { if (!await input.isVisible()) continue; const box = await input.boundingBox(); assert.ok(box && box.x >= 0 && box.x + box.width <= width + 1 && box.height >= (await input.getAttribute("type") === "checkbox" ? 18 : 43)); }
    await section.locator("fieldset").screenshot({ path: path.join(out, `editor-${width}.png`) });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await control({ mode: "ambiguous-accounts" });
  await section.getByRole("button", { name: "保存草稿", exact: true }).click();
  await section.getByRole("alert").getByText("日历工具声明了多个账号或账号来源无法确认，未读取或执行操作", { exact: true }).waitFor();
  assert.equal(await section.getByLabel("日程标题", { exact: true }).inputValue(), "合成日程：核对申请材料");
  assert.equal((await request()).data.proposals.length, 0);
  assert.equal(JSON.parse(await fs.readFile(ready.calendarEvents, "utf8")).length, 0);
  assert.equal((await fs.readFile(ready.rpcCapture, "utf8")).trim().split("\n").map(JSON.parse).some(call => call.method === "mcpServer/tool/call"), false);
  await page.setViewportSize({ width: 390, height: 640 }); await section.screenshot({ path: path.join(out, "ambiguous-account-390.png") });
  await page.setViewportSize({ width: 1280, height: 900 });
  await control({ mode: "ok" });
  await section.getByRole("button", { name: "保存草稿", exact: true }).click();
  await section.getByText("草稿 · 未执行", { exact: true }).waitFor();
  assert.equal(JSON.parse(await fs.readFile(ready.calendarEvents, "utf8")).length, 0);
  await section.getByRole("button", { name: "编辑日程 合成日程：核对申请材料", exact: true }).click();
  await section.getByLabel("日程标题", { exact: true }).fill("本机未保存修改");
  const savedDraft = (await request()).data.proposals[0];
  assert.equal((await request(route + `/${savedDraft.id}`, "PATCH", { revision: savedDraft.revision, form: { title: savedDraft.payload.title, description: "另一设备更新说明", timeZone: "Asia/Shanghai", startLocal: date + "T10:00", endLocal: date + "T10:30" } })).status, 200);
  await section.getByRole("button", { name: "刷新日程提案", exact: true }).click();
  await section.getByRole("button", { name: "保存草稿", exact: true }).click();
  await section.getByRole("alert").getByText("提案已在其他页面变化，请核对最新内容；你的输入未保存", { exact: true }).waitFor();
  assert.equal(await section.getByLabel("日程标题", { exact: true }).inputValue(), "本机未保存修改");
  await section.getByRole("button", { name: "取消", exact: true }).click();
  await section.getByRole("button", { name: "核对并预览", exact: true }).click();
  let confirmation = section.getByRole("region", { name: "确认日程 合成日程：核对申请材料", exact: true });
  await confirmation.waitFor(); assert.equal(await confirmation.getByRole("button", { name: "确认并创建", exact: true }).isDisabled(), true);
  await control({ email: "changed@example.test" });
  await confirmation.getByRole("checkbox", { name: "我确认以上账号、内容和影响，允许创建这一条日程", exact: true }).check();
  await confirmation.getByRole("button", { name: "确认并创建", exact: true }).click();
  await section.getByRole("alert").getByText("目标账号或工具已变化，请重新绑定并核对", { exact: true }).waitFor();
  assert.equal(JSON.parse(await fs.readFile(ready.calendarEvents, "utf8")).length, 0);
  await section.getByRole("button", { name: "重新绑定账号", exact: true }).click();
  await section.getByText(/changed@example.test · 主日历/).waitFor();
  await control({ email: "changed@example.test", mode: "conflict" });
  await section.getByRole("button", { name: "核对并预览", exact: true }).click(); await confirmation.getByText("此时段已有日程", { exact: true }).waitFor();
  await confirmation.getByRole("checkbox", { name: "我确认以上账号、内容和影响，允许创建这一条日程", exact: true }).check();
  assert.equal(await confirmation.getByRole("button", { name: "确认并创建", exact: true }).isDisabled(), true);
  for (const width of [1280, 768, 390, 320]) {
    await page.setViewportSize({ width, height: width < 400 ? 640 : 900 }); await confirmation.scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await confirmation.screenshot({ path: path.join(out, `confirmation-${width}.png`) });
  }
  await confirmation.getByRole("checkbox", { name: "我已核对冲突，仍要创建", exact: true }).check();
  await confirmation.getByRole("button", { name: "确认并创建", exact: true }).click();
  await section.getByText("已创建并核验", { exact: true }).waitFor({ state: "attached" });
  await page.reload(); const handled = section.locator("details.personal-completed"); await handled.locator("summary").click(); await section.getByText("已创建并核验", { exact: true }).waitFor();
  assert.equal(JSON.parse(await fs.readFile(ready.calendarEvents, "utf8")).length, 1);
  let items = (await request()).data.proposals; assert.equal(items[0].receipt.source, "google_calendar.read_event");
  const retry = await request(route + `/${items[0].id}/execute`, "POST", { revision: items[0].confirmation.revision, digest: items[0].confirmation.digest, confirm: true, confirmConflicts: true });
  assert.equal(retry.status, 200); assert.equal(JSON.parse(await fs.readFile(ready.calendarEvents, "utf8")).length, 1);
  const invalid = await request(route, "POST", { clientKey: crypto.randomUUID(), form: { title: "不能指定其他日历", calendar_id: "other" } }); assert.equal(invalid.status, 400);
  await control({ email: "changed@example.test", mode: "lost-receipt" });
  const created = await request(route, "POST", { clientKey: crypto.randomUUID(), form: { title: "合成丢失回执", timeZone: "Asia/Shanghai", startLocal: date + "T11:00", endLocal: date + "T11:30" } }); assert.equal(created.status, 200);
  const checked = (await request(route + `/${created.data.proposal.id}/preview`, "POST", { revision: 1 })).data.proposal;
  const uncertain = await request(route + `/${checked.id}/execute`, "POST", { revision: checked.revision, digest: checked.preview.digest, confirm: true }); assert.equal(uncertain.data.proposal.status, "needs_reconciliation");
  await page.reload(); await section.getByText("结果待核对 · 未自动重试", { exact: true }).waitFor();
  assert.equal((await request("/api/codex/app-host/status")).data.activeJobs.some(job => job.id === `calendar:${checked.id}`), true);
  await section.getByLabel("原日历核对说明", { exact: true }).fill("合成验收：已在原日历找到该测试日程，未重新创建");
  await section.getByRole("button", { name: "我已在原日历核对", exact: true }).click();
  await section.getByText("结果待核对 · 未自动重试", { exact: true }).waitFor({ state: "detached" });
  items = (await request()).data.proposals; assert.equal(items.find(item => item.id === checked.id).status, "reconciled");
  assert.equal((await request("/api/codex/app-host/status")).data.activeJobs.some(job => job.id === `calendar:${checked.id}`), false);
  assert.equal(JSON.parse(await fs.readFile(ready.calendarEvents, "utf8")).length, 2);
  await control({ email: "changed@example.test", mode: "connector-partial" });
  await request(route, "POST", { clientKey: crypto.randomUUID(), form: { title: "合成连接器缺少设置", timeZone: "Asia/Shanghai", startLocal: date + "T12:00", endLocal: date + "T12:30" } });
  await section.getByRole("button", { name: "刷新日程提案", exact: true }).click();
  const partial = section.locator("article.calendar-action-row").filter({ has: page.getByText("合成连接器缺少设置", { exact: true }) });
  await partial.getByRole("button", { name: "核对并预览", exact: true }).click();
  const partialConfirm = partial.getByRole("region", { name: "确认日程 合成连接器缺少设置", exact: true });
  await partialConfirm.getByRole("checkbox", { name: "我确认以上账号、内容和影响，允许创建这一条日程", exact: true }).check();
  await partialConfirm.getByRole("button", { name: "确认并创建", exact: true }).click();
  await partial.getByText(/内容匹配.*未返回忙闲设置、来宾修改权限/).waitFor();
  await page.reload(); await partial.getByText(/内容匹配.*未返回忙闲设置、来宾修改权限/).waitFor();
  assert.match(await section.getByRole("heading", { name: /日程提案/ }).innerText(), /日程提案\s+1/);
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: width < 400 ? 640 : 900 }); await partial.scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await assertHeadingFits(width);
    await partial.screenshot({ path: path.join(out, `partial-receipt-${width}.png`) });
  }
  await partial.getByRole("button", { name: "只读核验回执", exact: true }).click();
  await section.getByRole("alert").getByText(/内容匹配.*未返回忙闲设置、来宾修改权限/).waitFor();
  await page.getByRole("button", { name: /1 条日程提案待核对/ }).waitFor();
  await page.getByText("1 项需要你处理", { exact: true }).waitFor();
  const partialItem = (await request()).data.proposals.find(item => item.payload.title === "合成连接器缺少设置");
  assert.equal(partialItem.status, "needs_reconciliation"); assert.equal(partialItem.receipt, null);
  assert.equal((await request("/api/codex/app-host/status")).data.activeJobs.some(job => job.id === `calendar:${partialItem.id}`), true);
  assert.equal(JSON.parse(await fs.readFile(ready.calendarEvents, "utf8")).length, 3);
  const rpc = (await fs.readFile(ready.rpcCapture, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(rpc.some(item => ["turn/start", "account/login/start"].includes(item.method)), false);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, backend: "actual isolated console and native RPC fixture", realModelCalls: 0, realThirdPartyWrites: 0, syntheticCreates: 3, checks: ["草稿刷新找回", "四宽度编辑和确认", "多账号声明在来源读取前拒绝且保留输入", "账号变化拒绝", "冲突单独确认", "实际RPC单次执行与重复确认", "丢失回执阻止发布/人工核对", "缺少设置不冒充成功且只读核验不重复写入", "请求边界"] }));
  }
} finally {
  await browser?.close();
  if (fixture.exitCode === null) { const closed = new Promise(resolve => fixture.once("close", resolve)); fixture.kill("SIGTERM"); await closed; }
}
