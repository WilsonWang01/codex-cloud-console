#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "../server/codex-app-server-client.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const results = [];

async function check(name, task) {
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
  if (!child || child.exitCode !== null) return;
  const closed = new Promise((resolve) => child.once("close", resolve));
  child.kill("SIGTERM");
  await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 2_000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
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
const initDelay = Number(process.env.FAKE_INIT_DELAY_MS || 0);
const termDelay = Number(process.env.FAKE_TERM_DELAY_MS || 0);
process.on("SIGTERM", () => setTimeout(() => process.exit(0), termDelay));
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (process.env.FAKE_CAPTURE_PATH) fsSync.appendFileSync(process.env.FAKE_CAPTURE_PATH, JSON.stringify(message) + "\\n");
  if (!message.id) return;
  const send = (payload, delay = 0) => setTimeout(() => process.stdout.write(JSON.stringify(payload) + "\\n"), delay);
  if (message.method === "initialize") return send({ id: message.id, result: { ready: true } }, initDelay);
  if (message.method === "model/list") return send({
    id: message.id,
    result: {
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
  if (message.method === "thread/list") {
    const cwd = Array.isArray(message.params?.cwd) ? message.params.cwd.join(" ") : "";
    if (cwd.includes("macro-control-dashboard")) return send({ id: message.id, result: { data: [], nextCursor: null } });
    return send({ id: message.id, error: { code: -32000, message: "injected thread/list failure" } });
  }
  if (message.method === "thread/start") return send({ id: message.id, result: { thread: { id: "thread-regression" } } });
  if (message.method === "thread/resume") {
    const matched = message.params?.threadId === "thread-runtime-matched";
    return send({
      id: message.id,
      result: {
        thread: { id: message.params?.threadId },
        model: matched ? message.params?.model : "gpt-5.4-mini",
        reasoningEffort: matched ? message.params?.config?.model_reasoning_effort : "low",
      },
    });
  }
  if (message.method === "turn/start") return send({ id: message.id, result: { turn: { id: "turn-regression" } } });
  if (message.method === "slow") return send({ id: message.id, result: { ok: true, generation: process.pid } }, 900);
  return send({ id: message.id, result: { ok: true, method: message.method } });
});
`,
    { mode: 0o755 },
  );
  return fakePath;
}

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

await check("session sync failure preserves drafts and upload cleanup is verified", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-session-regression-"));
  const fakePath = await writeFakeCodex(tempRoot);
  const binDir = path.join(tempRoot, "bin");
  const stateRoot = path.join(tempRoot, "state");
  const cloudRoot = path.join(tempRoot, "cloud");
  const workspaceRoot = path.join(cloudRoot, "workspace");
  const repoRoot = path.join(workspaceRoot, "invest-dashboard");
  const emptyRepoRoot = path.join(workspaceRoot, "macro-control-dashboard");
  const outsideRoot = path.join(tempRoot, "outside-repository");
  const outsideSecretPath = path.join(outsideRoot, "secret.txt");
  const danglingWriteTarget = path.join(outsideRoot, "created-through-symlink.txt");
  const codexShim = path.join(binDir, "codex");
  const capturePath = path.join(tempRoot, "app-server-requests.jsonl");
  const port = await freePort();
  await fs.mkdir(path.join(repoRoot, ".codex-cloud", "uploads", "test"), { recursive: true });
  await fs.mkdir(emptyRepoRoot, { recursive: true });
  await fs.mkdir(outsideRoot, { recursive: true });
  await fs.writeFile(outsideSecretPath, "must stay outside the repository\n");
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
      ],
    }),
  );
  const staleManagedTemp = path.join(stateRoot, "automation-runs.json.999999.deadbeef.abcdef.tmp");
  const unmanagedTemp = path.join(stateRoot, "user-data.json.999999.deadbeef.abcdef.tmp");
  await fs.writeFile(staleManagedTemp, "stale partial state");
  await fs.writeFile(unmanagedTemp, "must remain");
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(codexShim, `#!/bin/sh\nexec "${process.execPath}" "${fakePath}"\n`, { mode: 0o755 });
  const child = spawn(process.execPath, [path.join(projectRoot, "server", "index.mjs")], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: String(port),
      CODEX_CLOUD_ROOT: cloudRoot,
      CODEX_WORKSPACE_ROOT: workspaceRoot,
      CODEX_STATE_ROOT: stateRoot,
      CODEX_CLOUD_WEBHOOK_TOKEN: "regression-token-123456",
      CODEX_AUTOMATION_TRIGGER_RATE_MAX: "1",
      CODEX_TURN_TIMEOUT_MS: "300",
      CODEX_ALLOW_LOCAL_FALLBACK: "0",
      FAKE_CAPTURE_PATH: capturePath,
      PATH: `${binDir}:${process.env.PATH}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const baseUrl = `http://127.0.0.1:${port}/`;
  try {
    await waitForOutput(child, /listening on/i);
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
    assert.equal(
      (statusData?.attention?.items || []).some((item) => String(item.title || "").includes("exited (SIGTERM)")),
      false,
    );
    const models = await jsonRequest(baseUrl, "/api/codex/models");
    assert.equal(models.response.status, 200);
    assert.equal(models.response.headers.get("x-codex-model-list-cache"), "refreshed");
    assert.equal(models.data.models[0].id, "gpt-5.6-sol");
    assert.ok(models.data.models[0].supportedReasoningEfforts.includes("max"));
    assert.ok(models.data.models[0].supportedReasoningEfforts.includes("ultra"));
    const escapedRead = await jsonRequest(
      baseUrl,
      `/api/files/read?repoId=invest-dashboard&path=${encodeURIComponent("outside-link/secret.txt")}`,
    );
    assert.equal(escapedRead.response.status, 400);
    assert.equal(escapedRead.data.source, "invalid-repository-path");
    assert.equal(JSON.stringify(escapedRead.data).includes("must stay outside"), false);
    const rootListing = await jsonRequest(baseUrl, "/api/files/tree?repoId=invest-dashboard&path=.");
    assert.equal(rootListing.response.status, 200);
    assert.equal(rootListing.data.entries.some((entry) => entry.name === "outside-link"), false);
    assert.equal(rootListing.data.entries.some((entry) => entry.name === "cyclic-link"), false);
    const escapedSearch = await jsonRequest(baseUrl, "/api/files/search?repoId=invest-dashboard&q=secret");
    assert.equal(escapedSearch.response.status, 200);
    assert.equal(escapedSearch.data.entries.some((entry) => entry.path.includes("outside-link")), false);
    const cyclicRead = await jsonRequest(
      baseUrl,
      `/api/files/read?repoId=invest-dashboard&path=${encodeURIComponent("cyclic-link")}`,
    );
    assert.equal(cyclicRead.response.status, 400);
    assert.match(cyclicRead.data.error, /cyclic symbolic links/i);
    const escapedWrite = await jsonRequest(baseUrl, "/api/files/write", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoId: "invest-dashboard", path: "dangling-write-link", content: "escaped" }),
    });
    assert.equal(escapedWrite.response.status, 400);
    assert.equal(escapedWrite.data.source, "invalid-repository-path");
    await assert.rejects(() => fs.stat(danglingWriteTarget), /ENOENT/);
    const escapedUpload = await jsonRequest(baseUrl, "/api/uploads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repoId: "invest-dashboard",
        files: [{ name: "escape.txt", type: "text/plain", dataUrl: "data:text/plain;base64,ZXNjYXBl" }],
      }),
    });
    assert.equal(escapedUpload.response.status, 400);
    assert.equal(escapedUpload.data.source, "invalid-repository-path");
    const escapedUploadDelete = await jsonRequest(baseUrl, "/api/uploads", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoId: "invest-dashboard", paths: [".codex-cloud/uploads/test/outside-secret-link"] }),
    });
    assert.equal(escapedUploadDelete.response.status, 400);
    assert.equal(await fs.readFile(outsideSecretPath, "utf8"), "must stay outside the repository\n");
    const invalidAutomationMode = await jsonRequest(baseUrl, "/api/automations/invest-daily-update/delete", {
      method: "POST",
    });
    assert.equal(invalidAutomationMode.response.status, 400);
    assert.match(invalidAutomationMode.data.output, /pause or resume/i);
    const created = await jsonRequest(baseUrl, "/api/chat/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoId: "invest-dashboard" }),
    });
    assert.equal(created.response.status, 200);
    const sessionId = created.data.activeSessionId;
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
      body: JSON.stringify({ repoId: "invest-dashboard" }),
    });
    assert.equal(crossSiteMutation.response.status, 403);
    const failedRead = await jsonRequest(baseUrl, "/api/chat/sessions?repoId=invest-dashboard");
    assert.equal(failedRead.response.status, 503);
    assert.equal(failedRead.data.ok, false);
    const store = JSON.parse(await fs.readFile(path.join(stateRoot, "chat-history.json"), "utf8"));
    assert.ok(store.sessions[sessionId]);
    assert.equal(store.activeByRepo["invest-dashboard"], sessionId);
    const explicitRead = await jsonRequest(baseUrl, `/api/chat/sessions?repoId=invest-dashboard&sessionId=${encodeURIComponent(sessionId)}`);
    assert.equal(explicitRead.response.status, 200);
    assert.equal(explicitRead.data.activeSessionId, sessionId);
    assert.equal(explicitRead.data.degraded, true);

    const runtimeStore = JSON.parse(await fs.readFile(path.join(stateRoot, "chat-history.json"), "utf8"));
    runtimeStore.sessions[sessionId].codexSessionId = "thread-runtime-regression";
    runtimeStore.sessions[sessionId].model = "gpt-5.4-mini";
    runtimeStore.sessions[sessionId].reasoning = "low";
    await fs.writeFile(path.join(stateRoot, "chat-history.json"), JSON.stringify(runtimeStore));
    const primedThreadState = await jsonRequest(
      baseUrl,
      `/api/codex/thread-state?repoId=invest-dashboard&sessionId=${encodeURIComponent(sessionId)}`,
    );
    assert.equal(primedThreadState.response.status, 200);
    assert.equal(primedThreadState.data.runtime.model, "gpt-5.4-mini");
    const runtimePatch = await jsonRequest(baseUrl, `/api/chat/sessions/${encodeURIComponent(sessionId)}/runtime`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repoId: "invest-dashboard",
        model: "gpt-5.5",
        reasoning: "high",
        sandbox: "danger-full-access",
        approval: "never",
        search: true,
      }),
    });
    assert.equal(runtimePatch.response.status, 200);
    assert.equal(runtimePatch.data.runtime.model, "gpt-5.5");
    assert.equal(runtimePatch.data.runtime.reasoning, "high");
    assert.equal(runtimePatch.data.appServerRuntime.model, "gpt-5.4-mini");
    assert.equal(runtimePatch.data.appliesOnNextTurn, true);
    const pendingThreadState = await jsonRequest(
      baseUrl,
      `/api/codex/thread-state?repoId=invest-dashboard&sessionId=${encodeURIComponent(sessionId)}`,
    );
    assert.equal(pendingThreadState.response.status, 200);
    assert.equal(pendingThreadState.data.runtime.model, "gpt-5.5");
    assert.equal(pendingThreadState.data.runtime.reasoning, "high");
    const gpt56RuntimePatch = await jsonRequest(baseUrl, `/api/chat/sessions/${encodeURIComponent(sessionId)}/runtime`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repoId: "invest-dashboard",
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
      body: JSON.stringify({ repoId: "invest-dashboard", sessionId, message: "timeout regression" }),
    });
    assert.equal(timedOutTurn.status, 200);
    const timedOutBody = await timedOutTurn.text();
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
    const inactiveAfterTimeout = await jsonRequest(baseUrl, `/api/chat/active?repoId=invest-dashboard&sessionId=${encodeURIComponent(sessionId)}`);
    assert.equal(inactiveAfterTimeout.response.status, 200);
    assert.equal(inactiveAfterTimeout.data.turn, null);

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
        repoId: "invest-dashboard",
        model: "gpt-5.5",
        reasoning: "high",
        sandbox: "danger-full-access",
        approval: "never",
        search: true,
      }),
    });
    assert.equal(matchedRuntimePatch.response.status, 200);
    assert.equal(matchedRuntimePatch.data.appServerRuntime.model, "gpt-5.5");
    assert.equal(matchedRuntimePatch.data.appServerRuntime.reasoning, "high");
    assert.equal(matchedRuntimePatch.data.appliesOnNextTurn, true);

    const uploadRelative = ".codex-cloud/uploads/test/regression.txt";
    const uploadAbsolute = path.join(repoRoot, uploadRelative);
    await fs.writeFile(uploadAbsolute, "cleanup me\n");
    const draft = await jsonRequest(baseUrl, `/api/chat/sessions/${encodeURIComponent(sessionId)}/draft`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repoId: "invest-dashboard",
        input: "",
        attachments: [{ name: "regression.txt", path: uploadRelative, absolutePath: uploadAbsolute, mimeType: "text/plain", size: 11, kind: "file" }],
      }),
    });
    assert.equal(draft.response.status, 200);
    const deleted = await jsonRequest(baseUrl, `/api/chat/sessions/${encodeURIComponent(sessionId)}?repoId=invest-dashboard`, { method: "DELETE" });
    assert.equal(deleted.response.status, 200);
    assert.equal(deleted.data.deletedSessionId, sessionId);
    assert.deepEqual(deleted.data.uploadCleanup.errors, []);
    await assert.rejects(() => fs.stat(uploadAbsolute), /ENOENT/);

    const bearer = await jsonRequest(baseUrl, "/api/automations/not-real/webhook", {
      method: "POST",
      headers: { authorization: "Bearer regression-token-123456", "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(bearer.response.status, 401);
    const tokenHeader = await jsonRequest(baseUrl, "/api/automations/not-real/webhook", {
      method: "POST",
      headers: { "x-codex-cloud-token": "regression-token-123456", "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(tokenHeader.response.status, 404);
    const triggerHeaders = {
      "x-codex-cloud-token": "regression-token-123456",
      "idempotency-key": "regression-idempotency-1",
      "content-type": "application/json",
    };
    const triggerBody = JSON.stringify({ prompt: "regression automation", worktree: false });
    const firstTrigger = await jsonRequest(baseUrl, "/api/automations/invest-daily-update/webhook", {
      method: "POST",
      headers: triggerHeaders,
      body: triggerBody,
    });
    assert.equal(firstTrigger.response.status, 200);
    assert.equal(firstTrigger.data.ok, true);
    assert.ok(firstTrigger.data.run?.id);
    const duplicateTrigger = await jsonRequest(baseUrl, "/api/automations/invest-daily-update/webhook", {
      method: "POST",
      headers: triggerHeaders,
      body: triggerBody,
    });
    assert.equal(duplicateTrigger.response.status, 200);
    assert.equal(duplicateTrigger.data.deduplicated, true);
    assert.equal(duplicateTrigger.data.run?.id, firstTrigger.data.run.id);
    const rateLimitedTrigger = await jsonRequest(baseUrl, "/api/automations/invest-daily-update/webhook", {
      method: "POST",
      headers: { ...triggerHeaders, "idempotency-key": "regression-idempotency-2" },
      body: triggerBody,
    });
    assert.equal(rateLimitedTrigger.response.status, 429);
    assert.ok(Number(rateLimitedTrigger.response.headers.get("retry-after")) >= 1);
    const unknownApi = await jsonRequest(baseUrl, "/api/not-a-route");
    assert.equal(unknownApi.response.status, 404);
    assert.equal(unknownApi.data.ok, false);

    const emptyActive = await jsonRequest(baseUrl, "/api/chat/active?repoId=macro-control-dashboard");
    assert.equal(emptyActive.response.status, 200);
    assert.equal(emptyActive.data.sessionId, null);
    assert.equal(emptyActive.data.authoritative, true);
    assert.equal(emptyActive.data.partial, false);
    const emptyHistory = await jsonRequest(baseUrl, "/api/chat/history?repoId=macro-control-dashboard");
    assert.equal(emptyHistory.response.status, 200);
    assert.equal(emptyHistory.data.activeSessionId, null);
    assert.deepEqual(emptyHistory.data.messages, []);
    const emptyThreadState = await jsonRequest(baseUrl, "/api/codex/thread-state?repoId=macro-control-dashboard");
    assert.equal(emptyThreadState.response.status, 200);
    assert.equal(emptyThreadState.data.threadId, null);
    assert.equal(emptyThreadState.data.authoritative, true);
    const finalStore = JSON.parse(await fs.readFile(path.join(stateRoot, "chat-history.json"), "utf8"));
    assert.equal(Object.values(finalStore.sessions).some((session) => session.repoId === "macro-control-dashboard"), false);

    const chatStatePath = path.join(stateRoot, "chat-history.json");
    const validChatState = await fs.readFile(chatStatePath, "utf8");
    await fs.writeFile(chatStatePath, "{invalid-json", "utf8");
    const rejectedCorruptWrite = await jsonRequest(baseUrl, "/api/chat/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoId: "invest-dashboard" }),
    });
    assert.equal(rejectedCorruptWrite.response.status, 500);
    assert.equal(rejectedCorruptWrite.data.source, "state-store-invalid");
    assert.equal(await fs.readFile(chatStatePath, "utf8"), "{invalid-json");
    await fs.writeFile(chatStatePath, validChatState, "utf8");
    const backupState = JSON.parse(await fs.readFile(`${chatStatePath}.bak`, "utf8"));
    assert.equal(backupState.version, 2);
  } finally {
    await stopProcess(child);
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
  const upstream = http.createServer((req, res) => {
    if (req.url === "/healthz") return;
    if (req.url === "/api/notifications/push/status") {
      const body = JSON.stringify({ ok: true, pushNotifications: { supported: true } });
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("upstream-not-found");
  });
  await new Promise((resolve) => upstream.listen(upstreamPort, "127.0.0.1", resolve));
  await fs.writeFile(credentialsPath, `url=http://127.0.0.1:${upstreamPort}/\nusername=test\npassword=test\n`);
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
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitForOutput(child, /local http proxy ready/i);
    const malformedStatus = await new Promise((resolve, reject) => {
      const request = http.get({ host: "127.0.0.1", port: proxyPort, path: "/%E0%A4%A" }, (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      });
      request.on("error", reject);
    });
    assert.equal(malformedStatus, 400);
    assert.equal(child.exitCode, null);
    const healthStartedAt = Date.now();
    const unavailableHealth = await fetch(`http://127.0.0.1:${proxyPort}/healthz`);
    assert.equal(unavailableHealth.status, 502);
    assert.ok(Date.now() - healthStartedAt < 1_500, "proxy health failure did not respect its response deadline");
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

await check("atomic installer gates on strict health, prunes, and rolls back", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-deploy-regression-"));
  const sourceRoot = path.join(tempRoot, "source");
  const releaseRoot = path.join(tempRoot, "releases");
  const currentLink = path.join(tempRoot, "console-current");
  const envFile = path.join(tempRoot, "console.env");
  const binDir = path.join(tempRoot, "bin");
  const healthCountPath = path.join(tempRoot, "health-count");
  const previousRelease = path.join(releaseRoot, "20260101T000000Z-previous");
  await fs.mkdir(path.join(sourceRoot, "ops"), { recursive: true });
  await fs.mkdir(previousRelease, { recursive: true });
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(path.join(sourceRoot, "package-lock.json"), "{}\n");
  await fs.writeFile(path.join(sourceRoot, "source-marker.txt"), "source data remains intact\n");
  await fs.writeFile(path.join(sourceRoot, "ops", "codex-cloud-console.service"), "[Service]\nExecStart=/bin/true\n");
  await fs.writeFile(path.join(sourceRoot, "ops", "codex-cloud-console.env.example"), "CODEX_CLOUD_WEBHOOK_TOKEN=replace-me\n");
  await fs.writeFile(envFile, "CODEX_CLOUD_WEBHOOK_TOKEN=regression-token-123456\n");
  await fs.writeFile(path.join(previousRelease, "release-marker.txt"), "previous\n");
  await fs.symlink(previousRelease, currentLink);
  await fs.writeFile(
    path.join(binDir, "sudo"),
    `#!/bin/sh
if [ "$1" = "systemctl" ]; then
  [ "$2" = "status" ] && echo "fake systemd service active"
  exit 0
fi
if [ "$1" = "install" ]; then exit 0; fi
exec "$@"
`,
    { mode: 0o755 },
  );
  await fs.writeFile(path.join(binDir, "npm"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
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
  };
  try {
    const successful = await runCaptured("bash", [path.join(projectRoot, "ops", "install-systemd.sh"), sourceRoot], {
      cwd: projectRoot,
      env: { ...installerEnv, FAKE_HEALTH_MODE: "recover" },
    });
    assert.equal(successful.code, 0, successful.stderr || successful.stdout);
    assert.match(successful.stdout, /retained releases: 1/i);
    const activeRelease = await fs.realpath(currentLink);
    assert.notEqual(activeRelease, previousRelease);
    assert.equal((await fs.readdir(releaseRoot)).length, 1);
    assert.equal(await fs.readFile(path.join(sourceRoot, "source-marker.txt"), "utf8"), "source data remains intact\n");

    await fs.writeFile(healthCountPath, "0");
    const failed = await runCaptured("bash", [path.join(projectRoot, "ops", "install-systemd.sh"), sourceRoot], {
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

console.log(JSON.stringify({ ok: true, checks: results }, null, 2));
