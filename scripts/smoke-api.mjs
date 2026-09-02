#!/usr/bin/env node

const baseUrl = new URL(process.env.CODEX_CLOUD_SMOKE_URL || process.env.CODEX_CLOUD_CONSOLE_URL || "http://127.0.0.1:18787/");
const repoId = process.env.CODEX_CLOUD_SMOKE_REPO || "invest-dashboard";
const repeat = Math.max(1, Number(process.env.CODEX_CLOUD_SMOKE_REPEAT || 10));
const timeoutMs = Math.max(1_000, Number(process.env.CODEX_CLOUD_SMOKE_TIMEOUT_MS || 30_000));

const badStatusNeedles = [
  "连接断开",
  "Local mock",
  "本地模拟",
  "模拟响应",
  "模拟日志",
  "/bin/bash -lc",
  "app-server-command",
  "/home/ubuntu/codex-cloud/worktrees",
  "detached-worktree",
  "repo-cwd",
  "控制台重启时云端自动化仍在运行",
  "terminal: grep",
  "grep -n",
  "systemctl show codex-cloud-console.service",
  "mock snapshot",
  "Cloud console preview",
];

const degradedPayloadNeedles = [
  '"mocked":true',
  '"partial":true',
  '"authoritative":false',
  '"source":"local-fallback"',
  '"source":"local-mock"',
  '"source":"mock"',
  '"source":"app-server-unavailable"',
  '"source":"app-server-partial"',
  '"fallbackError"',
  "local-fallback",
  "Local mock",
  "本地模拟",
  "模拟响应",
  "模拟日志",
  "mock snapshot",
  "Cloud console preview",
];

function urlFor(pathname) {
  return new URL(pathname, baseUrl).href;
}

async function fetchText(pathname, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetch(urlFor(pathname), {
      ...options,
      signal: controller.signal,
      headers: { accept: "application/json,text/plain,*/*", ...(options.headers || {}) },
    });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      ms: Date.now() - started,
      text,
      headers: Object.fromEntries(response.headers.entries()),
      cache: response.headers.get("x-codex-cloud-cache") || "",
      fallback: response.headers.get("x-codex-cloud-proxy-fallback") || "",
    };
  } finally {
    clearTimeout(timer);
  }
}

function parseJson(result, label) {
  try {
    return JSON.parse(result.text);
  } catch (error) {
    throw new Error(`${label} did not return JSON: ${error.message}; body=${result.text.slice(0, 300)}`);
  }
}

function assertNoProxyFallback(result, label) {
  if (result.fallback) throw new Error(`${label} was served from stale proxy fallback: ${result.fallback}`);
}

function assertNoDegradedPayload(result, label) {
  const hits = degradedPayloadNeedles.filter((needle) => result.text.includes(needle));
  if (hits.length) throw new Error(`${label} returned degraded/mock/fallback payload: ${hits.join(", ")}`);
}

async function assertJson(pathname, predicate, label, assertionOptions = {}) {
  const attempts = Math.max(1, Number(assertionOptions.attempts || 1));
  let result = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    result = await fetchText(pathname);
    if (result.ok) break;
    await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
  }
  if (!result.ok) throw new Error(`${label} failed with HTTP ${result.status}: ${result.text.slice(0, 500)}`);
  assertNoProxyFallback(result, label);
  assertNoDegradedPayload(result, label);
  const data = parseJson(result, label);
  if (predicate && !predicate(data)) throw new Error(`${label} returned unexpected payload: ${JSON.stringify(data).slice(0, 1000)}`);
  return { label, ms: result.ms, cache: result.cache, fallback: result.fallback };
}

async function assertJsonRequest(pathname, options, predicate, label) {
  const result = await fetchText(pathname, options);
  if (!result.ok) throw new Error(`${label} failed with HTTP ${result.status}: ${result.text.slice(0, 500)}`);
  assertNoProxyFallback(result, label);
  assertNoDegradedPayload(result, label);
  const data = parseJson(result, label);
  if (predicate && !predicate(data)) throw new Error(`${label} returned unexpected payload: ${JSON.stringify(data).slice(0, 1000)}`);
  return { label, ms: result.ms, cache: result.cache, fallback: result.fallback, data };
}

async function assertStatus(pathname, expectedStatus, label) {
  const result = await fetchText(pathname);
  assertNoProxyFallback(result, label);
  if (result.status !== expectedStatus) {
    throw new Error(`${label} expected HTTP ${expectedStatus}, got ${result.status}: ${result.text.slice(0, 500)}`);
  }
  if (result.text) assertNoDegradedPayload(result, label);
  return { label, ms: result.ms, status: result.status, cache: result.cache, fallback: result.fallback };
}

async function assertRequestStatus(pathname, options, expectedStatus, label, assertionOptions = {}) {
  const attempts = Math.max(1, Number(assertionOptions.attempts || 1));
  let result = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    result = await fetchText(pathname, options);
    if (result.status === expectedStatus) break;
    await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
  }
  assertNoProxyFallback(result, label);
  if (result.status !== expectedStatus) {
    throw new Error(`${label} expected HTTP ${expectedStatus}, got ${result.status}: ${result.text.slice(0, 500)}`);
  }
  if (result.text && !assertionOptions.allowDegradedPayload) assertNoDegradedPayload(result, label);
  return { label, ms: result.ms, status: result.status, cache: result.cache, fallback: result.fallback };
}

function assertRuntimeShape(runtime, label) {
  if (!runtime || typeof runtime !== "object") throw new Error(`${label} missing runtime`);
  const required = ["model", "reasoning", "sandbox", "approval"];
  const missing = required.filter((key) => !runtime[key]);
  if (missing.length) throw new Error(`${label} runtime missing ${missing.join(", ")}: ${JSON.stringify(runtime)}`);
  if (!["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(runtime.reasoning)) {
    throw new Error(`${label} runtime has invalid reasoning: ${runtime.reasoning}`);
  }
  if (typeof runtime.search !== "boolean") throw new Error(`${label} runtime.search is not boolean: ${JSON.stringify(runtime)}`);
}

function assertTokenUsageShape(tokenUsage, label) {
  if (!tokenUsage || typeof tokenUsage !== "object") throw new Error(`${label} missing token usage`);
  const windowSize = Number(tokenUsage.modelContextWindow || 0);
  if (!Number.isFinite(windowSize) || windowSize <= 0) {
    throw new Error(`${label} missing positive modelContextWindow: ${JSON.stringify(tokenUsage).slice(0, 500)}`);
  }
}

async function repeatEndpoint(pathname, label) {
  const attempts = [];
  for (let index = 0; index < repeat; index += 1) {
    try {
      const result = await fetchText(pathname);
      if (result.fallback) throw new Error(`stale proxy fallback: ${result.fallback}`);
      assertNoDegradedPayload(result, label);
      attempts.push({ ok: result.ok, status: result.status, ms: result.ms, cache: result.cache, fallback: result.fallback, body: result.text.slice(0, 300) });
    } catch (error) {
      attempts.push({ ok: false, status: 0, ms: timeoutMs, error: error.message });
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  const failed = attempts.filter((item) => !item.ok);
  if (failed.length) {
    throw new Error(`${label} had ${failed.length}/${attempts.length} failed attempts: ${JSON.stringify(failed.slice(0, 3))}`);
  }
  return {
    label,
    attempts: attempts.length,
    maxMs: Math.max(...attempts.map((item) => item.ms)),
    staleFallbacks: attempts.filter((item) => item.fallback).length,
  };
}

const checks = [];

checks.push(await assertJson("/healthz", (data) => data?.ok === true && data?.strictOk !== false && data?.partial !== true, "healthz", { attempts: 10 }));
const statusResult = await fetchText("/api/status");
if (!statusResult.ok) throw new Error(`/api/status failed with HTTP ${statusResult.status}: ${statusResult.text.slice(0, 500)}`);
assertNoProxyFallback(statusResult, "status");
const status = parseJson(statusResult, "status");
if (status?.health?.ok !== true) throw new Error(`/api/status health is not ok: ${JSON.stringify(status?.health).slice(0, 1000)}`);
const badHits = Object.fromEntries(badStatusNeedles.map((needle) => [needle, statusResult.text.includes(needle)]));
const visibleBad = Object.entries(badHits).filter(([, hit]) => hit).map(([needle]) => needle);
if (visibleBad.length) throw new Error(`/api/status contains stale/internal text: ${visibleBad.join(", ")}`);
checks.push({ label: "status", ms: statusResult.ms, cache: statusResult.cache, fallback: statusResult.fallback });

checks.push(await assertJson("/api/codex/models", (data) => {
  const models = Array.isArray(data?.models) ? data.models : [];
  const defaultModel = models.find((model) => model.isDefault) || models[0];
  return Boolean(
    data?.ok === true &&
    data?.source === "app-server" &&
    data?.authoritative === true &&
    models.length > 0 &&
    models.some((model) => model.id === "gpt-5.6-sol") &&
    models.some((model) => model.id === "gpt-5.6-terra") &&
    !models.some((model) => model.id === "gpt-5.5") &&
    defaultModel?.id === "gpt-5.6-terra" &&
    Array.isArray(defaultModel.supportedReasoningEfforts) &&
    defaultModel.supportedReasoningEfforts.includes("medium") &&
    models.some((model) => Array.isArray(model.inputModalities) && model.inputModalities.includes("image")),
  );
}, "codex models"));

checks.push(await assertJson(`/api/codex/app-status?repoId=${encodeURIComponent(repoId)}`, (data) => {
  const mcpServers = Array.isArray(data?.mcpServers) ? data.mcpServers : [];
  const permissionProfiles = Array.isArray(data?.permissionProfiles) ? data.permissionProfiles : [];
  const config = data?.config || {};
  return Boolean(
    data?.ok === true &&
    data?.source === "app-server" &&
    data?.authoritative === true &&
    data?.account?.type &&
    mcpServers.length > 0 &&
    data?.plugins?.enabled >= 0 &&
    data?.skills?.total >= 0 &&
    permissionProfiles.length > 0 &&
    config.model &&
    config.sandbox &&
    config.approval,
  );
}, "codex app status", { attempts: 5 }));

checks.push(await repeatEndpoint(`/api/chat/sessions?repoId=${encodeURIComponent(repoId)}`, "chat sessions"));
const sessionSnapshot = await assertJsonRequest(
  `/api/chat/sessions?repoId=${encodeURIComponent(repoId)}&sync=1`,
  {},
  (data) => data?.ok === true && data?.source === "app-server" && data?.authoritative === true,
  "chat sessions authoritative snapshot",
);
checks.push({ label: sessionSnapshot.label, ms: sessionSnapshot.ms, cache: sessionSnapshot.cache, fallback: sessionSnapshot.fallback });
const initialSessions = Array.isArray(sessionSnapshot.data?.sessions) ? sessionSnapshot.data.sessions : [];
const initialActiveSession = initialSessions.find((session) => session.id === sessionSnapshot.data?.activeSessionId) || null;
const hasAppServerThread = Boolean(initialActiveSession?.threadId || initialActiveSession?.codexSessionId);

checks.push(await repeatEndpoint(`/api/chat/active?repoId=${encodeURIComponent(repoId)}`, "chat active"));
checks.push(await repeatEndpoint(`/api/codex/thread-state?repoId=${encodeURIComponent(repoId)}`, "thread state"));

checks.push(await assertJson(`/api/chat/active?repoId=${encodeURIComponent(repoId)}`, (data) => {
  if (!hasAppServerThread) {
    return (
      data?.ok === true &&
      data?.source === "app-server" &&
      data?.authoritative === true &&
      data?.partial === false &&
      data?.sessionId === null &&
      data?.threadId === null &&
      data?.threadState?.source === "app-server" &&
      data?.threadState?.authoritative === true &&
      data?.threadState?.partial === false &&
      data?.threadState?.threadId === null
    );
  }
  return (
    data?.ok === true &&
    data?.source === "app-server" &&
    data?.authoritative === true &&
    data?.partial === false &&
    data?.threadState?.source === "app-server" &&
    data?.threadState?.authoritative === true &&
    data?.threadState?.partial === false &&
    Boolean(data?.threadState?.threadId)
  );
}, "chat active includes authoritative app-server thread state", { attempts: 3 }));

checks.push(await assertJson(`/api/chat/sessions?repoId=${encodeURIComponent(repoId)}&sync=1`, (data) => {
  const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
  const active = Array.isArray(data?.sessions) ? data.sessions.find((session) => session.id === data.activeSessionId) : null;
  return (
    data?.ok === true &&
    data?.source === "app-server" &&
    data?.authoritative === true &&
    data?.sessionListSource === "app-server" &&
    data?.sessionListAuthoritative === true &&
    (hasAppServerThread
      ? active?.source === "app-server" && Boolean(active?.threadId || active?.codexSessionId)
      : data?.activeSessionId === null && sessions.length === 0)
  );
}, "chat sessions use authoritative app-server state", { attempts: 3 }));

checks.push(await assertJson(`/api/chat/history?repoId=${encodeURIComponent(repoId)}`, (data) => {
  const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
  const active = sessions.find((session) => session.id === data.activeSessionId) || null;
  const messages = Array.isArray(data?.messages) ? data.messages : [];
  const officialMessages = messages.every(
    (message) => message?.mocked !== true && message?.messageType !== "threadReadError" && message?.source !== "app-server-unavailable",
  );
  if (hasAppServerThread) return data?.ok === true && active?.source === "app-server" && officialMessages;
  return (
    data?.ok === true &&
    data?.source === "app-server" &&
    data?.authoritative === true &&
    data?.activeSessionId === null &&
    sessions.length === 0 &&
    messages.length === 0
  );
}, "chat history uses official app-server thread messages", { attempts: 3 }));

checks.push(await assertJson("/api/automations/runs", (data) => {
  const runs = Array.isArray(data?.runs) ? data.runs : [];
  const threadRuns = runs.filter((run) => run.threadId);
  const verificationLimit = Number(data?.verification?.limit || 0);
  const expectedVerifiedCount = Math.min(verificationLimit, threadRuns.length);
  const verificationWindow = threadRuns.slice(0, expectedVerifiedCount);
  const verificationWindowIsAuthoritative = verificationWindow.every(
    (run) => run.threadVerified === true && String(run.stateSource || "").includes("app-server-thread"),
  );
  const allRunsDeclareVerificationState = runs.every(
    (run) => typeof run.threadVerified === "boolean" && String(run.stateSource || "").startsWith("local-run-store"),
  );
  return (
    data?.ok === true &&
    data?.source === "local-run-store+app-server-thread-verification" &&
    data?.verification?.verifiedCount >= expectedVerifiedCount &&
    verificationWindowIsAuthoritative &&
    allRunsDeclareVerificationState
  );
}, "automation runs include app-server thread verification", { attempts: 3 }));

const draftCreate = await assertJsonRequest(
  "/api/chat/sessions",
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repoId, title: "新会话" }),
  },
  (data) => {
    const active = Array.isArray(data?.sessions) ? data.sessions.find((session) => session.id === data.activeSessionId) : null;
    return data?.ok === true && active?.source === "local" && active?.isDraft === true;
  },
  "empty local draft remains active immediately after creation",
);
checks.push({ label: draftCreate.label, ms: draftCreate.ms, cache: draftCreate.cache, fallback: draftCreate.fallback });

checks.push(await assertJson(`/api/chat/sessions?repoId=${encodeURIComponent(repoId)}&sync=1`, (data) => {
  const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
  const active = Array.isArray(data?.sessions) ? data.sessions.find((session) => session.id === data.activeSessionId) : null;
  return (
    data?.ok === true &&
    data?.source === "app-server" &&
    data?.authoritative === true &&
    data?.sessionListSource === "app-server" &&
    data?.sessionListAuthoritative === true &&
    (hasAppServerThread
      ? active?.source === "app-server" && Boolean(active?.threadId || active?.codexSessionId)
      : data?.activeSessionId === null && sessions.length === 0)
  );
}, "empty local draft reconciles to authoritative app-server state", { attempts: 3 }));

const missingSessionId = "missing-session-id-for-smoke";
checks.push(await assertStatus(`/api/chat/active?repoId=${encodeURIComponent(repoId)}&sessionId=${encodeURIComponent(missingSessionId)}`, 404, "missing session active"));
checks.push(await assertStatus(`/api/chat/history?repoId=${encodeURIComponent(repoId)}&sessionId=${encodeURIComponent(missingSessionId)}`, 404, "missing session history"));
checks.push(await assertStatus(`/api/codex/thread-state?repoId=${encodeURIComponent(repoId)}&sessionId=${encodeURIComponent(missingSessionId)}`, 404, "missing session thread state"));
checks.push(await assertStatus(`/api/codex/thread-read?repoId=${encodeURIComponent(repoId)}&sessionId=${encodeURIComponent(missingSessionId)}`, 404, "missing session thread read"));
checks.push(await assertStatus(`/api/cli/sessions?repoId=${encodeURIComponent(repoId)}`, 404, "raw cli debug sessions disabled"));
checks.push(await assertJson(`/api/codex/review/summary?repoId=${encodeURIComponent(repoId)}`, (data) => {
  return data?.ok === true && data?.source === "app-server-command" && data?.authoritative === true && typeof data?.data?.fileCount === "number";
}, "review summary app-server source", { attempts: 3 }));
checks.push(await assertJson(`/api/codex/review/snapshot?repoId=${encodeURIComponent(repoId)}`, (data) => {
  return data?.ok === true && data?.source === "app-server-command" && data?.authoritative === true && data?.data?.readOnly === true && Array.isArray(data?.data?.files);
}, "review snapshot app-server source", { attempts: 3 }));
checks.push(await assertRequestStatus(
  "/api/codex/review/action",
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repoId, action: "stage", level: "all" }),
  },
  501,
  "local review mutation disabled",
  { allowDegradedPayload: true, attempts: 3 },
));

const threadStateResult = await fetchText(`/api/codex/thread-state?repoId=${encodeURIComponent(repoId)}`);
if (!threadStateResult.ok) throw new Error(`/api/codex/thread-state failed with HTTP ${threadStateResult.status}: ${threadStateResult.text.slice(0, 500)}`);
assertNoProxyFallback(threadStateResult, "thread state capability");
assertNoDegradedPayload(threadStateResult, "thread state capability");
let threadState = parseJson(threadStateResult, "thread state capability");
if (threadState?.ok !== true) throw new Error(`/api/codex/thread-state is not ok: ${threadStateResult.text.slice(0, 1000)}`);
if (threadState?.source !== "app-server" || threadState?.authoritative !== true) {
  throw new Error(`/api/codex/thread-state is not authoritative app-server state: ${threadStateResult.text.slice(0, 1000)}`);
}
assertRuntimeShape(threadState.runtime, "thread state");
if (hasAppServerThread && !threadState.tokenUsage) {
  const sessionsResult = await fetchText(`/api/chat/sessions?repoId=${encodeURIComponent(repoId)}&sync=1`);
  if (!sessionsResult.ok) throw new Error(`token usage session lookup failed with HTTP ${sessionsResult.status}: ${sessionsResult.text.slice(0, 500)}`);
  assertNoProxyFallback(sessionsResult, "token usage session lookup");
  assertNoDegradedPayload(sessionsResult, "token usage session lookup");
  const sessionsData = parseJson(sessionsResult, "token usage session lookup");
  const tokenSession = (Array.isArray(sessionsData?.sessions) ? sessionsData.sessions : []).find((session) => session?.tokenUsage?.modelContextWindow);
  if (tokenSession?.id) {
    const tokenThreadStateResult = await fetchText(`/api/codex/thread-state?repoId=${encodeURIComponent(repoId)}&sessionId=${encodeURIComponent(tokenSession.id)}`);
    if (!tokenThreadStateResult.ok) {
      throw new Error(`token usage thread-state failed with HTTP ${tokenThreadStateResult.status}: ${tokenThreadStateResult.text.slice(0, 500)}`);
    }
    assertNoProxyFallback(tokenThreadStateResult, "token usage thread state");
    assertNoDegradedPayload(tokenThreadStateResult, "token usage thread state");
    threadState = parseJson(tokenThreadStateResult, "token usage thread state");
  }
}
if (hasAppServerThread) {
  assertTokenUsageShape(threadState.tokenUsage, "thread state");
  if (!threadState.threadId) throw new Error(`/api/codex/thread-state missing threadId: ${threadStateResult.text.slice(0, 1000)}`);
} else if (threadState.threadId !== null || threadState.partial !== false) {
  throw new Error(`/api/codex/thread-state did not return an authoritative empty state: ${threadStateResult.text.slice(0, 1000)}`);
}
checks.push({ label: "thread state capability", ms: threadStateResult.ms, cache: threadStateResult.cache, fallback: threadStateResult.fallback });

checks.push(await assertJson(`/api/files/tree?repoId=${encodeURIComponent(repoId)}&path=.`, (data) => {
  const entries = Array.isArray(data?.entries) ? data.entries : [];
  return data?.ok === true && data?.source === "app-server" && entries.every((entry) => entry.source === "app-server");
}, "files tree app-server source"));

checks.push(await assertJson(`/api/files/search?repoId=${encodeURIComponent(repoId)}&q=${encodeURIComponent("package")}`, (data) => {
  return data?.ok === true && data?.fallback === false && ["app-server", "app-server-fuzzy"].includes(data?.source);
}, "files search app-server source"));

const cleanupPaths = [];
const requiredDeletedPaths = new Set();
let fileSmokeError = null;
let cleanupError = null;
try {
  const uploadContent = `codex-cloud app-server upload smoke ${new Date().toISOString()}\n`;
  let uploadedPath = "";
  const uploadCheck = await assertJsonRequest(
    "/api/uploads",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repoId,
        files: [
          {
            name: "smoke-api-upload.txt",
            dataUrl: `data:text/plain;base64,${Buffer.from(uploadContent, "utf8").toString("base64")}`,
          },
        ],
      }),
    },
    (data) => {
      uploadedPath = String(data?.files?.[0]?.path || "");
      if (uploadedPath && !cleanupPaths.includes(uploadedPath)) cleanupPaths.push(uploadedPath);
      return data?.ok === true && data?.files?.[0]?.source === "app-server" && Boolean(uploadedPath);
    },
    "upload app-server source",
  );
  requiredDeletedPaths.add(uploadedPath);
  checks.push({ label: uploadCheck.label, ms: uploadCheck.ms, cache: uploadCheck.cache, fallback: uploadCheck.fallback });

  checks.push(await assertJson(`/api/files/read?repoId=${encodeURIComponent(repoId)}&path=${encodeURIComponent(uploadedPath)}`, (data) => {
    return data?.ok === true && data?.source === "app-server" && data?.content === uploadContent;
  }, "uploaded file read app-server source"));

  const blobResult = await fetchText(`/api/files/blob?repoId=${encodeURIComponent(repoId)}&path=${encodeURIComponent(uploadedPath)}`, {
    headers: { accept: "*/*" },
  });
  if (!blobResult.ok) throw new Error(`uploaded file blob failed with HTTP ${blobResult.status}: ${blobResult.text.slice(0, 500)}`);
  assertNoProxyFallback(blobResult, "uploaded file blob app-server source");
  assertNoDegradedPayload(blobResult, "uploaded file blob app-server source");
  if (blobResult.headers?.["x-codex-source"] !== "app-server") {
    throw new Error(`uploaded file blob did not use app-server source: ${JSON.stringify(blobResult.headers).slice(0, 500)}`);
  }
  if (blobResult.text !== uploadContent) {
    throw new Error("uploaded file blob content did not match uploaded content");
  }
  checks.push({ label: "uploaded file blob app-server source", ms: blobResult.ms, cache: blobResult.cache, fallback: blobResult.fallback });

  const writeContent = `codex-cloud app-server write smoke ${new Date().toISOString()}\n`;
  const writePath = `.codex-cloud/uploads/smoke-api-write-${Date.now().toString(36)}.txt`;
  cleanupPaths.push(writePath);
  const writeCheck = await assertJsonRequest(
    "/api/files/write",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoId, path: writePath, content: writeContent }),
    },
    (data) => data?.ok === true && data?.source === "app-server" && data?.path === writePath,
    "file write app-server source",
  );
  requiredDeletedPaths.add(writePath);
  checks.push({ label: writeCheck.label, ms: writeCheck.ms, cache: writeCheck.cache, fallback: writeCheck.fallback });

  checks.push(await assertJson(`/api/files/read?repoId=${encodeURIComponent(repoId)}&path=${encodeURIComponent(writePath)}`, (data) => {
    return data?.ok === true && data?.source === "app-server" && data?.content === writeContent;
  }, "written file read app-server source"));
} catch (error) {
  fileSmokeError = error;
} finally {
  if (cleanupPaths.length) {
    try {
      const cleanupCheck = await assertJsonRequest(
        "/api/uploads",
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ repoId, paths: cleanupPaths }),
        },
        (data) => {
          const deleted = new Set(Array.isArray(data?.deleted) ? data.deleted : []);
          const errors = Array.isArray(data?.errors) ? data.errors : [];
          return data?.ok === true && errors.length === 0 && [...requiredDeletedPaths].every((filePath) => deleted.has(filePath));
        },
        "smoke file cleanup",
      );
      checks.push({ label: cleanupCheck.label, ms: cleanupCheck.ms, cache: cleanupCheck.cache, fallback: cleanupCheck.fallback });
    } catch (error) {
      cleanupError = error;
    }
  }
}

if (fileSmokeError) {
  const cleanupSuffix = cleanupError ? `; cleanup also failed: ${cleanupError.message}` : "";
  throw new Error(`${fileSmokeError.message}${cleanupSuffix}`);
}
if (cleanupError) throw cleanupError;

console.log(JSON.stringify({ ok: true, baseUrl: baseUrl.href, repoId, repeat, checks }, null, 2));
