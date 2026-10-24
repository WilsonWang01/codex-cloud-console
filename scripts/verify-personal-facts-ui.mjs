import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createPersonalFactsStore } from "../server/personal-facts.mjs";

// The actual console backend and built UI run against disposable local state. No real model or connector is reachable.
const project = fileURLToPath(new URL("../", import.meta.url));
const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-facts-ui-"));
const state = path.join(root, "state"), personal = path.join(root, "personal"), bin = path.join(root, "bin");
await fs.mkdir(state); await fs.mkdir(bin); await fs.mkdir(path.join(personal, ".codex-cloud/uploads"), { recursive: true });
await fs.chmod(personal, 0o700);
await fs.mkdir(path.join(root, "work"));
await fs.writeFile(path.join(personal, ".codex-cloud/uploads/note.txt"), "synthetic attachment\n");
await fs.mkdir(path.join(root, "work/.codex-cloud/uploads"), { recursive: true });
await fs.writeFile(path.join(root, "work/.codex-cloud/uploads/note.txt"), "synthetic attachment\n");
const source = { id: "facts-source", repoId: "_personal", title: "合成验收旧会话", codexSessionId: "legacy-facts-thread", messageCount: 1,
  model: "gpt-6-astra", reasoning: "ultra", sandbox: "workspace-write", approval: "on-request", search: false,
  messages: [{ id: "fixture-message", role: "user", text: "合成旧历史，不复制到新上下文", time: new Date().toISOString() }],
  draft: { input: "合成待发送草稿", revision: 1, attachments: [{ name: "note.txt", path: ".codex-cloud/uploads/note.txt", mimeType: "text/plain", kind: "file", size: 21 }] } };
const workHistory = { id: "work-history", repoId: "sample-app", title: "合成工作历史", codexSessionId: "work-thread", messages: [], draft: { input: "", attachments: [], revision: 1 } };
const workText = { id: "work-text", repoId: "sample-app", title: "新会话", messages: [], draft: { input: "合成工作文字草稿", attachments: [], revision: 1 } };
const workFile = { id: "work-file", repoId: "sample-app", title: "新会话", messages: [], draft: { input: "", attachments: source.draft.attachments, revision: 1 } };
await fs.writeFile(path.join(state, "chat-history.json"), JSON.stringify({ version: 2, activeByRepo: { _personal: source.id, "sample-app": workHistory.id }, sessions: Object.fromEntries([source, workHistory, workText, workFile].map(session => [session.id, session])) }));
await fs.writeFile(path.join(state, "personal-facts.json"), JSON.stringify({ version: 1, facts: [{ id: "fixture-fact", label: "合成称呼", value: "本机验收示例", source: "user", revision: 1, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" }] }));
const factStore = createPersonalFactsStore(path.join(state, "personal-facts.json"));
const largeDirectory = process.argv.includes("--large-directory");
const directoryControl = path.join(root, "directory-count.json");
if (largeDirectory) await fs.writeFile(directoryControl, "2013");
const memoryOrigin = { sessionId: source.id, threadId: source.codexSessionId, turnId: "synthetic-turn", callId: "synthetic-call" };
if (process.argv.includes("--serve") && process.argv.includes("--memory")) {
  await factStore.propose({ label: "合成出行偏好", value: "合成资料：偏好火车", reason: "本轮合成对话明确提到" }, memoryOrigin);
}
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
  const threads=[{id:'legacy-facts-thread',cwd:${JSON.stringify(personal)},name:'合成验收旧会话',createdAt:1790000000,updatedAt:1790000000},{id:'work-thread',cwd:${JSON.stringify(path.join(root, "work"))},name:'合成工作历史',createdAt:1790000000,updatedAt:1790000000}];
  if(m.method==='thread/list') result={data:threads.filter(thread=>!m.params.cwd||m.params.cwd.includes(thread.cwd)),nextCursor:null};
  if(m.method==='thread/read') {const thread=threads.find(thread=>thread.id===m.params.threadId);result={thread:{...thread,turns:[{id:'fixture-turn',status:'completed',items:[{type:'userMessage',content:[{type:'text',text:thread?.id==='work-thread'?'合成工作历史':'合成旧历史，不复制到新上下文'}]}]}]}};}
  const catalogApp=n=>({id:'service-'+n,name:['Gmail','Google Calendar','Google Drive','GitHub'][n]||(n<13?'已连接服务 '+String(n).padStart(4,'0'):'合成目录 '+String(n).padStart(4,'0')),description:n===0?'合成服务说明，仅用于目录验收。'.repeat(15):'合成目录说明',installUrl:n===1998?'javascript:alert(1)':'https://chatgpt.com/apps/fixture/service-'+n,isAccessible:n<13,isEnabled:n<13});
  if(m.method==='app/list') { const count=${largeDirectory} ? Number(fs.readFileSync(${JSON.stringify(directoryControl)},'utf8')) : 0; const offset=Number(m.params.cursor||0),end=Math.min(count,offset+100);result={data:Array.from({length:Math.max(0,end-offset)},(_,i)=>catalogApp(offset+i)),nextCursor:end<count?String(end):null}; }
  if(m.method==='app/installed') result={apps:${largeDirectory} ? Array.from({length:13},(_,n)=>({id:'service-'+n,runtimeName:catalogApp(n).name,enabled:true,callable:true})) : []};
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
  for (const [repoId, threadId] of [["_personal", "work-thread"], ["sample-app", "legacy-facts-thread"]]) {
    const rejected = await (await fetch(base + "api/chat/sessions?" + new URLSearchParams({ repoId, sessionId: "app-" + threadId }))).json();
    assert.equal(rejected.ok, true); assert.equal(rejected.activeSessionId, null); assert.deepEqual(rejected.messages, []);
    assert.equal(rejected.sessions.some(session => session.codexSessionId === threadId), false);
  }
  for (const sessionId of [workHistory.id, "app-work-thread", "unknown-session"]) {
    const response = await fetch(base + "api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repoId: "_personal", sessionId, message: "合成跨空间拒绝验收" }) });
    assert.equal(response.status, 404); assert.equal((await response.json()).ok, false);
  }
  if (process.argv.includes("--serve")) {
    console.log(JSON.stringify({ url: `${base}#/project/_personal/thread/facts-source`, state: "isolated synthetic", stop: "SIGTERM this process", model: "refused", ...(largeDirectory ? { directoryControl, rpcCapture: capture } : {}) }));
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
      const height = width <= 390 ? 480 : 900;
      await page.setViewportSize({ width, height });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      try { await page.waitForFunction(() => document.querySelector(".composer-shell")?.getBoundingClientRect().bottom <= innerHeight + 1, undefined, { timeout: 3000 }); }
      catch (error) {
        const layout = await page.evaluate(() => ({ viewport: { width: innerWidth, height: innerHeight }, elements: [".workspace", ".workspace-header", ".session-content-grid", ".chat-panel", ".app-session-strip", ".personal-scope-notice", ".chat-window", ".composer-shell", ".personal-context-notice", ".composer", ".composer-footer"].map(selector => {
          const element = document.querySelector(selector); if (!element) return { selector, absent: true };
          const box = element.getBoundingClientRect(), style = getComputedStyle(element);
          return { selector, top: box.top, bottom: box.bottom, height: box.height, flex: style.flex, minHeight: style.minHeight, padding: style.padding, margin: style.margin };
        }) }));
        await fs.writeFile(path.join(out, `layout-${width}-${height}.json`), JSON.stringify(layout, null, 2)); throw error;
      }
      await page.screenshot({ path: path.join(out, `context-${width}.png`), fullPage: true });
      const before = page.url();
      await page.getByRole("button", { name: "开启新上下文", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "开启新上下文？", exact: true });
      await dialog.waitFor();
      const box = await dialog.boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= width + 1 && box.y >= 0 && box.y + box.height <= height + 1);
      assert.equal(await page.evaluate(() => document.activeElement?.textContent), "取消");
      await page.screenshot({ path: path.join(out, `confirmation-${width}.png`), fullPage: true });
      await dialog.getByRole("button", { name: "取消", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      assert.equal(page.url(), before);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    const beforeCancel = page.url();
    await page.getByRole("button", { name: "开启新上下文", exact: true }).click();
    await page.getByRole("dialog", { name: "开启新上下文？", exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("dialog", { name: "开启新上下文？", exact: true }).waitFor({ state: "hidden" });
    assert.equal(page.url(), beforeCancel);
    await page.getByRole("button", { name: "开启新上下文", exact: true }).click();
    await page.getByRole("dialog", { name: "开启新上下文？", exact: true }).getByRole("button", { name: "确认开启", exact: true }).click();
    await page.waitForURL(url => !url.hash.includes("facts-source") && !url.hash.includes("legacy-facts-thread"));
    assert.equal(await page.getByRole("textbox", { name: "向个人助理发送消息" }).inputValue(), source.draft.input);
    assert.equal(await page.getByText("note.txt", { exact: true }).count() > 0, true);
    const chat = JSON.parse(await fs.readFile(path.join(state, "chat-history.json"), "utf8"));
    const copied = chat.sessions[chat.activeByRepo._personal];
    assert.equal(copied.codexSessionId, null); assert.deepEqual(copied.messages, []);
    assert.equal(copied.model, "gpt-6-astra"); assert.equal(copied.reasoning, "ultra"); assert.equal(copied.sandbox, "workspace-write");
    assert.equal(chat.sessions[source.id].draft.input, source.draft.input);
    const newContextUrl = page.url();
    await page.locator(".sidebar").getByRole("button", { name: /^合成验收旧会话/ }).click();
    await page.waitForURL(url => url.hash.includes("legacy-facts-thread"));
    await page.getByText("合成旧历史，不复制到新上下文", { exact: true }).waitFor();
    await page.locator(".sidebar").getByRole("button", { name: /新对话.*草稿.*1 附件/ }).click();
    await page.waitForURL(newContextUrl);
    assert.equal(await page.getByRole("textbox", { name: "向个人助理发送消息" }).inputValue(), source.draft.input);
    await page.reload();
    await page.getByRole("textbox", { name: "向个人助理发送消息" }).waitFor();
    await page.waitForFunction(expected => document.querySelector('textarea[placeholder="向个人助理发送消息"]')?.value === expected, source.draft.input);
    assert.equal(await page.getByText("note.txt", { exact: true }).count() > 0, true);
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
    // Seed only synthetic suggestions; the UI still uses the actual versioned HTTP review endpoints.
    const proposed = await factStore.propose({ label: "合成出行偏好", value: "合成资料：偏好火车", reason: "本轮合成对话明确提到" }, memoryOrigin);
    await factStore.propose({ label: "合成待拒绝资料", value: "不应成为事实", reason: "待用户核对的合成建议" }, { ...memoryOrigin, callId: "reject" });
    await page.getByRole("button", { name: "刷新个人事实", exact: true }).click();
    await page.getByRole("button", { name: "核对 合成出行偏好", exact: true }).waitFor();
    const memoryOut = path.join(project, "docs/research/acceptance/p032-memory-20261024"); await fs.mkdir(memoryOut, { recursive: true });
    for (const width of [1280, 768, 390, 320]) {
      await page.setViewportSize({ width, height: width <= 390 ? 640 : 900 });
      await page.locator(".personal-memory-candidates").scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      await page.screenshot({ path: path.join(memoryOut, `pending-${width}.png`), fullPage: true });
    }
    assert.equal((await factStore.snapshot()).facts.length, 0, "pending suggestions must not enter task context");
    await page.getByRole("button", { name: "核对 合成出行偏好", exact: true }).click();
    await page.getByLabel("事实内容", { exact: true }).fill("用户核对后的合成出行偏好");
    await page.getByRole("button", { name: "接受并记住", exact: true }).click();
    await page.getByRole("button", { name: "核对 合成出行偏好", exact: true }).waitFor({ state: "hidden" });
    await page.getByText(/^助理建议，你已确认/).waitFor();
    assert.equal((await factStore.snapshot()).facts[0].value, "用户核对后的合成出行偏好");
    await page.getByRole("button", { name: "不记住 合成待拒绝资料", exact: true }).click();
    await page.getByRole("button", { name: "不记住 合成待拒绝资料", exact: true }).waitFor({ state: "hidden" });
    assert.equal((await factStore.snapshot()).facts.length, 1);
    const concurrent = await factStore.propose({ label: "合成并行核对", value: "原始候选", reason: "跨页面冲突检查" }, { ...memoryOrigin, callId: "concurrent" });
    await page.getByRole("button", { name: "刷新个人事实", exact: true }).click();
    await page.getByRole("button", { name: "核对 合成并行核对", exact: true }).click();
    await page.getByLabel("事实内容", { exact: true }).fill("冲突时应保留的输入");
    const rejected = await fetch(`${base}api/personal/memory-candidates/${concurrent.id}/review`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: 1, decision: "reject" }) });
    assert.equal(rejected.status, 200);
    await page.getByRole("button", { name: "接受并记住", exact: true }).click();
    await page.getByText("这条候选状态已变化。你的输入仍保留，尚未接受；请核对已处理记录后取消此次核对。", { exact: true }).waitFor();
    assert.equal(await page.getByLabel("事实内容", { exact: true }).inputValue(), "冲突时应保留的输入");
    assert.equal(await page.getByRole("button", { name: "接受并记住", exact: true }).isDisabled(), true);
    await page.getByRole("button", { name: "取消核对", exact: true }).click();
    await page.getByText("已处理记录", { exact: true }).click();
    const beforeCleanup = await fs.readFile(path.join(state, "personal-facts.json"), "utf8");
    await page.getByRole("button", { name: "清理候选 合成出行偏好", exact: true }).click();
    const cleanup = page.getByRole("dialog", { name: "清理记忆候选记录", exact: true });
    await cleanup.waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), "取消");
    await cleanup.getByRole("button", { name: "取消", exact: true }).click();
    assert.equal(await fs.readFile(path.join(state, "personal-facts.json"), "utf8"), beforeCleanup);
    await page.getByRole("button", { name: "清理候选 合成出行偏好", exact: true }).click();
    await cleanup.getByRole("button", { name: "确认清理", exact: true }).click();
    await page.getByRole("button", { name: "清理候选 合成出行偏好", exact: true }).waitFor({ state: "hidden" });
    assert.equal((await factStore.overview()).candidates.some(item => item.id === proposed.id), false);
    assert.equal((await factStore.snapshot()).facts[0].value, "用户核对后的合成出行偏好");
    await page.reload();
    await page.getByText("用户核对后的合成出行偏好", { exact: true }).waitFor();
    await page.locator(".personal-facts").screenshot({ path: path.join(memoryOut, "accepted-after-reload.png") });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole("button", { name: "工作", exact: true }).click();
    await page.getByRole("textbox", { name: "向云端 Codex 发送消息" }).waitFor();
    await page.locator(".sidebar").getByRole("button", { name: /^合成工作历史/ }).waitFor();
    await page.locator(".sidebar button.session-state-draft").nth(1).waitFor();
    assert.equal(await page.locator(".sidebar").getByRole("button", { name: /^合成验收旧会话/ }).count(), 0);
    assert.equal(await page.locator(".sidebar button.session-state-draft").count(), 2);
    await page.locator(".sidebar").getByRole("button", { name: /新对话.*草稿.*1 附件/ }).click();
    await page.waitForURL(url => url.hash.includes("work-file"));
    assert.equal(await page.getByRole("textbox", { name: "向云端 Codex 发送消息" }).inputValue(), "");
    assert.equal(await page.getByText("note.txt", { exact: true }).count() > 0, true);
    await page.locator(".sidebar button.session-state-draft").click();
    await page.waitForURL(url => url.hash.includes("work-text"));
    assert.equal(await page.getByRole("textbox", { name: "向云端 Codex 发送消息" }).inputValue(), workText.draft.input);
    const rpc = (await fs.readFile(capture, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(rpc.some(message => ["turn/start", "turn/steer", "thread/compact/start", "thread/fork", "mcpServer/tool/call"].includes(message.method)), false);
    assert.equal(rpc.some(message => message.method === "thread/resume"), false, "拒绝跨空间导入不能先恢复或改写原线程");
    assert.deepEqual(errors, []);
    console.log("PASS actual isolated backend/UI: context and drafts, four widths/short screens, memory candidate edit/accept/reject/reload, stale review preserves input, cleanup confirmation keeps accepted fact; zero model or connector writes (candidates synthetically seeded)");
  }
} finally { await stop(); }
