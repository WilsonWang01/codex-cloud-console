#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn as spawnChild } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { CodexAppServerClient } from "../server/codex-app-server-client.mjs";
import { runExternalClient } from "./external-client-example.mjs";
import { modelApiJsonLimit } from "../server/model-api.mjs";
import { openRunUsageLedger } from "../server/run-usage-ledger.mjs";
import { createExternalTaskStore } from "../server/external-task-store.mjs";
import { pdfAttachment } from "./fixtures/inline-pdf.mjs";
import { Client as McpClient } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { verifyNativeMcpReadback } from "./verify-mcp-codex.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const results = [];
const selectedCheck = process.env.CODEX_CLOUD_REGRESSION_CASE;
const fixtureClosures = new WeakMap();
const isolatedProcessGroups = process.platform === "linux";

function spawn(command, args, options) {
  const child = spawnChild(command, args, { ...options, detached: isolatedProcessGroups });
  fixtureClosures.set(child, new Promise((resolve) => child.once("close", resolve)));
  return child;
}

async function check(name, task) {
  if (selectedCheck && name !== selectedCheck) return;
  const startedAt = Date.now();
  await task();
  results.push({ name, ok: true, ms: Date.now() - startedAt });
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function waitForOutput(child, pattern, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${pattern}: ${output.slice(-1000)}`)), timeoutMs);
    const onData = (chunk) => {
      output += chunk.toString();
      if (!pattern.test(output)) return;
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      resolve(output);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Process exited ${code} before ${pattern}: ${output.slice(-1000)}`));
    });
  });
}

async function stopProcess(child) {
  if (!child || !fixtureClosures.has(child)) return;
  const signal = (name) => {
    try {
      if (isolatedProcessGroups) process.kill(-child.pid, name);
      else child.kill(name);
    } catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  const closed = fixtureClosures.get(child);
  let timer;
  signal("SIGTERM");
  try { await Promise.race([closed, new Promise((resolve) => { timer = setTimeout(resolve, 2_000); })]); }
  finally { clearTimeout(timer); }
  // A server exit does not mean its simulated Codex children have stopped writing.
  signal("SIGKILL");
  await closed;
  fixtureClosures.delete(child);
}

async function runCaptured(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

async function initializeGitFixture(repoRoot) {
  await fs.writeFile(path.join(repoRoot, "README.md"), "fixture repository\n");
  for (const args of [
    ["-C", repoRoot, "init", "-q"],
    ["-C", repoRoot, "add", "README.md"],
    ["-C", repoRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "Initial fixture"],
  ]) {
    const result = await runCaptured("git", args);
    assert.equal(result.code, 0, result.stderr);
  }
}

async function jsonRequest(baseUrl, pathname, options = {}) {
  const response = await fetch(new URL(pathname, baseUrl), options);
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${pathname} returned non-JSON HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  return { response, data };
}

async function writeFakeCodex(tempRoot) {
  const fakePath = path.join(tempRoot, "fake-codex.mjs");
  await fs.writeFile(
    fakePath,
    `#!/usr/bin/env node
import fsSync from "node:fs";
import readline from "node:readline";
if (process.env.FAKE_CAPTURE_CALLBACK_ENV_PATH) fsSync.writeFileSync(process.env.FAKE_CAPTURE_CALLBACK_ENV_PATH, JSON.stringify(Object.keys(process.env).filter(key => key.startsWith("CODEX_CLOUD_CALLBACK_SECRET_"))));
const initDelay = Number(process.env.FAKE_INIT_DELAY_MS || 0);
const termDelay = Number(process.env.FAKE_TERM_DELAY_MS || 0);
const queuedNextDelay = Number(process.env.FAKE_QUEUE_NEXT_DELAY_MS || 80);
if (!Number.isSafeInteger(queuedNextDelay) || queuedNextDelay < 0 || queuedNextDelay > 3000) throw new Error("Invalid fixture queue delay");
const sharedPersonal = process.env.FAKE_SHARED_PERSONAL === "1";
const threads = [];
let modelApiText = null;
let modelApiImages = [];
let modelApiTurnId = null;
let modelApiStructured = false;
let turnSequence = 0;
let mailSourceSequence = 0;
const mailReceivedAt = Date.now() - 7200000;
const fixtureTurns = new Map();
const fixtureCwds = new Map();
const cancelGates = new Map();
const acceptedApprovals = new Set();
if (sharedPersonal) process.stderr.write("token_invalidated: Please log out and sign in again\\n");
process.on("SIGTERM", () => setTimeout(() => process.exit(0), termDelay));
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (process.env.FAKE_CAPTURE_PATH) fsSync.appendFileSync(process.env.FAKE_CAPTURE_PATH, JSON.stringify(message) + "\\n");
  if (!message.id) return;
  if (!message.method) { if (message.result?.decision === "accept") acceptedApprovals.add(message.id); return; }
  const send = (payload, delay = 0) => setTimeout(() => {
    if (payload.method === "item/agentMessage/delta") {
      const turn = fixtureTurns.get(payload.params.threadId)?.find(turn => turn.id === payload.params.turnId);
      if (turn && !turn.nativeKnown) {
        let message = turn.items.find(item => item.type === "agentMessage");
        if (!message) { message = { type: "agentMessage", phase: "final_answer", text: "" }; turn.items.push(message); }
        message.text += payload.params.delta;
      }
    }
    process.stdout.write(JSON.stringify(payload) + "\\n");
  }, delay);
  if (message.method === "initialize") return send({ id: message.id, result: { ready: true } }, initDelay);
  if (process.env.FAKE_EXECUTION_PROFILE === "1") {
    if (message.method === "config/read") return send({ id: message.id, result: { config: { mcp_servers: { fixture: { command: "fixture", tool_timeout_sec: "" } } } } });
    if (["thread/start", "thread/resume"].includes(message.method) && message.params.config?.mcp_servers?.fixture?.enabled === false) {
      const id = message.params.threadId || "thread-profile-" + threads.length;
      const thread = { id, cwd: message.params.cwd }; threads.push(thread); fixtureCwds.set(id, message.params.cwd);
      return send({ id: message.id, result: { thread, cwd: message.params.cwd, approvalPolicy: message.params.approvalPolicy,
        sandbox: { type: "workspaceWrite", writableRoots: [message.params.cwd], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true } } });
    }
    if (message.method === "mcpServerStatus/list" && message.params.threadId?.startsWith("thread-profile-")) {
      return send({ id: message.id, result: { data: [{ name: "fixture", runtimeStatus: fsSync.existsSync(process.env.FAKE_CAPTURE_PATH + ".unsafe-mcp") ? "connected" : "disabled", tools: {} }], nextCursor: null } });
    }
  }
  if (message.method === "thread/start" && message.params.ephemeral === true) return send({ id: message.id, result: { thread: { id: message.params.serviceName?.includes("mail") ? "mail-ephemeral-" + (++mailSourceSequence) : "calendar-ephemeral", ephemeral: true } } });
  if (message.method === "mcpServerStatus/list" && String(message.params.threadId || "").startsWith("mail-ephemeral-")) return send({ id: message.id, result: { data: [{ name: "codex_apps", httpOrigin: "https://chatgpt.com", tools: Object.fromEntries(["gmail.search_email_ids", "gmail.read_email"].map(name => [name, {
    name, annotations: { readOnlyHint: true, destructiveHint: false }, inputSchema: { type: "object" },
    _meta: { connector_id: "mail", link_id: "mail-one", link_accounts: [{ link_id: "mail-one", profile_email: "one@example.test", link_name: "个人" }, { link_id: "mail-two", profile_email: "two@example.test", link_name: "另一个" }].filter(item => item.link_id !== "mail-two" || !fsSync.existsSync(process.env.FAKE_CAPTURE_PATH + ".mail-account-revoked")) }
  }])) }], nextCursor: null } });
  if (message.method === "mcpServer/tool/call" && String(message.params.threadId || "").startsWith("mail-ephemeral-")) {
    if (message.params.tool === "gmail.search_email_ids") {
      send({ id: "mail-unexpected-approval", method: "item/commandExecution/requestApproval", params: { threadId: message.params.threadId, command: "must-not-run" } });
      const reply = () => fsSync.existsSync(process.env.FAKE_CAPTURE_PATH + ".mail-release")
        ? send({ id: message.id, result: { structuredContent: { message_ids: ["metadata-mail-id"], next_page_token: null } } }) : setTimeout(reply, 10);
      return reply();
    }
    return send({ id: message.id, result: { structuredContent: { id: "metadata-mail-id", threadId: "metadata-thread-id", internalDate: String(mailReceivedAt), labelIds: ["INBOX", "UNREAD"],
      payload: { headers: [{ name: "Subject", value: "HTTP 元信息验收" }, { name: "From", value: "sender@example.test" }], mime_type: "text/plain", body: message.params.arguments.format === "full" ? { content: "虚构正文：请于 2026-11-01 18:00（上海）前核对材料。" } : { data: "must-not-persist-private-body" } } } } });
  }
  if (message.method === "mcpServerStatus/list" && message.params.threadId === "calendar-ephemeral") return send({ id: message.id, result: { data: [{ name: "codex_apps", httpOrigin: "https://chatgpt.com", tools: { "google_calendar.search": {
    name: "google_calendar.search", annotations: { readOnlyHint: true, destructiveHint: false }, inputSchema: { type: "object" },
    _meta: { connector_id: "calendar", link_id: "synthetic-calendar-account", link_owner_profile: { email: "calendar@example.test" } }
  } } }], nextCursor: null } });
  if (message.method === "mcpServer/tool/call" && message.params.threadId === "calendar-ephemeral") {
    send({ id: "calendar-unexpected-approval", method: "item/commandExecution/requestApproval", params: { threadId: "calendar-ephemeral", command: "must-not-run" } });
    const reply = () => fsSync.existsSync(process.env.FAKE_CAPTURE_PATH + ".calendar-release")
      ? send({ id: message.id, result: { structuredContent: { events: [], next_page_token: null } } }) : setTimeout(reply, 10);
    return reply();
  }
  if (message.method === "thread/unsubscribe" && (message.params.threadId === "calendar-ephemeral" || String(message.params.threadId || "").startsWith("mail-ephemeral-"))) {
    send({ id: message.id, result: { status: "unsubscribed" } });
    return send({ method: "thread/closed", params: { threadId: message.params.threadId } });
  }
  if (message.method === "app/list") return send({ id: message.id, result: { data: [{ id: "mail", name: "Mail", isAccessible: true, isEnabled: true, installUrl: "https://chatgpt.com/apps/mail/mail" }], nextCursor: null } });
  if (message.method === "app/installed") return send({ id: message.id, result: { apps: [{ id: "mail", enabled: true, callable: true }, { id: "calendar", enabled: true, callable: true }] } });
  if (sharedPersonal && message.method === "account/read") return send({ id: message.id, result: { account: { type: "chatgpt", email: "fixture@example.test", planType: "plus" } } });
  if (sharedPersonal && message.method === "thread/list") return send({ id: message.id, result: { data: threads.filter((thread) => message.params.cwd.includes(thread.cwd)), nextCursor: null } });
  if (sharedPersonal && message.method === "thread/start") {
    const thread = { id: "shared-thread-" + threads.length, cwd: message.params.cwd, preview: "fixture", createdAt: 1, updatedAt: 1 };
    threads.push(thread);
    return send({ id: message.id, result: { thread } });
  }
  if (message.method === "model/list" && message.params?.cursor === "new-models") return send({ id: message.id, result: { data: [
    { id: "gpt-6-astra", model: "gpt-6-astra", displayName: "GPT-6 Astra", defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "ultra" }] },
    { id: "gpt-6-sol", model: "gpt-6-sol", displayName: "GPT-6 Sol", defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "ultra" }] },
  ], nextCursor: null } });
  if (message.method === "model/list") return send({
    id: message.id,
    result: {
      nextCursor: "new-models",
      data: [
        {
          id: "gpt-5.6-sol",
          model: "gpt-5.6-sol",
          displayName: "GPT-5.6-Sol",
          isDefault: true,
          defaultReasoningEffort: "low",
          supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"].map((reasoningEffort) => ({ reasoningEffort })),
          inputModalities: ["text", "image"],
        },
        {
          id: "gpt-5.6-terra",
          model: "gpt-5.6-terra",
          displayName: "GPT-5.6-Terra",
          isDefault: false,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"].map((reasoningEffort) => ({ reasoningEffort })),
          inputModalities: ["text", "image"],
        },
        {
          id: "gpt-5.5",
          model: "gpt-5.5",
          displayName: "GPT-5.5",
          isDefault: false,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: ["low", "medium", "high", "xhigh"].map((reasoningEffort) => ({ reasoningEffort })),
          inputModalities: ["text", "image"],
        },
      ],
    },
  });
  if (message.method === "fs/readDirectory") {
    const entries = fsSync.readdirSync(message.params.path, { withFileTypes: true }).map((entry) => ({
      fileName: entry.name,
      isDirectory: entry.isDirectory(),
    }));
    return send({ id: message.id, result: { entries } });
  }
  if (message.method === "fs/getMetadata") {
    const stat = fsSync.statSync(message.params.path);
    return send({
      id: message.id,
      result: { isFile: stat.isFile(), size: stat.size, modifiedAtMs: stat.mtimeMs },
    });
  }
  if (message.method === "fs/readFile") {
    return send({ id: message.id, result: { dataBase64: fsSync.readFileSync(message.params.path).toString("base64") } });
  }
  if (message.method === "fs/writeFile") {
    fsSync.writeFileSync(message.params.path, Buffer.from(message.params.dataBase64, "base64"));
    return send({ id: message.id, result: {} });
  }
  if (message.method === "fuzzyFileSearch") {
    const root = message.params?.roots?.[0] || process.cwd();
    return send({
      id: message.id,
      result: {
        files: [
          { root, path: "outside-link/secret.txt", file_name: "secret.txt", match_type: "file", score: 100 },
          { root, path: ".codex-cloud", file_name: ".codex-cloud", match_type: "directory", score: 50 },
        ],
      },
    });
  }
  if (message.method === "thread/read" && String(message.params?.threadId || "").startsWith("thread-external-archive-")) {
    send({ id: message.id, result: { thread: { id: message.params.threadId, turns: [] } } });
    return send({ method: "thread/archived", params: { threadId: message.params.threadId } }, 20);
  }
  if (message.method === "thread/read" && message.params?.includeTurns && fixtureTurns.has(message.params.threadId)) {
    return send({ id: message.id, result: { thread: { id: message.params.threadId, turns: fixtureTurns.get(message.params.threadId) } } });
  }
  if (message.method === "thread/archive" && message.params?.threadId === "thread-archive-race") {
    return send({ id: message.id, result: {} }, 250);
  }
  if (message.method === "thread/list") {
    const cwd = Array.isArray(message.params?.cwd) ? message.params.cwd.join(" ") : "";
    if (cwd.includes("sample-service")) return send({ id: message.id, result: { data: [], nextCursor: null } });
    return send({ id: message.id, error: { code: -32000, message: "injected thread/list failure" } });
  }
  if (message.method === "thread/start") {
    fixtureCwds.set("thread-regression", message.params.cwd);
    return send({ id: message.id, result: { thread: { id: "thread-regression" } } });
  }
  if (message.method === "thread/read" && message.params?.threadId === "thread-runtime-regression") {
    return send({ id: message.id, result: { thread: { id: message.params.threadId, model: "gpt-5.4-mini", reasoningEffort: "low",
      recencyAt: Date.parse("2026-09-01T00:00:00.000Z") / 1000, updatedAt: Date.now() / 1000, turns: [] } } });
  }
  if (message.method === "thread/read" && message.params?.threadId === "thread-runtime-delayed") {
    const reply = () => fsSync.existsSync(process.env.FAKE_CAPTURE_PATH + ".runtime-read-release")
      ? send({ id: message.id, result: { thread: { id: message.params.threadId, model: "gpt-5.4-mini", reasoningEffort: "low", turns: [] } } })
      : setTimeout(reply, 10);
    return reply();
  }
  if (message.method === "thread/resume") {
    if (process.env.FAKE_TURN_OWNERSHIP === "1" && fsSync.existsSync(process.env.FAKE_CAPTURE_PATH + ".preflight")) {
      const previous = fixtureTurns.get(message.params.threadId)?.at(-1)?.id;
      if (previous) {
        send({ method: "thread/tokenUsage/updated", params: { threadId: message.params.threadId, turnId: previous, tokenUsage: { last: { inputTokens: 999999, outputTokens: 1 } } } });
        send({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: previous, status: "completed" } } });
      }
    }
    if (message.params?.threadId === "thread-settings-race" && message.params?.model === "gpt-6-sol") {
      const reply = () => fsSync.existsSync(process.env.FAKE_CAPTURE_PATH + ".runtime-patch-release")
        ? send({ id: message.id, result: { thread: { id: message.params.threadId } } }) : setTimeout(reply, 10);
      return reply();
    }
    if (message.params?.threadId === "thread-runtime-regression" && !message.params?.model) {
      return send({ id: message.id, error: { code: -32000, message: "readonly observation must not resume" } });
    }
    const matched = message.params?.threadId === "thread-runtime-matched";
    return send({
      id: message.id,
      result: {
        thread: { id: message.params?.threadId },
        model: matched ? message.params?.model : "gpt-5.4-mini",
        reasoningEffort: matched ? message.params?.config?.model_reasoning_effort : "low",
        ...(sharedPersonal ? { sandboxPolicy: { type: "dangerFullAccess" }, approvalPolicy: "never" } : {}),
      },
    });
  }
  if (message.method === "turn/start") {
    const requestText = JSON.stringify(message.params || {});
    const uniqueTurn = process.pid + "-" + (++turnSequence);
    const turns = fixtureTurns.get(message.params.threadId) || [];
    fixtureTurns.set(message.params.threadId, turns);
    if (process.env.FAKE_TURN_OWNERSHIP === "1") {
      if (requestText.includes("uncertain ownership")) return send({ id: message.id, error: { code: -32000, message: "synthetic uncertain start receipt" } });
      const id = "owned-turn-" + uniqueTurn, old = turns.at(-1)?.id, early = requestText.includes("early ownership");
      turns.push({ id, nativeKnown: true, items: [{ type: "agentMessage", phase: "final_answer", text: "owned output" }] });
      send({ id: message.id, result: { turn: { id } } }, early ? 150 : 0);
      send({ method: "turn/started", params: { threadId: message.params.threadId, turn: { id, status: "inProgress" } } }, 10);
      send({ method: "item/agentMessage/delta", params: { threadId: message.params.threadId, turnId: id, delta: "owned output" } }, 20);
      if (requestText.includes("approval ownership")) send({ id: "own-approval-" + id, method: "item/commandExecution/requestApproval", params: { threadId: message.params.threadId, turnId: id, itemId: "new-command", command: "synthetic-only" } }, 20);
      if (requestText.includes("orphan ownership")) send({ id: "orphan-approval-" + id, method: "item/commandExecution/requestApproval", params: { threadId: message.params.threadId, turnId: id, itemId: "orphan-command", command: "synthetic-orphan" } }, 20);
      if (old) {
        send({ method: "turn/started", params: { threadId: message.params.threadId, turn: { id: old, status: "inProgress" } } }, 25);
        send({ method: "thread/tokenUsage/updated", params: { threadId: message.params.threadId, turnId: old, tokenUsage: { last: { inputTokens: 999999, outputTokens: 1 } } } }, 30);
        send({ method: "item/agentMessage/delta", params: { threadId: message.params.threadId, turnId: old, delta: "STALE OUTPUT MUST NOT APPEAR" } }, 35);
        send({ id: "stale-approval-" + id, method: "item/commandExecution/requestApproval", params: { threadId: message.params.threadId, turnId: old, itemId: "old-command", command: "must-not-run" } }, 40);
        send({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: old, status: "completed" } } }, 45);
      }
      const complete = () => {
        if (requestText.includes("approval ownership") && !acceptedApprovals.has("own-approval-" + id)) return setTimeout(complete, 20);
        if (requestText.includes("held ownership") && !fsSync.existsSync(process.env.FAKE_CAPTURE_PATH + ".release")) return setTimeout(complete, 20);
        if (requestText.includes("orphan ownership") && !fsSync.existsSync(process.env.FAKE_CAPTURE_PATH + ".orphan-release")) return setTimeout(complete, 20);
        if (requestText.includes("delegated usage")) send({ method: "item/started", params: { threadId: message.params.threadId, turnId: id,
          item: { type: "subAgentActivity", id: "delegate-item-" + id, kind: "started", agentThreadId: "child-" + id, agentPath: "/root/fixture" } } });
        if (requestText.includes("multi usage")) {
          send({ method: "thread/tokenUsage/updated", params: { threadId: message.params.threadId, turnId: id, tokenUsage: { total: { inputTokens: 1000, outputTokens: 300 }, last: { inputTokens: 100, outputTokens: 30 } } } });
          for (let duplicate = 0; duplicate < 2; duplicate++) send({ method: "thread/tokenUsage/updated", params: { threadId: message.params.threadId, turnId: id,
            tokenUsage: { total: { inputTokens: 1100, outputTokens: 330 }, last: { inputTokens: 100, outputTokens: 30 } } } });
        } else send({ method: "thread/tokenUsage/updated", params: { threadId: message.params.threadId, turnId: id, tokenUsage: { total: { inputTokens: 100, outputTokens: 30 }, last: { inputTokens: 100, outputTokens: 30 } } } });
        send({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id, status: "completed" } } }, 10);
      };
      setTimeout(complete, 60); return;
    }
    if (requestText.includes("artifact delivery fixture")) {
      const cwd = fixtureCwds.get(message.params.threadId);
      fsSync.mkdirSync(cwd + "/results", { recursive: true });
      fsSync.writeFileSync(cwd + "/results/report.md", "verified artifact delivery\\n");
    }
    if (requestText.includes("model api regression")) {
      modelApiTurnId = "turn-model-api-" + uniqueTurn;
      modelApiStructured = Boolean(message.params.outputSchema);
      modelApiText = modelApiStructured ? JSON.stringify({ answer: requestText.includes("invalid schema result") ? 7 : requestText.includes("large structured output") ? "验收".repeat(2500) : "结构化验收通过" }) : requestText.includes("long output") ? "验收".repeat(2500) : "接口验收通过";
      modelApiImages = requestText.includes("generated output") ? [{ id: "ig-fixture", type: "imageGeneration", status: "completed", failure: null, result: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", revisedPrompt: "图片输出验收" }] : [];
      turns.push({ id: modelApiTurnId, nativeKnown: true, items: [...(modelApiStructured ? [{ type: "agentMessage", phase: "commentary", text: "private non-JSON progress" }] : []),
        { type: "agentMessage", text: modelApiText, ...(modelApiStructured ? { phase: "final_answer" } : {}) }, ...modelApiImages] });
      if (requestText.includes("profile approval denied")) send({ id: "profile-request-extra", method: "item/commandExecution/requestApproval", params: { threadId: message.params.threadId, turnId: modelApiTurnId, command: "must-not-run" } }, 30);
      send({ id: message.id, result: { turn: { id: modelApiTurnId } } });
      send({ method: "item/agentMessage/delta", params: { threadId: message.params.threadId, turnId: modelApiTurnId, delta: modelApiText.slice(0, 2) } }, 40);
      send({ method: "item/agentMessage/delta", params: { threadId: message.params.threadId, turnId: modelApiTurnId, delta: modelApiText.slice(2) } }, 150);
      send({ method: "thread/tokenUsage/updated", params: { threadId: message.params.threadId, turnId: modelApiTurnId, tokenUsage: { total: { inputTokens: 100, outputTokens: 30, totalTokens: 130 }, last: { inputTokens: 100, outputTokens: 30, totalTokens: 130 } } } }, 170);
      send({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: modelApiTurnId, status: "completed" } } }, 300);
      return;
    }
    const turnId = (requestText.includes("cancel regression") ? "turn-cancel-regression-" : "turn-regression-") + uniqueTurn;
    turns.push({ id: turnId, items: [] });
    if (process.env.FAKE_CANCEL_GATES === "1") {
      cancelGates.set(turnId, { uncertain: requestText.includes("interrupt uncertain"), waiting: false });
      const receipt = () => {
        if (requestText.includes("hold start receipt") && !fsSync.existsSync(process.env.FAKE_CAPTURE_PATH + ".cancel-start-release")) return setTimeout(receipt, 20);
        send({ id: message.id, result: { turn: { id: turnId } } });
      };
      receipt(); return;
    }
    const progressRegression = requestText.includes("progress regression");
    const queuedFirstRegression = requestText.includes("progress regression queue first");
    const queueRegressionNext = requestText.includes("queue regression next");
    const personalDeletionRegression = requestText.includes("personal deletion regression");
    const recoveryRegression = requestText.includes("继续上一轮因服务重启中断的自动化任务");
    const outcomeContractRegression = requestText.includes("outcome contract regression");
    const personalTestRegression = requestText.includes("personal schedule test regression");
    const personalEmptyTestRegression = requestText.includes("personal schedule empty regression");
    const externalWriteRegression = requestText.includes("external write regression");
    send({ id: message.id, result: { turn: { id: turnId } } });
    if (externalWriteRegression) {
      const isReadOnly = requestText.includes("read only");
      const isTimeout = requestText.includes("timeout");
      const isFailure = requestText.includes("tool failure");
      const item = { type: "mcpToolCall", id: "external-write-regression", server: "connected-calendar", tool: "create_event", status: "inProgress", readOnlyHint: requestText.includes("missing hint") ? null : isReadOnly, appContext: requestText.includes("no app context") ? null : { connectorId: "fixture-calendar", actionName: "create_event" } };
      send({ method: "item/started", params: { threadId: message.params?.threadId, turnId, item } }, 20);
      if (!isTimeout) {
        send({ method: "item/completed", params: { threadId: message.params?.threadId, turnId, item: { ...item, status: isFailure ? "failed" : "completed" } } }, 65);
        send({ method: "thread/tokenUsage/updated", params: {
          threadId: message.params?.threadId, turnId, tokenUsage: { total: { inputTokens: 100, outputTokens: 30 }, last: { inputTokens: 100, outputTokens: 30 } },
        } }, 75);
        send({ method: "turn/completed", params: { threadId: message.params?.threadId, turn: { id: turnId, status: "completed" } } }, 90);
      }
    } else if (queueRegressionNext) {
      send({ method: "item/agentMessage/delta", params: {
        threadId: message.params?.threadId,
        turnId,
        delta: "queued response complete",
      } }, 40);
      send({ method: "turn/completed", params: {
        threadId: message.params?.threadId,
        turn: { id: turnId, status: "completed" },
      } }, queuedNextDelay);
    } else if (progressRegression) {
      if (process.env.FAKE_QUEUE_COMPLETION_GATE === "1" && (queuedFirstRegression || requestText.includes("progress regression cancel queue first"))) {
        // Keep queue preconditions true until the test releases them, even on a throttled host.
        const progress = setInterval(() => send({ method: "item/mcpToolCall/progress", params: {
          threadId: message.params.threadId, turnId, itemId: "progress-regression", message: "progress regression activity",
        } }), 150);
        const complete = () => {
          if (!fsSync.existsSync(process.env.FAKE_CAPTURE_PATH + ".queue-release")) return setTimeout(complete, 20);
          clearInterval(progress);
          send({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: turnId, status: "completed" } } });
        };
        complete();
        return;
      }
      const progressDelays = queuedFirstRegression ? Array.from({ length: 16 }, (_, index) => 150 * (index + 1)) : [150, 300, 450];
      for (const delay of progressDelays) {
        send({ method: "item/mcpToolCall/progress", params: {
          threadId: "thread-regression",
          turnId,
          itemId: "progress-regression",
          message: "progress regression activity",
        } }, delay);
      }
      if (!queuedFirstRegression || process.env.FAKE_HOLD_QUEUE_FIRST !== "1") send({ method: "turn/completed", params: {
        threadId: "thread-regression",
        turn: { id: turnId, status: "completed" },
      } }, queuedFirstRegression ? 2_600 : 650);
    }
    if (personalDeletionRegression) {
      const finishWhenReleased = () => {
        const gate = process.env.FAKE_PERSONAL_DELETE_GATE_PATH;
        if (gate && !fsSync.existsSync(gate)) return setTimeout(finishWhenReleased, 20);
        send({ method: "turn/completed", params: {
          threadId: message.params?.threadId,
          turn: { id: turnId, status: "completed" },
        } });
      };
      finishWhenReleased();
    }
    if (outcomeContractRegression) {
      const missingMarker = requestText.includes("missing marker");
      const legacyRun = requestText.includes("legacy no contract");
      const output = missingMarker
        ? "CONTRACT_MISSING_COMPLETE\\n任务尚未得到业务确认"
        : legacyRun
          ? "旧任务正常完成，无需完成契约"
          : "业务结果已核验\\r\\nCONTRACT_PASS_COMPLETE\\r\\n\\r\\n";
      send({ method: "item/agentMessage/delta", params: {
        threadId: message.params?.threadId,
        turnId,
        delta: output,
      } }, 40);
      if (requestText.includes("late event")) {
        for (const delay of [75, 82, 90, 110]) {
          send({ method: "thread/status/changed", params: {
            threadId: message.params?.threadId,
            status: "idle",
          } }, delay);
        }
      }
      send({ method: "turn/completed", params: {
        threadId: message.params?.threadId,
        turn: { id: turnId, status: "completed" },
      } }, 80);
    } else if (personalTestRegression) {
      send({ method: "item/agentMessage/delta", params: {
        threadId: message.params?.threadId, turnId, delta: "模拟试运行结果：已核对资料，无外部写入",
      } }, 40);
      send({ method: "thread/tokenUsage/updated", params: {
        threadId: message.params?.threadId, turnId, tokenUsage: { total: { inputTokens: 100, outputTokens: 30 }, last: { inputTokens: 100, outputTokens: 30 } },
      } }, 60);
      send({ method: "turn/completed", params: {
        threadId: message.params?.threadId, turn: { id: turnId, status: "completed" },
      } }, 80);
    } else if (personalEmptyTestRegression) {
      send({ method: "thread/tokenUsage/updated", params: {
        threadId: message.params?.threadId, turnId, tokenUsage: { total: { inputTokens: 100, outputTokens: 1 }, last: { inputTokens: 100, outputTokens: 1 } },
      } }, 60);
      send({ method: "turn/completed", params: {
        threadId: message.params?.threadId, turn: { id: turnId, status: "completed" },
      } }, 80);
    } else if (recoveryRegression) {
      const output = requestText.includes("RECOVERY_REGRESSION_COMPLETE")
        ? "恢复后的业务动作已核验\\nRECOVERY_REGRESSION_COMPLETE"
        : "恢复回合结束，但没有业务完成标记";
      send({ method: "item/agentMessage/delta", params: {
        threadId: message.params?.threadId,
        turnId,
        delta: output,
      } }, 40);
      send({ method: "turn/completed", params: {
        threadId: message.params?.threadId,
        turn: { id: turnId, status: "completed" },
      } }, 80);
    }
    return;
  }
  if (process.env.FAKE_CANCEL_GATES === "1" && message.method === "review/start") {
    const turnId = "cancel-review-" + (++turnSequence), threadId = message.params.delivery === "detached" ? "detached-" + turnId : message.params.threadId;
    cancelGates.set(turnId, { uncertain: false, waiting: false });
    const receipt = () => {
      if (!fsSync.existsSync(process.env.FAKE_CAPTURE_PATH + ".review-start-release-" + message.params.delivery)) return setTimeout(receipt, 20);
      send({ id: message.id, result: { turn: { id: turnId }, reviewThreadId: threadId } });
    };
    receipt(); return;
  }
  if (process.env.FAKE_TURN_OWNERSHIP === "1" && message.method === "review/start") {
    const threadId = message.params.delivery === "detached" ? "detached-review-" + (++turnSequence) : message.params.threadId;
    const id = "review-owned-" + turnSequence;
    send({ method: "turn/started", params: { threadId, turn: { id, status: "inProgress" } } });
    send({ method: "item/agentMessage/delta", params: { threadId, turnId: id, delta: "owned review" } }, 10);
    send({ method: "turn/completed", params: { threadId, turn: { id, status: "completed" } } }, 20);
    return send({ id: message.id, result: { turn: { id }, reviewThreadId: threadId } }, 80);
  }
  if (process.env.FAKE_TURN_OWNERSHIP === "1" && message.method === "thread/compact/start") {
    const id = "compact-owned-" + (++turnSequence), threadId = message.params.threadId;
    const old = fixtureTurns.get(threadId)?.at(-1)?.id;
    if (old) send({ method: "turn/completed", params: { threadId, turn: { id: old, status: "completed" } } });
    send({ method: "item/started", params: { threadId, turnId: id, startedAtMs: Date.now(), item: { type: "contextCompaction", id: "compact-item" } } }, 10);
    send({ id: message.id, result: {} }, 80);
    const finish = () => {
      if (!fsSync.existsSync(process.env.FAKE_CAPTURE_PATH + ".compact-release")) return setTimeout(finish, 20);
      send({ method: "item/completed", params: { threadId, turnId: id, item: { type: "contextCompaction", id: "compact-item" } } });
      send({ method: "turn/completed", params: { threadId, turn: { id, status: fsSync.existsSync(process.env.FAKE_CAPTURE_PATH + ".compact-fail") ? "failed" : "completed" } } }, 20);
    };
    setTimeout(finish, 100); return;
  }
  if (message.method === "turn/interrupt") {
    const gate = cancelGates.get(message.params?.turnId);
    if (gate) {
      send(gate.uncertain ? { id: message.id, error: { code: -32000, message: "Synthetic interruption receipt uncertain" } } : { id: message.id, result: {} });
      if (!gate.waiting) {
        gate.waiting = true;
        const complete = () => {
          if (!fsSync.existsSync(process.env.FAKE_CAPTURE_PATH + ".cancel-completion-" + message.params.turnId)) return setTimeout(complete, 20);
          send({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: message.params.turnId, status: "interrupted" } } });
        };
        complete();
      }
      return;
    }
    send({ id: message.id, result: {} });
    if (String(message.params?.turnId).startsWith("turn-cancel-regression-")) {
      send({ method: "turn/completed", params: {
        threadId: message.params?.threadId,
        turn: { id: message.params?.turnId, status: "interrupted" },
      } }, 20);
    }
    return;
  }
  if (message.method === "slow") return send({ id: message.id, result: { ok: true, generation: process.pid } }, 900);
  return send({ id: message.id, result: { ok: true, method: message.method } });
});
`,
    { mode: 0o755 },
  );
  return fakePath;
}

if (isolatedProcessGroups) await check("fixture shutdown stops descendants even after the parent has exited", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-process-stop-"));
  const marker = path.join(root, "late-write");
  const writer = `process.on('SIGTERM',()=>{});setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'must not survive'),300);console.log('writer-ready');setInterval(()=>{},1000);`;
  const parent = spawn(process.execPath, ["-e", `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(writer)}],{stdio:['ignore','pipe','ignore']});child.stdout.once('data',()=>{console.log('parent-ready');process.exit(0)});`], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    await waitForOutput(parent, /parent-ready/);
    await fixtureClosures.get(parent);
    await stopProcess(parent);
    await stopProcess(parent);
    await new Promise(resolve => setTimeout(resolve, 450));
    assert.equal(await fs.stat(marker).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; }), false);
  } finally { await stopProcess(parent); await fs.rm(root, { recursive: true, force: true }); }
});

await check("client limits preserve budget accounting, replay, policy conflicts and execution checks", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-client-policy-"));
  const cloudRoot = path.join(root, "cloud"), stateRoot = path.join(root, "state"), bin = path.join(root, "bin");
  const repo = path.join(cloudRoot, "workspace/sample-app"), capture = path.join(root, "requests.ndjson");
  for (const dir of [repo, stateRoot, bin]) await fs.mkdir(dir, { recursive: true });
  await initializeGitFixture(repo);
  const fake = await writeFakeCodex(root);
  await fs.writeFile(path.join(bin, "codex"), `#!/bin/sh\nexec "${process.execPath}" "${fake}"\n`, { mode: 0o755 });
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const headers = { "content-type": "application/json", "x-codex-cloud-token": "client-policy-fixture-admin" };
  let globalBudget = "500", globalConcurrency = "2", backendError = "";
  const start = () => {
    const child = spawn(process.execPath, [path.join(projectRoot, "server/index.mjs")], { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"], env: {
    ...process.env, NODE_ENV: "production", HOST: "127.0.0.1", PORT: String(port), CODEX_CLOUD_ROOT: cloudRoot,
    CODEX_STATE_ROOT: stateRoot, CODEX_HOME: path.join(root, ".codex"), CODEX_AUTOMATION_RECOVERY_ENABLED: "0", CODEX_ALLOW_LOCAL_FALLBACK: "0",
    CODEX_CLOUD_WEBHOOK_TOKEN: headers["x-codex-cloud-token"], CODEX_AUTOMATION_DAILY_KNOWN_TOKEN_LIMIT: globalBudget,
    CODEX_AUTOMATION_MAX_CONCURRENT: globalConcurrency, CODEX_AUTOMATION_MAX_CONCURRENT_PER_CLIENT: "2", CODEX_AUTOMATION_TRIGGER_RATE_MAX: "100",
    FAKE_CAPTURE_PATH: capture, PATH: `${bin}:${process.env.PATH}`,
    } });
    child.stderr.on("data", data => { backendError = (backendError + data).slice(-4000); });
    return child;
  };
  const submit = (key, auth = headers, prompt = "model api regression client-policy") => jsonRequest(base, "/api/automations/sample-research/webhook", {
    method: "POST", headers: { ...auth, "idempotency-key": key }, body: JSON.stringify({ prompt, ...(auth === headers ? { worktree: false } : {}) }),
  });
  const waitRun = async (submitted, auth = headers) => {
    let lastResult;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const result = await jsonRequest(base, submitted.data.run.resultPath, { headers: auth }); lastResult = result.data;
      if (["completed", "failed", "needs_reconciliation"].includes(result.data.run?.status)) return result.data.run;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error(JSON.stringify({ lastResult, backendError }));
  };
  const create = async (name, policy) => {
    const result = await jsonRequest(base, "/api/clients", { method: "POST", headers, body: JSON.stringify({ name, automationIds: ["sample-research"], ...policy }) });
    assert.equal(result.response.status, 201);
    return { client: result.data.client, auth: { "content-type": "application/json", authorization: `Bearer ${result.data.token}` } };
  };
  let server;
  try {
    server = start();
    await waitForOutput(server, /listening on/);
    const submitted = await submit("budget-self-0001");
    assert.equal(submitted.response.status, 200);
    const terminal = await waitRun(submitted);
    assert.equal(terminal.status, "completed", terminal.error);
    assert.equal(terminal.usage.totalTokens, 130);
    const a = await create("client-a", { maxConcurrent: 1, dailyKnownTokenLimit: 100 });
    const b = await create("client-b", { dailyKnownTokenLimit: 300 });
    const aRun = await submit("client-a-first-0001", a.auth);
    assert.equal(aRun.response.status, 200);
    assert.equal((await waitRun(aRun, a.auth)).status, "completed");
    const rejected = await submit("client-a-second-0002", a.auth);
    assert.equal(rejected.response.status, 429);
    assert.equal(rejected.data.code, "known_token_limit_reached");
    const replay = await submit("client-a-first-0001", a.auth);
    assert.equal(replay.data.run.id, aRun.data.run.id); assert.equal(replay.data.deduplicated, true);
    const bRun = await submit("client-b-first-0001", b.auth);
    const pending = await submit("client-b-second-0002", b.auth);
    assert.equal(pending.response.status, 429); assert.equal(pending.data.code, "token_usage_pending");
    assert.equal((await waitRun(bRun, b.auth)).status, "completed");
    const policyPath = `/api/clients/${a.client.id}/policy`;
    const update = await jsonRequest(base, policyPath, { method: "PATCH", headers, body: JSON.stringify({ expectedRevision: 0, dailyKnownTokenLimit: 200 }) });
    assert.equal(update.response.status, 200); assert.equal(update.data.client.policyRevision, 1);
    const stale = await jsonRequest(base, policyPath, { method: "PATCH", headers, body: JSON.stringify({ expectedRevision: 0, dailyKnownTokenLimit: null }) });
    assert.equal(stale.response.status, 409);
    const cap = await jsonRequest(base, "/api/automations/sample-research/v1/capabilities", { headers: a.auth });
    assert.equal(cap.data.limits.task_queue.max_concurrent_per_client, 1);
    assert.equal(cap.data.limits.task_queue.client_daily_known_token_limit, 200);
    const aSecond = await submit("client-a-second-0002", a.auth);
    assert.equal((await waitRun(aSecond, a.auth)).status, "completed");
    assert.equal((await submit("server-budget-reached-0001", b.auth)).response.status, 429);
    await stopProcess(server);
    // Change only this synthetic server's policy; retained accounting is not cleared.
    globalBudget = ""; server = start(); await waitForOutput(server, /listening on/);
    const c = await create("unknown-client", { dailyKnownTokenLimit: 200 });
    const ledger = openRunUsageLedger(path.join(stateRoot, "run-usage.sqlite"));
    try { ledger.sync([{ id: "unknown-client-fixture", clientId: c.client.id, automationId: "sample-research", runner: "app-server", status: "needs_reconciliation", startedAt: new Date().toISOString(), usage: { status: "unknown" } }]); }
    finally { ledger.close(); }
    const unknown = await submit("unknown-client-0001", c.auth);
    assert.equal(unknown.response.status, 409); assert.equal(unknown.data.code, "token_usage_incomplete");
    assert.equal((await waitRun(await submit("client-b-second-0002", b.auth), b.auth)).status, "completed");
    const usage = await jsonRequest(base, "/api/clients/usage", { headers });
    assert.equal(usage.data.runBuckets.reduce((sum, row) => sum + row.totalTokens, 0), 650);
    assert.equal(usage.data.runSummary.unknownUsage, 1);
    assert.equal(usage.data.deliverySummary.results.ready, 5);
    assert.equal(usage.data.deliverySummary.results.untracked, 1);
    assert.equal(usage.data.deliverySummary.tasks, usage.data.runSummary.tasks);
    assert.equal(usage.data.deliverySummary.callbacks.notRetained, 5);
    const ownDelivery = await jsonRequest(base, `/api/clients/usage?clientId=${a.client.id}`, { headers });
    assert.equal(ownDelivery.data.deliverySummary.tasks, 2);
    assert.equal(ownDelivery.data.deliverySummary.results.ready, 2);
    assert.ok(ownDelivery.data.deliverySummary.details.every(row => row.clientId === a.client.id));
    const clientsFile = path.join(stateRoot, "api-clients.json");
    const savedClients = await fs.readFile(clientsFile, "utf8"), damaged = JSON.parse(savedClients);
    damaged.clients[0].dailyKnownTokenLimit = -1;
    await fs.writeFile(clientsFile, JSON.stringify(damaged));
    const brokenHealth = await jsonRequest(base, "/healthz");
    assert.equal(brokenHealth.response.status, 503);
    assert.equal(brokenHealth.data.layers.apiClients.ok, false);
    assert.equal((await submit("damaged-policy-0001", b.auth)).response.status, 503);
    await fs.writeFile(clientsFile, savedClients);
    const calls = (await fs.readFile(capture, "utf8")).split("\n").filter(Boolean).map(JSON.parse);
    assert.equal(calls.filter(row => row.method === "turn/start").length, 5);
    await stopProcess(server);
    globalConcurrency = "1"; server = start(); await waitForOutput(server, /listening on/);
    const expiring = await create("expiring-while-queued", {});
    const holding = await submit("policy-hold-0001", headers, "progress regression queue first policy hold");
    const startedDeadline = Date.now() + 5000;
    while (Date.now() < startedDeadline) {
      const active = await jsonRequest(base, holding.data.run.resultPath, { headers });
      if (active.data.run?.status === "running") break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    const queued = await submit("expiry-queued-0001", expiring.auth);
    assert.equal(queued.data.run.status, "queued");
    const expires = await jsonRequest(base, `/api/clients/${expiring.client.id}/policy`, { method: "PATCH", headers, body: JSON.stringify({ expectedRevision: 0, expiresAt: new Date(Date.now() + 500).toISOString() }) });
    assert.equal(expires.response.status, 200);
    await waitRun(holding);
    let expiredRun;
    const expiryDeadline = Date.now() + 5000;
    while (Date.now() < expiryDeadline) {
      const list = await jsonRequest(base, "/api/automations/runs", { headers });
      expiredRun = list.data.runs.find(run => run.id === queued.data.run.id);
      if (expiredRun?.status === "failed") break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.equal(expiredRun?.status, "failed"); assert.equal(expiredRun.usage.totalTokens, 0);
    assert.equal((await submit("expiry-queued-0001", expiring.auth)).response.status, 401);
    await jsonRequest(base, `/api/clients/${expiring.client.id}/policy`, { method: "PATCH", headers, body: JSON.stringify({ expectedRevision: 1, expiresAt: new Date(Date.now() + 60_000).toISOString() }) });
    const recovered = await submit("expiry-queued-0001", expiring.auth);
    assert.equal(recovered.data.run.id, queued.data.run.id); assert.equal(recovered.data.run.status, "failed");
    const finalCalls = (await fs.readFile(capture, "utf8")).split("\n").filter(Boolean).map(JSON.parse);
    assert.equal(finalCalls.filter(row => row.method === "turn/start").length, 6);
  } finally { await stopProcess(server); await fs.rm(root, { recursive: true, force: true }); }
});

await check("scoped API callback intent survives restart and changed registration never receives old events", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-callback-api-"));
  const cloudRoot = path.join(root,"cloud"), stateRoot = path.join(root,"state"), bin = path.join(root,"bin");
  const repo = path.join(cloudRoot,"workspace/sample-app"), config = path.join(root,"callbacks.json"), capturedEnv = path.join(root,"child-env.json");
  for (const directory of [repo,stateRoot,bin]) await fs.mkdir(directory,{recursive:true});
  await initializeGitFixture(repo);
  const fake = await writeFakeCodex(root);
  await fs.writeFile(path.join(bin,"codex"),`#!/bin/sh\nexec "${process.execPath}" "${fake}"\n`,{mode:0o755});
  const clients = ["a","b"].map(letter=>({id:`callback-client-${letter}`,name:`callback-${letter}`,tokenHash:crypto.createHash("sha256").update(`callback-fixture-token-${letter}`).digest("hex"),automationIds:["sample-research"],expiresAt:null,revokedAt:null}));
  await fs.writeFile(path.join(stateRoot,"api-clients.json"),JSON.stringify({version:1,clients}));
  const target = {id:"receiver",clientId:clients[0].id,automationId:"sample-research",url:"https://callback.invalid/old",secretEnv:"CODEX_CLOUD_CALLBACK_SECRET_FIXTURE"};
  await fs.writeFile(config,JSON.stringify([target]),{mode:0o600});
  const port=await freePort(),base=`http://127.0.0.1:${port}`,admin={"content-type":"application/json","x-codex-cloud-token":"callback-admin-fixture-token"};
  const auth=letter=>({"content-type":"application/json",authorization:`Bearer callback-fixture-token-${letter}`});
  const start=()=>spawn(process.execPath,[path.join(projectRoot,"server/index.mjs")],{cwd:projectRoot,stdio:["ignore","pipe","pipe"],env:{...process.env,NODE_ENV:"production",HOST:"127.0.0.1",PORT:String(port),CODEX_CLOUD_ROOT:cloudRoot,CODEX_STATE_ROOT:stateRoot,CODEX_HOME:path.join(root,".codex"),CODEX_CLOUD_WEBHOOK_TOKEN:admin["x-codex-cloud-token"],CODEX_CLOUD_CALLBACKS_FILE:config,CODEX_CLOUD_CALLBACK_SECRET_FIXTURE:"synthetic-fixture-secret-not-a-real-credential",FAKE_CAPTURE_CALLBACK_ENV_PATH:capturedEnv,FAKE_HOLD_QUEUE_FIRST:"1",CODEX_AUTOMATION_RECOVERY_ENABLED:"0",CODEX_AUTOMATION_MAX_CONCURRENT:"1",CODEX_AUTOMATION_MAX_CONCURRENT_PER_CLIENT:"1",PATH:`${bin}:${process.env.PATH}`}});
  const submit=(key,prompt,headers,extra={})=>jsonRequest(base,"/api/automations/sample-research/webhook",{method:"POST",headers:{...headers,"idempotency-key":key},body:JSON.stringify({prompt,...extra})});
  const wait=async task=>{const deadline=Date.now()+12000;while(Date.now()<deadline){const result=await task();if(result)return result;await new Promise(resolve=>setTimeout(resolve,250));}throw new Error("Callback API fixture did not settle");};
  let server;
  try {
    server=start();await waitForOutput(server,/listening on/);
    const caps=await jsonRequest(base,"/api/automations/sample-research/v1/capabilities",{headers:auth("a")});
    assert.equal(caps.data.features.callback.supported,true);assert.equal(caps.data.features.callback.configured,true);
    assert.deepEqual(JSON.parse(await fs.readFile(capturedEnv,"utf8")),[]);
    const otherCaps=await jsonRequest(base,"/api/automations/sample-research/v1/capabilities",{headers:auth("b")});
    assert.equal(otherCaps.data.features.callback.configured,false);
    const busy=await submit("callback-hold-0001","progress regression queue first",admin,{worktree:false});assert.equal(busy.response.status,200);
    const queued=await submit("callback-pending-0002","queue regression next",auth("a"));
    assert.equal(queued.response.status,200);assert.equal(queued.data.run.status,"queued");
    const first=await jsonRequest(base,queued.data.run.resultPath,{headers:auth("a")});
    assert.equal(first.data.run.callbackDelivery.status,"awaiting");const eventId=first.data.run.callbackDelivery.eventId;
    assert.equal((await jsonRequest(base,queued.data.run.resultPath,{headers:auth("b")})).response.status,404);
    const rejected=await submit("callback-override-0003","must not run",auth("a"),{callbackUrl:"https://not-registered.invalid/"});assert.equal(rejected.response.status,400);
    await stopProcess(server);
    await fs.writeFile(config,JSON.stringify([{...target,url:"https://callback.invalid/changed"}]));
    server=start();await waitForOutput(server,/listening on/);
    const finished=await wait(async()=>{const result=await jsonRequest(base,queued.data.run.resultPath,{headers:auth("a")});return result.data.run?.callbackDelivery?.status==="failed"?result.data.run:null;});
    assert.equal(finished.status,"completed");assert.equal(finished.callbackDelivery.eventId,eventId);assert.equal(finished.callbackDelivery.lastCode,"target_changed");
    const replay=await submit("callback-pending-0002","queue regression next",auth("a"));assert.equal(replay.data.run.id,queued.data.run.id);assert.equal(replay.data.deduplicated,true);
    const output=await jsonRequest(base,queued.data.run.resultPath+"/output",{headers:auth("a")});assert.equal(output.response.status,200);
    assert.equal(JSON.stringify(finished.callbackDelivery).includes("callback.invalid"),false);
  } finally {await stopProcess(server);await fs.rm(root,{recursive:true,force:true});}
});

await check("callback committed before sender crash is redelivered once without repeating inference or losing private results", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-callback-roundtrip-"));
  const cloud = path.join(root, "cloud"), state = path.join(root, "state"), bin = path.join(root, "bin");
  const repo = path.join(cloud, "workspace/sample-app"), capture = path.join(root, "rpc.ndjson"), inboxFile = path.join(root, "inbox.sqlite");
  for (const dir of [repo, state, bin]) await fs.mkdir(dir, { recursive: true });
  await initializeGitFixture(repo);
  const fake = await writeFakeCodex(root);
  await fs.writeFile(path.join(bin, "codex"), `#!/bin/sh\nexec "${process.execPath}" "${fake}"\n`, { mode: 0o755 });
  const secret = "synthetic-roundtrip-signing-secret-not-an-account-key", token = "roundtrip-client-private-fixture-token";
  const clientId = "callback-roundtrip-client", automationId = "sample-research";
  await fs.writeFile(path.join(state, "api-clients.json"), JSON.stringify({ version: 1, clients: [{ id: clientId, name: "Roundtrip fixture",
    tokenHash: crypto.createHash("sha256").update(token).digest("hex"), automationIds: [automationId], expiresAt: null, revokedAt: null }] }));
  const config = path.join(root, "callbacks.json"), transport = path.join(root, "transport.mjs"), transportTrace = path.join(root, "transport.ndjson");
  await fs.writeFile(config, JSON.stringify([{ id: "receiver", clientId, automationId, url: "https://callback.test/codex/completed", secretEnv: "CODEX_CLOUD_CALLBACK_SECRET_FIXTURE" }]), { mode: 0o600 });
  const key = path.join(root, "key.pem"), cert = path.join(root, "cert.pem");
  const openssl = await runCaptured(process.platform === "darwin" ? "/usr/bin/openssl" : "openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=callback.test", "-addext", "subjectAltName=DNS:callback.test"]);
  assert.equal(openssl.code, 0, openssl.stderr);
  const port = await freePort(), origin = `http://127.0.0.1:${port}`, admin = { "x-codex-cloud-token": "roundtrip-admin-fixture-token" };
  const receiverEnv = { PATH: process.env.PATH, HOME: root, CODEX_CALLBACK_RECEIVER_STATE: inboxFile, CODEX_CALLBACK_RECEIVER_SECRET: secret,
    CODEX_CALLBACK_RECEIVER_AUTOMATION_ID: automationId, CODEX_CALLBACK_RECEIVER_PORT: "0" };
  let server, receiver, tls, heldResponse, proxyError;
  const receipts = [];
  const wait = async (task, timeoutMs = 10000) => {
    const deadline = Date.now() + timeoutMs;
    do {
      if (proxyError) throw proxyError;
      const value = await task(); if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    throw new Error("Callback roundtrip did not reach its required checkpoint");
  };
  try {
    receiver = spawn(process.execPath, [path.join(projectRoot, "scripts/callback-inbox-example.mjs")], { env: receiverEnv, stdio: ["ignore", "pipe", "pipe"] });
    const ready = await waitForOutput(receiver, /"url":/);
    const receiverUrl = JSON.parse(ready.split("\n").find(line => line.startsWith("{"))).url;
    const certificate = await fs.readFile(cert);
    tls = https.createServer({ key: await fs.readFile(key), cert: certificate }, (request, response) => {
      const chunks = [];
      request.on("data", chunk => chunks.push(chunk));
      const forward = http.request(receiverUrl, { method: request.method, headers: request.headers }, received => {
        const answer = [];
        received.on("data", chunk => answer.push(chunk));
        received.on("end", () => {
          receipts.push({ body: Buffer.concat(chunks).toString("utf8"), eventId: request.headers["x-codex-event-id"], code: received.statusCode, receivedAt: Date.now() });
          if (receipts.length === 1) { heldResponse = response; return; }
          response.writeHead(received.statusCode, { "content-type": "application/json" }); response.end(Buffer.concat(answer));
        });
      });
      forward.on("error", error => { proxyError = error; response.destroy(); }); request.pipe(forward);
    });
    await new Promise(resolve => tls.listen(0, "127.0.0.1", resolve));
    await assert.rejects(new Promise((resolve, reject) => {
      const request = https.get({ hostname: "127.0.0.1", port: tls.address().port, path: "/codex/completed", servername: "wrong.test", ca: certificate }, response => {
        response.resume(); resolve();
      });
      request.once("error", reject); request.setTimeout(3000, () => request.destroy(new Error("TLS rejection checkpoint timed out")));
    }), { code: "ERR_TLS_CERT_ALTNAME_INVALID" });
    assert.equal(receipts.length, 0, "A wrong TLS hostname cannot reach the receiver");
    // Only this disposable child maps a verified public fixture IP to a local TLS receiver.
    // Production DNS/IP checks and certificate verification remain enabled and unchanged.
    await fs.writeFile(transport, `import assert from 'node:assert/strict';import fs from 'node:fs';import https from 'node:https';import {Resolver} from 'node:dns/promises';
Resolver.prototype.resolve4=async host=>{assert.equal(host,'callback.test');return ['8.8.8.8'];};
Resolver.prototype.resolve6=async host=>{assert.equal(host,'callback.test');return [];};
const original=https.request;https.request=(url,options,respond)=>{assert.equal(url.href,'https://callback.test/codex/completed');assert.equal(options.agent,false);assert.equal(options.family,4);assert.notEqual(options.rejectUnauthorized,false);
let checked=false;options.lookup(url.hostname,{},(error,address,family)=>{assert.equal(error,null);assert.equal(address,'8.8.8.8');assert.equal(family,4);checked=true;});assert.ok(checked);
fs.appendFileSync(${JSON.stringify(transportTrace)},JSON.stringify({hostname:url.hostname,checkedAddress:'8.8.8.8',tlsVerified:true})+'\\n');
return original(url,{...options,port:${tls.address().port},ca:fs.readFileSync(${JSON.stringify(cert)}),lookup:(_h,o,done)=>done(null,o.all?[{address:'127.0.0.1',family:4}]:'127.0.0.1',4)},respond);};\n`, { mode: 0o600 });
    const start = () => spawn(process.execPath, [path.join(projectRoot, "server/index.mjs")], { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"], env: {
      PATH: `${bin}:${process.env.PATH}`, HOME: root, CODEX_HOME: path.join(root, ".codex"), NODE_OPTIONS: `--import=${pathToFileURL(transport).href}`,
      NODE_ENV: "production", HOST: "127.0.0.1", PORT: String(port), CODEX_CLOUD_ROOT: cloud, CODEX_STATE_ROOT: state,
      CODEX_CLOUD_WEBHOOK_TOKEN: admin["x-codex-cloud-token"], CODEX_CLOUD_CALLBACKS_FILE: config, CODEX_CLOUD_CALLBACK_SECRET_FIXTURE: secret,
      CODEX_AUTOMATION_RECOVERY_ENABLED: "0", CODEX_ALLOW_LOCAL_FALLBACK: "0", FAKE_CAPTURE_PATH: capture,
    } });
    server = start(); await waitForOutput(server, /listening on/);
    const options = { origin, token, automationId, timeoutMs: 10000, requestTimeoutMs: 3000 };
    const input = { prompt: "model api regression artifact delivery fixture", model: "gpt-6-sol", artifactPaths: ["results/report.md"],
      outputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false } };
    const eventId = "callback-roundtrip-0001";
    const run = await runExternalClient({ ...options, command: "submit", eventId, input, wait: true });
    assert.equal(run.status, "completed");
    await wait(() => receipts.length === 1 && receipts[0].code === 202);
    const before = await runExternalClient({ ...options, command: "status", runId: run.id });
    assert.equal(before.callbackDelivery.status, "sending"); assert.equal(before.callbackDelivery.attempts, 1);
    const event = JSON.parse(receipts[0].body);
    assert.equal(event.id, before.callbackDelivery.eventId); assert.equal(event.data.run_id, run.id); assert.equal(event.data.status, "completed");
    assert.deepEqual(Object.keys(event.data).sort(), ["automation_id", "output_path", "result_path", "run_id", "status"]);
    for (const privateValue of [secret, token, input.prompt, "verified artifact delivery"]) assert.equal(receipts[0].body.includes(privateValue), false);
    const closed = fixtureClosures.get(server);
    if (isolatedProcessGroups) process.kill(-server.pid, "SIGKILL"); else server.kill("SIGKILL");
    await closed; await stopProcess(server); server = null;
    heldResponse.destroy();
    server = start(); await waitForOutput(server, /listening on/);
    const resumed = await runExternalClient({ ...options, command: "status", runId: run.id });
    assert.equal(resumed.callbackDelivery.eventId, event.id); assert.equal(resumed.status, "completed");
    assert.equal(resumed.callbackDelivery.status, "sending"); assert.equal(resumed.callbackDelivery.attempts, 1); assert.equal(receipts.length, 1);
    assert.deepEqual(resumed.usage, run.usage);
    // Wait for the real persisted 30-second lease; do not edit SQL or advance system time.
    await wait(() => receipts.length === 2, 45000);
    assert.deepEqual(receipts.map(item => item.code), [202, 200]);
    assert.equal(receipts[1].body, receipts[0].body); assert.equal(receipts[1].eventId, event.id);
    const delivered = await wait(async () => {
      const current = await runExternalClient({ ...options, command: "status", runId: run.id });
      return current.callbackDelivery.status === "delivered" ? current : null;
    });
    assert.equal(delivered.callbackDelivery.attempts, 2); assert.equal(delivered.status, "completed"); assert.deepEqual(delivered.usage, run.usage);
    const output = await runExternalClient({ ...options, command: "output", runId: event.data.run_id });
    assert.equal(output.structuredOutput.data.answer, "结构化验收通过");
    const artifact = output.artifacts.find(item => item.name === "report.md");
    const download = await runExternalClient({ ...options, command: "download", runId: run.id, fileId: artifact.id });
    assert.equal(download.buffer.toString(), "verified artifact delivery\n");
    const replay = await runExternalClient({ ...options, command: "submit", eventId, input }); assert.equal(replay.id, run.id);
    const { CODEX_CALLBACK_RECEIVER_SECRET: _secret, ...readEnv } = receiverEnv;
    const listed = await runCaptured(process.execPath, [path.join(projectRoot, "scripts/callback-inbox-example.mjs"), "--list"], { env: readEnv });
    assert.equal(listed.code, 0, listed.stderr);
    const inbox = JSON.parse(listed.stdout); assert.equal(inbox.items.length, 1); assert.deepEqual(inbox.items[0].event, event);
    const rpc = (await fs.readFile(capture, "utf8")).split("\n").filter(Boolean).map(JSON.parse);
    assert.equal(rpc.filter(call => call.method === "turn/start").length, 1, "redelivery/replay/readback never repeat inference");
    const traces = (await fs.readFile(transportTrace, "utf8")).split("\n").filter(Boolean).map(JSON.parse);
    assert.equal(traces.length, 2); assert.ok(traces.every(item => item.checkedAddress === "8.8.8.8" && item.tlsVerified));
    const usage = await jsonRequest(origin, `/api/clients/usage?clientId=${clientId}`, { headers: admin });
    assert.equal(usage.response.status, 200); assert.equal(usage.data.runs.filter(item => item.id === run.id).length, 1);
    console.log(JSON.stringify({ callbackRoundtrip: { ok: true, senderRestarted: true, runId: run.id, eventId: event.id,
      receiverRows: inbox.items.length, receiverCodes: receipts.map(item => item.code), attempts: delivered.callbackDelivery.attempts,
      redeliveryDelayMs: receipts[1].receivedAt - receipts[0].receivedAt, bodySha256: crypto.createHash("sha256").update(receipts[0].body).digest("hex"),
      backendTurnStarts: rpc.filter(call => call.method === "turn/start").length, simulatedCodex: true, realModelTurns: 0,
      tlsHostnameRejected: true, stableEvent: receipts[1].body === receipts[0].body, reportSha256: artifact.sha256 } }));
  } finally {
    await stopProcess(server); heldResponse?.destroy();
    tls?.closeAllConnections(); if (tls?.listening) await new Promise(resolve => tls.close(resolve));
    await stopProcess(receiver); await fs.rm(root, { recursive: true, force: true });
  }
});

await check("durable API queue survives lost responses and restart without repeating claimed work", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-durable-api-"));
  const cloudRoot = path.join(root, "cloud"), stateRoot = path.join(root, "state"), bin = path.join(root, "bin");
  const repo = path.join(cloudRoot, "workspace/sample-app"), capture = path.join(root, "requests.ndjson");
  for (const directory of [repo, stateRoot, bin]) await fs.mkdir(directory, { recursive: true });
  await initializeGitFixture(repo);
  const fake = await writeFakeCodex(root);
  await fs.writeFile(path.join(bin, "codex"), `#!/bin/sh\nexec "${process.execPath}" "${fake}"\n`, { mode: 0o755 });
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const headers = { "content-type": "application/json", "x-codex-cloud-token": "durable-fixture-token-123456" };
  const start = () => spawn(process.execPath, [path.join(projectRoot, "server/index.mjs")], { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"], env: {
    ...process.env, NODE_ENV: "production", HOST: "127.0.0.1", PORT: String(port), CODEX_CLOUD_ROOT: cloudRoot,
    CODEX_STATE_ROOT: stateRoot, CODEX_HOME: path.join(root, ".codex"), CODEX_AUTOMATION_RECOVERY_ENABLED: "0", CODEX_ALLOW_LOCAL_FALLBACK: "0",
    CODEX_CLOUD_WEBHOOK_TOKEN: headers["x-codex-cloud-token"], CODEX_AUTOMATION_MAX_CONCURRENT: "1", CODEX_AUTOMATION_MAX_CONCURRENT_PER_CLIENT: "1",
    CODEX_AUTOMATION_MAX_QUEUED: "2", CODEX_AUTOMATION_TRIGGER_RATE_MAX: "100", FAKE_CAPTURE_PATH: capture, PATH: `${bin}:${process.env.PATH}`,
    FAKE_HOLD_QUEUE_FIRST: "1", FAKE_QUEUE_NEXT_DELAY_MS: "3000",
  } });
  const queuedMaterial = { name: "排队材料.md", mimeType: "text/markdown", dataBase64: Buffer.from("重启后仍需保留的材料 42。\n$not-a-skill @/not-a-file").toString("base64") };
  const queuedPdf = pdfAttachment({ text: "PDF QUEUED RESTART 42" });
  const submit = (key, prompt, auth = headers) => jsonRequest(base, "/api/automations/sample-research/webhook", {
    method: "POST", headers: { ...auth, "idempotency-key": key }, body: JSON.stringify({ prompt, ...(auth === headers ? { worktree: false } : {}),
      ...(prompt.includes("durable-fourth") ? { attachments: [queuedMaterial, queuedPdf] } : {}) }),
  });
  const wait = async (callback, diagnostics) => {
    const deadline = Date.now() + 7000;
    while (Date.now() < deadline) { const value = await callback(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 250)); }
    throw new Error("Durable API fixture did not reach expected state" + (diagnostics ? ": " + JSON.stringify(diagnostics()) : ""));
  };
  const rpc = async () => (await fs.readFile(capture, "utf8").catch(() => "")).split("\n").filter(Boolean).map(JSON.parse).filter((row) => row.method === "turn/start");
  let server;
  try {
    server = start(); await waitForOutput(server, /listening on/);
    const lock = path.join(cloudRoot, "locks/console-release.lock");
    await fs.mkdir(path.dirname(lock), { recursive: true });
    await fs.writeFile(path.join(bin, "flock"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    await fs.writeFile(lock, "");
    const maintenance = await submit("durable-maintenance-0000", "must-not-start during publication");
    assert.equal(maintenance.response.status, 503);
    assert.equal(Number(maintenance.response.headers.get("retry-after")), 5);
    assert.equal((await rpc()).length, 0);
    await fs.rm(lock);
    const firstBody = JSON.stringify({ prompt: "progress regression queue first durable-one", worktree: false });
    const lost = await fetch(base + "/api/automations/sample-research/webhook", { method: "POST", headers: { ...headers, "idempotency-key": "durable-lost-response-0001" }, body: firstBody });
    assert.equal(lost.status, 200); await lost.body.cancel();
    const first = await submit("durable-lost-response-0001", "progress regression queue first durable-one");
    assert.equal(first.data.deduplicated, true);
    await wait(async () => (await rpc()).length === 1);
    const burstClient = await jsonRequest(base, "/api/clients", { method: "POST", headers, body: JSON.stringify({ name: "same-key-concurrency", automationIds: ["sample-research"] }) });
    assert.equal(burstClient.response.status, 201);
    const burstAuth = { "content-type": "application/json", "x-codex-cloud-token": burstClient.data.token };
    const burstSubmit = () => submit("durable-cancel-0002", "queue regression next must-not-start", burstAuth);
    const burst = await Promise.all(Array.from({ length: 100 }, burstSubmit));
    const accepted = burst.filter(result => result.response.status === 200);
    assert.ok(accepted.length > 0, "the concurrent burst must actually accept a task");
    assert.equal(accepted.filter(result => !result.data.deduplicated).length, 1, "only one concurrent submission may create a run");
    const second = accepted[0];
    if (accepted.length < burst.length) await new Promise(resolve => setTimeout(resolve, 1000));
    for (const result of burst) {
      if (result.response.status === 200) {
        assert.equal(result.data.run.id, second.data.run.id);
        continue;
      }
      assert.equal(result.response.status, 429);
      assert.equal(result.data.code, "input_buffer_busy");
      assert.equal(result.response.headers.get("retry-after"), "1");
      const retried = await burstSubmit();
      assert.equal(retried.response.status, 200);
      assert.equal(retried.data.deduplicated, true);
      assert.equal(retried.data.run.id, second.data.run.id);
    }
    const burstDb = new DatabaseSync(path.join(stateRoot, "run-usage.sqlite"), { readOnly: true });
    try {
      assert.equal(burstDb.prepare("SELECT count(*) AS n FROM external_tasks WHERE json_extract(record,'$.clientId')=?").get(burstClient.data.client.id).n, 1);
      assert.equal(burstDb.prepare("SELECT count(*) AS n FROM external_task_keys WHERE run_id=?").get(second.data.run.id).n, 1);
    } finally { burstDb.close(); }
    assert.equal(second.data.run.status, "queued");
    const client = await jsonRequest(base, "/api/clients", { method: "POST", headers, body: JSON.stringify({ name: "queued-to-revoke", automationIds: ["sample-research"] }) });
    const scoped = { "content-type": "application/json", "x-codex-cloud-token": client.data.token };
    const third = await submit("durable-revoke-0003", "queue regression next revoked-must-not-start", scoped);
    assert.equal(third.data.run.status, "queued");
    const full = await submit("durable-queue-0004", "queue regression next durable-fourth");
    assert.equal(full.response.status, 429);
    assert.ok(Number(full.response.headers.get("retry-after")) > 0);
    const wrongCancel = await jsonRequest(base, second.data.run.resultPath + "/cancel", { method: "POST", headers });
    assert.equal(wrongCancel.response.status, 404, "another client cannot cancel the accepted burst task");
    const canceled = await jsonRequest(base, second.data.run.resultPath + "/cancel", { method: "POST", headers: burstAuth });
    assert.equal(canceled.response.status, 200);
    assert.equal(canceled.data.run.status, "canceled");
    assert.equal(canceled.data.run.usage.totalTokens, 0);
    const fourth = await submit("durable-queue-0004", "queue regression next durable-fourth");
    assert.equal(fourth.response.status, 200);
    await jsonRequest(base, `/api/clients/${client.data.client.id}/revoke`, { method: "POST", headers });
    // Cross the fake first turn's old timer to expose an incorrectly assumed queued state.
    await new Promise(resolve => setTimeout(resolve, 2800));
    const inspect = new DatabaseSync(path.join(stateRoot, "run-usage.sqlite"), { readOnly: true });
    let fourthState;
    try { fourthState = inspect.prepare("SELECT state FROM external_tasks WHERE id=?").get(fourth.data.run.id).state; }
    finally { inspect.close(); }
    const beforeRestart = { firstStatus: (await jsonRequest(base, first.data.run.resultPath, { headers })).data.run.status,
      fourthStatus: (await jsonRequest(base, fourth.data.run.resultPath, { headers })).data.run.status, fourthState, starts: (await rpc()).length };
    assert.deepEqual(beforeRestart, { firstStatus: "running", fourthStatus: "queued", fourthState: "queued", starts: 1 },
      "restart fixture must keep the fourth task unclaimed, not merely display queued during material processing");
    await stopProcess(server);
    const queuedLedger = openRunUsageLedger(path.join(stateRoot, "run-usage.sqlite"));
    try {
      const row = queuedLedger.database.prepare("SELECT * FROM external_tasks WHERE id=?").get(fourth.data.run.id);
      const execution = JSON.parse(row.execution);
      assert.deepEqual(execution.options.attachments, [queuedMaterial, queuedPdf]);
      assert.equal(row.record.includes(queuedMaterial.dataBase64), false);
      execution.options.attachments[0].dataBase64 = Buffer.from("tampered input").toString("base64");
      execution.options.triggerIdempotencyHash = null; execution.options.triggerRequestHash = null;
      createExternalTaskStore(queuedLedger.database).accept({ run: { ...JSON.parse(row.record), id: "tampered-input", triggerIdempotencyHash: null, triggerRequestHash: null }, execution, ttlMs: 60000 });
    } finally { queuedLedger.close(); }
    server = start(); await waitForOutput(server, /listening on/);
    let observed, resultPolls = 0;
    const recoveryStartedAt = Date.now();
    const completed = await wait(async () => {
      const result = await jsonRequest(base, fourth.data.run.resultPath, { headers });
      observed = { ...observed, http: result.response.status, retryAfter: result.response.headers.get("retry-after"), polls: ++resultPolls, elapsedMs: Date.now() - recoveryStartedAt,
        ...(result.data.run ? { status: result.data.run.status, inputProcessing: result.data.run.inputProcessing, error: result.data.run.error } : {}), beforeRestart };
      assert.equal(result.response.status, 200, "recovery observation failed: " + JSON.stringify(observed));
      assert.ok(!["failed", "canceled", "interrupted", "needs_reconciliation"].includes(result.data.run?.status), "unclaimed work did not recover: " + JSON.stringify(observed));
      return result.data.run?.status === "completed" ? result.data.run : null;
    }, () => observed);
    assert.ok(resultPolls < 60, "one bounded recovery check must remain within the actual result polling limit");
    assert.equal(completed.id, fourth.data.run.id);
    const replay = await submit("durable-lost-response-0001", "progress regression queue first durable-one");
    assert.equal(replay.data.run.id, first.data.run.id);
    assert.equal(replay.data.run.status, "needs_reconciliation");
    const conflicts = await submit("durable-lost-response-0001", "changed input");
    assert.equal(conflicts.response.status, 409);
    const burstReplay = await burstSubmit();
    assert.equal(burstReplay.response.status, 200);
    assert.equal(burstReplay.data.deduplicated, true);
    assert.equal(burstReplay.data.run.id, second.data.run.id);
    assert.equal(burstReplay.data.run.status, "canceled");
    assert.equal(burstReplay.data.run.usage.totalTokens, 0);
    const burstConflict = await submit("durable-cancel-0002", "changed concurrent input must-not-start", burstAuth);
    assert.equal(burstConflict.response.status, 409);
    const burstUsage = await jsonRequest(base, `/api/clients/usage?clientId=${burstClient.data.client.id}`, { headers });
    assert.equal(burstUsage.response.status, 200);
    assert.equal(burstUsage.data.runs.length, 1);
    assert.equal(burstUsage.data.runs[0].id, second.data.run.id);
    assert.equal(burstUsage.data.runs[0].usage.totalTokens, 0);
    const requests = await rpc();
    assert.equal(requests.filter((row) => JSON.stringify(row.params).includes("durable-one")).length, 1);
    assert.equal(requests.filter((row) => JSON.stringify(row.params).includes("durable-fourth")).length, 1);
    const resumed = requests.find(row => JSON.stringify(row.params).includes("durable-fourth"));
    assert.equal(resumed.params.input[0].text.includes("重启后仍需保留的材料"), false);
    assert.ok(resumed.params.input.some(item => item.type === "text" && item.text.includes("重启后仍需保留的材料")));
    assert.ok(resumed.params.input.some(item => item.type === "text" && item.text.includes("PDF QUEUED RESTART 42")));
    assert.equal(resumed.params.input.filter(item => item.type === "image").length, 1);
    assert.equal(completed.inputProcessing.status, "ready");
    assert.equal(resumed.params.input.some(item => ["skill", "mention"].includes(item.type)), false);
    assert.equal(requests.some((row) => JSON.stringify(row.params).includes("must-not-start")), false);
    const stored = JSON.parse(await fs.readFile(path.join(stateRoot, "automation-runs.json"), "utf8")).runs;
    assert.equal(stored.find((run) => run.id === third.data.run.id).status, "failed");
    assert.equal(stored.find((run) => run.id === third.data.run.id).usage.totalTokens, 0);
    const tampered = await wait(async () => {
      const result = await jsonRequest(base, "/api/automations/sample-research/runs/tampered-input", { headers });
      assert.equal(result.response.status, 200, "tampered input observation must remain within the result polling limit");
      return result.data.run?.status === "failed" ? result.data.run : null;
    });
    assert.equal(tampered.usage.totalTokens, 0);
    assert.equal(tampered.delivery.status, "failed");
    assert.match(tampered.error, /材料与执行副本不一致/);
    const checked = openRunUsageLedger(path.join(stateRoot, "run-usage.sqlite"));
    try {
      assert.equal(checked.database.prepare("SELECT execution FROM external_tasks WHERE id=?").get(fourth.data.run.id).execution, "{}");
      assert.equal(checked.database.prepare("SELECT execution FROM external_tasks WHERE id='tampered-input'").get().execution, "{}");
      assert.equal(checked.database.prepare("SELECT count(*) AS n FROM external_tasks WHERE json_extract(record,'$.clientId')=?").get(burstClient.data.client.id).n, 1);
      assert.equal(checked.database.prepare("SELECT count(*) AS n FROM external_task_keys WHERE run_id=?").get(second.data.run.id).n, 1);
    } finally { checked.close(); }
    console.log(JSON.stringify({ sameKeyConcurrency: { ok: true, initialRequests: burst.length, successfulResponses: accepted.length,
      busyResponses: burst.length - accepted.length, retries: burst.length - accepted.length, acceptedRuns: 1, durableKeys: 1,
      restartedStatus: burstReplay.data.run.status, nativeStartsForRun: 0, totalTokens: burstUsage.data.runs[0].usage.totalTokens } }));
  } finally { await stopProcess(server); await fs.rm(root, { recursive: true, force: true }); }
});

await check("cancel retries before and after the start receipt never repeat interruption or invent a stopped result", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-cancel-once-"));
  const cloudRoot = path.join(root, "cloud"), stateRoot = path.join(root, "state"), bin = path.join(root, "bin");
  const repo = path.join(cloudRoot, "workspace/sample-app"), capture = path.join(root, "requests.ndjson");
  for (const dir of [repo, stateRoot, bin]) await fs.mkdir(dir, { recursive: true });
  await initializeGitFixture(repo);
  const fake = await writeFakeCodex(root);
  await fs.writeFile(path.join(bin, "codex"), `#!/bin/sh\nexec "${process.execPath}" "${fake}"\n`, { mode: 0o755 });
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const headers = { "content-type": "application/json", "x-codex-cloud-token": "cancel-once-fixture-token-123456" };
  const child = spawn(process.execPath, [path.join(projectRoot, "server/index.mjs")], { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"], env: {
    ...process.env, NODE_ENV: "production", HOST: "127.0.0.1", PORT: String(port), CODEX_CLOUD_ROOT: cloudRoot, CODEX_STATE_ROOT: stateRoot,
    CODEX_HOME: path.join(root, ".codex"), CODEX_AUTOMATION_RECOVERY_ENABLED: "0", CODEX_ALLOW_LOCAL_FALLBACK: "0", CODEX_CLOUD_WEBHOOK_TOKEN: headers["x-codex-cloud-token"],
    FAKE_CAPTURE_PATH: capture, FAKE_CANCEL_GATES: "1", PATH: `${bin}:${process.env.PATH}`,
  } });
  const wait = async callback => {
    const deadline = Date.now() + 7000;
    while (Date.now() < deadline) { const value = await callback(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
    throw new Error("Cancellation fixture did not reach its explicit gate");
  };
  const rpc = async () => (await fs.readFile(capture, "utf8").catch(() => "")).split("\n").filter(Boolean).map(JSON.parse);
  try {
    await waitForOutput(child, /listening on/);
    const client = await jsonRequest(base, "/api/clients", { method: "POST", headers, body: JSON.stringify({ name: "cancellation owner", automationIds: ["sample-research"] }) });
    const other = await jsonRequest(base, "/api/clients", { method: "POST", headers, body: JSON.stringify({ name: "other caller", automationIds: ["sample-research"] }) });
    assert.equal(client.response.status, 201); assert.equal(other.response.status, 201);
    const auth = { ...headers, "x-codex-cloud-token": client.data.token };
    let reviewSessionId;
    for (const [index, mode] of ["hold start receipt", "interrupt uncertain"].entries()) {
      const start = await jsonRequest(base, "/api/automations/sample-research/webhook", { method: "POST", headers: { ...auth, "idempotency-key": `cancel-once-event-${index}` }, body: JSON.stringify({ prompt: `cancel regression ${mode}` }) });
      assert.equal(start.response.status, 200);
      const route = start.data.run.resultPath;
      const before = await wait(async () => {
        const result = await jsonRequest(base, route, { headers: auth });
        assert.equal(result.response.status, 200);
        return result.data.run.status === "running" && (await rpc()).some(item => item.method === "turn/start" && JSON.stringify(item.params).includes(mode)) ? result.data.run : null;
      });
      const previousInterrupts = (await rpc()).filter(item => item.method === "turn/interrupt").length;
      const interrupts = async () => (await rpc()).filter(item => item.method === "turn/interrupt").slice(previousInterrupts);
      assert.equal((await jsonRequest(base, route + "/cancel", { method: "POST", headers: { ...headers, "x-codex-cloud-token": other.data.token } })).response.status, 404);
      assert.equal((await jsonRequest(base, route + "/cancel", { method: "POST" })).response.status, 401);
      const cancel = () => jsonRequest(base, route + "/cancel", { method: "POST", headers: auth });
      const first = await cancel();
      assert.equal(first.response.status, 202); assert.equal(first.data.run.status, "canceling");
      const db = new DatabaseSync(path.join(stateRoot, "run-usage.sqlite"), { readOnly: true });
      let sessionId;
      try { sessionId = JSON.parse(db.prepare("SELECT record FROM external_tasks WHERE id=?").get(before.id).record).sessionId; }
      finally { db.close(); }
      assert.ok(sessionId);
      reviewSessionId = sessionId;
      const consoleStop = () => jsonRequest(base, "/api/codex/turn-interrupt", { method: "POST", headers,
        body: JSON.stringify({ repoId: "sample-app", sessionId }) });
      if (index === 0) {
        const earlyStop = await consoleStop();
        assert.equal(earlyStop.response.status, 202); assert.equal(earlyStop.data.pending, true);
        assert.equal((await interrupts()).length, 0, "未绑定回合编号时不能向猜测的回合发送中断");
        await fs.writeFile(capture + ".cancel-start-release", "release synthetic receipt");
      }
      const sent = await wait(async () => (await interrupts())[0]);
      for (let repeat = 0; repeat < 3; repeat++) {
        const result = await cancel();
        assert.equal(result.response.status, 202); assert.equal(result.data.run.status, "canceling");
        assert.equal(result.data.run.cancelRequestedAt, first.data.run.cancelRequestedAt);
      }
      const concurrent = await Promise.all([cancel(), cancel()]);
      for (const result of concurrent) {
        assert.equal(result.response.status, 202); assert.equal(result.data.run.status, "canceling");
        assert.equal(result.data.run.cancelRequestedAt, first.data.run.cancelRequestedAt);
      }
      const webStop = await consoleStop();
      assert.equal(webStop.response.status, index === 0 ? 202 : 500);
      if (index === 0) assert.equal(webStop.data.pending, true);
      assert.equal((await interrupts()).length, 1, "原生停止回执尚未到达时，重复取消不能重复发送中断");
      if (index === 1) await wait(async () => {
        const result = await jsonRequest(base, route, { headers: auth });
        return result.data.events?.some(event => event.type === "cancel-warning");
      });
      const pending = await jsonRequest(base, route, { headers: auth });
      assert.equal(pending.data.run.status, "canceling"); assert.equal(pending.data.run.finishedAt, null);
      assert.equal(pending.data.events.filter(event => event.type === "cancel-requested").length, 1);
      assert.equal(pending.data.events.filter(event => event.type === "cancel-warning").length, index);
      await fs.writeFile(capture + ".cancel-completion-" + sent.params.turnId, "release synthetic stop");
      const stopped = await wait(async () => {
        const result = await jsonRequest(base, route, { headers: auth });
        return result.data.run.status === "canceled" ? result.data.run : null;
      });
      assert.equal(stopped.id, before.id); assert.equal(stopped.usage.status, "unknown");
      assert.equal((await cancel()).response.status, 200);
      assert.equal((await interrupts()).length, 1);
    }
    for (const delivery of ["inline", "detached"]) {
      const previousInterrupts = (await rpc()).filter(item => item.method === "turn/interrupt").length;
      const interrupts = async () => (await rpc()).filter(item => item.method === "turn/interrupt").slice(previousInterrupts);
      const review = await fetch(base + "/api/codex/review/stream", { method: "POST", headers,
        body: JSON.stringify({ repoId: "sample-app", sessionId: reviewSessionId, delivery }), signal: AbortSignal.timeout(15000) });
      const started = await wait(async () => (await rpc()).find(item => item.method === "review/start" && item.params.delivery === delivery));
      const stop = () => jsonRequest(base, "/api/codex/turn-interrupt", { method: "POST", headers,
        body: JSON.stringify({ repoId: "sample-app", sessionId: reviewSessionId }) });
      const early = await stop();
      assert.equal(early.response.status, 202); assert.equal(early.data.pending, true);
      assert.equal((await interrupts()).length, 0);
      await fs.writeFile(capture + ".review-start-release-" + delivery, "release synthetic review receipt");
      const sent = await wait(async () => (await interrupts())[0]);
      assert.equal(sent.params.threadId, delivery === "detached" ? "detached-" + sent.params.turnId : started.params.threadId);
      for (const result of await Promise.all([stop(), stop()])) {
        assert.equal(result.response.status, 202); assert.equal(result.data.pending, true);
      }
      assert.equal((await interrupts()).length, 1);
      await fs.writeFile(capture + ".cancel-completion-" + sent.params.turnId, "release synthetic review stop");
      const events = await review.text();
      assert.match(events, /event: done/); assert.match(events, /"ok":false/); assert.doesNotMatch(events, /"ok":true/);
    }
    assert.equal((await rpc()).filter(item => item.method === "turn/start").length, 2, "重复取消不能创建新模型回合");
    assert.equal((await rpc()).filter(item => item.method === "review/start").length, 2);
  } finally { await stopProcess(child); await fs.rm(root, { recursive: true, force: true }); }
});

await check("old turn notifications and approvals cannot complete, charge or corrupt a new API heartbeat before or after its start receipt", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-turn-ownership-"));
  const cloudRoot = path.join(root, "cloud"), stateRoot = path.join(root, "state"), bin = path.join(root, "bin");
  const repo = path.join(cloudRoot, "workspace/sample-app"), capture = path.join(root, "requests.ndjson");
  for (const dir of [repo, stateRoot, bin]) await fs.mkdir(dir, { recursive: true });
  await initializeGitFixture(repo);
  const fake = await writeFakeCodex(root);
  await fs.writeFile(path.join(bin, "codex"), `#!/bin/sh\nexec "${process.execPath}" "${fake}"\n`, { mode: 0o755 });
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const headers = { "content-type": "application/json", "x-codex-cloud-token": "ownership-fixture-token-123456" };
  const server = spawn(process.execPath, [path.join(projectRoot, "server/index.mjs")], { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"], env: {
    ...process.env, NODE_ENV: "production", HOST: "127.0.0.1", PORT: String(port), CODEX_CLOUD_ROOT: cloudRoot, CODEX_STATE_ROOT: stateRoot,
    CODEX_HOME: path.join(root, ".codex"), CODEX_AUTOMATION_RECOVERY_ENABLED: "0", CODEX_ALLOW_LOCAL_FALLBACK: "0", CODEX_CLOUD_WEBHOOK_TOKEN: headers["x-codex-cloud-token"],
    FAKE_CAPTURE_PATH: capture, FAKE_TURN_OWNERSHIP: "1", PATH: `${bin}:${process.env.PATH}`,
  } });
  const wait = async callback => {
    const deadline = Date.now() + 7000;
    while (Date.now() < deadline) { const value = await callback(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 30)); }
    throw new Error("Turn ownership fixture timed out");
  };
  const rpc = async () => (await fs.readFile(capture, "utf8").catch(() => "")).split("\n").filter(Boolean).map(JSON.parse);
  try {
    await waitForOutput(server, /listening on/);
    const client = await jsonRequest(base, "/api/clients", { method: "POST", headers, body: JSON.stringify({ name: "ownership fixture", automationIds: ["sample-research"] }) });
    const auth = { ...headers, "x-codex-cloud-token": client.data.token };
    const submit = (key, prompt, trigger = "heartbeat") => jsonRequest(base, `/api/automations/sample-research/${trigger}`, { method: "POST", headers: { ...auth, "idempotency-key": key }, body: JSON.stringify({ prompt }) });
    const read = async run => {
      await new Promise(resolve => setTimeout(resolve, 1000));
      const result = await jsonRequest(base, run.resultPath, { headers: auth });
      assert.equal(result.response.status, 200, String(result.data.error || "Result polling failed"));
      return result.data.run;
    };
    const completed = run => wait(async () => { const value = await read(run); return value.status === "completed" ? value : null; });
    const first = await submit("owned-first-0001", "first ownership", "webhook");
    const one = await completed(first.data.run); assert.equal(one.usage.totalTokens, 130);
    for (const [index, prompt] of ["held ownership", "early ownership", "preflight ownership"].entries()) {
      if (prompt.startsWith("preflight")) await fs.writeFile(capture + ".preflight", "inject");
      const next = await submit("owned-next-000" + (index + 2), prompt);
      assert.equal(next.response.status, 200);
      await wait(async () => (await rpc()).filter(row => row.method === "turn/start").length === index + 2);
      if (prompt.startsWith("held")) {
        await new Promise(resolve => setTimeout(resolve, 200));
        assert.equal((await read(next.data.run)).status, "running", "old completion must not terminate the new turn");
        const approvals = await jsonRequest(base, "/api/approvals", { headers });
        assert.equal(approvals.data.pending.length, 0, "stale permissions must never enter human approval");
        await fs.writeFile(capture + ".release", "finish");
      }
      const done = await completed(next.data.run);
      assert.equal(done.usage.totalTokens, 130); assert.equal(done.summary, "owned output");
      assert.equal((await rpc()).filter(row => row.method === "turn/start").length, index + 2, "no alternate thread or model replay");
    }
    const requests = await rpc();
    const stale = requests.filter(row => String(row.id).startsWith("stale-approval-") && !row.method);
    assert.equal(stale.length, 3); assert.equal(stale.every(row => row.result?.decision === "decline" || row.error), true);
    const orphan = await submit("owned-orphan-0005", "orphan ownership");
    const orphanApproval = await wait(async () => { const value = await jsonRequest(base, "/api/approvals", { headers }); return value.data.pending.find(item => item.params.command === "synthetic-orphan"); });
    await fs.writeFile(capture + ".orphan-release", "finish");
    assert.equal((await completed(orphan.data.run)).usage.totalTokens, 130);
    assert.equal((await jsonRequest(base, "/api/approvals", { headers })).data.pending.length, 0);
    const expired = await jsonRequest(base, `/api/approvals/${orphanApproval.id}/decision`, { method: "POST", headers, body: JSON.stringify({ decision: "accept", digest: orphanApproval.digest }) });
    assert.equal(expired.response.status, 410);
    const approval = await submit("owned-approval-0006", "early approval ownership");
    const pending = await wait(async () => { const value = await jsonRequest(base, "/api/approvals", { headers }); return value.data.pending.find(item => String(item.params.command) === "synthetic-only"); });
    assert.equal(pending.owner.repoId, "sample-app");
    const accepted = await jsonRequest(base, `/api/approvals/${pending.id}/decision`, { method: "POST", headers, body: JSON.stringify({ decision: "accept", digest: pending.digest }) });
    assert.equal(accepted.response.status, 200);
    assert.equal((await completed(approval.data.run)).usage.totalTokens, 130);
    const sessionId = JSON.parse(await fs.readFile(path.join(stateRoot, "automation-runs.json"), "utf8")).runs.find(run => run.id === approval.data.run.id).sessionId;
    let compactSettled = false;
    const compact = jsonRequest(base, "/api/codex/thread-compact", { method: "POST", headers, body: JSON.stringify({ repoId: "sample-app", sessionId }) }).then(result => { compactSettled = true; return result; });
    await wait(async () => (await rpc()).some(row => row.method === "thread/compact/start"));
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(compactSettled, false, "old turn completion must not finish a new compaction");
    await fs.writeFile(capture + ".compact-release", "finish");
    assert.equal((await compact).response.status, 200);
    await fs.writeFile(capture + ".compact-fail", "failed");
    assert.equal((await jsonRequest(base, "/api/codex/thread-compact", { method: "POST", headers, body: JSON.stringify({ repoId: "sample-app", sessionId }) })).response.status, 500);
    for (const delivery of ["inline", "detached"]) {
      const review = await fetch(base + "/api/codex/review/stream", { method: "POST", headers, body: JSON.stringify({ repoId: "sample-app", sessionId, delivery }), signal: AbortSignal.timeout(5000) });
      const events = await review.text();
      assert.match(events, /owned review/); assert.match(events, /"ok":true/);
    }
    const uncertain = await submit("owned-uncertain-0007", "uncertain ownership");
    const unknown = await wait(async () => { const run = await read(uncertain.data.run); return run.status === "needs_reconciliation" ? run : null; });
    assert.equal(unknown.usage.status, "unknown");
    assert.equal((await submit("owned-uncertain-0007", "uncertain ownership")).data.run.id, unknown.id);
    const multi = await submit("owned-multi-usage-0008", "multi usage ownership", "webhook");
    const multiDone = await completed(multi.data.run);
    assert.equal(multiDone.usage.totalTokens, 260);
    assert.equal(multiDone.usage.source, "app-server:turn-counter-delta");
    const delegated = await submit("owned-delegated-usage-0009", "delegated usage ownership", "webhook");
    const delegatedDone = await completed(delegated.data.run);
    assert.equal(delegatedDone.usage.status, "unknown");
    assert.match(delegatedDone.usage.reason, /独立协作/);
    const usageDetails = await jsonRequest(base, "/api/clients/usage", { headers });
    assert.equal(usageDetails.response.status, 200);
    assert.match(usageDetails.data.runs.find(run => run.id === delegatedDone.id).usage.reason, /独立协作/);
  } finally { await stopProcess(server); await fs.rm(root, { recursive: true, force: true }); }
});

await check("operator execution policy is pinned through API acceptance, continuation and restart and refuses unsafe native runtime before inference", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-api-profile-"));
  const cloudRoot = path.join(root, "cloud"), stateRoot = path.join(root, "state"), bin = path.join(root, "bin");
  const repo = path.join(cloudRoot, "workspace/sample-app"), capture = path.join(root, "requests.ndjson");
  for (const directory of [repo, stateRoot, bin]) await fs.mkdir(directory, { recursive: true });
  await initializeGitFixture(repo);
  const fake = await writeFakeCodex(root);
  await fs.writeFile(path.join(bin, "codex"), `#!/bin/sh\nexec "${process.execPath}" "${fake}"\n`, { mode: 0o755 });
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const headers = { "content-type": "application/json", "x-codex-cloud-token": "profile-fixture-token-123456" };
  const profile = "workspace-restricted-v1";
  let apiHeaders = headers;
  const automation = { id: "restricted", name: "Restricted fixture", repoId: "sample-app", mode: "on-demand", prompt: "model api regression", model: "gpt-6-sol", reasoning: "medium", executionProfile: profile };
  const start = (executionProfile = profile) => spawn(process.execPath, [path.join(projectRoot, "server/index.mjs")], { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"], env: {
    ...process.env, NODE_ENV: "production", HOST: "127.0.0.1", PORT: String(port), CODEX_CLOUD_ROOT: cloudRoot, CODEX_STATE_ROOT: stateRoot,
    CODEX_HOME: path.join(root, ".codex"), CODEX_AUTOMATION_RECOVERY_ENABLED: "0", CODEX_ALLOW_LOCAL_FALLBACK: "0", CODEX_CLOUD_WEBHOOK_TOKEN: headers["x-codex-cloud-token"],
    CODEX_AUTOMATION_MAX_CONCURRENT: "1", CODEX_AUTOMATION_MAX_CONCURRENT_PER_CLIENT: "1", CODEX_AUTOMATION_TRIGGER_RATE_MAX: "100", FAKE_CAPTURE_PATH: capture,
    CODEX_CLOUD_AUTOMATIONS_CONFIG_B64: Buffer.from(JSON.stringify([{ ...automation, executionProfile }])).toString("base64"), FAKE_EXECUTION_PROFILE: "1", FAKE_HOLD_QUEUE_FIRST: "1", PATH: `${bin}:${process.env.PATH}`,
  } });
  const submit = (key, prompt, extra = {}, trigger = "webhook") => jsonRequest(base, `/api/automations/restricted/${trigger}`, {
    method: "POST", headers: { ...apiHeaders, "idempotency-key": key }, body: JSON.stringify({ prompt, ...extra }),
  });
  const wait = async callback => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) { const value = await callback(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 40)); }
    throw new Error("Execution profile fixture timed out");
  };
  const terminal = run => wait(async () => {
    await new Promise(resolve => setTimeout(resolve, 1000));
    const { response, data } = await jsonRequest(base, run.resultPath, { headers: apiHeaders });
    assert.equal(response.status, 200, "profile result observation must not exhaust result queries");
    return ["completed", "failed"].includes(data.run?.status) ? data.run : null;
  });
  const rpc = async () => (await fs.readFile(capture, "utf8").catch(() => "")).split("\n").filter(Boolean).map(JSON.parse);
  let server;
  try {
    server = start(); await waitForOutput(server, /listening on/);
    const client = await jsonRequest(base, "/api/clients", { method: "POST", headers, body: JSON.stringify({ name: "profile-only-fixture", automationIds: ["restricted"] }) });
    assert.equal(client.response.status, 201);
    apiHeaders = { ...headers, "x-codex-cloud-token": client.data.token };
    const caps = await jsonRequest(base, "/api/automations/restricted/v1/capabilities", { headers: apiHeaders });
    assert.equal(caps.data.execution.profile, profile); assert.equal(caps.data.features.image_output.supported, false);
    for (const extra of [{ worktree: false }, { executionProfile: null }, { sandbox: "danger-full-access" }]) assert.equal((await submit("profile-invalid-0001", "must-not-start", extra)).response.status, 400);
    for (const [route, body] of [["images/generations", { prompt: "generated output" }], ["responses", { input: "generated output", tools: [{ type: "image_generation" }] }]]) {
      const result = await jsonRequest(base, `/api/automations/restricted/v1/${route}`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + client.data.token, "idempotency-key": "profile-image-0001" }, body: JSON.stringify({ model: "gpt-6-sol", ...body }) });
      assert.equal(result.response.status, 400); assert.match(result.data.error.message, /受限自动化/);
    }
    assert.equal((await rpc()).filter(row => row.method === "turn/start").length, 0);
    const first = await submit("profile-success-0001", "model api regression restricted first", { model: "gpt-6-astra", reasoning: "ultra", search: true });
    assert.equal(first.response.status, 200);
    const done = await terminal(first.data.run); assert.equal(done.status, "completed"); assert.equal(done.execution.profile, profile);
    const replay = await submit("profile-success-0001", "model api regression restricted first", { model: "gpt-6-astra", reasoning: "ultra", search: true });
    assert.equal(replay.data.run.id, done.id);
    const continued = await submit("profile-heartbeat-0002", "model api regression restricted continued", {}, "heartbeat");
    assert.equal((await terminal(continued.data.run)).status, "completed");
    let requests = await rpc();
    const turn = requests.find(row => row.method === "turn/start");
    assert.equal(turn.params.model, "gpt-6-astra"); assert.equal(turn.params.effort, "ultra");
    assert.deepEqual(turn.params.sandboxPolicy, { type: "workspaceWrite", writableRoots: [turn.params.cwd], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true });
    assert.equal(turn.params.approvalPolicy, "never");
    assert.ok(requests.some(row => row.method === "thread/resume" && row.params.config?.mcp_servers?.fixture?.enabled === false));
    const beforeUnsafe = requests.filter(row => row.method === "turn/start").length;
    await fs.writeFile(capture + ".unsafe-mcp", "unsafe");
    const unsafe = await submit("profile-unsafe-0003", "must-not-start unsafe connector");
    const rejected = await terminal(unsafe.data.run);
    assert.equal(rejected.status, "failed"); assert.equal(rejected.usage.totalTokens, 0); assert.equal(rejected.usage.source, "not-started");
    assert.equal((await rpc()).filter(row => row.method === "turn/start").length, beforeUnsafe);
    await fs.rm(capture + ".unsafe-mcp");
    const approval = await submit("profile-approval-0004", "model api regression profile approval denied");
    const declined = await terminal(approval.data.run);
    assert.equal(declined.status, "failed"); assert.match(declined.error, /额外权限/);
    assert.ok((await rpc()).some(row => row.id === "profile-request-extra" && row.result?.decision === "decline"));
    const holding = await submit("profile-holding-0005", "progress regression queue first held");
    await wait(async () => (await rpc()).some(row => row.method === "turn/start" && JSON.stringify(row.params).includes("queue first held")));
    const restored = await submit("profile-restored-0006", "model api regression same profile after restart");
    assert.equal(restored.data.run.status, "queued");
    await stopProcess(server);
    server = start(); await waitForOutput(server, /listening on/);
    assert.equal((await terminal(restored.data.run)).status, "completed");
    assert.equal((await jsonRequest(base, holding.data.run.resultPath, { headers: apiHeaders })).data.run.status, "needs_reconciliation");
    await submit("profile-holding-0007", "progress regression queue first held again");
    await wait(async () => (await rpc()).some(row => row.method === "turn/start" && JSON.stringify(row.params).includes("held again")));
    const queued = await submit("profile-change-0008", "model api regression must-not-start after config change");
    assert.equal(queued.data.run.status, "queued");
    await stopProcess(server);
    const ledger = openRunUsageLedger(path.join(stateRoot, "run-usage.sqlite"));
    try {
      const row = ledger.database.prepare("SELECT record,execution FROM external_tasks WHERE id=?").get(queued.data.run.id);
      assert.equal(JSON.parse(row.record).executionProfile, profile); assert.equal(JSON.parse(row.execution).options.executionProfile, profile);
    } finally { ledger.close(); }
    server = start(null); await waitForOutput(server, /listening on/);
    const changed = await terminal(queued.data.run);
    assert.equal(changed.status, "failed"); assert.equal(changed.usage.totalTokens, 0); assert.match(changed.error, /执行策略/);
    assert.equal((await submit("profile-success-0001", "model api regression restricted first", { model: "gpt-6-astra", reasoning: "ultra", search: true })).data.run.id, done.id);
    assert.equal((await jsonRequest(base, holding.data.run.resultPath, { headers: apiHeaders })).data.run.status, "needs_reconciliation");
    requests = await rpc();
    assert.equal(requests.some(row => row.method === "turn/start" && JSON.stringify(row.params).includes("after config change")), false);
    const policyMismatch = await submit("profile-mismatch-0009", "must-not-start legacy heartbeat", {}, "heartbeat");
    assert.equal(policyMismatch.response.status, 409);
  } finally { await stopProcess(server); await fs.rm(root, { recursive: true, force: true }); }
});

await check("independent clients retrieve private exact-turn files and images after native history and process restart", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-result-delivery-"));
  const cloudRoot = path.join(root, "cloud"), stateRoot = path.join(root, "state"), bin = path.join(root, "bin");
  const repo = path.join(cloudRoot, "workspace/sample-app"), capture = path.join(root, "requests.ndjson");
  for (const dir of [repo, stateRoot, bin]) await fs.mkdir(dir, { recursive: true });
  await initializeGitFixture(repo);
  await fs.symlink("README.md", path.join(repo, "unsafe.md"));
  for (const args of [["-C", repo, "add", "unsafe.md"], ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "Unsafe file fixture"]]) {
    const result = await runCaptured("git", args); assert.equal(result.code, 0, result.stderr);
  }
  const fake = await writeFakeCodex(root);
  await fs.writeFile(path.join(bin, "codex"), `#!/bin/sh\nexec "${process.execPath}" "${fake}"\n`, { mode: 0o755 });
  const port = await freePort(), origin = `http://127.0.0.1:${port}`;
  const admin = { "content-type": "application/json", "x-codex-cloud-token": "result-fixture-admin-123456" };
  const start = () => spawn(process.execPath, [path.join(projectRoot, "server/index.mjs")], { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"], env: {
    ...process.env, NODE_ENV: "production", HOST: "127.0.0.1", PORT: String(port), CODEX_CLOUD_ROOT: cloudRoot, CODEX_STATE_ROOT: stateRoot,
    CODEX_HOME: path.join(root, ".codex"), CODEX_AUTOMATION_RECOVERY_ENABLED: "0", CODEX_ALLOW_LOCAL_FALLBACK: "0", CODEX_AUTOMATION_TRIGGER_RATE_MAX: "100",
    CODEX_CLOUD_WEBHOOK_TOKEN: admin["x-codex-cloud-token"], FAKE_CAPTURE_PATH: capture, PATH: `${bin}:${process.env.PATH}`,
  } });
  let server;
  try {
    server = start(); await waitForOutput(server, /listening on/);
    const client = await jsonRequest(origin, "/api/clients", { method: "POST", headers: admin, body: JSON.stringify({ name: "file-client", automationIds: ["sample-research"] }) });
    const other = await jsonRequest(origin, "/api/clients", { method: "POST", headers: admin, body: JSON.stringify({ name: "other-client", automationIds: ["sample-research"] }) });
    const token = client.data.token, headers = { "content-type": "application/json", authorization: `Bearer ${token}` };
    const schema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false };
    const materialText = "外部调用材料 42。\n$not-a-skill @/not-a-file";
    const material = { name: "材料.md", mimeType: "text/markdown", dataBase64: Buffer.from(materialText).toString("base64") };
    const inputImage = { name: "image.png", mimeType: "image/png", dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC" };
    const inputPdf = pdfAttachment({ text: "PDF CLIENT MATERIAL 42" });
    const input = { prompt: "model api regression artifact delivery fixture generated output", model: "gpt-6-sol", outputSchema: schema, artifactPaths: ["results/report.md"], attachments: [material, inputImage, inputPdf] };
    const options = { automationId: "sample-research", origin, token, timeoutMs: 10000, requestTimeoutMs: 3000 };
    const lost = await fetch(origin + "/api/automations/sample-research/webhook", { method: "POST", headers: { ...headers, "idempotency-key": "file-delivery-0001" }, body: JSON.stringify({ runner: "app-server", worktree: true, ...input }) });
    assert.equal(lost.status, 200); await lost.body.cancel();
    const run = await runExternalClient({ ...options, command: "submit", eventId: "file-delivery-0001", input, wait: true });
    assert.equal(run.status, "completed", JSON.stringify(run));
    assert.equal(run.delivery.status, "ready");
    assert.equal(run.inputFiles.length, 3);
    assert.equal(run.inputProcessing.status, "ready");
    assert.equal(JSON.stringify(run).includes(material.dataBase64), false);
    assert.equal(JSON.stringify(run).includes(materialText), false);
    const manifest = await runExternalClient({ ...options, command: "output", runId: run.id });
    assert.equal(manifest.structuredOutput.data.answer, "结构化验收通过");
    assert.equal(manifest.artifacts.length, 2);
    assert.equal(manifest.text, JSON.stringify(manifest.structuredOutput.data));
    const report = manifest.artifacts.find(file => file.name === "report.md");
    const file = await runExternalClient({ ...options, command: "download", runId: run.id, fileId: report.id });
    assert.equal(file.buffer.toString(), "verified artifact delivery\n");
    const cross = await fetch(origin + report.downloadPath, { headers: { authorization: `Bearer ${other.data.token}` } });
    assert.equal(cross.status, 404);
    const conflict = await jsonRequest(origin, "/api/automations/sample-research/webhook", { method: "POST", headers: { ...headers, "idempotency-key": "file-delivery-0001" }, body: JSON.stringify({ ...input, artifactPaths: ["different.md"] }) });
    assert.equal(conflict.response.status, 409);
    const changedInput = await jsonRequest(origin, "/api/automations/sample-research/webhook", { method: "POST", headers: { ...headers, "idempotency-key": "file-delivery-0001" },
      body: JSON.stringify({ ...input, attachments: [{ ...material, dataBase64: Buffer.from("changed").toString("base64") }, inputImage, inputPdf] }) });
    assert.equal(changedInput.response.status, 409);
    const internalRun = JSON.parse(await fs.readFile(path.join(stateRoot, "automation-runs.json"), "utf8")).runs.find(item => item.id === run.id);
    await fs.unlink(path.join(internalRun.worktreePath, "results/report.md"));
    const imageBody = { model: "gpt-6-sol", prompt: "model api regression generated output", response_format: "b64_json" };
    const imageOptions = { method: "POST", headers: { ...headers, "idempotency-key": "file-images-0002" }, body: JSON.stringify(imageBody) };
    const image = await jsonRequest(origin, "/api/automations/sample-research/v1/images/generations", imageOptions);
    assert.equal(image.response.status, 200, JSON.stringify(image.data));
    assert.equal(image.data.data[0].revised_prompt, "图片输出验收");
    await stopProcess(server);
    server = start(); await waitForOutput(server, /listening on/);
    const restored = await runExternalClient({ ...options, command: "download", runId: run.id, fileId: report.id });
    assert.deepEqual(restored.buffer, file.buffer);
    const python = await runCaptured("python3", [path.join(projectRoot, "scripts/external-client-example.py"), "download", "sample-research", run.id,
      "--file-id", report.id, "--output", path.join(root, "downloaded.md")], { env: { ...process.env, CODEX_CLOUD_URL: origin, CODEX_CLOUD_API_TOKEN: token } });
    assert.equal(python.code, 0, python.stderr);
    assert.equal(await fs.readFile(path.join(root, "downloaded.md"), "utf8"), file.buffer.toString());
    const replay = await jsonRequest(origin, "/api/automations/sample-research/v1/images/generations", imageOptions);
    assert.equal(replay.response.status, 200, JSON.stringify(replay.data));
    assert.equal(replay.data.data[0].b64_json, image.data.data[0].b64_json);
    const mcp = new McpClient({ name: "console-mcp-acceptance", version: "1.0.0" });
    const crossMcp = new McpClient({ name: "console-mcp-cross-scope", version: "1.0.0" });
    const mcpTransport = value => new StdioClientTransport({ command: process.execPath, args: [path.join(projectRoot, "scripts/codex-cloud-mcp.mjs")], stderr: "pipe",
      env: { CODEX_CLOUD_URL: origin, CODEX_CLOUD_API_TOKEN: value, CODEX_CLOUD_AUTOMATION_ID: "sample-research", CODEX_CLOUD_MCP_ALLOW_EXECUTION: "1" } });
    const mcpCall = async (client, name, args) => {
      const response = await client.callTool({ name: `codex_cloud_${name}`, arguments: args });
      return { error: response.isError, data: response.structuredContent || JSON.parse(response.content[0].text) };
    };
    try {
      await mcp.connect(mcpTransport(token));
      assert.equal((await mcp.listTools()).tools.length, 7);
      const mcpReplay = await mcpCall(mcp, "submit", { eventId: "file-delivery-0001", input });
      assert.equal(mcpReplay.error, undefined, JSON.stringify(mcpReplay));
      assert.equal(mcpReplay.data.run.id, run.id, "MCP reuses the API's durable idempotency record");
      assert.equal((await mcpCall(mcp, "status", { runId: run.id })).data.run.status, "completed");
      const mcpOutput = await mcpCall(mcp, "output", { runId: run.id });
      assert.equal(mcpOutput.data.content, manifest.text);
      const mcpFile = await mcpCall(mcp, "read_artifact", { runId: run.id, fileId: report.id });
      assert.equal(mcpFile.data.artifact.sha256, report.sha256);
      assert.deepEqual(Buffer.from(mcpFile.data.dataBase64, "base64"), file.buffer);
      const imageArtifact = manifest.artifacts.find(file => file.mimeType === "image/png");
      const mcpImage = await mcp.callTool({ name: "codex_cloud_read_artifact", arguments: { runId: run.id, fileId: imageArtifact.id, asImage: true } });
      assert(mcpImage.content.some(item => item.type === "image" && item.data));
      await crossMcp.connect(mcpTransport(other.data.token));
      const denied = await mcpCall(crossMcp, "output", { runId: run.id });
      assert.equal(denied.error, true); assert.equal(denied.data.httpStatus, 404);
    } finally { await mcp.close(); await crossMcp.close(); }
    if (process.env.CODEX_MCP_NATIVE_CLI_BINARY) {
      const nativeCross = await jsonRequest(origin, "/api/clients", { method: "POST", headers: admin,
        body: JSON.stringify({ name: "native-mcp-cross-scope", automationIds: ["sample-research"] }) });
      assert.equal(nativeCross.response.status, 201);
      const runsBefore = await fs.readFile(path.join(stateRoot, "automation-runs.json"));
      const native = await verifyNativeMcpReadback({ root, projectRoot, origin, token, run, manifest, report, reportBytes: file.buffer,
        crossToken: nativeCross.data.token, revokeCross: async () => {
          const revoked = await jsonRequest(origin, `/api/clients/${nativeCross.data.client.id}/revoke`, { method: "POST", headers: admin });
          assert.equal(revoked.response.status, 200);
        } });
      assert.deepEqual(await fs.readFile(path.join(stateRoot, "automation-runs.json")), runsBefore, "Native MCP reads do not change tasks");
      console.log(JSON.stringify({ nativeMcp: native }));
    }
    const rpc = (await fs.readFile(capture, "utf8")).split("\n").filter(Boolean).map(JSON.parse);
    assert.equal(rpc.filter(call => call.method === "turn/start").length, 2, "reads and restarts must not repeat inference");
    assert.equal(rpc.filter(call => call.method === "thread/read" && call.params.includeTurns).length, 2, "stored delivery does not reread erased native history");
    const firstInput = rpc.find(call => call.method === "turn/start").params.input;
    assert.equal(firstInput[0].text.includes(materialText), false);
    assert.ok(firstInput.some(item => item.type === "text" && item.text.includes("外部调用材料 42")));
    assert.ok(firstInput.some(item => item.type === "image" && item.url === `data:image/png;base64,${inputImage.dataBase64}`));
    assert.ok(firstInput.some(item => item.type === "text" && item.text.includes("PDF CLIENT MATERIAL 42")));
    assert.equal(firstInput.filter(item => item.type === "image").length, 2);
    assert.equal(firstInput.some(item => ["skill", "mention"].includes(item.type)), false);
    const route = origin + "/api/automations/sample-research/webhook";
    const unauthenticated = await fetch(route, { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
    assert.equal(unauthenticated.status, 401, "authenticate before parsing invalid payloads");
    const wrongType = await fetch(route, { method: "POST", headers: { ...headers, "content-type": "text/plain", "idempotency-key": "must-not-start-0006" }, body: JSON.stringify({ prompt: "must not start" }) });
    assert.equal(wrongType.status, 415);
    const oversized = await fetch(route, { method: "POST", headers: { ...headers, "idempotency-key": "must-not-start-0007" }, body: JSON.stringify({ prompt: "x".repeat(12 * 1024 * 1024) }) });
    assert.equal(oversized.status, 413);
    assert.equal((await fs.readFile(capture, "utf8")).split("\n").filter(Boolean).map(JSON.parse).filter(call => call.method === "turn/start").length, 2);
    const badPdf = await jsonRequest(origin, "/api/automations/sample-research/v1/responses", { method: "POST", headers: { ...headers, "idempotency-key": "pdf-invalid-0001" },
      body: JSON.stringify({ model: "gpt-6-sol", input: [{ role: "user", content: [{ type: "input_text", text: "must not start" },
        { type: "input_file", filename: "broken.pdf", file_data: "data:application/pdf;base64," + Buffer.from("%PDF-1.7\nPRIVATE PDF CONTENT").toString("base64") }] }] }) });
    assert.equal(badPdf.response.status, 422, JSON.stringify(badPdf.data));
    assert.equal(badPdf.data.error.code, "pdf_parse_failed");
    const badRun = await jsonRequest(origin, badPdf.response.headers.get("x-codex-cloud-result-path"), { headers });
    assert.equal(badRun.data.run.inputProcessing.status, "failed");
    assert.equal(badRun.data.run.usage.totalTokens, 0);
    assert.equal(badRun.data.run.delivery.status, "failed");
    assert.equal(JSON.stringify(badRun.data).includes("PRIVATE PDF CONTENT"), false);
    assert.equal((await fs.readFile(capture, "utf8")).split("\n").filter(Boolean).map(JSON.parse).filter(call => call.method === "turn/start").length, 2);
    const waitClaimed = async (accepted, auth) => {
      const db = new DatabaseSync(path.join(stateRoot, "run-usage.sqlite"), { readOnly: true });
      try {
        for (let attempt = 0; attempt < 100; attempt++) {
          const row = db.prepare("SELECT record FROM external_tasks WHERE id=?").get(accepted.id);
          if (row && JSON.parse(row.record).executionStartedAt) {
            const result = await jsonRequest(origin, accepted.resultPath, { headers: auth });
            assert.equal(result.response.status, 200, "PDF phase observation must not exhaust result queries");
            assert.ok(result.data.run.executionStartedAt);
            assert.equal(result.data.run.inputProcessing, undefined, "the test must act while PDF conversion is still pending");
            return;
          }
          await new Promise(resolve => setTimeout(resolve, 5));
        }
      } finally { db.close(); }
      throw new Error("PDF task was not claimed");
    };
    const canceledPdf = await runExternalClient({ ...options, command: "submit", eventId: "pdf-cancel-0002", input: { prompt: "must not start", attachments: [inputPdf] } });
    await waitClaimed(canceledPdf, headers);
    await jsonRequest(origin, canceledPdf.resultPath + "/cancel", { method: "POST", headers });
    const canceledPdfFinal = await runExternalClient({ ...options, command: "status", runId: canceledPdf.id, wait: true });
    assert.equal(canceledPdfFinal.status, "canceled");
    assert.equal(canceledPdfFinal.usage.totalTokens, 0);
    const otherAuth = { "content-type": "application/json", authorization: `Bearer ${other.data.token}` };
    const revokedPdf = await runExternalClient({ ...options, token: other.data.token, command: "submit", eventId: "pdf-revoke-0003", input: { prompt: "must not start", attachments: [inputPdf] } });
    await waitClaimed(revokedPdf, otherAuth);
    await jsonRequest(origin, `/api/clients/${other.data.client.id}/revoke`, { method: "POST", headers: admin });
    let revokedFinal;
    for (let attempt = 0; attempt < 100; attempt++) {
      revokedFinal = (await jsonRequest(origin, "/api/automations/runs", { headers: admin })).data.runs.find(item => item.id === revokedPdf.id);
      if (revokedFinal?.status === "failed") break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(revokedFinal.status, "failed");
    assert.equal(revokedFinal.inputProcessing.status, "ready", "revocation is rechecked after conversion");
    assert.equal(revokedFinal.usage.totalTokens, 0);
    assert.match(revokedFinal.error, /调用方已撤销/);
    assert.equal((await fs.readFile(capture, "utf8")).split("\n").filter(Boolean).map(JSON.parse).filter(call => call.method === "turn/start").length, 2);
    for (const [key, artifactPaths] of [["file-unchanged-0003", ["README.md"]], ["file-missing-0004", ["results/missing.md"]]]) {
      const failed = await runExternalClient({ ...options, command: "submit", eventId: key,
        input: { prompt: "model api regression artifact delivery fixture", artifactPaths }, wait: true });
      assert.equal(failed.status, "failed");
      assert.equal(failed.delivery.status, "failed");
      assert.ok(["artifact_not_generated", "file_not_found"].includes(failed.delivery.error.code));
    }
    const callsBefore = (await fs.readFile(capture, "utf8")).split("\n").filter(Boolean).map(JSON.parse).filter(call => call.method === "turn/start").length;
    const unsafe = await runExternalClient({ ...options, command: "submit", eventId: "file-unsafe-0005",
      input: { prompt: "must not start a model for an unsafe baseline", artifactPaths: ["unsafe.md"] }, wait: true });
    assert.equal(unsafe.status, "failed");
    assert.equal(unsafe.usage.totalTokens, 0);
    assert.equal(unsafe.delivery.status, "failed");
    assert.equal(unsafe.usage.status, "complete");
    assert.equal((await fs.readFile(capture, "utf8")).split("\n").filter(Boolean).map(JSON.parse).filter(call => call.method === "turn/start").length, callsBefore);
    await stopProcess(server);
    const ledger = openRunUsageLedger(path.join(stateRoot, "run-usage.sqlite"));
    let seedClock = Date.now() - 500;
    const tasks = createExternalTaskStore(ledger.database, { now: () => seedClock++ });
    try {
      for (let index = 0; index < 250; index++) {
        tasks.accept({ run: { id: `seed-${index}`, clientId: "synthetic-list-client", automationId: "sample-research", repoId: "sample-app", status: "queued",
          startedAt: new Date(seedClock).toISOString(), prompt: "private seed context".repeat(200) }, execution: {}, ttlMs: 60000 });
        const owned = tasks.claim({ owner: "seed" });
        tasks.update({ ...owned.run, sessionId: "seed-session", status: "completed", model: "gpt-6-sol",
          usage: { status: "complete", source: "synthetic", inputTokens: 2, outputTokens: 1, totalTokens: 3 } }, owned.claim);
      }
      assert.equal(ledger.database.prepare("SELECT count(*) AS n FROM usage_runs WHERE id LIKE 'seed-%'").get().n, 0);
    } finally { ledger.close(); }
    server = start(); await waitForOutput(server, /listening on/);
    const list = await jsonRequest(origin, "/api/automations/runs", { headers: admin });
    assert.equal(list.response.status, 200);
    assert.ok(list.data.runs.length <= 200, "global list is a bounded projection, not all retained full records");
    assert.equal(list.data.runs.some(item => item.id === run.id), false);
    const old = await runExternalClient({ ...options, command: "status", runId: run.id });
    assert.equal(old.status, "completed");
    assert.deepEqual((await runExternalClient({ ...options, command: "download", runId: run.id, fileId: report.id })).buffer, file.buffer);
    const checked = openRunUsageLedger(path.join(stateRoot, "run-usage.sqlite"));
    try {
      assert.equal(checked.database.prepare("SELECT count(*) AS n FROM usage_runs WHERE id LIKE 'seed-%'").get().n, 250);
      assert.equal(checked.rows({ from: 0, to: Date.now() + 1000 }).filter(item => item.id.startsWith("seed-")).reduce((sum, item) => sum + item.usage.totalTokens, 0), 750);
    } finally { checked.close(); }
  } finally { await stopProcess(server); await fs.rm(root, { recursive: true, force: true }); }
});

await check("usage API retains accounting across history pruning and restart; corrupt ledgers block execution", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-ledger-api-"));
  const cloudRoot = path.join(root, "cloud"), stateRoot = path.join(root, "state"), binDir = path.join(root, "bin");
  for (const directory of [stateRoot, binDir, path.join(cloudRoot, "workspace", "sample-app")]) await fs.mkdir(directory, { recursive: true });
  const fake = await writeFakeCodex(root);
  await fs.writeFile(path.join(binDir, "codex"), `#!/bin/sh\nexec "${process.execPath}" "${fake}"\n`, { mode: 0o755 });
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const startedAt = new Date(Date.now() - 86400000).toISOString();
  const runs = Array.from({ length: 450 }, (_, i) => ({
    id: `accounting-${i}`, automationId: "sample-research", repoId: "sample-app", runner: "app-server", clientId: "ledger-client",
    status: "completed", startedAt, updatedAt: startedAt, finishedAt: startedAt, threadId: "ledger-thread", turnId: `turn-${i}`,
    usage: { status: "complete", inputTokens: 100, outputTokens: 20, totalTokens: 120 }, prompt: "private accounting fixture",
  }));
  const source = path.join(stateRoot, "automation-runs.json");
  await fs.writeFile(source, JSON.stringify({ version: 1, runs }));
  const capturePath = path.join(root, "requests.ndjson");
  const startServer = () => spawn(process.execPath, [path.join(projectRoot, "server/index.mjs")], {
    cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"], env: {
      ...process.env, NODE_ENV: "production", HOST: "127.0.0.1", PORT: String(port),
      CODEX_CLOUD_ROOT: cloudRoot, CODEX_STATE_ROOT: stateRoot, CODEX_HOME: path.join(root, ".codex"),
      CODEX_CLOUD_WEBHOOK_TOKEN: "ledger-test-token-123456", CODEX_AUTOMATION_RECOVERY_ENABLED: "0", CODEX_ALLOW_LOCAL_FALLBACK: "0",
      FAKE_CAPTURE_PATH: capturePath, PATH: `${binDir}:${process.env.PATH}`,
    },
  });
  const headers = { "x-codex-cloud-token": "ledger-test-token-123456" };
  let server;
  try {
    server = startServer(); await waitForOutput(server, /listening on/);
    const first = await jsonRequest(base, "/api/clients/usage", { headers });
    assert.equal(first.response.status, 200);
    assert.equal(first.data.runBuckets.reduce((sum, row) => sum + row.totalTokens, 0), 54000);
    assert.equal(JSON.stringify(first.data).includes("private accounting fixture"), false);
    assert.equal(first.data.usageLedger.rows, 450);
    assert.equal(first.data.runs.length, 200);
    assert.equal(first.data.runSummary.tasks, 450);
    assert.equal(first.data.runSummary.observedModelTurns, 450);
    assert.equal(first.data.runSummary.successRate, 1);
    assert.equal(first.data.runSummary.unknownUsageRate, 0);
    assert.equal(first.data.deliverySummary.tasks, 450);
    assert.equal(first.data.deliverySummary.results.untracked, 450);
    assert.equal(first.data.deliverySummary.details.length, 200);
    assert.deepEqual(first.data.runSummary.execution, { samples: 0, p50Ms: null, p95Ms: null });
    assert.deepEqual(first.data.requestSummary.groups, []);
    await stopProcess(server);
    await fs.writeFile(source, JSON.stringify({ version: 1, runs: runs.slice(0, 200) }));
    server = startServer(); await waitForOutput(server, /listening on/);
    const after = await jsonRequest(base, "/api/clients/usage", { headers });
    assert.equal(after.response.status, 200);
    assert.deepEqual(after.data.runBuckets, first.data.runBuckets);
    assert.deepEqual(after.data.runSummary, first.data.runSummary);
    assert.deepEqual(after.data.deliverySummary.results, first.data.deliverySummary.results);
    const other = await jsonRequest(base, "/api/clients/usage?clientId=other", { headers });
    assert.deepEqual(other.data.runBuckets, []);
    assert.deepEqual(other.data.runs, []);
    assert.equal(other.data.runSummary.tasks, 0);
    assert.equal(other.data.runSummary.successRate, null);
    assert.equal(other.data.deliverySummary.tasks, 0);
    assert.deepEqual(other.data.deliverySummary.details, []);
    await stopProcess(server);
    for (const suffix of ["", "-wal", "-shm"]) {
      await fs.rename(path.join(stateRoot, `run-usage.sqlite${suffix}`), path.join(stateRoot, `saved.sqlite${suffix}`)).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    await fs.writeFile(path.join(stateRoot, "run-usage.sqlite"), "corrupt fixture");
    server = startServer(); await waitForOutput(server, /listening on/);
    assert.equal((await jsonRequest(base, "/api/clients/usage", { headers })).response.status, 500);
    const health = await jsonRequest(base, "/healthz", { headers });
    assert.equal(health.response.status, 503);
    assert.equal(health.data.layers.usageLedger.ok, false);
    const rejected = await jsonRequest(base, "/api/automations/sample-research/webhook", {
      method: "POST", headers: { ...headers, "content-type": "application/json", "idempotency-key": "ledger-unreadable-0001" },
      body: JSON.stringify({ prompt: "must not run", worktree: false }),
    });
    assert.equal(rejected.response.status, 500);
    const requests = await fs.readFile(capturePath, "utf8").catch(() => "");
    assert.equal(requests.includes('"method":"turn/start"'), false);
    assert.equal(JSON.parse(await fs.readFile(source, "utf8")).runs.length, 200);
  } finally { await stopProcess(server); await fs.rm(root, { recursive: true, force: true }); }
});

await check("app-server generations ignore stale exits", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-client-generation-"));
  const fakePath = await writeFakeCodex(tempRoot);
  const client = new CodexAppServerClient({
    cwd: tempRoot,
    command: process.execPath,
    args: [fakePath],
    env: { ...process.env, FAKE_TERM_DELAY_MS: "650" },
    initializeTimeoutMs: 2_000,
  });
  try {
    await client.request("ping", {}, 2_000);
    void client.stop();
    await client.ensureStarted();
    const result = await client.request("slow", {}, 1_800);
    assert.equal(result.ok, true);
    assert.equal(client.status().running, true);
    assert.equal(client.status().pending, 0);
  } finally {
    await client.stop({ waitForExit: true });
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

await check("app-server request timeout is an end-to-end budget", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-client-budget-"));
  const fakePath = await writeFakeCodex(tempRoot);
  const client = new CodexAppServerClient({
    cwd: tempRoot,
    command: process.execPath,
    args: [fakePath],
    env: { ...process.env, FAKE_INIT_DELAY_MS: "350" },
    initializeTimeoutMs: 2_000,
  });
  const startedAt = Date.now();
  try {
    await assert.rejects(() => client.request("slow", {}, 650), /timed out/i);
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed >= 550 && elapsed < 1_050, `request exceeded total budget: ${elapsed}ms`);
  } finally {
    await client.stop({ waitForExit: true });
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

await check("automation completion contracts fail closed without changing legacy runs", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-completion-contract-"));
  const fakePath = await writeFakeCodex(tempRoot);
  const binDir = path.join(tempRoot, "bin");
  const cloudRoot = path.join(tempRoot, "cloud");
  const workspaceRoot = path.join(cloudRoot, "workspace");
  const repoRoot = path.join(workspaceRoot, "sample-app");
  const stateRoot = path.join(tempRoot, "state");
  const codexHome = path.join(tempRoot, ".codex");
  const codexShim = path.join(binDir, "codex");
  const port = await freePort();
  const runsPath = path.join(stateRoot, "automation-runs.json");
  const passContract = { version: 1, type: "exact-final-line", marker: "CONTRACT_PASS_COMPLETE" };
  const missingContract = { version: 1, type: "exact-final-line", marker: "CONTRACT_MISSING_COMPLETE" };
  const artifactBody = "verified artifact\n";
  const artifactContract = {
    ...passContract,
    artifactPath: "results/report.md",
    artifactSha256: crypto.createHash("sha256").update(artifactBody).digest("hex"),
  };

  await fs.mkdir(repoRoot, { recursive: true });
  await fs.mkdir(stateRoot, { recursive: true });
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(codexShim, `#!/bin/sh\nexec "${process.execPath}" "${fakePath}"\n`, { mode: 0o755 });

  const childEnvironment = {
    ...process.env,
    NODE_ENV: "production",
    HOST: "127.0.0.1",
    PORT: String(port),
    CODEX_CLOUD_ROOT: cloudRoot,
    CODEX_WORKSPACE_ROOT: workspaceRoot,
    CODEX_STATE_ROOT: stateRoot,
    CODEX_HOME: codexHome,
    CODEX_CLOUD_WEBHOOK_TOKEN: "regression-token-123456",
    CODEX_ALLOW_LOCAL_FALLBACK: "0",
    CODEX_TURN_TIMEOUT_MS: "2500",
    CODEX_EXTERNAL_WRITE_TIMEOUT_MS: "120",
    CODEX_AUTOMATION_RECOVERY_ENABLED: "0",
    PATH: `${binDir}:${process.env.PATH}`,
  };
  const startServer = () => spawn(process.execPath, [path.join(projectRoot, "server", "index.mjs")], {
    cwd: projectRoot,
    env: childEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const trigger = (idempotencyKey, prompt, completionContract) => jsonRequest(
    `http://127.0.0.1:${port}/`,
    "/api/automations/sample-research/webhook",
    {
      method: "POST",
      headers: {
        "x-codex-cloud-token": "regression-token-123456",
        "idempotency-key": idempotencyKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({ prompt, worktree: false, ...(completionContract === undefined ? {} : { completionContract }) }),
    },
  );
  const waitForRun = async (runId, expectedStatus) => {
    let run = null;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const store = JSON.parse(await fs.readFile(runsPath, "utf8"));
      run = store.runs.find((item) => item.id === runId) || null;
      if (run?.status === expectedStatus) return run;
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    throw new Error(`run ${runId} did not reach ${expectedStatus}: ${JSON.stringify(run)}`);
  };

  let firstServer = startServer();
  let secondServer = null;
  try {
    await waitForOutput(firstServer, /listening on/i);

    const passedStart = await trigger("contract-pass-0001", "outcome contract regression pass with late event", passContract);
    assert.equal(passedStart.response.status, 200);
    assert.deepEqual(passedStart.data.run?.completionContract, passContract);
    const passedRun = await waitForRun(passedStart.data.run.id, "completed");
    assert.equal(passedRun.completionOutcome, "passed");
    assert.ok(passedRun.completionCheckedAt);
    assert.match(passedRun.summary, /CONTRACT_PASS_COMPLETE\s*$/);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const passedAfterLateEvents = (JSON.parse(await fs.readFile(runsPath, "utf8"))).runs.find((run) => run.id === passedRun.id);
    assert.equal(passedAfterLateEvents.status, "completed");
    assert.equal(passedAfterLateEvents.completionOutcome, "passed");

    await fs.mkdir(path.join(repoRoot, "results"), { recursive: true });
    await fs.writeFile(path.join(repoRoot, "results", "report.md"), artifactBody);
    const artifactPassed = await trigger("artifact-pass-0001", "outcome contract regression artifact pass", artifactContract);
    assert.equal(artifactPassed.response.status, 200);
    assert.equal((await waitForRun(artifactPassed.data.run.id, "completed")).completionOutcome, "passed");
    await fs.rm(path.join(repoRoot, "results", "report.md"));
    const artifactMissing = await trigger("artifact-missing-0001", "outcome contract regression artifact missing", artifactContract);
    assert.equal(artifactMissing.response.status, 200);
    assert.equal((await waitForRun(artifactMissing.data.run.id, "failed")).completionOutcome, "artifact-missing");
    await fs.writeFile(path.join(repoRoot, "results", "report.md"), "different content\n");
    const artifactMismatch = await trigger("artifact-mismatch-0001", "outcome contract regression artifact mismatch", artifactContract);
    assert.equal(artifactMismatch.response.status, 200);
    assert.equal((await waitForRun(artifactMismatch.data.run.id, "failed")).completionOutcome, "artifact-mismatch");
    await fs.rm(path.join(repoRoot, "results", "report.md"));
    await fs.symlink(path.join(tempRoot, "outside.md"), path.join(repoRoot, "results", "report.md"));
    await fs.writeFile(path.join(tempRoot, "outside.md"), artifactBody);
    const artifactEscape = await trigger("artifact-escape-0001", "outcome contract regression artifact escape", artifactContract);
    assert.equal(artifactEscape.response.status, 200);
    assert.equal((await waitForRun(artifactEscape.data.run.id, "failed")).completionOutcome, "artifact-missing");
    const invalidArtifactPath = await trigger("artifact-invalid-0001", "outcome contract regression artifact invalid", { ...passContract, artifactPath: "../outside.md" });
    assert.equal(invalidArtifactPath.response.status, 400);

    const changedContractReplay = await trigger(
      "contract-pass-0001",
      "outcome contract regression changed contract",
      { version: 1, type: "exact-final-line", marker: "CONTRACT_CHANGED_COMPLETE" },
    );
    assert.equal(changedContractReplay.response.status, 409);

    const missingStart = await trigger("contract-missing-0001", "outcome contract regression missing marker", missingContract);
    assert.equal(missingStart.response.status, 200);
    const missingRun = await waitForRun(missingStart.data.run.id, "failed");
    assert.equal(missingRun.completionOutcome, "missing");
    assert.match(missingRun.error, /完成契约未满足/);
    assert.match(missingRun.summary, /^CONTRACT_MISSING_COMPLETE/);
    assert.doesNotMatch(missingRun.summary, /CONTRACT_MISSING_COMPLETE\s*$/);
    const inbox = await jsonRequest(`http://127.0.0.1:${port}/`, "/api/automations/inbox");
    assert.equal(inbox.response.status, 200);
    assert.ok(inbox.data.needsAttention.some((run) => run.id === missingRun.id));

    const sameProcessReplay = await trigger("contract-missing-0001", "outcome contract regression missing marker", missingContract);
    assert.equal(sameProcessReplay.response.status, 200);
    assert.equal(sameProcessReplay.data.deduplicated, true);
    assert.equal(sameProcessReplay.data.run?.id, missingRun.id);
    assert.equal(sameProcessReplay.data.run?.status, "failed");

    const invalidContract = await trigger("contract-invalid-0001", "outcome contract regression invalid", {
      version: 1,
      type: "exact-final-line",
      marker: "CONTRACT_INVALID_COMPLETE",
      completionCommand: "touch /tmp/should-never-run",
    });
    assert.equal(invalidContract.response.status, 400);

    const externalWriteStart = await trigger("external-write-timeout-0001", "external write regression timeout");
    assert.equal(externalWriteStart.response.status, 200);
    const externalWriteRun = await waitForRun(externalWriteStart.data.run.id, "needs_reconciliation");
    assert.match(externalWriteRun.error, /勿直接重试/);
    const externalWriteSessions = JSON.parse(await fs.readFile(path.join(stateRoot, "chat-history.json"), "utf8")).sessions;
    assert.equal(externalWriteSessions[externalWriteRun.sessionId]?.externalActionReview?.automationRunId, externalWriteRun.id);
    assert.ok((await jsonRequest(`http://127.0.0.1:${port}/`, "/api/automations/inbox")).data.needsAttention.some((run) => run.id === externalWriteRun.id));

    await stopProcess(firstServer);
    firstServer = null;
    secondServer = startServer();
    await waitForOutput(secondServer, /listening on/i);

    const afterRestartReplay = await trigger("contract-missing-0001", "outcome contract regression missing marker", missingContract);
    assert.equal(afterRestartReplay.response.status, 200);
    assert.equal(afterRestartReplay.data.deduplicated, true);
    assert.equal(afterRestartReplay.data.run?.id, missingRun.id);
    assert.equal(afterRestartReplay.data.run?.status, "failed");
    const externalWriteReplay = await trigger("external-write-timeout-0001", "external write regression timeout");
    assert.equal(externalWriteReplay.data.deduplicated, true);
    assert.equal(externalWriteReplay.data.run?.id, externalWriteRun.id);
    assert.equal(externalWriteReplay.data.run?.status, "needs_reconciliation");

    const legacyStart = await trigger("contract-legacy-0001", "outcome contract regression legacy no contract", undefined);
    assert.equal(legacyStart.response.status, 200);
    const legacyRun = await waitForRun(legacyStart.data.run.id, "completed");
    assert.equal(legacyRun.completionContract, null);
    assert.equal(legacyRun.completionOutcome, null);
    assert.equal(legacyRun.error, null);

    const finalRuns = JSON.parse(await fs.readFile(runsPath, "utf8"));
    assert.equal(finalRuns.runs.filter((run) => run.triggerIdempotencyHash === missingRun.triggerIdempotencyHash).length, 1);
  } finally {
    await stopProcess(firstServer);
    await stopProcess(secondServer);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

await check("external automation interrupted by restart waits for reconciliation without repeating actions", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-automation-recovery-"));
  const fakePath = await writeFakeCodex(tempRoot);
  const binDir = path.join(tempRoot, "bin");
  const cloudRoot = path.join(tempRoot, "cloud");
  const workspaceRoot = path.join(cloudRoot, "workspace");
  const repoRoot = path.join(workspaceRoot, "sample-app");
  const stateRoot = path.join(tempRoot, "state");
  const codexHome = path.join(tempRoot, ".codex");
  const codexShim = path.join(binDir, "codex");
  const capturePath = path.join(tempRoot, "app-server-requests.jsonl");
  const originalWorktree = path.join(cloudRoot, "worktrees", "original-run");
  await fs.mkdir(originalWorktree, { recursive: true });
  const port = await freePort();
  const now = new Date();
  const old = new Date(now.getTime() - 2 * 60 * 60_000).toISOString();
  const recent = new Date(now.getTime() - 5_000).toISOString();
  const recoveryKey = "recovery-key-0001";
  const recoveryContract = { version: 1, type: "exact-final-line", marker: "RECOVERY_REGRESSION_COMPLETE" };
  const recoveryHash = crypto
    .createHash("sha256")
    .update(`sample-research:webhook:${recoveryKey}`)
    .digest("hex");
  const sessions = {
    "sess-recovery": {
      id: "sess-recovery",
      repoId: "sample-app",
      title: "Recovery regression",
      createdAt: recent,
      updatedAt: recent,
      messages: [],
      codexSessionId: "thread-recovery",
      model: "gpt-5.6-terra",
      reasoning: "high",
    },
    "sess-recovery-old": {
      id: "sess-recovery-old",
      repoId: "sample-app",
      title: "Old recovery regression",
      createdAt: old,
      updatedAt: old,
      messages: [],
      codexSessionId: "thread-recovery-old",
    },
    "sess-recovery-attempted": {
      id: "sess-recovery-attempted",
      repoId: "sample-app",
      title: "Bounded recovery regression",
      createdAt: recent,
      updatedAt: recent,
      messages: [],
      codexSessionId: "thread-recovery-attempted",
    },
    "sess-queue-waiting": {
      id: "sess-queue-waiting", repoId: "sample-app", title: "Queued before restart",
      createdAt: recent, updatedAt: recent, messages: [], codexSessionId: "thread-queue-waiting",
      queuedTurn: { id: "queue-waiting", message: "queue must wait after restart", status: "queued", createdAt: recent },
    },
    "sess-queue-dispatching": {
      id: "sess-queue-dispatching", repoId: "sample-app", title: "Started before restart",
      createdAt: recent, updatedAt: recent, messages: [], codexSessionId: "thread-queue-dispatching",
      queuedTurn: { id: "queue-dispatching", message: "queue may already have started", status: "dispatching", createdAt: recent },
    },
    "sess-external-draft": {
      id: "sess-external-draft", repoId: "sample-app", title: "External draft",
      createdAt: recent, updatedAt: recent, messages: [], codexSessionId: "thread-external-archive-draft",
      draft: { input: "preserve an unsent draft", attachments: [], revision: 1 },
    },
    "sess-external-queue": {
      id: "sess-external-queue", repoId: "sample-app", title: "External queue",
      createdAt: recent, updatedAt: recent, messages: [], codexSessionId: "thread-external-archive-queue",
      queuedTurn: { id: "queue-external", message: "do not resend after external archive", status: "queued", createdAt: recent },
    },
    "sess-archive-race": {
      id: "sess-archive-race", repoId: "sample-app", title: "Archive race",
      createdAt: recent, updatedAt: recent, messages: [], codexSessionId: "thread-archive-race",
    },
  };
  const sourceRuns = [
    {
      id: "run-recovery-source",
      automationId: "sample-research",
      repoId: "sample-app",
      name: "Sample research queue",
      trigger: "webhook",
      triggerIdempotencyHash: recoveryHash,
      runner: "app-server",
      status: "running",
      startedAt: recent,
      updatedAt: recent,
      finishedAt: null,
      threadId: "thread-recovery",
      sessionId: "sess-recovery",
      worktreePolicy: "detached-worktree",
      worktreePath: originalWorktree,
      model: "gpt-5.6-terra",
      reasoning: "high",
      prompt: "original recovery regression prompt",
      completionContract: recoveryContract,
      completionOutcome: "pending",
      events: [],
    },
    {
      id: "run-recovery-old",
      automationId: "sample-hourly",
      repoId: "sample-app",
      name: "Sample hourly analysis",
      trigger: "manual",
      runner: "app-server",
      status: "running",
      startedAt: old,
      updatedAt: old,
      threadId: "thread-recovery-old",
      sessionId: "sess-recovery-old",
      worktreePolicy: "repo-cwd",
      prompt: "old recovery regression prompt",
      events: [],
    },
    {
      id: "run-recovery-attempted",
      automationId: "sample-maintenance",
      repoId: "sample-app",
      name: "Sample repository maintenance",
      trigger: "manual",
      runner: "app-server",
      status: "running",
      startedAt: recent,
      updatedAt: recent,
      threadId: "thread-recovery-attempted",
      sessionId: "sess-recovery-attempted",
      worktreePolicy: "existing-thread",
      prompt: "bounded recovery regression prompt",
      recoveryOfRunId: "run-recovery-root",
      recoveryRootRunId: "run-recovery-root",
      recoveryAttempt: 1,
      events: [],
    },
  ];

  await fs.mkdir(repoRoot, { recursive: true });
  await fs.mkdir(stateRoot, { recursive: true });
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(codexShim, `#!/bin/sh\nexec "${process.execPath}" "${fakePath}"\n`, { mode: 0o755 });
  await fs.writeFile(
    path.join(stateRoot, "chat-history.json"),
    JSON.stringify({ version: 2, activeByRepo: {}, sessions }),
  );
  await fs.writeFile(
    path.join(stateRoot, "automation-runs.json"),
    JSON.stringify({ version: 1, runs: sourceRuns }),
  );

  const childEnvironment = {
    ...process.env,
    NODE_ENV: "production",
    HOST: "127.0.0.1",
    PORT: String(port),
    CODEX_CLOUD_ROOT: cloudRoot,
    CODEX_WORKSPACE_ROOT: workspaceRoot,
    CODEX_STATE_ROOT: stateRoot,
    CODEX_HOME: codexHome,
    CODEX_CLOUD_WEBHOOK_TOKEN: "regression-token-123456",
    CODEX_ALLOW_LOCAL_FALLBACK: "0",
    CODEX_TURN_TIMEOUT_MS: "1000",
    CODEX_AUTOMATION_RECOVERY_ENABLED: "1",
    CODEX_AUTOMATION_RECOVERY_MAX_AGE_MS: "60000",
    CODEX_AUTOMATION_RECOVERY_MAX_ATTEMPTS: "1",
    CODEX_AUTOMATION_RECOVERY_STARTUP_DELAY_MS: "500",
    FAKE_CAPTURE_PATH: capturePath,
    PATH: `${binDir}:${process.env.PATH}`,
  };
  const startServer = () => spawn(process.execPath, [path.join(projectRoot, "server", "index.mjs")], {
    cwd: projectRoot,
    env: childEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let firstServer = startServer();
  let secondServer = null;
  try {
    await waitForOutput(firstServer, /listening on/i);
    const startupReplay = await jsonRequest(`http://127.0.0.1:${port}/`, "/api/automations/sample-research/webhook", {
      method: "POST",
      headers: {
        "x-codex-cloud-token": "regression-token-123456",
        "idempotency-key": recoveryKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({ prompt: "startup retry must wait for recovery", worktree: false, completionContract: recoveryContract }),
    });
    assert.equal(startupReplay.response.status, 409);
    assert.match(startupReplay.data.error, /缺少请求摘要/);
    let storedRuns = [];
    await new Promise((resolve) => setTimeout(resolve, 300));
    storedRuns = JSON.parse(await fs.readFile(path.join(stateRoot, "automation-runs.json"), "utf8")).runs;
    const recoveredSource = storedRuns.find((run) => run.id === "run-recovery-source");
    assert.equal(recoveredSource.status, "needs_reconciliation");
    assert.equal(recoveredSource.interruptionKind, "console-restart");
    assert.equal(recoveredSource.recoveryRunId, null);
    assert.equal(storedRuns.some((run) => run.recoveryOfRunId === "run-recovery-source"), false);
    assert.equal(storedRuns.some((run) => run.recoveryOfRunId === "run-recovery-old"), false);
    assert.equal(storedRuns.some((run) => run.recoveryOfRunId === "run-recovery-attempted"), false);
    const recoveredQueues = JSON.parse(await fs.readFile(path.join(stateRoot, "chat-history.json"), "utf8")).sessions;
    assert.equal(recoveredQueues["sess-queue-waiting"].queuedTurn.status, "paused");
    assert.equal(recoveredQueues["sess-queue-dispatching"].queuedTurn.status, "needs_reconciliation");

    const inbox = await jsonRequest(`http://127.0.0.1:${port}/`, "/api/automations/inbox");
    assert.ok(inbox.data.needsAttention.some((run) => run.id === recoveredSource.id));

    const captured = (await fs.readFile(capturePath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(captured.some((request) => request.method === "thread/resume" && request.params?.threadId === "thread-recovery"), false);
    assert.equal(captured.some((request) => request.method === "thread/start"), false);
    assert.equal(captured.some((request) => request.method === "turn/start"), false);

    const replay = await jsonRequest(`http://127.0.0.1:${port}/`, "/api/automations/sample-research/webhook", {
      method: "POST",
      headers: {
        "x-codex-cloud-token": "regression-token-123456",
        "idempotency-key": recoveryKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({ prompt: "startup retry must wait for recovery", worktree: false, completionContract: recoveryContract }),
    });
    assert.equal(replay.response.status, 409);

    const conflictingReplay = await jsonRequest(`http://127.0.0.1:${port}/`, "/api/automations/sample-research/webhook", {
      method: "POST",
      headers: {
        "x-codex-cloud-token": "regression-token-123456",
        "idempotency-key": recoveryKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({ prompt: "different prompt", worktree: false, completionContract: recoveryContract }),
    });
    assert.equal(conflictingReplay.response.status, 409);

    await stopProcess(firstServer);
    firstServer = null;
    secondServer = startServer();
    await waitForOutput(secondServer, /listening on/i);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const afterSecondRestart = JSON.parse(await fs.readFile(path.join(stateRoot, "automation-runs.json"), "utf8")).runs;
    assert.equal(afterSecondRestart.filter((run) => run.recoveryOfRunId === "run-recovery-source").length, 0);
    assert.equal(afterSecondRestart.find((run) => run.id === "run-recovery-source")?.status, "needs_reconciliation");
    const queuesAfterSecondRestart = JSON.parse(await fs.readFile(path.join(stateRoot, "chat-history.json"), "utf8")).sessions;
    assert.equal(queuesAfterSecondRestart["sess-queue-waiting"].queuedTurn.status, "paused");
    assert.equal(queuesAfterSecondRestart["sess-queue-dispatching"].queuedTurn.status, "needs_reconciliation");
    for (const [sessionId, title] of [["sess-external-draft", "已归档草稿"], ["sess-external-queue", "待核对"]]) {
      const notified = await jsonRequest(`http://127.0.0.1:${port}/`, `/api/codex/thread-read?repoId=sample-app&sessionId=${sessionId}`);
      assert.equal(notified.response.status, 200);
      let migrated = null;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const current = JSON.parse(await fs.readFile(path.join(stateRoot, "chat-history.json"), "utf8")).sessions;
        migrated = Object.values(current).find((session) => session.title.startsWith(`${title}:`) && session.id !== sessionId);
        if (migrated) {
          assert.equal(current[sessionId], undefined);
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.ok(migrated, `${sessionId} was not preserved after external archive`);
      assert.equal(migrated.codexSessionId, null);
      if (sessionId === "sess-external-draft") assert.equal(migrated.draft.input, "preserve an unsent draft");
      else {
        assert.equal(migrated.queuedTurn.message, "do not resend after external archive");
        assert.equal(migrated.queuedTurn.status, "needs_reconciliation");
      }
    }
    const archiveRequest = jsonRequest(`http://127.0.0.1:${port}/`, "/api/codex/thread-archive", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoId: "sample-app", sessionId: "sess-archive-race" }),
    });
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const captured = await fs.readFile(capturePath, "utf8");
      if (captured.includes('"threadId":"thread-archive-race"')) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const duringArchive = await jsonRequest(`http://127.0.0.1:${port}/`, "/api/chat", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoId: "sample-app", sessionId: "sess-archive-race", message: "must not restart archived session" }),
    });
    assert.equal(duringArchive.response.status, 409);
    assert.equal((await archiveRequest).response.status, 200);
    assert.equal(JSON.parse(await fs.readFile(path.join(stateRoot, "chat-history.json"), "utf8")).sessions["sess-archive-race"], undefined);
  } finally {
    await stopProcess(firstServer);
    await stopProcess(secondServer);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

await check("calendar and mail sources are explicit, account-bound, durable and protected from cross-site requests and approvals", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-calendar-"));
  const fake = await writeFakeCodex(root), cloudRoot = path.join(root, "cloud"), stateRoot = path.join(root, "state"), bin = path.join(root, "bin");
  const capture = path.join(root, "requests.jsonl"), port = await freePort(), base = `http://127.0.0.1:${port}`;
  for (const dir of [path.join(cloudRoot, "workspace", "sample-app"), stateRoot, bin]) await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(bin, "codex"), `#!/bin/sh\nif [ "$1" = "login" ]; then echo "Logged in using ChatGPT"; exit 0; fi\nif [ "$1" = "--version" ]; then echo "fixture"; exit 0; fi\nexec "${process.execPath}" "${fake}"\n`, { mode: 0o755 });
  const headers = { "content-type": "application/json", "x-codex-cloud-token": "calendar-admin-test-only" };
  const env = { ...process.env, NODE_ENV: "production", HOST: "127.0.0.1", PORT: String(port), CODEX_CLOUD_ROOT: cloudRoot, CODEX_STATE_ROOT: stateRoot,
    CODEX_HOME: path.join(root, ".codex"), CODEX_PERSONAL_MODE: "shared", CODEX_PERSONAL_ROOT: path.join(cloudRoot, "personal"), CODEX_CLOUD_WEBHOOK_TOKEN: headers["x-codex-cloud-token"],
    CODEX_AUTOMATION_RECOVERY_ENABLED: "0", FAKE_CAPTURE_PATH: capture, PATH: `${bin}:${process.env.PATH}` };
  const start = () => spawn(process.execPath, [path.join(projectRoot, "server/index.mjs")], { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"], env });
  let child = start();
  try {
    await waitForOutput(child, /listening on/i);
    const crossSite = await jsonRequest(base, "/api/personal/calendar/refresh", { method: "POST", headers: { ...headers, origin: "https://untrusted.example.test" }, body: JSON.stringify({ timeZone: "UTC" }) });
    assert.equal(crossSite.response.status, 403);
    const initial = await jsonRequest(base, "/api/personal/calendar?timeZone=UTC", { headers });
    assert.equal(initial.response.status, 200); assert.equal(initial.data.calendar.snapshot, null);
    const captured = () => fs.readFile(capture, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; }).then(raw => raw.trim().split("\n").filter(Boolean).map(JSON.parse));
    assert.equal((await captured().catch(() => [])).filter(item => item.method === "mcpServer/tool/call").length, 0);
    const invalid = await jsonRequest(base, "/api/personal/calendar/refresh", { method: "POST", headers, body: JSON.stringify({ timeZone: "UTC", tool: "write" }) });
    assert.equal(invalid.response.status, 400);
    assert.equal((await jsonRequest(base, "/api/personal/mail?timeZone=UTC", { headers })).data.mail.snapshot, null);
    assert.equal((await jsonRequest(base, "/api/personal/mail?timeZone=UTC")).response.status, 200, "the trusted loopback backend is behind Caddy admin authentication, not a public token endpoint");
    const accountsRequest = { method: "POST", headers, body: "{}" };
    assert.equal((await jsonRequest(base, "/api/personal/mail/accounts", { ...accountsRequest, headers: { ...headers, origin: "https://untrusted.example.test" } })).response.status, 403);
    assert.equal((await jsonRequest(base, "/api/personal/mail/refresh", { ...accountsRequest, headers: { ...headers, "sec-fetch-site": "cross-site" } })).response.status, 403);
    assert.equal((await jsonRequest(base, "/api/personal/mail/accounts", accountsRequest)).data.accounts.length, 2);
    assert.equal((await captured()).filter(item => item.method === "mcpServer/tool/call").length, 0, "mail account discovery never reads data");
    for (const body of [{ timeZone: "UTC" }, { timeZone: "UTC", accountId: "mail-two", query: "anywhere" }, { timeZone: "UTC", accountId: "not/valid" }]) {
      assert.equal((await jsonRequest(base, "/api/personal/mail/refresh", { method: "POST", headers, body: JSON.stringify(body) })).response.status, 400);
    }
    const refreshing = jsonRequest(base, "/api/personal/calendar/refresh", { method: "POST", headers, body: JSON.stringify({ timeZone: "UTC" }) });
    refreshing.catch(() => null);
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await captured()).some(item => item.method === "mcpServer/tool/call")) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const during = await jsonRequest(base, "/api/codex/app-host/status", { headers });
    assert.equal(during.data.activeSourceReads, 1); assert.deepEqual(during.data.activeJobs, []);
    const mailRefreshing = jsonRequest(base, "/api/personal/mail/refresh", { method: "POST", headers, body: JSON.stringify({ timeZone: "UTC", accountId: "mail-two" }) });
    mailRefreshing.catch(() => null);
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await captured()).some(item => item.method === "mcpServer/tool/call" && item.params.tool === "gmail.search_email_ids")) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal((await jsonRequest(base, "/api/codex/app-host/status", { headers })).data.activeSourceReads, 2);
    await fs.writeFile(capture + ".calendar-release", "release fixture only");
    const done = await refreshing;
    assert.equal(done.response.status, 200); assert.equal(done.data.calendar.stale, false); assert.deepEqual(done.data.calendar.snapshot.items, []);
    assert.equal(done.response.headers.get("cache-control"), "no-store");
    await fs.writeFile(capture + ".mail-release", "release fixture only");
    const mailDone = await mailRefreshing;
    assert.equal(mailDone.data.mail.snapshot.account.email, "two@example.test");
    assert.equal(mailDone.data.mail.snapshot.items[0].title, "HTTP 元信息验收");
    assert.equal((await jsonRequest(base, "/api/codex/app-host/status", { headers })).data.activeSourceReads, 0);
    const native = await captured();
    assert.equal(native.filter(item => item.method === "mcpServer/tool/call").length, 3);
    const mailCalls = native.filter(item => item.method === "mcpServer/tool/call" && item.params.tool.startsWith("gmail."));
    assert.equal(mailCalls.length, 2); assert.ok(mailCalls.every(item => item.params.arguments.link_id === "mail-two"));
    assert.equal(mailCalls[1].params.arguments.format, "metadata");
    assert.equal(native.some(item => item.method === "turn/start"), false);
    const snapshot = mailDone.data.mail.snapshot, message = snapshot.items[0];
    const draftInput = { timeZone: "UTC", source: { accountId: snapshot.account.id, messageId: message.id, itemVersion: message.version, snapshotVersion: snapshot.version } };
    const createDraft = extra => jsonRequest(base, "/api/personal/mail-drafts", { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(draftInput) });
    assert.equal((await createDraft({ origin: "https://untrusted.example.test" })).response.status, 403);
    const reply = await createDraft({}); assert.equal(reply.response.status, 200); assert.equal(reply.data.draft.source.accountEmail, "two@example.test");
    assert.deepEqual(reply.data.draft.form.to, []); assert.equal(reply.data.draft.review, null);
    assert.equal((await createDraft({})).data.draft.id, reply.data.draft.id);
    const draftPath = path.join(stateRoot,"personal-mail-drafts.json"), draftPreserved = await fs.readFile(draftPath,"utf8");
    assert.equal((await fs.stat(draftPath)).mode & 0o777, 0o600);
    assert.equal((await captured()).filter(item => ["turn/start","mcpServer/tool/call"].includes(item.method)).length, 3, "local drafts neither read mail nor start a model");
    assert.ok(native.find(item => item.id === "calendar-unexpected-approval")?.error);
    assert.ok(native.find(item => item.id === "mail-unexpected-approval")?.error);
    const stateFile = path.join(stateRoot, "personal-calendar-source.json"), preserved = await fs.readFile(stateFile, "utf8");
    const mailStateFile = path.join(stateRoot, "personal-mail-source.json"), mailPreserved = await fs.readFile(mailStateFile, "utf8");
    assert.equal(mailPreserved.includes("must-not-persist-private-body"), false);
    const bodyRequest = { ...draftInput, confirm: true };
    const readBody = (input = bodyRequest, extra = {}) => jsonRequest(base, "/api/personal/mail/body", { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(input) });
    assert.equal((await readBody(bodyRequest, { origin: "https://untrusted.example.test" })).response.status, 403);
    for (const invalid of [{ ...bodyRequest, confirm: false }, { ...bodyRequest, format: "raw" }, { ...bodyRequest, source: { ...bodyRequest.source, messageId: "unknown-message" } }]) {
      assert.ok([400, 409].includes((await readBody(invalid)).response.status));
    }
    assert.equal((await captured()).filter(item => item.method === "mcpServer/tool/call").length, 3);
    const bodyResult = await readBody(); assert.equal(bodyResult.response.status, 200);
    assert.match(bodyResult.data.body.text, /2026-11-01 18:00/); assert.equal(bodyResult.data.body.source.accountEmail, "two@example.test");
    assert.equal(bodyResult.response.headers.get("cache-control"), "no-store");
    assert.equal(await fs.readFile(mailStateFile, "utf8"), mailPreserved); assert.equal(await fs.readFile(draftPath, "utf8"), draftPreserved);
    const afterBody = await captured(), fullCalls = afterBody.filter(item => item.method === "mcpServer/tool/call" && item.params.arguments.format === "full");
    assert.equal(fullCalls.length, 1); assert.deepEqual(fullCalls[0].params.arguments, { link_id: "mail-two", message_id: "metadata-mail-id", format: "full" });
    assert.equal(afterBody.some(item => item.method === "turn/start"), false);
    const history = JSON.parse(await fs.readFile(path.join(stateRoot, "chat-history.json"), "utf8").catch(() => '{"sessions":{}}'));
    assert.equal(Object.keys(history.sessions).length, 0, "ephemeral source is not a console conversation");
    await stopProcess(child); child = start(); await waitForOutput(child, /listening on/i);
    const restored = await jsonRequest(base, "/api/personal/calendar?timeZone=UTC", { headers });
    assert.equal(restored.data.calendar.snapshot.version, done.data.calendar.snapshot.version);
    assert.equal(await fs.readFile(stateFile, "utf8"), preserved);
    assert.equal((await jsonRequest(base, "/api/personal/mail?timeZone=UTC", { headers })).data.mail.snapshot.version, mailDone.data.mail.snapshot.version);
    assert.equal(await fs.readFile(mailStateFile, "utf8"), mailPreserved);
    const restoredDrafts = await jsonRequest(base,"/api/personal/mail-drafts",{headers});
    assert.equal(restoredDrafts.data.drafts[0].id,reply.data.draft.id);assert.equal(await fs.readFile(draftPath,"utf8"),draftPreserved);
    assert.equal((await createDraft({})).data.draft.id,reply.data.draft.id);
    await fs.writeFile(capture + ".mail-account-revoked", "fixture account removal only");
    const remaining = await jsonRequest(base, "/api/personal/mail/accounts", accountsRequest);
    assert.equal(remaining.response.status, 200); assert.equal(remaining.data.accounts.length, 1);
    assert.equal(remaining.data.accounts[0].id, "mail-one");
    const unavailable = (await jsonRequest(base, "/api/personal/mail?timeZone=UTC", { headers })).data.mail;
    assert.equal(unavailable.stale, true); assert.equal(unavailable.lastAttempt.code, "mail_account_unavailable");
    assert.deepEqual(unavailable.snapshot, snapshot);
    const editPath = "/api/personal/mail-drafts/" + reply.data.draft.id;
    const editable = await jsonRequest(base, editPath, { method: "PATCH", headers, body: JSON.stringify({ revision: reply.data.draft.revision,
      form: { to: ["chosen@example.test"], subject: "Synthetic local reply", body: "Local editing remains available after disconnection." } }) });
    assert.equal(editable.response.status, 200);
    const editedDraft = await fs.readFile(draftPath, "utf8");
    const reviewRevoked = await jsonRequest(base, editPath, { method: "PATCH", headers, body: JSON.stringify({ revision: editable.data.draft.revision, status: "ready" }) });
    assert.equal(reviewRevoked.response.status, 409); assert.equal(reviewRevoked.data.code, "mail_draft_source_changed");
    assert.equal(await fs.readFile(draftPath, "utf8"), editedDraft);
    await stopProcess(child); child = start(); await waitForOutput(child, /listening on/i);
    assert.equal((await jsonRequest(base, "/api/personal/mail?timeZone=UTC", { headers })).data.mail.stale, true);
    assert.equal(await fs.readFile(draftPath, "utf8"), editedDraft);
    assert.equal((await captured()).filter(item => ["turn/start", "mcpServer/tool/call"].includes(item.method)).length, 4, "discovering disconnection and reopening drafts never reads another mailbox or invokes a model");
    await fs.writeFile(draftPath,"null");
    assert.equal((await jsonRequest(base,"/api/personal/mail-drafts",{headers})).response.status,503);
    assert.equal((await createDraft({})).response.status,503);assert.equal(await fs.readFile(draftPath,"utf8"),"null");
    await fs.unlink(draftPath);await fs.symlink(capture,draftPath);
    assert.equal((await jsonRequest(base,"/api/personal/mail-drafts",{headers})).response.status,503);assert.equal((await fs.lstat(draftPath)).isSymbolicLink(),true);
    const oversized = "x".repeat(1024 * 1024 + 1);
    await fs.writeFile(stateFile, oversized);
    assert.equal((await jsonRequest(base, "/api/personal/calendar?timeZone=UTC", { headers })).response.status, 503);
    assert.equal(await fs.readFile(stateFile, "utf8"), oversized);
    await fs.unlink(stateFile); await fs.symlink(capture, stateFile);
    assert.equal((await jsonRequest(base, "/api/personal/calendar?timeZone=UTC", { headers })).response.status, 503);
    assert.equal((await fs.lstat(stateFile)).isSymbolicLink(), true);
    await fs.unlink(stateFile);
    await fs.writeFile(stateFile, '{"version":99,"preserve":"invalid fixture"}');
    const broken = await jsonRequest(base, "/api/personal/calendar/refresh", { method: "POST", headers, body: JSON.stringify({ timeZone: "UTC" }) });
    assert.equal(broken.response.status, 503); assert.equal(JSON.parse(await fs.readFile(stateFile, "utf8")).preserve, "invalid fixture");
    await fs.unlink(mailStateFile); await fs.symlink(capture, mailStateFile);
    assert.equal((await jsonRequest(base, "/api/personal/mail?timeZone=UTC", { headers })).response.status, 503);
    assert.equal((await fs.lstat(mailStateFile)).isSymbolicLink(), true);
  } finally { await stopProcess(child); await fs.rm(root, { recursive: true, force: true }); }
});

await check("personal and work reuse authentication without sharing threads or stale worker status", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-shared-personal-"));
  const fake = await writeFakeCodex(root);
  const cloudRoot = path.join(root, "cloud");
  const stateRoot = path.join(root, "state");
  const bin = path.join(root, "bin");
  const capturePath = path.join(root, "requests.jsonl");
  const personalDeleteGate = path.join(root, "release-personal-delete-turn");
  const port = await freePort();
  await fs.mkdir(path.join(cloudRoot, "workspace", "sample-app"), { recursive: true });
  await fs.mkdir(stateRoot, { recursive: true });
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, "codex"), `#!/bin/sh\nif [ "$1" = "login" ]; then echo "Logged in using ChatGPT"; exit 0; fi\nif [ "$1" = "--version" ]; then echo "fixture"; exit 0; fi\nexec "${process.execPath}" "${fake}"\n`, { mode: 0o755 });
  await fs.writeFile(path.join(stateRoot, "codex-app-status-cache.json"), JSON.stringify({ repos: { _personal: { cachedAt: new Date().toISOString(), data: { ok: true, source: "app-server", authoritative: true, runtimeScope: "personal-worker", account: null, auth: { ok: false, issue: "old worker login" } } } } }));
  const child = spawn(process.execPath, [path.join(projectRoot, "server/index.mjs")], {
    cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "production", HOST: "127.0.0.1", PORT: String(port), CODEX_CLOUD_ROOT: cloudRoot,
      CODEX_WORKSPACE_ROOT: path.join(cloudRoot, "workspace"), CODEX_STATE_ROOT: stateRoot, CODEX_HOME: path.join(root, ".codex"),
      CODEX_PERSONAL_MODE: "shared", CODEX_PERSONAL_ROOT: path.join(cloudRoot, "personal"), CODEX_PERSONAL_WORKER: "1",
      CODEX_CLOUD_WEBHOOK_TOKEN: "shared-test-token-only", CODEX_TURN_TIMEOUT_MS: "5000", CODEX_ALLOW_LOCAL_FALLBACK: "0",
      FAKE_SHARED_PERSONAL: "1", FAKE_CAPTURE_PATH: capturePath, FAKE_PERSONAL_DELETE_GATE_PATH: personalDeleteGate, PATH: `${bin}:${process.env.PATH}` },
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitForOutput(child, /listening on/i);
    const accountStates = [];
    const sessions = [];
    for (const repoId of ["sample-app", "_personal"]) {
      const { data: account } = await jsonRequest(base, `/api/codex/app-status?repoId=${repoId}`);
      assert.equal(account.auth.ok, true, JSON.stringify(account));
      assert.equal(account.runtimeScope, "shared");
      accountStates.push(account.account);
      const { response, data } = await jsonRequest(base, "/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repoId, message: "outcome contract regression" }) });
      assert.equal(response.status, 200, JSON.stringify(data));
      assert.equal(data.ok, true, JSON.stringify(data));
      sessions.push(data);
    }
    assert.deepEqual(accountStates[0], accountStates[1]);
    assert.notEqual(sessions[0].codexSessionId, sessions[1].codexSessionId);
    const crossSpace = await jsonRequest(base, `/api/chat/sessions/${sessions[1].sessionId}/select`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repoId: "sample-app" }) });
    assert.equal(crossSpace.response.status, 404);
    for (const [index, repoId] of ["sample-app", "_personal"].entries()) {
      const { data } = await jsonRequest(base, `/api/chat/sessions?repoId=${repoId}`);
      assert.equal(data.sessions.length, 1);
      assert.equal(data.sessions[0].codexSessionId, sessions[index].codexSessionId);
    }
    const requests = (await fs.readFile(capturePath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(requests.filter((r) => r.method === "initialize").length, 1);
    assert.equal(requests.filter((r) => r.method === "account/login/start").length, 0);
    const starts = requests.filter((r) => r.method === "thread/start");
    assert.equal(starts[0].params.cwd, path.join(cloudRoot, "workspace", "sample-app"));
    assert.equal(starts[1].params.cwd, path.join(cloudRoot, "personal"));
    assert.equal(starts[1].params.sandbox, "read-only");
    assert.equal(starts[1].params.config.features.memories, false);
    assert.equal(starts[0].params.dynamicTools, undefined);
    assert.deepEqual(starts[1].params.dynamicTools.map(tool => tool.name), ["personal_memory_propose", "personal_facts_reference", "personal_mail_draft"]);
    assert.match(starts[1].params.developerInstructions, /only this conversation/);
    const personalSessionId = sessions[1].sessionId;
    const writable = await jsonRequest(base, `/api/chat/sessions/${personalSessionId}/runtime`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ repoId: "_personal", sandbox: "workspace-write", model: "gpt-5.6-terra", reasoning: "medium" }),
    });
    assert.equal(writable.response.status, 200, JSON.stringify(writable.data));
    assert.equal(writable.data.runtime.sandbox, "workspace-write");
    const writeTurn = await jsonRequest(base, "/api/chat", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repoId: "_personal", sessionId: personalSessionId, message: "outcome contract regression" }),
    });
    assert.equal(writeTurn.data.ok, true);
    const afterWriteRequests = (await fs.readFile(capturePath, "utf8")).trim().split("\n").map(JSON.parse);
    const lastTurn = afterWriteRequests.filter((r) => r.method === "turn/start").at(-1).params;
    assert.equal(lastTurn.sandboxPolicy.type, "workspaceWrite");
    assert.deepEqual(lastTurn.sandboxPolicy.writableRoots, [path.join(cloudRoot, "personal")]);
    assert.equal(lastTurn.approvalPolicy, "on-request");
    const lastResume = afterWriteRequests.filter((r) => r.method === "thread/resume" && r.params.developerInstructions).at(-1).params;
    assert.match(lastResume.developerInstructions, /allowed writing within this personal workspace/);
    const refreshed = await jsonRequest(base, `/api/chat/sessions/${personalSessionId}/select`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repoId: "_personal" }),
    });
    assert.equal(refreshed.response.status, 200);
    const refreshedPersonal = refreshed.data.sessions.find((s) => s.id === personalSessionId);
    assert.equal(refreshedPersonal.sandbox, "workspace-write", "后台刷新不能覆盖用户确认的个人权限");
    assert.equal(refreshedPersonal.approval, "on-request");
    const refreshRequests = (await fs.readFile(capturePath, "utf8")).trim().split("\n").map(JSON.parse);
    const refreshResume = refreshRequests.filter((r) => r.method === "thread/resume").at(-1).params;
    assert.equal(refreshResume.sandbox, "workspace-write");
    assert.equal(refreshResume.approvalPolicy, "on-request");
    const createdFact = await jsonRequest(base, "/api/personal/facts", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "称呼", value: "回归测试称呼" }),
    });
    assert.equal(createdFact.response.status, 201);
    const createdCommitment = await jsonRequest(base, "/api/personal/commitments", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "回归测试个人事项", nextStep: "整理资料", dueAt: "2026-10-02T09:00:00.000Z" }),
    });
    assert.equal(createdCommitment.response.status, 201);
    const createdRoutine = await jsonRequest(base, "/api/personal/routines", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "回归测试流程", prompt: "只读整理资料" }),
    });
    assert.equal(createdRoutine.response.status, 201);
    const routineId = createdRoutine.data.routine.id;
    const listedRoutines = await jsonRequest(base, "/api/personal/routines");
    assert.equal(listedRoutines.data.routines[0].id, routineId);
    const routineStatus = await jsonRequest(base, "/api/status");
    assert.equal(routineStatus.data.automations.find((item) => item.id === routineId)?.mode, "on-demand");
    const unconfirmedRun = await jsonRequest(base, `/api/automations/${routineId}/run`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runner: "app-server" }),
    });
    assert.equal(unconfirmedRun.response.status, 428);
    const externalRoutine = await jsonRequest(base, `/api/automations/${routineId}/webhook`, {
      method: "POST", headers: { "content-type": "application/json", "x-codex-cloud-token": "shared-test-token-only" }, body: JSON.stringify({ prompt: "run" }),
    });
    assert.equal(externalRoutine.response.status, 403);
    const staleRoutine = await jsonRequest(base, `/api/personal/routines/${routineId}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: 0, name: "旧名称", prompt: "旧任务" }),
    });
    assert.equal(staleRoutine.response.status, 409);
    const scheduleWithoutConsent = await jsonRequest(base, `/api/personal/routines/${routineId}/schedule`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: 1, enabled: true, cadence: "daily", time: "09:00", timeZone: "Asia/Shanghai" }),
    });
    assert.equal(scheduleWithoutConsent.response.status, 428);
    const invalidSchedule = await jsonRequest(base, `/api/personal/routines/${routineId}/schedule`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: 1, enabled: true, confirmModelCost: true, cadence: "daily", time: "09:00", timeZone: "Mars/Olympus" }),
    });
    assert.equal(invalidSchedule.response.status, 400);
    const updatedRoutine = await jsonRequest(base, `/api/personal/routines/${routineId}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: 1, name: "新名称", prompt: "只读整理明天资料 personal schedule test regression" }),
    });
    assert.equal(updatedRoutine.response.status, 200);
    assert.equal((await jsonRequest(base, "/api/status")).data.automations.find((item) => item.id === routineId)?.name, "新名称");
    const scheduleTime = new Date(Date.now() + 2 * 60 * 60_000);
    const schedulePayload = { revision: 4, enabled: true, confirmModelCost: true, cadence: "daily",
      time: `${String(scheduleTime.getUTCHours()).padStart(2, "0")}:${String(scheduleTime.getUTCMinutes()).padStart(2, "0")}`, timeZone: "UTC" };
    const untestedSchedule = await jsonRequest(base, `/api/personal/routines/${routineId}/schedule`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...schedulePayload, revision: 2 }),
    });
    assert.equal(untestedSchedule.response.status, 409);
    const trialWithoutConsent = await jsonRequest(base, `/api/personal/routines/${routineId}/test`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: 2 }),
    });
    assert.equal(trialWithoutConsent.response.status, 428);
    const startedTrial = await jsonRequest(base, `/api/personal/routines/${routineId}/test`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: 2, confirmModelCost: true }),
    });
    assert.equal(startedTrial.response.status, 200);
    assert.equal(startedTrial.data.revision, 3);
    let latestTrial;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      latestTrial = await jsonRequest(base, `/api/personal/routines/${routineId}/test`);
      if (latestTrial.data.test?.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(latestTrial.data.test?.status, "completed");
    assert.equal(latestTrial.data.test.promptMatches, true);
    const approvalWithoutReview = await jsonRequest(base, `/api/personal/routines/${routineId}/test/approve`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: 3, runId: latestTrial.data.test.id }),
    });
    assert.equal(approvalWithoutReview.response.status, 428);
    const approvedTrial = await jsonRequest(base, `/api/personal/routines/${routineId}/test/approve`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: 3, runId: latestTrial.data.test.id, confirmResult: true }),
    });
    assert.equal(approvedTrial.response.status, 200, JSON.stringify({ test: latestTrial.data.test, response: approvedTrial.data }));
    assert.equal((await jsonRequest(base, "/api/status")).data.automations.find((item) => item.id === routineId)?.personalTestApproval?.current, true);
    const enabledSchedule = await jsonRequest(base, `/api/personal/routines/${routineId}/schedule`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(schedulePayload),
    });
    assert.equal(enabledSchedule.response.status, 200);
    assert.equal(enabledSchedule.data.routine.personalSchedule.enabled, true);
    const scheduledStatus = await jsonRequest(base, "/api/status");
    assert.ok(Number.isFinite(Date.parse(scheduledStatus.data.automations.find((item) => item.id === routineId)?.nextRun)));
    const pausedSchedule = await jsonRequest(base, `/api/personal/routines/${routineId}/schedule`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: 5, enabled: false }),
    });
    assert.equal(pausedSchedule.response.status, 200);
    assert.equal(pausedSchedule.data.routine.personalSchedule.enabled, false);
    const editedAfterTrial = await jsonRequest(base, `/api/personal/routines/${routineId}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: 6, name: "新名称", prompt: "只读整理空结果 personal schedule empty regression" }),
    });
    assert.equal(editedAfterTrial.response.status, 200);
    assert.equal((await jsonRequest(base, "/api/status")).data.automations.find((item) => item.id === routineId)?.personalTestApproval?.current, false);
    assert.equal((await jsonRequest(base, `/api/personal/routines/${routineId}/test`)).data.test.promptMatches, false);
    const emptyTrial = await jsonRequest(base, `/api/personal/routines/${routineId}/test`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: 7, confirmModelCost: true }),
    });
    assert.equal(emptyTrial.response.status, 200, JSON.stringify(emptyTrial.data));
    let emptyTrialStatus;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      emptyTrialStatus = await jsonRequest(base, `/api/personal/routines/${routineId}/test`);
      if (emptyTrialStatus.data.test?.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(emptyTrialStatus.data.test?.status, "completed");
    assert.match(emptyTrialStatus.data.test.reviewIssue, /没有可审核/);
    const emptyApproval = await jsonRequest(base, `/api/personal/routines/${routineId}/test/approve`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: 8, runId: emptyTrialStatus.data.test.id, confirmResult: true }),
    });
    assert.equal(emptyApproval.response.status, 409);
    const archivedRoutine = await jsonRequest(base, `/api/personal/routines/${routineId}`, {
      method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: 8 }),
    });
    assert.equal(archivedRoutine.response.status, 200);
    assert.ok(archivedRoutine.data.routine.archivedAt);
    assert.equal((await jsonRequest(base, "/api/status")).data.automations.some((item) => item.id === routineId), false);
    const restoredRoutine = await jsonRequest(base, `/api/personal/routines/${routineId}/restore`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: 9 }),
    });
    assert.equal(restoredRoutine.response.status, 200);
    assert.equal((await jsonRequest(base, "/api/status")).data.automations.find((item) => item.id === routineId)?.name, "新名称");
    const firstBrief = await jsonRequest(base, "/api/personal/brief");
    assert.equal(firstBrief.response.status, 200);
    assert.ok(firstBrief.data.brief.items.some((item) => item.title === "回归测试个人事项" && item.detail === "新增关注事项"));
    const reviewedBrief = await jsonRequest(base, "/api/personal/brief/review", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ through: firstBrief.data.brief.until }),
    });
    assert.equal(reviewedBrief.response.status, 200);
    assert.equal((await jsonRequest(base, "/api/personal/brief")).data.brief.total, 0);
    const invalidReview = await jsonRequest(base, "/api/personal/brief/review", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ through: "2999-01-01T00:00:00.000Z" }),
    });
    assert.equal(invalidReview.response.status, 400);
    const pushEndpoint = "https://push.example.test/sub/personal-regression";
    const subscription = { endpoint: pushEndpoint, keys: { p256dh: "test-p256dh", auth: "test-auth" } };
    const pushSubscribed = await jsonRequest(base, "/api/notifications/push/subscribe", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subscription, personalTimeZone: "Asia/Shanghai" }),
    });
    assert.equal(pushSubscribed.response.status, 200);
    const defaultReminder = await jsonRequest(base, "/api/personal/reminders/status", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: pushEndpoint }),
    });
    assert.equal(defaultReminder.data.settings.enabled, false);
    assert.equal(defaultReminder.data.settings.timeZone, "Asia/Shanghai");
    const enabledReminder = await jsonRequest(base, "/api/personal/reminders", {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: pushEndpoint, settings: { enabled: true, timeZone: "Asia/Shanghai", quietStart: "22:00", quietEnd: "08:00" } }),
    });
    assert.equal(enabledReminder.response.status, 200);
    await jsonRequest(base, "/api/notifications/push/subscribe", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subscription }),
    });
    assert.equal((await jsonRequest(base, "/api/personal/reminders/status", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: pushEndpoint }),
    })).data.settings.enabled, true, "重新订阅不应取消个人提醒");
    const concurrentSettings = { enabled: false, timeZone: "Asia/Shanghai", quietStart: "21:00", quietEnd: "07:00" };
    const concurrentWrites = await Promise.all([
      jsonRequest(base, "/api/personal/reminders", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: pushEndpoint, settings: concurrentSettings }) }),
      jsonRequest(base, "/api/notifications/push/subscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subscription }) }),
    ]);
    assert.ok(concurrentWrites.every(({ response }) => response.status === 200));
    assert.deepEqual((await jsonRequest(base, "/api/personal/reminders/status", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: pushEndpoint }),
    })).data.settings, concurrentSettings, "并发重新订阅不能覆盖已保存的提醒偏好");
    const wrongSpaceLink = await jsonRequest(base, `/api/personal/commitments/${createdCommitment.data.commitment.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: 1, sessionId: sessions[0].sessionId }),
    });
    assert.equal(wrongSpaceLink.response.status, 404);
    const factSession = await jsonRequest(base, "/api/chat/sessions", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repoId: "_personal", title: "Fact test" }),
    });
    assert.equal(factSession.response.status, 200);
    const linkedCommitment = await jsonRequest(base, `/api/personal/commitments/${createdCommitment.data.commitment.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: 1, sessionId: factSession.data.activeSessionId }),
    });
    assert.equal(linkedCommitment.response.status, 200);
    const withFact = await jsonRequest(base, "/api/chat", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoId: "_personal", sessionId: factSession.data.activeSessionId, message: "outcome contract regression with fact", model: "gpt-6-astra", reasoning: "ultra" }),
    });
    assert.equal(withFact.data.ok, true);
    const factStarts = (await fs.readFile(capturePath, "utf8")).trim().split("\n").map(JSON.parse).filter((request) => request.method === "thread/start" && request.params.cwd === path.join(cloudRoot, "personal"));
    assert.match(factStarts.at(-1).params.developerInstructions, /回归测试称呼/);
    assert.match(factStarts.at(-1).params.developerInstructions, /回归测试个人事项/);
    const completedCommitment = await jsonRequest(base, `/api/personal/commitments/${createdCommitment.data.commitment.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: linkedCommitment.data.commitment.revision, status: "done" }),
    });
    assert.equal(completedCommitment.response.status, 200);
    const completedBrief = await jsonRequest(base, "/api/personal/brief");
    assert.ok(completedBrief.data.brief.items.some((item) => item.title === "回归测试个人事项" && item.detail === "关注事项已完成"));
    const deletedFact = await jsonRequest(base, `/api/personal/facts/${createdFact.data.fact.id}`, {
      method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: createdFact.data.fact.revision }),
    });
    assert.equal(deletedFact.response.status, 200);
    const rpcBeforeBlock = await fs.readFile(capturePath, "utf8");
    for (const [route, body] of [
      ["/api/chat", { message: "must not reuse removed fact" }],
      ["/api/codex/thread-fork", {}],
      [`/api/chat/sessions/${factSession.data.activeSessionId}/runtime`, { model: "gpt-6-sol", reasoning: "medium" }],
    ]) {
      const blocked = await jsonRequest(base, route, { method: route.endsWith("/runtime") ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repoId: "_personal", sessionId: factSession.data.activeSessionId, ...body }) });
      assert.equal(blocked.response.status, 409, JSON.stringify(blocked.data));
      assert.match(blocked.data.error, /新上下文/);
    }
    const blockedStream = await fetch(`${base}/api/chat/stream`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repoId: "_personal", sessionId: factSession.data.activeSessionId, message: "must not run stream" }) });
    assert.match(await blockedStream.text(), /personal_context_changed/);
    const rpcAfterBlock = await fs.readFile(capturePath, "utf8");
    const executionMethods = (capture) => capture.trim().split("\n").map(JSON.parse).filter((request) => ["thread/resume", "thread/start", "thread/fork", "turn/start", "thread/compact/start"].includes(request.method));
    assert.equal(executionMethods(rpcAfterBlock).length, executionMethods(rpcBeforeBlock).length, "rejected requests must not resume, fork or run a model");
    const contextCheck = await jsonRequest(base, `/api/chat/sessions/${factSession.data.activeSessionId}/personal-context?repoId=_personal`);
    assert.match(contextCheck.data.issue, /新上下文/); assert.equal(contextCheck.data.providedCount, 1);
    const removedFactSession = await jsonRequest(base, "/api/chat/sessions", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repoId: "_personal", title: "Removed fact test" }),
    });
    assert.equal(removedFactSession.response.status, 200);
    const withoutFact = await jsonRequest(base, "/api/chat", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoId: "_personal", sessionId: removedFactSession.data.activeSessionId, message: "outcome contract regression after fact removal" }),
    });
    assert.equal(withoutFact.data.ok, true);
    const updatedStarts = (await fs.readFile(capturePath, "utf8")).trim().split("\n").map(JSON.parse).filter((request) => request.method === "thread/start" && request.params.cwd === path.join(cloudRoot, "personal"));
    assert.doesNotMatch(updatedStarts.at(-1).params.developerInstructions, /回归测试称呼/);
    assert.doesNotMatch(updatedStarts.at(-1).params.developerInstructions, /回归测试个人事项/);
    const attachmentBytes = Buffer.from("personal upload regression\n");
    const uploaded = await jsonRequest(base, "/api/uploads", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoId: "_personal", files: [{ name: "notes.txt", type: "text/plain", dataUrl: `data:text/plain;base64,${attachmentBytes.toString("base64")}` }] }),
    });
    assert.equal(uploaded.response.status, 200, JSON.stringify(uploaded.data));
    assert.equal(uploaded.data.files.length, 1);
    assert.equal(uploaded.data.files[0].source, "personal-upload");
    const uploadPath = uploaded.data.files[0].path;
    const draftCopy = { input: "保留原未发送输入", attachments: [{ name: "notes.txt", path: uploadPath, mimeType: "text/plain", size: attachmentBytes.length, kind: "file" }] };
    const savedCopy = await jsonRequest(base, `/api/chat/sessions/${factSession.data.activeSessionId}/draft`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ repoId: "_personal", ...draftCopy }) });
    const pendingSessionId = crypto.randomUUID(), contextRoute = `/api/chat/sessions/${factSession.data.activeSessionId}/personal-context`;
    const copyOptions = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repoId: "_personal", pendingSessionId, expectedDraftRevision: savedCopy.data.draft.revision }) };
    const copied = await jsonRequest(base, contextRoute, copyOptions);
    assert.equal(copied.response.status, 200, JSON.stringify(copied.data));
    const newContext = copied.data.sessions.find((session) => session.id === pendingSessionId);
    assert.equal(newContext.codexSessionId, null); assert.equal(newContext.model, "gpt-6-astra"); assert.equal(newContext.reasoning, "ultra");
    assert.equal(newContext.draft.input, draftCopy.input); assert.equal(newContext.draft.attachments[0].path, uploadPath);
    assert.deepEqual(copied.data.messages, []);
    const oldDraft = await jsonRequest(base, `/api/chat/sessions/${factSession.data.activeSessionId}/draft?repoId=_personal`);
    assert.deepEqual(oldDraft.data.draft, savedCopy.data.draft);
    const contextReplay = await jsonRequest(base, contextRoute, copyOptions);
    assert.equal(contextReplay.data.activeSessionId, pendingSessionId);
    assert.equal(contextReplay.data.sessions.filter((session) => session.id === pendingSessionId).length, 1);
    assert.equal((await jsonRequest(base, contextRoute, { ...copyOptions, body: JSON.stringify({ repoId: "sample-app", pendingSessionId }) })).response.status, 400);
    await jsonRequest(base, `/api/chat/sessions/${pendingSessionId}?repoId=_personal`, { method: "DELETE" });
    await jsonRequest(base, `/api/chat/sessions/${factSession.data.activeSessionId}/draft`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ repoId: "_personal", input: "", attachments: [] }) });
    assert.match(uploadPath, /^\.codex-cloud\/uploads\//);
    assert.deepEqual(await fs.readFile(path.join(cloudRoot, "personal", uploadPath)), attachmentBytes);
    const preview = await fetch(`${base}/api/files/blob?repoId=_personal&path=${encodeURIComponent(uploadPath)}`);
    assert.equal(preview.status, 200);
    assert.deepEqual(Buffer.from(await preview.arrayBuffer()), attachmentBytes);
    await fs.mkdir(path.join(cloudRoot, "personal", "results"), { recursive: true });
    await fs.writeFile(path.join(cloudRoot, "personal", "results", "summary.md"), "personal result\n");
    await fs.writeFile(path.join(cloudRoot, "workspace", "sample-app", "work-only.txt"), "must not be exposed\n");
    await fs.symlink(path.join(cloudRoot, "workspace", "sample-app"), path.join(cloudRoot, "personal", "results", "work-link"));
    const personalFiles = await jsonRequest(base, "/api/personal/files");
    assert.equal(personalFiles.response.status, 200);
    assert.ok(personalFiles.data.files.some((file) => file.path === "results/summary.md" && file.kind === "output"));
    assert.ok(personalFiles.data.files.some((file) => file.path === uploadPath && file.kind === "input"));
    assert.equal(personalFiles.data.files.some((file) => file.path.includes("work-link")), false);
    const resultFile = await fetch(`${base}/api/personal/files/content?path=results%2Fsummary.md&preview=1`);
    assert.equal(resultFile.status, 200);
    assert.equal(resultFile.headers.get("content-security-policy"), "sandbox");
    assert.match(resultFile.headers.get("content-disposition"), /^inline;/);
    assert.equal(await resultFile.text(), "personal result\n");
    const downloadedFile = await fetch(`${base}/api/personal/files/content?path=results%2Fsummary.md`);
    assert.equal(downloadedFile.status, 200);
    assert.equal(downloadedFile.headers.get("content-type"), "application/octet-stream");
    assert.match(downloadedFile.headers.get("content-disposition"), /^attachment;/);
    assert.equal(await downloadedFile.text(), "personal result\n");
    const linkedWorkFile = await fetch(`${base}/api/personal/files/content?path=results%2Fwork-link%2Fwork-only.txt`);
    assert.equal(linkedWorkFile.status, 403);
    const crossSpacePreview = await fetch(`${base}/api/files/blob?repoId=sample-app&path=${encodeURIComponent(uploadPath)}`);
    assert.notEqual(crossSpacePreview.status, 200);
    const traversal = await jsonRequest(base, "/api/chat/stream", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoId: "_personal", attachments: [{ path: "../../sample-app/secret.txt", name: "secret.txt", mimeType: "text/plain" }] }),
    });
    assert.equal(traversal.response.status, 400);
    const materialSession = await jsonRequest(base, "/api/chat/sessions", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repoId: "_personal", title: "Material retention" }),
    });
    assert.equal(materialSession.response.status, 200);
    const materialSessionId = materialSession.data.activeSessionId;
    const attachedDraft = await jsonRequest(base, `/api/chat/sessions/${materialSessionId}/draft`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoId: "_personal", input: "", attachments: [{ name: "notes.txt", path: uploadPath, mimeType: "text/plain", size: attachmentBytes.length, kind: "file" }] }),
    });
    assert.equal(attachedDraft.response.status, 200, JSON.stringify(attachedDraft.data));
    const blockedDelete = await jsonRequest(base, `/api/personal/files?path=${encodeURIComponent(uploadPath)}`, { method: "DELETE" });
    assert.equal(blockedDelete.response.status, 409);
    const deletedSession = await jsonRequest(base, `/api/chat/sessions/${materialSessionId}?repoId=_personal`, { method: "DELETE" });
    assert.equal(deletedSession.response.status, 200, JSON.stringify(deletedSession.data));
    assert.deepEqual(deletedSession.data.uploadCleanup.retained, [uploadPath]);
    assert.deepEqual(await fs.readFile(path.join(cloudRoot, "personal", uploadPath)), attachmentBytes);
    const activePersonalTurn = await fetch(`${base}/api/chat/stream`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoId: "_personal", sessionId: removedFactSession.data.activeSessionId, message: "personal deletion regression" }),
    });
    assert.equal(activePersonalTurn.status, 200);
    let personalTurnStarted = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await fs.readFile(capturePath, "utf8")).includes("personal deletion regression")) { personalTurnStarted = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(personalTurnStarted, true, "个人会话必须启动后才能测试运行中删除保护");
    const blockedDuringTurn = await jsonRequest(base, `/api/personal/files?path=${encodeURIComponent(uploadPath)}`, { method: "DELETE" });
    assert.equal(blockedDuringTurn.response.status, 409);
    assert.deepEqual(await fs.readFile(path.join(cloudRoot, "personal", uploadPath)), attachmentBytes);
    await fs.writeFile(personalDeleteGate, "released");
    await activePersonalTurn.text();
    const removed = await jsonRequest(base, `/api/personal/files?path=${encodeURIComponent(uploadPath)}`, { method: "DELETE" });
    assert.equal(removed.response.status, 200, JSON.stringify(removed.data));
    assert.equal(await fs.stat(path.join(cloudRoot, "personal", uploadPath)).catch(() => null), null);
    assert.equal(await fs.readFile(path.join(cloudRoot, "personal", "results", "summary.md"), "utf8"), "personal result\n");
    const writeRoutine = await jsonRequest(base, "/api/personal/routines", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "外部写入拦截", prompt: "external write regression" }),
    });
    assert.equal(writeRoutine.response.status, 201);
    const writeRoutineId = writeRoutine.data.routine.id;
    const writeTrial = await jsonRequest(base, `/api/personal/routines/${writeRoutineId}/test`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: 1, confirmModelCost: true }),
    });
    assert.equal(writeTrial.response.status, 200, JSON.stringify(writeTrial.data));
    let writeTrialStatus;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      writeTrialStatus = await jsonRequest(base, `/api/personal/routines/${writeRoutineId}/test`);
      if (writeTrialStatus.data.test?.status === "needs_reconciliation") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(writeTrialStatus.data.test?.status, "needs_reconciliation");
    assert.match(writeTrialStatus.data.test.error, /连接服务写入/);
    const blockedWriteApproval = await jsonRequest(base, `/api/personal/routines/${writeRoutineId}/test/approve`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: 2, runId: writeTrialStatus.data.test.id, confirmResult: true }),
    });
    assert.equal(blockedWriteApproval.response.status, 409);
    const interruptsBeforeUnknown = (await fs.readFile(capturePath, "utf8")).trim().split("\n").map(JSON.parse).filter((request) => request.method === "turn/interrupt").length;
    const unknownRoutine = await jsonRequest(base, "/api/personal/routines", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "只读状态未知", prompt: "external write regression missing hint" }),
    });
    assert.equal(unknownRoutine.response.status, 201);
    const unknownRoutineId = unknownRoutine.data.routine.id;
    const unknownTrial = await jsonRequest(base, `/api/personal/routines/${unknownRoutineId}/test`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: 1, confirmModelCost: true }),
    });
    assert.equal(unknownTrial.response.status, 200, JSON.stringify(unknownTrial.data));
    let unknownTrialStatus;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      unknownTrialStatus = await jsonRequest(base, `/api/personal/routines/${unknownRoutineId}/test`);
      if (unknownTrialStatus.data.test?.status === "needs_reconciliation") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(unknownTrialStatus.data.test?.status, "needs_reconciliation");
    assert.match(unknownTrialStatus.data.test.error, /未声明只读/);
    const interruptsAfterUnknown = (await fs.readFile(capturePath, "utf8")).trim().split("\n").map(JSON.parse).filter((request) => request.method === "turn/interrupt").length;
    assert.ok(interruptsAfterUnknown > interruptsBeforeUnknown);
    const blockedUnknownApproval = await jsonRequest(base, `/api/personal/routines/${unknownRoutineId}/test/approve`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: 2, runId: unknownTrialStatus.data.test.id, confirmResult: true }),
    });
    assert.equal(blockedUnknownApproval.response.status, 409);
    const { data: status } = await jsonRequest(base, "/api/status");
    assert.equal(status.codex.authenticated, true);
    assert.equal(status.repos.find((r) => r.id === "_personal").executionAvailable, true);
  } finally {
    await stopProcess(child);
    await fs.rm(root, { recursive: true, force: true });
  }
});

await check("session sync failure preserves drafts and upload cleanup is verified", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-session-regression-"));
  const fakePath = await writeFakeCodex(tempRoot);
  const binDir = path.join(tempRoot, "bin");
  const stateRoot = path.join(tempRoot, "state");
  const cloudRoot = path.join(tempRoot, "cloud");
  const workspaceRoot = path.join(cloudRoot, "workspace");
  const repoRoot = path.join(workspaceRoot, "sample-app");
  const emptyRepoRoot = path.join(workspaceRoot, "sample-service");
  const outsideRoot = path.join(tempRoot, "outside-repository");
  const outsideSecretPath = path.join(outsideRoot, "secret.txt");
  const danglingWriteTarget = path.join(outsideRoot, "created-through-symlink.txt");
  const codexShim = path.join(binDir, "codex");
  const capturePath = path.join(tempRoot, "app-server-requests.jsonl");
  const codexHome = path.join(tempRoot, ".codex");
  const generatedImagesRoot = path.join(codexHome, "generated_images");
  const generatedImagePath = path.join(generatedImagesRoot, "thread-regression", "generated.png");
  const generatedImageBytes = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  const port = await freePort();
  const benxingPort = await freePort();
  const benxingRequests = [];
  const benxingUpstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    benxingRequests.push({
      method: req.method,
      url: req.url,
      authorization: req.headers["oai-sites-authorization"],
      jobToken: req.headers["x-benxing-job-token"],
      contentType: req.headers["content-type"],
      body,
    });
    if (req.method === "GET" && req.url?.includes("/inputs/")) {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(generatedImageBytes);
      return;
    }
    if (req.method === "POST" && req.url?.endsWith("/complete")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false }));
  });
  await new Promise((resolve) => benxingUpstream.listen(benxingPort, "127.0.0.1", resolve));
  await fs.mkdir(path.join(repoRoot, ".codex-cloud", "uploads", "test"), { recursive: true });
  await initializeGitFixture(repoRoot);
  await fs.mkdir(emptyRepoRoot, { recursive: true });
  await fs.mkdir(outsideRoot, { recursive: true });
  await fs.mkdir(path.dirname(generatedImagePath), { recursive: true });
  await fs.writeFile(outsideSecretPath, "must stay outside the repository\n");
  await fs.writeFile(generatedImagePath, generatedImageBytes);
  await fs.symlink(outsideSecretPath, path.join(generatedImagesRoot, "thread-regression", "outside.png"), "file");
  await fs.symlink(outsideRoot, path.join(repoRoot, "outside-link"), "dir");
  await fs.symlink(danglingWriteTarget, path.join(repoRoot, "dangling-write-link"), "file");
  await fs.symlink("cyclic-link", path.join(repoRoot, "cyclic-link"), "file");
  await fs.symlink(outsideSecretPath, path.join(repoRoot, ".codex-cloud", "uploads", "test", "outside-secret-link"), "file");
  await fs.symlink(outsideRoot, path.join(repoRoot, ".codex-cloud", "uploads", new Date().toISOString().slice(0, 10)), "dir");
  await fs.mkdir(stateRoot, { recursive: true });
  await fs.writeFile(
    path.join(stateRoot, "codex-models-cache.json"),
    JSON.stringify({
      ok: true,
      source: "app-server",
      authoritative: true,
      cachedAt: "2026-01-01T00:00:00.000Z",
      models: [
        {
          id: "gpt-5.5",
          model: "gpt-5.5",
          displayName: "GPT-5.5",
          isDefault: true,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
          inputModalities: ["text", "image"],
        },
      ],
    }),
  );
  await fs.writeFile(
    path.join(stateRoot, "audit-events.json"),
    JSON.stringify({
      version: 1,
      events: [
        {
          id: "audit-regression-command-path",
          time: new Date().toISOString(),
          source: "app-server",
          type: "shell",
          summary: "Read project files",
          detail: JSON.stringify({
            type: "commandExecution",
            command: `rg --files ${path.join(cloudRoot, "worktrees", "run-regression")}`,
            exitCode: 0,
          }),
        },
        {
          id: "audit-regression-interrupted-run",
          time: new Date().toISOString(),
          source: "console",
          type: "automation-interrupted",
          summary: "Automation interrupted",
          detail: JSON.stringify({ reason: "控制台重启时云端自动化仍在运行" }),
        },
        {
          id: "audit-regression-normal-shutdown",
          time: new Date().toISOString(),
          source: "app-server",
          type: "app-server-error",
          summary: "Codex app-server exited (SIGTERM)",
          detail: JSON.stringify({ signal: "SIGTERM" }),
        },
        {
          id: "audit-regression-running-shell",
          time: new Date().toISOString(),
          source: "app-server",
          type: "shell",
          summary: "shell inProgress: /bin/bash -lc 'codex doctor'",
          detail: JSON.stringify({ status: "inProgress" }),
        },
        {
          id: "audit-regression-systemd-deploy",
          time: new Date().toISOString(),
          source: "console",
          type: "terminal",
          summary: "terminal: sudo systemd-run --unit=codex-cloud-deploy-regression /bin/bash -lc 'set -euo pipefail'",
          detail: JSON.stringify({
            type: "commandExecution",
            command: "sudo systemd-run --unit=codex-cloud-deploy-regression /bin/bash -lc 'set -euo pipefail'",
            exitCode: 0,
          }),
        },
      ],
    }),
  );
  const staleManagedTemp = path.join(stateRoot, "automation-runs.json.999999.deadbeef.abcdef.tmp");
  const unmanagedTemp = path.join(stateRoot, "user-data.json.999999.deadbeef.abcdef.tmp");
  await fs.writeFile(staleManagedTemp, "stale partial state");
  await fs.writeFile(unmanagedTemp, "must remain");
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(codexShim, `#!/bin/sh\nexec "${process.execPath}" "${fakePath}"\n`, { mode: 0o755 });
  const start = () => spawn(process.execPath, [path.join(projectRoot, "server", "index.mjs")], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: String(port),
      CODEX_CLOUD_ROOT: cloudRoot,
      CODEX_WORKSPACE_ROOT: workspaceRoot,
      CODEX_STATE_ROOT: stateRoot,
      CODEX_HOME: codexHome,
      CODEX_CLOUD_WEBHOOK_TOKEN: "regression-token-123456",
      CODEX_PERSONAL_MODE: "disabled",
      CODEX_AUTOMATION_TRIGGER_RATE_MAX: "1",
      CODEX_AUTOMATION_TRIGGER_RATE_WINDOW_MS: "250",
      CODEX_TURN_TIMEOUT_MS: "300",
      CODEX_EXTERNAL_WRITE_TIMEOUT_MS: "120",
      CODEX_ALLOW_LOCAL_FALLBACK: "0",
      BENXING_SITE_ORIGIN: `http://127.0.0.1:${benxingPort}`,
      BENXING_SITES_BYPASS_BEARER_TOKEN: "regression-sites-bypass-token",
      FAKE_CAPTURE_PATH: capturePath,
      FAKE_QUEUE_COMPLETION_GATE: "1",
      PATH: `${binDir}:${process.env.PATH}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let child = start();
  const baseUrl = `http://127.0.0.1:${port}/`;
  try {
    await waitForOutput(child, /listening on/i);
    const relayToken = "a".repeat(64);
    const relayInput = await fetch(new URL(`/api/integrations/benxing/jobs/job-regression/inputs/input-regression?token=${relayToken}`, baseUrl));
    assert.equal(relayInput.status, 200);
    assert.equal(relayInput.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await relayInput.arrayBuffer()), generatedImageBytes);
    assert.equal(benxingRequests.at(-1)?.authorization, "Bearer regression-sites-bypass-token");
    const relayCallback = await jsonRequest(baseUrl, "/api/integrations/benxing/jobs/job-regression/complete", {
      method: "POST",
      headers: { "content-type": "application/json", "x-benxing-job-token": relayToken },
      body: JSON.stringify({ candidates: [{ title: "regression" }] }),
    });
    assert.equal(relayCallback.response.status, 200);
    assert.equal(benxingRequests.at(-1)?.jobToken, relayToken);
    assert.deepEqual(JSON.parse(benxingRequests.at(-1)?.body.toString("utf8")), { candidates: [{ title: "regression" }] });
    const multipartBody = Buffer.from("--regression\r\nContent-Disposition: form-data; name=\"audit\"\r\n\r\n{}\r\n--regression--\r\n");
    const relayMultipart = await fetch(new URL("/api/integrations/benxing/jobs/job-regression/complete", baseUrl), {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=regression", "x-benxing-job-token": relayToken },
      body: multipartBody,
    });
    assert.equal(relayMultipart.status, 200);
    assert.deepEqual(benxingRequests.at(-1)?.body, multipartBody);
    const publicRelayAttempt = await jsonRequest(baseUrl, `/api/integrations/benxing/jobs/job-regression/inputs/input-regression?token=${relayToken}`, {
      headers: { "x-forwarded-for": "203.0.113.10" },
    });
    assert.equal(publicRelayAttempt.response.status, 403);
    const release = await jsonRequest(baseUrl, "/api/release");
    assert.equal(release.response.status, 200);
    assert.equal(release.response.headers.get("cache-control"), "no-store");
    assert.equal(release.data.role, "console-api");
    assert.match(release.data.release.entrypoints["server/index.mjs"], /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(release.data).includes(projectRoot), false);
    assert.deepEqual((await jsonRequest(baseUrl, "/api/release")).data, release.data, "version is captured at startup");
    await assert.rejects(() => fs.stat(staleManagedTemp), /ENOENT/);
    assert.equal(await fs.readFile(unmanagedTemp, "utf8"), "must remain");
    let serializedStatus = "";
    let statusData = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const status = await jsonRequest(baseUrl, "/api/status");
      assert.equal(status.response.status, 200);
      statusData = status.data;
      serializedStatus = JSON.stringify(status.data);
      assert.equal(serializedStatus.includes("控制台重启时云端自动化仍在运行"), false);
      if (serializedStatus.includes("控制台维护期间中断，已自动归档")) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.equal(serializedStatus.includes("控制台重启时云端自动化仍在运行"), false);
    assert.equal(serializedStatus.includes("控制台维护期间中断，已自动归档"), true);
    assert.equal(serializedStatus.includes("/bin/bash -lc"), false);
    assert.equal(serializedStatus.includes("shell: codex doctor"), true);
    assert.equal(serializedStatus.includes("terminal: deploy cloud console release"), true);
    assert.ok(statusData.repos.some((repo) => repo.id === "_personal" && repo.kind === "personal" && repo.executionAvailable === false));
    const blockedPersonalChat = await jsonRequest(baseUrl, "/api/chat", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repoId: "_personal", message: "do not execute" }),
    });
    assert.equal(blockedPersonalChat.response.status, 503);
    const blockedPersonalAttachment = await jsonRequest(baseUrl, "/api/chat/stream", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repoId: "_personal", message: "", attachments: [{ path: ".codex-cloud/uploads/test.txt" }] }),
    });
    assert.equal(blockedPersonalAttachment.response.status, 503);
    const blockedPersonalWrite = await jsonRequest(baseUrl, "/api/files/write", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repoId: "_personal", path: "note.txt", content: "must not write" }),
    });
    assert.equal(blockedPersonalWrite.response.status, 403);
    const commandAudit = statusData.auditEvents.find((event) => event.id === "audit-regression-command-path");
    assert.ok(commandAudit);
    assert.equal(commandAudit.detail.includes(cloudRoot), false);
    assert.equal(JSON.parse(commandAudit.detail).command, "rg --files 隔离工作区");
    assert.equal(statusData.automations.some((automation) => automation.model === "gpt-5.5"), false);
    const queueSession = await jsonRequest(baseUrl, "/api/chat/sessions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoId: "sample-app", title: "Queue regression" }),
    });
    const queueSessionId = queueSession.data.activeSessionId;
    const prematureQueue = await jsonRequest(baseUrl, "/api/chat/queue", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoId: "sample-app", sessionId: queueSessionId, message: "must not start first" }),
    });
    assert.equal(prematureQueue.response.status, 409);
    const firstQueuedStream = await fetch(new URL("/api/chat/stream", baseUrl), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoId: "sample-app", sessionId: queueSessionId, message: "progress regression queue first" }),
    });
    assert.equal(firstQueuedStream.status, 200);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const active = await jsonRequest(baseUrl, `/api/chat/active?repoId=sample-app&sessionId=${queueSessionId}`);
      if (active.data.turn?.turnId) break;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    const enqueue = (message) => jsonRequest(baseUrl, "/api/chat/queue", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoId: "sample-app", sessionId: queueSessionId, message }),
    });
    const queued = await enqueue("queue regression next");
    assert.equal(queued.response.status, 202);
    const repeated = await enqueue("queue regression next");
    assert.equal(repeated.data.queuedTurn.id, queued.data.queuedTurn.id);
    const attachmentQueue = await jsonRequest(baseUrl, "/api/chat/queue", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoId: "sample-app", sessionId: queueSessionId, message: "attachment must not vanish", attachments: [{ path: "notes.txt" }] }),
    });
    assert.equal(attachmentQueue.response.status, 400);
    const conflicting = await enqueue("queue regression different");
    assert.equal(conflicting.response.status, 409);
    const bypassQueue = await jsonRequest(baseUrl, "/api/chat", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoId: "sample-app", sessionId: queueSessionId, message: "must not jump ahead" }),
    });
    assert.equal(bypassQueue.response.status, 409);
    const compactWhileQueued = await jsonRequest(baseUrl, "/api/codex/thread-compact", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoId: "sample-app", sessionId: queueSessionId }),
    });
    assert.equal(compactWhileQueued.response.status, 409);
    const queuedActive = await jsonRequest(baseUrl, `/api/chat/active?repoId=sample-app&sessionId=${queueSessionId}`);
    assert.equal(queuedActive.data.queuedTurn?.status, "queued");
    assert.equal(Object.hasOwn(queuedActive.data.queuedTurn, "message"), false);
    assert.equal(queuedActive.data.queuedTurn.preview, "queue regression next");
    const deleteQueuedSession = await jsonRequest(baseUrl, `/api/chat/sessions/${queueSessionId}?repoId=sample-app`, { method: "DELETE" });
    assert.equal(deleteQueuedSession.response.status, 409);
    const archiveQueuedSession = await jsonRequest(baseUrl, "/api/codex/thread-archive", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoId: "sample-app", sessionId: queueSessionId }),
    });
    assert.equal(archiveQueuedSession.response.status, 409);
    await fs.writeFile(capturePath + ".queue-release", "");
    await firstQueuedStream.text();
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const stored = JSON.parse(await fs.readFile(path.join(stateRoot, "chat-history.json"), "utf8"));
      if (!stored.sessions[queueSessionId]?.queuedTurn) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const queueRequests = (await fs.readFile(capturePath, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(queueRequests.filter((request) => request.method === "turn/start" && JSON.stringify(request.params).includes("queue regression next")).length, 1);
    const afterQueue = JSON.parse(await fs.readFile(path.join(stateRoot, "chat-history.json"), "utf8"));
    assert.equal(afterQueue.sessions[queueSessionId]?.queuedTurn, null);
    await fs.rm(capturePath + ".queue-release");
    const canceledSession = await jsonRequest(baseUrl, "/api/chat/sessions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoId: "sample-app", title: "Canceled queue regression" }),
    });
    const canceledSessionId = canceledSession.data.activeSessionId;
    const canceledStream = await fetch(new URL("/api/chat/stream", baseUrl), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoId: "sample-app", sessionId: canceledSessionId, message: "progress regression cancel queue first" }),
    });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const active = await jsonRequest(baseUrl, `/api/chat/active?repoId=sample-app&sessionId=${canceledSessionId}`);
      if (active.data.turn?.turnId) break;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    const pendingCancel = await jsonRequest(baseUrl, "/api/chat/queue", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoId: "sample-app", sessionId: canceledSessionId, message: "queue regression canceled" }),
    });
    assert.equal(pendingCancel.response.status, 202);
    const cancelQueue = await jsonRequest(baseUrl, "/api/chat/queue", {
      method: "DELETE", headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoId: "sample-app", sessionId: canceledSessionId }),
    });
    assert.equal(cancelQueue.response.status, 200);
    assert.equal(cancelQueue.data.queuedTurn.preview, "queue regression canceled");
    assert.equal(cancelQueue.data.draft.input, "queue regression canceled");
    await fs.writeFile(capturePath + ".queue-release", "");
    await canceledStream.text();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const canceledRequests = (await fs.readFile(capturePath, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(canceledRequests.some((request) => request.method === "turn/start" && JSON.stringify(request.params).includes("queue regression canceled")), false);
    assert.equal(statusData.automations.some((automation) => automation.id === "sample-research"), true);
    assert.equal(statusData.automations.some((automation) => automation.id === "sample-hourly"), true);
    assert.equal(
      (statusData?.attention?.items || []).some((item) => String(item.title || "").includes("exited (SIGTERM)")),
      false,
    );
    const models = await jsonRequest(baseUrl, "/api/codex/models");
    assert.equal(models.response.status, 200);
    assert.equal(models.response.headers.get("x-codex-model-list-cache"), "refreshed");
    assert.equal(models.data.models[0].id, "gpt-5.6-sol");
    assert.equal(models.data.models.find((model) => model.isDefault)?.id, "gpt-6-sol");
    assert.equal(models.data.models.some((model) => model.id === "gpt-5.5"), false);
    assert.ok(models.data.models[0].supportedReasoningEfforts.includes("max"));
    assert.ok(models.data.models[0].supportedReasoningEfforts.includes("ultra"));
    assert.equal(models.data.models.find((model) => model.id === "gpt-6-astra")?.displayName, "GPT-6 Astra");
    assert.deepEqual(models.data.models.find((model) => model.id === "gpt-6-astra")?.supportedReasoningEfforts, ["medium", "ultra"]);
    const generatedImage = await fetch(
      new URL(`/api/codex/generated-image?path=${encodeURIComponent(generatedImagePath)}`, baseUrl),
    );
    assert.equal(generatedImage.status, 200);
    assert.equal(generatedImage.headers.get("content-type"), "image/png");
    assert.equal(generatedImage.headers.get("x-codex-source"), "app-server");
    assert.deepEqual(Buffer.from(await generatedImage.arrayBuffer()), generatedImageBytes);
    const escapedGeneratedImage = await jsonRequest(
      baseUrl,
      `/api/codex/generated-image?path=${encodeURIComponent(outsideSecretPath)}`,
    );
    assert.equal(escapedGeneratedImage.response.status, 400);
    assert.equal(escapedGeneratedImage.data.source, "invalid-generated-image-path");
    const linkedGeneratedImage = await jsonRequest(
      baseUrl,
      `/api/codex/generated-image?path=${encodeURIComponent(path.join(generatedImagesRoot, "thread-regression", "outside.png"))}`,
    );
    assert.equal(linkedGeneratedImage.response.status, 400);
    assert.equal(linkedGeneratedImage.data.source, "invalid-generated-image-path");
    const escapedRead = await jsonRequest(
      baseUrl,
      `/api/files/read?repoId=sample-app&path=${encodeURIComponent("outside-link/secret.txt")}`,
    );
    assert.equal(escapedRead.response.status, 400);
    assert.equal(escapedRead.data.source, "invalid-repository-path");
    assert.equal(JSON.stringify(escapedRead.data).includes("must stay outside"), false);
    const rootListing = await jsonRequest(baseUrl, "/api/files/tree?repoId=sample-app&path=.");
    assert.equal(rootListing.response.status, 200);
    assert.equal(rootListing.data.entries.some((entry) => entry.name === "outside-link"), false);
    assert.equal(rootListing.data.entries.some((entry) => entry.name === "cyclic-link"), false);
    const escapedSearch = await jsonRequest(baseUrl, "/api/files/search?repoId=sample-app&q=secret");
    assert.equal(escapedSearch.response.status, 200);
    assert.equal(escapedSearch.data.entries.some((entry) => entry.path.includes("outside-link")), false);
    const cyclicRead = await jsonRequest(
      baseUrl,
      `/api/files/read?repoId=sample-app&path=${encodeURIComponent("cyclic-link")}`,
    );
    assert.equal(cyclicRead.response.status, 400);
    assert.match(cyclicRead.data.error, /cyclic symbolic links/i);
    const escapedWrite = await jsonRequest(baseUrl, "/api/files/write", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoId: "sample-app", path: "dangling-write-link", content: "escaped" }),
    });
    assert.equal(escapedWrite.response.status, 400);
    assert.equal(escapedWrite.data.source, "invalid-repository-path");
    await assert.rejects(() => fs.stat(danglingWriteTarget), /ENOENT/);
    const escapedUpload = await jsonRequest(baseUrl, "/api/uploads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repoId: "sample-app",
        files: [{ name: "escape.txt", type: "text/plain", dataUrl: "data:text/plain;base64,ZXNjYXBl" }],
      }),
    });
    assert.equal(escapedUpload.response.status, 400);
    assert.equal(escapedUpload.data.source, "invalid-repository-path");
    const escapedUploadDelete = await jsonRequest(baseUrl, "/api/uploads", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoId: "sample-app", paths: [".codex-cloud/uploads/test/outside-secret-link"] }),
    });
    assert.equal(escapedUploadDelete.response.status, 400);
    assert.equal(await fs.readFile(outsideSecretPath, "utf8"), "must stay outside the repository\n");
    const invalidAutomationMode = await jsonRequest(baseUrl, "/api/automations/sample-maintenance/delete", {
      method: "POST",
    });
    assert.equal(invalidAutomationMode.response.status, 400);
    assert.match(invalidAutomationMode.data.output, /pause or resume/i);
    const created = await jsonRequest(baseUrl, "/api/chat/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoId: "sample-app" }),
    });
    assert.equal(created.response.status, 200);
    const sessionId = created.data.activeSessionId;
    assert.equal(created.data.sessions.find((session) => session.id === sessionId)?.model, "gpt-6-sol");
    const personalSession = await jsonRequest(baseUrl, "/api/chat/sessions", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repoId: "_personal" }),
    });
    assert.equal(personalSession.response.status, 200);
    assert.equal(personalSession.data.sessions.find((session) => session.id === personalSession.data.activeSessionId)?.sandbox, "read-only");
    const personalRuntimePath = `/api/chat/sessions/${personalSession.data.activeSessionId}/runtime`;
    const personalRuntime = await jsonRequest(baseUrl, personalRuntimePath, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ repoId: "_personal", sandbox: "workspace-write", approval: "never" }) });
    assert.equal(personalRuntime.response.status, 200);
    assert.equal(personalRuntime.data.runtime.sandbox, "workspace-write");
    assert.equal(personalRuntime.data.runtime.approval, "on-request");
    const rejectedFullAccess = await jsonRequest(baseUrl, personalRuntimePath, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ repoId: "_personal", sandbox: "danger-full-access" }) });
    assert.equal(rejectedFullAccess.data.runtime.sandbox, "read-only");
    const apps = await jsonRequest(baseUrl, "/api/codex/apps?repoId=sample-app&refresh=1");
    assert.equal(apps.response.status, 200);
    assert.equal(apps.data.apps[0].callable, true);
    assert.equal(apps.data.apps[0].installUrl, "https://chatgpt.com/apps/mail/mail");
    const crossSpaceSelection = await jsonRequest(baseUrl, `/api/chat/sessions/${encodeURIComponent(personalSession.data.activeSessionId)}/select`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repoId: "sample-app" }),
    });
    assert.equal(crossSpaceSelection.response.status, 404);
    const personalExecution = await jsonRequest(baseUrl, "/api/chat/stream", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repoId: "_personal", message: "test" }),
    });
    assert.equal(personalExecution.response.status, 503);
    const personalWrite = await jsonRequest(baseUrl, "/api/files/write", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repoId: "_personal", path: "test.txt", content: "test" }),
    });
    assert.equal(personalWrite.response.status, 403);
    const personalTerminal = await jsonRequest(baseUrl, "/api/terminal/run", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repoId: "_personal", command: "pwd" }),
    });
    assert.equal(personalTerminal.response.status, 403);
    const personalPull = await jsonRequest(baseUrl, "/api/repos/_personal/pull", { method: "POST" });
    assert.equal(personalPull.response.status, 400);
    const invalidRepo = await jsonRequest(baseUrl, "/api/chat/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoId: "not-a-real-repository" }),
    });
    assert.equal(invalidRepo.response.status, 404);
    assert.equal(invalidRepo.data.source, "invalid-repository");
    const crossSiteMutation = await jsonRequest(baseUrl, "/api/chat/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://attacker.example", "sec-fetch-site": "cross-site" },
      body: JSON.stringify({ repoId: "sample-app" }),
    });
    assert.equal(crossSiteMutation.response.status, 403);
    const failedRead = await jsonRequest(baseUrl, "/api/chat/sessions?repoId=sample-app");
    assert.equal(failedRead.response.status, 503);
    assert.equal(failedRead.data.ok, false);
    const store = JSON.parse(await fs.readFile(path.join(stateRoot, "chat-history.json"), "utf8"));
    assert.ok(store.sessions[sessionId]);
    assert.equal(store.activeByRepo["sample-app"], sessionId);
    const explicitRead = await jsonRequest(baseUrl, `/api/chat/sessions?repoId=sample-app&sessionId=${encodeURIComponent(sessionId)}`);
    assert.equal(explicitRead.response.status, 200);
    assert.equal(explicitRead.data.activeSessionId, sessionId);
    assert.equal(explicitRead.data.degraded, true);

    const runtimeStore = JSON.parse(await fs.readFile(path.join(stateRoot, "chat-history.json"), "utf8"));
    runtimeStore.sessions[sessionId].codexSessionId = "thread-runtime-regression";
    runtimeStore.sessions[sessionId].model = "gpt-5.4-mini";
    runtimeStore.sessions[sessionId].reasoning = "low";
    runtimeStore.sessions[sessionId].sandbox = "danger-full-access";
    runtimeStore.sessions[sessionId].approval = "never";
    runtimeStore.sessions[sessionId].search = true;
    const previousActivity = "2026-09-01T00:00:00.000Z";
    runtimeStore.sessions[sessionId].updatedAt = previousActivity;
    await fs.writeFile(path.join(stateRoot, "chat-history.json"), JSON.stringify(runtimeStore));
    const primedThreadState = await jsonRequest(
      baseUrl,
      `/api/codex/thread-state?repoId=sample-app&sessionId=${encodeURIComponent(sessionId)}`,
    );
    assert.equal(primedThreadState.response.status, 200);
    assert.equal(primedThreadState.data.runtime.model, "gpt-5.4-mini");
    const refreshedStore = JSON.parse(await fs.readFile(path.join(stateRoot, "chat-history.json"), "utf8"));
    assert.deepEqual(refreshedStore, runtimeStore, "只读 thread-state 不改变活跃时间、草稿或会话排序来源");
    const readonlyThread = await jsonRequest(baseUrl, `/api/codex/thread-read?repoId=sample-app&sessionId=${encodeURIComponent(sessionId)}`);
    assert.equal(readonlyThread.response.status, 200);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(stateRoot, "chat-history.json"), "utf8")), runtimeStore,
      "官方元数据更新而 recencyAt 未变化时，不改会话活动时间");
    const runtimePatch = await jsonRequest(baseUrl, `/api/chat/sessions/${encodeURIComponent(sessionId)}/runtime`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repoId: "sample-app",
        model: "gpt-5.5",
        reasoning: "high",
        sandbox: "danger-full-access",
        approval: "never",
        search: true,
      }),
    });
    assert.equal(runtimePatch.response.status, 200);
    assert.equal(runtimePatch.data.runtime.model, "gpt-5.6-terra");
    assert.equal(runtimePatch.data.runtime.reasoning, "high");
    assert.equal(runtimePatch.data.appServerRuntime.model, "gpt-5.4-mini");
    assert.equal(runtimePatch.data.appliesOnNextTurn, true);
    const patchedStore = JSON.parse(await fs.readFile(path.join(stateRoot, "chat-history.json"), "utf8"));
    assert.notEqual(patchedStore.sessions[sessionId].updatedAt, previousActivity, "主动设置模型仍记录活跃时间");
    const runtimeStatePath = path.join(stateRoot, "chat-history.json");
    const beforeRace = await fs.readFile(runtimeStatePath, "utf8");
    const raceStore = JSON.parse(beforeRace);
    raceStore.sessions[sessionId].codexSessionId = "thread-settings-race";
    await fs.writeFile(runtimeStatePath, JSON.stringify(raceStore));
    const patchRuntime = (runtime) => jsonRequest(baseUrl, `/api/chat/sessions/${encodeURIComponent(sessionId)}/runtime`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoId: "sample-app", makeActive: false, ...runtime }),
    });
    const capturedRpc = async () => (await fs.readFile(capturePath, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
    const waitForRpc = async (predicate, after = 0) => {
      for (let attempt = 0; attempt < 150; attempt++) {
        if ((await capturedRpc()).slice(after).some(predicate)) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("模拟 Codex 未收到预期请求");
    };
    let firstSelection, secondSelection;
    try {
      firstSelection = patchRuntime({ model: "gpt-6-sol", reasoning: "medium" });
      await waitForRpc((item) => item.method === "thread/resume" && item.params.threadId === "thread-settings-race");
      secondSelection = patchRuntime({ model: "gpt-6-astra", reasoning: "ultra", search: false });
      await new Promise((resolve) => setTimeout(resolve, 80));
    } finally {
      await fs.writeFile(capturePath + ".runtime-patch-release", "release");
      const responses = await Promise.all([firstSelection, secondSelection].filter(Boolean));
      for (const result of responses) assert.equal(result.response.status, 200);
    }
    try {
      const afterRace = JSON.parse(await fs.readFile(runtimeStatePath, "utf8")).sessions[sessionId];
      assert.equal(afterRace.model, "gpt-6-astra", "慢旧 PATCH 不能在新选择完成后覆盖模型");
      assert.equal(afterRace.reasoning, "ultra");
      assert.equal(afterRace.search, false);
      const activeStore = JSON.parse(await fs.readFile(runtimeStatePath, "utf8"));
      Object.assign(activeStore.sessions[sessionId], { codexSessionId: "thread-regression", model: "gpt-6-sol", reasoning: "medium", search: true, pendingTurnRuntime: null });
      await fs.writeFile(runtimeStatePath, JSON.stringify(activeStore));
      const activeRpcStart = (await capturedRpc()).length;
      const activeStream = await fetch(new URL("/api/chat/stream", baseUrl), {
        method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(5_000),
        body: JSON.stringify({ repoId: "sample-app", sessionId, message: "progress regression runtime selection" }),
      });
      await waitForRpc((item) => item.method === "turn/start", activeRpcStart);
      const deniedPermissions = await patchRuntime({ sandbox: "read-only", approval: "on-request" });
      assert.equal(deniedPermissions.response.status, 409, "运行中的权限变更必须拒绝");
      const nextTurnSelection = await patchRuntime({ model: "gpt-6-astra", reasoning: "ultra", search: false });
      assert.equal(nextTurnSelection.response.status, 200);
      assert.equal(nextTurnSelection.data.appliesOnNextTurn, true);
      assert.equal(nextTurnSelection.data.appServerSynced, false, "活动任务不被 thread/resume 改动");
      await activeStream.text();
      const afterActive = JSON.parse(await fs.readFile(runtimeStatePath, "utf8")).sessions[sessionId];
      assert.equal(afterActive.model, "gpt-6-astra", "旧任务结束不能覆盖新选择");
      assert.equal(afterActive.reasoning, "ultra");
      assert.equal(afterActive.search, false);
      assert.ok(afterActive.pendingTurnRuntime);
      const nextRpcStart = (await capturedRpc()).length;
      const nextTurn = await jsonRequest(baseUrl, "/api/chat", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ repoId: "sample-app", sessionId, message: "outcome contract regression legacy no contract" }),
      });
      assert.equal(nextTurn.data.ok, true);
      const nextStart = (await capturedRpc()).slice(nextRpcStart).find((item) => item.method === "turn/start");
      assert.equal(nextStart.params.model, "gpt-6-astra");
      assert.equal(JSON.parse(await fs.readFile(runtimeStatePath, "utf8")).sessions[sessionId].pendingTurnRuntime, null);

      await fs.rm(capturePath + ".runtime-patch-release");
      const barrierStore = JSON.parse(await fs.readFile(runtimeStatePath, "utf8"));
      barrierStore.sessions[sessionId].codexSessionId = "thread-settings-race";
      await fs.writeFile(runtimeStatePath, JSON.stringify(barrierStore));
      const barrierRpcStart = (await capturedRpc()).length;
      let changingPermissions, waitingStream;
      try {
        changingPermissions = patchRuntime({ model: "gpt-6-sol", reasoning: "medium", sandbox: "read-only", approval: "on-request" });
        await waitForRpc((item) => item.method === "thread/resume", barrierRpcStart);
        const otherSession = await jsonRequest(baseUrl, personalRuntimePath, {
          method: "PATCH", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(1_500),
          body: JSON.stringify({ repoId: "_personal", search: false }),
        });
        assert.equal(otherSession.response.status, 200, "另一会话不能被当前设置锁阻塞");
        waitingStream = await fetch(new URL("/api/chat/stream", baseUrl), {
          method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(5_000),
          body: JSON.stringify({ repoId: "sample-app", sessionId, message: "outcome contract regression legacy no contract" }),
        });
        await new Promise((resolve) => setTimeout(resolve, 80));
        assert.equal((await capturedRpc()).slice(barrierRpcStart).some((item) => item.method === "turn/start"), false);
      } finally {
        await fs.writeFile(capturePath + ".runtime-patch-release", "release");
        if (changingPermissions) assert.equal((await changingPermissions).response.status, 200);
        if (waitingStream) await waitingStream.text();
      }
      const admittedStart = (await capturedRpc()).slice(barrierRpcStart).find((item) => item.method === "turn/start");
      assert.equal(admittedStart.params.model, "gpt-6-sol");
      assert.equal(admittedStart.params.sandboxPolicy.type, "readOnly", "任务采用锁内最新权限");
      assert.equal(admittedStart.params.approvalPolicy, "on-request");
    } finally {
      await fs.writeFile(runtimeStatePath, beforeRace);
    }
    const pendingThreadState = await jsonRequest(
      baseUrl,
      `/api/codex/thread-state?repoId=sample-app&sessionId=${encodeURIComponent(sessionId)}`,
    );
    assert.equal(pendingThreadState.response.status, 200);
    assert.equal(pendingThreadState.data.runtime.model, "gpt-5.6-terra");
    assert.equal(pendingThreadState.data.runtime.reasoning, "high");
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(stateRoot, "chat-history.json"), "utf8")), patchedStore,
      "刷新待应用模型不触碰会话时间或丢失 pendingTurnRuntime");
    await jsonRequest(baseUrl, `/api/codex/thread-read?repoId=sample-app&sessionId=${encodeURIComponent(sessionId)}`);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(stateRoot, "chat-history.json"), "utf8")), patchedStore,
      "较旧的官方 recencyAt 不覆盖用户刚修改模型的本地活动时间");
    const delayedStore = JSON.parse(await fs.readFile(path.join(stateRoot, "chat-history.json"), "utf8"));
    Object.assign(delayedStore.sessions[sessionId], { codexSessionId: "thread-runtime-delayed", model: "gpt-5.4-mini", reasoning: "low", pendingTurnRuntime: null });
    await fs.writeFile(path.join(stateRoot, "chat-history.json"), JSON.stringify(delayedStore));
    const delayedRead = jsonRequest(baseUrl, `/api/codex/thread-state?repoId=sample-app&sessionId=${encodeURIComponent(sessionId)}`);
    let runtimeReadStarted = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const requests = (await fs.readFile(capturePath, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
      if (requests.some((item) => item.method === "thread/read" && item.params?.threadId === "thread-runtime-delayed")) {
        runtimeReadStarted = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    let latestRuntimeStore;
    try {
      assert.ok(runtimeReadStarted, "先启动旧运行时读取，再交错修改设置");
      const concurrentPatch = await jsonRequest(baseUrl, `/api/chat/sessions/${encodeURIComponent(sessionId)}/runtime`, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ repoId: "sample-app", model: "gpt-5.6-sol", reasoning: "max", sandbox: "workspace-write", approval: "on-request", search: false }),
      });
      assert.equal(concurrentPatch.response.status, 200);
      latestRuntimeStore = JSON.parse(await fs.readFile(path.join(stateRoot, "chat-history.json"), "utf8"));
    } finally {
      await fs.writeFile(capturePath + ".runtime-read-release", "release");
    }
    const lateRuntimeResponse = await delayedRead;
    assert.equal(lateRuntimeResponse.response.status, 200);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(stateRoot, "chat-history.json"), "utf8")), latestRuntimeStore,
      "迟到的 HTTP 观察不能覆盖模型、推理、权限、搜索、pending 或会话时间");
    assert.equal(lateRuntimeResponse.data.runtime.model, "gpt-5.6-sol");
    assert.equal(lateRuntimeResponse.data.runtime.reasoning, "max");
    assert.equal(lateRuntimeResponse.data.runtime.sandbox, "workspace-write");
    latestRuntimeStore.sessions[sessionId].codexSessionId = "thread-runtime-regression";
    await fs.writeFile(path.join(stateRoot, "chat-history.json"), JSON.stringify(latestRuntimeStore));
    const gpt56RuntimePatch = await jsonRequest(baseUrl, `/api/chat/sessions/${encodeURIComponent(sessionId)}/runtime`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repoId: "sample-app",
        model: "gpt-5.6-sol",
        reasoning: "max",
        sandbox: "danger-full-access",
        approval: "never",
        search: true,
      }),
    });
    assert.equal(gpt56RuntimePatch.response.status, 200);
    assert.equal(gpt56RuntimePatch.data.runtime.model, "gpt-5.6-sol");
    assert.equal(gpt56RuntimePatch.data.runtime.reasoning, "max");

    const timedOutTurn = await fetch(new URL("/api/chat/stream", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoId: "sample-app", sessionId, message: "timeout regression" }),
    });
    assert.equal(timedOutTurn.status, 200);
    const timedOutBody = await timedOutTurn.text();
    assert.match(timedOutBody, /event: accepted\n/);
    assert.match(timedOutBody, /timed out after/i);
    const capturedRequests = (await fs.readFile(capturePath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const runtimeResume = capturedRequests.find(
      (request) =>
        request.method === "thread/resume" &&
        request.params?.threadId === "thread-runtime-regression" &&
        request.params?.model === "gpt-5.6-sol",
    );
    assert.ok(runtimeResume);
    assert.match(runtimeResume.params.developerInstructions, /authoritative model selected by the console/i);
    assert.match(runtimeResume.params.developerInstructions, /"gpt-5\.6-sol"/);
    assert.match(runtimeResume.params.developerInstructions, /generic model aliases and concrete model variants/i);
    assert.match(runtimeResume.params.developerInstructions, /Do not edit ~\/\.codex\/config\.toml/i);
    const inactiveAfterTimeout = await jsonRequest(baseUrl, `/api/chat/active?repoId=sample-app&sessionId=${encodeURIComponent(sessionId)}`);
    assert.equal(inactiveAfterTimeout.response.status, 200);
    assert.equal(inactiveAfterTimeout.data.turn, null);

    const externalRead = await jsonRequest(baseUrl, "/api/chat", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repoId: "sample-app", sessionId, message: "external write regression read only" }),
    });
    assert.equal(externalRead.data.ok, true);
    const externalSuccess = await jsonRequest(baseUrl, "/api/chat", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repoId: "sample-app", sessionId, message: "external write regression success no app context" }),
    });
    assert.equal(externalSuccess.data.ok, true);
    let externalStore = JSON.parse(await fs.readFile(path.join(stateRoot, "chat-history.json"), "utf8"));
    assert.equal(externalStore.sessions[sessionId].externalActionReview, null);

    const externalTimeout = await jsonRequest(baseUrl, "/api/chat", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repoId: "sample-app", sessionId, message: "external write regression timeout" }),
    });
    assert.equal(externalTimeout.data.ok, false);
    externalStore = JSON.parse(await fs.readFile(path.join(stateRoot, "chat-history.json"), "utf8"));
    const review = externalStore.sessions[sessionId].externalActionReview;
    assert.equal(review.server, "connected-calendar");
    assert.deepEqual(review.actions.map((action) => action.status), ["inProgress"]);
    assert.match(review.reason, /勿直接重试/);
    const blockedExternalRetry = await jsonRequest(baseUrl, "/api/chat", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repoId: "sample-app", sessionId, message: "external write regression success" }),
    });
    assert.equal(blockedExternalRetry.response.status, 409);
    const staleReviewAck = await jsonRequest(baseUrl, `/api/chat/sessions/${sessionId}/external-action-review/acknowledge`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repoId: "sample-app", reviewId: "wrong-review" }),
    });
    assert.equal(staleReviewAck.response.status, 409);
    const reviewAck = await jsonRequest(baseUrl, `/api/chat/sessions/${sessionId}/external-action-review/acknowledge`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repoId: "sample-app", reviewId: review.id }),
    });
    assert.equal(reviewAck.response.status, 200);
    externalStore = JSON.parse(await fs.readFile(path.join(stateRoot, "chat-history.json"), "utf8"));
    assert.equal(externalStore.sessions[sessionId].externalActionReview, null);

    const externalToolFailure = await jsonRequest(baseUrl, "/api/chat", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repoId: "sample-app", sessionId, message: "external write regression tool failure" }),
    });
    assert.equal(externalToolFailure.data.ok, false);
    externalStore = JSON.parse(await fs.readFile(path.join(stateRoot, "chat-history.json"), "utf8"));
    assert.ok(externalStore.sessions[sessionId].externalActionReview);
    const failureAck = await jsonRequest(baseUrl, `/api/chat/sessions/${sessionId}/external-action-review/acknowledge`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repoId: "sample-app", reviewId: externalStore.sessions[sessionId].externalActionReview.id }),
    });
    assert.equal(failureAck.response.status, 200);

    const matchedRuntimeStore = JSON.parse(await fs.readFile(path.join(stateRoot, "chat-history.json"), "utf8"));
    matchedRuntimeStore.sessions[sessionId].codexSessionId = "thread-runtime-matched";
    matchedRuntimeStore.sessions[sessionId].model = "gpt-5.4-mini";
    matchedRuntimeStore.sessions[sessionId].reasoning = "low";
    matchedRuntimeStore.sessions[sessionId].pendingTurnRuntime = null;
    await fs.writeFile(path.join(stateRoot, "chat-history.json"), JSON.stringify(matchedRuntimeStore));
    const matchedRuntimePatch = await jsonRequest(baseUrl, `/api/chat/sessions/${encodeURIComponent(sessionId)}/runtime`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repoId: "sample-app",
        model: "gpt-5.5",
        reasoning: "high",
        sandbox: "danger-full-access",
        approval: "never",
        search: true,
      }),
    });
    assert.equal(matchedRuntimePatch.response.status, 200);
    assert.equal(matchedRuntimePatch.data.appServerRuntime.model, "gpt-5.6-terra");
    assert.equal(matchedRuntimePatch.data.appServerRuntime.reasoning, "high");
    assert.equal(matchedRuntimePatch.data.appliesOnNextTurn, true);

    const uploadRelative = ".codex-cloud/uploads/test/regression.txt";
    const uploadAbsolute = path.join(repoRoot, uploadRelative);
    await fs.writeFile(uploadAbsolute, "cleanup me\n");
    const draft = await jsonRequest(baseUrl, `/api/chat/sessions/${encodeURIComponent(sessionId)}/draft`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repoId: "sample-app",
        input: "",
        attachments: [{ name: "regression.txt", path: uploadRelative, absolutePath: uploadAbsolute, mimeType: "text/plain", size: 11, kind: "file" }],
      }),
    });
    assert.equal(draft.response.status, 200);
    assert.equal(draft.data.draft.revision, 1);
    const staleDraft = await jsonRequest(baseUrl, `/api/chat/sessions/${sessionId}/draft`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoId: "sample-app", input: "stale", expectedRevision: 0 }),
    });
    assert.equal(staleDraft.response.status, 409);
    const unchangedDraft = await jsonRequest(baseUrl, `/api/chat/sessions/${sessionId}/draft?repoId=sample-app`);
    assert.equal(unchangedDraft.data.draft.input, "");
    const editedDraft = await jsonRequest(baseUrl, `/api/chat/sessions/${sessionId}/draft`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoId: "sample-app", input: "latest", attachments: [], expectedRevision: 1 }),
    });
    assert.equal(editedDraft.response.status, 200);
    const lateUpload = await jsonRequest(baseUrl, `/api/chat/sessions/${sessionId}/draft/attachments`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoId: "sample-app", attachments: draft.data.draft.attachments }),
    });
    assert.equal(lateUpload.response.status, 200);
    assert.equal(lateUpload.data.draft.input, "latest");
    assert.equal(lateUpload.data.draft.attachments.length, 1);
    const readFile = await jsonRequest(baseUrl, `/api/files/read?repoId=sample-app&path=${encodeURIComponent(uploadRelative)}`);
    await fs.writeFile(uploadAbsolute, "new agent content");
    const staleFileWrite = await jsonRequest(baseUrl, "/api/files/write", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoId: "sample-app", path: uploadRelative, content: "stale browser content", expectedHash: readFile.data.contentHash }),
    });
    assert.equal(staleFileWrite.response.status, 409);
    assert.equal(await fs.readFile(uploadAbsolute, "utf8"), "new agent content");
    const deleted = await jsonRequest(baseUrl, `/api/chat/sessions/${encodeURIComponent(sessionId)}?repoId=sample-app`, { method: "DELETE" });
    assert.equal(deleted.response.status, 200);
    assert.equal(deleted.data.deletedSessionId, sessionId);
    assert.deepEqual(deleted.data.uploadCleanup.errors, []);
    await assert.rejects(() => fs.stat(uploadAbsolute), /ENOENT/);

    const bearer = await jsonRequest(baseUrl, "/api/automations/not-real/webhook", {
      method: "POST",
      headers: { authorization: "Bearer regression-token-123456", "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(bearer.response.status, 404, "Bearer now authenticates the same scoped token; unknown automation remains unavailable");
    const tokenHeader = await jsonRequest(baseUrl, "/api/automations/not-real/webhook", {
      method: "POST",
      headers: { "x-codex-cloud-token": "regression-token-123456", "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(tokenHeader.response.status, 404);
    const newClient = await jsonRequest(baseUrl, "/api/clients", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "regression-service", automationIds: ["sample-on-demand"] }),
    });
    assert.equal(newClient.response.status, 201);
    assert.equal(JSON.stringify(newClient.data.client).includes(newClient.data.token), false);
    const scopedHeaders = { "x-codex-cloud-token": newClient.data.token, "content-type": "application/json" };
    const outOfScope = await jsonRequest(baseUrl, "/api/automations/sample-maintenance/webhook", {
      method: "POST", headers: { ...scopedHeaders, "idempotency-key": "scoped-test-0001" }, body: JSON.stringify({ worktree: false }),
    });
    assert.equal(outOfScope.response.status, 401);
    const missingKey = await jsonRequest(baseUrl, "/api/automations/sample-on-demand/webhook", {
      method: "POST", headers: scopedHeaders, body: JSON.stringify({ prompt: "scoped fake task", worktree: false }),
    });
    assert.equal(missingKey.response.status, 400);
    const repoCwdDenied = await jsonRequest(baseUrl, "/api/automations/sample-on-demand/webhook", {
      method: "POST", headers: { ...scopedHeaders, "idempotency-key": "scoped-repo-cwd-denied-0001" },
      body: JSON.stringify({ prompt: "scoped fake task", worktree: false }),
    });
    assert.equal(repoCwdDenied.response.status, 400);
    assert.match(repoCwdDenied.data.error, /detached worktree/);
    const scopedPrompt = "outcome contract regression legacy no contract";
    const scopedBody = JSON.stringify({ prompt: scopedPrompt, model: "gpt-6-astra", reasoning: "ultra", search: false });
    for (const input of [{ sessionId: "existing-console-chat" }, { search: "false" }, { model: {} }, { reasoning: "typo" }, { runner: "shell" }, { sandbox: "danger-full-access" }]) {
      const invalidTrigger = await jsonRequest(baseUrl, "/api/automations/sample-on-demand/webhook", {
        method: "POST", headers: { ...scopedHeaders, "idempotency-key": "scoped-invalid-body-0001" }, body: JSON.stringify(input),
      });
      assert.equal(invalidTrigger.response.status, 400, JSON.stringify(invalidTrigger.data));
    }
    const clientTrigger = await jsonRequest(baseUrl, "/api/automations/sample-on-demand/webhook", {
      method: "POST", headers: { ...scopedHeaders, "idempotency-key": "scoped-test-0001" }, body: scopedBody,
    });
    assert.equal(clientTrigger.response.status, 200);
    assert.equal(clientTrigger.data.run.clientId, newClient.data.client.id);
    assert.equal(clientTrigger.data.run.resultPath, `/api/automations/sample-on-demand/runs/${clientTrigger.data.run.id}`);
    assert.equal("prompt" in clientTrigger.data.run, false);
    assert.equal("worktreePath" in clientTrigger.data.run, false);
    assert.equal("sessionId" in clientTrigger.data.run, false);
    const scopedResult = await jsonRequest(baseUrl, clientTrigger.data.run.resultPath, { headers: scopedHeaders });
    assert.equal(scopedResult.response.status, 200);
    assert.equal(scopedResult.data.run.id, clientTrigger.data.run.id);
    assert.equal("prompt" in scopedResult.data.run, false);
    assert.equal("worktreePath" in scopedResult.data.run, false);
    let scopedCompleted;
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const result = await jsonRequest(baseUrl, clientTrigger.data.run.resultPath, { headers: scopedHeaders });
      scopedCompleted = result.data.run;
      if (scopedCompleted?.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(scopedCompleted?.status, "completed");
    const completedProgress = await jsonRequest(baseUrl, clientTrigger.data.run.resultPath, { headers: scopedHeaders });
    assert.equal(completedProgress.response.status, 200);
    const integrationResult = await runExternalClient({ command: "status", origin: baseUrl, token: newClient.data.token, automationId: "sample-on-demand", runId: clientTrigger.data.run.id });
    assert.equal(integrationResult.status, "completed");
    assert.equal(integrationResult.model, "gpt-6-astra");
    assert.ok(completedProgress.data.eventCursor >= 1);
    assert.equal(completedProgress.data.run.eventCursor, completedProgress.data.eventCursor);
    assert.ok(completedProgress.data.events.some((event) => event.type === "queued"));
    assert.ok(completedProgress.data.events.every((event) => !Object.hasOwn(event, "text")));
    const noNewProgress = await jsonRequest(baseUrl, `${clientTrigger.data.run.resultPath}?after=${completedProgress.data.eventCursor}`, { headers: scopedHeaders });
    assert.equal(noNewProgress.data.events.length, 0);
    assert.equal(noNewProgress.data.eventGap, false);
    const invalidCursor = await jsonRequest(baseUrl, `${clientTrigger.data.run.resultPath}?after=bad`, { headers: scopedHeaders });
    assert.equal(invalidCursor.response.status, 400);
    const originalClientRun = (JSON.parse(await fs.readFile(path.join(stateRoot, "automation-runs.json"), "utf8"))).runs.find((run) => run.id === clientTrigger.data.run.id);
    assert.notEqual(originalClientRun.worktreePath, repoRoot);
    assert.equal(originalClientRun.model, "gpt-6-astra");
    assert.equal(originalClientRun.reasoning, "ultra");
    const externalThreadStart = (await fs.readFile(capturePath, "utf8")).trim().split("\n").map(JSON.parse)
      .find((request) => request.method === "thread/start" && request.params.cwd === originalClientRun.worktreePath);
    assert.equal(externalThreadStart?.params.model, "gpt-6-astra");
    assert.equal(externalThreadStart?.params.config.model_reasoning_effort, "ultra");
    assert.equal(externalThreadStart?.params.config.tools.web_search, false);
    const modelClient = await jsonRequest(baseUrl, "/api/clients", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "model-api-regression", automationIds: ["sample-on-demand"] }),
    });
    const modelPath = "/api/automations/sample-on-demand/v1/chat/completions";
    const modelBody = { model: "gpt-6-sol", reasoning_effort: "high", messages: [{ role: "system", content: "只用中文" }, { role: "user", content: "model api regression" }] };
    const modelHeaders = { authorization: `Bearer ${modelClient.data.token}`, "content-type": "application/json", "idempotency-key": "model-api-regression-0001", origin: "https://external-service.example" };
    const discoveryBase = "/api/automations/sample-on-demand/v1";
    assert.equal((await jsonRequest(baseUrl, `${discoveryBase}/models`)).response.status, 401);
    assert.equal((await jsonRequest(baseUrl, `${discoveryBase}/models`, { headers: { authorization: "Bearer regression-token-123456" } })).response.status, 401);
    assert.equal((await jsonRequest(baseUrl, "/api/automations/sample-hourly/v1/models", { headers: modelHeaders })).response.status, 401);
    const discovered = await jsonRequest(baseUrl, `${discoveryBase}/models`, { headers: modelHeaders });
    assert.equal(discovered.response.status, 200);
    assert.ok(discovered.data.data.some((model) => model.id === "gpt-6-sol"));
    const capabilities = await jsonRequest(baseUrl, `${discoveryBase}/capabilities`, { headers: modelHeaders });
    assert.equal(capabilities.response.status, 200);
    assert.equal(capabilities.data.features.structured_output, true);
    assert.equal(capabilities.data.limits.task_queue.max_queued, 32);
    assert.equal(capabilities.data.features.artifact_download, true);
    assert.equal(capabilities.data.limits.result_storage.reservation_bytes_per_run, 20 * 1024 * 1024);
    const missingModelToken = await jsonRequest(baseUrl, modelPath, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(modelBody) });
    assert.equal(missingModelToken.response.status, 401);
    assert.equal(missingModelToken.data.error.type, "authentication_error");
    const modelComplete = await jsonRequest(baseUrl, modelPath, { method: "POST", headers: modelHeaders, body: JSON.stringify(modelBody) });
    assert.equal(modelComplete.response.status, 200, JSON.stringify(modelComplete.data));
    assert.equal(modelComplete.data.choices[0].message.content, "接口验收通过");
    assert.equal(modelComplete.data.usage.total_tokens, 130);
    const modelRunId = modelComplete.response.headers.get("x-codex-cloud-run-id");
    const modelRun = (JSON.parse(await fs.readFile(path.join(stateRoot, "automation-runs.json"), "utf8"))).runs.find((run) => run.id === modelRunId);
    assert.equal(modelRun.clientId, modelClient.data.client.id);
    assert.equal(modelRun.status, "completed");
    assert.equal(modelRun.worktreePolicy, "detached-worktree");
    assert.notEqual(modelRun.worktreePath, originalClientRun.worktreePath);
    assert.equal(modelRun.model, "gpt-6-sol");
    assert.equal(modelRun.reasoning, "high");
    const modelReplay = await jsonRequest(baseUrl, modelPath, { method: "POST", headers: modelHeaders, body: JSON.stringify(modelBody) });
    assert.equal(modelReplay.data.id, modelComplete.data.id);
    const modelConflict = await jsonRequest(baseUrl, modelPath, { method: "POST", headers: modelHeaders, body: JSON.stringify({ ...modelBody, reasoning_effort: "low" }) });
    assert.equal(modelConflict.response.status, 409);
    const modelStream = await fetch(new URL(modelPath, baseUrl), { method: "POST", headers: modelHeaders, body: JSON.stringify({ ...modelBody, stream: true, stream_options: { include_usage: true } }) });
    const modelStreamRaw = await modelStream.text();
    assert.match(modelStreamRaw, /接口验收通过/);
    assert.match(modelStreamRaw, /\[DONE\]/);
    assert.match(modelStreamRaw, /"total_tokens":130/);
    const longHeaders = { ...modelHeaders, "idempotency-key": "model-api-long-0001" };
    const longBody = { ...modelBody, messages: [{ role: "user", content: "model api regression long output" }] };
    const longFirst = await jsonRequest(baseUrl, modelPath, { method: "POST", headers: longHeaders, body: JSON.stringify(longBody) });
    assert.equal(longFirst.data.choices[0].message.content, "验收".repeat(2500));
    const longReplay = await jsonRequest(baseUrl, modelPath, { method: "POST", headers: longHeaders, body: JSON.stringify(longBody) });
    assert.equal(longReplay.data.choices[0].message.content, longFirst.data.choices[0].message.content);
    const schema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false };
    const structuredBody = { ...modelBody, response_format: { type: "json_schema", json_schema: { name: "answer", schema, strict: true } } };
    const structuredHeaders = { ...modelHeaders, "idempotency-key": "model-api-structured-0001" };
    const structured = await jsonRequest(baseUrl, modelPath, { method: "POST", headers: structuredHeaders, body: JSON.stringify(structuredBody) });
    assert.equal(structured.response.status, 200, JSON.stringify(structured.data));
    assert.deepEqual(JSON.parse(structured.data.choices[0].message.content), { answer: "结构化验收通过" });
    const structuredId = structured.response.headers.get("x-codex-cloud-run-id");
    const structuredRun = (JSON.parse(await fs.readFile(path.join(stateRoot, "automation-runs.json"), "utf8"))).runs.find(run => run.id === structuredId);
    assert.equal(structuredRun.structuredOutput.status, "validated");
    const structuredRpc = (await fs.readFile(capturePath, "utf8")).trim().split("\n").map(JSON.parse).find(request => request.method === "turn/start" && request.params.outputSchema);
    assert.deepEqual(structuredRpc.params.outputSchema, schema);
    const structuredReplay = await jsonRequest(baseUrl, modelPath, { method: "POST", headers: structuredHeaders, body: JSON.stringify(structuredBody) });
    assert.deepEqual(structuredReplay.data, structured.data);
    const largeStructured = await jsonRequest(baseUrl, modelPath, { method: "POST", headers: { ...structuredHeaders, "idempotency-key": "model-api-structured-large-0001" }, body: JSON.stringify({ ...structuredBody, messages: [{ role: "user", content: "model api regression large structured output" }] }) });
    assert.equal(largeStructured.response.status, 200);
    assert.equal(JSON.parse(largeStructured.data.choices[0].message.content).answer, "验收".repeat(2500));
    const changedSchema = structuredClone(structuredBody); changedSchema.response_format.json_schema.schema.description = "different request";
    assert.equal((await jsonRequest(baseUrl, modelPath, { method: "POST", headers: structuredHeaders, body: JSON.stringify(changedSchema) })).response.status, 409);
    const invalidBody = { ...structuredBody, messages: [{ role: "user", content: "model api regression invalid schema result" }] };
    const invalidStructured = await jsonRequest(baseUrl, modelPath, { method: "POST", headers: { ...structuredHeaders, "idempotency-key": "model-api-structured-invalid-0001" }, body: JSON.stringify(invalidBody) });
    assert.equal(invalidStructured.response.status, 502);
    assert.equal(invalidStructured.data.error.code, "invalid_structured_output");
    const invalidStream = await fetch(new URL(modelPath, baseUrl), { method: "POST", headers: { ...structuredHeaders, "idempotency-key": "model-api-structured-invalid-0002" }, body: JSON.stringify({ ...invalidBody, stream: true }) });
    const invalidRaw = await invalidStream.text();
    assert.match(invalidRaw, /invalid_structured_output/); assert.doesNotMatch(invalidRaw, /private non-JSON|\[DONE\]/);
    const asyncStructured = await jsonRequest(baseUrl, "/api/automations/sample-on-demand/webhook", { method: "POST", headers: { "x-codex-cloud-token": modelClient.data.token, "content-type": "application/json", "idempotency-key": "async-structured-0001" }, body: JSON.stringify({ prompt: "model api regression", model: "gpt-6-sol", outputSchema: schema }) });
    assert.equal(asyncStructured.response.status, 200);
    const asyncResult = await runExternalClient({ command: "status", origin: baseUrl, token: modelClient.data.token, automationId: "sample-on-demand", runId: asyncStructured.data.run.id, wait: true, pollMs: 100, timeoutMs: 10000 });
    assert.equal(asyncResult.structuredOutput.status, "validated");
    assert.equal(asyncResult.structuredOutput.data.answer, "结构化验收通过");
    const anthropicHeaders = { "x-api-key": modelClient.data.token, "content-type": "application/json", "idempotency-key": "model-api-anthropic-0001", "anthropic-version": "2023-06-01", "x-codex-cloud-allow-unbounded-output": "true" };
    const anthropicPath = "/api/automations/sample-on-demand/v1/messages";
    const anthropicBody = { model: "gpt-6-sol", messages: [{ role: "user", content: "model api regression" }], max_tokens: 1024 };
    const anthropicResult = await jsonRequest(baseUrl, anthropicPath, { method: "POST", headers: anthropicHeaders, body: JSON.stringify(anthropicBody) });
    assert.equal(anthropicResult.response.status, 200);
    assert.equal(anthropicResult.data.content[0].text, "接口验收通过");
    assert.equal(anthropicResult.data.usage.output_tokens, 30);
    assert.equal(anthropicResult.response.headers.get("x-codex-cloud-output-limit"), "unsupported-acknowledged");
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
    const bluePng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC";
    const imageHeaders = { ...modelHeaders, "idempotency-key": "model-api-images-0001" };
    const imageBody = { ...modelBody, messages: [{ role: "user", content: [
      { type: "text", text: "model api regression compare images" },
      { type: "image_url", image_url: { url: `data:image/png;base64,${png}`, detail: "auto" } },
      { type: "image_url", image_url: { url: `data:image/png;base64,${bluePng}` } },
    ] }] };
    const imagesFirst = await jsonRequest(baseUrl, modelPath, { method: "POST", headers: imageHeaders, body: JSON.stringify(imageBody) });
    assert.equal(imagesFirst.response.status, 200, JSON.stringify(imagesFirst.data));
    assert.equal(imagesFirst.data.choices[0].message.content, "接口验收通过");
    const capturedImages = (await fs.readFile(capturePath, "utf8")).trim().split("\n").map(JSON.parse).filter((item) => item.method === "turn/start" && item.params.input.some((block) => block.type === "image")).at(-1);
    assert.deepEqual(capturedImages.params.input.filter((block) => block.type === "image"), [
      { type: "image", url: `data:image/png;base64,${png}`, detail: "auto" },
      { type: "image", url: `data:image/png;base64,${bluePng}`, detail: "auto" },
    ]);
    const imagesRun = (JSON.parse(await fs.readFile(path.join(stateRoot, "automation-runs.json"), "utf8"))).runs.find((run) => run.id === imagesFirst.response.headers.get("x-codex-cloud-run-id"));
    assert.equal(imagesRun.prompt.includes(png), false);
    assert.match(imagesRun.prompt, /"sha256"/);
    const imagesReplay = await jsonRequest(baseUrl, modelPath, { method: "POST", headers: imageHeaders, body: JSON.stringify(imageBody) });
    assert.equal(imagesReplay.data.id, imagesFirst.data.id);
    const changedImageBody = structuredClone(imageBody);
    changedImageBody.messages[0].content[1].image_url.url = `data:image/png;base64,${bluePng}`;
    const imagesConflict = await jsonRequest(baseUrl, modelPath, { method: "POST", headers: imageHeaders, body: JSON.stringify(changedImageBody) });
    assert.equal(imagesConflict.response.status, 409);
    const anthropicImage = await jsonRequest(baseUrl, anthropicPath, { method: "POST", headers: { ...anthropicHeaders, "idempotency-key": "model-api-images-anthropic-0001" }, body: JSON.stringify({ ...anthropicBody, messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: png } }, { type: "text", text: "model api regression" },
    ] }] }) });
    assert.equal(anthropicImage.response.status, 200, JSON.stringify(anthropicImage.data));
    assert.equal(anthropicImage.data.content[0].text, "接口验收通过");
    const beforeInvalidImages = (JSON.parse(await fs.readFile(path.join(stateRoot, "automation-runs.json"), "utf8"))).runs.length;
    const invalidImageBody = structuredClone(imageBody);
    invalidImageBody.messages[0].content[1].image_url.url = "http://169.254.169.254/latest/meta-data";
    const invalidImages = await jsonRequest(baseUrl, modelPath, { method: "POST", headers: { ...modelHeaders, "idempotency-key": "model-api-bad-image-0001" }, body: JSON.stringify(invalidImageBody) });
    assert.equal(invalidImages.response.status, 400);
    assert.equal((JSON.parse(await fs.readFile(path.join(stateRoot, "automation-runs.json"), "utf8"))).runs.length, beforeInvalidImages);
    const badJson = await jsonRequest(baseUrl, anthropicPath, { method: "POST", headers: anthropicHeaders, body: "{not json" });
    assert.equal(badJson.response.status, 400);
    assert.equal(badJson.data.type, "error");
    assert.equal(badJson.data.error.type, "invalid_request_error");
    const hugeBody = await jsonRequest(baseUrl, modelPath, { method: "POST", headers: modelHeaders, body: JSON.stringify({ ...modelBody, ignored: "x".repeat(modelApiJsonLimit) }) });
    assert.equal(hugeBody.response.status, 413);
    const unauthenticatedHugeBody = await jsonRequest(baseUrl, modelPath, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ignored: "x".repeat(modelApiJsonLimit) }) });
    assert.equal(unauthenticatedHugeBody.response.status, 401);
    const modelOutOfScope = await jsonRequest(baseUrl, "/api/automations/sample-hourly/v1/chat/completions", { method: "POST", headers: modelHeaders, body: JSON.stringify(modelBody) });
    assert.equal(modelOutOfScope.response.status, 401);
    const responsesPath = "/api/automations/sample-on-demand/v1/responses";
    const responsesBody = { model: "gpt-6-sol", input: "model api regression generated output", tools: [{ type: "image_generation" }], store: false };
    const responsesHeaders = { ...modelHeaders, "idempotency-key": "model-api-responses-output-0001" };
    const outputResponse = await jsonRequest(baseUrl, responsesPath, { method: "POST", headers: responsesHeaders, body: JSON.stringify(responsesBody) });
    assert.equal(outputResponse.response.status, 200, JSON.stringify(outputResponse.data));
    assert.equal(outputResponse.data.output.find((item) => item.type === "image_generation_call").result, png);
    assert.equal(outputResponse.data.usage.total_tokens, 130);
    const streamedResponse = await fetch(new URL(responsesPath, baseUrl), { method: "POST", headers: responsesHeaders, body: JSON.stringify({ ...responsesBody, stream: true }) });
    const streamedRaw = await streamedResponse.text();
    assert.match(streamedRaw, /event: response.completed/);
    assert.ok(streamedRaw.includes(png));
    const outputRun = (JSON.parse(await fs.readFile(path.join(stateRoot, "automation-runs.json"), "utf8"))).runs.find((run) => run.id === outputResponse.response.headers.get("x-codex-cloud-run-id"));
    assert.equal(JSON.stringify(outputRun).includes(png), false);
    const generationsPath = "/api/automations/sample-on-demand/v1/images/generations";
    const generationsBody = { model: "gpt-6-sol", prompt: "model api regression generated output", response_format: "b64_json" };
    const generationsHeaders = { ...modelHeaders, "idempotency-key": "model-api-generations-output-0001" };
    const generation = await jsonRequest(baseUrl, generationsPath, { method: "POST", headers: generationsHeaders, body: JSON.stringify(generationsBody) });
    assert.equal(generation.response.status, 200, JSON.stringify(generation.data));
    assert.equal(generation.data.data[0].b64_json, png);
    const generationReplay = await jsonRequest(baseUrl, generationsPath, { method: "POST", headers: generationsHeaders, body: JSON.stringify(generationsBody) });
    assert.deepEqual(generationReplay.data, generation.data);
    const noGeneration = await jsonRequest(baseUrl, generationsPath, { method: "POST", headers: { ...generationsHeaders, "idempotency-key": "model-api-generations-empty-0001" }, body: JSON.stringify({ ...generationsBody, prompt: "model api regression no image" }) });
    assert.equal(noGeneration.response.status, 502);
    assert.equal(noGeneration.data.error.code, "no_image_generated");
    for (const endpoint of [responsesPath, generationsPath]) {
      const anonymous = await jsonRequest(baseUrl, endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      assert.equal(anonymous.response.status, 401);
      assert.equal(anonymous.data.error.type, "authentication_error");
      const oversized = await jsonRequest(baseUrl, endpoint, { method: "POST", headers: modelHeaders, body: JSON.stringify({ ignored: "x".repeat(modelApiJsonLimit) }) });
      assert.equal(oversized.response.status, 413);
    }
    await jsonRequest(baseUrl, `/api/clients/${modelClient.data.client.id}/revoke`, { method: "POST" });
    const modelRevoked = await jsonRequest(baseUrl, modelPath, { method: "POST", headers: modelHeaders, body: JSON.stringify(modelBody) });
    assert.equal(modelRevoked.response.status, 401);
    const chatStateFile = path.join(stateRoot, "chat-history.json");
    const chatBeforeTamper = await fs.readFile(chatStateFile, "utf8");
    const chatWithMissingThread = JSON.parse(chatBeforeTamper);
    chatWithMissingThread.sessions[originalClientRun.sessionId].codexSessionId = null;
    await fs.writeFile(chatStateFile, JSON.stringify(chatWithMissingThread));
    const missingThreadHeartbeat = await jsonRequest(baseUrl, "/api/automations/sample-on-demand/heartbeat", {
      method: "POST", headers: { ...scopedHeaders, "idempotency-key": "scoped-missing-thread-0001" }, body: scopedBody,
    });
    assert.equal(missingThreadHeartbeat.response.status, 409);
    await fs.writeFile(chatStateFile, chatBeforeTamper);
    await new Promise((resolve) => setTimeout(resolve, 275));
    const heartbeat = await jsonRequest(baseUrl, "/api/automations/sample-on-demand/heartbeat", {
      method: "POST", headers: { ...scopedHeaders, "idempotency-key": "scoped-heartbeat-0001" }, body: scopedBody,
    });
    assert.equal(heartbeat.response.status, 200, JSON.stringify(heartbeat.data));
    let heartbeatRun;
    const heartbeatStartedDeadline = Date.now() + 5000;
    while (Date.now() < heartbeatStartedDeadline) {
      heartbeatRun = (JSON.parse(await fs.readFile(path.join(stateRoot, "automation-runs.json"), "utf8"))).runs.find((run) => run.id === heartbeat.data.run.id);
      if (heartbeatRun?.sessionId) break;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.equal(heartbeatRun.sessionId, originalClientRun.sessionId);
    assert.equal(await fs.realpath(heartbeatRun.worktreePath), await fs.realpath(originalClientRun.worktreePath));
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const result = await jsonRequest(baseUrl, heartbeat.data.run.resultPath, { headers: scopedHeaders });
      if (result.data.run?.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const competingClient = await jsonRequest(baseUrl, "/api/clients", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "other-regression-service", automationIds: ["sample-on-demand"] }),
    });
    assert.equal(competingClient.response.status, 201);
    const competingHeartbeat = await jsonRequest(baseUrl, "/api/automations/sample-on-demand/heartbeat", {
      method: "POST", headers: { "x-codex-cloud-token": competingClient.data.token, "idempotency-key": "scoped-cross-session-0001", "content-type": "application/json" },
      body: JSON.stringify({ sessionId: originalClientRun.sessionId, prompt: scopedPrompt }),
    });
    assert.equal(competingHeartbeat.response.status, 403);
    const competingWebhook = await jsonRequest(baseUrl, "/api/automations/sample-on-demand/webhook", {
      method: "POST", headers: { "x-codex-cloud-token": competingClient.data.token, "idempotency-key": "scoped-cross-webhook-0001", "content-type": "application/json" },
      body: JSON.stringify({ sessionId: originalClientRun.sessionId, prompt: scopedPrompt }),
    });
    assert.equal(competingWebhook.response.status, 400);
    const competingResult = await jsonRequest(baseUrl, clientTrigger.data.run.resultPath, {
      headers: { "x-codex-cloud-token": competingClient.data.token },
    });
    assert.equal(competingResult.response.status, 404);
    const competingCancel = await jsonRequest(baseUrl, `${clientTrigger.data.run.resultPath}/cancel`, {
      method: "POST", headers: { "x-codex-cloud-token": competingClient.data.token },
    });
    assert.equal(competingCancel.response.status, 404);
    const unauthorizedResult = await jsonRequest(baseUrl, clientTrigger.data.run.resultPath);
    assert.equal(unauthorizedResult.response.status, 401);
    const clientReplay = await jsonRequest(baseUrl, "/api/automations/sample-on-demand/webhook", {
      method: "POST", headers: { ...scopedHeaders, "idempotency-key": "scoped-test-0001" }, body: scopedBody,
    });
    assert.equal(clientReplay.data.deduplicated, true);
    const clientConflict = await jsonRequest(baseUrl, "/api/automations/sample-on-demand/webhook", {
      method: "POST", headers: { ...scopedHeaders, "idempotency-key": "scoped-test-0001" }, body: JSON.stringify({ prompt: "changed task" }),
    });
    assert.equal(clientConflict.response.status, 409);
    const pollBurst = await Promise.all(Array.from({ length: 70 }, () => jsonRequest(baseUrl, clientTrigger.data.run.resultPath, { headers: scopedHeaders })));
    assert.ok(pollBurst.some((result) => result.response.status === 429));
    assert.ok(pollBurst.some((result) => result.response.status === 200));
    const revokedClient = await jsonRequest(baseUrl, `/api/clients/${newClient.data.client.id}/revoke`, { method: "POST" });
    assert.equal(revokedClient.response.status, 200);
    const revokedResult = await jsonRequest(baseUrl, clientTrigger.data.run.resultPath, { headers: scopedHeaders });
    assert.equal(revokedResult.response.status, 401);
    const rejectedAfterRevoke = await jsonRequest(baseUrl, "/api/automations/sample-on-demand/webhook", {
      method: "POST", headers: { ...scopedHeaders, "idempotency-key": "scoped-test-0002" }, body: JSON.stringify({ prompt: "scoped fake task", worktree: false }),
    });
    assert.equal(rejectedAfterRevoke.response.status, 401);
    const clientsAfter = await jsonRequest(baseUrl, "/api/clients");
    assert.equal(JSON.stringify(clientsAfter.data).includes(newClient.data.token), false);
    const usageAfter = await jsonRequest(baseUrl, `/api/clients/usage?to=${encodeURIComponent(new Date(Date.now() + 5_000).toISOString())}`);
    assert.equal(usageAfter.response.status, 200);
    assert.equal(usageAfter.data.usageLedger.source, "sqlite-terminal-runs");
    assert.equal(usageAfter.data.usageLedger.timezone, "UTC");
    assert.ok(usageAfter.data.buckets.some((bucket) => bucket.clientId === newClient.data.client.id && bucket.requests >= 3));
    assert.ok(usageAfter.data.buckets.some((bucket) => bucket.clientId === newClient.data.client.id && bucket.polls >= 1));
    assert.equal(usageAfter.data.buckets.some((bucket) => bucket.clientId === "unknown"), false);
    const triggerHeaders = {
      "x-codex-cloud-token": "regression-token-123456",
      "idempotency-key": "regression-idempotency-1",
      "content-type": "application/json",
    };
    const triggerBody = JSON.stringify({ prompt: "regression automation", worktree: false });
    const concurrentTriggers = await Promise.all(Array.from({ length: 6 }, () => jsonRequest(baseUrl, "/api/automations/sample-maintenance/webhook", {
      method: "POST",
      headers: triggerHeaders,
      body: triggerBody,
    })));
    const acceptedTriggers = concurrentTriggers.filter(item => item.response.status === 200);
    assert.ok(acceptedTriggers.length > 0);
    for (const busy of concurrentTriggers.filter(item => item.response.status !== 200)) {
      assert.equal(busy.response.status, 429);
      assert.equal(busy.data.code, "input_buffer_busy");
      assert.equal(busy.response.headers.get("retry-after"), "1");
      const retried = await jsonRequest(baseUrl, "/api/automations/sample-maintenance/webhook", { method: "POST", headers: triggerHeaders, body: triggerBody });
      assert.equal(retried.response.status, 200);
      assert.equal(retried.data.deduplicated, true);
      acceptedTriggers.push(retried);
    }
    const firstTrigger = acceptedTriggers[0];
    assert.equal(new Set(acceptedTriggers.map(item => item.data.run.id)).size, 1);
    assert.equal(firstTrigger.response.status, 200);
    assert.equal(firstTrigger.data.ok, true);
    assert.ok(firstTrigger.data.run?.id);
    const duplicateTrigger = await jsonRequest(baseUrl, "/api/automations/sample-maintenance/webhook", {
      method: "POST",
      headers: triggerHeaders,
      body: triggerBody,
    });
    assert.equal(duplicateTrigger.response.status, 200);
    assert.equal(duplicateTrigger.data.deduplicated, true);
    assert.equal(duplicateTrigger.data.run?.id, firstTrigger.data.run.id);
    const rateLimitedTrigger = await jsonRequest(baseUrl, "/api/automations/sample-maintenance/webhook", {
      method: "POST",
      headers: { ...triggerHeaders, "idempotency-key": "regression-idempotency-2" },
      body: triggerBody,
    });
    assert.equal(rateLimitedTrigger.response.status, 429);
    assert.ok(Number(rateLimitedTrigger.response.headers.get("retry-after")) >= 1);
    await new Promise((resolve) => setTimeout(resolve, 400));
    // Model completion precedes automation settlement and admission release.
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const status = await jsonRequest(baseUrl, "/api/codex/app-host/status");
      const runs = await jsonRequest(baseUrl, "/api/automations/runs?verifyLimit=0");
      assert.equal(status.response.status, 200);
      assert.equal(runs.response.status, 200);
      assert.ok(Array.isArray(status.data.activeJobs));
      assert.ok(Array.isArray(runs.data.activeRunIds));
      if (!status.data.activeJobs.length && !runs.data.activeRunIds.length) break;
      assert.ok(attempt < 49, `preceding regression task did not settle: ${JSON.stringify(runs.data.activeRunIds)}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const progressTriggerKey = "regression-idempotency-progress";
    const promptQueryToken = "progress-query-token-123456789";
    const promptHeaderToken = "progress-header-token-123456789";
    const progressTrigger = await jsonRequest(baseUrl, "/api/automations/sample-research/webhook", {
      method: "POST",
      headers: { ...triggerHeaders, "idempotency-key": progressTriggerKey },
      body: JSON.stringify({
        prompt: `progress regression https://example.com/input?token=${promptQueryToken} -H 'x-benxing-job-token: ${promptHeaderToken}'`,
        worktree: false,
      }),
    });
    assert.equal(progressTrigger.response.status, 200, JSON.stringify(progressTrigger.data));
    let progressRun = null;
    const progressDeadline = Date.now() + 5_000;
    while (Date.now() < progressDeadline) {
      const runs = await jsonRequest(baseUrl, "/api/automations/runs?automationId=sample-research");
      assert.equal(runs.response.status, 200);
      progressRun = runs.data.runs.find((run) => run.id === progressTrigger.data.run.id) || null;
      if (progressRun && !["queued", "running", "canceling"].includes(progressRun.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(progressRun?.status, "completed");
    assert.ok(new Date(progressRun.finishedAt).getTime() - new Date(progressRun.startedAt).getTime() >= 600);

    const interruptedKey = "regression-idempotency-interrupted";
    const interruptedHash = crypto
      .createHash("sha256")
      .update(`sample-hourly:webhook:${interruptedKey}`)
      .digest("hex");
    const automationRunPath = path.join(stateRoot, "automation-runs.json");
    await stopProcess(child);
    const interruptedStore = JSON.parse(await fs.readFile(automationRunPath, "utf8"));
    interruptedStore.runs.unshift({
      ...progressRun,
      id: "run-sample-research-interrupted-regression",
      automationId: "sample-hourly",
      turnId: "interrupted-fixture-turn",
      status: "interrupted",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      triggerIdempotencyHash: interruptedHash,
      triggerRequestHash: null,
    });
    await fs.writeFile(automationRunPath, JSON.stringify(interruptedStore), "utf8");
    child = start();
    await waitForOutput(child, /listening on/i);
    const seededRuns = await jsonRequest(baseUrl, "/api/automations/runs?automationId=sample-hourly&verifyLimit=0");
    assert.ok(seededRuns.data.runs.some(run => run.id === "run-sample-research-interrupted-regression" && run.triggerIdempotencyHash === interruptedHash));
    const retriedInterruptedTrigger = await jsonRequest(baseUrl, "/api/automations/sample-hourly/webhook", {
      method: "POST",
      headers: { ...triggerHeaders, "idempotency-key": interruptedKey },
      body: triggerBody,
    });
    assert.equal(retriedInterruptedTrigger.response.status, 409);
    assert.match(retriedInterruptedTrigger.data.error, /缺少请求摘要/);

    const persistedAutomationRuns = await fs.readFile(path.join(stateRoot, "automation-runs.json"), "utf8");
    assert.equal(persistedAutomationRuns.includes(progressTriggerKey), false);
    assert.equal(persistedAutomationRuns.includes(promptQueryToken), false);
    assert.equal(persistedAutomationRuns.includes(promptHeaderToken), false);
    assert.match(persistedAutomationRuns, /"triggerIdempotencyHash"\s*:\s*"[a-f0-9]{64}"/);
    const unknownApi = await jsonRequest(baseUrl, "/api/not-a-route");
    assert.equal(unknownApi.response.status, 404);
    assert.equal(unknownApi.data.ok, false);

    const emptyActive = await jsonRequest(baseUrl, "/api/chat/active?repoId=sample-service");
    assert.equal(emptyActive.response.status, 200);
    assert.equal(emptyActive.data.sessionId, null);
    assert.equal(emptyActive.data.authoritative, true);
    assert.equal(emptyActive.data.partial, false);
    const emptyHistory = await jsonRequest(baseUrl, "/api/chat/history?repoId=sample-service");
    assert.equal(emptyHistory.response.status, 200);
    assert.equal(emptyHistory.data.activeSessionId, null);
    assert.deepEqual(emptyHistory.data.messages, []);
    const emptyThreadState = await jsonRequest(baseUrl, "/api/codex/thread-state?repoId=sample-service");
    assert.equal(emptyThreadState.response.status, 200);
    assert.equal(emptyThreadState.data.threadId, null);
    assert.equal(emptyThreadState.data.authoritative, true);
    const finalStore = JSON.parse(await fs.readFile(path.join(stateRoot, "chat-history.json"), "utf8"));
    assert.equal(Object.values(finalStore.sessions).some((session) => session.repoId === "sample-service"), false);

    const admissionFirst = await jsonRequest(baseUrl, "/api/automations/sample-research/run", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ runner: "app-server", prompt: "progress regression admission first", worktree: false }),
    });
    assert.equal(admissionFirst.response.status, 200, JSON.stringify(admissionFirst.data));
    const admissionBlocked = await jsonRequest(baseUrl, "/api/automations/sample-hourly/run", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ runner: "app-server", prompt: "admission second", worktree: false }),
    });
    assert.equal(admissionBlocked.response.status, 429);
    assert.ok(Number(admissionBlocked.response.headers.get("retry-after")) > 0);
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const runStore = JSON.parse(await fs.readFile(path.join(stateRoot, "automation-runs.json"), "utf8"));
      if (runStore.runs.find((run) => run.id === admissionFirst.data.run.id)?.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    const admissionRetry = await jsonRequest(baseUrl, "/api/automations/sample-hourly/run", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ runner: "app-server", prompt: "outcome contract regression legacy no contract", worktree: false }),
    });
    assert.equal(admissionRetry.response.status, 200);
    const cancelStart = await jsonRequest(baseUrl, "/api/automations/sample-on-demand/webhook", {
      method: "POST", headers: { "x-codex-cloud-token": competingClient.data.token, "idempotency-key": "cancel-regression-0001", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "progress regression cancel regression" }),
    });
    assert.equal(cancelStart.response.status, 200);
    const cancelAccepted = await jsonRequest(baseUrl, `${cancelStart.data.run.resultPath}/cancel`, {
      method: "POST", headers: { "x-codex-cloud-token": competingClient.data.token },
    });
    assert.equal(cancelAccepted.response.status, 202);
    assert.equal(cancelAccepted.data.run.status, "canceling");
    assert.ok(cancelAccepted.data.run.cancelRequestedAt);
    let canceledRun;
    for (let attempt = 0; attempt < 15; attempt += 1) {
      const result = await jsonRequest(baseUrl, cancelStart.data.run.resultPath, { headers: { "x-codex-cloud-token": competingClient.data.token } });
      canceledRun = result.data.run;
      if (canceledRun?.status === "canceled") break;
      await new Promise((resolve) => setTimeout(resolve, 70));
    }
    assert.equal(canceledRun?.status, "canceled", JSON.stringify({ run: canceledRun, requests: (await fs.readFile(capturePath, "utf8")).trim().split("\n").slice(-8) }));
    const cancelAgain = await jsonRequest(baseUrl, `${cancelStart.data.run.resultPath}/cancel`, {
      method: "POST", headers: { "x-codex-cloud-token": competingClient.data.token },
    });
    assert.equal(cancelAgain.response.status, 200);
    const legacyIdleDeadline = Date.now() + 5000;
    while (Date.now() < legacyIdleDeadline) {
      const remaining = JSON.parse(await fs.readFile(path.join(stateRoot, "automation-runs.json"), "utf8")).runs;
      if (!remaining.some((run) => ["queued", "running", "canceling"].includes(run.status))) break;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    const legacyRunPath = path.join(stateRoot, "automation-runs.json");
    const legacyRunStore = JSON.parse(await fs.readFile(legacyRunPath, "utf8"));
    const legacySource = legacyRunStore.runs.find((run) => run.id === canceledRun.id);
    const legacyTerminals = ["cancelled", "interrupted", "needs_reconciliation", "completed", "failed"].map((status) => ({
      ...legacySource, id: `legacy-terminal-${status}`, status,
      ...(["interrupted", "needs_reconciliation"].includes(status) ? { usage: { status: "unknown", reason: "合成旧任务未确认用量" } } : {}),
    }));
    legacyRunStore.runs.push(...legacyTerminals);
    await fs.writeFile(legacyRunPath, JSON.stringify(legacyRunStore));
    const legacyBytes = await fs.readFile(legacyRunPath, "utf8");
    const terminalDatabase = new DatabaseSync(path.join(stateRoot, "run-usage.sqlite"), { readOnly: true });
    try {
      for (const run of legacyTerminals) assert.equal(terminalDatabase.prepare("SELECT id FROM external_tasks WHERE id=?").get(run.id), undefined, "旧记录不能被持久任务同 ID 覆盖而虚假通过");
    } finally { terminalDatabase.close(); }
    const foreignLegacyClient = await jsonRequest(baseUrl, "/api/clients", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "legacy-terminal-other-client", automationIds: ["sample-on-demand"] }) });
    assert.equal(foreignLegacyClient.response.status, 201);
    const rpcBeforeLegacyRead = (await fs.readFile(capturePath, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse).filter((item) => item.method === "turn/start" || item.method === "turn/interrupt").length;
    for (const run of legacyTerminals) {
      const route = `/api/automations/${run.automationId}/runs/${run.id}`, expected = run.status === "cancelled" ? "canceled" : run.status;
      const legacyResult = await jsonRequest(baseUrl, route, { headers: { "x-codex-cloud-token": competingClient.data.token } });
      assert.equal(legacyResult.response.status, 200); assert.equal(legacyResult.data.run.status, expected);
      if (["interrupted", "needs_reconciliation"].includes(run.status)) {
        assert.equal(legacyResult.data.run.usage.status, "unknown"); assert.equal(legacyResult.data.run.usage.totalTokens, undefined);
      }
      for (let repeat = 0; repeat < 2; repeat++) {
        const result = await jsonRequest(baseUrl, `${route}/cancel`, { method: "POST", headers: { "x-codex-cloud-token": competingClient.data.token } });
        assert.equal(result.response.status, 200, `旧终态 ${run.status} 的重复取消应返回原记录`);
        assert.deepEqual(result.data.run, legacyResult.data.run, "取消不是将旧终态改写成成功或已取消");
      }
      assert.equal((await jsonRequest(baseUrl, `${route}/cancel`, { method: "POST", headers: { "x-codex-cloud-token": foreignLegacyClient.data.token } })).response.status, 404, "其他调用方不能操作旧记录");
      assert.equal((await jsonRequest(baseUrl, `${route}/cancel`, { method: "POST" })).response.status, 401);
    }
    assert.equal(await fs.readFile(legacyRunPath, "utf8"), legacyBytes, "查询和重复取消不触发旧数据重写");
    const rpcAfterLegacyRead = (await fs.readFile(capturePath, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse).filter((item) => item.method === "turn/start" || item.method === "turn/interrupt").length;
    assert.equal(rpcAfterLegacyRead, rpcBeforeLegacyRead, "旧取消结果不再启动或中断模型");

    const chatStatePath = path.join(stateRoot, "chat-history.json");
    const validChatState = await fs.readFile(chatStatePath, "utf8");
    await fs.writeFile(chatStatePath, "{invalid-json", "utf8");
    const rejectedCorruptWrite = await jsonRequest(baseUrl, "/api/chat/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoId: "sample-app" }),
    });
    assert.equal(rejectedCorruptWrite.response.status, 500);
    assert.equal(rejectedCorruptWrite.data.source, "state-store-invalid");
    assert.equal(await fs.readFile(chatStatePath, "utf8"), "{invalid-json");
    await fs.writeFile(chatStatePath, validChatState, "utf8");
    const backupState = JSON.parse(await fs.readFile(`${chatStatePath}.bak`, "utf8"));
    assert.equal(backupState.version, 2);
  } finally {
    await stopProcess(child);
    await new Promise((resolve) => benxingUpstream.close(resolve));
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

await check("local proxy survives malformed URLs and rejects symlink escapes", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-proxy-regression-"));
  const proxyPort = await freePort();
  const upstreamPort = await freePort();
  const oauthPort = await freePort();
  const credentialsPath = path.join(tempRoot, "credentials");
  const cachePath = path.join(tempRoot, "cache.json");
  const secretPath = path.join(tempRoot, "outside-secret.txt");
  const symlinkPath = path.join(projectRoot, "dist", "regression-outside.txt");
  let proxyStderr = "";
  let healthMode = "hang", notificationOffline = false, getAttempts = 0, postAttempts = 0, bodyAttempts = 0;
  const upstream = http.createServer((req, res) => {
    const url = new URL(req.url, "http://upstream.test");
    if (url.pathname === "/healthz" || url.pathname === "/api/status") {
      if (healthMode === "hang") return;
      res.writeHead(503, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: false, partial: true }));
    }
    if (url.pathname === "/api/chat/private-project-private-session") {
      getAttempts += 1;
      if (getAttempts === 1) return req.socket.destroy();
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (url.pathname === "/api/codex/private-write") {
      postAttempts += 1;
      req.resume();
      req.on("end", () => req.socket.destroy());
      return;
    }
    if (url.pathname === "/api/files/private-body") {
      bodyAttempts += 1;
      res.writeHead(200, { "content-type": "application/json", "content-length": 100 });
      res.write("BODY-SECRET");
      return;
    }
    if (url.pathname === "/api/chat/job-events") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: delta\ndata: SSE-SECRET\n\n");
      setTimeout(() => res.destroy(), 20);
      return;
    }
    if (req.url === "/api/notifications/push/status") {
      if (notificationOffline) return req.socket.destroy();
      const body = JSON.stringify({ ok: true, pushNotifications: { supported: true } });
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    if (["chat/completions", "messages", "responses", "images/generations", "models", "capabilities"].some((route) => req.url === `/api/automations/demo/v1/${route}`) ||
        /^\/api\/automations\/demo\/(webhook|heartbeat|runs\/one(?:\/cancel|\/output(?:\/files\/file)?)?)$/.test(url.pathname)) {
      req.resume();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ authorization: req.headers.authorization, cloudToken: req.headers["x-codex-cloud-token"] || null }));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("upstream-not-found");
  });
  await new Promise((resolve) => upstream.listen(upstreamPort, "127.0.0.1", resolve));
  await fs.writeFile(credentialsPath, `url=http://127.0.0.1:${upstreamPort}/\nusername=test\npassword=test\ntoken=ambient-proxy-token\n`);
  await fs.writeFile(secretPath, "must-not-be-served");
  await fs.rm(symlinkPath, { force: true });
  await fs.symlink(secretPath, symlinkPath);
  const child = spawn(process.execPath, [path.join(projectRoot, "scripts", "local-cloud-console-proxy.mjs")], {
    cwd: projectRoot,
    env: {
      ...process.env,
      CODEX_CLOUD_CONSOLE_PORT: String(proxyPort),
      CODEX_CLOUD_CONSOLE_CREDENTIALS: credentialsPath,
      CODEX_CLOUD_CONSOLE_CACHE: cachePath,
      CODEX_CLOUD_CONSOLE_HEALTH_TIMEOUT_MS: "150",
      CODEX_CLOUD_CONSOLE_FRESH_CACHE_TTL_MS: "0",
      CODEX_CLOUD_CONSOLE_BUFFER_IDLE_TIMEOUT_MS: "1000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (chunk) => { proxyStderr += chunk.toString(); });
  try {
    await waitForOutput(child, /local http proxy ready/i);
    const localRelease = await jsonRequest(`http://127.0.0.1:${proxyPort}`, "/api/local/release?ignored=PRIVATE-QUERY");
    assert.equal(localRelease.response.status, 200);
    assert.equal(localRelease.response.headers.get("cache-control"), "no-store");
    assert.equal(localRelease.data.role, "local-proxy");
    assert.match(localRelease.data.release.entrypoints["scripts/local-cloud-console-proxy.mjs"], /^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(localRelease.data), /PRIVATE-QUERY|ambient-proxy-token|upstream\.test/);
    assert.equal((await fetch(`http://127.0.0.1:${proxyPort}/api/local/release`, { method: "POST" })).status, 405);
    const malformedStatus = await new Promise((resolve, reject) => {
      const request = http.get({ host: "127.0.0.1", port: proxyPort, path: "/%E0%A4%A" }, (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      });
      request.on("error", reject);
    });
    assert.equal(malformedStatus, 400);
    for (const requestPath of ["http://untrusted.invalid/private-command", "https://untrusted.invalid/?secret=QUERY-SECRET", "//untrusted.invalid/private-command"]) {
      const status = await new Promise((resolve, reject) => {
        const request = http.get({ host: "127.0.0.1", port: proxyPort, path: requestPath }, (response) => { response.resume(); response.once("end", () => resolve(response.statusCode)); });
        request.once("error", reject);
      });
      assert.equal(status, 400, "console forwarding must reject a different upstream origin before attaching credentials");
    }
    assert.equal(child.exitCode, null);
    const healthStartedAt = Date.now();
    const syncId = "sync-00000000-0000-4000-8000-000000000001";
    const unavailableHealth = await fetch(`http://127.0.0.1:${proxyPort}/healthz`, { headers: { "x-codex-cloud-sync-id": syncId } });
    assert.equal(unavailableHealth.status, 502);
    assert.ok(Date.now() - healthStartedAt < 1_500, "proxy health failure did not respect its response deadline");
    const failure = await unavailableHealth.json();
    assert.equal(failure.requestId, unavailableHealth.headers.get("x-codex-cloud-request-id"));
    assert.equal(failure.cause, "header-timeout");
    const event = proxyStderr.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line)).find((event) => event.requestId === failure.requestId);
    assert.ok(event, "代理错误必须留下可通过页面错误编号查找的脱敏记录");
    assert.equal(event.route, "/healthz");
    assert.equal(event.syncId, syncId, "浏览器同步编号必须能关联代理故障记录");
    assert.equal(event.cause, "header-timeout");
    assert.equal(event.attempts, 1);
    assert.ok(event.durationMs >= 0);
    const abandoned = new AbortController();
    const abandonedResponse = fetch(`http://127.0.0.1:${proxyPort}/api/status`, { signal: abandoned.signal, headers: { "x-codex-cloud-sync-id": syncId } });
    setTimeout(() => abandoned.abort(), 50);
    await assert.rejects(abandonedResponse, /abort/i);
    for (let attempt = 0; attempt < 20 && !proxyStderr.includes('"cause":"client-aborted"'); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const abandonedEvent = proxyStderr.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line)).find((item) => item.cause === "client-aborted");
    assert.equal(abandonedEvent?.syncId, syncId);
    assert.equal(abandonedEvent?.route, "/api/status");
    healthMode = "unhealthy";
    const unhealthy = await fetch(`http://127.0.0.1:${proxyPort}/healthz`);
    assert.equal(unhealthy.status, 503, "真实服务器的 503 不冒充代理故障或健康");
    await unhealthy.arrayBuffer();
    const recovered = await fetch(`http://127.0.0.1:${proxyPort}/api/chat/private-project-private-session?token=QUERY-SECRET`, { headers: { authorization: "Bearer HEADER-SECRET" } });
    assert.equal(recovered.status, 200);
    await recovered.arrayBuffer();
    assert.equal(getAttempts, 2, "只读请求可按原策略重试");
    const write = await fetch(`http://127.0.0.1:${proxyPort}/api/codex/private-write?token=QUERY-SECRET`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer HEADER-SECRET", "x-codex-cloud-sync-id": "PRIVATE-SYNC-SECRET" }, body: JSON.stringify({ message: "BODY-SECRET" }) });
    assert.equal(write.status, 502);
    const writeFailure = await write.json();
    assert.equal(postAttempts, 1, "诊断不能导致写请求重放");
    const bodyTimeout = await fetch(`http://127.0.0.1:${proxyPort}/api/files/private-body`);
    assert.equal(bodyTimeout.status, 502);
    const bodyFailure = await bodyTimeout.json();
    assert.equal(bodyFailure.cause, "body-timeout");
    const interruptedStream = await fetch(`http://127.0.0.1:${proxyPort}/api/chat/job-events`, { headers: { accept: "text/event-stream" } });
    await interruptedStream.text();
    assert.equal(child.exitCode, null);
    const symlinkResponse = await fetch(`http://127.0.0.1:${proxyPort}/regression-outside.txt`);
    const symlinkBody = await symlinkResponse.text();
    assert.equal(symlinkResponse.status, 404);
    assert.equal(symlinkBody.includes("must-not-be-served"), false);
    const manifest = await fetch(`http://127.0.0.1:${proxyPort}/manifest.webmanifest`);
    assert.equal(manifest.status, 200);
    const cachedStatus = await fetch(`http://127.0.0.1:${proxyPort}/api/notifications/push/status`);
    assert.equal(cachedStatus.status, 200);
    await cachedStatus.arrayBuffer();
    notificationOffline = true;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const stale = await fetch(`http://127.0.0.1:${proxyPort}/api/notifications/push/status`);
    assert.equal(stale.status, 200);
    assert.equal(stale.headers.get("x-codex-cloud-proxy-fallback"), "stale-cache");
    await stale.arrayBuffer();
    if (!proxyStderr.includes('"outcome":"stale-cache"')) await waitForOutput(child, /"outcome":"stale-cache"/);
    const events = proxyStderr.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
    assert.ok(events.some((event) => event.cause === "upstream-http" && event.status === 503 && event.outcome === "forwarded"));
    assert.ok(events.some((event) => event.route === "/api/chat" && event.attempts === 2 && event.outcome === "recovered"));
    assert.ok(events.some((event) => event.requestId === writeFailure.requestId && event.attempts === 1 && event.outcome === "error"));
    assert.ok(events.some((event) => event.requestId === bodyFailure.requestId && event.attempts === bodyAttempts && event.cause === "body-timeout"));
    assert.ok(events.some((event) => event.route === "/api/chat" && event.outcome === "stream-closed"));
    assert.ok(events.some((event) => event.route === "/api/notifications" && event.attempts === 2 && event.outcome === "stale-cache"));
    for (const secret of ["QUERY-SECRET", "HEADER-SECRET", "BODY-SECRET", "SSE-SECRET", "PRIVATE-SYNC-SECRET", "private-project", "private-session", "private-write", "private-body", "ambient-proxy-token"]) {
      assert.equal(proxyStderr.includes(secret), false, "代理诊断不能保存秘密或私人路径");
    }
    assert.equal(new Set(events.map((event) => event.requestId)).size, events.length, "同一请求只记录一次结果");
    for (const route of ["chat/completions", "messages", "responses", "images/generations"]) {
      const modelProxy = await fetch(`http://127.0.0.1:${proxyPort}/api/automations/demo/v1/${route}`, {
        method: "POST", headers: { authorization: "Bearer isolated-client-token", "content-type": "application/json" }, body: "{}",
      });
      assert.deepEqual(await modelProxy.json(), { authorization: "Bearer isolated-client-token", cloudToken: null });
    }
    for (const route of ["models", "capabilities"]) {
      const discoveryProxy = await fetch(`http://127.0.0.1:${proxyPort}/api/automations/demo/v1/${route}`, { headers: { authorization: "Bearer scoped-discovery-token" } });
      assert.deepEqual(await discoveryProxy.json(), { authorization: "Bearer scoped-discovery-token", cloudToken: null });
    }
    for (const [method, route] of [["POST", "webhook"], ["POST", "heartbeat"], ["GET", "runs/one"], ["POST", "runs/one/cancel"], ["GET", "runs/one/output"], ["GET", "runs/one/output/files/file"]]) {
      const preserved = await fetch(`http://127.0.0.1:${proxyPort}/api/automations/demo/${route}`, { method, headers: { "x-codex-cloud-token": "scoped-external-token" } });
      assert.deepEqual(await preserved.json(), { cloudToken: "scoped-external-token" });
      const anonymous = await fetch(`http://127.0.0.1:${proxyPort}/api/automations/demo/${route}`, { method });
      assert.deepEqual(await anonymous.json(), { cloudToken: null }, "proxy must not lend its admin token to an anonymous API request");
    }
    const cacheMode = (await fs.stat(cachePath)).mode & 0o777;
    assert.equal(cacheMode, 0o600);
    const callbackPath = "/callback/allowed-regression";
    const authorizationUrl = new URL("https://auth.example/authorize");
    authorizationUrl.searchParams.set("redirect_uri", `http://127.0.0.1:${oauthPort}${callbackPath}`);
    const relayStart = await fetch(`http://127.0.0.1:${proxyPort}/api/local/mcp-oauth-relay/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ authorizationUrl: authorizationUrl.href }),
    });
    assert.equal(relayStart.status, 200);
    const unknownRelayPath = await fetch(`http://127.0.0.1:${oauthPort}/callback/not-authorized`);
    assert.equal(unknownRelayPath.status, 404);
    const unknownRelayBody = await unknownRelayPath.text();
    assert.match(unknownRelayBody, /unknown oauth relay path/i);
    assert.equal(child.exitCode, null);
  } finally {
    await stopProcess(child);
    await new Promise((resolve) => upstream.close(resolve));
    await fs.rm(symlinkPath, { force: true });
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

await check("atomic installer gates on strict health, installs locked runtime dependencies, and rolls back", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-deploy-regression-"));
  const sourceRoot = path.join(tempRoot, "source");
  const releaseRoot = path.join(tempRoot, "releases");
  const currentLink = path.join(tempRoot, "console-current");
  const envFile = path.join(tempRoot, "console.env");
  const binDir = path.join(tempRoot, "bin");
  const healthCountPath = path.join(tempRoot, "health-count");
  const npmCallsPath = path.join(tempRoot, "npm-calls");
  const previousRelease = path.join(releaseRoot, "20260101T000000Z-previous");
  await fs.mkdir(path.join(sourceRoot, "ops"), { recursive: true });
  await fs.mkdir(path.join(sourceRoot, "server"), { recursive: true });
  await fs.copyFile(path.join(projectRoot, "ops/write-release-manifest.mjs"), path.join(sourceRoot, "ops/write-release-manifest.mjs"));
  await fs.copyFile(path.join(projectRoot, "ops/check-task-rollback.mjs"), path.join(sourceRoot, "ops/check-task-rollback.mjs"));
  await fs.copyFile(path.join(projectRoot, "server/release-info.mjs"), path.join(sourceRoot, "server/release-info.mjs"));
  await fs.mkdir(previousRelease, { recursive: true });
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(path.join(binDir, "flock"), '#!/bin/sh\n[ "${FAKE_DEPLOY_LOCK_BUSY:-0}" != 1 ]\n', { mode: 0o755 });
  if (process.platform === "darwin") {
    await fs.writeFile(path.join(binDir, "tar"), '#!/bin/sh\nexec /usr/bin/tar -b 1 "$@"\n', { mode: 0o755 });
  }
  await fs.writeFile(path.join(sourceRoot, "package-lock.json"), "{}\n");
  await fs.writeFile(path.join(sourceRoot, "source-marker.txt"), "source data remains intact\n");
  for (const folder of ["docs/research", "test-results", "playwright-report"]) {
    await fs.mkdir(path.join(sourceRoot, folder), { recursive: true });
    await fs.writeFile(path.join(sourceRoot, folder, "test-artifact.txt"), "local-only artifact");
  }
  await fs.writeFile(path.join(sourceRoot, "ops", "codex-cloud-console.service"), "[Service]\nExecStart=/bin/true\n");
  await fs.writeFile(path.join(sourceRoot, "ops", "codex-cloud-console.env.example"), "CODEX_CLOUD_WEBHOOK_TOKEN=replace-me\n");
  await fs.writeFile(envFile, "CODEX_CLOUD_WEBHOOK_TOKEN=regression-token-123456\n");
  await fs.writeFile(path.join(previousRelease, "release-marker.txt"), "previous\n");
  await fs.symlink(previousRelease, currentLink);
  await fs.writeFile(
    path.join(binDir, "sudo"),
    `#!/bin/sh
if [ "$1" = "-u" ]; then shift 2; fi
if [ "$1" = "systemctl" ]; then
  [ "$2" = "status" ] && echo "fake systemd service active"
  exit 0
fi
if [ "$1" = "install" ]; then exit 0; fi
exec "$@"
`,
    { mode: 0o755 },
  );
  await fs.writeFile(path.join(binDir, "npm"), `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_NPM_CALLS"
if [ "$1" = "ci" ] && [ "$2" = "--omit=dev" ] && [ "$FAKE_NPM_FAIL_RUNTIME" = "1" ]; then exit 1; fi
if [ "$1" = "audit" ] && [ "$FAKE_NPM_FAIL_AUDIT" = "1" ]; then exit 1; fi
exit 0
`, { mode: 0o755 });
  await fs.writeFile(
    path.join(binDir, "curl"),
    `#!/bin/sh
count=0
[ -f "$FAKE_HEALTH_COUNT" ] && count=$(cat "$FAKE_HEALTH_COUNT")
count=$((count + 1))
printf '%s' "$count" > "$FAKE_HEALTH_COUNT"
if [ "$FAKE_HEALTH_MODE" = "recover" ] && [ "$count" -ge 2 ]; then
  printf '%s\n' '{"strictOk":true,"partial":false}'
else
  printf '%s\n' '{"strictOk":false,"partial":true}'
fi
`,
    { mode: 0o755 },
  );
  await fs.writeFile(
    path.join(binDir, "mv"),
    `#!/bin/sh
if [ "$1" = "-Tf" ]; then
  /bin/rm -f "$3"
  exec /bin/mv "$2" "$3"
fi
exec /bin/mv "$@"
`,
    { mode: 0o755 },
  );
  await fs.writeFile(
    path.join(binDir, "readlink"),
    `#!/bin/sh
if [ "$1" = "-f" ]; then
  exec "${process.execPath}" -e 'const fs=require("fs");try{process.stdout.write(fs.realpathSync(process.argv[1]))}catch{process.exit(1)}' "$2"
fi
exec /usr/bin/readlink "$@"
`,
    { mode: 0o755 },
  );

  const installerEnv = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    CODEX_CLOUD_ENV_FILE: envFile,
    CODEX_CLOUD_RELEASE_ROOT: releaseRoot,
    CODEX_CLOUD_CURRENT_LINK: currentLink,
    CODEX_CLOUD_HEALTH_ATTEMPTS: "3",
    CODEX_CLOUD_HEALTH_INTERVAL_SECONDS: "0",
    CODEX_CLOUD_KEEP_RELEASES: "1",
    FAKE_HEALTH_COUNT: healthCountPath,
    FAKE_NPM_CALLS: npmCallsPath,
    CODEX_CLOUD_SERVICE_USER: process.env.USER || "root",
  };
  const installerArgs = [
    "-c",
    'umask 077; exec bash "$1" "$2"',
    "installer-regression",
    path.join(projectRoot, "ops", "install-systemd.sh"),
    sourceRoot,
  ];
  try {
    const successful = await runCaptured("bash", installerArgs, {
      cwd: projectRoot,
      env: { ...installerEnv, FAKE_HEALTH_MODE: "recover" },
    });
    assert.equal(successful.code, 0, successful.stderr || successful.stdout);
    assert.match(successful.stdout, /retained releases: 1/i);
    const activeRelease = await fs.realpath(currentLink);
    assert.notEqual(activeRelease, previousRelease);
    const releaseManifest = JSON.parse(await fs.readFile(path.join(activeRelease, ".codex-cloud-release.json"), "utf8"));
    assert.equal(releaseManifest.schemaVersion, 1);
    assert.equal(releaseManifest.releaseId, path.basename(activeRelease));
    assert.equal(releaseManifest.source.revision, null, "exported sources do not invent a git revision");
    assert.equal((await fs.stat(activeRelease)).mode & 0o055, 0o055);
    assert.equal((await fs.stat(path.join(activeRelease, "package-lock.json"))).mode & 0o044, 0o044);
    assert.equal((await fs.readdir(releaseRoot)).length, 1);
    assert.equal(await fs.readFile(path.join(sourceRoot, "source-marker.txt"), "utf8"), "source data remains intact\n");
    assert.deepEqual((await fs.readFile(npmCallsPath, "utf8")).trim().split("\n"), [
      "ci --include=dev", "audit --audit-level=high", "run build", "run codex:schema:check", "run verify:normalizers",
      "ci --omit=dev --ignore-scripts --no-audit --no-fund", "ls --omit=dev --depth=0",
    ]);
    for (const folder of ["docs/research", "test-results", "playwright-report"]) {
      await assert.rejects(fs.access(path.join(activeRelease, folder)), { code: "ENOENT" });
      await fs.access(path.join(sourceRoot, folder, "test-artifact.txt"));
    }

    const lockBusy = await runCaptured("bash", installerArgs, {
      cwd: projectRoot, env: { ...installerEnv, FAKE_DEPLOY_LOCK_BUSY: "1", FAKE_HEALTH_MODE: "recover" },
    });
    assert.notEqual(lockBusy.code, 0);
    assert.equal(await fs.realpath(currentLink), activeRelease);

    const auditFailed = await runCaptured("bash", installerArgs, {
      cwd: projectRoot,
      env: { ...installerEnv, FAKE_HEALTH_MODE: "recover", FAKE_NPM_FAIL_AUDIT: "1" },
    });
    assert.notEqual(auditFailed.code, 0);
    assert.equal(await fs.realpath(currentLink), activeRelease);
    assert.equal((await fs.readdir(releaseRoot)).length, 1);

    const runtimeInstallFailed = await runCaptured("bash", installerArgs, {
      cwd: projectRoot,
      env: { ...installerEnv, FAKE_HEALTH_MODE: "recover", FAKE_NPM_FAIL_RUNTIME: "1" },
    });
    assert.notEqual(runtimeInstallFailed.code, 0);
    assert.equal(await fs.realpath(currentLink), activeRelease);
    assert.equal((await fs.readdir(releaseRoot)).length, 1);

    const preSwitchCheck = path.join(binDir, "pre-switch-check");
    await fs.writeFile(preSwitchCheck, "#!/bin/sh\necho 'active task detected' >&2\nexit 1\n", { mode: 0o755 });
    const busy = await runCaptured("bash", installerArgs, {
      cwd: projectRoot,
      env: { ...installerEnv, CODEX_CLOUD_PRE_SWITCH_CHECK: preSwitchCheck, FAKE_HEALTH_MODE: "recover" },
    });
    assert.notEqual(busy.code, 0);
    assert.match(busy.stderr, /active task detected/);
    assert.equal(await fs.realpath(currentLink), activeRelease);
    assert.equal((await fs.readdir(releaseRoot)).length, 1);

    await fs.writeFile(healthCountPath, "0");
    const failed = await runCaptured("bash", installerArgs, {
      cwd: projectRoot,
      env: { ...installerEnv, CODEX_CLOUD_HEALTH_ATTEMPTS: "1", FAKE_HEALTH_MODE: "fail" },
    });
    assert.notEqual(failed.code, 0);
    assert.match(failed.stderr, /strict health check failed/i);
    assert.equal(await fs.realpath(currentLink), activeRelease);
    assert.equal((await fs.readdir(releaseRoot)).length, 1);
    assert.equal(await fs.readFile(path.join(sourceRoot, "source-marker.txt"), "utf8"), "source data remains intact\n");
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

await check("webhook snippets use the server token contract", async () => {
  const source = await fs.readFile(path.join(projectRoot, "src", "App.tsx"), "utf8");
  assert.equal(source.includes("Authorization: Bearer $CODEX_CLOUD_WEBHOOK_TOKEN"), false);
  assert.equal(source.includes("x-codex-cloud-token: $CODEX_CLOUD_WEBHOOK_TOKEN"), true);
  assert.equal(source.includes("status.publicConfig?.publicOrigin"), true);
});

assert.ok(results.length, "No regression case matched the requested name");
console.log(JSON.stringify({ ok: true, scope: selectedCheck ? "selected" : "all", checks: results }, null, 2));
