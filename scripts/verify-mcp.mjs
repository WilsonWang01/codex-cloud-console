import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createCloudMcpServer } from "./codex-cloud-mcp.mjs";

const script = fileURLToPath(new URL("./codex-cloud-mcp.mjs", import.meta.url));
const token = "synthetic-scoped-mcp-token-not-a-real-secret";
const baseEnv = { CODEX_CLOUD_API_TOKEN: token, CODEX_CLOUD_AUTOMATION_ID: "research" };
const reply = (status = "running") => ({ ok: true, run: { id: "run-1", automationId: "research", status, summary: "test", usage: { totalTokens: 0 } } });
const data = (result) => result.structuredContent || JSON.parse(result.content.find(item => item.type === "text").text);
const call = (client, name, args = {}, options) => client.callTool({ name: `codex_cloud_${name}`, arguments: args }, options);
async function apiFixture(t, handler) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    calls.push({ method: req.method, url: req.url, key: req.headers["idempotency-key"], body: Buffer.concat(chunks).toString() });
    assert.equal(req.headers["x-codex-cloud-token"], token);
    res.setHeader("content-type", "application/json");
    await handler(req, res, calls.at(-1));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return { calls, origin: `http://127.0.0.1:${server.address().port}` };
}
async function connect(t, origin, execution = false, modern = false) {
  const client = new Client({ name: "independent-mcp-acceptance", version: "1.0.0" }, modern ? { versionNegotiation: { mode: "auto" } } : {});
  const transport = new StdioClientTransport({ command: process.execPath, args: [script], stderr: "pipe",
    env: { ...baseEnv, CODEX_CLOUD_URL: origin, ...(execution ? { CODEX_CLOUD_MCP_ALLOW_EXECUTION: "1" } : {}) } });
  let stderr = ""; transport.stderr.on("data", chunk => { stderr += chunk; });
  t.after(async () => { await client.close(); assert.doesNotMatch(stderr, new RegExp(token + "|PRIVATE_BODY|PRIVATE_ERROR")); });
  await client.connect(transport);
  return client;
}

test("MCP fails closed on missing credentials, unsafe origin and invalid execution configuration", async () => {
  for (const env of [ {}, { ...baseEnv, CODEX_CLOUD_URL: "http://public.example" }, { ...baseEnv, CODEX_CLOUD_URL: "https://user:pass@example.com" },
    { ...baseEnv, CODEX_CLOUD_URL: "https://example.com/?secret=PRIVATE_BODY" },
    { ...baseEnv, CODEX_CLOUD_URL: "https://example.com", CODEX_CLOUD_MCP_ALLOW_EXECUTION: "yes" } ]) assert.throws(() => createCloudMcpServer(env));
  const result = await new Promise(resolve => {
    const child = spawn(process.execPath, [script], { env: { CODEX_CLOUD_API_TOKEN: token }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = ""; child.stdout.on("data", c => { stdout += c; }); child.stderr.on("data", c => { stderr += c; });
    child.on("close", code => resolve({ code, stdout, stderr }));
  });
  assert.equal(result.code, 1); assert.equal(result.stdout, ""); assert.doesNotMatch(result.stderr, new RegExp(token)); assert.match(result.stderr, /不会回退/);
});

test("real MCP stdio host lists read-only tools, rejects extra authority and supports discovery", async t => {
  const { origin, calls } = await apiFixture(t, (req, res) => res.end(JSON.stringify(req.url.endsWith("/models")
    ? { object: "list", data: [{ id: "gpt-6-sol" }] } : { object: "codex_cloud.capabilities", automation_id: "research", defaults: { model: "gpt-6-sol" } })));
  for (const modern of [false, true]) {
    const client = await connect(t, origin, false, modern);
    assert.equal(client.getProtocolEra(), modern ? "modern" : "legacy");
    const tools = (await client.listTools()).tools;
    assert.equal(tools.length, 5); assert(tools.every(tool => tool.annotations.readOnlyHint));
    assert(!tools.some(tool => /submit|cancel/.test(tool.name)));
    assert(!JSON.stringify(tools).includes(token));
    assert.equal(data(await call(client, "capabilities")).capabilities.automation_id, "research");
    assert.equal(data(await call(client, "models")).models.data[0].id, "gpt-6-sol");
    const before = calls.length;
    const refused = await call(client, "status", { runId: "run-1", origin: "https://foreign.invalid", token: "PRIVATE_BODY" });
    assert.equal(refused.isError, true); assert.equal(calls.length, before);
    await assert.rejects(call(client, "submit", { eventId: "event-test-001" }));
    assert.equal(calls.length, before, "hidden execution tools cannot perform any HTTP writes");
    await client.close();
  }
  assert(calls.every(item => item.method === "GET" && item.url.startsWith("/api/automations/research/v1/")));
});

test("MCP submits, recovers a lost response and process restart with the same event, and explicitly cancels", async t => {
  let accepted = 0, lost = false, status = "running";
  const seen = new Map();
  const { origin, calls } = await apiFixture(t, (req, res, request) => {
    if (req.url.endsWith("/webhook")) {
      if (!seen.has(request.key)) { seen.set(request.key, request.body); accepted++; }
      else assert.equal(seen.get(request.key), request.body);
      if (!lost) { lost = true; return req.socket.destroy(); }
    }
    if (req.url.endsWith("/cancel")) status = "canceling";
    res.end(JSON.stringify(reply(status)));
  });
  let client = await connect(t, origin, true);
  assert.equal((await client.listTools()).tools.length, 7);
  const input = { prompt: "PRIVATE_BODY", artifactPaths: ["results/report.md"], outputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
    attachments: [{ name: "notes.md", mimeType: "text/markdown", dataBase64: Buffer.from("material").toString("base64") }] };
  const first = data(await call(client, "submit", { eventId: "mcp-event-test-001", input }));
  assert.equal(first.run.id, "run-1"); assert.equal(first.eventId, "mcp-event-test-001"); assert.equal(accepted, 1);
  assert.equal(calls.filter(item => item.url.endsWith("/webhook")).length, 2);
  await client.close();
  client = await connect(t, origin, true);
  assert.equal(data(await call(client, "submit", { eventId: "mcp-event-test-001", input })).run.id, "run-1");
  assert.equal(accepted, 1);
  const count = calls.length;
  for (const bad of [{ sandbox: "danger-full-access" }, { artifactPaths: ["../secret.txt"] }, { sessionId: "thread-1" }, { model: "bad/model" }]) {
    const result = await call(client, "submit", { eventId: "mcp-invalid-001", input: bad }); assert.equal(result.isError, true);
  }
  assert.equal(calls.length, count, "bad input cannot reach execution");
  assert.equal(data(await call(client, "status", { runId: "run-1" })).run.status, "running");
  assert.equal(data(await call(client, "cancel", { runId: "run-1" })).run.status, "canceling");
  status = "canceled";
  assert.equal(data(await call(client, "status", { runId: "run-1" })).run.status, "canceled");
  assert.equal(calls.filter(item => item.url.endsWith("/cancel")).length, 1);
});

test("MCP paginates complete text/JSON and returns verified private bytes and real image blocks", async t => {
  const fileId = "00000000-0000-4000-8000-000000000001";
  const buffer = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const text = "中文😀结果".repeat(100);
  const structured = { status: "validated", data: { text } };
  const manifest = { version: 1, runId: "run-1", automationId: "research", status: "completed", text, structuredOutput: structured,
    turnId: "original-turn", sources: [{ url: "https://example.com/source", title: "来源" }],
    artifacts: [{ id: fileId, name: "generated.png", mimeType: "image/png", size: buffer.length, sha256, downloadPath: "https://foreign.invalid/PRIVATE_BODY" }] };
  let corrupt = false;
  const { origin, calls } = await apiFixture(t, (req, res) => {
    if (req.url.endsWith("/output")) return res.end(JSON.stringify({ ok: true, result: manifest }));
    res.setHeader("X-Content-SHA256", sha256); res.end(corrupt ? Buffer.from("bad") : buffer);
  });
  const client = await connect(t, origin);
  for (const section of ["text", "structured", "metadata"]) {
    let offset = 0, joined = "";
    while (true) {
      const page = data(await call(client, "output", { runId: "run-1", section, offset, limit: 37 }));
      assert.equal(page.ok, true); joined += page.content;
      assert.equal(page.artifacts[0].downloadPath, undefined);
      if (page.done) { assert.equal(page.nextOffset, null); break; }
      assert(page.nextOffset > offset); offset = page.nextOffset;
    }
    if (section === "metadata") { assert.equal(JSON.parse(joined).turnId, "original-turn"); assert.deepEqual(JSON.parse(joined).sources, manifest.sources); }
    else assert.equal(joined, section === "text" ? text : JSON.stringify(structured));
  }
  let offset = 0, chunks = [];
  while (true) {
    const page = data(await call(client, "read_artifact", { runId: "run-1", fileId, offset, limit: 17 }));
    chunks.push(Buffer.from(page.dataBase64, "base64"));
    if (page.done) break; offset = page.nextOffset;
  }
  assert.deepEqual(Buffer.concat(chunks), buffer);
  const image = await call(client, "read_artifact", { runId: "run-1", fileId, asImage: true });
  assert.deepEqual(image.content.find(item => item.type === "image"), { type: "image", mimeType: "image/png", data: buffer.toString("base64") });
  assert.equal((await call(client, "output", { runId: "run-1", offset: text.length + 1 })).isError, true);
  assert.equal((await call(client, "read_artifact", { runId: "run-1", fileId, offset: buffer.length + 1 })).isError, true);
  assert.equal((await call(client, "read_artifact", { runId: "run-1", fileId, asImage: true, offset: 1 })).isError, true);
  corrupt = true;
  assert.equal((await call(client, "read_artifact", { runId: "run-1", fileId })).isError, true);
  assert(calls.every(item => item.method === "GET" && item.url.startsWith("/api/automations/research/runs/run-1/output")));
});

test("MCP contains upstream failures and redirect credentials; aborting local wait never cancels a run", async t => {
  let mode = "redirect";
  const { origin, calls } = await apiFixture(t, (_req, res) => {
    if (mode === "redirect") { res.writeHead(307, { location: "http://127.0.0.1:1/PRIVATE_BODY" }); return res.end(); }
    if (mode === "revoked") { res.statusCode = 403; return res.end(JSON.stringify({ error: token + " PRIVATE_ERROR" })); }
    if (mode === "hang") return;
    res.end(JSON.stringify(reply()));
  });
  const client = await connect(t, origin, true);
  const redirect = await call(client, "status", { runId: "run-1" });
  assert.equal(redirect.isError, true); assert.equal(data(redirect).code, "INVALID_RESPONSE"); assert.equal(calls.length, 1);
  mode = "revoked";
  const revoked = await call(client, "status", { runId: "run-1" });
  assert.equal(revoked.isError, true); assert.equal(data(revoked).httpStatus, 403); assert(!JSON.stringify(revoked).includes(token));
  mode = "hang";
  const controller = new AbortController();
  const waiting = call(client, "status", { runId: "run-1" }, { signal: controller.signal });
  for (let i = 0; i < 100 && calls.length < 3; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(calls.length, 3); controller.abort();
  await assert.rejects(waiting);
  mode = "ready";
  assert.equal(data(await call(client, "status", { runId: "run-1" })).run.status, "running");
  assert.equal(calls.filter(item => item.url.endsWith("/cancel")).length, 0);
});

test("MCP bounds concurrent work and frees abandoned waits without starting or canceling remote tasks", async t => {
  let ready = false;
  const waiting = [];
  const { origin, calls } = await apiFixture(t, (_req, res) => {
    if (ready) return res.end(JSON.stringify(reply()));
    waiting.push(res);
  });
  const client = await connect(t, origin, true);
  const firstAbort = new AbortController(), secondAbort = new AbortController();
  const first = call(client, "status", { runId: "run-1" }, { signal: firstAbort.signal });
  const second = call(client, "status", { runId: "run-1" }, { signal: secondAbort.signal });
  for (let i = 0; i < 100 && waiting.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(waiting.length, 2);
  const busy = await call(client, "submit", { eventId: "must-not-start-001", input: {} });
  assert.equal(busy.isError, true); assert.equal(data(busy).code, "busy"); assert.equal(calls.length, 2);
  const rejectedFirst = assert.rejects(first), rejectedSecond = assert.rejects(second);
  firstAbort.abort(); secondAbort.abort(); await rejectedFirst; await rejectedSecond;
  ready = true;
  for (const res of waiting) res.end(JSON.stringify(reply()));
  let response;
  for (let i = 0; i < 100; i++) {
    response = await call(client, "status", { runId: "run-1" });
    if (data(response).ok) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(data(response).run.status, "running");
  assert(calls.every(item => item.method === "GET"));
});
