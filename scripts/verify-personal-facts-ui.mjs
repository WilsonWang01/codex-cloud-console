import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

// The actual console backend and built UI run against disposable local state. No real model or connector is reachable.
const project = fileURLToPath(new URL("../", import.meta.url));
const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-facts-ui-"));
const state = path.join(root, "state"), personal = path.join(root, "personal"), bin = path.join(root, "bin");
await fs.mkdir(state); await fs.mkdir(bin); await fs.mkdir(path.join(personal, ".codex-cloud/uploads"), { recursive: true });
await fs.chmod(personal, 0o700);
await fs.mkdir(path.join(root, "work"));
await fs.writeFile(path.join(personal, ".codex-cloud/uploads/note.txt"), "synthetic attachment\n");
const source = { id: "facts-source", repoId: "_personal", title: "合成验收旧会话", codexSessionId: "legacy-facts-thread", messageCount: 1,
  model: "gpt-6-astra", reasoning: "ultra", sandbox: "workspace-write", approval: "on-request", search: false,
  messages: [{ id: "fixture-message", role: "user", text: "合成旧历史，不复制到新上下文", time: new Date().toISOString() }],
  draft: { input: "合成待发送草稿", revision: 1, attachments: [{ name: "note.txt", path: ".codex-cloud/uploads/note.txt", mimeType: "text/plain", kind: "file", size: 21 }] } };
await fs.writeFile(path.join(state, "chat-history.json"), JSON.stringify({ version: 2, activeByRepo: { _personal: source.id }, sessions: { [source.id]: source } }));
await fs.writeFile(path.join(state, "personal-facts.json"), JSON.stringify({ version: 1, facts: [{ id: "fixture-fact", label: "合成称呼", value: "本机验收示例", source: "user", revision: 1, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" }] }));
const capture = path.join(root, "rpc.jsonl");
await fs.writeFile(path.join(bin, "codex"), `#!/usr/bin/env node
import fs from 'node:fs'; import readline from 'node:readline';
if (process.argv.includes('--version')) { console.log('codex-cli 0.162.1'); process.exit(0); }
if (process.argv.includes('login')) { console.error('Logged in using ChatGPT'); process.exit(0); }
readline.createInterface({input:process.stdin}).on('line', line => {
  const m=JSON.parse(line); fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify(m)+'\\n'); if (m.id==null) return;
  let result={};
  if(m.method==='account/read') result={account:{type:'chatgpt',email:'fixture@example.test',planType:'plus'},requiresOpenaiAuth:false};
  if(m.method==='model/list') result={data:[{id:'gpt-6-sol',model:'gpt-6-sol',displayName:'GPT-6 Sol',defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium'}]},{id:'gpt-6-astra',model:'gpt-6-astra',displayName:'GPT-6 Astra',defaultReasoningEffort:'ultra',supportedReasoningEfforts:[{reasoningEffort:'ultra'}]}],nextCursor:null};
  if(m.method==='thread/list') result={data:[{id:'legacy-facts-thread',cwd:${JSON.stringify(personal)},name:'合成验收旧会话',createdAt:1790000000,updatedAt:1790000000}],nextCursor:null};
  if(m.method==='thread/read') result={thread:{id:'legacy-facts-thread',cwd:${JSON.stringify(personal)},turns:[{id:'fixture-turn',status:'completed',items:[{type:'userMessage',content:[{type:'text',text:'合成旧历史，不复制到新上下文'}]}]}]}};
  if(m.method==='app/list') result={data:[],nextCursor:null};
  if(m.method==='app/installed') result={apps:[]};
  if(m.method==='mcpServerStatus/list') result={data:[],nextCursor:null};
  if(['turn/start','turn/steer','thread/compact/start','thread/fork'].includes(m.method)) return process.stdout.write(JSON.stringify({id:m.id,error:{code:-32000,message:'Test fixture refuses model execution'}})+'\\n');
  process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');
});
`, { mode: 0o755 });
const port = await new Promise((resolve, reject) => {
  const listener = net.createServer(); listener.once("error", reject);
  listener.listen(0, "127.0.0.1", () => { const port = listener.address().port; listener.close(() => resolve(port)); });
});
const base = `http://127.0.0.1:${port}/`;
const server = spawn(process.execPath, [path.join(project, "server/index.mjs")], { cwd: project, stdio: ["ignore", "pipe", "pipe"], env: {
  PATH: `${bin}:${process.env.PATH}`, HOME: root, NODE_ENV: "production", HOST: "127.0.0.1", PORT: String(port),
  CODEX_CLOUD_ROOT: root, CODEX_STATE_ROOT: state, CODEX_HOME: path.join(root, "codex-home"), CODEX_PERSONAL_MODE: "shared", CODEX_PERSONAL_ROOT: personal,
  CODEX_CLOUD_REPOS_CONFIG_B64: Buffer.from(JSON.stringify([{ id: "sample-app", name: "合成工作项目", path: path.join(root, "work") }])).toString("base64"),
} });
let logs = "", browser;
server.stdout.on("data", chunk => { logs += chunk; }); server.stderr.on("data", chunk => { logs += chunk; });
const stop = async () => {
  await browser?.close();
  if (server.exitCode === null) { const closed = new Promise(resolve => server.once("close", resolve)); server.kill("SIGTERM"); await closed; }
  await fs.rm(root, { recursive: true, force: true });
};
try {
  for (let n = 0; n < 100 && !logs.includes("listening on"); n++) {
    if (server.exitCode !== null) throw new Error(logs);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.match(logs, /listening on/);
  assert.equal((await fetch(base)).status, 200);
  if (process.argv.includes("--serve")) {
    console.log(JSON.stringify({ url: `${base}#/project/_personal/thread/facts-source`, state: "isolated synthetic", stop: "SIGTERM this process", model: "refused" }));
    await new Promise(resolve => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
  } else {
    browser = await chromium.launch({ channel: process.env.CODEX_CLOUD_CHROME_CHANNEL || "chrome", headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    const out = path.join(project, "docs/research/acceptance/p03-facts-20261024"); await fs.mkdir(out, { recursive: true });
    await page.goto(`${base}#/project/_personal/thread/facts-source`);
    await page.getByRole("button", { name: "开启新上下文", exact: true }).waitFor();
    assert.equal(await page.getByRole("textbox", { name: "向个人助理发送消息" }).inputValue(), source.draft.input);
    for (const width of [1280, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      await page.screenshot({ path: path.join(out, `context-${width}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    const beforeCancel = page.url();
    page.once("dialog", dialog => dialog.dismiss());
    await page.getByRole("button", { name: "开启新上下文", exact: true }).click();
    assert.equal(page.url(), beforeCancel);
    page.once("dialog", dialog => dialog.accept());
    await page.getByRole("button", { name: "开启新上下文", exact: true }).click();
    await page.waitForURL(url => !url.hash.includes("facts-source") && !url.hash.includes("legacy-facts-thread"));
    assert.equal(await page.getByRole("textbox", { name: "向个人助理发送消息" }).inputValue(), source.draft.input);
    assert.equal(await page.getByText("note.txt", { exact: true }).count() > 0, true);
    const chat = JSON.parse(await fs.readFile(path.join(state, "chat-history.json"), "utf8"));
    const copied = chat.sessions[chat.activeByRepo._personal];
    assert.equal(copied.codexSessionId, null); assert.deepEqual(copied.messages, []);
    assert.equal(copied.model, "gpt-6-astra"); assert.equal(copied.reasoning, "ultra"); assert.equal(copied.sandbox, "workspace-write");
    assert.equal(chat.sessions[source.id].draft.input, source.draft.input);
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "编辑 合成称呼", exact: true }).click();
    assert.equal(await page.getByLabel("在后续个人任务中使用").isChecked(), true);
    await page.getByLabel("在后续个人任务中使用").uncheck();
    await page.getByLabel("设置有效期").check();
    await page.getByLabel("事实到期时间").fill("2026-10-25T18:00");
    await page.getByRole("button", { name: "保存修改", exact: true }).click();
    await page.getByText(/已停用 · 有效至/).waitFor();
    for (const width of [1280, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.getByRole("button", { name: "编辑 合成称呼", exact: true }).click();
      assert.equal(await page.getByLabel("在后续个人任务中使用").isChecked(), false);
      assert.equal(await page.getByLabel("事实到期时间").inputValue(), "2026-10-25T18:00");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      await page.locator(".personal-facts").screenshot({ path: path.join(out, `facts-${width}.png`) });
      await page.getByRole("button", { name: "取消编辑", exact: true }).click();
    }
    const facts = JSON.parse(await fs.readFile(path.join(state, "personal-facts.json"), "utf8"));
    assert.equal(facts.version, 2); assert.equal(facts.facts[0].enabled, false); assert.ok(facts.facts[0].confirmedAt);
    const rpc = (await fs.readFile(capture, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(rpc.some(message => ["turn/start", "turn/steer", "thread/compact/start", "thread/fork", "mcpServer/tool/call"].includes(message.method)), false);
    assert.deepEqual(errors, []);
    console.log("PASS actual isolated backend/UI: four widths, explicit fresh context, preserved original draft/attachment/runtime, expiry/disable; zero model or connector writes");
  }
} finally { await stop(); }
