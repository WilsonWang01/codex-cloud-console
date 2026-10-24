import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const project = new URL("../", import.meta.url).pathname;
const fixture = spawn(process.execPath, ["scripts/verify-personal-facts-ui.mjs", "--serve", "--references"], { cwd: project, stdio: ["ignore", "pipe", "pipe"] });
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
    const data = await response.json(); assert.equal(response.status, 200, JSON.stringify(data)); assert.equal(data.ok, true); return data;
  };
  const session = await request("/api/chat/sessions", "POST", { repoId: "_personal", title: "合成引用验收" });
  const turn = await request("/api/chat", "POST", { repoId: "_personal", sessionId: session.activeSessionId, message: "合成引用验收" });
  assert.equal(turn.codexSessionId, "reference-runtime-thread");
  const history = () => request("/api/chat/sessions?" + new URLSearchParams({ repoId: "_personal", sessionId: session.activeSessionId }));
  const first = (await history()).messages.find(message => message.details?.personalFactReferences);
  assert.ok(first); assert.equal(first.details.personalFactReferences.references[0].state, "active");
  assert.doesNotMatch(JSON.stringify(first.details.contentItems), /本机验收示例/);
  browser = await chromium.launch({ channel: process.env.CODEX_CLOUD_CHROME_CHANNEL || "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  const url = base + "/#/project/_personal/thread/" + turn.codexSessionId;
  await page.goto(url);
  const open = async () => {
    const details = page.locator(".personal-reference-details");
    await details.locator("summary").first().waitFor();
    if (!await details.evaluate(element => element.open)) await details.locator("summary").first().click();
    return page.getByRole("region", { name: "本回合个人资料引用" });
  };
  const panel = await open();
  await panel.getByText("合成称呼", { exact: true }).waitFor();
  assert.match(await panel.innerText(), /引用版本 1.*当前有效/);
  assert.match(await panel.innerText(), /不等同于内部推理证明或任务成功回执/);
  assert.equal(await page.locator(".personal-reference-details").evaluate(element => getComputedStyle(element).maxHeight), "none");
  const out = path.join(project, "docs/research/acceptance/p033-references-20261024"); await fs.mkdir(out, { recursive: true });
  for (const width of [1280, 768, 390, 320]) {
    await page.setViewportSize({ width, height: width <= 390 ? 640 : 900 });
    await panel.scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    const control = await page.locator(".personal-reference-details > summary").boundingBox(); assert.ok(control && control.height >= 44);
    await page.screenshot({ path: path.join(out, `reference-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  let fact = (await request("/api/personal/facts")).facts[0];
  for (const [patch, state, label] of [
    [{ enabled: false }, "disabled", "资料已停用"],
    [{ enabled: true, expiresAt: new Date(Date.now() - 1000).toISOString() }, "expired", "资料已到期"],
    [{ expiresAt: null }, "reconfirmed", "之后已重新确认"],
    [{ label: "更正后的合成名称", value: "更正后的合成内容" }, "changed", "资料已更正"],
  ]) {
    fact = (await request(`/api/personal/facts/${fact.id}`, "PATCH", { label: fact.label, value: fact.value, ...patch, revision: fact.revision })).fact;
    const read = (await history()).messages.find(message => message.details?.personalFactReferences);
    assert.equal(read.details.personalFactReferences.references[0].state, state);
    await page.reload(); const current = await open(); await current.getByText(new RegExp(label)).waitFor();
    if (state === "changed") { assert.doesNotMatch(await current.innerText(), /更正后的合成内容|更正后的合成名称|合成称呼/); }
  }
  await request(`/api/personal/facts/${fact.id}`, "DELETE", { revision: fact.revision });
  await page.reload(); const removed = await open(); await removed.getByText(/资料已删除/).waitFor();
  assert.doesNotMatch(await removed.innerText(), /本机验收示例|更正后的合成内容|合成称呼/);
  await page.screenshot({ path: path.join(out, "reference-deleted.png"), fullPage: true });
  const rpc = (await fs.readFile(ready.rpcCapture, "utf8")).trim().split("\n").map(JSON.parse);
  const start = rpc.find(item => item.method === "thread/start");
  assert.ok(start.params.dynamicTools.some(tool => tool.name === "personal_facts_reference"));
  assert.equal(rpc.filter(item => item.method === "turn/start").length, 1, "history, state edits and reload must not repeat the synthetic turn");
  assert.equal(rpc.find(item => item.id === 0 && item.result)?.result.success, true);
  assert.equal(rpc.some(item => ["mcpServer/tool/call", "account/login/start"].includes(item.method)), false);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, backend: "actual isolated console", syntheticTurns: 1, referenceCallAcknowledged: true, externalModelCalls: 0,
    checks: ["原生工具注册与当前回合处理", "HTTP 历史来源投影", "引用与正文不复制", "四宽度44px与重载", "停用/到期/重确认/更正/删除", "不重复执行与零连接器写入"] }));
} finally {
  await browser?.close();
  if (fixture.exitCode === null) { const closed = new Promise(resolve => fixture.once("close", resolve)); fixture.kill("SIGTERM"); await closed; }
}
