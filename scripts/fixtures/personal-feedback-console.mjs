import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { waitForConsoleReady } from "./console-ready.mjs";

export async function personalFeedbackConsole() {
  const project = fileURLToPath(new URL("../../", import.meta.url));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-feedback-console-"));
  const state = path.join(root, "state"), personal = path.join(root, "personal"), work = path.join(root, "work"), bin = path.join(root, "bin");
  for (const dir of [state, personal, work, bin]) await fs.mkdir(dir, { mode: 0o700 });
  const control = path.join(root, "control.json"), rpcCapture = path.join(root, "rpc.jsonl");
  await fs.writeFile(control, JSON.stringify({ a: { text: "合成建议 A：先核对日期，没有预订或付款。", status: "completed", phase: "final_answer" }, b: { text: "合成建议 B：先比较路线，没有发送邮件。", status: "completed", phase: "final_answer" } }));
  const sessions = ["a", "b"].map(name => ({ id: `personal-${name}`, repoId: "_personal", title: `合成个人对话 ${name.toUpperCase()}`, codexSessionId: `feedback-thread-${name}`,
    model: name === "a" ? "gpt-6-astra" : "gpt-6-sol", reasoning: name === "a" ? "ultra" : "medium", sandbox: "read-only", approval: "on-request", messages: [],
    draft: { input: `合成未发送草稿 ${name.toUpperCase()}`, revision: 1, attachments: [] } }));
  sessions.push({ id: "work-history", repoId: "work", title: "合成工作对话", codexSessionId: "work-thread", model: "gpt-6-sol", reasoning: "medium", messages: [], draft: { input: "合成工作草稿", revision: 1, attachments: [] } });
  await fs.writeFile(path.join(state, "chat-history.json"), JSON.stringify({ version: 2, sessions: Object.fromEntries(sessions.map(session => [session.id, session])), activeByRepo: { _personal: "personal-a", work: "work-history" } }));
  await fs.writeFile(path.join(bin, "codex"), `#!/usr/bin/env node
import fs from 'node:fs';import readline from 'node:readline';
if(process.argv.includes('--version')){console.log('codex-cli 0.157.1');process.exit(0)}
if(process.argv.includes('login')){console.error('Logged in using ChatGPT');process.exit(0)}
const stamp=Math.floor(Date.now()/1000)-3600;
const threads=['a','b'].map(name=>({id:'feedback-thread-'+name,cwd:${JSON.stringify(personal)},name:'合成个人对话 '+name.toUpperCase(),createdAt:stamp,updatedAt:stamp}));
threads.push({id:'work-thread',cwd:${JSON.stringify(work)},name:'合成工作对话',createdAt:stamp,updatedAt:stamp});
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);fs.appendFileSync(${JSON.stringify(rpcCapture)},JSON.stringify(m)+'\\n');if(m.id==null)return;
let result={};
if(m.method==='account/read')result={account:{type:'chatgpt',email:'synthetic@example.test',planType:'plus'},requiresOpenaiAuth:false};
if(m.method==='model/list')result={data:[{id:'gpt-6-sol',model:'gpt-6-sol',displayName:'GPT-6 Sol',defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium'}]},{id:'gpt-6-astra',model:'gpt-6-astra',displayName:'GPT-6 Astra',defaultReasoningEffort:'ultra',supportedReasoningEfforts:[{reasoningEffort:'ultra'}]}],nextCursor:null};
if(m.method==='thread/list')result={data:threads.filter(t=>!m.params.cwd||m.params.cwd.includes(t.cwd)),nextCursor:null};
if(m.method==='thread/read'){const thread=threads.find(t=>t.id===m.params.threadId),name=thread?.id.endsWith('-b')?'b':'a',value=JSON.parse(fs.readFileSync(${JSON.stringify(control)},'utf8'))[name];if(value.unavailable)return process.stdout.write(JSON.stringify({id:m.id,error:{code:-32000,message:'Synthetic source unavailable'}})+'\\n');result={thread:{...thread,turns:[...(value.history||[]),{id:'same-turn',status:value.status,items:[{id:'question',type:'userMessage',content:[{type:'text',text:'合成：帮我规划下一步'}]},{id:'commentary',type:'agentMessage',phase:'commentary',text:'合成过程记录，不是最终答复。'},{id:'same-message',type:'agentMessage',phase:value.phase,text:value.text}]}]}}}
if(m.method==='thread/goal/get')result={goal:null};
if(m.method==='config/read')result={config:{model:'gpt-6-sol',model_reasoning_effort:'medium'}};
if(['app/list','mcpServerStatus/list','skills/list','experimentalFeature/list','permissionProfile/list'].includes(m.method))result={data:[],nextCursor:null};
if(m.method==='app/installed')result={apps:[]};
if(['turn/start','turn/steer','thread/start','thread/fork','thread/compact/start','mcpServer/tool/call','command/exec'].includes(m.method))return process.stdout.write(JSON.stringify({id:m.id,error:{code:-32000,message:'Feedback fixture refuses inference and tools'}})+'\\n');
process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');});
`, { mode: 0o755 });
  const port = await new Promise((resolve, reject) => {
    const listener = net.createServer(); listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => { const { port } = listener.address(); listener.close(() => resolve(port)); });
  });
  let server, logs = "";
  const stopServer = async () => {
    if (!server || server.exitCode !== null || server.signalCode) return;
    const closed = new Promise(resolve => server.once("close", resolve));
    server.kill("SIGTERM"); await closed;
  };
  const start = async () => {
    logs = "";
    server = spawn(process.execPath, [path.join(project, "server/index.mjs")], { cwd: project, stdio: ["ignore", "pipe", "pipe"], env: {
      PATH: `${bin}:${process.env.PATH}`, HOME: root, NODE_ENV: "production", HOST: "127.0.0.1", PORT: String(port),
      CODEX_CLOUD_ROOT: root, CODEX_STATE_ROOT: state, CODEX_HOME: path.join(root, "codex-home"), CODEX_PERSONAL_MODE: "shared", CODEX_PERSONAL_ROOT: personal,
      CODEX_CLOUD_REPOS_CONFIG_B64: Buffer.from(JSON.stringify([{ id: "work", name: "合成工作项目", path: work }])).toString("base64"),
    } });
    server.stdout.on("data", chunk => { logs += chunk; }); server.stderr.on("data", chunk => { logs += chunk; });
    await waitForConsoleReady({ child: server, baseUrl: `http://127.0.0.1:${port}`, logs: () => logs });
  };
  try { await start(); } catch (error) { await stopServer(); await fs.rm(root, { recursive: true, force: true }); throw error; }
  const base = `http://127.0.0.1:${port}`;
  const request = async (url, method = "GET", body, headers = {}) => {
    const response = await fetch(base + url, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  return { project, root, state, control, rpcCapture, base, request, restart: async () => { await stopServer(); await start(); },
    stop: async () => { await stopServer(); await fs.rm(root, { recursive: true, force: true }); } };
}
