import express from "express";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { WebSocketServer } from "ws";
import webPush from "web-push";
import { CodexAppServerClient } from "./codex-app-server-client.mjs";
import { normalizeAppServerThreadMessages } from "./app-server-normalizers.mjs";
import { buildReviewSnapshotFromDiff, handleReviewRoutes } from "./review-git.mjs";

const app = express();
app.set("trust proxy", "loopback");
const server = http.createServer(app);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const defaultCloudRoot = process.platform === "linux" && process.env.NODE_ENV === "production"
  ? "/home/ubuntu/codex-cloud"
  : path.join(projectRoot, ".codex-cloud-local");
const cloudRoot = process.env.CODEX_CLOUD_ROOT || defaultCloudRoot;
const codexHome = process.env.CODEX_HOME || path.join(process.env.HOME || path.dirname(cloudRoot), ".codex");
const generatedImagesRoot = process.env.CODEX_GENERATED_IMAGES_ROOT || path.join(codexHome, "generated_images");
const workspaceRoot = process.env.CODEX_WORKSPACE_ROOT || path.join(cloudRoot, "workspace");
const logsRoot = process.env.CODEX_LOGS_ROOT || path.join(cloudRoot, "logs");
const stateRoot =
  process.env.CODEX_STATE_ROOT ||
  (process.env.NODE_ENV === "production" ? path.join(cloudRoot, "state") : path.join(projectRoot, ".codex-cloud-state"));
const chatHistoryPath = path.join(stateRoot, "chat-history.json");
const customReposPath = path.join(stateRoot, "custom-repos.json");
const automationRunsPath = path.join(stateRoot, "automation-runs.json");
const auditEventsPath = path.join(stateRoot, "audit-events.json");
const attentionStatePath = path.join(stateRoot, "attention-state.json");
const notificationStatePath = path.join(stateRoot, "notification-state.json");
const diagnosticsStatePath = path.join(stateRoot, "diagnostics-state.json");
const codexAppStatusCachePath = path.join(stateRoot, "codex-app-status-cache.json");
const codexModelsCachePath = path.join(stateRoot, "codex-models-cache.json");
const worktreesRoot = process.env.CODEX_WORKTREE_ROOT || path.join(cloudRoot, "worktrees");
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || "127.0.0.1";
const publicIp = process.env.CODEX_PUBLIC_IP || "13.231.3.21";
const publicOrigin = String(
  process.env.CODEX_CLOUD_PUBLIC_ORIGIN ||
    `https://${process.env.CODEX_CLOUD_HTTPS_HOST || `${publicIp}.sslip.io`}`,
).replace(/\/+$/, "");

app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy", "default-src 'self'; base-uri 'self'; connect-src 'self'; font-src 'self' data:; form-action 'self'; frame-ancestors 'none'; img-src 'self' data: blob: https:; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if (/^\/api\/automations\/[^/]+\/(webhook|heartbeat)$/.test(req.path)) return next();
  const origin = String(req.get("origin") || "").replace(/\/+$/, "");
  const localOrigin = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(origin);
  if ((origin && origin !== publicOrigin && !localOrigin) || req.get("sec-fetch-site") === "cross-site") {
    return res.status(403).json({ ok: false, error: "Cross-site mutation request rejected" });
  }
  return next();
});
app.use(express.json({ limit: process.env.CODEX_UPLOAD_JSON_LIMIT || "32mb" }));
const maxStoredChatMessages = 80;
const maxPromptChatMessages = 18;
const maxStoredSessions = Number(process.env.CODEX_MAX_SESSIONS || 120);
const appServerThreadPageSize = Math.min(Math.max(Number(process.env.CODEX_THREAD_PAGE_SIZE || 50), 10), 100);
const appServerReadTimeoutMs = Number(process.env.CODEX_APP_SERVER_READ_TIMEOUT_MS || 12_000);
const appServerFastReadTimeoutMs = Number(process.env.CODEX_APP_SERVER_FAST_READ_TIMEOUT_MS || 2_500);
const statusCacheTtlMs = Number(process.env.CODEX_STATUS_CACHE_TTL_MS || 20_000);
const statusFirstResponseMs = Number(process.env.CODEX_STATUS_FIRST_RESPONSE_MS || 2_000);
const appStatusCacheTtlMs = Number(process.env.CODEX_APP_STATUS_CACHE_TTL_MS || 60_000);
const appStatusFirstResponseMs = Number(process.env.CODEX_APP_STATUS_FIRST_RESPONSE_MS || 8_000);
const modelListCacheTtlMs = Number(process.env.CODEX_MODEL_LIST_CACHE_TTL_MS || 10 * 60_000);
const modelListFirstResponseMs = Number(process.env.CODEX_MODEL_LIST_FIRST_RESPONSE_MS || 6_000);
const threadStateCacheTtlMs = Number(process.env.CODEX_THREAD_STATE_CACHE_TTL_MS || 10_000);
const threadStateFirstResponseMs = Number(process.env.CODEX_THREAD_STATE_FIRST_RESPONSE_MS || 5_000);
const maxUploadBytes = Number(process.env.CODEX_MAX_UPLOAD_BYTES || 20 * 1024 * 1024);
const maxUploadFiles = Number(process.env.CODEX_MAX_UPLOAD_FILES || 8);
const codexTurnTimeoutMs = Number(process.env.CODEX_TURN_TIMEOUT_MS || 900_000);
const codexCompactTimeoutMs = Number(process.env.CODEX_COMPACT_TIMEOUT_MS || 900_000);
const automationAttentionMaxAgeHours = Number(process.env.CODEX_AUTOMATION_ATTENTION_MAX_AGE_HOURS || 72);
const allowLocalFallback = process.env.CODEX_ALLOW_LOCAL_FALLBACK === "1";
const enableCliDebug = process.env.CODEX_ENABLE_CLI_DEBUG === "1";
const enableLocalReviewRead = process.env.CODEX_ENABLE_LOCAL_REVIEW_READ === "1";
const enableLocalReviewMutation = process.env.CODEX_ENABLE_LOCAL_REVIEW_MUTATION === "1";
const defaultRuntime = {
  model: "gpt-5.5",
  reasoning: "medium",
  sandbox: "danger-full-access",
  approval: "never",
  search: true,
};
const allowedReasoning = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
const allowedSandbox = new Set(["read-only", "workspace-write", "danger-full-access"]);
const allowedApproval = new Set(["untrusted", "on-failure", "on-request", "never"]);
const pushSubject = process.env.CODEX_CLOUD_PUSH_SUBJECT || process.env.WEB_PUSH_SUBJECT || "mailto:codex-cloud@example.invalid";
const activeTurns = new Map();
const activeCompactions = new Map();
const activeAutomationRuns = new Map();
const threadOwners = new Map();
const turnOwners = new Map();
const itemOwners = new Map();
const mcpOauthResults = [];
const accountLoginFlows = new Map();
const appServerLiveEvents = [];
const appServerMcpStartup = new Map();
let appServerSkillsChangedAt = null;
let appServerAppListUpdated = null;
let appServerRemoteControl = null;
let appServerClient;
let serverEventSeq = 0;
let chatStoreWriteQueue = Promise.resolve();
let automationRunsWriteQueue = Promise.resolve();
let auditEventsWriteQueue = Promise.resolve();
let attentionStateWriteQueue = Promise.resolve();
let notificationStateWriteQueue = Promise.resolve();
let diagnosticsStateWriteQueue = Promise.resolve();
let notificationCheckRunning = false;
let statusCache = null;
let statusRefreshPromise = null;
let modelListCache = null;
let modelListRefreshPromise = null;
const appStatusCacheByRepo = new Map();
const appStatusRefreshByRepo = new Map();
const repoSessionSyncByRepo = new Map();
const threadSummaryRefreshByKey = new Map();
const threadStateCacheByKey = new Map();
const threadStateRefreshByKey = new Map();
const threadStateRevisionByKey = new Map();
const automationThreadVerificationById = new Map();
const automationThreadVerificationTtlMs = Number(process.env.CODEX_AUTOMATION_THREAD_VERIFY_TTL_MS || 30_000);
const automationThreadVerificationDefaultLimit = Math.min(
  Math.max(Number(process.env.CODEX_AUTOMATION_THREAD_VERIFY_LIMIT || 12), 0),
  50,
);
const automationTriggerRateWindowMs = Number(process.env.CODEX_AUTOMATION_TRIGGER_RATE_WINDOW_MS || 60_000);
const automationTriggerRateMax = Number(process.env.CODEX_AUTOMATION_TRIGGER_RATE_MAX || 12);
const automationTriggerIdempotencyTtlMs = Number(process.env.CODEX_AUTOMATION_IDEMPOTENCY_TTL_MS || 24 * 60 * 60 * 1000);
const automationTriggerRateByKey = new Map();
const automationTriggerIdempotency = new Map();
const configuredOwnerEntries = Number(process.env.CODEX_OWNER_INDEX_MAX || 5_000);
const maxOwnerEntries = Number.isFinite(configuredOwnerEntries) ? Math.max(500, configuredOwnerEntries) : 5_000;

const repos = [
  {
    id: "invest-dashboard",
    name: "invest-dashboard",
    path: path.join(workspaceRoot, "invest-dashboard"),
    remote: "WilsonWang01/invest-dashboard",
    accent: "teal",
  },
  {
    id: "macro-control-dashboard",
    name: "macro-control-dashboard",
    path: path.join(workspaceRoot, "macro-control-dashboard"),
    remote: "WilsonWang01/macro-control-dashboard",
    accent: "blue",
  },
  {
    id: "memory-export-tracker",
    name: "memory-export-tracker",
    path: path.join(workspaceRoot, "memory-export-tracker"),
    remote: "WilsonWang01/memory-export-tracker",
    accent: "amber",
  },
];

const repoAccents = ["teal", "blue", "amber"];

const automations = [
  {
    id: "invest-daily-update",
    name: "投资监控每日更新",
    repoId: "invest-dashboard",
    timer: "codex-auto-invest-daily-update.timer",
    service: "codex-auto-invest-daily-update.service",
    schedule: "工作日 09:30",
    model: "gpt-5.5",
    reasoning: "high",
    prompt: "运行投资监控每日更新流程。先检查仓库说明和现有脚本，在隔离工作区中完成数据/页面更新，最后汇总运行结果、文件变更和需要人工关注的问题。",
  },
  {
    id: "invest-completion-check",
    name: "投资监控每日完成度检查",
    repoId: "invest-dashboard",
    timer: "codex-auto-invest-completion-check.timer",
    service: "codex-auto-invest-completion-check.service",
    schedule: "工作日 09:50",
    model: "gpt-5.5",
    reasoning: "medium",
    prompt: "检查投资监控每日任务完成度。读取当前仓库状态和日志，确认数据刷新、研究摘要和页面输出是否完整，最后给出通过/失败原因和后续动作。",
  },
  {
    id: "macro-control-refresh",
    name: "每日宏观看板数据与解读刷新",
    repoId: "macro-control-dashboard",
    timer: "codex-auto-macro-control-refresh.timer",
    service: "codex-auto-macro-control-refresh.service",
    schedule: "每天 18:30",
    model: "gpt-5.4-mini",
    reasoning: "low",
    prompt: "刷新宏观看板数据与解读。使用仓库现有脚本和文档，在隔离工作区中执行更新，最后汇总数据来源、输出文件和任何失败。",
  },
  {
    id: "memory-export-refresh",
    name: "Update Korea memory export dashboard data",
    repoId: "memory-export-tracker",
    timer: "codex-auto-memory-export-refresh.timer",
    service: "codex-auto-memory-export-refresh.service",
    schedule: "每 24 小时",
    model: "gpt-5.4-mini",
    reasoning: "low",
    prompt: "更新 Korea memory export dashboard 数据。使用仓库现有更新流程，在隔离工作区中运行并报告变更、验证结果和下一步。",
  },
];

await loadCustomRepos();

function run(command, args = [], options = {}) {
  return new Promise((resolve) => {
    if (options.input) {
      const child = spawn(command, args, {
        cwd: options.cwd || projectRoot,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
      }, options.timeout || 12_000);
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({
          ok: code === 0,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          code,
        });
      });
      child.stdin.end(options.input);
      return;
    }

    execFile(
      command,
      args,
      {
        timeout: options.timeout || 12_000,
        cwd: options.cwd || projectRoot,
        env: process.env,
      },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          code: error?.code ?? 0,
        });
      },
    );
  });
}

function slugifyRepoId(value) {
  const slug = String(value || "")
    .trim()
    .replace(/\.git$/i, "")
    .split("/")
    .filter(Boolean)
    .at(-1)
    ?.toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || `project-${Date.now().toString(36)}`;
}

function repoCloneUrl(remote) {
  const value = String(remote || "").trim();
  if (!value) return "";
  if (/^(https?:\/\/|git@|ssh:\/\/)/i.test(value)) return value;
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) return `https://github.com/${value}.git`;
  return value;
}

function repoDisplayRemote(remote) {
  const value = String(remote || "").trim();
  const github = value.match(/github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?$/i);
  if (github) return github[1];
  return value;
}

function normalizeCustomRepo(item, index = 0) {
  const id = slugifyRepoId(item?.id || item?.name || item?.remote);
  const name = String(item?.name || id).trim().slice(0, 80) || id;
  return {
    id,
    name,
    path: path.resolve(workspaceRoot, id),
    remote: repoDisplayRemote(item?.remote || item?.cloneUrl || ""),
    cloneUrl: repoCloneUrl(item?.cloneUrl || item?.remote || ""),
    accent: repoAccents[index % repoAccents.length],
    custom: true,
  };
}

async function readCustomRepos() {
  const parsed = await readJsonState(customReposPath, { repos: [] });
  return Array.isArray(parsed?.repos) ? parsed.repos.map(normalizeCustomRepo).filter((repo) => repo.id) : [];
}

async function writeCustomRepos(customRepos) {
  await atomicWriteJson(customReposPath, { repos: customRepos });
}

async function loadCustomRepos() {
  const customRepos = await readCustomRepos();
  for (const repo of customRepos) {
    if (!repos.some((existing) => existing.id === repo.id)) repos.push(repo);
  }
}

async function codexAppServerRequest(method, params = {}, timeout = 20_000) {
  try {
    const result = await getAppServerClient().request(method, params, timeout);
    return { ok: true, result, stderr: getAppServerClient().status().stderrTail.join("\n") };
  } catch (error) {
    return {
      ok: false,
      error: appServerErrorMessage(error, "Codex app-server request failed"),
      stderr: getAppServerClient().status().stderrTail.join("\n"),
    };
  }
}

function appServerUnavailableError(operation, error = "") {
  const detail = compactSingleLine(error || "Codex app-server unavailable", 360);
  const err = new Error(`${operation} failed through Codex app-server${detail ? `: ${detail}` : ""}`);
  err.statusCode = 502;
  err.source = "app-server-unavailable";
  return err;
}

function sendRouteError(res, error, fallbackStatus = 400) {
  res.status(error?.statusCode || fallbackStatus).json({
    ok: false,
    error: error?.message || "Request failed",
    ...(error?.source ? { source: error.source } : {}),
  });
}

function sendAppServerOnlyError(res, error) {
  return res.status(501).json({
    ok: false,
    source: "app-server-only",
    authoritative: false,
    error,
  });
}

function normalizeChatMessage(item) {
  const role = item?.role === "user" ? "user" : "codex";
  const text = String(item?.text || "").slice(0, 12000);
  const normalized = {
    id: String(item?.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`),
    role,
    text,
    time: String(item?.time || new Date().toISOString()),
    mocked: Boolean(item?.mocked),
  };
  if (item?.messageType) normalized.messageType = String(item.messageType);
  if (item?.status) normalized.status = String(item.status);
  if (item?.source) normalized.source = String(item.source);
  if (item?.turnId) normalized.turnId = String(item.turnId);
  if (typeof item?.turnIndex === "number") normalized.turnIndex = item.turnIndex;
  if (item?.details && typeof item.details === "object") normalized.details = item.details;
  if (Array.isArray(item?.attachments)) {
    normalized.attachments = item.attachments
      .slice(0, maxUploadFiles)
      .map(normalizeDraftAttachment)
      .filter((attachment) => attachment.path || attachment.absolutePath);
  }
  return normalized;
}

function sessionId() {
  return `sess-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}`;
}

function sessionTitle(message = "") {
  const title = String(message || "").replace(/\s+/g, " ").trim();
  return title ? title.slice(0, 38) : "新会话";
}

function normalizeSession(item, repoId) {
  const createdAt = String(item?.createdAt || new Date().toISOString());
  const messages = Array.isArray(item?.messages) ? item.messages.map(normalizeChatMessage).filter((message) => message.text) : [];
  const messageCount = Number(item?.messageCount || messages.length || 0);
  return {
    id: String(item?.id || sessionId()),
    repoId: String(item?.repoId || repoId),
    title: sessionTitle(item?.title || messages.find((message) => message.role === "user")?.text || "新会话"),
    createdAt,
    updatedAt: String(item?.updatedAt || messages.at(-1)?.time || createdAt),
    messages: messages.slice(-maxStoredChatMessages),
    messageCount: Number.isFinite(messageCount) && messageCount > 0 ? Math.max(messageCount, messages.length) : messages.length,
    codexSessionId: item?.codexSessionId ? String(item.codexSessionId) : null,
    model: item?.model ? String(item.model) : null,
    reasoning: item?.reasoning ? String(item.reasoning) : null,
    sandbox: item?.sandbox ? String(item.sandbox) : null,
    approval: item?.approval ? String(item.approval) : null,
    search: typeof item?.search === "boolean" ? item.search : null,
    pendingTurnRuntime: normalizePendingTurnRuntime(item?.pendingTurnRuntime, item),
    tokenUsage: normalizeTokenUsage(item?.tokenUsage),
    goal: item?.goal && typeof item.goal === "object" ? item.goal : null,
    compactedAt: item?.compactedAt ? String(item.compactedAt) : null,
    draft: normalizeChatDraft(item?.draft),
  };
}

function normalizeDraftAttachment(item = {}) {
  const name = safeUploadName(item?.name || path.basename(String(item?.path || "attachment")) || "attachment");
  const mimeType = String(item?.mimeType || item?.type || "application/octet-stream").slice(0, 160);
  const rawSize = Number(item?.size || 0);
  const kind = item?.kind === "image" || mimeType.startsWith("image/") ? "image" : "file";
  return {
    name,
    path: String(item?.path || "").slice(0, 1000),
    absolutePath: item?.absolutePath ? String(item.absolutePath).slice(0, 1400) : undefined,
    mimeType,
    size: Number.isFinite(rawSize) && rawSize > 0 ? rawSize : 0,
    kind,
  };
}

function normalizeChatDraft(value = {}) {
  const input = String(value?.input || value?.text || "").slice(0, 120_000);
  const attachments = Array.isArray(value?.attachments)
    ? value.attachments
        .slice(0, maxUploadFiles)
        .map(normalizeDraftAttachment)
        .filter((attachment) => attachment.path || attachment.absolutePath)
    : [];
  return {
    input,
    attachments,
    updatedAt: value?.updatedAt ? String(value.updatedAt) : null,
  };
}

function isEmptyDraftSession(session = {}) {
  const title = String(session.title || "").trim();
  const messageCount = Array.isArray(session.messages) ? session.messages.length : Number(session.messageCount || 0);
  const draft = normalizeChatDraft(session.draft || {});
  const hasDraftContent = Boolean(draft.input.trim() || draft.attachments.length);
  return !session.codexSessionId && messageCount === 0 && !hasDraftContent && (!title || title === "新会话" || title === "新对话");
}

function isLocalDraftSession(session = {}) {
  return !session.codexSessionId;
}

function chooseRepoActiveSessionId(store, repoId, options = {}) {
  const activeId = String(store.activeByRepo?.[repoId] || "");
  const active = activeId ? store.sessions?.[activeId] : null;
  if (active?.repoId === repoId) {
    if (active.codexSessionId) return active.id;
    if (options.preserveLocalActive || options.allowLocalActive) return active.id;
  }

  const appServerActive = Object.values(store.sessions || {})
    .filter((session) => session.repoId === repoId && session.codexSessionId)
    .sort((a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime())[0];
  if (appServerActive) return appServerActive.id;

  if (active?.repoId === repoId && (options.preserveLocalActive || options.allowLocalActive)) return active.id;

  const latestLocal = Object.values(store.sessions || {})
    .filter((session) => session.repoId === repoId)
    .sort((a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime())[0];
  return options.allowLocalActive ? latestLocal?.id || "" : "";
}

function compactEmptyDraftSessions(store, repoId, keepSessionId = "") {
  const keepId = String(keepSessionId || "");
  const deleted = [];
  for (const session of Object.values(store.sessions || {})) {
    if (session.repoId !== repoId || !isEmptyDraftSession(session)) continue;
    if (keepId && session.id === keepId) continue;
    delete store.sessions[session.id];
    deleted.push(session.id);
  }
  if (!deleted.length) return deleted;
  const remaining = Object.values(store.sessions || {})
    .filter((session) => session.repoId === repoId)
    .sort((a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime());
  if (!store.activeByRepo[repoId] || deleted.includes(store.activeByRepo[repoId])) {
    store.activeByRepo[repoId] = remaining[0]?.id || "";
  }
  store.__deletedSessionIds = [...new Set([...(store.__deletedSessionIds || []), ...deleted])];
  return deleted;
}

function emptyTokenBreakdown() {
  return {
    totalTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  };
}

function normalizeTokenBreakdown(value) {
  if (!value || typeof value !== "object") return emptyTokenBreakdown();
  const numberValue = (camel, snake = camel) => {
    const raw = value[camel] ?? value[snake] ?? 0;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  };
  return {
    totalTokens: numberValue("totalTokens", "total_tokens"),
    inputTokens: numberValue("inputTokens", "input_tokens"),
    cachedInputTokens: numberValue("cachedInputTokens", "cached_input_tokens"),
    outputTokens: numberValue("outputTokens", "output_tokens"),
    reasoningOutputTokens: numberValue("reasoningOutputTokens", "reasoning_output_tokens"),
  };
}

function normalizeTokenUsage(value) {
  if (!value || typeof value !== "object") return null;
  const total = normalizeTokenBreakdown(value.total || value.total_tokens || value);
  const last = normalizeTokenBreakdown(value.last || value.last_turn || value.lastTurn || value);
  const rawWindow = value.modelContextWindow ?? value.model_context_window ?? value.contextWindow ?? value.context_window;
  const modelContextWindow = Number(rawWindow || 0);
  return {
    total,
    last,
    modelContextWindow: Number.isFinite(modelContextWindow) && modelContextWindow > 0 ? modelContextWindow : null,
  };
}

function cleanModel(value, fallback = defaultRuntime.model) {
  const model = String(value || "").trim();
  return /^[A-Za-z0-9._:-]{2,64}$/.test(model) ? model : fallback;
}

function choice(value, allowed, fallback) {
  const candidate = String(value || "").trim();
  return allowed.has(candidate) ? candidate : fallback;
}

function uniqueTempPath(targetPath) {
  return `${targetPath}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(16).slice(2)}.tmp`;
}

async function atomicWriteJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = uniqueTempPath(filePath);
  const handle = await fs.open(tmpPath, "w", 0o600);
  try {
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.copyFile(filePath, `${filePath}.bak`);
      await fs.chmod(`${filePath}.bak`, 0o600);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await fs.rename(tmpPath, filePath);
  } finally {
    await fs.rm(tmpPath, { force: true }).catch(() => null);
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

async function cleanupStaleStateTempFiles() {
  await fs.mkdir(stateRoot, { recursive: true });
  const managedNames = new Set([
    chatHistoryPath,
    customReposPath,
    automationRunsPath,
    auditEventsPath,
    attentionStatePath,
    notificationStatePath,
    diagnosticsStatePath,
    codexAppStatusCachePath,
    codexModelsCachePath,
  ].map((filePath) => path.basename(filePath)));
  const entries = await fs.readdir(stateRoot, { withFileTypes: true });
  const removed = [];
  const oldEnoughToIgnorePidReuseMs = 24 * 60 * 60 * 1000;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = entry.name.match(/^(.*)\.(\d+)\.[a-z0-9]+\.[a-f0-9]+\.tmp$/i);
    if (!match || !managedNames.has(match[1])) continue;
    const filePath = path.join(stateRoot, entry.name);
    const stat = await fs.lstat(filePath).catch(() => null);
    if (!stat?.isFile()) continue;
    const ownerPid = Number(match[2]);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ownerPid === process.pid) continue;
    if (processExists(ownerPid) && ageMs < oldEnoughToIgnorePidReuseMs) continue;
    await fs.rm(filePath, { force: true });
    removed.push(entry.name);
  }
  return removed;
}

async function readJsonState(filePath, emptyValue) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return typeof emptyValue === "function" ? emptyValue() : structuredClone(emptyValue);
    const stateError = new Error(`State file is unreadable or invalid: ${path.basename(filePath)}: ${error.message}`);
    stateError.statusCode = 500;
    stateError.source = "state-store-invalid";
    stateError.cause = error;
    throw stateError;
  }
}

function enqueueWrite(queueName, task) {
  const previous =
    queueName === "chat"
      ? chatStoreWriteQueue
      : queueName === "audit"
        ? auditEventsWriteQueue
        : queueName === "attention"
        ? attentionStateWriteQueue
        : queueName === "notification"
          ? notificationStateWriteQueue
          : queueName === "diagnostics"
            ? diagnosticsStateWriteQueue
          : automationRunsWriteQueue;
  const next = previous.catch(() => null).then(task);
  if (queueName === "chat") chatStoreWriteQueue = next.catch(() => null);
  else if (queueName === "audit") auditEventsWriteQueue = next.catch(() => null);
  else if (queueName === "attention") attentionStateWriteQueue = next.catch(() => null);
  else if (queueName === "notification") notificationStateWriteQueue = next.catch(() => null);
  else if (queueName === "diagnostics") diagnosticsStateWriteQueue = next.catch(() => null);
  else automationRunsWriteQueue = next.catch(() => null);
  return next;
}

function normalizeRuntime(input = {}, session = {}) {
  const base = {
    model: session.model || defaultRuntime.model,
    reasoning: session.reasoning || defaultRuntime.reasoning,
    sandbox: session.sandbox || defaultRuntime.sandbox,
    approval: session.approval || defaultRuntime.approval,
    search: typeof session.search === "boolean" ? session.search : defaultRuntime.search,
  };
  return {
    model: cleanModel(input.model, base.model),
    reasoning: choice(input.reasoning, allowedReasoning, base.reasoning),
    sandbox: choice(input.sandbox, allowedSandbox, base.sandbox),
    approval: choice(input.approval, allowedApproval, base.approval),
    search: typeof input.search === "boolean" ? input.search : base.search,
  };
}

function normalizePendingTurnRuntime(value, session = {}) {
  if (!value || typeof value !== "object") return null;
  const runtime = normalizeRuntime(value, session);
  return {
    model: runtime.model,
    reasoning: runtime.reasoning,
    updatedAt: value.updatedAt ? String(value.updatedAt) : new Date().toISOString(),
  };
}

function pendingTurnRuntimeApplied(pending = null, runtime = {}) {
  if (!pending) return true;
  return pending.model === runtime.model && pending.reasoning === runtime.reasoning;
}

function mergeAppServerRuntimeWithPending(session = {}, appServerRuntime = {}, options = {}) {
  const pending = normalizePendingTurnRuntime(session.pendingTurnRuntime, session);
  if (!pending || (options.clearPending && pendingTurnRuntimeApplied(pending, appServerRuntime))) {
    return { ...appServerRuntime, pendingTurnRuntime: null };
  }
  return {
    ...appServerRuntime,
    model: pending.model,
    reasoning: pending.reasoning,
    search: typeof session.search === "boolean" ? session.search : appServerRuntime.search,
    pendingTurnRuntime: pending,
  };
}

function normalizeApprovalPolicy(value, fallback = defaultRuntime.approval) {
  if (typeof value === "string") return choice(value, allowedApproval, fallback);
  if (value && typeof value === "object" && value.granular) return "on-request";
  return fallback;
}

function normalizeSandboxMode(value, fallback = defaultRuntime.sandbox) {
  if (typeof value === "string") return choice(value, allowedSandbox, fallback);
  const type = String(value?.type || value?.mode || "").trim();
  if (type === "dangerFullAccess") return "danger-full-access";
  if (type === "readOnly") return "read-only";
  if (type === "workspaceWrite") return "workspace-write";
  return fallback;
}

function runtimeFromAppServerSettings(result = {}, fallback = {}) {
  const settings = result.threadSettings || result.settings || {};
  return {
    model: cleanModel(result.model || settings.model, fallback.model || defaultRuntime.model),
    reasoning: choice(result.reasoningEffort || settings.effort, allowedReasoning, fallback.reasoning || defaultRuntime.reasoning),
    sandbox: normalizeSandboxMode(result.sandbox || result.sandboxPolicy || settings.sandboxPolicy, fallback.sandbox || defaultRuntime.sandbox),
    approval: normalizeApprovalPolicy(result.approvalPolicy || settings.approvalPolicy, fallback.approval || defaultRuntime.approval),
    search: typeof fallback.search === "boolean" ? fallback.search : defaultRuntime.search,
  };
}

async function refreshSessionRuntimeFromAppServer(repo, session, options = {}) {
  if (!session?.codexSessionId) return session;
  const response = await codexAppServerRequest("thread/resume", { threadId: session.codexSessionId, cwd: repo.path }, options.timeout || 20_000);
  if (!response.ok) return session;
  const appServerRuntime = runtimeFromAppServerSettings(response.result || {}, session);
  const runtime = mergeAppServerRuntimeWithPending(session, appServerRuntime);
  return (await updateSessionRuntime(repo.id, session.id, runtime, { makeActive: false })) || session;
}

async function readChatStore() {
  const parsed = await readJsonState(chatHistoryPath, { version: 2, activeByRepo: {}, sessions: {} });
  const sessions = {};
  const activeByRepo = parsed?.activeByRepo && typeof parsed.activeByRepo === "object" ? parsed.activeByRepo : {};

  if (parsed?.sessions && typeof parsed.sessions === "object") {
    for (const [key, value] of Object.entries(parsed.sessions)) {
      if (Array.isArray(value)) {
        const migrated = normalizeSession(
          {
            id: `legacy-${key}`,
            repoId: key,
            title: value.find((message) => message?.role === "user")?.text || "默认会话",
            messages: value,
          },
          key,
        );
        sessions[migrated.id] = migrated;
        activeByRepo[key] ||= migrated.id;
        continue;
      }

      const repoId = value?.repoId || key;
      const normalized = normalizeSession(value, repoId);
      sessions[normalized.id] = normalized;
      activeByRepo[normalized.repoId] ||= normalized.id;
    }
  }

  return { version: 2, activeByRepo, sessions };
}

async function mutateChatStore(mutator) {
  return enqueueWrite("chat", async () => {
    const store = await readChatStore();
    const result = await mutator(store);
    await atomicWriteJson(chatHistoryPath, { version: 2, activeByRepo: store.activeByRepo, sessions: store.sessions });
    return result;
  });
}

async function activateStoredSession(repoId, sessionId, keepSessionId = "") {
  return mutateChatStore((store) => {
    const session = store.sessions[sessionId];
    if (!session || session.repoId !== repoId) return null;
    store.activeByRepo[repoId] = session.id;
    compactEmptyDraftSessions(store, repoId, keepSessionId);
    return session;
  });
}

async function ensureChatSession(repoId, sessionHint, title = "新会话") {
  let store = await readChatStore();
  const hinted = findStoredSessionByHint(store, repoId, sessionHint);
  if (hinted) {
    return (await activateStoredSession(repoId, hinted.id, isEmptyDraftSession(hinted) ? hinted.id : "")) || hinted;
  }

  if (shouldResolveAppThreadHint(sessionHint)) {
    const repo = getRepoById(repoId);
    const imported = await importAppServerThreadSession(repo, appThreadIdFromSessionHint(sessionHint), title).catch(() => null);
    if (imported) return imported;
  }

  const chosenActiveId = chooseRepoActiveSessionId(store, repoId);
  const active = chosenActiveId && store.sessions[chosenActiveId]?.repoId === repoId
    ? store.sessions[chosenActiveId]
    : null;
  if (!sessionHint && active) {
    return (await activateStoredSession(repoId, active.id, isEmptyDraftSession(active) ? active.id : "")) || active;
  }

  const next = normalizeSession({ id: sessionId(), repoId, title, messages: [] }, repoId);
  return mutateChatStore((current) => {
    const concurrent = findStoredSessionByHint(current, repoId, sessionHint);
    if (concurrent) {
      current.activeByRepo[repoId] = concurrent.id;
      return concurrent;
    }
    if (!sessionHint) {
      const activeId = chooseRepoActiveSessionId(current, repoId, { allowLocalActive: true });
      const concurrentActive = activeId ? current.sessions[activeId] : null;
      if (concurrentActive) {
        current.activeByRepo[repoId] = concurrentActive.id;
        return concurrentActive;
      }
    }
    current.sessions[next.id] = next;
    current.activeByRepo[repoId] = next.id;
    compactEmptyDraftSessions(current, repoId, next.id);
    return next;
  });
}

async function resolveChatSessionForRead(repoId, sessionHint = "", options = {}) {
  const hint = String(sessionHint || "").trim();
  if (!hint) return ensureChatSession(repoId, "");

  let store = await readChatStore();
  const hinted = findStoredSessionByHint(store, repoId, hint);
  if (hinted) {
    return (await activateStoredSession(repoId, hinted.id, isEmptyDraftSession(hinted) ? hinted.id : "")) || hinted;
  }

  if (shouldResolveAppThreadHint(hint)) {
    const repo = getRepoById(repoId);
    const imported = await importAppServerThreadSession(repo, appThreadIdFromSessionHint(hint)).catch(() => null);
    if (imported) return imported;
  }

  if (options.strictHint) return null;

  const chosenActiveId = chooseRepoActiveSessionId(store, repoId);
  const active = chosenActiveId && store.sessions[chosenActiveId]?.repoId === repoId
    ? store.sessions[chosenActiveId]
    : null;
  if (active) {
    return (await activateStoredSession(repoId, active.id, isEmptyDraftSession(active) ? active.id : "")) || active;
  }

  const latest = Object.values(store.sessions)
    .filter((session) => session.repoId === repoId)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0];
  if (latest) {
    return (await activateStoredSession(repoId, latest.id)) || latest;
  }

  return ensureChatSession(repoId, "");
}

async function resolveChatSessionForRequest(repoId, rawSessionId = "") {
  const sessionHint = String(rawSessionId || "").trim();
  if (sessionHint) return resolveChatSessionForRead(repoId, sessionHint, { strictHint: true });

  const store = await readChatStore();
  const activeId = chooseRepoActiveSessionId(store, repoId, { allowLocalActive: true });
  return activeId && store.sessions[activeId]?.repoId === repoId ? store.sessions[activeId] : null;
}

async function resolveSyncedChatSessionForRequest(repo, rawSessionId = "") {
  const requestedSessionId = String(rawSessionId || "").trim();
  let session = await resolveChatSessionForRequest(repo.id, requestedSessionId);
  if (session || requestedSessionId) return { session, summary: null, requestedSessionId };

  const summary = await getRepoSessions(repo.id, {
    timeout: appServerFastReadTimeoutMs,
    requireAppServerSync: true,
  });
  if (summary.ok && summary.authoritative === true && summary.activeSessionId) {
    session = await resolveChatSessionForRequest(repo.id, summary.activeSessionId);
  }
  return { session, summary, requestedSessionId };
}

async function createStoredChatSession(repoId, title = "新会话", { makeActive = true } = {}) {
  const next = normalizeSession({ id: sessionId(), repoId, title, messages: [] }, repoId);
  return mutateChatStore((store) => {
    store.sessions[next.id] = next;
    if (makeActive) store.activeByRepo[repoId] = next.id;
    if (makeActive) compactEmptyDraftSessions(store, repoId, next.id);
    return next;
  });
}

function appThreadTime(value) {
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return new Date().toISOString();
  const ms = numeric > 10_000_000_000 ? numeric : numeric * 1000;
  return new Date(ms).toISOString();
}

function appThreadTitle(thread = {}) {
  const title = thread.name || thread.title || thread.preview || thread.firstUserMessage || thread.first_user_message || thread.id || "新会话";
  return sessionTitle(title);
}

function appThreadSessionId(threadId) {
  return `app-${String(threadId || "").replace(/[^A-Za-z0-9._-]+/g, "-")}`;
}

function appThreadIdFromSessionHint(sessionHint) {
  const hint = String(sessionHint || "").trim();
  if (!hint || hint.startsWith("sess-") || hint.startsWith("legacy-")) return "";
  if (hint.startsWith("app-")) return hint.slice(4);
  return hint;
}

function isLikelyAppThreadId(value) {
  return /^[0-9a-f]{8,}(?:-[0-9a-f]{4,}){2,}$/i.test(String(value || "").trim());
}

function shouldResolveAppThreadHint(sessionHint) {
  const hint = String(sessionHint || "").trim();
  const threadId = appThreadIdFromSessionHint(sessionHint);
  return Boolean(threadId && (hint.startsWith("app-") || isLikelyAppThreadId(threadId)));
}

function findStoredSessionByHint(store, repoId, sessionHint) {
  const hint = String(sessionHint || "").trim();
  if (!hint) return null;
  const direct = store.sessions[hint];
  if (direct?.repoId === repoId) return direct;
  const threadId = appThreadIdFromSessionHint(hint);
  if (!threadId) return null;
  return (
    Object.values(store.sessions).find((session) => session.repoId === repoId && session.codexSessionId === threadId) ||
    null
  );
}

function normalizedPathPrefix(value = "") {
  return String(value || "").replace(/\/+$/, "");
}

function repoMatchesThreadPath(repo, cwd = "") {
  const repoPath = normalizedPathPrefix(repo?.path);
  const threadPath = normalizedPathPrefix(cwd);
  return Boolean(repoPath && threadPath && (threadPath === repoPath || threadPath.startsWith(`${repoPath}/`)));
}

function repoForThreadNotification(thread = {}, routeOwner = null) {
  if (routeOwner?.repoId) {
    try {
      return getRepoById(routeOwner.repoId);
    } catch {
      // Fall through to cwd matching below.
    }
  }
  const cwd = thread?.cwd || thread?.path || "";
  return repos.find((repo) => repoMatchesThreadPath(repo, cwd)) || null;
}

function threadNotificationId(params = {}, owner = {}) {
  return String(params.threadId || params.thread?.id || owner.threadId || "").trim();
}

async function findStoredSessionByThreadId(threadId) {
  const store = await readChatStore();
  const session =
    Object.values(store.sessions || {}).find((item) => item.codexSessionId && item.codexSessionId === threadId) || null;
  return { store, session };
}

async function patchStoredThreadSession(threadId, patch = {}, options = {}) {
  if (!threadId) return null;
  return mutateChatStore((store) => {
    const session = Object.values(store.sessions || {}).find((item) => item.codexSessionId === threadId) || null;
    if (!session) return null;
    const updated = normalizeSession(
      {
        ...session,
        ...patch,
        codexSessionId: threadId,
        updatedAt: patch.updatedAt || new Date().toISOString(),
      },
      session.repoId,
    );
    store.sessions[session.id] = updated;
    if (options.makeActive) store.activeByRepo[session.repoId] = session.id;
    return sessionSummary(updated);
  });
}

async function removeStoredThreadSession(threadId) {
  if (!threadId) return null;
  return mutateChatStore((store) => {
    const session = Object.values(store.sessions || {}).find((item) => item.codexSessionId === threadId) || null;
    if (!session) return null;
    delete store.sessions[session.id];
    if (store.activeByRepo[session.repoId] === session.id) {
      const replacement = Object.values(store.sessions || {})
        .filter((item) => item.repoId === session.repoId)
        .sort((a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime())[0];
      store.activeByRepo[session.repoId] = replacement?.id || "";
    }
    return sessionSummary(session);
  });
}

async function upsertThreadNotificationSession(thread = {}, routeOwner = null) {
  const threadId = String(thread?.id || "").trim();
  if (!threadId) return null;
  const repo = repoForThreadNotification(thread, routeOwner);
  if (!repo) return null;
  const updatedOwner = await mutateChatStore((store) => {
    const ownerSession =
      routeOwner?.sessionId && store.sessions[routeOwner.sessionId]?.repoId === repo.id
        ? store.sessions[routeOwner.sessionId]
        : null;
    if (!ownerSession || (ownerSession.codexSessionId && ownerSession.codexSessionId !== threadId)) return null;
    const updated = normalizeSession(
      {
        ...ownerSession,
        title: appThreadTitle(thread),
        createdAt: appThreadTime(thread.createdAt || thread.created_at || ownerSession.createdAt),
        updatedAt: appThreadTime(thread.updatedAt || thread.updated_at || ownerSession.updatedAt),
        codexSessionId: threadId,
      },
      repo.id,
    );
    store.sessions[ownerSession.id] = updated;
    return sessionSummary(updated);
  });
  if (updatedOwner) return updatedOwner;
  const [summary] = await upsertAppServerThreads(repo, [thread], { pruneMissing: false });
  return summary || null;
}

async function importAppServerThreadSession(repo, threadId, title = "新会话") {
  if (!threadId) return null;
  const response = await codexAppServerRequest("thread/resume", { threadId, cwd: repo.path }, 20_000);
  if (!response.ok) return null;
  const returnedThread = response.result?.thread || response.result?.data?.thread || response.result?.data || {};
  const returnedThreadId = String(returnedThread?.id || response.result?.threadId || "").trim();
  if (returnedThreadId && returnedThreadId !== threadId) return null;
  const thread = returnedThread;
  const runtime = runtimeFromAppServerSettings(response.result || {}, {});
  const imported = normalizeSession(
    {
      id: appThreadSessionId(threadId),
      repoId: repo.id,
      title: thread?.name || thread?.title || thread?.preview ? appThreadTitle(thread) : title,
      createdAt: appThreadTime(thread?.createdAt || thread?.created_at),
      updatedAt: appThreadTime(thread?.updatedAt || thread?.updated_at || thread?.createdAt || thread?.created_at),
      messages: [],
      codexSessionId: threadId,
      ...runtime,
    },
    repo.id,
  );
  return mutateChatStore((store) => {
    const existing = findStoredSessionByHint(store, repo.id, threadId);
    if (existing) {
      store.activeByRepo[repo.id] = existing.id;
      return existing;
    }
    store.sessions[imported.id] = imported;
    store.activeByRepo[repo.id] = imported.id;
    return imported;
  });
}

async function listAppServerThreads(repo, options = {}) {
  const maxThreads = Math.min(Math.max(Number(options.limit || maxStoredSessions), 1), maxStoredSessions);
  const searchTerm = String(options.searchTerm || "").trim() || null;
  const timeout = Math.min(Math.max(Number(options.timeout || appServerReadTimeoutMs), 1_000), 30_000);
  const threads = [];
  let cursor = null;
  do {
    const response = await codexAppServerRequest(
      "thread/list",
      {
        cursor,
        limit: Math.min(appServerThreadPageSize, Math.max(maxThreads - threads.length, 1)),
        cwd: [repo.path],
        archived: Boolean(options.archived),
        useStateDbOnly: options.useStateDbOnly !== false,
        sortKey: "updated_at",
        sortDirection: "desc",
        ...(searchTerm ? { searchTerm } : {}),
      },
      timeout,
    );
    if (!response.ok) return { ok: false, error: response.error, threads };
    threads.push(...(Array.isArray(response.result?.data) ? response.result.data : []));
    cursor = response.result?.nextCursor || null;
  } while (cursor && threads.length < maxThreads);
  return { ok: true, threads: threads.slice(0, maxThreads) };
}

function sessionSummary(item) {
  const isDraft = isLocalDraftSession(item);
  const storedMessageCount = Number(item.messageCount || 0);
  const messageCount = Math.max(Array.isArray(item.messages) ? item.messages.length : 0, Number.isFinite(storedMessageCount) ? storedMessageCount : 0);
  return {
    id: item.id,
    repoId: item.repoId,
    title: item.title,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    messageCount,
    codexSessionId: item.codexSessionId || null,
    threadId: item.codexSessionId || null,
    isDraft,
    source: item.codexSessionId ? "app-server" : "local",
    model: item.model || null,
    reasoning: item.reasoning || null,
    sandbox: item.sandbox || null,
    approval: item.approval || null,
    search: typeof item.search === "boolean" ? item.search : null,
    runtimePending: Boolean(item.pendingTurnRuntime),
    tokenUsage: item.tokenUsage || null,
    goal: item.goal || null,
    compactedAt: item.compactedAt || null,
    draft: normalizeChatDraft(item.draft || {}),
  };
}

async function upsertAppServerThreads(repo, threads, options = {}) {
  return mutateChatStore((store) => {
  const listedThreadIds = new Set((threads || []).map((thread) => String(thread?.id || "")).filter(Boolean));
  if (options.pruneMissing) {
    for (const session of Object.values(store.sessions)) {
      if (session.repoId !== repo.id || !session.codexSessionId) continue;
      if (listedThreadIds.has(session.codexSessionId)) continue;
      delete store.sessions[session.id];
    }
  }
  const mergedSessions = [];
  const byThreadId = new Map(
    Object.values(store.sessions)
      .filter((session) => session.repoId === repo.id && session.codexSessionId)
      .map((session) => [session.codexSessionId, session]),
  );

  for (const thread of threads || []) {
    const threadId = String(thread.id || "");
    if (!threadId) continue;
    const existing = byThreadId.get(threadId);
    const sessionId = existing?.id || appThreadSessionId(threadId);
    const officialTitle = appThreadTitle(thread);
    const hasOfficialName = Boolean(String(thread.name || thread.title || "").trim());
    const threadMessageCount = Number(thread.messageCount ?? thread.message_count ?? 0);
    const threadTokenUsage = normalizeTokenUsage(thread.tokenUsage || thread.token_usage);
    const threadRuntime = {
      model: thread.model || existing?.model || defaultRuntime.model,
      reasoning: thread.reasoningEffort || thread.reasoning_effort || existing?.reasoning || defaultRuntime.reasoning,
    };
    const pendingTurnRuntime = normalizePendingTurnRuntime(existing?.pendingTurnRuntime, existing || {});
    const keepPendingTurnRuntime = pendingTurnRuntime;
    const merged = normalizeSession(
      {
        ...(existing || {}),
        id: sessionId,
        repoId: repo.id,
        title: hasOfficialName ? officialTitle : existing?.title && existing.title !== "新会话" ? existing.title : officialTitle,
        createdAt: appThreadTime(thread.createdAt || thread.created_at),
        updatedAt: appThreadTime(thread.updatedAt || thread.updated_at || thread.createdAt || thread.created_at),
        codexSessionId: threadId,
        model: keepPendingTurnRuntime?.model || threadRuntime.model,
        reasoning: keepPendingTurnRuntime?.reasoning || threadRuntime.reasoning,
        sandbox: thread.sandboxPolicy || thread.sandbox_policy || existing?.sandbox || null,
        approval: thread.approvalMode || thread.approval_mode || existing?.approval || null,
        pendingTurnRuntime: keepPendingTurnRuntime,
        messages: existing?.messages || [],
        messageCount: Math.max(
          Number(existing?.messageCount || 0),
          Number.isFinite(threadMessageCount) && threadMessageCount > 0 ? threadMessageCount : 0,
          Array.isArray(existing?.messages) ? existing.messages.length : 0,
        ),
        tokenUsage: threadTokenUsage || existing?.tokenUsage || null,
        goal: existing?.goal || null,
        compactedAt: existing?.compactedAt || null,
        draft: existing?.draft || null,
      },
      repo.id,
    );
    store.sessions[sessionId] = merged;
    mergedSessions.push(merged);
    if (!store.activeByRepo[repo.id]) store.activeByRepo[repo.id] = sessionId;
  }
  if (!store.activeByRepo[repo.id] || !store.sessions[store.activeByRepo[repo.id]]) {
    const active = Object.values(store.sessions)
      .filter((session) => session.repoId === repo.id)
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0];
    store.activeByRepo[repo.id] = active?.id || "";
  }
  return mergedSessions.map(sessionSummary);
  });
}

async function syncAppServerThreads(repo, options = {}) {
  const listed = await listAppServerThreads(repo, options);
  if (!listed.ok) return listed;
  await upsertAppServerThreads(repo, listed.threads, { pruneMissing: true });
  return listed;
}

function scheduleRepoSessionSync(repo, options = {}) {
  if (!repo?.id) return;
  if (repoSessionSyncByRepo.has(repo.id)) return;
  const task = syncAppServerThreads(repo, { timeout: options.timeout || appServerReadTimeoutMs })
    .catch(() => null)
    .finally(() => repoSessionSyncByRepo.delete(repo.id));
  repoSessionSyncByRepo.set(repo.id, task);
}

async function getRepoSessions(repoId, options = {}) {
  const repo = getRepoById(repoId);
  let source = options.sync === false ? "local-session-cache" : "app-server";
  let authoritative = false;
  let syncError = null;
  if (options.sync !== false) {
    const listed = await syncAppServerThreads(repo, { timeout: options.timeout || appServerReadTimeoutMs }).catch((error) => ({
      ok: false,
      error: error.message || String(error),
    }));
    if (!listed.ok) {
      syncError = listed.error || "app-server thread/list failed";
      source = "app-server-unavailable";
    } else {
      source = "app-server";
      authoritative = true;
    }
  }
  let store = await readChatStore();
  if (syncError) {
    const items = Object.values(store.sessions)
      .filter((item) => item.repoId === repoId)
      .map(sessionSummary)
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
      .slice(0, maxStoredSessions);
    const storedActiveId = String(store.activeByRepo?.[repoId] || "");
    const storedActive = storedActiveId && store.sessions[storedActiveId]?.repoId === repoId ? storedActiveId : null;
    return {
      ok: Boolean(allowLocalFallback && !options.requireAppServerSync),
      source,
      authoritative: false,
      error: syncError,
      sessions: items,
      activeSessionId: storedActive,
    };
  }
  const activeId = chooseRepoActiveSessionId(store, repoId, options);
  const needsActiveUpdate = Boolean(activeId && store.activeByRepo[repoId] !== activeId);
  const active = activeId ? store.sessions[activeId] : null;
  const keepDraftId = authoritative && active && isEmptyDraftSession(active) ? active.id : "";
  if (needsActiveUpdate || authoritative) {
    await mutateChatStore((current) => {
      if (activeId && current.sessions[activeId]?.repoId === repoId) current.activeByRepo[repoId] = activeId;
      if (authoritative) compactEmptyDraftSessions(current, repoId, keepDraftId);
    });
    store = await readChatStore();
  }
  const items = Object.values(store.sessions)
    .filter((item) => item.repoId === repoId)
    .map(sessionSummary)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .slice(0, maxStoredSessions);
  const returnedActiveId = chooseRepoActiveSessionId(store, repoId, options);
  const allowLocalActive = options.preserveLocalActive || options.allowLocalActive;
  return {
    ok: true,
    source,
    authoritative,
    error: syncError,
    sessions: items,
    activeSessionId: returnedActiveId || (allowLocalActive ? items[0]?.id || null : null),
  };
}

function collectText(value, depth = 0) {
  if (depth > 4 || value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => collectText(item, depth + 1)).filter(Boolean).join("\n");
  if (typeof value !== "object") return "";
  const direct = ["text", "markdown", "content", "message", "summary", "preview"]
    .map((key) => (typeof value[key] === "string" ? value[key] : ""))
    .filter(Boolean);
  if (direct.length) return direct.join("\n");
  return ["input", "output", "items", "parts", "content", "message"].map((key) => collectText(value[key], depth + 1)).filter(Boolean).join("\n");
}

function normalizeThreadItemMessage(item = {}) {
  const type = String(item.type || item.kind || "").toLowerCase();
  const role =
    item.role === "user" || type.includes("user")
      ? "user"
      : item.role === "assistant" || item.role === "agent" || type.includes("agent") || type.includes("assistant")
        ? "codex"
        : null;
  if (!role) return null;
  const text = collectText(item).trim();
  if (!text) return null;
  return {
    id: String(item.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`),
    role,
    text: text.slice(0, 12000),
    time: appThreadTime(item.createdAt || item.updatedAt || item.timestamp || Date.now()),
    mocked: false,
  };
}

function normalizeAppThreadMessages(thread = {}) {
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const messages = [];
  for (const turn of turns) {
    const items = Array.isArray(turn.items) ? turn.items : Array.isArray(turn.itemsView?.items) ? turn.itemsView.items : [];
    for (const item of items) {
      const message = normalizeThreadItemMessage(item);
      if (message) messages.push(message);
    }
  }
  return messages;
}

function appServerNormalizerOptions(repo) {
  return {
    repoId: repo?.id || "",
    repoName: repo?.name || repo?.id || "",
    repoPath: repo?.path || "",
  };
}

async function getAppServerThreadMessages(session, repo = null, options = {}) {
  if (!session.codexSessionId) return { ok: true, messages: [], thread: null };
  const response = await codexAppServerRequest(
    "thread/read",
    { threadId: session.codexSessionId, includeTurns: true },
    options.timeout || 20_000,
  );
  if (!response.ok) return { ok: false, error: response.error || "thread/read failed", messages: [], thread: null };
  const thread = response.result?.thread || null;
  return { ok: true, messages: normalizeAppServerThreadMessages(thread || {}, appServerNormalizerOptions(repo)), thread };
}

async function updateStoredSessionFromOfficialThread(session, repo, official = {}, options = {}) {
  if (!session?.codexSessionId || !official?.ok) return null;
  const officialMessages = (official.messages || []).map(normalizeChatMessage).filter((item) => item.text);
  const thread = official.thread || {};
  const updatedAt =
    appThreadTime(thread.updatedAt || thread.updated_at || officialMessages.at(-1)?.time || session.updatedAt || session.createdAt);
  const hasOfficialName = Boolean(String(thread.name || thread.title || "").trim());
  const patch = {
    title: hasOfficialName ? appThreadTitle(thread) : session.title,
    updatedAt,
    messages: [],
    messageCount: Math.max(officialMessages.length, Number(thread.messageCount ?? thread.message_count ?? session.messageCount ?? 0)),
    tokenUsage: normalizeTokenUsage(thread.tokenUsage || thread.token_usage || session.tokenUsage),
    goal: session.goal || null,
    compactedAt: session.compactedAt || null,
  };
  const summary = await patchStoredThreadSession(session.codexSessionId, patch, { makeActive: Boolean(options.makeActive) });
  const key = threadStateCacheKey(session);
  const cached = threadStateCacheByKey.get(key);
  if (cached) {
    threadStateCacheByKey.set(key, {
      cachedAt: Date.now(),
      data: {
        ...cached.data,
        tokenUsage: patch.tokenUsage || cached.data.tokenUsage || null,
        threadId: session.codexSessionId,
        runtime: normalizeRuntime({}, { ...session, ...patch }),
      },
    });
  }
  return summary;
}

function scheduleThreadSummaryRefresh(repo, session) {
  if (!session?.codexSessionId || !repo) return;
  const key = `${repo.id}:${session.codexSessionId}`;
  if (threadSummaryRefreshByKey.has(key)) return;
  const task = getAppServerThreadMessages(session, repo, { timeout: appServerReadTimeoutMs })
    .then((official) => updateStoredSessionFromOfficialThread(session, repo, official, { makeActive: false }))
    .catch(() => null)
    .finally(() => threadSummaryRefreshByKey.delete(key));
  threadSummaryRefreshByKey.set(key, task);
}

async function getChatMessages(repoId, sessionHint, options = {}) {
  const session = await resolveChatSessionForRead(repoId, sessionHint);
  if (session.codexSessionId) {
    const repo = repos.find((item) => item.id === session.repoId || item.id === repoId) || null;
    const official = await getAppServerThreadMessages(session, repo, { timeout: options.timeout }).catch((error) => ({
      ok: false,
      error: error.message || "thread/read failed",
      messages: [],
    }));
    if (!official.ok) {
      return [
        normalizeChatMessage({
          id: `thread-read-error-${session.codexSessionId}`,
          role: "codex",
          text: `无法从 Codex app-server 读取当前 thread。${official.error ? `\n\n${official.error}` : ""}`,
          time: new Date().toISOString(),
          mocked: false,
          messageType: "threadReadError",
          status: "failed",
          source: "app-server-unavailable",
          details: { error: official.error || "thread/read failed" },
        }),
      ];
    }
    await updateStoredSessionFromOfficialThread(session, repo, official, { makeActive: false }).catch(() => null);
    const officialMessages = official.messages
      .map(normalizeChatMessage)
      .filter((item) => item.text)
    const supplementalMessages = await auditTimelineMessagesForSession(repoId, session, new Set(officialMessages.map((item) => item.id)));
    const turnOrder = new Map();
    officialMessages.forEach((item, index) => {
      if (!item.turnId || turnOrder.has(item.turnId)) return;
      turnOrder.set(item.turnId, { index: typeof item.turnIndex === "number" ? item.turnIndex : index, time: item.time });
    });
    const itemRank = (item) => {
      if (item.role === "user") return 0;
      if (/commandExecution|fileChange|mcpToolCall|dynamicToolCall|webSearch/i.test(String(item.messageType || ""))) return 1;
      return 2;
    };
    return [...officialMessages, ...supplementalMessages]
      .sort((a, b) => {
        const turnA = a.turnId ? turnOrder.get(a.turnId) : null;
        const turnB = b.turnId ? turnOrder.get(b.turnId) : null;
        if (turnA && turnB) {
          if (turnA.index !== turnB.index) return turnA.index - turnB.index;
          const rank = itemRank(a) - itemRank(b);
          if (rank) return rank;
        }
        return new Date(a.time) - new Date(b.time);
      })
      .slice(-maxStoredChatMessages);
  }

  const sourceMessages = session.messages;
  return sourceMessages
    .map(normalizeChatMessage)
    .filter((item) => item.text)
    .slice(-maxStoredChatMessages);
}

async function saveChatMessages(repoId, sessionHint, messages) {
  const session = await ensureChatSession(repoId, sessionHint);
  const normalized = messages.map(normalizeChatMessage).filter((item) => item.text).slice(-maxStoredChatMessages);
  const firstUser = normalized.find((item) => item.role === "user")?.text;
  return mutateChatStore((store) => {
    const current = store.sessions[session.id];
    if (!current || current.repoId !== repoId) throw new Error("Session disappeared while saving messages");
    store.sessions[session.id] = normalizeSession({
      ...current,
      title: current.title === "新会话" && firstUser ? sessionTitle(firstUser) : current.title,
      updatedAt: normalized.at(-1)?.time || new Date().toISOString(),
      messages: normalized,
    }, repoId);
    store.activeByRepo[repoId] = session.id;
    return store.sessions[session.id];
  });
}

async function updateSessionRuntime(repoId, sessionId, runtime = {}, { makeActive = true } = {}) {
  return mutateChatStore((store) => {
    const session = store.sessions[sessionId];
    if (!session || session.repoId !== repoId) return null;
    store.sessions[sessionId] = normalizeSession(
      {
        ...session,
        ...runtime,
        updatedAt: new Date().toISOString(),
      },
      repoId,
    );
    if (makeActive) store.activeByRepo[repoId] = sessionId;
    return store.sessions[sessionId];
  });
}

async function appendChatTurn(repoId, sessionHint, message, response, mocked = false) {
  const session = await ensureChatSession(repoId, sessionHint, sessionTitle(message));
  const current = session.messages || [];
  const now = new Date().toISOString();
  return saveChatMessages(repoId, session.id, [
    ...current,
    { id: `${Date.now()}-user`, role: "user", text: message, time: now },
    {
      id: `${Date.now()}-codex`,
      role: "codex",
      text: response || "Codex completed without output.",
      time: new Date().toISOString(),
      mocked,
    },
  ]);
}

function formatChatHistory(messages) {
  const recent = messages.slice(-maxPromptChatMessages);
  if (!recent.length) return "无";
  return recent
    .map((item) => {
      const speaker = item.role === "user" ? "用户" : "云端 Codex";
      return `${speaker}: ${item.text}`;
    })
    .join("\n\n");
}

function buildChatPrompt(repo, session, message) {
  if (session?.codexSessionId) return message;
  return [
    "你是运行在 EC2 上的云端 Codex CLI。这个网页只是 Codex CLI 的远程控制台外壳。",
    `当前仓库: ${repo.name}`,
    `工作目录: ${repo.path}`,
    "请像完整 Codex 一样工作：可以读写文件、运行终端命令、使用浏览器验证、解释日志、修复代码并持续验证。用户没有明确要求只讨论时，优先直接推进任务。",
    "",
    "用户消息:",
    message,
  ].join("\n");
}

function parseCodexSessionId(output = "") {
  const match = String(output).match(/(?:session\s*id|session_id)\s*[:=]\s*([0-9a-f]{8,}(?:-[0-9a-f]{4,}){3,})/i);
  return match?.[1] || null;
}

function codexExecArgs(repo, session, runtime) {
  const args = [];
  if (runtime.search) args.push("--search");
  const bypassSandbox = runtime.sandbox === "danger-full-access" && runtime.approval === "never";
  if (!bypassSandbox) args.push("-a", runtime.approval);
  args.push(
    "exec",
    "--skip-git-repo-check",
    "-C",
    repo.path,
    "-m",
    runtime.model,
    "-c",
    `model_reasoning_effort=${runtime.reasoning}`,
  );
  if (bypassSandbox) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  } else {
    args.push("-s", runtime.sandbox);
  }
  if (session?.codexSessionId) {
    args.push("resume", session.codexSessionId, "-");
  } else {
    args.push("-");
  }
  return args;
}

function writeSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function cloudRuntimeDeveloperInstructions(runtime) {
  return [
    "You are running through Codex Cloud Console.",
    `The authoritative model selected by the console for this thread is "${runtime.model}" with reasoning effort "${runtime.reasoning}".`,
    "When asked which model is active, report that exact model ID. Do not infer the active model from ~/.codex/config.toml because that file only controls the standalone CLI default.",
    "Treat generic model aliases and concrete model variants as distinct identifiers. A failed request for a generic alias does not prove that the selected concrete variant or its model family is unavailable.",
    `Before claiming the selected model is unavailable, verify the exact selected ID "${runtime.model}", or rely on the fact that this turn was successfully started with it.`,
    "Do not edit ~/.codex/config.toml unless the user explicitly asks to change the standalone CLI default.",
  ].join("\n");
}

function appServerThreadParams(repo, runtime) {
  return {
    cwd: repo.path,
    model: runtime.model,
    approvalPolicy: runtime.approval,
    sandbox: runtime.sandbox,
    serviceName: "codex_cloud_console",
    personality: "pragmatic",
    developerInstructions: cloudRuntimeDeveloperInstructions(runtime),
    config: {
      model_reasoning_effort: runtime.reasoning,
      tools: { web_search: runtime.search },
    },
  };
}

function appServerSandboxPolicy(runtime, repo) {
  if (runtime.sandbox === "danger-full-access") return { type: "dangerFullAccess" };
  if (runtime.sandbox === "read-only") return { type: "readOnly", networkAccess: true };
  return {
    type: "workspaceWrite",
    writableRoots: [repo.path],
    networkAccess: true,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

function inlineShellCommand(command, limit = 180) {
  const text = String(command || "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\/bin\/(?:bash|sh)\s+-lc\s*/i, "")
    .trim()
    .replace(/^(['"])([\s\S]*)\1$/, "$2")
    .trim();
  if (!text) return "shell";
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}

async function appServerTurnParams(threadId, repo, runtime, message, attachments = []) {
  return {
    threadId,
    input: await buildUserInputs(repo, message, attachments),
    cwd: repo.path,
    approvalPolicy: runtime.approval,
    sandboxPolicy: appServerSandboxPolicy(runtime, repo),
    model: runtime.model,
    effort: runtime.reasoning,
  };
}

function formatAppServerItemStatus(item = {}) {
  if (item.type === "commandExecution") return `运行命令: ${commandSummaryLabel(item.command)}`;
  if (item.type === "fileChange") return "正在修改文件...";
  if (item.type === "webSearch") return `联网搜索: ${item.query || ""}`.trim();
  if (item.type === "mcpToolCall") return `调用 ${item.server || "MCP"} / ${item.tool || "tool"}`;
  if (item.type === "dynamicToolCall") return `调用工具: ${item.tool || "tool"}`;
  if (item.type === "reasoning") return "正在思考...";
  if (item.type === "plan") return "正在更新计划...";
  return "";
}

function formatThreadStatus(status) {
  if (!status) return "unknown";
  if (typeof status === "string") return status;
  if (typeof status === "object" && status.type) return String(status.type);
  return JSON.stringify(status);
}

function decodeAppServerTextDelta(params = {}) {
  if (typeof params.delta === "string") return params.delta;
  if (typeof params.text === "string") return params.text;
  if (typeof params.deltaBase64 === "string") {
    try {
      return Buffer.from(params.deltaBase64, "base64").toString("utf8");
    } catch {
      return "";
    }
  }
  return "";
}

function countTextLines(value) {
  const text = String(value || "").replace(/\r\n/g, "\n");
  const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text;
  return trimmed ? trimmed.split("\n").length : 0;
}

const auditSummaryMaxChars = 260;
const auditDetailMaxChars = 1800;
const auditStatusDetailMaxChars = 900;
const interruptedAutomationArchiveText = "控制台维护期间中断，已自动归档";
const automationRunPromptPreviewChars = 520;
const commandOutputMaxChars = 5000;
const commandAuditDetailMaxChars = 7200;

function redactOpaqueText(value) {
  return String(value || "").replace(/[A-Za-z0-9+/=_-]{180,}/g, (match) => `[opaque payload redacted: ${match.length} chars]`);
}

function truncateForUi(value, maxLength = 800) {
  const text = redactOpaqueText(value).replace(/\u0000/g, "");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength).trimEnd()}\n...[truncated ${text.length - maxLength} chars]`;
}

function compactSingleLine(value, maxLength = auditSummaryMaxChars) {
  return truncateForUi(value, maxLength).replace(/\s+/g, " ").trim();
}

function stripAnsi(value) {
  return String(value || "").replace(/\x1b\[[0-9;]*m/g, "");
}

function compactAuditSummary(value) {
  const text = compactSingleLine(value, auditSummaryMaxChars);
  if (/printf\s+['"]?%s['"]?/i.test(text) && /(opaque payload redacted|[A-Za-z0-9+/=_-]{80,})/.test(text)) {
    return text.replace(/printf\s+['"]?%s['"]?.*$/i, "printf '<payload>'");
  }
  if (/(base64|payload|blob)/i.test(text) && /[A-Za-z0-9+/=_-]{80,}/.test(text)) {
    return text.replace(/[A-Za-z0-9+/=_-]{80,}/g, "<payload>");
  }
  return text;
}

function datePartsInShanghai(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  return {
    year: parts.find((part) => part.type === "year")?.value || "",
    month: parts.find((part) => part.type === "month")?.value || "",
    day: parts.find((part) => part.type === "day")?.value || "",
  };
}

function dateKeyFromParts(parts) {
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function relativeDateLabel(year, month, day) {
  const today = dateKeyFromParts(datePartsInShanghai());
  const target = `${year}-${month}-${day}`;
  if (target === today) return "今天";
  const tomorrowDate = new Date(`${today}T00:00:00+08:00`);
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  if (target === dateKeyFromParts(datePartsInShanghai(tomorrowDate))) return "明天";
  return `${Number(month)}月${Number(day)}日`;
}

function addDaysToShanghaiParts(parts, days) {
  const date = new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00+08:00`);
  date.setDate(date.getDate() + days);
  return datePartsInShanghai(date);
}

function parseNormalizedHumanDateTimeMs(value, referenceDate = new Date()) {
  const text = compactSingleLine(value, 120);
  const referenceParts = datePartsInShanghai(referenceDate);
  const relative = text.match(/^(今天|明天)\s+(\d{1,2}):(\d{2})$/);
  if (relative) {
    const parts = relative[1] === "明天" ? addDaysToShanghaiParts(referenceParts, 1) : referenceParts;
    return Date.parse(`${parts.year}-${parts.month}-${parts.day}T${String(Number(relative[2])).padStart(2, "0")}:${relative[3]}:00+08:00`);
  }
  const monthDay = text.match(/^(\d{1,2})月(\d{1,2})日\s+(\d{1,2}):(\d{2})$/);
  if (monthDay) {
    return Date.parse(
      `${referenceParts.year}-${String(Number(monthDay[1])).padStart(2, "0")}-${String(Number(monthDay[2])).padStart(2, "0")}T${String(Number(monthDay[3])).padStart(2, "0")}:${monthDay[4]}:00+08:00`,
    );
  }
  return null;
}

function normalizeHumanDateTime(value, referenceDate = new Date()) {
  const text = compactSingleLine(value, 220);
  if (!text) return "";
  const relative = text.match(/\b(今天|明天)\s+(\d{1,2}):(\d{2})\b/);
  if (relative) {
    const referenceParts = datePartsInShanghai(referenceDate);
    const parts = relative[1] === "明天" ? addDaysToShanghaiParts(referenceParts, 1) : referenceParts;
    return `${relativeDateLabel(parts.year, parts.month, parts.day)} ${String(Number(relative[2])).padStart(2, "0")}:${relative[3]}`;
  }
  const systemd = text.match(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::\d{2})?\s+[A-Z]+/i);
  if (systemd) return `${relativeDateLabel(systemd[1], systemd[2], systemd[3])} ${systemd[4]}:${systemd[5]}`;
  const months = {
    jan: "01",
    feb: "02",
    mar: "03",
    apr: "04",
    may: "05",
    jun: "06",
    jul: "07",
    aug: "08",
    sep: "09",
    oct: "10",
    nov: "11",
    dec: "12",
  };
  const english = text.match(/\b([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?,\s*(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)\b/i);
  if (english) {
    const month = months[english[1].slice(0, 3).toLowerCase()];
    if (month) {
      let hour = Number(english[4]);
      const ampm = english[6].toUpperCase();
      if (ampm === "PM" && hour < 12) hour += 12;
      if (ampm === "AM" && hour === 12) hour = 0;
      const day = String(Number(english[2])).padStart(2, "0");
      return `${relativeDateLabel(english[3], month, day)} ${String(hour).padStart(2, "0")}:${english[5]}`;
    }
  }
  const timeOnly = text.match(/\b(\d{1,2}):(\d{2})\s*(AM|PM)\b/i);
  if (timeOnly) {
    let hour = Number(timeOnly[1]);
    const ampm = timeOnly[3].toUpperCase();
    if (ampm === "PM" && hour < 12) hour += 12;
    if (ampm === "AM" && hour === 12) hour = 0;
    return `${relativeDateLabel(...Object.values(datePartsInShanghai(referenceDate)))} ${String(hour).padStart(2, "0")}:${timeOnly[2]}`;
  }
  return text;
}

function terminalCommandSummary(script, prefix = "terminal") {
  const text = compactAuditSummary(script);
  if (!text) return prefix;
  const command = text
    .replace(/^\/bin\/(?:bash|sh)\s+-lc\s*/i, "")
    .trim()
    .replace(/^(['"])([\s\S]*)\1$/, "$2")
    .trim();
  const deployBlob = /(?:\.deploy\.b64|\/tmp\/codex-cloud-[\w.-]*\.b64)/i.test(command);
  const gapPlanBlob = /codex-cloud-gap-plan\.md\.b64|docs\/research\/codex-cloud-gap-plan\.md/i.test(command);
  const uiBlob = /codex-cloud-ui-(?:deploy|chunk)|dist\/assets|src\/App\.tsx/i.test(command);
  const serverBlob = /codex-cloud-(?:server-deploy|index\.mjs)|server\/index\.mjs/i.test(command);
  if (deployBlob && /:\s*>/i.test(command)) return `${prefix}: deployment file prepare`;
  if (deployBlob && /cat\s*>>/i.test(command)) return `${prefix}: deployment file chunk`;
  if (gapPlanBlob && /base64\s+-d/i.test(command)) return `${prefix}: sync gap plan document`;
  if (serverBlob && /base64\s+-d/i.test(command)) return `${prefix}: deploy backend service`;
  if (uiBlob && /base64\s+-d/i.test(command)) return `${prefix}: deploy frontend bundle`;
  if (deployBlob && /base64\s+-d/i.test(command)) return `${prefix}: deployment file sync`;
  if (/\bsystemd-run\b[\s\S]*\bcodex-cloud-deploy[-\w]*\b/i.test(command) || /\binstall-systemd\.sh\b/i.test(command)) {
    return `${prefix}: deploy cloud console release`;
  }
  if (/systemctl\s+restart\s+codex-cloud-console\.service/i.test(command)) return `${prefix}: restart cloud console service`;
  if (/systemctl\s+is-active\s+codex-cloud-console\.service/i.test(command)) return `${prefix}: check cloud console service`;
  if (
    /codex-cloud-console\.service|\/home\/ubuntu\/codex-cloud\/console\/server\/index\.mjs|\/tmp\/codex-cloud-console-restart/i.test(command) &&
    /\b(?:grep|stat|systemctl\s+show|ps\s+-p|cat)\b/i.test(command)
  ) {
    return `${prefix}: inspect cloud console deployment`;
  }
  if (/npm\s+run\s+build/i.test(command)) return `${prefix}: frontend build`;
  if (/codex:schema:check/i.test(command)) return `${prefix}: schema check`;
  if (/node\s+--check/i.test(command)) return `${prefix}: server syntax check`;
  if (/curl\s+-sS.*\/healthz/i.test(command)) return `${prefix}: health check`;
  if (/INVEST_DASHBOARD_CLOUD_(SYNC_TOKEN|BASE_URL)/i.test(command)) return `${prefix}: cloud sync configuration check`;
  if (/~\/\.(?:bash_profile|bash_login|profile)/i.test(command)) return `${prefix}: shell profile inspection`;
  if (/git\s+check-ignore\b|git\s+status\b/i.test(command)) return `${prefix}: inspect git status`;
  if (/git\s+diff\b/i.test(command)) return `${prefix}: inspect git diff`;
  if (/\bfind\s+data\b/i.test(command)) return `${prefix}: inspect data files`;
  if (/\bls\s+-la\s+data\b/i.test(command)) return `${prefix}: inspect data directory`;
  if (/invest_dashboard\.cli\b/i.test(command)) return `${prefix}: run project CLI`;
  return `${prefix}: ${command.slice(0, 180)}`;
}

function commandSummaryLabel(script) {
  return terminalCommandSummary(script, "command").replace(/^command:\s*/i, "").trim() || "command";
}

function sanitizeStatusText(value, maxLength = 900) {
  return truncateForUi(String(value || ""), maxLength)
    .replace(
      /Console restarted while (?:Codex app-server|app-server|云端 Codex|云端)?\s*automation was running|控制台重启时云端自动化仍在运行/gi,
      interruptedAutomationArchiveText,
    )
    .replace(/INVEST_DASHBOARD_CLOUD_SYNC_TOKEN\s*=\s*[A-Za-z0-9_./+=-]+/gi, "云端同步 Token=<redacted>")
    .replace(/INVEST_DASHBOARD_CLOUD_BASE_URL\s*=\s*([^\s`'"]+)/gi, "云端同步地址=$1")
    .replace(/Codex app-server/gi, "云端 Codex")
    .replace(/app-server automation/gi, "云端自动化")
    .replace(/INVEST_DASHBOARD_CLOUD_SYNC_TOKEN/gi, "云端同步 Token")
    .replace(/INVEST_DASHBOARD_CLOUD_BASE_URL/gi, "云端同步地址")
    .replace(/[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{24,}/g, "<token>")
    .replace(/\b(token|secret|password|key)\s*=\s*[A-Za-z0-9_./+=-]{16,}/gi, "$1=<redacted>")
    .replace(/云端同步\s+Token\s*=\s*[A-Za-z0-9_./+=-]+/gi, "云端同步 Token=<redacted>");
}

function sanitizeCloudPathText(value, maxLength = 900) {
  let text = sanitizeStatusText(value, maxLength).replaceAll("\\", "/");
  for (const repo of repos) {
    const repoPath = normalizedPathPrefix(repo.path).replaceAll("\\", "/");
    if (!repoPath) continue;
    const escaped = repoPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(`${escaped}/`, "g"), "").replace(new RegExp(escaped, "g"), `项目工作区 · ${repo.id}`);
  }
  const escapedWorkspaceRoot = normalizedPathPrefix(workspaceRoot).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedWorktreesRoot = normalizedPathPrefix(worktreesRoot).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text
    .replace(new RegExp(`${escapedWorkspaceRoot}/([^/\\s)\\]]+)/`, "g"), "")
    .replace(new RegExp(`${escapedWorkspaceRoot}/([^/\\s)\\]]+)`, "g"), "项目工作区 · $1")
    .replace(new RegExp(`${escapedWorkspaceRoot}(?=$|[\\s'")\\]])`, "g"), "项目工作区")
    .replace(new RegExp(`${escapedWorktreesRoot}/([^/\\s)\\]]+)/`, "g"), "隔离工作区/")
    .replace(new RegExp(`${escapedWorktreesRoot}/([^/\\s)\\]]+)`, "g"), "隔离工作区")
    .replace(new RegExp(`${escapedWorktreesRoot}(?=$|[\\s'")\\]])`, "g"), "隔离工作区")
    .replace(/\/home\/ubuntu\/codex-cloud\/logs\b/g, "云端日志")
    .replace(/\/home\/ubuntu\/\.codex\b/g, "Codex 状态目录")
    .replace(/\/home\/ubuntu\/codex-cloud\/console\//g, "")
    .replace(/\bworktrees?\b/gi, "隔离工作区")
    .replace(/Created\s+隔离工作区\s+隔离工作区/gi, "已创建隔离工作区")
    .replace(/Using repository cwd\s+项目工作区\s*·\s*([A-Za-z0-9._-]+)/gi, "使用项目工作区 · $1")
    .replace(/detached-隔离工作区/gi, "isolated")
    .replace(/repo-cwd/gi, "repo")
    .replace(/existing-thread/gi, "existing-thread");
}

function semanticAuditSummary(value) {
  const text = compactAuditSummary(value);
  if (/^Codex rate limits updated$/i.test(text)) return "额度状态更新";
  if (/^Codex app-server ready$/i.test(text)) return "云端 Codex 就绪";
  const terminal = text.match(/^(terminal(?:\s+fallback)?):\s*([\s\S]+)$/i);
  if (terminal?.[1] && terminal?.[2]) return terminalCommandSummary(terminal[2], terminal[1]);
  const shell = text.match(/^shell:\s*([\s\S]+)$/i);
  if (shell?.[1]) {
    const command = shell[1].replace(/^\/bin\/bash\s+-lc\s*/i, "").trim().replace(/^(['"])([\s\S]*)\1$/, "$2");
    return terminalCommandSummary(command, "shell");
  }
  const shellWithStatus = text.match(/^shell\s+(?:inProgress|completed|failed|cancelled):\s*([\s\S]+)$/i);
  if (shellWithStatus?.[1]) return terminalCommandSummary(shellWithStatus[1], "shell");
  return text;
}

function sanitizeAuditValue(value, maxStringLength = 900, depth = 0) {
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return sanitizeCloudPathText(value, Math.max(180, maxStringLength - depth * 120));
  if (depth >= 5) return truncateForUi(JSON.stringify(value), 240);
  if (Array.isArray(value)) {
    const items = value.slice(0, 24).map((item) => sanitizeAuditValue(item, maxStringLength, depth + 1));
    if (value.length > items.length) items.push(`[truncated ${value.length - items.length} items]`);
    return items;
  }
  if (typeof value === "object") {
    if (value.type === "commandExecution" || value.command) {
      return {
        type: "commandExecution",
        command: commandSummaryLabel(value.command || ""),
        status: value.status ? String(value.status) : undefined,
        exitCode: typeof value.exitCode === "number" ? value.exitCode : undefined,
        cwd: value.cwd ? sanitizeCloudPathText(value.cwd, 180) : undefined,
        outputLineCount: typeof value.outputLineCount === "number" ? value.outputLineCount : undefined,
        outputLength: typeof value.outputLength === "number" ? value.outputLength : undefined,
        outputTruncated: typeof value.outputTruncated === "boolean" ? value.outputTruncated : undefined,
      };
    }
    const entries = Object.entries(value).slice(0, 48);
    const result = {};
    for (const [key, item] of entries) result[key] = sanitizeAuditValue(item, maxStringLength, depth + 1);
    const total = Object.keys(value).length;
    if (total > entries.length) result.__truncatedKeys = total - entries.length;
    return result;
  }
  return truncateForUi(value, maxStringLength);
}

function jsonDetail(value, maxLength = auditDetailMaxChars) {
  try {
    const sanitized = sanitizeAuditValue(value || {});
    const text = JSON.stringify(sanitized, null, 2);
    if (text.length <= maxLength) return text;
    return JSON.stringify(
      {
        truncated: true,
        preview: truncateForUi(text, maxLength),
        originalChars: text.length,
      },
      null,
      2,
    );
  } catch {
    return JSON.stringify({ preview: truncateForUi(value, maxLength) }, null, 2);
  }
}

function normalizeAuditDetail(detail, maxLength = auditDetailMaxChars) {
  if (!detail) return "";
  if (typeof detail === "object") return jsonDetail(detail, maxLength);
  const text = String(detail);
  try {
    return jsonDetail(JSON.parse(text), maxLength);
  } catch {
    return jsonDetail({ preview: text }, maxLength);
  }
}

function parseAuditDetailPayload(detail) {
  if (!detail) return null;
  if (typeof detail === "object") return detail;
  try {
    return JSON.parse(String(detail));
  } catch {
    return null;
  }
}

function errorCandidateStrings(value, depth = 0, seen = new Set()) {
  if (value == null || depth > 4) return [];
  if (typeof value === "string") return [value];
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (value instanceof Error) {
    return [
      value.message,
      ...errorCandidateStrings(value.appServerError, depth + 1, seen),
      ...errorCandidateStrings(value.cause, depth + 1, seen),
    ].filter(Boolean);
  }
  if (typeof value !== "object") return [];
  if (seen.has(value)) return [];
  seen.add(value);
  const preferredKeys = [
    "message",
    "summary",
    "error",
    "detail",
    "details",
    "additionalDetails",
    "additional_details",
    "stderr",
    "stdout",
    "codexErrorInfo",
  ];
  const candidates = [];
  for (const key of preferredKeys) {
    if (value[key] === undefined || value[key] === null) continue;
    candidates.push(...errorCandidateStrings(value[key], depth + 1, seen));
  }
  return candidates;
}

function isGenericAppServerErrorText(value = "") {
  return /^(Codex app-server error|Codex app-server request failed|request failed|error|failed)$/i.test(String(value).trim());
}

function appServerErrorMessage(value, fallback = "Codex app-server error") {
  const candidates = errorCandidateStrings(value)
    .map((item) => stripAnsi(item).replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const authProblem = codexAuthProblemFromSources(candidates.join("\n"));
  if (authProblem) return authProblem;
  const message = candidates.find((item) => !isGenericAppServerErrorText(item)) || candidates[0] || fallback;
  return compactSingleLine(message || fallback, 520);
}

function auditEventSummary(event = {}) {
  const fallback = semanticAuditSummary(event.summary || event.type || "");
  const text = `${event.type || ""} ${event.summary || ""}`;
  if (!/error|failed|warning/i.test(text)) return fallback;
  const detail = parseAuditDetailPayload(event.detail);
  const message = appServerErrorMessage({ message: event.summary, detail }, fallback);
  return semanticAuditSummary(message || fallback);
}

function auditEventAttentionBody(event = {}) {
  const detail = parseAuditDetailPayload(event.detail);
  const message = detail ? appServerErrorMessage(detail, "") : "";
  if (message && !isGenericAppServerErrorText(message) && message !== event.summary) return compactSingleLine(message, 360);
  return compactSingleLine(event.source || event.type || "", 360);
}

function auditAppServerLifecycle(type, summary, detail = {}) {
  appendAuditEvent({
    source: "app-server",
    type,
    summary,
    detail: jsonDetail(detail),
  }).catch(() => null);
}

function appServerRequestLabel(method, params = {}, decision = "") {
  if (method.includes("commandExecution") || method === "execCommandApproval") {
    return `command approval: ${decision}`;
  }
  if (method.includes("fileChange") || method === "applyPatchApproval") {
    return `file approval: ${decision}`;
  }
  if (method.includes("permissions")) {
    return `permissions approval: ${decision}`;
  }
  if (method.includes("elicitation")) {
    return `MCP elicitation: ${decision}`;
  }
  if (method.includes("requestUserInput")) {
    return `user input request: ${decision}`;
  }
  return `${method}: ${decision}`;
}

function recordAppServerRequestDecision(method, params = {}, decision) {
  const owner = ownerFromParams(params);
  const job = findTurnJob(params) || findCompactJob(params);
  const summary = appServerRequestLabel(method, params, decision);
  appendAuditEvent({
    source: "app-server-request",
    type: method.includes("requestUserInput") ? "user-input-request" : method.includes("elicitation") ? "mcp-elicitation" : "approval",
    repoId: job?.repoId || null,
    sessionId: job?.sessionId || null,
    threadId: owner.threadId || job?.threadId || null,
    turnId: owner.turnId || job?.turnId || null,
    itemId: owner.itemId || null,
    summary,
    detail: jsonDetail({ method, decision, params }),
  }).catch(() => null);
  if (job) {
    emitJobEvent(job, "approval", {
      method,
      decision,
      summary,
      threadId: owner.threadId || job.threadId || null,
      turnId: owner.turnId || job.turnId || null,
      itemId: owner.itemId || null,
      detail: jsonDetail(params),
    });
  }
}

function appServerRequestResult(method, params = {}) {
  const recordApproval = (decision) => recordAppServerRequestDecision(method, params, decision);
  if (method === "item/commandExecution/requestApproval") {
    recordApproval("acceptForSession");
    return { decision: "acceptForSession" };
  }
  if (method === "item/fileChange/requestApproval") {
    recordApproval("acceptForSession");
    return { decision: "acceptForSession" };
  }
  if (method === "execCommandApproval") {
    recordApproval("approved_for_session");
    return { decision: "approved_for_session" };
  }
  if (method === "applyPatchApproval") {
    recordApproval("approved_for_session");
    return { decision: "approved_for_session" };
  }
  if (method === "item/permissions/requestApproval") {
    recordApproval("permissions session");
    return {
      permissions: {
        network: { enabled: true },
        fileSystem: {
          read: null,
          write: null,
          entries: [{ path: { type: "special", value: { kind: "root" } }, access: "write" }],
        },
      },
      scope: "session",
    };
  }
  if (method === "mcpServer/elicitation/request") {
    recordApproval("decline");
    return { action: "decline", content: null, _meta: null };
  }
  if (method === "item/tool/requestUserInput") {
    recordApproval("empty answers");
    return { answers: {} };
  }
  return null;
}

function guardianActionSummary(action = {}) {
  const type = String(action?.type || "unknown");
  if (type === "command") return `command: ${compactSingleLine(action.command || "shell", 180)}`;
  if (type === "execve") {
    const argv = Array.isArray(action.argv) ? action.argv.join(" ") : "";
    return `execve: ${compactSingleLine(`${action.program || "program"} ${argv}`.trim(), 180)}`;
  }
  if (type === "applyPatch") {
    const files = Array.isArray(action.files) ? action.files : [];
    const first = files[0] ? ` · ${compactSingleLine(files[0], 90)}` : "";
    return `apply patch: ${files.length} file${files.length === 1 ? "" : "s"}${first}`;
  }
  if (type === "networkAccess") {
    const host = action.host || action.target || "network";
    const port = action.port ? `:${action.port}` : "";
    return `network: ${action.protocol || "tcp"}://${host}${port}`;
  }
  if (type === "mcpToolCall") {
    return `MCP: ${action.server || action.connectorName || "mcp"} / ${action.toolTitle || action.toolName || "tool"}`;
  }
  if (type === "requestPermissions") {
    return `permissions: ${compactSingleLine(action.reason || "request permissions", 160)}`;
  }
  return compactSingleLine(type || "approval review", 180);
}

function guardianReviewEvent(method, params = {}) {
  const phase = method.endsWith("/completed") ? "completed" : "started";
  const review = params.review && typeof params.review === "object" ? params.review : {};
  const action = params.action && typeof params.action === "object" ? params.action : {};
  const actionSummary = guardianActionSummary(action);
  const status = review.status || (phase === "completed" ? "completed" : "inProgress");
  const risk = review.riskLevel ? ` · risk ${review.riskLevel}` : "";
  const authorization = review.userAuthorization ? ` · auth ${review.userAuthorization}` : "";
  const source = params.decisionSource ? ` · ${params.decisionSource}` : "";
  const summary = `auto review ${status}${risk}${authorization}: ${actionSummary}${source}`;
  return {
    phase,
    method,
    summary: compactSingleLine(summary, 260),
    reviewId: params.reviewId || null,
    threadId: params.threadId || null,
    turnId: params.turnId || null,
    itemId: params.targetItemId || null,
    targetItemId: params.targetItemId || null,
    startedAtMs: typeof params.startedAtMs === "number" ? params.startedAtMs : null,
    completedAtMs: typeof params.completedAtMs === "number" ? params.completedAtMs : null,
    decisionSource: params.decisionSource || null,
    status,
    riskLevel: review.riskLevel || null,
    userAuthorization: review.userAuthorization || null,
    rationale: review.rationale || null,
    actionType: action.type || null,
    actionSummary,
    review,
    action,
  };
}

function getAppServerClient() {
  if (appServerClient) return appServerClient;
  appServerClient = new CodexAppServerClient({
    cwd: projectRoot,
    env: process.env,
    onServerRequest: (method, params) => appServerRequestResult(method, params),
  });
  appServerClient.on("notification", handleAppServerNotification);
  appServerClient.on("ready", (result) => {
    auditAppServerLifecycle("app-server", "Codex app-server ready", {
      restartCount: appServerClient.status().restartCount,
      result,
    });
  });
  appServerClient.on("protocol-error", ({ error, line, message, recoverable }) => {
    auditAppServerLifecycle("app-server-error", message || error?.message || "Codex app-server protocol error", {
      recoverable: Boolean(recoverable),
      line: String(line || "").slice(0, 2000),
    });
  });
  appServerClient.on("exit", ({ message }) => {
    auditAppServerLifecycle("app-server-error", message || "Codex app-server stopped", appServerClient.status());
    for (const job of [...activeTurns.values()]) {
      finishTurnJob(job, false, 1, message || "Codex app-server stopped");
    }
    for (const job of [...activeCompactions.values()]) {
      finishCompactJob(job, false, message || "Codex app-server stopped");
    }
  });
  return appServerClient;
}

function makeSessionKey(repoId, sessionId) {
  return `${repoId}:${sessionId}`;
}

function eventPayload(event, data = {}) {
  return {
    id: ++serverEventSeq,
    event,
    data,
    time: new Date().toISOString(),
  };
}

function semanticJobStatusText(value = "") {
  const text = compactSingleLine(stripAnsi(String(value || "")), 360);
  if (!text) return "";
  if (/^正在连接 Codex app-server/i.test(text)) return "正在连接云端 Codex...";
  if (/^已连接 Codex app-server，正在恢复 thread/i.test(text)) return "正在恢复云端会话...";
  if (/^已连接 Codex app-server，正在启动 thread/i.test(text)) return "正在建立云端会话...";
  if (/^已连接 Codex app-server，正在启动官方 review/i.test(text)) return "正在启动代码审查...";
  if (/^已恢复 app-server thread\b/i.test(text) && /上下文压缩/.test(text)) return "已恢复云端会话，正在启动上下文压缩...";
  if (/^已恢复 app-server thread\b/i.test(text)) return "已恢复云端会话";
  if (/^旧 session 无法恢复，正在创建新的 app-server thread/i.test(text)) return "旧会话无法恢复，正在创建新的云端会话...";
  if (/^已创建 app-server thread\b/i.test(text)) return "已创建云端会话";
  if (/^已启动 turn\b/i.test(text) || /^已启动 app-server turn/i.test(text)) return "已开始生成回复";
  if (/^已启动 detached review\b/i.test(text)) return "已启动侧边代码审查";
  if (/^已启动官方 review/i.test(text)) return "已启动代码审查";
  if (/^app-server thread 已启动/i.test(text)) return "云端会话已启动";
  if (/^app-server thread 已关闭/i.test(text)) return "云端会话已关闭";
  const threadStatus = text.match(/^thread 状态:\s*(.+)$/i);
  if (threadStatus) {
    const status = threadStatus[1].trim().toLowerCase();
    if (status === "idle") return "会话已空闲";
    if (status === "active") return "Codex 正在处理...";
    return "会话状态已更新";
  }
  const settings = text.match(/^设置已同步:\s*(.+)$/i);
  if (settings) return `设置已同步：${settings[1]}`;
  const mcp = text.match(/^MCP\s+([^:]+):\s*(.+)$/i);
  if (mcp) {
    const name = mcp[1].trim();
    const status = mcp[2].trim().toLowerCase();
    if (status === "ready") return `${name} MCP 已就绪`;
    if (status === "failed") return `${name} MCP 启动失败`;
    if (status === "starting") return `${name} MCP 正在启动`;
    return `${name} MCP 状态已更新`;
  }
  if (/token usage/i.test(text)) return "压缩已完成，但上下文用量同步失败。";
  if (/Codex app-server turn 正在运行/i.test(text)) return "云端 Codex 正在运行...";
  if (/Codex app-server stopped/i.test(text)) return "云端 Codex 已停止";
  return text;
}

function semanticJobEventData(event, data = {}) {
  if (event !== "status" || !data || typeof data !== "object" || typeof data.text !== "string") return data;
  return { ...data, text: semanticJobStatusText(data.text) };
}

function rememberAppServerLiveEvent(type, payload = {}) {
  const item = {
    id: `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`,
    time: new Date().toISOString(),
    type: compactSingleLine(type || "app-server", 80),
    title: compactSingleLine(payload.title || type || "app-server event", 160),
    body: compactSingleLine(payload.body || "", 360),
    tone: payload.tone || "info",
    threadId: payload.threadId || null,
    turnId: payload.turnId || null,
    repoId: payload.repoId || null,
    sessionId: payload.sessionId || null,
    data: payload.data || null,
  };
  appServerLiveEvents.unshift(item);
  if (appServerLiveEvents.length > 40) appServerLiveEvents.splice(40);
  return item;
}

function appServerLiveSnapshot() {
  return {
    latestEvents: appServerLiveEvents.slice(0, 12),
    mcpStartup: Object.fromEntries(appServerMcpStartup.entries()),
    skillsChangedAt: appServerSkillsChangedAt,
    appListUpdated: appServerAppListUpdated,
    remoteControl: appServerRemoteControl,
  };
}

function emitJobEvent(job, event, data = {}) {
  const payload = eventPayload(event, semanticJobEventData(event, data));
  job.events.push(payload);
  if (job.events.length > 500) job.events.splice(0, job.events.length - 500);
  job.emitter.emit("event", payload);
  return payload;
}

function writeEventPayload(res, payload) {
  if (res.writableEnded || res.destroyed) return;
  writeSse(res, payload.event, payload.data);
}

function subscribeJobEvents(job, res) {
  for (const payload of job.events) writeEventPayload(res, payload);
  const onEvent = (payload) => writeEventPayload(res, payload);
  job.emitter.on("event", onEvent);
  reqSafeClose(res, () => job.emitter.off("event", onEvent));
}

function reqSafeClose(res, cleanup) {
  res.on("close", cleanup);
  res.on("finish", cleanup);
}

function ownerFromParams(params = {}) {
  const item = params.item || {};
  const itemId = params.itemId || item.id || null;
  const turnId = params.turnId || params.turn?.id || item.turnId || null;
  const threadId =
    params.threadId ||
    params.thread?.id ||
    params.turn?.threadId ||
    params.turn?.thread_id ||
    item.threadId ||
    (turnId && turnOwners.get(turnId)?.threadId) ||
    (itemId && itemOwners.get(itemId)?.threadId) ||
    null;
  return { threadId, turnId, itemId };
}

function rememberOwner({ threadId, turnId, itemId }, owner) {
  if (threadId) rememberBoundedOwner(threadOwners, threadId, owner);
  if (turnId) rememberBoundedOwner(turnOwners, turnId, { ...owner, threadId });
  if (itemId) rememberBoundedOwner(itemOwners, itemId, { ...owner, threadId, turnId });
}

function rememberBoundedOwner(store, key, value) {
  if (store.has(key)) store.delete(key);
  store.set(key, value);
  while (store.size > maxOwnerEntries) store.delete(store.keys().next().value);
}

function clearJobOwners(job) {
  if (job.turnId && turnOwners.get(job.turnId)?.sessionId === job.sessionId) turnOwners.delete(job.turnId);
  for (const itemId of job.itemIds || []) {
    if (itemOwners.get(itemId)?.sessionId === job.sessionId) itemOwners.delete(itemId);
  }
}

function findTurnJob(params = {}) {
  const owner = ownerFromParams(params);
  if (owner.itemId && itemOwners.has(owner.itemId)) {
    const itemOwner = itemOwners.get(owner.itemId);
    const job = activeTurns.get(makeSessionKey(itemOwner.repoId, itemOwner.sessionId));
    if (job) return job;
  }
  if (owner.turnId && turnOwners.has(owner.turnId)) {
    const turnOwner = turnOwners.get(owner.turnId);
    const job = activeTurns.get(makeSessionKey(turnOwner.repoId, turnOwner.sessionId));
    if (job) return job;
  }
  if (owner.threadId && threadOwners.has(owner.threadId)) {
    const threadOwner = threadOwners.get(owner.threadId);
    const job = activeTurns.get(makeSessionKey(threadOwner.repoId, threadOwner.sessionId));
    if (job) return job;
  }
  return null;
}

function findCompactJob(params = {}) {
  const owner = ownerFromParams(params);
  if (owner.threadId) {
    for (const job of activeCompactions.values()) {
      if (job.threadId === owner.threadId) return job;
    }
  }
  if (owner.itemId && itemOwners.has(owner.itemId)) {
    const itemOwner = itemOwners.get(owner.itemId);
    const key = makeSessionKey(itemOwner.repoId, itemOwner.sessionId);
    return activeCompactions.get(key) || null;
  }
  return null;
}

function commandToolRecord(job, itemOrId = {}) {
  if (!job) return null;
  const itemId = typeof itemOrId === "string" ? itemOrId : String(itemOrId.id || itemOrId.itemId || "");
  if (!itemId) return null;
  const existing = job.toolItems.get(itemId) || {
    type: "commandExecution",
    itemId,
    command: "",
    cwd: "",
    status: "inProgress",
    exitCode: null,
    output: "",
    outputLength: 0,
    outputTruncated: false,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (typeof itemOrId === "object") {
    if (itemOrId.command) existing.command = String(itemOrId.command);
    if (itemOrId.cwd) existing.cwd = String(itemOrId.cwd);
    if (itemOrId.status) existing.status = String(itemOrId.status);
  }
  existing.threadId = job.threadId;
  existing.turnId = job.turnId;
  existing.repoId = job.repoId;
  existing.sessionId = job.sessionId;
  existing.updatedAt = new Date().toISOString();
  job.toolItems.set(itemId, existing);
  return existing;
}

function appendCommandOutput(job, itemId, text) {
  const chunk = String(text || "");
  if (!chunk) return null;
  const record = commandToolRecord(job, itemId);
  if (!record) return null;
  record.outputLength += chunk.length;
  if (record.output.length < commandOutputMaxChars) {
    record.output = `${record.output}${chunk}`.slice(0, commandOutputMaxChars);
  }
  if (record.outputLength > commandOutputMaxChars) record.outputTruncated = true;
  record.updatedAt = new Date().toISOString();
  return record;
}

function finishCommandTool(job, itemId, exitCode) {
  const record = commandToolRecord(job, itemId);
  if (!record) return null;
  if (typeof exitCode === "number") {
    record.exitCode = exitCode;
    record.status = exitCode === 0 ? "completed" : "failed";
  } else {
    record.status = record.status === "inProgress" ? "completed" : record.status;
  }
  record.finishedAt = new Date().toISOString();
  record.updatedAt = record.finishedAt;
  return record;
}

function commandToolAuditDetail(record) {
  const output = truncateForUi(record.output || "", commandOutputMaxChars);
  return {
    type: "commandExecution",
    itemId: record.itemId,
    command: record.command,
    cwd: record.cwd,
    status: record.status || "recorded",
    exitCode: typeof record.exitCode === "number" ? record.exitCode : null,
    output,
    outputLineCount: countTextLines(record.output || ""),
    outputLength: record.outputLength || String(record.output || "").length,
    outputTruncated: Boolean(record.outputTruncated || String(record.output || "").length > output.length),
    startedAt: record.startedAt || null,
    finishedAt: record.finishedAt || null,
  };
}

async function persistJobToolAudits(job) {
  if (!job?.toolItems?.size) return;
  for (const record of job.toolItems.values()) {
    if (record.type !== "commandExecution" || !record.command) continue;
    const detail = commandToolAuditDetail(record);
    await appendAuditEvent({
      id: `audit-command-final-${record.itemId}`,
      source: "app-server",
      type: "shell",
      repoId: job.repoId,
      sessionId: job.sessionId,
      threadId: job.threadId || record.threadId || null,
      turnId: job.turnId || record.turnId || null,
      itemId: record.itemId,
      summary: `shell ${detail.status}: ${record.command}`,
      detail: jsonDetail(detail, commandAuditDetailMaxChars),
      detailMaxChars: commandAuditDetailMaxChars,
    });
  }
}

function createServerJob(kind, repo, session, runtime) {
  const key = makeSessionKey(repo.id, session.id);
  let resolvePromise;
  const job = {
    id: `${kind}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`,
    kind,
    key,
    repoId: repo.id,
    sessionId: session.id,
    repo,
    session,
    runtime,
    threadId: session.codexSessionId || null,
    turnId: null,
    itemIds: new Set(),
    toolItems: new Map(),
    output: "",
    stderr: "",
    latestTokenUsage: session.tokenUsage || null,
    latestGoal: session.goal || null,
    completed: false,
    finishing: false,
    ok: null,
    code: null,
    error: null,
    timeoutTimer: null,
    events: [],
    emitter: new EventEmitter(),
    startedAt: new Date().toISOString(),
    promise: new Promise((resolve) => {
      resolvePromise = resolve;
    }),
    makeSessionActive: true,
    cancelRequested: false,
  };
  job.resolve = resolvePromise;
  return job;
}

function armTurnJobTimeout(job) {
  job.timeoutTimer = setTimeout(() => {
    if (job.completed) return;
    job.cancelRequested = true;
    const interrupt = job.threadId && job.turnId
      ? getAppServerClient().request("turn/interrupt", { threadId: job.threadId, turnId: job.turnId }, 20_000).catch(() => null)
      : Promise.resolve();
    interrupt.finally(() => {
      finishTurnJob(job, false, 124, `Codex turn timed out after ${Math.round(codexTurnTimeoutMs / 1000)} seconds`).catch((error) => {
        emitJobEvent(job, "error", { message: error.message || "Codex turn timeout cleanup failed" });
      });
    });
  }, codexTurnTimeoutMs);
  job.timeoutTimer.unref?.();
}

async function resolveThreadForJob(job) {
  const client = getAppServerClient();
  if (job.threadId) {
    try {
      await client.request("thread/resume", { threadId: job.threadId, ...appServerThreadParams(job.repo, job.runtime) }, 30_000);
      emitJobEvent(job, "status", { text: `已恢复 app-server thread ${job.threadId.slice(0, 8)}` });
      rememberOwner({ threadId: job.threadId }, { repoId: job.repoId, sessionId: job.sessionId });
      return job.threadId;
    } catch (error) {
      emitJobEvent(job, "status", { text: "旧 session 无法恢复，正在创建新的 app-server thread..." });
    }
  }
  const started = await client.request("thread/start", appServerThreadParams(job.repo, job.runtime), 30_000);
  job.threadId = started?.thread?.id;
  if (!job.threadId) throw new Error("Codex app-server did not return a thread id");
  rememberOwner({ threadId: job.threadId }, { repoId: job.repoId, sessionId: job.sessionId });
  await updateSessionRuntime(job.repoId, job.sessionId, { codexSessionId: job.threadId, ...job.runtime }, { makeActive: job.makeSessionActive !== false });
  emitJobEvent(job, "session", { codexSessionId: job.threadId, threadId: job.threadId });
  emitJobEvent(job, "status", { text: `已创建 app-server thread ${job.threadId.slice(0, 8)}` });
  return job.threadId;
}

async function startTurnJob(repo, session, runtime, message, attachments = [], storedMessage = message, options = {}) {
  const key = makeSessionKey(repo.id, session.id);
  const existing = activeTurns.get(key);
  if (existing && !existing.completed) throw new Error("当前会话已有正在运行的 turn");

  const job = createServerJob("turn", repo, session, runtime);
  job.makeSessionActive = options.makeSessionActive !== false;
  job.message = message;
  job.storedMessage = storedMessage;
  activeTurns.set(key, job);
  armTurnJobTimeout(job);
  emitJobEvent(job, "meta", { mocked: false, repo: repo.name, sessionId: session.id, codexSessionId: session.codexSessionId || null, jobId: job.id });
  emitJobEvent(job, "status", { text: session.codexSessionId ? "已连接 Codex app-server，正在恢复 thread..." : "已连接 Codex app-server，正在启动 thread..." });

  (async () => {
    try {
      await resolveThreadForJob(job);
      if (job.completed) return;
      if (job.cancelRequested) {
        await getAppServerClient().request("thread/archive", { threadId: job.threadId }, 20_000).catch(() => null);
        await finishTurnJob(job, false, 130, "Turn cancelled before start");
        return;
      }
      const result = await getAppServerClient().request("turn/start", await appServerTurnParams(job.threadId, repo, runtime, message, attachments), 30_000);
      job.turnId = result?.turn?.id || null;
      if (job.completed) {
        if (job.threadId && job.turnId) {
          await getAppServerClient().request("turn/interrupt", { threadId: job.threadId, turnId: job.turnId }, 20_000).catch(() => null);
        }
        return;
      }
      await updateSessionRuntime(
        repo.id,
        session.id,
        { ...runtime, pendingTurnRuntime: null },
        { makeActive: job.makeSessionActive !== false },
      );
      rememberOwner({ threadId: job.threadId, turnId: job.turnId }, { repoId: repo.id, sessionId: session.id });
      if (job.cancelRequested && job.threadId && job.turnId) {
        await getAppServerClient().request("turn/interrupt", { threadId: job.threadId, turnId: job.turnId }, 20_000).catch(() => null);
      }
      emitJobEvent(job, "status", { text: job.turnId ? `已启动 turn ${job.turnId.slice(0, 8)}` : "已启动 app-server turn" });
    } catch (error) {
      await finishTurnJob(job, false, 1, error.message || "Codex app-server turn/start failed");
    }
  })();
  return job;
}

async function startReviewJob(repo, session, runtime, target = { type: "uncommittedChanges" }, delivery = "inline") {
  const key = makeSessionKey(repo.id, session.id);
  const existing = activeTurns.get(key);
  if (existing && !existing.completed) throw new Error("当前会话已有正在运行的 turn");

  const job = createServerJob("turn", repo, session, runtime);
  job.message = "Codex review";
  job.storedMessage = `/review ${target.type || "uncommittedChanges"}`;
  activeTurns.set(key, job);
  armTurnJobTimeout(job);
  emitJobEvent(job, "meta", { mocked: false, repo: repo.name, sessionId: session.id, codexSessionId: session.codexSessionId || null, jobId: job.id, mode: "review" });
  emitJobEvent(job, "status", { text: "已连接 Codex app-server，正在启动官方 review..." });

  (async () => {
    try {
      await resolveThreadForJob(job);
      if (job.completed) return;
      const result = await getAppServerClient().request(
        "review/start",
        {
          threadId: job.threadId,
          target,
          delivery,
        },
        30_000,
      );
      job.turnId = result?.turn?.id || result?.reviewTurnId || null;
      if (job.completed) {
        if (job.threadId && job.turnId) {
          await getAppServerClient().request("turn/interrupt", { threadId: job.threadId, turnId: job.turnId }, 20_000).catch(() => null);
        }
        return;
      }
      if (result?.reviewThreadId) job.reviewThreadId = result.reviewThreadId;
      rememberOwner({ threadId: job.threadId, turnId: job.turnId }, { repoId: repo.id, sessionId: session.id });
      emitJobEvent(job, "status", { text: result?.reviewThreadId ? `已启动 detached review ${String(result.reviewThreadId).slice(0, 8)}` : "已启动官方 review" });
    } catch (error) {
      await finishTurnJob(job, false, 1, error.message || "Codex app-server review/start failed");
    }
  })();
  return job;
}

async function finishTurnJob(job, ok, code = 0, error = null) {
  if (job.completed || job.finishing) return;
  job.finishing = true;
  if (job.timeoutTimer) clearTimeout(job.timeoutTimer);
  job.ok = ok;
  job.code = code;
  job.error = error;
  await persistJobToolAudits(job).catch((auditError) => {
    emitJobEvent(job, "error", { message: `命令审计保存失败: ${auditError.message}` });
  });
  try {
    if (job.threadId) {
      await updateSessionRuntime(job.repoId, job.sessionId, {
        codexSessionId: job.threadId,
        ...job.runtime,
        tokenUsage: normalizeTokenUsage(job.latestTokenUsage),
        goal: job.latestGoal,
        title:
          job.session.title === "新会话" && job.storedMessage
            ? sessionTitle(job.storedMessage)
            : job.session.title,
      }, { makeActive: job.makeSessionActive !== false });
    } else {
      await appendChatTurn(job.repoId, job.sessionId, job.storedMessage, job.output || job.stderr || error || "Codex completed without output.", false);
    }
  } catch (saveError) {
    emitJobEvent(job, "error", { message: `会话保存失败: ${saveError.message}` });
  }
  job.completed = true;
  job.finishing = false;
  if (activeTurns.get(job.key) === job) activeTurns.delete(job.key);
  clearJobOwners(job);
  emitJobEvent(job, "done", { ok, code, sessionId: job.sessionId, codexSessionId: job.threadId, turnId: job.turnId, error });
  job.resolve?.({ ok, code, error });
}

async function startCompactJob(repo, session, runtime) {
  const key = makeSessionKey(repo.id, session.id);
  const existing = activeCompactions.get(key);
  if (existing && !existing.completed) return existing;
  const job = createServerJob("compact", repo, session, runtime);
  activeCompactions.set(key, job);
  job.timeoutTimer = setTimeout(() => {
    finishCompactJob(job, false, `主动压缩超过 ${Math.round(codexCompactTimeoutMs / 1000)} 秒未完成，已标记为失败。`).catch((error) => {
      emitJobEvent(job, "error", { message: error.message || "主动压缩超时处理失败" });
    });
  }, codexCompactTimeoutMs);
  job.timeoutTimer.unref?.();
  emitJobEvent(job, "meta", { repoId: repo.id, sessionId: session.id, threadId: session.codexSessionId, jobId: job.id });
  emitJobEvent(job, "status", { text: "正在连接 Codex app-server..." });

  (async () => {
    try {
      if (!job.threadId) throw new Error("先发送一条消息建立 app-server thread，再压缩上下文。");
      await resolveThreadForJob(job);
      emitJobEvent(job, "status", { text: `已恢复 app-server thread ${job.threadId.slice(0, 8)}，正在启动上下文压缩...` });
      await getAppServerClient().request("thread/compact/start", { threadId: job.threadId }, 30_000);
      emitJobEvent(job, "status", { text: "正在压缩上下文..." });
    } catch (error) {
      await finishCompactJob(job, false, error.message || "主动压缩失败");
    }
  })();
  return job;
}

async function finishCompactJob(job, ok, error = null) {
  if (job.completed) return;
  job.completed = true;
  if (job.timeoutTimer) clearTimeout(job.timeoutTimer);
  activeCompactions.delete(job.key);
  const compactedAt = ok ? new Date().toISOString() : null;
  if (ok && job.threadId) {
    const threadResponse = await codexAppServerRequest("thread/read", { threadId: job.threadId, includeTurns: false }, 20_000).catch((readError) => ({
      ok: false,
      error: readError.message || "thread/read failed after compact",
    }));
    if (threadResponse.ok) {
      job.latestTokenUsage =
        normalizeTokenUsage(threadResponse.result?.thread?.tokenUsage || threadResponse.result?.thread?.token_usage) ||
        job.latestTokenUsage;
    } else {
      emitJobEvent(job, "status", { text: `压缩完成，但 token usage 同步失败：${threadResponse.error}` });
    }
  }
  if (ok) {
    try {
      await updateSessionRuntime(job.repoId, job.sessionId, {
        compactedAt,
        tokenUsage: normalizeTokenUsage(job.latestTokenUsage || job.session.tokenUsage),
      });
    } catch (saveError) {
      emitJobEvent(job, "error", { message: `压缩状态保存失败: ${saveError.message}` });
    }
  }
  emitJobEvent(job, "done", {
    ok,
    code: ok ? 0 : 1,
    sessionId: job.sessionId,
    threadId: job.threadId,
    compactedAt,
    error,
    tokenUsage: normalizeTokenUsage(job.latestTokenUsage || job.session.tokenUsage),
  });
  job.resolve?.({ ok, error });
}

function handleAppServerNotification(rpcMessage) {
  const params = rpcMessage.params || {};
  const owner = ownerFromParams(params);
  const turnJob = findTurnJob(params);
  const compactJob = findCompactJob(params);
  const job = compactJob || turnJob;

  if (owner.threadId || owner.turnId || owner.itemId) {
    const routeOwner = job ? { repoId: job.repoId, sessionId: job.sessionId } : owner.threadId ? threadOwners.get(owner.threadId) : null;
    if (routeOwner) rememberOwner(owner, routeOwner);
  }

  if (rpcMessage.method === "thread/started") {
    const routeOwner = job ? { repoId: job.repoId, sessionId: job.sessionId } : owner.threadId ? threadOwners.get(owner.threadId) : null;
    if (routeOwner) {
      upsertThreadNotificationSession(params.thread || {}, routeOwner).catch((error) => {
        if (job) emitJobEvent(job, "error", { message: `thread 启动同步失败: ${error.message}` });
      });
    }
    if (job) emitJobEvent(job, "status", { text: "app-server thread 已启动" });
    return;
  }
  if (rpcMessage.method === "thread/name/updated") {
    const threadId = threadNotificationId(params, owner);
    const title = params.threadName ? sessionTitle(params.threadName) : "";
    if (threadId && title) {
      patchStoredThreadSession(threadId, { title }, { makeActive: false }).catch((error) => {
        if (job) emitJobEvent(job, "error", { message: `thread 标题同步失败: ${error.message}` });
      });
      if (job) emitJobEvent(job, "status", { text: `会话已命名: ${title}` });
    }
    return;
  }
  if (rpcMessage.method === "thread/archived") {
    const threadId = threadNotificationId(params, owner);
    if (threadId) {
      removeStoredThreadSession(threadId).catch((error) => {
        if (job) emitJobEvent(job, "error", { message: `thread 归档同步失败: ${error.message}` });
      });
      if (job) emitJobEvent(job, "status", { text: "会话已归档" });
    }
    return;
  }
  if (rpcMessage.method === "thread/unarchived") {
    const threadId = threadNotificationId(params, owner);
    const routeOwner = job ? { repoId: job.repoId, sessionId: job.sessionId } : threadId ? threadOwners.get(threadId) : null;
    if (threadId && routeOwner?.repoId) {
      const repo = getRepoById(routeOwner.repoId);
      importAppServerThreadSession(repo, threadId).catch((error) => {
        if (job) emitJobEvent(job, "error", { message: `thread 恢复同步失败: ${error.message}` });
      });
      if (job) emitJobEvent(job, "status", { text: "会话已恢复" });
    }
    return;
  }
  if (rpcMessage.method === "thread/closed") {
    if (job) emitJobEvent(job, "status", { text: "app-server thread 已关闭" });
    return;
  }
  if (rpcMessage.method === "thread/status/changed") {
    if (job) emitJobEvent(job, "status", { text: `thread 状态: ${formatThreadStatus(params.status)}` });
    return;
  }
  if (rpcMessage.method === "thread/tokenUsage/updated") {
    if (job) {
      job.latestTokenUsage = normalizeTokenUsage(params.tokenUsage) || job.latestTokenUsage;
      emitJobEvent(job, "tokenUsage", { tokenUsage: job.latestTokenUsage });
    }
    return;
  }
  if (rpcMessage.method === "thread/settings/updated") {
    const routeOwner = job ? { repoId: job.repoId, sessionId: job.sessionId } : owner.threadId ? threadOwners.get(owner.threadId) : null;
    const runtime = runtimeFromAppServerSettings(params, job?.runtime || {});
    if (routeOwner) {
      findStoredSessionByThreadId(owner.threadId || job?.threadId || "")
        .then(({ session }) => mergeAppServerRuntimeWithPending(session || {}, runtime, { clearPending: Boolean(job) }))
        .then((mergedRuntime) => updateSessionRuntime(routeOwner.repoId, routeOwner.sessionId, mergedRuntime, { makeActive: false }))
        .catch((error) => {
          if (job) emitJobEvent(job, "error", { message: `设置同步失败: ${error.message}` });
        });
    }
    if (job) emitJobEvent(job, "status", { text: `设置已同步: ${runtime.model} · ${runtime.reasoning}` });
    return;
  }
  if (rpcMessage.method === "thread/goal/updated") {
    if (job) {
      job.latestGoal = params.goal || job.latestGoal;
      emitJobEvent(job, "goal", { goal: job.latestGoal });
    }
    return;
  }
  if (rpcMessage.method === "thread/goal/cleared") {
    if (job) {
      job.latestGoal = null;
      emitJobEvent(job, "goal", { goal: null });
    }
    return;
  }
  if (rpcMessage.method === "thread/compacted") {
    if (compactJob) {
      emitJobEvent(compactJob, "compacted", { text: "上下文已压缩" });
      finishCompactJob(compactJob, true).catch((error) => {
        emitJobEvent(compactJob, "error", { message: error.message || "主动压缩完成状态保存失败" });
      });
    } else if (turnJob) {
      emitJobEvent(turnJob, "status", { text: "上下文已自动压缩" });
    }
    return;
  }
  if (rpcMessage.method === "turn/started") {
    if (turnJob) {
      turnJob.turnId = params.turn?.id || turnJob.turnId;
      rememberOwner({ threadId: turnJob.threadId, turnId: turnJob.turnId }, { repoId: turnJob.repoId, sessionId: turnJob.sessionId });
      emitJobEvent(turnJob, "status", { text: "Codex 正在运行 turn..." });
    }
    return;
  }
  if (rpcMessage.method === "item/started") {
    if (params.item?.id && job) {
      job.itemIds.add(params.item.id);
      rememberOwner({ threadId: owner.threadId || job.threadId, turnId: owner.turnId || job.turnId, itemId: params.item.id }, { repoId: job.repoId, sessionId: job.sessionId });
    }
    auditAppServerItem(params.item || {}, job, owner);
    const statusText = formatAppServerItemStatus(params.item);
    if (statusText && job) emitJobEvent(job, "status", { text: statusText });
    if (params.item?.type === "contextCompaction") {
      const target = compactJob || turnJob;
      if (target) emitJobEvent(target, "status", { text: "Codex 正在生成压缩摘要..." });
    }
    if (params.item?.type === "commandExecution" && job) {
      commandToolRecord(job, params.item);
      emitJobEvent(job, "tool", { type: "command", command: params.item.command, cwd: params.item.cwd, itemId: params.item.id });
    }
    if (params.item?.type === "fileChange" && job) {
      emitJobEvent(job, "tool", { type: "fileChange", itemId: params.item.id, changes: params.item.changes || [] });
    }
    return;
  }
  if (rpcMessage.method === "item/agentMessage/delta") {
    if (!turnJob) return;
    const text = String(params.delta || "");
    turnJob.output += text;
    emitJobEvent(turnJob, "delta", { text });
    return;
  }
  if (rpcMessage.method === "item/completed") {
    const item = params.item || {};
    if (item.type === "agentMessage" && turnJob && !turnJob.output && item.text) {
      turnJob.output = String(item.text);
      emitJobEvent(turnJob, "delta", { text: turnJob.output });
    }
    if (item.type === "contextCompaction") {
      const target = compactJob || turnJob;
      if (target) emitJobEvent(target, "status", { text: "压缩摘要已生成，正在写回会话..." });
      if (compactJob) finishCompactJob(compactJob, true).catch((error) => {
        emitJobEvent(compactJob, "error", { message: error.message || "主动压缩完成状态保存失败" });
      });
      return;
    }
    if (item.type === "commandExecution" && job) {
      const record = commandToolRecord(job, params.item);
      if (record && typeof params.item.aggregatedOutput === "string" && !record.output) {
        record.output = params.item.aggregatedOutput.slice(0, commandOutputMaxChars);
        record.outputLength = params.item.aggregatedOutput.length;
        record.outputTruncated = params.item.aggregatedOutput.length > commandOutputMaxChars;
      }
      finishCommandTool(job, params.item.id, typeof params.item.exitCode === "number" ? params.item.exitCode : null);
      emitJobEvent(job, "tool", {
        type: "processExited",
        exitCode: typeof params.item.exitCode === "number" ? params.item.exitCode : null,
        itemId: params.item.id,
      });
    }
    return;
  }
  if (rpcMessage.method === "item/plan/delta") {
    if (job) emitJobEvent(job, "tool", { type: "plan", text: String(params.delta || ""), itemId: params.itemId });
    return;
  }
  if (rpcMessage.method === "turn/plan/updated") {
    if (job) emitJobEvent(job, "tool", { type: "plan", plan: params.plan || params.steps || params });
    return;
  }
  if (rpcMessage.method === "turn/diff/updated") {
    if (job) emitJobEvent(job, "tool", { type: "diff", diff: params.diff || params });
    return;
  }
  if (rpcMessage.method === "item/commandExecution/outputDelta") {
    if (job) {
      const text = decodeAppServerTextDelta(params);
      appendCommandOutput(job, params.itemId, text);
      emitJobEvent(job, "tool", { type: "commandOutput", text, itemId: params.itemId });
    }
    return;
  }
  if (rpcMessage.method === "command/exec/outputDelta" || rpcMessage.method === "process/outputDelta") {
    if (job) {
      const text = decodeAppServerTextDelta(params);
      appendCommandOutput(job, params.itemId, text);
      emitJobEvent(job, "tool", { type: "commandOutput", text, itemId: params.itemId, stream: params.stream || null });
    }
    return;
  }
  if (rpcMessage.method === "process/exited") {
    if (job) {
      const exitCode = params.exitCode ?? params.exit_code ?? null;
      finishCommandTool(job, params.itemId, typeof exitCode === "number" ? exitCode : null);
      emitJobEvent(job, "tool", { type: "processExited", exitCode, itemId: params.itemId });
    }
    return;
  }
  if (rpcMessage.method === "item/fileChange/outputDelta") {
    if (job) emitJobEvent(job, "tool", { type: "fileChangeOutput", text: decodeAppServerTextDelta(params), itemId: params.itemId });
    return;
  }
  if (rpcMessage.method === "item/fileChange/patchUpdated") {
    if (job) emitJobEvent(job, "tool", { type: "filePatch", changes: params.changes || [], itemId: params.itemId });
    return;
  }
  if (rpcMessage.method === "item/reasoning/textDelta" || rpcMessage.method === "item/reasoning/summaryTextDelta") {
    if (job) emitJobEvent(job, "tool", { type: "reasoning", text: decodeAppServerTextDelta(params), itemId: params.itemId });
    return;
  }
  if (rpcMessage.method === "item/reasoning/summaryPartAdded") {
    if (job) emitJobEvent(job, "tool", { type: "reasoning", text: collectText(params.part || params).slice(0, 2000), itemId: params.itemId });
    return;
  }
  if (rpcMessage.method === "item/mcpToolCall/progress") {
    const message = compactSingleLine(params.message || "MCP tool is still running", 360);
    if (job) {
      emitJobEvent(job, "tool", {
        type: "mcpProgress",
        message,
        itemId: params.itemId || owner.itemId || null,
        threadId: params.threadId || owner.threadId || job.threadId || null,
        turnId: params.turnId || owner.turnId || job.turnId || null,
      });
    }
    return;
  }
  if (rpcMessage.method === "item/commandExecution/terminalInteraction") {
    if (job) {
      emitJobEvent(job, "tool", {
        type: "terminalInteraction",
        processId: params.processId || null,
        stdin: truncateForUi(params.stdin || "", 600),
        itemId: params.itemId || owner.itemId || null,
        threadId: params.threadId || owner.threadId || job.threadId || null,
        turnId: params.turnId || owner.turnId || job.turnId || null,
      });
    }
    return;
  }
  if (rpcMessage.method === "serverRequest/resolved") {
    if (job) {
      emitJobEvent(job, "tool", {
        type: "requestResolved",
        requestId: params.requestId || null,
        threadId: params.threadId || owner.threadId || job.threadId || null,
      });
    }
    return;
  }
  if (rpcMessage.method === "model/rerouted") {
    const routeOwner = job ? { repoId: job.repoId, sessionId: job.sessionId } : owner.threadId ? threadOwners.get(owner.threadId) : null;
    const title = `模型已切换: ${params.fromModel || "unknown"} -> ${params.toModel || "unknown"}`;
    rememberAppServerLiveEvent("model/rerouted", {
      title,
      body: params.reason ? `原因: ${params.reason}` : "",
      tone: "warn",
      threadId: params.threadId || owner.threadId || null,
      turnId: params.turnId || owner.turnId || null,
      repoId: routeOwner?.repoId || null,
      sessionId: routeOwner?.sessionId || null,
      data: params,
    });
    appendAuditEvent({
      source: "app-server",
      type: "model-rerouted",
      repoId: routeOwner?.repoId || null,
      sessionId: routeOwner?.sessionId || null,
      threadId: params.threadId || owner.threadId || null,
      turnId: params.turnId || owner.turnId || null,
      itemId: null,
      summary: title,
      detail: jsonDetail(params),
    }).catch(() => null);
    if (job) {
      emitJobEvent(job, "tool", {
        type: "modelRerouted",
        fromModel: params.fromModel || null,
        toModel: params.toModel || null,
        reason: params.reason || null,
        threadId: params.threadId || owner.threadId || job.threadId || null,
        turnId: params.turnId || owner.turnId || job.turnId || null,
      });
      emitJobEvent(job, "status", { text: title });
    }
    return;
  }
  if (rpcMessage.method === "model/verification") {
    const routeOwner = job ? { repoId: job.repoId, sessionId: job.sessionId } : owner.threadId ? threadOwners.get(owner.threadId) : null;
    const verifications = Array.isArray(params.verifications) ? params.verifications : [];
    const title = verifications.length ? `模型验证: ${verifications.join(", ")}` : "模型验证已更新";
    rememberAppServerLiveEvent("model/verification", {
      title,
      body: params.turnId ? `turn ${String(params.turnId).slice(0, 8)}` : "",
      tone: "info",
      threadId: params.threadId || owner.threadId || null,
      turnId: params.turnId || owner.turnId || null,
      repoId: routeOwner?.repoId || null,
      sessionId: routeOwner?.sessionId || null,
      data: params,
    });
    if (job) {
      emitJobEvent(job, "tool", {
        type: "modelVerification",
        verifications,
        threadId: params.threadId || owner.threadId || job.threadId || null,
        turnId: params.turnId || owner.turnId || job.turnId || null,
      });
    }
    return;
  }
  if (rpcMessage.method === "item/autoApprovalReview/started" || rpcMessage.method === "item/autoApprovalReview/completed") {
    const event = guardianReviewEvent(rpcMessage.method, params);
    appendAuditEvent({
      source: "app-server",
      type: "approval-auto-review",
      repoId: job?.repoId || null,
      sessionId: job?.sessionId || null,
      threadId: event.threadId || owner.threadId || job?.threadId || null,
      turnId: event.turnId || owner.turnId || job?.turnId || null,
      itemId: event.targetItemId || owner.itemId || null,
      summary: event.summary,
      detail: jsonDetail(event),
    }).catch(() => null);
    if (job) {
      emitJobEvent(job, "guardian", event);
      emitJobEvent(job, "status", { text: event.summary });
    }
    return;
  }
  if (rpcMessage.method === "mcpServer/startupStatus/updated") {
    const name = compactSingleLine(params.name || "mcp", 120);
    const status = compactSingleLine(params.status || "unknown", 80);
    const error = params.error ? compactSingleLine(params.error, 360) : null;
    const tone = status === "failed" ? "warn" : status === "ready" ? "ok" : "info";
    appServerMcpStartup.set(name, { name, status, error, updatedAt: new Date().toISOString() });
    rememberAppServerLiveEvent("mcpServer/startupStatus/updated", {
      title: `MCP ${name}: ${status}`,
      body: error || "",
      tone,
      data: { name, status, error },
    });
    if (status === "failed") {
      appendAuditEvent({
        source: "app-server",
        type: "mcp-startup",
        repoId: null,
        sessionId: null,
        threadId: null,
        turnId: null,
        itemId: null,
        summary: `MCP ${name} 启动失败`,
        detail: jsonDetail(params),
      }).catch(() => null);
    }
    if (job) emitJobEvent(job, "status", { text: `MCP ${name}: ${status}` });
    return;
  }
  if (rpcMessage.method === "skills/changed") {
    appServerSkillsChangedAt = new Date().toISOString();
    rememberAppServerLiveEvent("skills/changed", {
      title: "Skills 已变更",
      body: "app-server 已发出 skills/list 失效信号，下一次状态刷新会读取最新 skill metadata。",
      tone: "info",
    });
    if (job) emitJobEvent(job, "status", { text: "Skills 已更新，正在等待状态刷新" });
    return;
  }
  if (rpcMessage.method === "app/list/updated") {
    const count = Array.isArray(params.data) ? params.data.length : 0;
    appServerAppListUpdated = { count, updatedAt: new Date().toISOString() };
    rememberAppServerLiveEvent("app/list/updated", {
      title: `App 列表已更新: ${count}`,
      body: "连接器/App 列表已由 app-server 推送更新。",
      tone: "info",
      data: { count },
    });
    return;
  }
  if (rpcMessage.method === "remoteControl/status/changed") {
    appServerRemoteControl = {
      status: params.status || "unknown",
      serverName: params.serverName || "",
      installationId: params.installationId || "",
      environmentId: params.environmentId || null,
      updatedAt: new Date().toISOString(),
    };
    rememberAppServerLiveEvent("remoteControl/status/changed", {
      title: `Remote control ${appServerRemoteControl.status}`,
      body: appServerRemoteControl.serverName || "",
      tone: appServerRemoteControl.status === "errored" ? "warn" : "info",
      data: appServerRemoteControl,
    });
    return;
  }
  if (rpcMessage.method === "externalAgentConfig/import/completed") {
    rememberAppServerLiveEvent("externalAgentConfig/import/completed", {
      title: "外部 Agent 配置已导入",
      body: "app-server 已完成外部 agent 配置导入。",
      tone: "ok",
    });
    return;
  }
  if (rpcMessage.method === "deprecationNotice") {
    const summary = compactSingleLine(params.summary || "Codex deprecation notice", 220);
    const details = compactSingleLine(params.details || "", 520);
    rememberAppServerLiveEvent("deprecationNotice", {
      title: summary,
      body: details,
      tone: "warn",
      data: params,
    });
    appendAuditEvent({
      source: "app-server",
      type: "deprecation-notice",
      repoId: null,
      sessionId: null,
      threadId: null,
      turnId: null,
      itemId: null,
      summary,
      detail: jsonDetail(params),
    }).catch(() => null);
    return;
  }
  if (rpcMessage.method === "fuzzyFileSearch/sessionUpdated") {
    const count = Array.isArray(params.files) ? params.files.length : 0;
    rememberAppServerLiveEvent("fuzzyFileSearch/sessionUpdated", {
      title: `文件搜索: ${params.query || ""}`,
      body: `${count} 个匹配`,
      tone: "info",
      data: { sessionId: params.sessionId || null, query: params.query || "", count },
    });
    return;
  }
  if (rpcMessage.method === "fuzzyFileSearch/sessionCompleted") {
    rememberAppServerLiveEvent("fuzzyFileSearch/sessionCompleted", {
      title: "文件搜索已完成",
      body: params.sessionId ? `session ${String(params.sessionId).slice(0, 8)}` : "",
      tone: "info",
      data: params,
    });
    return;
  }
  if (rpcMessage.method === "warning" || rpcMessage.method === "guardianWarning" || rpcMessage.method === "configWarning") {
    const message = appServerErrorMessage(params, params.message || params.warning || "Codex warning");
    appendAuditEvent({
      source: "app-server",
      type: "app-server-warning",
      repoId: job?.repoId || null,
      sessionId: job?.sessionId || null,
      threadId: owner.threadId || job?.threadId || null,
      turnId: owner.turnId || job?.turnId || null,
      itemId: owner.itemId || null,
      summary: message,
      detail: jsonDetail({ ...params, normalizedMessage: message }),
    }).catch(() => null);
    if (job) emitJobEvent(job, "error", { message });
    return;
  }
  if (rpcMessage.method === "mcpServer/oauthLogin/completed") {
    mcpOauthResults.unshift({
      name: String(params.name || ""),
      success: Boolean(params.success),
      error: params.error ? String(params.error) : null,
      time: new Date().toISOString(),
    });
    mcpOauthResults.splice(12);
    return;
  }
  if (rpcMessage.method === "account/login/completed") {
    const flow = completeAccountLoginFlow(params);
    const canceled = flow?.status === "canceled";
    appendAuditEvent({
      source: "app-server",
      type: params.success ? "account-login-completed" : canceled ? "account-login-canceled" : "account-login-failed",
      summary: params.success ? "Codex account login completed" : canceled ? "Codex account login canceled" : "Codex account login failed",
      detail: jsonDetail({ ...params, flow }),
    }).catch(() => null);
    return;
  }
  if (rpcMessage.method === "account/updated" || rpcMessage.method === "account/rateLimits/updated") {
    appendAuditEvent({
      source: "app-server",
      type: rpcMessage.method,
      summary: rpcMessage.method === "account/updated" ? "Codex account updated" : "Codex rate limits updated",
      detail: jsonDetail(params),
    }).catch(() => null);
    return;
  }
  if (rpcMessage.method === "turn/completed") {
    if (compactJob) {
      finishCompactJob(compactJob, true).catch((error) => {
        emitJobEvent(compactJob, "error", { message: error.message || "主动压缩完成状态保存失败" });
      });
      return;
    }
    if (turnJob) {
      turnJob.latestTokenUsage =
        normalizeTokenUsage(params.tokenUsage || params.turn?.tokenUsage || params.turn?.token_usage) || turnJob.latestTokenUsage;
      const status = params.turn?.status || "completed";
      finishTurnJob(turnJob, status === "completed", status === "completed" ? 0 : 1, status === "completed" ? null : status);
    }
    return;
  }
  if (rpcMessage.method === "error") {
    const message = appServerErrorMessage(params, "Codex app-server error");
    appendAuditEvent({
      source: "app-server",
      type: "app-server-error",
      repoId: job?.repoId || null,
      sessionId: job?.sessionId || null,
      threadId: owner.threadId || job?.threadId || null,
      turnId: owner.turnId || job?.turnId || null,
      itemId: owner.itemId || null,
      summary: String(message),
      detail: jsonDetail({ ...params, normalizedMessage: message }),
    }).catch(() => null);
    if (job) emitJobEvent(job, "error", { message });
    if (turnJob) finishTurnJob(turnJob, false, 1, message);
    if (compactJob) {
      finishCompactJob(compactJob, false, message).catch((error) => {
        emitJobEvent(compactJob, "error", { message: error.message || "主动压缩失败状态保存失败" });
      });
    }
  }
}

async function appServerProbe(method, params = {}, timeout = 20_000) {
  const response = await codexAppServerRequest(method, params, timeout);
  return response.ok
    ? { ok: true, result: response.result || null }
    : { ok: false, error: response.error || "request failed" };
}

async function codexAppServerBatchRequest(requests, timeout = 60_000) {
  const perRequestTimeout = Math.min(Math.max(Number(timeout || 0), 3_000), 60_000);
  const entries = await Promise.all(
    requests.map(async (request) => {
      const response = await codexAppServerRequest(request.method, request.params || {}, request.timeout || perRequestTimeout);
      return [
        request.key,
        response.ok
          ? { ok: true, result: response.result || null }
          : { ok: false, error: response.error || "request failed", stderr: response.stderr || "" },
      ];
    }),
  );
  return Object.fromEntries(entries);
}

function countInstalledPlugins(pluginResponse) {
  const marketplaces = pluginResponse?.result?.marketplaces || [];
  const plugins = marketplaces.flatMap((marketplace) => marketplace.plugins || []);
  return {
    installed: plugins.filter((plugin) => plugin.installed).length,
    enabled: plugins.filter((plugin) => plugin.enabled).length,
    available: plugins.length,
    names: plugins
      .filter((plugin) => plugin.installed || plugin.enabled)
      .map((plugin) => plugin.interface?.displayName || plugin.name || plugin.id)
      .filter(Boolean)
      .slice(0, 12),
  };
}

// Adapted in spirit from friuns2/codexui's MIT-licensed skill grouping
// helpers in src/api/codexGateway.ts. Keep app-server as the source of truth.
function normalizeSkillMarkdownPath(skillPath) {
  if (!skillPath) return "";
  return String(skillPath).endsWith("/SKILL.md") ? String(skillPath) : `${skillPath}/SKILL.md`;
}

function deriveGroupedSkillRoot(skillPath, knownPaths) {
  const normalizedPath = normalizeSkillMarkdownPath(skillPath);
  const parts = normalizedPath.split("/").filter(Boolean);
  if (parts.length < 2) return null;

  const pluginSkillsIndex = parts.lastIndexOf("skills");
  if (pluginSkillsIndex >= 2) {
    const pluginName = parts[pluginSkillsIndex - 2] || "";
    if (pluginName) {
      const pluginRootPath = `/${[...parts.slice(0, pluginSkillsIndex + 1), pluginName, "SKILL.md"].join("/")}`;
      if (knownPaths.has(pluginRootPath)) return { rootPath: pluginRootPath, rootName: pluginName, isNested: pluginRootPath !== normalizedPath };
    }
  }

  const firstSkillsIndex = parts.indexOf("skills");
  if (firstSkillsIndex < 0 || firstSkillsIndex + 1 >= parts.length - 1) return null;
  const rootName = parts[firstSkillsIndex + 1] || "";
  if (!rootName) return null;
  const rootPath = `/${[...parts.slice(0, firstSkillsIndex + 2), "SKILL.md"].join("/")}`;
  return { rootPath, rootName, isNested: rootPath !== normalizedPath };
}

function groupedSkillsFromEntries(entries) {
  const allSkills = (entries || []).flatMap((entry) => (Array.isArray(entry?.skills) ? entry.skills : []));
  const pathSet = new Set(allSkills.map((skill) => normalizeSkillMarkdownPath(skill.path)).filter(Boolean));
  const grouped = new Map();
  for (const skill of allSkills) {
    if (!skill?.name) continue;
    const groupInfo = deriveGroupedSkillRoot(skill.path, pathSet);
    const normalizedPath = normalizeSkillMarkdownPath(skill.path);
    const shouldCollapseIntoRoot = Boolean(groupInfo?.isNested && pathSet.has(groupInfo.rootPath));
    const key = shouldCollapseIntoRoot ? groupInfo.rootPath : normalizedPath;
    const isRoot = normalizedPath === key;
    const candidate = {
      name: String(skill.name),
      displayName: groupInfo && key === groupInfo.rootPath ? groupInfo.rootName : skill.interface?.displayName || skill.name,
      description: skill.shortDescription || skill.interface?.shortDescription || skill.description || "",
      path: key,
      scope: skill.scope || "",
      enabled: skill.enabled !== false,
      __hasRoot: isRoot,
    };
    const existing = grouped.get(key);
    if (!existing || (!existing.__hasRoot && isRoot)) {
      grouped.set(key, candidate);
      continue;
    }
    existing.enabled = existing.enabled || candidate.enabled;
    if (!existing.displayName && candidate.displayName) existing.displayName = candidate.displayName;
    if (!existing.description && candidate.description) existing.description = candidate.description;
  }
  return Array.from(grouped.values()).map(({ __hasRoot: _ignored, ...skill }) => skill);
}

function rememberAccountLoginFlow(flow = {}) {
  const loginId = String(flow.loginId || "").trim();
  if (!loginId) return null;
  const existing = accountLoginFlows.get(loginId) || {};
  const now = new Date().toISOString();
  const next = {
    ...existing,
    ...flow,
    loginId,
    startedAt: existing.startedAt || flow.startedAt || now,
    updatedAt: now,
  };
  accountLoginFlows.set(loginId, next);
  const newest = [...accountLoginFlows.values()].sort(
    (a, b) => new Date(b.updatedAt || b.startedAt || 0) - new Date(a.updatedAt || a.startedAt || 0),
  );
  for (const stale of newest.slice(12)) accountLoginFlows.delete(stale.loginId);
  return next;
}

function accountLoginFlowFromResponse(response = {}) {
  const loginId = String(response.loginId || "").trim();
  if (!loginId) return null;
  return rememberAccountLoginFlow({
    loginId,
    type: String(response.type || "unknown"),
    status: "pending",
    authUrl: response.authUrl || null,
    verificationUrl: response.verificationUrl || null,
    userCode: response.userCode || null,
    error: null,
  });
}

function completeAccountLoginFlow(params = {}) {
  const loginId = String(params.loginId || "").trim();
  const fallback = [...accountLoginFlows.values()]
    .filter((flow) => flow.status === "pending")
    .sort((a, b) => new Date(b.updatedAt || b.startedAt || 0) - new Date(a.updatedAt || a.startedAt || 0))[0];
  const targetId = loginId || fallback?.loginId || "";
  if (!targetId) return null;
  const existing = accountLoginFlows.get(targetId);
  if (!params.success && existing?.status === "canceled") {
    return rememberAccountLoginFlow({
      loginId: targetId,
      status: "canceled",
      error: null,
      completedAt: existing.completedAt || new Date().toISOString(),
    });
  }
  return rememberAccountLoginFlow({
    loginId: targetId,
    status: params.success ? "completed" : "failed",
    error: params.error ? String(params.error) : null,
    completedAt: new Date().toISOString(),
  });
}

function cancelAccountLoginFlow(loginId, result = {}) {
  return rememberAccountLoginFlow({
    loginId,
    status: result.status === "notFound" ? "notFound" : "canceled",
    error: null,
    completedAt: new Date().toISOString(),
  });
}

function accountLoginSnapshot() {
  const flows = [...accountLoginFlows.values()]
    .sort((a, b) => new Date(b.updatedAt || b.startedAt || 0) - new Date(a.updatedAt || a.startedAt || 0))
    .slice(0, 8);
  return {
    active: flows.find((flow) => flow.status === "pending") || null,
    latest: flows[0] || null,
    flows,
  };
}

function summarizeAppServerStatus(results) {
  const account = results.account.result?.account || null;
  const rateLimits = results.rateLimits.result?.rateLimits || null;
  const mcpServers = results.mcp.result?.data || [];
  const skills = groupedSkillsFromEntries(results.skills.result?.data || []);
  const features = results.features.result?.data || [];
  const config = results.config.result?.config || {};
  const plugins = countInstalledPlugins(results.plugins);
  const gaps = [];
  const appHost = getAppServerClient().status();
  const allRequestsFailed = Object.values(results).every((value) => !value.ok);
  const authProblem = codexAuthProblemFromSources(
    appHost.lastError,
    (appHost.stderrTail || []).join("\n"),
    Object.values(results).map((value) => value.error || value.stderr || "").join("\n"),
  );
  const usageLimit = codexUsageLimitFromSources(
    appHost.lastError,
    (appHost.stderrTail || []).join("\n"),
    rateLimits?.rateLimitReachedType ? `rateLimitReachedType: ${rateLimits.rateLimitReachedType}` : "",
    Object.values(results).map((value) => value.error || value.stderr || "").join("\n"),
  );
  if (authProblem) gaps.push(authProblem);
  if (usageLimit) gaps.push(`${usageLimit.title}: ${usageLimit.retryAtText ? `可在 ${usageLimit.retryAtText} 后重试` : usageLimit.message}`);
  if (allRequestsFailed) gaps.push(`Codex app-server host 不可用: ${appHost.lastError || Object.values(results)[0]?.error || "unknown"}`);
  if (!allRequestsFailed && !results.appList.ok) gaps.push("App list 当前不可用，云端无法完整展示桌面 App 连接器市场。");
  for (const server of mcpServers) {
    if (mcpAuthNeedsLogin(server.authStatus)) {
      gaps.push(`${server.name} MCP 需要 OAuth 登录后才能完整使用。`);
    }
  }
  if (!features.some((feature) => feature.name === "realtime_conversation" && feature.enabled)) {
    gaps.push("Realtime voice/audio 是底层未启用能力，网页端暂不对齐。");
  }
  const requiredKeys = ["account", "rateLimits", "mcp", "plugins", "provider"];
  const capabilityKeys = ["skills", "features", "permissions", "config", "appList"];
  const failedCriticalKeys = requiredKeys.filter((key) => !results[key]?.ok);
  const capabilityWarnings = capabilityKeys
    .filter((key) => !results[key]?.ok)
    .map((key) => ({
      key,
      error: sanitizeCloudPathText(results[key]?.error || "app-server method unavailable", 320),
    }));
  const permissionProfiles = Array.isArray(results.permissions.result?.data) && results.permissions.result.data.length
    ? results.permissions.result.data
    : [
        { id: "read-only", description: "只读工作区" },
        { id: "workspace-write", description: "可写工作区" },
        { id: "danger-full-access", description: "全权限，不询问" },
      ];
  return {
    ok: failedCriticalKeys.length === 0,
    source: failedCriticalKeys.length ? "app-server-partial" : "app-server",
    authoritative: failedCriticalKeys.length === 0,
    partial: failedCriticalKeys.length > 0,
    failedCriticalKeys,
    capabilityWarnings,
    account,
    rateLimits,
    usageLimit,
    mcpServers: mcpServers.map((server) => ({
      name: server.name,
      authStatus: server.authStatus,
      toolCount: Object.keys(server.tools || {}).length,
      resourceCount: (server.resources || []).length + (server.resourceTemplates || []).length,
    })),
    plugins,
    skills: {
      enabled: skills.filter((skill) => skill.enabled !== false).length,
      total: skills.length,
      names: skills.map((skill) => skill.name).filter(Boolean).slice(0, 16),
      items: skills.slice(0, 80),
    },
    features: {
      enabled: features.filter((feature) => feature.enabled).length,
      total: features.length,
      names: features.filter((feature) => feature.enabled).map((feature) => feature.name).slice(0, 24),
    },
    permissionProfiles,
    config: {
      model: config.model || defaultRuntime.model,
      reasoning: config.model_reasoning_effort || defaultRuntime.reasoning,
      sandbox: config.sandbox_mode || defaultRuntime.sandbox,
      approval: config.approval_policy || defaultRuntime.approval,
      autoCompactTokenLimit: Number(config.model_auto_compact_token_limit || 0) || null,
      autoCompactTokenLimitScope: config.model_auto_compact_token_limit_scope || null,
    },
    providerCapabilities: results.provider.result || null,
    auth: {
      ok: !authProblem,
      issue: authProblem || null,
    },
    appHost,
    live: appServerLiveSnapshot(),
    accountLogin: accountLoginSnapshot(),
    mcpOauthResults,
    rawErrors: Object.fromEntries(
      Object.entries(results)
        .filter(([, value]) => !value.ok)
        .map(([key, value]) => [key, String(value.error || "").slice(0, 320)]),
    ),
    gaps,
  };
}

function appStatusRequestList(repo) {
  return [
    { key: "account", method: "account/read", params: {} },
    { key: "rateLimits", method: "account/rateLimits/read", params: undefined },
    { key: "mcp", method: "mcpServerStatus/list", params: {} },
    { key: "plugins", method: "plugin/list", params: {} },
    { key: "skills", method: "skills/list", params: { cwds: [repo.path] } },
    { key: "features", method: "experimentalFeature/list", params: {} },
    { key: "permissions", method: "permissionProfile/list", params: {} },
    { key: "provider", method: "modelProvider/capabilities/read", params: {} },
    { key: "appList", method: "app/list", params: {} },
    { key: "config", method: "config/read", params: { includeLayers: false } },
  ];
}

async function computeCodexAppStatus(repo, timeout = 12_000) {
  const results = await codexAppServerBatchRequest(appStatusRequestList(repo), timeout);
  return summarizeAppServerStatus(results);
}

async function readStoredAppStatusCache(repo) {
  const existing = appStatusCacheByRepo.get(repo.id);
  if (existing) return existing;
  try {
    const parsed = JSON.parse(await fs.readFile(codexAppStatusCachePath, "utf8"));
    const item = parsed?.repos?.[repo.id] || parsed?.[repo.id] || null;
    if (item?.data?.ok === true && item.data.source === "app-server" && item.data.authoritative === true) {
      const cached = {
        data: item.data,
        cachedAt: Date.parse(item.cachedAt || item.data.cachedAt || "") || 0,
      };
      appStatusCacheByRepo.set(repo.id, cached);
      return cached;
    }
  } catch {
    // Cache is optional and only stores prior app-server results.
  }
  return null;
}

async function writeStoredAppStatusCache(repo, data) {
  if (data?.ok !== true || data.source !== "app-server" || data.authoritative !== true) return;
  let parsed = { version: 1, repos: {} };
  try {
    const existing = JSON.parse(await fs.readFile(codexAppStatusCachePath, "utf8"));
    parsed = { version: 1, repos: { ...(existing?.repos || {}) } };
  } catch {
    // Create cache on first successful app-server status.
  }
  const cachedAt = new Date().toISOString();
  parsed.repos[repo.id] = {
    cachedAt,
    data: { ...data, cachedAt },
  };
  await atomicWriteJson(codexAppStatusCachePath, parsed);
}

function fastCodexAppStatusFallback(repo, error = "") {
  const appHost = getAppServerClient().status();
  const issue = error ? `云端能力后台同步中: ${String(error).slice(0, 240)}` : null;
  return {
    ok: false,
    source: "app-server-unavailable",
    authoritative: false,
    partial: true,
    account: null,
    rateLimits: null,
    usageLimit: null,
    mcpServers: [],
    plugins: { installed: 0, enabled: 0, available: 0, names: [] },
    skills: { enabled: 0, total: 0, names: [], items: [] },
    features: { enabled: 0, total: 0, names: [] },
    permissionProfiles: [],
    config: {
      model: defaultRuntime.model,
      reasoning: defaultRuntime.reasoning,
      sandbox: defaultRuntime.sandbox,
      approval: defaultRuntime.approval,
      autoCompactTokenLimit: null,
      autoCompactTokenLimitScope: null,
    },
    providerCapabilities: null,
    auth: { ok: Boolean(appHost.running && !appHost.lastError), issue },
    appHost,
    live: appServerLiveSnapshot(),
    accountLogin: accountLoginSnapshot(),
    mcpOauthResults,
    rawErrors: issue ? { status: issue } : {},
    gaps: issue ? [issue] : [],
    repoId: repo?.id || null,
  };
}

function startAppStatusRefresh(repo) {
  if (appStatusRefreshByRepo.has(repo.id)) return appStatusRefreshByRepo.get(repo.id);
  const task = computeCodexAppStatus(repo, 30_000)
    .then((data) => {
      if (data?.ok === true && data.source === "app-server" && data.authoritative === true) {
        appStatusCacheByRepo.set(repo.id, { data, cachedAt: Date.now() });
        writeStoredAppStatusCache(repo, data).catch(() => null);
      }
      return data;
    })
    .catch((error) => {
      const cached = appStatusCacheByRepo.get(repo.id);
      if (cached) return { ...cached.data, refreshing: false, refreshError: error.message || String(error) };
      throw error;
    })
    .finally(() => appStatusRefreshByRepo.delete(repo.id));
  appStatusRefreshByRepo.set(repo.id, task);
  return task;
}

function staleCodexAppStatus(data = {}, error = "") {
  const issue = error ? `云端能力状态刷新超时: ${String(error).slice(0, 240)}` : "云端能力状态正在刷新，当前缓存已过期。";
  return {
    ...data,
    ok: false,
    source: "app-server-stale",
    authoritative: false,
    partial: true,
    refreshing: true,
    refreshError: issue,
    gaps: [...new Set([...(Array.isArray(data.gaps) ? data.gaps : []), issue])],
  };
}

function deadline(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms));
}

async function getCodexAppStatusForRoute(repo) {
  const cached = await readStoredAppStatusCache(repo);
  const age = cached ? Date.now() - cached.cachedAt : Infinity;
  if (cached && age <= appStatusCacheTtlMs) return { data: cached.data, cache: "fresh" };
  const refresh = startAppStatusRefresh(repo);
  if (cached) {
    try {
      const data = await Promise.race([refresh, deadline(appStatusFirstResponseMs)]);
      return { data, cache: "fresh" };
    } catch (error) {
      refresh.catch(() => null);
      return { data: { ...cached.data, refreshing: true }, cache: "stale" };
    }
  }
  try {
    const data = await Promise.race([refresh, deadline(appStatusFirstResponseMs)]);
    return { data, cache: "fresh" };
  } catch (error) {
    refresh.catch(() => null);
    return { data: fastCodexAppStatusFallback(repo, error.message || String(error)), cache: "partial" };
  }
}

function diagnosticCheck(id, label, ok, summary, detail = "", tone = null, meta = {}) {
  const normalizedTone = tone || (ok ? "ok" : "danger");
  return {
    id,
    label,
    ok: Boolean(ok),
    tone: normalizedTone,
    summary: compactSingleLine(summary || (ok ? "ok" : "failed"), 260),
    detail: truncateForUi(stripAnsi(detail || ""), 1200),
    durationMs: Number(meta.durationMs || 0),
  };
}

async function timedDiagnostic(id, label, fn, tone = null) {
  const startedAt = Date.now();
  try {
    const result = await fn();
    return diagnosticCheck(
      id,
      label,
      result.ok !== false,
      result.summary,
      result.detail,
      result.tone || tone,
      { durationMs: Date.now() - startedAt },
    );
  } catch (error) {
    return diagnosticCheck(id, label, false, error.message || "diagnostic failed", "", tone || "danger", { durationMs: Date.now() - startedAt });
  }
}

async function runCodexDiagnostics(repo) {
  const generatedAt = new Date().toISOString();
  const appHost = getAppServerClient().status();
  const checks = [];
  const [codexVersion, codexStatus, schemaCheck, appServerResults, threadList] = await Promise.all([
    timedDiagnostic("codex-version", "Codex CLI", async () => {
      const result = await run("codex", ["--version"], { timeout: 10_000 });
      return {
        ok: result.ok,
        summary: result.ok ? result.stdout || "codex version available" : "无法读取 Codex CLI 版本",
        detail: result.stderr || result.stdout,
      };
    }),
    timedDiagnostic("codex-auth", "Codex 账号", async () => {
      const [status, accountProbe] = await Promise.all([
        getCodexStatus(),
        appServerProbe("account/read", {}, 10_000),
      ]);
      const authProblem = codexAuthProblemFromSources(accountProbe.error, status.detail);
      const effective = codexStatusFromAccountProbe(status, accountProbe, authProblem);
      return {
        ok: effective.authenticated,
        summary: effective.authenticated ? effective.mode : "Codex 登录失效",
        detail: effective.detail,
      };
    }),
    timedDiagnostic("schema-drift", "云端协议 schema", async () => {
      const result = await run("npm", ["run", "codex:schema:check"], { timeout: 90_000 });
      return {
        ok: result.ok,
        summary: result.ok ? "生成 schema 与当前代码一致" : "生成 schema 与当前代码不一致或生成失败",
        detail: [result.stdout, result.stderr].filter(Boolean).join("\n"),
      };
    }),
    timedDiagnostic("app-server-capabilities", "云端能力探测", async () => {
      const results = await codexAppServerBatchRequest(
        [
          { key: "config", method: "config/read", params: { includeLayers: false } },
          { key: "models", method: "model/list", params: { includeHidden: false } },
          { key: "mcp", method: "mcpServerStatus/list", params: {} },
          { key: "plugins", method: "plugin/list", params: {} },
          { key: "skills", method: "skills/list", params: { cwds: [repo.path] } },
          { key: "permissions", method: "permissionProfile/list", params: {} },
          { key: "provider", method: "modelProvider/capabilities/read", params: {} },
        ],
        45_000,
      );
      const failed = Object.entries(results).filter(([, value]) => !value.ok);
      return {
        ok: failed.length === 0,
        tone: failed.length ? "danger" : "ok",
        summary: failed.length
          ? `${failed.length} 个云端能力探测失败`
          : "配置、模型、MCP、插件、Skills、权限和模型能力均可读取",
        detail: failed.length
          ? failed.map(([key, value]) => `${key}: ${value.error}`).join("\n")
          : [
              `模型 ${(results.models.result?.data || []).length} 个`,
              `MCP 服务器 ${(results.mcp.result?.data || []).length} 个`,
              `插件 ${countInstalledPlugins(results.plugins)} 个`,
              `Skills ${groupedSkillsFromEntries(results.skills.result?.data || []).length} 个`,
              `权限配置 ${(results.permissions.result?.data || []).length} 个`,
            ].join(" · "),
      };
    }),
    timedDiagnostic("thread-list", "会话列表事实源", async () => {
      const response = await listAppServerThreads(repo, { limit: 5, useStateDbOnly: true });
      return {
        ok: response.ok,
        summary: response.ok ? `当前项目可读取 ${response.threads.length} 条云端会话` : "无法读取云端会话列表",
        detail: response.ok
          ? response.threads
              .slice(0, 5)
              .map((thread) => `${thread.id || thread.threadId || "会话"} ${thread.title || ""}`.trim())
              .join("\n")
          : response.error,
      };
    }),
  ]);
  checks.push(codexVersion, codexStatus, schemaCheck, appServerResults, threadList);

  const appStatusResults = await codexAppServerBatchRequest(appStatusRequestList(repo));
  const appStatus = summarizeAppServerStatus(appStatusResults);
  const gapChecks = appStatus.gaps.map((gap, index) =>
    diagnosticCheck(`gap-${index + 1}`, "已知能力差异", false, gap, "", gap.includes("Realtime") || gap.includes("App list") ? "warn" : "danger"),
  );
  checks.push(...gapChecks);
  const dangerCount = checks.filter((check) => check.tone === "danger").length;
  const warnCount = checks.filter((check) => check.tone === "warn").length;
  return {
    ok: dangerCount === 0,
    generatedAt,
    repoId: repo.id,
    appHost,
    summary: {
      total: checks.length,
      ok: checks.filter((check) => check.tone === "ok").length,
      warn: warnCount,
      danger: dangerCount,
    },
    checks,
  };
}

function normalizeDiagnosticCheck(check = {}) {
  const id = String(check.id || "").trim();
  if (!id) return null;
  const tone = ["ok", "warn", "danger", "active"].includes(String(check.tone)) ? String(check.tone) : check.ok ? "ok" : "danger";
  const label = sanitizeDiagnosticText(check.label || id, 160);
  return {
    id: id.slice(0, 120),
    label,
    ok: Boolean(check.ok),
    tone,
    summary: sanitizeDiagnosticText(check.summary || "", 260),
    detail: sanitizeDiagnosticText(check.detail || "", 1200),
    durationMs: Number(check.durationMs || 0),
  };
}

function sanitizeDiagnosticText(value = "", maxLength = 900) {
  return sanitizeCloudPathText(value, maxLength)
    .replace(/\bCodex auth\b/gi, "Codex 账号")
    .replace(/\bApp-server schema\b/gi, "云端协议 schema")
    .replace(/\bApp-server capabilities\b/gi, "云端能力探测")
    .replace(/\bKnown app gap\b/gi, "已知能力差异")
    .replace(/\bThread list\/read source\b/gi, "会话列表事实源")
    .replace(/\bapp-server capability probe\b/gi, "云端能力探测")
    .replace(/\bapp-server capabilities\b/gi, "云端能力")
    .replace(/\bapp-server schema\b/gi, "云端协议 schema")
    .replace(/Codex app-server schema is up to date\./gi, "云端协议 schema 已是最新。")
    .replace(/Codex app-server schema is out of date\./gi, "云端协议 schema 已过期。")
    .replace(/Run `npm run codex:schema` to refresh\./gi, "运行 npm run codex:schema 刷新。")
    .replace(/(\d+) 个 app-server capability probe 失败/gi, "$1 个云端能力探测失败")
    .replace(/config\/model\/MCP\/plugin\/skills\/permissions\/provider probes 均通过/gi, "配置、模型、MCP、插件、Skills、权限和模型能力均可读取");
}

function normalizeDiagnosticsSnapshot(value = {}) {
  const generatedAt = value.generatedAt ? String(value.generatedAt) : null;
  if (!generatedAt) return null;
  const checks = Array.isArray(value.checks) ? value.checks.map(normalizeDiagnosticCheck).filter(Boolean) : [];
  const summary = value.summary && typeof value.summary === "object" ? value.summary : {};
  return {
    ok: Boolean(value.ok),
    generatedAt,
    repoId: String(value.repoId || "").slice(0, 120),
    summary: {
      total: Number(summary.total ?? checks.length),
      ok: Number(summary.ok ?? checks.filter((check) => check.tone === "ok").length),
      warn: Number(summary.warn ?? checks.filter((check) => check.tone === "warn").length),
      danger: Number(summary.danger ?? checks.filter((check) => check.tone === "danger").length),
    },
    checks,
  };
}

async function readDiagnosticsState() {
  const parsed = await readJsonState(diagnosticsStatePath, { version: 1, latest: null });
  const latest = normalizeDiagnosticsSnapshot(parsed?.latest || parsed);
  return { version: 1, latest };
}

async function writeDiagnosticsState(store) {
  return enqueueWrite("diagnostics", async () => {
    const latest = normalizeDiagnosticsSnapshot(store?.latest || store);
    await atomicWriteJson(diagnosticsStatePath, { version: 1, latest });
  });
}

function diagnosticsAttentionItems(snapshot = null) {
  const diagnostics = normalizeDiagnosticsSnapshot(snapshot || {});
  if (!diagnostics) {
    return [
      {
        id: "diagnostics:not-run",
        type: "diagnostics",
        tone: "neutral",
        title: "Codex 诊断尚未运行",
        body: "运行一次诊断，确认云端协议 schema、会话事实源和 MCP/插件/Skills 能力没有漂移。",
        time: new Date().toISOString(),
        action: "settings",
      },
    ];
  }
  const items = [];
  const generatedAtMs = new Date(diagnostics.generatedAt).getTime();
  const ageHours = Number.isFinite(generatedAtMs) ? (Date.now() - generatedAtMs) / 36e5 : Infinity;
  const staleHours = Number(process.env.CODEX_DIAGNOSTICS_STALE_HOURS || 24);
  if (ageHours > staleHours) {
    items.push({
      id: "diagnostics:stale",
      type: "diagnostics",
      tone: "neutral",
      title: "Codex 诊断已过期",
      body: `最近一次诊断是 ${diagnostics.generatedAt}，建议重新运行。`,
      time: diagnostics.generatedAt,
      action: "settings",
    });
  }
  for (const check of diagnostics.checks) {
    if (check.ok || check.tone !== "danger" || check.id.startsWith("gap-")) continue;
    items.push({
      id: `diagnostics:${check.id}`,
      type: "diagnostics",
      tone: "danger",
      title: `Codex 诊断失败：${check.label}`,
      body: check.summary,
      time: diagnostics.generatedAt,
      action: "settings",
    });
  }
  return items.slice(0, 6);
}

async function getCodexAppConfig(options = {}) {
  const response = await codexAppServerRequest("config/read", { includeLayers: false }, options.timeout || 20_000);
  if (!response.ok) return { ok: false, error: response.error, config: {} };
  const config = response.result?.config || {};
  return {
    ok: true,
    config: {
      modelContextWindow: Number(config.model_context_window || 0) || null,
      autoCompactTokenLimit: Number(config.model_auto_compact_token_limit || 0) || null,
      autoCompactTokenLimitScope: config.model_auto_compact_token_limit_scope || null,
      compactPrompt: config.compact_prompt || null,
    },
  };
}

async function writeCodexConfigValue(keyPath, value) {
  return codexAppServerRequest("config/value/write", { keyPath, value, mergeStrategy: "upsert" }, 20_000);
}

async function computeThreadState(session, options = {}) {
  const timeout = options.timeout || appServerReadTimeoutMs;
  const configPromise = getCodexAppConfig({ timeout }).catch((error) => ({ ok: false, error: error.message, config: {} }));
  if (!session.codexSessionId) {
    const config = await configPromise;
    return {
      ok: true,
      source: "draft",
      authoritative: false,
      partial: true,
      goal: session.goal || null,
      tokenUsage: session.tokenUsage || null,
      config: config.config,
      threadId: null,
      runtime: normalizeRuntime({}, session),
    };
  }
  const repo = getRepoById(session.repoId);
  const [config, refreshedSession, goalResponse, threadResponse] = await Promise.all([
    configPromise,
    refreshSessionRuntimeFromAppServer(repo, session, { timeout }).catch(() => session),
    codexAppServerRequest("thread/goal/get", { threadId: session.codexSessionId }, timeout),
    codexAppServerRequest("thread/read", { threadId: session.codexSessionId, includeTurns: false }, timeout),
  ]);
  const goal = goalResponse.ok ? goalResponse.result?.goal || null : refreshedSession.goal || null;
  const tokenUsage = threadResponse.ok
    ? normalizeTokenUsage(threadResponse.result?.thread?.tokenUsage || threadResponse.result?.thread?.token_usage || refreshedSession.tokenUsage)
    : normalizeTokenUsage(refreshedSession.tokenUsage);
  const authoritative = Boolean(config.ok && goalResponse.ok && threadResponse.ok);
  return {
    ok: Boolean(threadResponse.ok),
    source: authoritative ? "app-server" : "app-server-partial",
    authoritative,
    partial: !authoritative,
    error: threadResponse.ok ? null : threadResponse.error || goalResponse.error || config.error,
    goal,
    tokenUsage,
    config: config.config,
    threadId: session.codexSessionId,
    runtime: normalizeRuntime({}, refreshedSession),
  };
}

function threadStateCacheKey(session = {}) {
  return `${session.repoId || "repo"}:${session.id || "session"}:${session.codexSessionId || "draft"}`;
}

function cachedConfigForThreadState(session = {}) {
  const cachedAppStatus = appStatusCacheByRepo.get(session.repoId || "");
  const config = cachedAppStatus?.data?.config || {};
  return {
    modelContextWindow: Number(config.modelContextWindow || 0) || null,
    autoCompactTokenLimit: Number(config.autoCompactTokenLimit || 0) || null,
    autoCompactTokenLimitScope: config.autoCompactTokenLimitScope || null,
    compactPrompt: null,
  };
}

function fastThreadStateFallback(session = {}, error = "") {
  return {
    ok: false,
    source: "app-server-unavailable",
    authoritative: false,
    error: error ? String(error).slice(0, 320) : null,
    goal: session.goal || null,
    tokenUsage: normalizeTokenUsage(session.tokenUsage),
    config: cachedConfigForThreadState(session),
    threadId: session.codexSessionId || null,
    runtime: normalizeRuntime({}, session),
    partial: true,
  };
}

function authoritativeEmptyThreadState(repoId) {
  return {
    ok: true,
    source: "app-server",
    authoritative: true,
    error: null,
    goal: null,
    tokenUsage: null,
    config: cachedConfigForThreadState({ repoId }),
    threadId: null,
    runtime: normalizeRuntime({}, {}),
    partial: false,
  };
}

function staleThreadState(data = {}, error = "") {
  return {
    ...data,
    ok: false,
    source: "app-server-stale",
    authoritative: false,
    partial: true,
    refreshing: true,
    refreshError: error ? String(error).slice(0, 320) : "thread state cache is stale",
  };
}

function patchThreadStateCache(session = {}, patch = {}) {
  const key = threadStateCacheKey(session);
  threadStateRevisionByKey.set(key, (threadStateRevisionByKey.get(key) || 0) + 1);
  const cached = threadStateCacheByKey.get(key);
  const base = cached?.data || fastThreadStateFallback(session);
  threadStateCacheByKey.set(key, {
    cachedAt: Date.now(),
    data: {
      ...base,
      ...patch,
      source: "app-server",
      authoritative: true,
      partial: false,
      cached: true,
      refreshing: false,
      threadId: session.codexSessionId || base.threadId || null,
      runtime: patch.runtime || base.runtime || normalizeRuntime({}, session),
    },
  });
}

function startThreadStateRefresh(session, options = {}) {
  const key = threadStateCacheKey(session);
  if (threadStateRefreshByKey.has(key)) return threadStateRefreshByKey.get(key);
  const revision = threadStateRevisionByKey.get(key) || 0;
  const task = computeThreadState(session, options)
    .then((data) => {
      if ((threadStateRevisionByKey.get(key) || 0) === revision) {
        threadStateCacheByKey.set(key, { data, cachedAt: Date.now() });
      }
      return data;
    })
    .catch((error) => {
      const cached = threadStateCacheByKey.get(key);
      if (cached) return { ...cached.data, refreshing: false, refreshError: error.message || String(error) };
      throw error;
    })
    .finally(() => threadStateRefreshByKey.delete(key));
  threadStateRefreshByKey.set(key, task);
  return task;
}

async function getThreadState(session, options = {}) {
  if (options.force) return computeThreadState(session, options);
  const key = threadStateCacheKey(session);
  const cached = threadStateCacheByKey.get(key);
  const age = cached ? Date.now() - cached.cachedAt : Infinity;
  if (cached && age <= threadStateCacheTtlMs) return { ...cached.data, cached: true };
  const refresh = startThreadStateRefresh(session, options);
  if (cached) {
    try {
      return await Promise.race([refresh, deadline(threadStateFirstResponseMs)]);
    } catch (error) {
      refresh.catch(() => null);
      return staleThreadState({ ...cached.data, cached: true }, error.message || String(error));
    }
  }
  try {
    return await Promise.race([refresh, deadline(threadStateFirstResponseMs)]);
  } catch (error) {
    refresh.catch(() => null);
    return fastThreadStateFallback(session, error.message || String(error));
  }
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function compactLines(text, max = 120) {
  return String(text || "")
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-max);
}

async function getRepo(repo) {
  const present = await exists(repo.path);
  if (!present) {
    return {
      ...repo,
      present: false,
      branch: "main",
      commit: "unavailable",
      dirty: false,
      statusText: "repository path unavailable",
      lastCommit: "Repository path unavailable",
      source: "repository-unavailable",
    };
  }

  const [branch, commit, status, lastCommit] = await Promise.all([
    run("git", ["-C", repo.path, "branch", "--show-current"]),
    run("git", ["-C", repo.path, "rev-parse", "--short", "HEAD"]),
    run("git", ["-C", repo.path, "status", "--short", "--branch"]),
    run("git", ["-C", repo.path, "log", "-1", "--pretty=%s"]),
  ]);

  return {
    ...repo,
    present: true,
    branch: branch.stdout || "main",
    commit: commit.stdout || "unknown",
    dirty: compactLines(status.stdout).some((line) => !line.startsWith("##")),
    statusText: compactLines(status.stdout || "clean", 8).join("\n"),
    lastCommit: lastCommit.stdout || "No commits",
  };
}

function parseTimerLines(stdout) {
  const lines = compactLines(stdout);
  return automations.map((automation) => {
    const line = lines.find((item) => item.includes(automation.timer));
    const next = line?.match(/^(.+?)\s{2,}/)?.[1]?.trim();
    const enabled = Boolean(line);
    return {
      ...automation,
      enabled,
      nextRun: next ? normalizeHumanDateTime(next) : automation.schedule,
      lastRun: line?.includes(" - ") ? "尚未运行" : "最近一次已记录",
      run: defaultRunDetail(automation),
    };
  });
}

function defaultRunDetail(automation) {
  return {
    activeState: "inactive",
    failedState: "inactive",
    exitCode: "0",
    logName: `${automation.id}-latest.log`,
    logUpdatedAt: new Date().toISOString(),
    logTail: ["云端拉取完成", "定时器等待下一次运行"],
  };
}

function automationRunId(automationId) {
  return `run-${automationId}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
}

function normalizeAutomationRun(run = {}) {
  const startedAt = run.startedAt ? String(run.startedAt) : new Date().toISOString();
  return {
    id: String(run.id || automationRunId(String(run.automationId || "automation"))),
    automationId: String(run.automationId || ""),
    repoId: String(run.repoId || ""),
    name: String(run.name || run.automationId || "Automation run"),
    trigger: String(run.trigger || "manual"),
    runner: String(run.runner || "systemd"),
    status: String(run.status || "queued"),
    startedAt,
    updatedAt: String(run.updatedAt || startedAt),
    finishedAt: run.finishedAt ? String(run.finishedAt) : null,
    threadId: run.threadId ? String(run.threadId) : null,
    sessionId: run.sessionId ? String(run.sessionId) : null,
    worktreePath: run.worktreePath ? String(run.worktreePath) : null,
    worktreePolicy: String(run.worktreePolicy || "none"),
    model: run.model ? String(run.model) : null,
    reasoning: run.reasoning ? String(run.reasoning) : null,
    prompt: run.prompt ? String(run.prompt) : "",
    summary: run.summary ? String(run.summary).slice(0, 4000) : "",
    diffStat: run.diffStat ? String(run.diffStat).slice(0, 4000) : "",
    error: run.error ? String(run.error).slice(0, 2000) : null,
    events: Array.isArray(run.events)
      ? run.events.slice(-80).map((event) => ({
          time: String(event.time || new Date().toISOString()),
          type: String(event.type || "status"),
          text: String(event.text || "").slice(0, 1200),
        }))
      : [],
  };
}

async function readAutomationRuns() {
  const parsed = await readJsonState(automationRunsPath, { version: 1, runs: [] });
  const runs = Array.isArray(parsed?.runs) ? parsed.runs.map(normalizeAutomationRun) : [];
  return { version: 1, runs };
}

async function writeAutomationRuns(store) {
  return enqueueWrite("automation", async () => {
    const current = await readAutomationRuns();
    const byId = new Map((current.runs || []).map((run) => [run.id, run]));
    for (const incoming of store.runs || []) {
      const normalized = normalizeAutomationRun(incoming);
      const existing = byId.get(normalized.id);
      if (!existing) {
        byId.set(normalized.id, normalized);
        continue;
      }
      const seen = new Set();
      const events = [...(existing.events || []), ...(normalized.events || [])].filter((event) => {
        const key = `${event.time}|${event.type}|${event.text}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).slice(-80);
      byId.set(normalized.id, normalizeAutomationRun({ ...existing, ...normalized, events }));
    }
    const runs = [...byId.values()].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)).slice(0, 200);
    await atomicWriteJson(automationRunsPath, { version: 1, runs });
  });
}

async function upsertAutomationRun(run, event = null) {
  const store = await readAutomationRuns();
  const normalized = normalizeAutomationRun({
    ...run,
    updatedAt: new Date().toISOString(),
    events: event ? [...(run.events || []), event] : run.events,
  });
  const index = store.runs.findIndex((item) => item.id === normalized.id);
  if (index >= 0) store.runs[index] = { ...store.runs[index], ...normalized };
  else store.runs.unshift(normalized);
  store.runs.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  await writeAutomationRuns(store);
  return normalized;
}

async function appendAutomationRunEvent(runId, patch = {}, event = null) {
  const store = await readAutomationRuns();
  const current = store.runs.find((item) => item.id === runId);
  if (!current) return null;
  const next = normalizeAutomationRun({
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
    events: event ? [...(current.events || []), event] : current.events,
  });
  const index = store.runs.findIndex((item) => item.id === runId);
  store.runs[index] = next;
  await writeAutomationRuns(store);
  return next;
}

async function reconcileStaleAutomationRuns(reason = "Console restarted while app-server automation was running") {
  const store = await readAutomationRuns();
  const staleRuns = store.runs.filter(
    (run) => run.runner === "app-server" && ["queued", "running"].includes(run.status) && !activeAutomationRuns.has(run.id),
  );
  for (const runRecord of staleRuns) {
    await appendAutomationRunEvent(
      runRecord.id,
      {
        status: "interrupted",
        finishedAt: new Date().toISOString(),
        error: null,
        summary: reason,
      },
      { type: "interrupted", text: reason },
    );
  }
  if (staleRuns.length > 0) {
    appendAuditEvent({
      source: "automation",
      type: "automation-reconcile",
      summary: `Marked ${staleRuns.length} stale app-server automation run(s) as interrupted`,
      detail: jsonDetail({ runIds: staleRuns.map((runRecord) => runRecord.id), reason }),
    }).catch(() => null);
  }
  return staleRuns.length;
}

async function createAutomationWorktree(repo, runId) {
  await fs.mkdir(worktreesRoot, { recursive: true });
  const target = path.join(worktreesRoot, runId);
  const result = await run("git", ["-C", repo.path, "worktree", "add", "--detach", target, "HEAD"], { timeout: 120_000 });
  if (!result.ok) throw new Error(result.stderr || result.stdout || "git worktree add failed");
  return target;
}

async function diffStatForPath(cwd) {
  if (!cwd) return "";
  const result = await run("git", ["-C", cwd, "diff", "--stat"], { timeout: 30_000 });
  return result.stdout || result.stderr || "";
}

function usageLimitStillActionable(usageLimit = null) {
  if (!usageLimit) return false;
  if (!usageLimit.retryAtMs) return true;
  return Number(usageLimit.retryAtMs) > Date.now() + 60_000;
}

function automationRunUsageLimitFromRun(run = {}, auditEvents = []) {
  return automationRunUsageLimit(run, auditEvents);
}

function automationRunHasOnlyExpiredUsageLimit(run = {}, auditEvents = []) {
  const text = [run.error, run.summary, ...(Array.isArray(run.events) ? run.events.map((event) => event?.text || "") : [])]
    .filter(Boolean)
    .join("\n");
  if (text.includes(expiredUsageLimitHistoryText())) return true;
  const usageLimit = automationRunUsageLimitFromRun(run, auditEvents);
  return Boolean(usageLimit && !usageLimitStillActionable(usageLimit));
}

function automationRunInterruptedByConsoleRestart(run = {}) {
  const text = [run.error, run.summary, ...(Array.isArray(run.events) ? run.events.map((event) => event?.text || "") : [])]
    .filter(Boolean)
    .join("\n");
  return text.includes(interruptedAutomationArchiveText) || /控制台重启时云端自动化仍在运行|Console restarted while .*automation was running/i.test(text);
}

function isStaleAutomationFailure(run = {}) {
  const maxAgeHours = Number.isFinite(automationAttentionMaxAgeHours) ? automationAttentionMaxAgeHours : 72;
  if (maxAgeHours <= 0) return false;
  if (["queued", "running", "archived"].includes(String(run.status || ""))) return false;
  if (!(run.status === "failed" || run.error || run.diffStat)) return false;
  const time = new Date(automationRunAttentionTime(run)).getTime();
  if (!Number.isFinite(time)) return false;
  return Date.now() - time > maxAgeHours * 60 * 60 * 1000;
}

function automationRunSortTimeMs(run = {}) {
  const time = new Date(automationRunAttentionTime(run)).getTime();
  return Number.isFinite(time) ? time : 0;
}

function successfulAutomationRun(run = {}) {
  if (String(run.status || "") !== "completed") return false;
  if (run.error || run.diffStat) return false;
  return true;
}

function supersededAutomationFailure(run = {}, latestSuccessByAutomation = new Map()) {
  if (["queued", "running", "archived"].includes(String(run.status || ""))) return false;
  if (!(run.status === "failed" || run.error || run.diffStat)) return false;
  const key = `${run.repoId || ""}:${run.automationId || ""}`;
  const latestSuccessMs = latestSuccessByAutomation.get(key) || 0;
  return latestSuccessMs > automationRunSortTimeMs(run);
}

function automationInboxBuckets(runs, auditEvents = []) {
  const active = [];
  const needsAttention = [];
  const recent = [];
  const archived = [];
  const latestSuccessByAutomation = new Map();
  for (const run of runs) {
    if (!successfulAutomationRun(run)) continue;
    const key = `${run.repoId || ""}:${run.automationId || ""}`;
    latestSuccessByAutomation.set(key, Math.max(latestSuccessByAutomation.get(key) || 0, automationRunSortTimeMs(run)));
  }
  for (const run of runs) {
    if (run.status === "archived") archived.push(run);
    else if (["queued", "running"].includes(run.status)) active.push(run);
    else if (
      automationRunInterruptedByConsoleRestart(run) ||
      automationRunHasOnlyExpiredUsageLimit(run, auditEvents) ||
      supersededAutomationFailure(run, latestSuccessByAutomation) ||
      isStaleAutomationFailure(run)
    )
      archived.push(run);
    else if (run.status === "failed" || run.error || run.diffStat) needsAttention.push(run);
    else recent.push(run);
  }
  return { needsAttention, active, recent: recent.slice(0, 20), archived: archived.slice(0, 20) };
}

function isNoisyAuditAttentionEvent(event = {}) {
  const type = String(event.type || "");
  const summary = String(event.summary || "");
  const detail = String(event.detail || "");
  const text = `${type}\n${summary}\n${detail}`;
  if (/Skill descriptions were shortened to fit the 2% skills context budget/i.test(text)) return true;
  if (/^(?:Codex app-server|云端 Codex) exited (?:\(SIGTERM\)|with code 0)$/i.test(summary)) return true;
  if (/^mcp-startup$/i.test(type) && /not logged in|需要登录|登录失效/i.test(text)) return true;
  if (/^shell (completed|failed):/i.test(summary) || /^shell:/i.test(summary)) {
    return !codexUsageLimitFromSources(summary, detail);
  }
  return false;
}

function isAttentionAuditEvent(event = {}) {
  const type = String(event.type || "");
  const summary = String(event.summary || "");
  if (/^account-login-/i.test(type)) return false;
  if (isNoisyAuditAttentionEvent(event)) return false;
  if (/approval|elicitation|request/i.test(`${type} ${summary}`)) return true;
  if (/^(shell|file-edit|network|tool|mcp)$/i.test(type)) return false;
  if (/error|failed|warning/i.test(type)) return true;
  return /(^|\s)(failed|failure):/i.test(summary);
}

function buildCapabilityWarnings({ mcpProbeResult = null, appHost = null } = {}) {
  const warnings = [];
  const now = new Date().toISOString();
  if (mcpProbeResult?.ok) {
    const servers = Array.isArray(mcpProbeResult.result?.data) ? mcpProbeResult.result.data : [];
    for (const server of servers) {
      const name = String(server.name || server.id || "MCP");
      const authStatus = String(server.authStatus || server.auth_status || server.status || "");
      if (mcpAuthNeedsLogin(authStatus)) {
        warnings.push({
          id: `mcp-auth:${name}`,
          type: "mcp",
          tone: "active",
          title: `${name} MCP 需要登录`,
          body: mcpAuthStatusSummary(authStatus),
          time: now,
          action: "mcp-login",
          serverName: name,
        });
      }
    }
  } else if (mcpProbeResult && !mcpProbeResult.ok) {
    warnings.push({
      id: "mcp-status:unavailable",
      type: "mcp",
      tone: "active",
      title: "MCP 状态暂不可用",
      body: compactSingleLine(mcpProbeResult.error || "mcpServerStatus/list failed", 260),
      time: now,
      action: "logs",
    });
  }

  const stderr = stripCodexAuthProblemText((appHost?.stderrTail || []).join("\n"));
  if (/AuthRequired|OAuth|mcp\.|cloudflare|invalid_token/i.test(stderr) && !warnings.some((item) => item.id.startsWith("mcp-auth:"))) {
    warnings.push({
      id: "mcp-auth:stderr",
      type: "mcp",
      tone: "active",
      title: "MCP OAuth 需要处理",
      body: "app-server host 报告 MCP OAuth token 无效，请在设置或 /mcp 中重新登录。",
      time: now,
      action: "settings",
    });
  }
  return warnings.slice(0, 8);
}

function codexAuthProblemFromSources(...sources) {
  const text = sources.flat().filter(Boolean).map(String).join("\n");
  if (!text) return "";
  if (
    /token_invalidated/i.test(text) ||
    /authentication token has been invalidated/i.test(text) ||
    /access token could not be refreshed/i.test(text) ||
    /refresh token was already used/i.test(text) ||
    /Please log out and sign in again/i.test(text)
  ) {
    return "Codex ChatGPT 登录已失效，需要在云端重新登录 Codex。";
  }
  return "";
}

function mcpAuthNeedsLogin(authStatus = "") {
  const normalized = String(authStatus || "").trim().replace(/[\s_-]+/g, "").toLowerCase();
  return ["notloggedin", "authrequired", "requiresoauth", "oauthrequired", "expired", "invalidtoken", "tokeninvalidated"].includes(normalized);
}

function mcpAuthStatusSummary(authStatus = "") {
  const normalized = String(authStatus || "").trim().replace(/[\s_-]+/g, "").toLowerCase();
  if (!normalized) return "未知状态";
  if (normalized === "notloggedin") return "未登录";
  if (["authrequired", "requiresoauth", "oauthrequired"].includes(normalized)) return "需要登录";
  if (["expired", "invalidtoken", "tokeninvalidated"].includes(normalized)) return "登录失效";
  if (normalized === "bearertoken") return "令牌已配置";
  if (normalized === "unsupported") return "不支持登录";
  return compactSingleLine(authStatus, 120);
}

function semanticLogLine(value = "", referenceTime = new Date()) {
  const text = compactSingleLine(value, 420);
  if (!text) return "";
  const referenceDate = referenceTime instanceof Date ? referenceTime : new Date(referenceTime || Date.now());
  const usageLimit = codexUsageLimitFromText(text, referenceDate);
  if (usageLimit) return usageLimit.retryAtExpired ? expiredUsageLimitHistoryText() : usageLimit.body;
  const done = text.match(/^\[[^\]]+\]\s+event=done\s+([\s\S]+)$/i);
  if (done?.[1]) {
    const message = done[1].trim();
    const doneUsageLimit = codexUsageLimitFromText(message, referenceDate);
    if (doneUsageLimit) return `运行完成：${doneUsageLimit.retryAtExpired ? expiredUsageLimitHistoryText() : doneUsageLimit.body}`;
    if (/Automation completed/i.test(message)) return "运行完成：自动化已完成";
    if (/Automation failed/i.test(message)) return "运行完成：自动化失败";
    return `运行完成：${message}`;
  }
  const finished = text.match(/^\[[^\]]+\]\s+finished(?:\s+job=[^\s]+)?\s+status=([A-Za-z_-]+)/i);
  if (finished?.[1]) {
    const status = finished[1].toLowerCase();
    const label = status === "completed" || status === "success" ? "已完成" : status === "failed" ? "失败" : status === "running" ? "运行中" : finished[1];
    return `运行结束：${label}`;
  }
  const error = text.match(/^\[[^\]]+\]\s+error(?:\[[^\]]+\])?=([\s\S]+)$/i);
  if (error?.[1]) {
    if (/Unknown automation/i.test(error[1])) return "错误：自动化任务不存在或已被移除";
    if (/fetch failed/i.test(error[1])) return "错误：网络请求失败";
    return `错误：${compactSingleLine(error[1], 260)}`;
  }
  if (/^Unknown automation$/i.test(text)) return "自动化任务不存在或已被移除";
  if (/^Automation completed$/i.test(text)) return "自动化已完成";
  if (/^Automation failed$/i.test(text)) return "自动化失败";
  if (/^codex exec completed$/i.test(text)) return "Codex 运行已完成";
  if (/^Timer waiting for next run$/i.test(text)) return "定时器等待下一次运行";
  if (/^CLOUD_PULL_DONE$/i.test(text)) return "云端拉取完成";
  if (/^No log file found for this automation\.?$/i.test(text)) return "暂无自动化日志";
  return text;
}

function semanticLogTail(lines = [], referenceTime = new Date()) {
  return lines.map((line) => semanticLogLine(line, referenceTime)).filter(Boolean);
}

function isCodexUsageLimitText(value = "") {
  return /usageLimitExceeded|usage limit|purchase more credits|rateLimitReachedType|rate limit reached|Codex 额度已达上限|额度已达上限/i.test(String(value || ""));
}

function codexUsageLimitFromText(text, referenceDate = new Date()) {
  if (!isCodexUsageLimitText(text)) return null;
  const reference = referenceDate instanceof Date && Number.isFinite(referenceDate.getTime()) ? referenceDate : new Date();
  const now = Date.now();
  const retryAtText =
    text.match(/try again at ([^."\n]+)/i)?.[1]?.trim() ||
    text.match(/可在\s*([^。]+?)\s*后重试/)?.[1]?.trim() ||
    null;
  const retryAtLabel = retryAtText ? normalizeHumanDateTime(retryAtText, reference) : null;
  const retryAtMs = retryAtLabel ? parseNormalizedHumanDateTimeMs(retryAtLabel, reference) : null;
  const retryAtExpired = Boolean(retryAtMs && retryAtMs <= now + 60_000);
  const message =
    text.match(/message:\s*"([^"]+)"/i)?.[1] ||
    text.match(/You've hit your usage limit[^"\n]*/i)?.[0] ||
    text.match(/usage limit[^.\n]*/i)?.[0] ||
    "Codex usage limit reached.";
  const body = retryAtLabel
    ? `Codex 额度已达上限，可在 ${retryAtLabel} 后重试。`
    : "Codex 额度已达上限。请稍后重试，或打开额度设置查看可用额度。";
  const code =
    text.match(/codexErrorInfo:\s*['"]?([A-Za-z0-9_-]+)/i)?.[1] ||
    text.match(/rateLimitReachedType["']?\s*[:=]\s*['"]?([A-Za-z0-9_-]+)/i)?.[1] ||
    "usageLimitExceeded";
  return {
    code,
    message: body,
    rawMessage: compactSingleLine(message, 320),
    retryAtText: retryAtLabel,
    retryAtMs,
    retryAtExpired,
    title: "Codex 额度已达上限",
    body,
  };
}

function codexUsageLimitFromSources(...sources) {
  const text = sources.flat().filter(Boolean).map(String).join("\n");
  return codexUsageLimitFromText(text, new Date());
}

function stripCodexAuthProblemText(text = "") {
  return String(text)
    .split(/\r?\n/)
    .filter((line) => !codexAuthProblemFromSources(line))
    .join("\n");
}

function runAttentionError(run = {}, auditEvents = []) {
  const direct = String(run.error || "").trim();
  if (/^Preparing (?:隔离工作区|worktree) \(detached HEAD\b/i.test(direct)) {
    return "隔离工作区准备未完成，请查看任务日志后重试。";
  }
  if (/^Reconnecting\.\.\.\s*\d+\/\d+/i.test(direct)) {
    return "云端 Codex 连接中断，重连未完成；请打开对话查看详情或重新运行。";
  }
  if (direct && !isGenericAppServerErrorText(direct)) return sanitizeStatusText(direct, 520);
  const audit = auditEvents.find(
    (event) =>
      run.threadId &&
      event.threadId === run.threadId &&
      /error|failed|warning/i.test(`${event.type || ""} ${event.summary || ""}`),
  );
  if (audit?.summary && !isGenericAppServerErrorText(audit.summary)) return sanitizeStatusText(audit.summary, 520);
  const eventText = Array.isArray(run.events) ? run.events.map((event) => event?.text || event?.type || "").join("\n") : "";
  if (/systemError/i.test(eventText)) return "云端 Codex 会话进入 systemError，请打开对话查看详情或重新运行。";
  if (direct && isGenericAppServerErrorText(direct)) return "云端 Codex 运行失败，请打开对话查看详情或重新运行。";
  return sanitizeStatusText(direct, 520);
}

function automationRunAttentionText(run = {}, auditEvents = []) {
  const eventText = Array.isArray(run.events) ? run.events.map((event) => event?.text || event?.type || "").join("\n") : "";
  const auditText = auditEvents
    .filter((event) => run.threadId && event.threadId === run.threadId)
    .slice(0, 12)
    .map((event) => `${event.type || ""} ${event.summary || ""} ${event.detail || ""}`)
    .join("\n");
  return [
    run.error,
    run.summary,
    run.diffStat,
    run.status,
    runAttentionError(run, auditEvents),
    eventText,
    auditText,
  ]
    .filter(Boolean)
    .join("\n");
}

function automationRunUsageLimit(run = {}, auditEvents = []) {
  const referenceTime = new Date(automationRunAttentionTime(run));
  return codexUsageLimitFromText(automationRunAttentionText(run, auditEvents), referenceTime);
}

function automationRunAttentionTime(run = {}) {
  return run.updatedAt || run.finishedAt || run.startedAt || new Date(0).toISOString();
}

function enrichAutomationRunForStatus(run = {}, auditEvents = []) {
  const status = String(run.status || "");
  const direct = String(run.error || "").trim();
  if (!direct && !["failed", "interrupted", "running", "queued"].includes(status)) return run;
  const normalizedError = runAttentionError(run, auditEvents);
  if (!normalizedError || normalizedError === run.error) return run;
  return {
    ...run,
    error: normalizedError,
    events: Array.isArray(run.events)
      ? run.events.map((event) =>
          isGenericAppServerErrorText(event?.text || "") ? { ...event, text: normalizedError } : event,
        )
      : [],
  };
}

function usageLimitAttentionItem(usageLimit, overrides = {}) {
  return {
    id: overrides.id || "account:usage-limit",
    type: "account",
    tone: "danger",
    title: usageLimit?.title || "Codex 额度已达上限",
    body: compactSingleLine(
      usageLimit?.body || usageLimit?.message || "Codex 额度已达上限。请稍后重试，或打开额度设置查看可用额度。",
      420,
    ),
    time: overrides.time || new Date().toISOString(),
    action: overrides.action || "external",
    actionUrl: overrides.actionUrl || "https://chatgpt.com/codex/settings/usage",
    actionLabel: overrides.actionLabel || "打开额度设置",
    repoId: overrides.repoId || null,
    sessionId: overrides.sessionId || null,
    threadId: overrides.threadId || null,
    itemId: overrides.itemId || null,
  };
}

function summarizeJobEvent(payload = {}) {
  const data = payload.data && typeof payload.data === "object" ? payload.data : {};
  const text =
    data.text ||
    data.message ||
    data.error ||
    data.status ||
    data.output ||
    payload.event ||
    "";
  return {
    id: payload.id || null,
    event: String(payload.event || "event"),
    time: payload.time || new Date().toISOString(),
    text: semanticJobStatusText(text),
  };
}

function activeJobTitle(job = {}) {
  if (job.kind === "compact") return "Codex 正在压缩上下文";
  if (job.storedMessage && String(job.storedMessage).startsWith("/review")) return "Codex 正在执行 review";
  return "Codex 正在运行 turn";
}

function summarizeActiveJob(job = {}, { includeEvents = false } = {}) {
  const events = Array.isArray(job.events) ? job.events.map(summarizeJobEvent) : [];
  const latestEvent = [...events].reverse().find((event) => event.text) || null;
  const message = compactSingleLine(job.storedMessage || job.message || "", 240);
  const body =
    latestEvent?.text ||
    (job.kind === "compact" ? "正在生成压缩摘要..." : message || "云端 Codex 正在运行...");
  const runtime = job.runtime || {};
  return {
    id: job.id,
    kind: job.kind,
    status: job.completed ? (job.ok ? "completed" : "failed") : "running",
    title: activeJobTitle(job),
    body: compactSingleLine(body, 360),
    repoId: job.repoId || null,
    sessionId: job.sessionId || null,
    threadId: job.threadId || null,
    turnId: job.turnId || null,
    startedAt: job.startedAt || new Date().toISOString(),
    message,
    runtime: {
      model: runtime.model || null,
      reasoning: runtime.reasoning || null,
      sandbox: runtime.sandbox || null,
      approval: runtime.approval || null,
      search: typeof runtime.search === "boolean" ? runtime.search : null,
    },
    completed: Boolean(job.completed),
    ok: job.ok,
    error: job.error ? compactSingleLine(job.error, 360) : null,
    latestEvent,
    eventCount: events.length,
    ...(includeEvents ? { events: events.slice(-16) } : {}),
  };
}

function activeJobSummaries(options = {}) {
  return [...activeTurns.values(), ...activeCompactions.values()]
    .filter((job) => job && !job.completed)
    .map((job) => summarizeActiveJob(job, options))
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
}

function activeJobAttentionItems(activeJobs = [], automationRuns = []) {
  const runningRuns = automationRuns.filter((run) => ["queued", "running"].includes(String(run.status || "")));
  const automationThreadIds = new Set(runningRuns.map((run) => run.threadId).filter(Boolean));
  const automationSessionKeys = new Set(
    runningRuns
      .filter((run) => run.repoId && run.sessionId)
      .map((run) => `${run.repoId}:${run.sessionId}`),
  );
  return activeJobs
    .filter((job) => job.status === "running" && !job.completed)
    .filter((job) => {
      if (job.threadId && automationThreadIds.has(job.threadId)) return false;
      if (job.repoId && job.sessionId && automationSessionKeys.has(`${job.repoId}:${job.sessionId}`)) return false;
      return true;
    })
    .slice(0, 8)
    .map((job) => ({
      id: `job:${job.id}`,
      type: "job",
      tone: "active",
      title: job.title,
      body: job.body,
      time: job.startedAt,
      repoId: job.repoId,
      sessionId: job.sessionId,
      threadId: job.threadId,
      action: job.repoId && (job.threadId || job.sessionId) ? "thread" : "logs",
    }));
}

function buildAttentionSummary({ repoStatus = [], runs = [], auditEvents = [], codexStatus = {}, capabilityWarnings = [], diagnosticWarnings = [], usageLimit = null, activeJobs = [] }) {
  const inbox = automationInboxBuckets(runs, auditEvents);
  const auditIssues = auditEvents.filter(isAttentionAuditEvent);
  const dirtyRepos = repoStatus.filter((repo) => repo.dirty);
  const automationAttentionRuns = [...inbox.needsAttention, ...inbox.active].slice(0, 12);
  const usageLimitedAutomationRuns = [];
  const regularAutomationAttentionRuns = [];
  for (const run of automationAttentionRuns) {
    const runUsageLimit = automationRunUsageLimit(run, auditEvents);
    const isActiveRun = ["queued", "running"].includes(String(run.status || ""));
    if (runUsageLimit && !isActiveRun) {
      if (usageLimitStillActionable(runUsageLimit)) usageLimitedAutomationRuns.push({ run, usageLimit: runUsageLimit });
    } else {
      regularAutomationAttentionRuns.push(run);
    }
  }
  const activeJobItems = activeJobAttentionItems(activeJobs, automationAttentionRuns);
  const automationThreadIds = new Set(automationAttentionRuns.map((run) => run.threadId).filter(Boolean));
  const automationErrorSummaries = new Set(
    automationAttentionRuns
      .map((run) => runAttentionError(run, auditEvents))
      .filter((summary) => summary && !isGenericAppServerErrorText(summary)),
  );
  const items = [];
  let hasUsageLimitItem = false;
  if (usageLimit) {
    items.push(usageLimitAttentionItem(usageLimit));
    hasUsageLimitItem = true;
  }
  if (!codexStatus.authenticated) {
    items.push({
      id: "auth:codex",
      type: "auth",
      tone: "danger",
      title: "Codex 未登录",
      body: codexStatus.detail || "云端 Codex 需要重新登录。",
      time: new Date().toISOString(),
      action: "codex-login",
    });
  }
  for (const warning of capabilityWarnings.slice(0, 8)) {
    items.push({
      id: String(warning.id || `capability:${warning.title}`),
      type: String(warning.type || "capability"),
      tone: warning.tone || "active",
      title: compactAuditSummary(warning.title || "能力需要处理").slice(0, 180),
      body: compactSingleLine(warning.body || "", 360),
      time: warning.time || new Date().toISOString(),
      action: warning.action || "settings",
      serverName: warning.serverName || null,
    });
  }
  for (const warning of diagnosticWarnings.slice(0, 6)) {
    items.push({
      id: String(warning.id || `diagnostics:${warning.title}`),
      type: "diagnostics",
      tone: warning.tone || "danger",
      title: compactAuditSummary(warning.title || "Codex 诊断需要处理").slice(0, 180),
      body: compactSingleLine(warning.body || "", 360),
      time: warning.time || new Date().toISOString(),
      action: warning.action || "settings",
    });
  }
  items.push(...activeJobItems);
  if (usageLimitedAutomationRuns.length && !hasUsageLimitItem) {
    const latest = [...usageLimitedAutomationRuns].sort(
      (a, b) => new Date(automationRunAttentionTime(b.run)) - new Date(automationRunAttentionTime(a.run)),
    )[0];
    const merged = usageLimitAttentionItem(latest.usageLimit, {
      id: "account:usage-limit:automation",
      time: automationRunAttentionTime(latest.run),
      repoId: latest.run.repoId,
      sessionId: latest.run.sessionId || null,
      threadId: latest.run.threadId || null,
    });
    items.push({
      ...merged,
      body:
        usageLimitedAutomationRuns.length > 1
          ? `${merged.body}（已合并 ${usageLimitedAutomationRuns.length} 条自动化失败）`
          : merged.body,
    });
    hasUsageLimitItem = true;
  }
  for (const run of regularAutomationAttentionRuns) {
    const runError = runAttentionError(run, auditEvents);
    items.push({
      id: `automation:${run.id}`,
      type: "automation",
      tone: ["queued", "running"].includes(run.status) ? "active" : "danger",
      title: compactAuditSummary(run.name).slice(0, 180),
      body: compactSingleLine(runError || run.summary || run.diffStat || run.status, 360),
      time: run.updatedAt || run.startedAt || new Date().toISOString(),
      repoId: run.repoId,
      automationId: run.automationId,
      runId: run.id,
      sessionId: run.sessionId || null,
      threadId: run.threadId || null,
      action: run.sessionId || run.threadId ? "thread" : "automation",
    });
  }
  let auditIssueCount = 0;
  const seenAuditIssueKeys = new Set();
  for (const event of auditIssues) {
    if (event.threadId && automationThreadIds.has(event.threadId)) continue;
    if (!event.threadId && automationErrorSummaries.has(event.summary)) continue;
    const auditUsageLimit = codexUsageLimitFromText(
      [event.summary, event.detail].filter(Boolean).join("\n"),
      new Date(event.time || Date.now()),
    );
    if (auditUsageLimit) {
      if (!hasUsageLimitItem && usageLimitStillActionable(auditUsageLimit)) {
        items.push(usageLimitAttentionItem(auditUsageLimit, {
          id: `audit:${event.id}`,
          time: event.time,
          repoId: event.repoId,
          sessionId: event.sessionId,
          threadId: event.threadId,
          itemId: event.itemId,
        }));
        hasUsageLimitItem = true;
      }
      continue;
    }
    const auditIssueKey = `${event.type || ""}:${event.summary || ""}`;
    if (seenAuditIssueKeys.has(auditIssueKey)) continue;
    seenAuditIssueKeys.add(auditIssueKey);
    const eventText = `${event.type || ""} ${event.summary || ""}`;
    const isRequestLike = /approval|elicitation|request/i.test(eventText);
    const canOpenThread = Boolean(event.repoId && (event.sessionId || event.threadId));
    auditIssueCount += 1;
    items.push({
      id: `audit:${event.id}`,
      type: "audit",
      tone: isRequestLike ? "active" : "danger",
      title: compactAuditSummary(event.summary || event.type).slice(0, 180),
      body: auditEventAttentionBody(event),
      time: event.time,
      repoId: event.repoId,
      sessionId: event.sessionId,
      threadId: event.threadId,
      itemId: event.itemId,
      action: canOpenThread ? "thread" : "logs",
    });
    if (auditIssueCount >= 8) break;
  }
  for (const repo of dirtyRepos.slice(0, 8)) {
    items.push({
      id: `repo:${repo.id}`,
      type: "repo",
      tone: "neutral",
      title: repo.name,
      body: compactSingleLine(repo.statusText || repo.lastCommit || "工作区存在未提交改动", 520),
      time: new Date().toISOString(),
      repoId: repo.id,
      action: "repo",
    });
  }
  const actionableItems = items.filter((item) => item.tone !== "neutral");
  const tonePriority = (tone) => (tone === "danger" ? 0 : tone === "active" ? 1 : 2);
  items.sort((a, b) => tonePriority(a.tone) - tonePriority(b.tone) || new Date(b.time) - new Date(a.time));
  actionableItems.sort((a, b) => new Date(b.time) - new Date(a.time));
  return {
    count: actionableItems.length,
    needsAttentionCount:
      regularAutomationAttentionRuns.filter((run) => !["queued", "running"].includes(String(run.status || ""))).length +
      (usageLimitedAutomationRuns.length ? 1 : 0),
    activeCount: inbox.active.length + activeJobItems.length,
    dirtyRepoCount: dirtyRepos.length,
    auditIssueCount,
    capabilityWarningCount: capabilityWarnings.length,
    diagnosticsWarningCount: diagnosticWarnings.length,
    latestItemId: actionableItems[0]?.id || "",
    latestTitle: actionableItems[0]?.title || "",
    items: items.slice(0, 24),
  };
}

function normalizeAttentionAcknowledgement(value = {}) {
  const id = String(value.id || "").trim();
  if (!id) return null;
  return {
    id: id.slice(0, 220),
    acknowledgedAt: value.acknowledgedAt ? String(value.acknowledgedAt) : new Date().toISOString(),
    title: compactSingleLine(value.title || "", 220),
    type: compactSingleLine(value.type || "attention", 80),
  };
}

async function readAttentionState() {
  const parsed = await readJsonState(attentionStatePath, { version: 1, acknowledged: {} });
  const acknowledged = {};
  const source = parsed?.acknowledged && typeof parsed.acknowledged === "object" ? Object.values(parsed.acknowledged) : [];
  for (const item of source) {
    const normalized = normalizeAttentionAcknowledgement(item);
    if (normalized) acknowledged[normalized.id] = normalized;
  }
  return { version: 1, acknowledged };
}

async function writeAttentionState(store) {
  return enqueueWrite("attention", async () => {
    const acknowledged = {};
    const source = store?.acknowledged && typeof store.acknowledged === "object" ? Object.values(store.acknowledged) : [];
    for (const item of source) {
      const normalized = normalizeAttentionAcknowledgement(item);
      if (normalized) acknowledged[normalized.id] = normalized;
    }
    const newest = Object.fromEntries(
      Object.values(acknowledged)
        .sort((a, b) => new Date(b.acknowledgedAt) - new Date(a.acknowledgedAt))
        .slice(0, 500)
        .map((item) => [item.id, item]),
    );
    await atomicWriteJson(attentionStatePath, { version: 1, acknowledged: newest });
  });
}

function applyAttentionAcknowledgements(summary, state) {
  const acknowledged = state?.acknowledged || {};
  const items = (summary.items || []).map((item) => {
    const ack = acknowledged[item.id];
    return ack ? { ...item, acknowledged: true, acknowledgedAt: ack.acknowledgedAt } : { ...item, acknowledged: false };
  });
  const unacknowledged = items.filter((item) => item.tone !== "neutral" && !item.acknowledged);
  unacknowledged.sort((a, b) => new Date(b.time) - new Date(a.time));
  return {
    ...summary,
    count: unacknowledged.length,
    unreadCount: unacknowledged.length,
    totalCount: items.length,
    acknowledgedCount: items.filter((item) => item.acknowledged).length,
    latestItemId: unacknowledged[0]?.id || "",
    latestTitle: unacknowledged[0]?.title || "",
    items,
  };
}

async function acknowledgeAttentionItems(items) {
  const store = await readAttentionState();
  const now = new Date().toISOString();
  for (const item of items) {
    const normalized = normalizeAttentionAcknowledgement({
      id: item.id,
      type: item.type,
      title: item.title,
      acknowledgedAt: now,
    });
    if (normalized) store.acknowledged[normalized.id] = normalized;
  }
  await writeAttentionState(store);
  return readAttentionState();
}

async function clearAttentionAcknowledgements({ currentIds = null, all = false } = {}) {
  const store = await readAttentionState();
  const before = Object.keys(store.acknowledged).length;
  if (all) {
    store.acknowledged = {};
  } else if (currentIds) {
    const active = new Set(currentIds);
    for (const id of Object.keys(store.acknowledged)) {
      if (!active.has(id)) delete store.acknowledged[id];
    }
  }
  await writeAttentionState(store);
  const next = await readAttentionState();
  return { state: next, cleared: before - Object.keys(next.acknowledged).length };
}

function redactUrl(value) {
  const url = String(value || "").trim();
  if (!url) return "";
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname.split("/").slice(0, 2).join("/")}${parsed.search ? "?..." : ""}`;
  } catch {
    return url.length > 28 ? `${url.slice(0, 18)}...${url.slice(-6)}` : url;
  }
}

function notificationChannels() {
  const channels = [
    {
      id: "webhook",
      label: "Generic webhook",
      enabled: Boolean(process.env.CODEX_CLOUD_NOTIFY_WEBHOOK_URL),
      target: redactUrl(process.env.CODEX_CLOUD_NOTIFY_WEBHOOK_URL),
      type: "webhook",
      url: process.env.CODEX_CLOUD_NOTIFY_WEBHOOK_URL || "",
    },
    {
      id: "slack",
      label: "Slack webhook",
      enabled: Boolean(process.env.CODEX_CLOUD_NOTIFY_SLACK_WEBHOOK_URL),
      target: redactUrl(process.env.CODEX_CLOUD_NOTIFY_SLACK_WEBHOOK_URL),
      type: "slack",
      url: process.env.CODEX_CLOUD_NOTIFY_SLACK_WEBHOOK_URL || "",
    },
    {
      id: "telegram",
      label: "Telegram bot",
      enabled: Boolean(process.env.CODEX_CLOUD_NOTIFY_TELEGRAM_BOT_TOKEN && process.env.CODEX_CLOUD_NOTIFY_TELEGRAM_CHAT_ID),
      target: process.env.CODEX_CLOUD_NOTIFY_TELEGRAM_CHAT_ID ? `chat ${String(process.env.CODEX_CLOUD_NOTIFY_TELEGRAM_CHAT_ID).slice(0, 4)}...` : "",
      type: "telegram",
      token: process.env.CODEX_CLOUD_NOTIFY_TELEGRAM_BOT_TOKEN || "",
      chatId: process.env.CODEX_CLOUD_NOTIFY_TELEGRAM_CHAT_ID || "",
    },
  ];
  return channels;
}

function pushSubscriptionId(endpoint) {
  return crypto.createHash("sha256").update(String(endpoint || "")).digest("base64url").slice(0, 24);
}

function normalizePushSubscription(value = {}) {
  const endpoint = String(value.endpoint || "").trim();
  const keys = value.keys && typeof value.keys === "object" ? value.keys : {};
  const p256dh = String(keys.p256dh || "").trim();
  const auth = String(keys.auth || "").trim();
  if (!endpoint || !p256dh || !auth) return null;
  return {
    id: String(value.id || pushSubscriptionId(endpoint)).slice(0, 80),
    endpoint,
    expirationTime: value.expirationTime ?? null,
    keys: { p256dh, auth },
    userAgent: compactSingleLine(value.userAgent || "", 220),
    createdAt: value.createdAt ? String(value.createdAt) : new Date().toISOString(),
    lastSeenAt: value.lastSeenAt ? String(value.lastSeenAt) : new Date().toISOString(),
    lastDeliveredAt: value.lastDeliveredAt ? String(value.lastDeliveredAt) : null,
    lastError: value.lastError ? compactSingleLine(value.lastError, 360) : null,
  };
}

function normalizePushState(value = {}) {
  const subscriptions = {};
  const source = value?.subscriptions && typeof value.subscriptions === "object" ? Object.values(value.subscriptions) : [];
  for (const item of source) {
    const normalized = normalizePushSubscription(item);
    if (normalized) subscriptions[normalized.id] = normalized;
  }
  const envPublicKey = process.env.CODEX_CLOUD_PUSH_PUBLIC_KEY || process.env.WEB_PUSH_PUBLIC_KEY || "";
  const envPrivateKey = process.env.CODEX_CLOUD_PUSH_PRIVATE_KEY || process.env.WEB_PUSH_PRIVATE_KEY || "";
  return {
    vapidPublicKey: envPublicKey || String(value?.vapidPublicKey || ""),
    vapidPrivateKey: envPrivateKey || String(value?.vapidPrivateKey || ""),
    vapidSource: envPublicKey && envPrivateKey ? "env" : String(value?.vapidSource || "generated"),
    subscriptions,
    lastTestAt: value?.lastTestAt ? String(value.lastTestAt) : null,
    lastError: value?.lastError ? compactSingleLine(value.lastError, 360) : null,
  };
}

async function ensurePushState(state, { persist = false } = {}) {
  const next = { ...(state || {}), push: normalizePushState(state?.push || {}) };
  if (!next.push.vapidPublicKey || !next.push.vapidPrivateKey) {
    const generated = webPush.generateVAPIDKeys();
    next.push.vapidPublicKey = generated.publicKey;
    next.push.vapidPrivateKey = generated.privateKey;
    next.push.vapidSource = "generated";
    persist = true;
  }
  if (persist) await writeNotificationState(next);
  return next;
}

function pushNotificationStatusFromState(state = {}) {
  const push = normalizePushState(state.push || {});
  const subscriptions = Object.values(push.subscriptions || {});
  const lastDelivery = subscriptions
    .filter((item) => item.lastDeliveredAt)
    .sort((a, b) => new Date(b.lastDeliveredAt) - new Date(a.lastDeliveredAt))[0];
  return {
    supported: true,
    configured: Boolean(push.vapidPublicKey && push.vapidPrivateKey),
    publicKey: push.vapidPublicKey || "",
    subject: pushSubject,
    subscriptionCount: subscriptions.length,
    subscriptions: subscriptions.slice(0, 8).map((item) => ({
      id: item.id,
      endpoint: redactUrl(item.endpoint),
      userAgent: item.userAgent,
      lastSeenAt: item.lastSeenAt,
      lastDeliveredAt: item.lastDeliveredAt,
      lastError: item.lastError,
    })),
    lastDeliveredAt: lastDelivery?.lastDeliveredAt || null,
    lastTestAt: push.lastTestAt,
    lastError: push.lastError || null,
  };
}

async function pushNotificationStatus(state = null) {
  const currentState = state || (await readNotificationState());
  const push = normalizePushState(currentState.push || {});
  const current = await ensurePushState(currentState, { persist: !push.vapidPublicKey || !push.vapidPrivateKey });
  return pushNotificationStatusFromState(current);
}

function attentionTargetHash(item = {}) {
  if (item.actionUrl && /^https?:\/\//i.test(String(item.actionUrl))) return String(item.actionUrl);
  if (item.action === "thread") {
    const repo = encodeURIComponent(String(item.repoId || defaultRepoId));
    const thread = encodeURIComponent(String(item.threadId || item.sessionId || ""));
    if (thread) return `#/project/${repo}/thread/${thread}`;
  }
  if (item.action === "repo" && item.repoId) return `#/project/${encodeURIComponent(String(item.repoId))}`;
  if (item.action === "automation") {
    const repo = item.repoId ? `/${encodeURIComponent(String(item.repoId))}` : "";
    const automation = item.automationId ? `/${encodeURIComponent(String(item.automationId))}` : "";
    return `#/automations${repo}${automation}`;
  }
  if (item.action === "logs") return "#/logs";
  if (["settings", "codex-login", "mcp-login"].includes(String(item.action || ""))) return "#/settings";
  return "#/inbox";
}

async function sendPushNotifications(state, item, reason = "attention") {
  const push = normalizePushState(state.push || {});
  const subscriptions = Object.values(push.subscriptions || {});
  if (!subscriptions.length) return { ok: false, status: "no-subscriptions", sent: 0, failed: 0 };
  webPush.setVapidDetails(pushSubject, push.vapidPublicKey, push.vapidPrivateKey);
  const payload = JSON.stringify({
    title: "Codex Cloud 需要关注",
    body: item.title || item.body || "云端 Codex 有新的待处理事件",
    tag: item.id,
    url: attentionTargetHash(item),
    item,
    reason,
  });
  let sent = 0;
  let failed = 0;
  const now = new Date().toISOString();
  for (const subscription of subscriptions) {
    try {
      await webPush.sendNotification(
        { endpoint: subscription.endpoint, expirationTime: subscription.expirationTime, keys: subscription.keys },
        payload,
        { TTL: 60 * 60 },
      );
      sent += 1;
      state.push.subscriptions[subscription.id] = {
        ...subscription,
        lastDeliveredAt: now,
        lastError: null,
      };
    } catch (error) {
      failed += 1;
      const statusCode = error?.statusCode || error?.status;
      if (statusCode === 404 || statusCode === 410) {
        delete state.push.subscriptions[subscription.id];
      } else {
        state.push.subscriptions[subscription.id] = {
          ...subscription,
          lastError: compactSingleLine(error.message || "push send failed", 360),
        };
      }
    }
  }
  state.push.lastError = failed && !sent ? `Push failed for ${failed} subscription(s)` : null;
  return { ok: sent > 0, status: sent > 0 ? 201 : 502, sent, failed };
}

function normalizeNotificationDelivery(value = {}) {
  const itemId = String(value.itemId || "").trim();
  if (!itemId) return null;
  const channels = Array.isArray(value.channels)
    ? value.channels
        .map((channel) => ({
          channelId: String(channel.channelId || "").slice(0, 80),
          ok: channel.ok !== false,
          status: channel.status ? String(channel.status).slice(0, 80) : null,
          error: channel.error ? compactSingleLine(channel.error, 360) : null,
        }))
        .filter((channel) => channel.channelId)
    : [];
  return {
    itemId: itemId.slice(0, 220),
    channelId: String(value.channelId || "").slice(0, 80),
    deliveredAt: value.deliveredAt ? String(value.deliveredAt) : new Date().toISOString(),
    title: compactSingleLine(value.title || "", 220),
    ok: value.ok !== false,
    error: value.error ? compactSingleLine(value.error, 360) : null,
    channels,
  };
}

async function readNotificationState() {
  const parsed = await readJsonState(notificationStatePath, {
    version: 1,
    delivered: {},
    push: {},
    lastCheckAt: null,
    lastSentAt: null,
    lastError: null,
  });
  const delivered = {};
  const source = parsed?.delivered && typeof parsed.delivered === "object" ? Object.values(parsed.delivered) : [];
  for (const item of source) {
    const normalized = normalizeNotificationDelivery(item);
    if (normalized) delivered[normalized.itemId] = normalized;
  }
  return {
    version: 1,
    delivered,
    push: normalizePushState(parsed?.push || {}),
    lastCheckAt: parsed?.lastCheckAt || null,
    lastSentAt: parsed?.lastSentAt || null,
    lastError: parsed?.lastError || null,
  };
}

async function writeNotificationState(store) {
  return enqueueWrite("notification", async () => {
    const delivered = {};
    const source = store?.delivered && typeof store.delivered === "object" ? Object.values(store.delivered) : [];
    for (const item of source) {
      const normalized = normalizeNotificationDelivery(item);
      if (normalized) delivered[normalized.itemId] = normalized;
    }
    const newest = Object.fromEntries(
      Object.values(delivered)
        .sort((a, b) => new Date(b.deliveredAt) - new Date(a.deliveredAt))
        .slice(0, 500)
        .map((item) => [item.itemId, item]),
    );
    await atomicWriteJson(notificationStatePath, {
      version: 1,
      delivered: newest,
      push: normalizePushState(store.push || {}),
      lastCheckAt: store.lastCheckAt || null,
      lastSentAt: store.lastSentAt || null,
      lastError: store.lastError || null,
    });
  });
}

function notificationText(item, reason = "attention") {
  const lines = [
    `Codex Cloud: ${item.title || "需要关注"}`,
    item.body ? compactSingleLine(item.body, 500) : "",
    item.repoId ? `repo: ${item.repoId}` : "",
    item.threadId ? `thread: ${String(item.threadId).slice(0, 8)}` : "",
    `type: ${item.type || "attention"} · reason: ${reason}`,
  ].filter(Boolean);
  return lines.join("\n");
}

async function postJson(url, payload, timeout = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await response.text().catch(() => "");
    if (!response.ok) throw new Error(`${response.status} ${text || response.statusText}`);
    return { ok: true, status: response.status, body: text.slice(0, 400) };
  } finally {
    clearTimeout(timer);
  }
}

async function sendNotificationToChannel(channel, item, reason = "attention") {
  const text = notificationText(item, reason);
  if (channel.type === "telegram") {
    return postJson(`https://api.telegram.org/bot${channel.token}/sendMessage`, {
      chat_id: channel.chatId,
      text,
      disable_web_page_preview: true,
    });
  }
  if (channel.type === "slack") {
    return postJson(channel.url, { text });
  }
  return postJson(channel.url, {
    source: "codex-cloud",
    reason,
    item,
    text,
  });
}

async function externalNotificationStatus(state = null) {
  const current = state || (await readNotificationState());
  const channels = notificationChannels().map((channel) => {
    const deliveries = Object.values(current.delivered || {}).flatMap((item) => {
      const channelResults = Array.isArray(item.channels) ? item.channels : [];
      const nested = channelResults
        .filter((result) => result.channelId === channel.id)
        .map((result) => ({
          deliveredAt: item.deliveredAt,
          ok: result.ok,
          error: result.error,
        }));
      if (item.channelId === channel.id) nested.push(item);
      return nested;
    });
    const lastDelivery = deliveries
      .sort((a, b) => new Date(b.deliveredAt) - new Date(a.deliveredAt))[0];
    return {
      id: channel.id,
      label: channel.label,
      enabled: channel.enabled,
      target: channel.target,
      lastDeliveredAt: lastDelivery?.deliveredAt || null,
      lastError: lastDelivery?.ok === false ? lastDelivery.error : null,
    };
  });
  return {
    configured: channels.some((channel) => channel.enabled),
    channels,
    deliveredCount: Object.keys(current.delivered || {}).length,
    lastCheckAt: current.lastCheckAt,
    lastSentAt: current.lastSentAt,
    lastError: current.lastError,
    pollMs: Number(process.env.CODEX_CLOUD_NOTIFY_POLL_MS || 60_000),
  };
}

async function notifyAttentionItems(items, reason = "attention") {
  const state = await ensurePushState(await readNotificationState());
  const channels = notificationChannels().filter((channel) => channel.enabled);
  const hasPushSubscriptions = Object.keys(state.push?.subscriptions || {}).length > 0;
  if (hasPushSubscriptions) {
    channels.push({
      id: "push",
      label: "Browser push",
      enabled: true,
      target: `${Object.keys(state.push.subscriptions || {}).length} browser(s)`,
      type: "push",
    });
  }
  state.lastCheckAt = new Date().toISOString();
  if (!channels.length) {
    await writeNotificationState(state);
    return { ok: false, skipped: true, reason: "not-configured", sent: [], failed: [] };
  }
  const candidates = (items || []).filter((item) => item.tone !== "neutral" && !item.acknowledged && !state.delivered[item.id]).slice(0, 5);
  const sent = [];
  const failed = [];
  for (const item of candidates) {
    const channelResults = [];
    for (const channel of channels) {
      try {
        const result = channel.type === "push" ? await sendPushNotifications(state, item, reason) : await sendNotificationToChannel(channel, item, reason);
        channelResults.push({ channelId: channel.id, ok: Boolean(result.ok), status: result.status, error: result.ok ? null : result.error || result.status });
      } catch (error) {
        channelResults.push({ channelId: channel.id, ok: false, error: error.message || "send failed" });
      }
    }
    const okResult = channelResults.find((result) => result.ok);
    if (okResult) {
      const deliveredAt = new Date().toISOString();
      state.delivered[item.id] = normalizeNotificationDelivery({
        itemId: item.id,
        channelId: okResult.channelId,
        title: item.title,
        ok: true,
        deliveredAt,
        channels: channelResults,
      });
      state.lastSentAt = state.delivered[item.id].deliveredAt;
      sent.push({ itemId: item.id, title: item.title, channels: channelResults });
    } else {
      const message = channelResults.map((result) => `${result.channelId}: ${result.error}`).join("; ");
      state.lastError = message;
      failed.push({ itemId: item.id, title: item.title, channels: channelResults });
    }
  }
  await writeNotificationState(state);
  return { ok: failed.length === 0, skipped: false, sent, failed };
}

async function runExternalNotificationCheck(reason = "poll") {
  if (notificationCheckRunning) return { ok: false, skipped: true, reason: "already-running", sent: [], failed: [] };
  notificationCheckRunning = true;
  try {
    const status = await getStatus();
    return await notifyAttentionItems(status.attention?.items || [], reason);
  } finally {
    notificationCheckRunning = false;
  }
}

function normalizeAuditEvent(event = {}) {
  const time = event.time ? String(event.time) : new Date().toISOString();
  const detailMaxChars = Number(event.detailMaxChars || auditDetailMaxChars);
  return {
    id: String(event.id || `audit-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`),
    time,
    source: String(event.source || "console"),
    type: String(event.type || "event"),
    repoId: event.repoId ? String(event.repoId) : null,
    sessionId: event.sessionId ? String(event.sessionId) : null,
    threadId: event.threadId ? String(event.threadId) : null,
    turnId: event.turnId ? String(event.turnId) : null,
    itemId: event.itemId ? String(event.itemId) : null,
    summary: sanitizeCloudPathText(auditEventSummary(event), auditSummaryMaxChars),
    detail: normalizeAuditDetail(event.detail, detailMaxChars),
    detailMaxChars,
  };
}

function auditSourceForStatus(source = "") {
  const text = String(source || "console").trim();
  const normalized = text.replace(/[\s_-]+/g, "").toLowerCase();
  if (normalized === "appservercommand") return "云端命令";
  if (normalized === "appserver") return "云端 Codex";
  if (normalized === "localfallback") return "本地兜底";
  return text || "console";
}

function auditEventForStatus(event = {}) {
  return {
    ...event,
    source: auditSourceForStatus(event.source),
    summary: sanitizeCloudPathText(auditEventSummary(event), auditSummaryMaxChars),
    detail: normalizeAuditDetail(event.detail, auditStatusDetailMaxChars),
    detailMaxChars: undefined,
  };
}

async function readAuditEvents() {
  const parsed = await readJsonState(auditEventsPath, { version: 1, events: [] });
  const events = Array.isArray(parsed?.events) ? parsed.events.map(normalizeAuditEvent) : [];
  return { version: 1, events };
}

async function writeAuditEvents(store) {
  return enqueueWrite("audit", async () => {
    const current = await readAuditEvents();
    const byId = new Map((current.events || []).map((event) => [event.id, event]));
    for (const event of store.events || []) byId.set(String(event.id || normalizeAuditEvent(event).id), normalizeAuditEvent(event));
    const events = [...byId.values()].sort((a, b) => new Date(b.time) - new Date(a.time)).slice(0, 300);
    await atomicWriteJson(auditEventsPath, { version: 1, events });
  });
}

async function appendAuditEvent(event) {
  const normalized = normalizeAuditEvent(event);
  await writeAuditEvents({ events: [normalized] });
  return normalized;
}

function auditAppServerItem(item = {}, job = null, owner = {}) {
  const typeMap = {
    commandExecution: "shell",
    fileChange: "file-edit",
    webSearch: "network",
    mcpToolCall: "mcp",
    dynamicToolCall: "tool",
    imageGeneration: "tool",
  };
  const auditType = typeMap[item.type];
  if (!auditType) return;
  const summary =
    item.type === "commandExecution"
      ? `shell: ${item.command || "command"}`
      : item.type === "fileChange"
        ? "file edit"
        : item.type === "webSearch"
          ? `web search: ${item.query || ""}`.trim()
          : item.type === "mcpToolCall"
            ? `mcp: ${item.server || "server"} / ${item.tool || "tool"}`
            : `tool: ${item.tool || item.type}`;
  appendAuditEvent({
    source: "app-server",
    type: auditType,
    repoId: job?.repoId || null,
    sessionId: job?.sessionId || null,
    threadId: owner.threadId || job?.threadId || null,
    turnId: owner.turnId || job?.turnId || null,
    itemId: item.id || owner.itemId || null,
    summary,
    detail: jsonDetail({
      type: item.type,
      command: item.command,
      cwd: item.cwd,
      query: item.query,
      server: item.server,
      tool: item.tool,
      status: item.status,
    }),
  }).catch(() => null);
}

function parseAuditDetailObject(detail) {
  if (!detail) return {};
  if (typeof detail === "object") return detail;
  try {
    return JSON.parse(String(detail));
  } catch {
    return {};
  }
}

async function auditTimelineMessagesForSession(repoId, session, existingIds = new Set()) {
  if (!session?.codexSessionId) return [];
  const store = await readAuditEvents();
  const records = new Map();
  const relevantEvents = (store.events || [])
    .filter((event) => {
      if (event.repoId && event.repoId !== repoId) return false;
      if (event.sessionId && event.sessionId !== session.id) return false;
      if (event.threadId && event.threadId !== session.codexSessionId) return false;
      return event.threadId === session.codexSessionId || event.sessionId === session.id;
    })
    .reverse();

  for (const event of relevantEvents) {
    const detail = parseAuditDetailObject(event.detail);
    if (event.type !== "shell" && detail.type !== "commandExecution") continue;
    const itemId = String(event.itemId || detail.itemId || event.id || "");
    if (!itemId || existingIds.has(itemId)) continue;
    const record = records.get(itemId) || {
      id: itemId,
      role: "codex",
      text: "",
      time: event.time,
      mocked: false,
      turnId: event.turnId || null,
      messageType: "commandExecution",
      status: "command recorded",
      details: {
        kind: "command",
        command: "",
        cwd: null,
        exitCode: null,
        status: "recorded",
        output: "",
        outputLineCount: 0,
        outputLength: 0,
        outputTruncated: false,
      },
    };
    if (detail.command) record.details.command = String(detail.command);
    if (detail.cwd) record.details.cwd = String(detail.cwd);
    if (detail.status) record.details.status = String(detail.status);
    if (typeof detail.output === "string") record.details.output = detail.output;
    if (typeof detail.outputLineCount === "number") record.details.outputLineCount = detail.outputLineCount;
    if (typeof detail.outputLength === "number") record.details.outputLength = detail.outputLength;
    if (typeof detail.outputTruncated === "boolean") record.details.outputTruncated = detail.outputTruncated;
    if (typeof detail.exitCode === "number") {
      record.details.exitCode = detail.exitCode;
      record.details.status = detail.exitCode === 0 ? "completed" : "failed";
      record.status = `command ${record.details.status}`;
    } else if (detail.status) {
      record.status = `command ${record.details.status}`;
    }
    record.time = record.time || event.time;
    record.text = `运行命令: ${inlineShellCommand(record.details.command || event.summary.replace(/^shell:\s*/i, "") || "shell")}`;
    records.set(itemId, record);
  }

  return [...records.values()].map(normalizeChatMessage).filter((item) => item.text);
}

function validateAutomationTrigger(req) {
  const expected = String(process.env.CODEX_CLOUD_WEBHOOK_TOKEN || process.env.AUTOMATION_WEBHOOK_TOKEN || "").trim();
  const provided = String(req.get("x-codex-cloud-token") || "").trim();
  if (expected) {
    const providedBytes = Buffer.from(provided);
    const expectedBytes = Buffer.from(expected);
    return providedBytes.length === expectedBytes.length && crypto.timingSafeEqual(providedBytes, expectedBytes);
  }
  if (process.env.NODE_ENV === "production") return false;
  return true;
}

function automationTriggerClientKey(req, automationId) {
  return `${String(req.ip || req.socket?.remoteAddress || "unknown")}:${automationId}`;
}

function consumeAutomationTriggerRate(req, automationId) {
  const now = Date.now();
  const key = automationTriggerClientKey(req, automationId);
  const recent = (automationTriggerRateByKey.get(key) || []).filter((time) => now - time < automationTriggerRateWindowMs);
  if (recent.length >= automationTriggerRateMax) {
    const retryAfterMs = Math.max(1_000, automationTriggerRateWindowMs - (now - recent[0]));
    automationTriggerRateByKey.set(key, recent);
    return { ok: false, retryAfterMs };
  }
  recent.push(now);
  automationTriggerRateByKey.set(key, recent);
  return { ok: true, retryAfterMs: 0 };
}

function automationTriggerIdempotencyKey(req, automationId, trigger) {
  const raw = String(req.get("idempotency-key") || req.get("x-codex-idempotency-key") || "").trim();
  if (!raw) return { key: "", error: null };
  if (!/^[A-Za-z0-9._:-]{8,160}$/.test(raw)) {
    return { key: "", error: "Idempotency-Key must be 8-160 characters using letters, numbers, dot, underscore, colon, or dash" };
  }
  return { key: `${automationId}:${trigger}:${raw}`, error: null };
}

function pruneAutomationTriggerIdempotency(now = Date.now()) {
  for (const [key, entry] of automationTriggerIdempotency.entries()) {
    if (entry.expiresAt <= now) automationTriggerIdempotency.delete(key);
  }
}

function automationTriggerOptions(req, trigger) {
  return {
    trigger,
    prompt: req.body?.prompt,
    sessionId: req.body?.sessionId,
    worktree: req.body?.worktree !== false,
  };
}

async function startAppServerAutomationRun(automation, repo, options = {}) {
  const runId = automationRunId(automation.id);
  const runtime = normalizeRuntime(
    {
      model: options.model || automation.model,
      reasoning: options.reasoning || automation.reasoning,
      sandbox: options.sandbox || defaultRuntime.sandbox,
      approval: options.approval || defaultRuntime.approval,
      search: typeof options.search === "boolean" ? options.search : true,
    },
    {},
  );
  const prompt = String(options.prompt || automation.prompt || "").trim();
  if (!prompt) throw new Error("Automation prompt is required");
  const heartbeatSessionId = options.sessionId ? String(options.sessionId) : "";
  const store = heartbeatSessionId ? await readChatStore() : null;
  const heartbeatSession = heartbeatSessionId ? store.sessions[heartbeatSessionId] : null;
  if (heartbeatSessionId && (!heartbeatSession || heartbeatSession.repoId !== repo.id)) {
    throw new Error("Heartbeat session does not belong to this automation repo");
  }
  const useWorktree = heartbeatSession ? false : options.worktree !== false;
  let worktreePath = null;
  let runRecord = await upsertAutomationRun({
    id: runId,
    automationId: automation.id,
    repoId: repo.id,
    name: automation.name,
    trigger: options.trigger || "manual",
    runner: "app-server",
    status: "queued",
    worktreePolicy: heartbeatSession ? "existing-thread" : useWorktree ? "detached-worktree" : "repo-cwd",
    model: runtime.model,
    reasoning: runtime.reasoning,
    prompt,
  }, { type: "queued", text: heartbeatSession ? "Heartbeat turn queued" : "Automation run queued" });

  try {
    if (heartbeatSession) {
      runRecord = await appendAutomationRunEvent(
        runId,
        { worktreePath: repo.path, status: "running", sessionId: heartbeatSession.id, threadId: heartbeatSession.codexSessionId || null },
        { type: "heartbeat", text: `Using existing session ${heartbeatSession.id}` },
      );
    } else if (useWorktree) {
      worktreePath = await createAutomationWorktree(repo, runId);
      runRecord = await appendAutomationRunEvent(runId, { worktreePath, status: "running" }, { type: "worktree", text: `Created worktree ${worktreePath}` });
    } else {
      runRecord = await appendAutomationRunEvent(runId, { worktreePath: repo.path, status: "running" }, { type: "worktree", text: `Using repository cwd ${repo.path}` });
    }
    const runRepo = { ...repo, path: worktreePath || repo.path };
    const session = heartbeatSession || (await createStoredChatSession(repo.id, `Automation: ${automation.name}`, { makeActive: false }));
    const job = await startTurnJob(runRepo, session, runtime, prompt, [], prompt, { makeSessionActive: false });
    activeAutomationRuns.set(runId, job);
    await appendAutomationRunEvent(runId, { threadId: job.threadId, sessionId: session.id, status: "running" }, { type: "thread", text: "Started Codex app-server automation thread" });
    job.emitter.on("event", (payload) => {
      if (!["status", "tool", "error", "done", "session", "tokenUsage"].includes(payload.event)) return;
      const text =
        payload.event === "tool"
          ? payload.data?.type
            ? `tool: ${payload.data.type}`
            : "tool event"
          : payload.data?.text || payload.data?.message || payload.event;
      appendAutomationRunEvent(runId, { threadId: job.threadId || null }, { type: payload.event, text }).catch(() => null);
    });
    job.promise.then(async (result) => {
      activeAutomationRuns.delete(runId);
      const diffStat = await diffStatForPath(worktreePath || repo.path).catch(() => "");
      await appendAutomationRunEvent(
        runId,
        {
          status: result.ok ? "completed" : "failed",
          finishedAt: new Date().toISOString(),
          threadId: job.threadId,
          summary: job.output || "",
          diffStat,
          error: result.ok ? null : result.error || job.error || "Automation failed",
        },
        { type: "done", text: result.ok ? "Automation completed" : result.error || "Automation failed" },
      );
    }).catch(() => null);
    return { ...runRecord, threadId: job.threadId, sessionId: session.id, status: "running" };
  } catch (error) {
    await appendAutomationRunEvent(
      runId,
      { status: "failed", finishedAt: new Date().toISOString(), worktreePath, error: error.message },
      { type: "error", text: error.message },
    );
    throw error;
  }
}

async function getLogForAutomation(automation) {
  if (!(await exists(logsRoot))) return defaultRunDetail(automation);
  const entries = await fs.readdir(logsRoot, { withFileTypes: true }).catch(() => []);
  const preferred = [
    `${automation.id}-latest.log`,
    ...entries
      .map((entry) => entry.name)
      .filter((name) => name.startsWith(automation.id) && name.endsWith(".log"))
      .sort()
      .reverse(),
  ];
  const name = preferred.find(Boolean);
  if (!name) {
    return {
      activeState: "unknown",
      failedState: "unknown",
      exitCode: "unknown",
      logName: null,
      logUpdatedAt: null,
      logTail: ["暂无自动化日志"],
    };
  }
  const filePath = path.join(logsRoot, name);
  const stat = await fs.stat(filePath).catch(() => null);
  const content = await fs.readFile(filePath, "utf8").catch(() => "");
  return {
    activeState: "unknown",
    failedState: "unknown",
    exitCode: inferExitCode(content),
    logName: name,
    logUpdatedAt: stat?.mtime.toISOString() || null,
    logTail: semanticLogTail(compactLines(content, 2), stat?.mtime || new Date()),
  };
}

function inferExitCode(content) {
  const lines = compactLines(content, 200).reverse();
  for (const line of lines) {
    const done = line.match(/\bevent=done\s+([\s\S]+)$/i)?.[1] || "";
    if (/Automation completed|completed|success/i.test(done)) return "0";
    if (/Automation failed|failed|error|exception/i.test(done)) return "non-zero?";
    const finished = line.match(/\bfinished(?:\s+job=[^\s]+)?\s+status=([A-Za-z_-]+)/i)?.[1] || "";
    if (/^(completed|success)$/i.test(finished)) return "0";
    if (/^(failed|error)$/i.test(finished)) return "non-zero?";
    const exitMatch = line.match(/(?:EXIT|exit code|code)[ =:]+(\d+)/i);
    if (exitMatch) return exitMatch[1];
  }
  if (/failed|error|traceback|exception/i.test(content)) return "non-zero?";
  if (/completed|CLOUD_PULL_DONE|migrated-runner-ok/i.test(content)) return "0";
  return "unknown";
}

function automationLogHasOnlyExpiredUsageLimitFailure(logDetail = {}) {
  const lines = Array.isArray(logDetail.logTail) ? logDetail.logTail.filter(Boolean) : [];
  return lines.some((line) => String(line).includes(expiredUsageLimitHistoryText())) && !lines.some((line) => /自动化已完成|已完成|成功/i.test(String(line)));
}

async function attachRunDetails(timerStatus) {
  return Promise.all(
    timerStatus.map(async (automation) => {
      const [active, failed, logDetail] = await Promise.all([
        run("systemctl", ["is-active", automation.service], { timeout: 5_000 }),
        run("systemctl", ["is-failed", automation.service], { timeout: 5_000 }),
        getLogForAutomation(automation),
      ]);
      const expiredUsageLimitFailure = automationLogHasOnlyExpiredUsageLimitFailure(logDetail);
      return {
        ...automation,
        run: {
          ...logDetail,
          activeState: expiredUsageLimitFailure ? "inactive" : active.stdout || logDetail.activeState,
          failedState: expiredUsageLimitFailure ? "inactive" : failed.stdout || logDetail.failedState,
          exitCode: expiredUsageLimitFailure ? "archived" : logDetail.exitCode,
        },
      };
    }),
  );
}

async function getTimers() {
  const result = await run("systemctl", ["list-timers", "codex-auto-*", "--all", "--no-pager"], {
    timeout: 8_000,
  });
  if (!result.ok) {
    return Promise.all(
      automations.map(async (automation, index) => ({
        ...automation,
        enabled: true,
        nextRun: ["今天 09:30", "今天 09:50", "今天 18:30", "明天 00:38"][index],
        lastRun: index === 3 ? "今天 00:38" : "尚未运行",
        run: await getLogForAutomation(automation),
      })),
    );
  }
  return attachRunDetails(parseTimerLines(result.stdout));
}

async function getCodexStatus() {
  const result = await run("codex", ["login", "status"], { timeout: 8_000 });
  const detail = result.stdout || result.stderr;
  if (!result.ok) {
    return {
      authenticated: false,
      mode: "unknown",
      detail: compactSingleLine(`codex login status 不可用: ${detail || result.error || `exit ${result.code ?? "unknown"}`}`, 360),
      source: "cli-unavailable",
    };
  }
  return {
    authenticated: /Logged in/i.test(detail),
    mode: /ChatGPT/i.test(detail) ? "ChatGPT subscription" : "API key",
    detail,
    source: "cli",
  };
}

function codexStatusFromAccountProbe(codexStatus = {}, accountProbeResult = null, authProblem = "") {
  if (authProblem) return { ...codexStatus, authenticated: false, detail: authProblem, source: "app-server-auth-error" };
  const account = accountProbeResult?.ok ? accountProbeResult.result?.account || null : null;
  if (!account) return codexStatus;
  const email = account.email || account.login || account.name || "";
  const plan = account.planType || account.plan || "";
  return {
    ...codexStatus,
    authenticated: true,
    mode: plan ? "ChatGPT subscription" : codexStatus.mode && codexStatus.mode !== "unknown" ? codexStatus.mode : "ChatGPT subscription",
    detail: email ? `云端 Codex 已验证账号 ${email}` : "云端 Codex 已验证账号登录有效",
    source: "app-server-account",
  };
}

async function getLogs() {
  const present = await exists(logsRoot);
  if (!present) {
    return [
      {
        id: "mock-1",
        job: "memory-export-refresh",
        name: "memory-export-refresh-latest.log",
        size: 619,
        updatedAt: new Date().toISOString(),
        tail: ["云端拉取完成", "定时器等待下一次运行"],
      },
    ];
  }
  const resolvedLogsRoot = await fs.realpath(logsRoot).catch(() => path.resolve(logsRoot));
  const entries = await fs.readdir(logsRoot, { withFileTypes: true });
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile() || entry.isSymbolicLink())
      .slice(-40)
      .map(async (entry) => {
        const filePath = path.join(logsRoot, entry.name);
        try {
          const resolvedPath = await fs.realpath(filePath);
          if (resolvedPath !== resolvedLogsRoot && !resolvedPath.startsWith(`${resolvedLogsRoot}${path.sep}`)) return null;
          const stat = await fs.stat(resolvedPath);
          if (!stat.isFile()) return null;
          const content = await fs.readFile(resolvedPath, "utf8").catch(() => "");
          return {
            id: entry.name,
            job: entry.name.replace(/-\d{8}.+$/, "").replace("-latest.log", ""),
            name: entry.name,
            size: stat.size,
            updatedAt: stat.mtime.toISOString(),
            tail: semanticLogTail(compactLines(content, 1), stat.mtime),
          };
        } catch {
          return null;
        }
      }),
  );
  return files
    .filter(Boolean)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .slice(0, 4);
}

function expiredUsageLimitHistoryText() {
  return "历史额度限制已过期，已移入运行历史。";
}

function semanticRunEventText(event = {}, referenceTime = new Date()) {
  const type = compactSingleLine(event.type || "status", 80).replace(/[\s_-]+/g, "").toLowerCase();
  const text = sanitizeCloudPathText(event.text || "", 360);
  if (!text) {
    if (type === "tokenusage") return "context usage updated";
    if (type === "done") return "automation completed";
    return "";
  }
  const usageLimit = codexUsageLimitFromText(text, new Date(referenceTime || Date.now()));
  if (usageLimit) return usageLimit.retryAtExpired ? expiredUsageLimitHistoryText() : usageLimit.body;
  if (/^tool:\s*processExited$/i.test(text)) return "command exited";
  if (/^tool:\s*terminalInteraction$/i.test(text)) return "terminal interaction";
  if (/^tool:\s*commandOutput$/i.test(text)) return "command output";
  if (/^tokenUsage\b/i.test(text) || type === "tokenusage") return "context usage updated";
  if (/^thread\s+状态:\s*idle$/i.test(text)) return "thread idle";
  if (/^(done|Automation completed)$/i.test(text)) return "automation completed";
  if (/^Started (?:Codex app-server|云端 Codex) automation thread$/i.test(text)) return "已启动云端自动化会话";
  if (/^app-server automation run started$/i.test(text)) return "云端自动化运行已启动";
  if (/^app-server automation/i.test(text)) return sanitizeStatusText(text).replace(/app-server automation/gi, "云端自动化");
  const commandRun = text.match(/^(?:运行命令|command):\s*([\s\S]+)$/i);
  if (commandRun?.[1]) return `运行命令: ${commandSummaryLabel(commandRun[1])}`;
  if (/INVEST_DASHBOARD_CLOUD_(?:SYNC_TOKEN|BASE_URL)/i.test(text)) return "运行命令: cloud sync configuration check";
  return text;
}

function summarizeRunEvent(event = {}, referenceTime = new Date()) {
  return {
    ...event,
    type: compactSingleLine(event.type || "status", 80),
    text: semanticRunEventText(event, event.time || referenceTime),
  };
}

function automationRunDisplayText(value = "", maxLength = 700, referenceTime = new Date()) {
  const referenceDate = referenceTime instanceof Date ? referenceTime : new Date(referenceTime || Date.now());
  const usageLimit = codexUsageLimitFromText(String(value || ""), referenceDate);
  return sanitizeCloudPathText(usageLimit ? (usageLimit.retryAtExpired ? expiredUsageLimitHistoryText() : usageLimit.body) : value || "", maxLength);
}

function summarizeAutomationRun(run = {}) {
  const worktreePolicy = String(run.worktreePolicy || "none");
  const referenceTime = run.updatedAt || run.finishedAt || run.startedAt || new Date().toISOString();
  const interruptedByRestart = automationRunInterruptedByConsoleRestart(run);
  return {
    ...run,
    status: interruptedByRestart ? "archived" : run.status,
    name: compactSingleLine(run.name || run.automationId || "automation", 180),
    prompt: sanitizeCloudPathText(run.prompt || "", automationRunPromptPreviewChars),
    summary: interruptedByRestart ? "控制台重启中断的历史运行，已归档。" : automationRunDisplayText(run.summary || "", 700, referenceTime),
    diffStat: sanitizeStatusText(run.diffStat || "", 700),
    error: interruptedByRestart ? "" : automationRunDisplayText(run.error || "", 520, referenceTime),
    worktreePath: run.worktreePath ? sanitizeCloudPathText(run.worktreePath, 120) : null,
    worktreePolicy: worktreePolicy === "detached-worktree" ? "isolated" : worktreePolicy === "repo-cwd" ? "repo" : worktreePolicy,
    events: interruptedByRestart
      ? [
          {
            time: run.finishedAt || run.updatedAt || run.startedAt || new Date().toISOString(),
            type: "archived",
            text: "历史运行已归档",
          },
        ]
      : Array.isArray(run.events)
      ? run.events.slice(-16).map((event) => summarizeRunEvent(event, referenceTime))
      : [],
  };
}

async function verifyAutomationRunThread(run = {}) {
  const threadId = String(run.threadId || "").trim();
  if (!threadId) {
    return {
      ...run,
      stateSource: "local-run-store",
      threadVerified: false,
      threadVerification: null,
    };
  }
  const cached = automationThreadVerificationById.get(threadId);
  if (cached && Date.now() - cached.cachedAt <= automationThreadVerificationTtlMs) {
    return { ...run, ...cached.data };
  }
  const response = await codexAppServerRequest("thread/read", { threadId, includeTurns: false }, appServerFastReadTimeoutMs);
  const thread = response.ok ? response.result?.thread || null : null;
  const data = response.ok
    ? {
        stateSource: "local-run-store+app-server-thread",
        threadVerified: true,
        threadVerification: {
          source: "app-server",
          threadId,
          updatedAt: appThreadTime(thread?.updatedAt || thread?.updated_at || thread?.createdAt || thread?.created_at),
          tokenUsage: normalizeTokenUsage(thread?.tokenUsage || thread?.token_usage),
        },
      }
    : {
        stateSource: "local-run-store",
        threadVerified: false,
        threadVerification: {
          source: "app-server-unavailable",
          threadId,
          error: compactSingleLine(response.error || "thread/read failed", 320),
        },
      };
  automationThreadVerificationById.set(threadId, { cachedAt: Date.now(), data });
  return { ...run, ...data };
}

async function verifyAutomationRunThreads(runs = [], options = {}) {
  const requestedLimit = options.limit ?? automationThreadVerificationDefaultLimit;
  const limit = Math.min(Math.max(Number(requestedLimit) || 0, 0), 50);
  const selectedIds = new Set(
    runs
      .filter((run) => run.threadId)
      .slice(0, limit)
      .map((run) => run.id),
  );
  const verified = await Promise.all(
    runs.map((run) => {
      if (selectedIds.has(run.id)) {
        return verifyAutomationRunThread(run).catch((error) => ({
          ...run,
          stateSource: "local-run-store",
          threadVerified: false,
          threadVerification: {
            source: "app-server-unavailable",
            threadId: run.threadId,
            error: compactSingleLine(error?.message || "thread/read failed", 320),
          },
        }));
      }
      return {
        ...run,
        stateSource: "local-run-store",
        threadVerified: false,
        threadVerification: null,
      };
    }),
  );
  return verified;
}

async function getStatus({ applyAttentionState = true } = {}) {
  const [
    repoStatus,
    timerStatus,
    codexStatus,
    logs,
    automationRunStore,
    auditStore,
    attentionState,
    notificationState,
    diagnosticsState,
    appServerProbeResult,
    accountProbeResult,
    mcpProbeResult,
  ] = await Promise.all([
    Promise.all(repos.map(getRepo)),
    getTimers(),
    getCodexStatus(),
    getLogs(),
    readAutomationRuns(),
    readAuditEvents(),
    applyAttentionState ? readAttentionState() : Promise.resolve({ version: 1, acknowledged: {} }),
    readNotificationState(),
    readDiagnosticsState(),
    appServerProbe("config/read", { includeLayers: false }, 10_000),
    appServerProbe("account/read", {}, 10_000),
    appServerProbe("mcpServerStatus/list", {}, 10_000),
  ]);
  const hostname = await run("hostname");
  const localMode = repoStatus.some((repo) => !repo.present);
  const appHost = getAppServerClient().status();
  const codexAuthProblem = codexAuthProblemFromSources(
    appHost.lastError,
    (appHost.stderrTail || []).join("\n"),
    appServerProbeResult.error,
    accountProbeResult.error,
  );
  const usageLimit = codexUsageLimitFromSources(
    appHost.lastError,
    (appHost.stderrTail || []).join("\n"),
    appServerProbeResult.error,
  );
  const effectiveCodexStatus = codexStatusFromAccountProbe(codexStatus, accountProbeResult, codexAuthProblem);
  const capabilityWarnings = buildCapabilityWarnings({ mcpProbeResult, appHost });
  const auditEventsForAttention = auditStore.events.map(auditEventForStatus);
  const auditEvents = auditEventsForAttention.slice(0, 40);
  const automationRuns = automationRunStore.runs
    .map(summarizeAutomationRun)
    .map((run) => enrichAutomationRunForStatus(run, auditEventsForAttention));
  const automationInbox = automationInboxBuckets(automationRuns, auditEventsForAttention);
  const activeJobs = activeJobSummaries();
  const health = buildHealthSnapshot({ codexStatus: effectiveCodexStatus, repoStatus, appServerProbeResult, accountProbeResult });
  const diagnosticWarnings = diagnosticsAttentionItems(diagnosticsState.latest);
  const rawAttention = buildAttentionSummary({
    repoStatus,
    runs: automationRuns,
    auditEvents: auditEventsForAttention,
    codexStatus: effectiveCodexStatus,
    capabilityWarnings,
    diagnosticWarnings,
    usageLimit,
    activeJobs,
  });
  const attention = applyAttentionState ? applyAttentionAcknowledgements(rawAttention, attentionState) : rawAttention;
  const externalNotifications = await externalNotificationStatus(notificationState);
  const pushNotifications = await pushNotificationStatus(notificationState);

  return {
    generatedAt: new Date().toISOString(),
    localMode,
    publicConfig: {
      publicOrigin,
      webhook: {
        tokenConfigured: Boolean(String(process.env.CODEX_CLOUD_WEBHOOK_TOKEN || process.env.AUTOMATION_WEBHOOK_TOKEN || "").trim()),
        tokenHeader: "x-codex-cloud-token",
        idempotencyHeader: "Idempotency-Key",
        basicAuthRequired: false,
      },
    },
    instance: {
      name: hostname.stdout || "codex-cloud-worker",
      region: process.env.AWS_REGION || "ap-northeast-1",
      publicIp,
      privateIp: process.env.CODEX_PRIVATE_IP || "172.31.7.169",
      type: process.env.CODEX_INSTANCE_TYPE || "t3.micro",
      root: cloudRoot,
    },
    health,
    codex: effectiveCodexStatus,
    usageLimit,
    repos: repoStatus,
    automations: timerStatus,
    automationRuns: automationRuns.slice(0, 20),
    automationInbox,
    activeJobs: activeJobs.slice(0, 20),
    attention,
    externalNotifications,
    pushNotifications,
    diagnostics: diagnosticsState.latest,
    capabilityWarnings,
    appServerLive: appServerLiveSnapshot(),
    auditEvents,
    logs,
    events: [
      { tone: "ok", text: "GitHub credentials are available on the cloud worker." },
      { tone: "ok", text: "System timers are enabled and waiting." },
      {
        tone: localMode ? "warn" : "ok",
        text: localMode ? "仓库尚未挂载，当前仅显示开发快照。" : "Cloud paths are mounted.",
      },
    ],
  };
}

function fastStatusFallback(error = "") {
  const now = new Date().toISOString();
  const previous = statusCache?.data || {};
  const appHost = getAppServerClient().status();
  const repoStatus =
    Array.isArray(previous.repos) && previous.repos.length
      ? previous.repos
      : repos.map((repo) => ({
          ...repo,
          present: true,
          branch: "main",
          commit: "syncing",
          dirty: false,
          statusText: "云端状态后台同步中",
          lastCommit: "后台同步中",
        }));
  const codexStatus = previous.codex || {
    authenticated: Boolean(appHost.running && !appHost.lastError),
    mode: "ChatGPT subscription",
    detail: appHost.lastError || "云端 Codex 状态后台同步中",
    source: "app-server-fast-status",
  };
  const health = {
    ok: false,
    layers: {
      ec2Console: { ok: true, port, host, time: now },
      appServer: {
        ok: Boolean(appHost.running && !appHost.lastError),
        running: Boolean(appHost.running),
        startedAt: appHost.startedAt,
        restartCount: appHost.restartCount,
        lastError: appHost.lastError ? sanitizeCloudPathText(appHost.lastError, 240) : null,
      },
      codexAuth: {
        ok: Boolean(codexStatus.authenticated),
        mode: codexStatus.mode,
        detail: codexStatus.detail,
      },
      repos: repoStatus.map((repo) => ({
        id: repo.id,
        ok: Boolean(repo.present),
        path: repo.path,
        branch: repo.branch,
        dirty: Boolean(repo.dirty),
      })),
    },
  };
  return {
    generatedAt: now,
    localMode: false,
    publicConfig: previous.publicConfig || {
      publicOrigin,
      webhook: {
        tokenConfigured: Boolean(String(process.env.CODEX_CLOUD_WEBHOOK_TOKEN || process.env.AUTOMATION_WEBHOOK_TOKEN || "").trim()),
        tokenHeader: "x-codex-cloud-token",
        idempotencyHeader: "Idempotency-Key",
        basicAuthRequired: false,
      },
    },
    instance: previous.instance || {
      name: "codex-cloud-worker",
      region: process.env.AWS_REGION || "ap-northeast-1",
      publicIp,
      privateIp: process.env.CODEX_PRIVATE_IP || "172.31.7.169",
      type: process.env.CODEX_INSTANCE_TYPE || "t3.micro",
      root: cloudRoot,
    },
    health,
    codex: codexStatus,
    usageLimit: previous.usageLimit || null,
    repos: repoStatus,
    automations: previous.automations || automations.map((automation) => ({ ...automation, enabled: true, nextRun: automation.schedule, lastRun: "后台同步中", run: defaultRunDetail(automation) })),
    automationRuns: previous.automationRuns || [],
    automationInbox: previous.automationInbox || { needsAttention: [], active: [], recent: [], archived: [] },
    activeJobs: activeJobSummaries().slice(0, 20),
    attention: previous.attention || {
      count: 0,
      unreadCount: 0,
      totalCount: 0,
      acknowledgedCount: 0,
      needsAttentionCount: 0,
      activeCount: 0,
      dirtyRepoCount: 0,
      auditIssueCount: 0,
      latestItemId: "",
      latestTitle: "",
      items: [],
    },
    externalNotifications: previous.externalNotifications || {
      configured: false,
      channels: [],
      deliveredCount: 0,
      lastCheckAt: null,
      lastSentAt: null,
      lastError: null,
      pollMs: 60000,
    },
    pushNotifications: previous.pushNotifications || pushNotificationStatusFromState({ subscriptions: [], vapidPublicKey: "" }),
    diagnostics: previous.diagnostics || null,
    capabilityWarnings: previous.capabilityWarnings || [],
    appServerLive: appServerLiveSnapshot(),
    auditEvents: previous.auditEvents || [],
    logs: previous.logs || [],
    events: [
      { tone: health.ok ? "ok" : "warn", text: error ? `云端状态后台刷新中: ${sanitizeCloudPathText(error, 180)}` : "云端状态后台刷新中。" },
    ],
    partial: true,
  };
}

function startStatusRefresh(options = {}) {
  if (statusRefreshPromise) return statusRefreshPromise;
  statusRefreshPromise = getStatus(options)
    .then((data) => {
      statusCache = { data, cachedAt: Date.now() };
      return data;
    })
    .catch((error) => {
      if (statusCache) return { ...statusCache.data, refreshing: false, refreshError: error.message || String(error) };
      throw error;
    })
    .finally(() => {
      statusRefreshPromise = null;
    });
  return statusRefreshPromise;
}

async function getStatusForRoute() {
  const age = statusCache ? Date.now() - statusCache.cachedAt : Infinity;
  if (statusCache && age <= statusCacheTtlMs) return { data: statusCache.data, cache: "fresh" };
  const refresh = startStatusRefresh();
  if (statusCache) return { data: { ...statusCache.data, refreshing: true }, cache: "stale" };
  try {
    const data = await Promise.race([refresh, deadline(statusFirstResponseMs)]);
    return { data, cache: "fresh" };
  } catch (error) {
    refresh.catch(() => null);
    return { data: fastStatusFallback(error.message || String(error)), cache: "partial" };
  }
}

function buildHealthSnapshot({ codexStatus, repoStatus, appServerProbeResult, accountProbeResult = null }) {
  const appHost = getAppServerClient().status();
  const codexAuthProblem = codexAuthProblemFromSources(
    appHost.lastError,
    (appHost.stderrTail || []).join("\n"),
    appServerProbeResult?.error,
    accountProbeResult?.error,
  );
  const effectiveCodexStatus = codexStatusFromAccountProbe(codexStatus, accountProbeResult, codexAuthProblem);
  const layers = {
    ec2Console: { ok: true, port, host, time: new Date().toISOString() },
    appServer: {
      ok: Boolean(appServerProbeResult.ok),
      running: Boolean(appHost.running),
      startedAt: appHost.startedAt,
      restartCount: appHost.restartCount,
      lastError: appServerProbeResult.ok
        ? null
        : (appHost.lastError || appServerProbeResult.error)
          ? sanitizeCloudPathText(appHost.lastError || appServerProbeResult.error, 320)
          : null,
    },
    codexAuth: {
      ok: Boolean(effectiveCodexStatus.authenticated),
      mode: effectiveCodexStatus.mode,
      detail: effectiveCodexStatus.detail,
    },
    repos: repoStatus.map((repo) => ({
      id: repo.id,
      ok: Boolean(repo.present),
      path: repo.path,
      branch: repo.branch,
      dirty: repo.dirty,
    })),
  };
  const ok = layers.ec2Console.ok && layers.appServer.ok && layers.codexAuth.ok && layers.repos.every((repo) => repo.ok);
  return { ok, layers };
}

function getRepoById(id) {
  const repoId = String(id || "").trim();
  const repo = repos.find((item) => item.id === repoId);
  if (repo) return repo;
  const error = new Error(repoId ? `Unknown repository: ${repoId}` : "repoId is required");
  error.statusCode = repoId ? 404 : 400;
  error.source = "invalid-repository";
  throw error;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function resolveRepoPath(repo, relativePath = ".") {
  const clean = String(relativePath || ".").replaceAll("\\", "/");
  const target = path.resolve(repo.path, clean);
  const root = path.resolve(repo.path);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw repoPathError("Path escapes repository root");
  }
  return target;
}

function pathIsWithin(root, target) {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

function repoPathError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.source = "invalid-repository-path";
  return error;
}

function generatedImagePathError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.source = "invalid-generated-image-path";
  return error;
}

async function realPathOrNearestExisting(target, seenLinks = new Set()) {
  let candidate = target;
  while (true) {
    try {
      const metadata = await fs.lstat(candidate);
      if (metadata.isSymbolicLink()) {
        const linkedPath = await fs.readlink(candidate);
        const resolvedLink = path.resolve(path.dirname(candidate), linkedPath);
        if (seenLinks.size >= 64) throw repoPathError("Path contains too many symbolic links");
        if (seenLinks.has(resolvedLink)) throw repoPathError("Path contains cyclic symbolic links");
        seenLinks.add(resolvedLink);
        return realPathOrNearestExisting(resolvedLink, seenLinks);
      }
      return await fs.realpath(candidate);
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes(error?.code)) throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

async function assertRepoPathAccess(repo, target, options = {}) {
  const lexicalTarget = resolveRepoPath(repo, target);
  let realRoot;
  try {
    realRoot = await fs.realpath(repo.path);
  } catch (error) {
    if (error?.code === "ENOENT") throw repoPathError("Repository path does not exist", 404);
    throw error;
  }

  let realTarget;
  try {
    realTarget = options.allowMissing
      ? await realPathOrNearestExisting(lexicalTarget)
      : await fs.realpath(lexicalTarget);
  } catch (error) {
    if (error?.code === "ENOENT") throw repoPathError("Path does not exist", 404);
    if (error?.code === "ELOOP") throw repoPathError("Path contains cyclic symbolic links");
    throw error;
  }
  if (!pathIsWithin(realRoot, realTarget)) {
    throw repoPathError("Path resolves outside repository root");
  }
  return lexicalTarget;
}

async function assertGeneratedImagePathAccess(target) {
  const requestedPath = String(target || "").trim();
  if (!requestedPath || !path.isAbsolute(requestedPath)) {
    throw generatedImagePathError("Generated image path must be absolute");
  }
  const lexicalRoot = path.resolve(generatedImagesRoot);
  const lexicalTarget = path.resolve(requestedPath);
  if (!pathIsWithin(lexicalRoot, lexicalTarget)) {
    throw generatedImagePathError("Path is outside the generated image directory");
  }

  let realRoot;
  let realTarget;
  try {
    [realRoot, realTarget] = await Promise.all([fs.realpath(lexicalRoot), fs.realpath(lexicalTarget)]);
  } catch (error) {
    if (error?.code === "ENOENT") throw generatedImagePathError("Generated image does not exist", 404);
    if (error?.code === "ELOOP") throw generatedImagePathError("Generated image path contains cyclic symbolic links");
    throw error;
  }
  if (!pathIsWithin(realRoot, realTarget)) {
    throw generatedImagePathError("Generated image resolves outside its directory");
  }
  if (!imageMimeForPath(realTarget)) {
    throw generatedImagePathError("Only raster generated images are supported", 415);
  }
  return realTarget;
}

async function appServerReviewExec(repo, command, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 30_000);
  const response = await codexAppServerRequest(
    "command/exec",
    {
      command,
      cwd: repo.path,
      timeoutMs,
      sandboxPolicy: appServerSandboxPolicy({ ...defaultRuntime, sandbox: "read-only" }, repo),
      disableOutputCap: true,
      env: options.env || null,
    },
    timeoutMs + 10_000,
  );
  if (!response.ok) {
    throw new Error(response.error || `Codex app-server command failed: ${command[0] || "command"}`);
  }
  const result = response.result || {};
  const code = Number(result.exitCode ?? 1);
  const stdout = String(result.stdout || "");
  const stderr = String(result.stderr || "");
  if (code !== 0 && !options.allowFailure) {
    throw new Error(stderr || stdout || `Command exited ${code}: ${command.join(" ")}`);
  }
  return { code, stdout, stderr };
}

function emptyAppServerReviewSnapshot(repo, scope, workspaceView, source = "app-server-command") {
  return {
    cwd: repo.path,
    gitRoot: null,
    isGitRepo: false,
    scope,
    workspaceView,
    baseBranch: null,
    baseBranchOptions: [],
    commitSha: null,
    headBranch: null,
    mergeBaseSha: null,
    generatedAtIso: new Date().toISOString(),
    source,
    readOnly: true,
    summary: { fileCount: 0, addedLineCount: 0, removedLineCount: 0 },
    files: [],
  };
}

function parseGitLines(value) {
  return String(value || "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function buildAppServerReviewSnapshot(repo, options = {}) {
  const scope = options.scope === "baseBranch" ? "baseBranch" : "workspace";
  const workspaceView = options.workspaceView === "staged" ? "staged" : "unstaged";
  const rootResult = await appServerReviewExec(repo, ["git", "rev-parse", "--show-toplevel"], { allowFailure: true, timeoutMs: 15_000 });
  if (rootResult.code !== 0) {
    return emptyAppServerReviewSnapshot(repo, scope, workspaceView);
  }
  const gitRoot = rootResult.stdout.trim() || repo.path;
  const [headResult, branchesResult] = await Promise.all([
    appServerReviewExec(repo, ["git", "rev-parse", "--abbrev-ref", "HEAD"], { allowFailure: true, timeoutMs: 15_000 }),
    appServerReviewExec(
      repo,
      ["git", "for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes/origin"],
      { allowFailure: true, timeoutMs: 15_000 },
    ),
  ]);
  const headBranch = headResult.code === 0 ? headResult.stdout.trim() || null : null;
  const baseBranchOptions = [...new Set(parseGitLines(branchesResult.stdout).filter((branch) => branch !== "origin/HEAD"))];
  let diffText = "";
  let baseBranch = null;
  let mergeBaseSha = null;

  if (scope === "baseBranch") {
    baseBranch =
      String(options.baseBranch || "").trim() ||
      baseBranchOptions.find((branch) => branch === "origin/main") ||
      baseBranchOptions.find((branch) => branch === "main") ||
      baseBranchOptions.find((branch) => branch === "origin/master") ||
      baseBranchOptions.find((branch) => branch === "master") ||
      baseBranchOptions[0] ||
      null;
    if (baseBranch) {
      const mergeBase = await appServerReviewExec(repo, ["git", "merge-base", "HEAD", baseBranch], { allowFailure: true, timeoutMs: 20_000 });
      mergeBaseSha = mergeBase.code === 0 ? mergeBase.stdout.trim() || null : null;
      if (mergeBaseSha) {
        const diff = await appServerReviewExec(repo, ["git", "diff", "--no-ext-diff", "--find-renames", "--patch", mergeBaseSha, "HEAD"], {
          allowFailure: true,
          timeoutMs: 30_000,
        });
        diffText = diff.stdout || "";
      }
    }
  } else if (workspaceView === "staged") {
    const diff = await appServerReviewExec(repo, ["git", "diff", "--cached", "--no-ext-diff", "--find-renames", "--patch"], {
      allowFailure: true,
      timeoutMs: 30_000,
    });
    diffText = diff.stdout || "";
  } else {
    const [tracked, untracked] = await Promise.all([
      appServerReviewExec(repo, ["git", "diff", "--no-ext-diff", "--find-renames", "--patch"], { allowFailure: true, timeoutMs: 30_000 }),
      appServerReviewExec(
        repo,
        [
          "/bin/bash",
          "-lc",
          "git ls-files --others --exclude-standard -z | while IFS= read -r -d '' p; do git diff --no-index -- /dev/null \"$p\" || true; done",
        ],
        { allowFailure: true, timeoutMs: 30_000 },
      ),
    ]);
    diffText = [tracked.stdout, untracked.stdout].map((chunk) => String(chunk || "").trim()).filter(Boolean).join("\n");
  }

  return buildReviewSnapshotFromDiff({
    cwd: repo.path,
    gitRoot,
    diffText,
    scope,
    workspaceView,
    baseBranch,
    baseBranchOptions,
    headBranch,
    mergeBaseSha,
    source: "app-server-command",
    readOnly: true,
  });
}

async function serveReviewGitRoute(req, res, pathname, searchParams = {}, body = req.body || {}) {
  const url = new URL(`http://codex-cloud.local${pathname}`);
  for (const [key, value] of Object.entries(searchParams)) {
    if (value !== undefined && value !== null && String(value).trim()) {
      url.searchParams.set(key, String(value));
    }
  }
  const handled = await handleReviewRoutes(req, res, url, {
    readJsonBody: async () => body || {},
  });
  if (!handled && !res.headersSent) {
    res.status(404).json({ ok: false, error: "Unknown review route" });
  }
}

function safeUploadName(name = "upload") {
  const original = String(name || "upload");
  const ext = path.extname(original).slice(0, 16).replace(/[^A-Za-z0-9._-]/g, "");
  const base = path
    .basename(original, path.extname(original))
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70);
  return `${base || "upload"}${ext}`;
}

const imageMimeByExt = new Map([
  [".apng", "image/apng"],
  [".avif", "image/avif"],
  [".gif", "image/gif"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
]);

const attachmentMimeByExt = new Map([
  ...imageMimeByExt,
  [".csv", "text/csv; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".log", "text/plain; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
  [".pdf", "application/pdf"],
  [".txt", "text/plain; charset=utf-8"],
  [".xml", "application/xml; charset=utf-8"],
]);

function imageMimeForPath(filePath) {
  return imageMimeByExt.get(path.extname(String(filePath || "")).toLowerCase()) || null;
}

function attachmentMimeForPath(filePath) {
  return attachmentMimeByExt.get(path.extname(String(filePath || "")).toLowerCase()) || "application/octet-stream";
}

function isUploadedAttachmentPath(repo, filePath) {
  const relativePath = path.relative(repo.path, filePath).replaceAll("\\", "/");
  return relativePath === ".codex-cloud/uploads" || relativePath.startsWith(".codex-cloud/uploads/");
}

function uploadedAttachmentAbsolutePath(repo, attachment = {}) {
  const candidates = [attachment.absolutePath, attachment.path].map((value) => String(value || "").trim()).filter(Boolean);
  for (const candidate of candidates) {
    let target;
    try {
      target = path.isAbsolute(candidate) ? path.resolve(candidate) : resolveRepoPath(repo, candidate);
    } catch {
      continue;
    }
    if (isUploadedAttachmentPath(repo, target)) return target;
  }
  return null;
}

function sessionUploadedAttachmentPaths(repo, session = {}) {
  const attachments = [
    ...(Array.isArray(session?.draft?.attachments) ? session.draft.attachments : []),
    ...(Array.isArray(session?.messages) ? session.messages.flatMap((message) => message?.attachments || []) : []),
  ];
  return new Set(attachments.map((attachment) => uploadedAttachmentAbsolutePath(repo, attachment)).filter(Boolean));
}

async function cleanupSessionUploadFiles(repo, session, store) {
  const owned = sessionUploadedAttachmentPaths(repo, session);
  const referencedElsewhere = new Set();
  for (const other of Object.values(store.sessions || {})) {
    if (other.id === session.id || other.repoId !== repo.id) continue;
    for (const filePath of sessionUploadedAttachmentPaths(repo, other)) referencedElsewhere.add(filePath);
  }
  const deleted = [];
  const errors = [];
  for (const filePath of owned) {
    if (referencedElsewhere.has(filePath)) continue;
    try {
      await assertRepoPathAccess(repo, filePath, { allowMissing: true });
      await fs.unlink(filePath);
      deleted.push(path.relative(repo.path, filePath));
      await fs.rmdir(path.dirname(filePath)).catch(() => null);
    } catch (error) {
      if (error?.code !== "ENOENT") errors.push(`${path.relative(repo.path, filePath)}: ${error.message}`);
    }
  }
  return { deleted, errors };
}

function parseDataUrl(dataUrl = "") {
  const match = String(dataUrl).match(/^data:([^;,]+)?(?:;[^,]*)?;base64,(.+)$/s);
  if (!match) throw new Error("Upload must be a base64 data URL");
  const mimeType = match[1] || "application/octet-stream";
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length) throw new Error("Upload is empty");
  if (buffer.length > maxUploadBytes) throw new Error(`Upload exceeds ${Math.round(maxUploadBytes / 1024 / 1024)} MB`);
  return { mimeType, buffer };
}

async function readRequestBuffer(req, limitBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limitBytes) throw new Error(`Upload exceeds ${Math.round(limitBytes / 1024 / 1024)} MB`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function multipartBoundary(contentType = "") {
  const match = String(contentType).match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  return (match?.[1] || match?.[2] || "").trim();
}

function parseContentDisposition(value = "") {
  const parsed = {};
  for (const part of String(value).split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    const key = rawKey?.trim().toLowerCase();
    if (!key || !rawValue.length) continue;
    parsed[key] = rawValue.join("=").trim().replace(/^"|"$/g, "");
  }
  return parsed;
}

function parseMultipartUploads(buffer, boundary) {
  if (!boundary) throw new Error("Missing multipart boundary");
  const delimiter = Buffer.from(`--${boundary}`);
  const fields = {};
  const files = [];
  let cursor = 0;
  while (cursor < buffer.length) {
    const start = buffer.indexOf(delimiter, cursor);
    if (start < 0) break;
    const partStart = start + delimiter.length;
    if (buffer.slice(partStart, partStart + 2).toString() === "--") break;
    let bodyStart = partStart;
    if (buffer.slice(bodyStart, bodyStart + 2).toString() === "\r\n") bodyStart += 2;
    const headerEnd = buffer.indexOf(Buffer.from("\r\n\r\n"), bodyStart);
    if (headerEnd < 0) break;
    const headerText = buffer.slice(bodyStart, headerEnd).toString("utf8");
    let next = buffer.indexOf(delimiter, headerEnd + 4);
    if (next < 0) next = buffer.length;
    let content = buffer.slice(headerEnd + 4, next);
    if (content.slice(-2).toString() === "\r\n") content = content.slice(0, -2);
    const headers = {};
    for (const line of headerText.split("\r\n")) {
      const splitAt = line.indexOf(":");
      if (splitAt < 0) continue;
      headers[line.slice(0, splitAt).trim().toLowerCase()] = line.slice(splitAt + 1).trim();
    }
    const disposition = parseContentDisposition(headers["content-disposition"] || "");
    const fieldName = disposition.name || "";
    const fileName = disposition.filename || "";
    if (fileName) {
      files.push({
        name: fileName,
        type: headers["content-type"] || attachmentMimeForPath(fileName),
        buffer: content,
      });
    } else if (fieldName) {
      fields[fieldName] = content.toString("utf8");
    }
    cursor = next;
  }
  return { fields, files };
}

async function uploadRequestPayload(req) {
  const contentType = String(req.headers["content-type"] || "");
  if (/multipart\/form-data/i.test(contentType)) {
    const limitBytes = maxUploadBytes * Math.max(maxUploadFiles, 1) + 1024 * 1024;
    const multipart = parseMultipartUploads(await readRequestBuffer(req, limitBytes), multipartBoundary(contentType));
    return {
      repoId: multipart.fields.repoId || multipart.fields.repo || multipart.fields.project || "",
      files: multipart.files.slice(0, maxUploadFiles),
    };
  }
  return {
    repoId: req.body?.repoId,
    files: Array.isArray(req.body?.files) ? req.body.files.slice(0, maxUploadFiles) : [],
  };
}

function uploadFileBytes(file = {}) {
  if (Buffer.isBuffer(file.buffer)) {
    if (!file.buffer.length) throw new Error("Upload is empty");
    if (file.buffer.length > maxUploadBytes) throw new Error(`Upload exceeds ${Math.round(maxUploadBytes / 1024 / 1024)} MB`);
    return {
      mimeType: String(file.type || file.mimeType || attachmentMimeForPath(file.name || "upload")),
      buffer: file.buffer,
    };
  }
  return parseDataUrl(file?.dataUrl);
}

function normalizeAttachment(repo, item = {}) {
  const relativePath = String(item.relativePath || item.path || "").replaceAll("\\", "/");
  if (!relativePath.startsWith(".codex-cloud/uploads/")) throw new Error("Attachment path is not an upload");
  const absolutePath = resolveRepoPath(repo, relativePath);
  const uploadRoot = resolveRepoPath(repo, ".codex-cloud/uploads");
  if (absolutePath !== uploadRoot && !absolutePath.startsWith(`${uploadRoot}${path.sep}`)) {
    throw new Error("Attachment escapes upload directory");
  }
  const mimeType = String(item.mimeType || item.type || "application/octet-stream");
  return {
    name: safeUploadName(item.name || path.basename(relativePath)),
    path: absolutePath,
    relativePath: path.relative(repo.path, absolutePath),
    mimeType,
    kind: mimeType.startsWith("image/") ? "image" : "file",
  };
}

function extractInlineTokens(message, prefix) {
  const tokens = [];
  const matcher = /(^|\s)([$@])([^\s]+)/g;
  let match;
  while ((match = matcher.exec(String(message || "")))) {
    if (match[2] !== prefix) continue;
    const clean = String(match[3] || "")
      .replace(/[),.;!?]+$/g, "")
      .trim();
    if (clean) tokens.push(clean);
  }
  return Array.from(new Set(tokens));
}

async function resolveSkillMentions(repo, message) {
  const tokens = extractInlineTokens(message, "$");
  if (!tokens.length) return [];
  const response = await codexAppServerRequest("skills/list", { cwds: [repo.path] }, 12_000).catch((error) => ({ ok: false, error: error.message }));
  if (!response.ok) return [];
  const skills = groupedSkillsFromEntries(response.result?.data || []).filter((skill) => skill.enabled !== false && skill.path);
  const index = new Map();
  for (const skill of skills) {
    for (const key of [skill.name, skill.displayName]) {
      if (key) index.set(String(key).toLowerCase(), skill);
    }
  }
  const resolved = [];
  const seen = new Set();
  for (const token of tokens) {
    const skill = index.get(token.toLowerCase());
    if (!skill || seen.has(skill.path)) continue;
    seen.add(skill.path);
    resolved.push({ name: skill.name, path: skill.path });
  }
  return resolved;
}

async function resolveFileMentions(repo, message) {
  const tokens = extractInlineTokens(message, "@");
  const resolved = [];
  const seen = new Set();
  for (const token of tokens) {
    if (!token || token.includes("://")) continue;
    if (token.startsWith("project:")) {
      continue;
    }
    const relativePath = token.replace(/^\.?\//, "");
    let absolutePath;
    try {
      absolutePath = await assertRepoPathAccess(repo, relativePath);
    } catch {
      continue;
    }
    const metadata = await codexAppServerRequest("fs/getMetadata", { path: absolutePath }, 8_000);
    if (!metadata.ok || seen.has(absolutePath)) continue;
    seen.add(absolutePath);
    resolved.push({
      name: path.basename(absolutePath) || relativePath || repo.name,
      path: absolutePath,
      relativePath: path.relative(repo.path, absolutePath) || ".",
    });
  }
  return resolved;
}

async function buildUserInputs(repo, message, attachments = []) {
  const normalizedAttachments = attachments.slice(0, maxUploadFiles).map((item) => normalizeAttachment(repo, item));
  await Promise.all(normalizedAttachments.map((attachment) => assertRepoPathAccess(repo, attachment.path)));
  const fileAttachments = normalizedAttachments.filter((attachment) => attachment.kind !== "image");
  const attachmentText = fileAttachments.length
    ? `\n\n上传文件路径:\n${fileAttachments.map((attachment) => `- ${attachment.relativePath}`).join("\n")}`
    : "";
  const [skillMentions, fileMentions] = await Promise.all([resolveSkillMentions(repo, message), resolveFileMentions(repo, message)]);
  const inputs = [];
  if (message || attachmentText) inputs.push({ type: "text", text: `${message || "请查看我上传的附件。"}${attachmentText}`, text_elements: [] });
  for (const skill of skillMentions) {
    inputs.push({ type: "skill", name: skill.name, path: skill.path });
  }
  const mentionedPaths = new Set(fileMentions.map((mention) => mention.path));
  for (const mention of fileMentions) {
    inputs.push({ type: "mention", name: mention.name, path: mention.path });
  }
  for (const attachment of normalizedAttachments) {
    if (attachment.kind === "image") {
      inputs.push({ type: "localImage", path: attachment.path, detail: null });
    } else if (!mentionedPaths.has(attachment.path)) {
      inputs.push({ type: "mention", name: attachment.name, path: attachment.path });
    }
  }
  return inputs.length ? inputs : [{ type: "text", text: "请查看我上传的附件。", text_elements: [] }];
}

async function listRepoFiles(repo, relativePath = ".") {
  const target = await assertRepoPathAccess(repo, relativePath);
  const response = await codexAppServerRequest("fs/readDirectory", { path: target }, 20_000);
  if (response.ok) {
    const rows = Array.isArray(response.result?.entries) ? response.result.entries : [];
    const visible = rows
      .filter((entry) => {
        const fileName = String(entry?.fileName || "");
        return fileName && fileName === path.basename(fileName) && !fileName.includes("\\") && ![".git", "node_modules", "dist", ".next", "build"].includes(fileName);
      })
      .slice(0, 220);
    const items = await Promise.all(
      visible.map(async (entry) => {
        const entryPath = path.join(target, entry.fileName);
        try {
          await assertRepoPathAccess(repo, entryPath);
        } catch {
          return null;
        }
        const metadata = await codexAppServerRequest("fs/getMetadata", { path: entryPath }, 8_000);
        const modifiedAtMs = Number(metadata.result?.modifiedAtMs || 0);
        return {
          name: entry.fileName,
          path: path.relative(repo.path, entryPath) || ".",
          type: entry.isDirectory ? "directory" : "file",
          size: Number(metadata.result?.size || metadata.result?.sizeBytes || 0),
          updatedAt: modifiedAtMs > 0 ? new Date(modifiedAtMs).toISOString() : null,
          source: "app-server",
        };
      }),
    );
    const safeItems = items.filter(Boolean);
    return {
      path: path.relative(repo.path, target) || ".",
      entries: safeItems.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1)),
      source: "app-server",
    };
  }

  if (!allowLocalFallback) throw appServerUnavailableError("fs/readDirectory", response.error);

  if (!(await exists(target))) return { path: relativePath, entries: [], source: "local-fallback", error: response.error };
  const entries = await fs.readdir(target, { withFileTypes: true });
  const items = await Promise.all(
    entries
      .filter((entry) => !entry.name.includes("\\") && ![".git", "node_modules", "dist", ".next", "build"].includes(entry.name))
      .slice(0, 220)
      .map(async (entry) => {
        const entryPath = path.join(target, entry.name);
        try {
          await assertRepoPathAccess(repo, entryPath);
        } catch {
          return null;
        }
        const stat = await fs.stat(entryPath).catch(() => null);
        return {
          name: entry.name,
          path: path.relative(repo.path, entryPath) || ".",
          type: entry.isDirectory() ? "directory" : "file",
          size: stat?.size || 0,
          updatedAt: stat?.mtime.toISOString() || null,
          source: "local-fallback",
        };
      }),
  );
  const safeItems = items.filter(Boolean);
  return {
    path: path.relative(repo.path, target) || ".",
    entries: safeItems.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1)),
    source: "local-fallback",
    error: response.error,
  };
}

function normalizeFuzzyFileResult(repo, result = {}) {
  const root = String(result.root || repo.path || "");
  const rawPath = String(result.path || "");
  let absolutePath;
  try {
    absolutePath = resolveRepoPath(repo, path.isAbsolute(rawPath) ? rawPath : path.join(root || repo.path, rawPath));
  } catch {
    return null;
  }
  const relativePath = path.relative(repo.path, absolutePath) || rawPath || result.file_name || ".";
  const type = result.match_type === "directory" ? "directory" : "file";
  return {
    name: String(result.file_name || path.basename(relativePath) || relativePath),
    path: relativePath.replace(/\\/g, "/"),
    type,
    size: 0,
    updatedAt: null,
    source: "app-server-fuzzy",
    score: Number(result.score || 0),
    indices: Array.isArray(result.indices) ? result.indices : null,
  };
}

function isMentionCandidatePath(relativePath = "") {
  const parts = String(relativePath || "").split(/[\\/]+/).filter(Boolean);
  return !parts.some((part) => [".git", "node_modules", "dist", ".next", "build"].includes(part));
}

async function searchRepoFiles(repo, query = "", options = {}) {
  const trimmed = compactSingleLine(query, 180).replace(/^@+/, "").trim();
  const limit = Math.min(Math.max(Number(options.limit || 16), 1), 40);
  if (!trimmed) {
    const listed = await listRepoFiles(repo, ".");
    return { query: trimmed, entries: listed.entries.slice(0, limit), source: listed.source, fallback: listed.source !== "app-server" };
  }
  const response = await codexAppServerRequest(
    "fuzzyFileSearch",
    { query: trimmed, roots: [repo.path], cancellationToken: options.cancellationToken || null },
    20_000,
  );
  if (response.ok) {
    const seen = new Set();
    const normalized = (Array.isArray(response.result?.files) ? response.result.files : [])
      .map((item) => normalizeFuzzyFileResult(repo, item));
    const validated = await Promise.all(
      normalized.map(async (item) => {
        if (!item?.path) return null;
        try {
          await assertRepoPathAccess(repo, item.path);
          return item;
        } catch {
          return null;
        }
      }),
    );
    const entries = validated
      .filter((item) => {
        if (!item?.path || seen.has(item.path)) return false;
        if (!isMentionCandidatePath(item.path)) return false;
        seen.add(item.path);
        return true;
      })
      .slice(0, limit);
    return { query: trimmed, entries, source: "app-server-fuzzy", fallback: false };
  }

  if (!allowLocalFallback) throw appServerUnavailableError("fuzzyFileSearch", response.error);

  const directoryQuery = trimmed.includes("/") ? trimmed.slice(0, trimmed.lastIndexOf("/")) || "." : ".";
  const leafQuery = trimmed.includes("/") ? trimmed.slice(trimmed.lastIndexOf("/") + 1).toLowerCase() : trimmed.toLowerCase();
  const listed = await listRepoFiles(repo, directoryQuery).catch(() => ({ path: directoryQuery, entries: [], source: "local-fallback" }));
  const entries = (listed.entries || [])
    .filter((entry) => !leafQuery || entry.name.toLowerCase().includes(leafQuery) || entry.path.toLowerCase().includes(leafQuery))
    .slice(0, limit)
    .map((entry) => ({ ...entry, source: entry.source || listed.source || "fallback" }));
  return { query: trimmed, entries, source: listed.source || "fallback", fallback: true, error: response.error };
}

async function runShellCommand(repo, command) {
  const script = String(command || "").trim();
  if (!script) return { ok: false, code: 1, stdout: "", stderr: "Command is required" };
  const cwd = (await exists(repo.path)) ? repo.path : projectRoot;
  const appServerResponse = await codexAppServerRequest(
    "command/exec",
    {
      command: ["/bin/bash", "-lc", script],
      cwd,
      timeoutMs: 120_000,
      sandboxPolicy: appServerSandboxPolicy(defaultRuntime, repo),
      disableOutputCap: true,
    },
    130_000,
  );
  if (appServerResponse.ok) {
    appendAuditEvent({
      source: "app-server-command",
      type: "shell",
      repoId: repo.id,
      summary: terminalCommandSummary(script),
      detail: JSON.stringify({ cwd, exitCode: appServerResponse.result?.exitCode ?? null, command: script }),
    }).catch(() => null);
    return {
      ok: appServerResponse.result?.exitCode === 0,
      code: appServerResponse.result?.exitCode ?? 1,
      stdout: appServerResponse.result?.stdout || "",
      stderr: appServerResponse.result?.stderr || "",
      cwd,
      source: "app-server",
    };
  }

  if (!allowLocalFallback) {
    return {
      ok: false,
      code: 502,
      stdout: "",
      stderr: appServerResponse.error || "Codex app-server command execution failed",
      cwd,
      source: "app-server-unavailable",
    };
  }

  const result = await run("/bin/bash", ["-lc", script], { cwd, timeout: 120_000 });
  appendAuditEvent({
    source: "local-fallback",
    type: "shell",
    repoId: repo.id,
    summary: terminalCommandSummary(script, "terminal fallback"),
    detail: JSON.stringify({ cwd, exitCode: result.code, command: script, fallbackError: appServerResponse.error }),
  }).catch(() => null);
  return { ...result, cwd, mocked: cwd !== repo.path, source: "local-fallback", fallbackError: appServerResponse.error };
}

async function findBrowserExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  return null;
}

async function runBrowserCheck(url) {
  const target = String(url || "").trim();
  if (!/^https?:\/\//i.test(target)) {
    return { ok: false, error: "URL must start with http:// or https://" };
  }
  try {
    const { chromium } = await import("playwright");
    const executablePath = await findBrowserExecutable();
    const browser = await chromium.launch({
      headless: true,
      executablePath: executablePath || undefined,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    const response = await page.goto(target, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(600);
    const title = await page.title();
    const screenshot = await page.screenshot({ type: "png", fullPage: false });
    await browser.close();
    return {
      ok: Boolean(response?.ok()),
      status: response?.status() || 0,
      title,
      url: target,
      executablePath: executablePath || "playwright-managed-chromium",
      errors: errors.slice(0, 12),
      screenshot: `data:image/png;base64,${screenshot.toString("base64")}`,
    };
  } catch (error) {
    return { ok: false, url: target, error: error.message };
  }
}

function relayLoopbackHttp({ port: rawPort, path: rawPath, query = "" }) {
  const portNumber = Number(rawPort);
  const relayPath = String(rawPath || "");
  if (!Number.isInteger(portNumber) || portNumber < 1024 || portNumber > 65535) {
    return Promise.resolve({ ok: false, statusCode: 400, body: "Invalid OAuth callback port" });
  }
  if (!relayPath.startsWith("/callback/")) {
    return Promise.resolve({ ok: false, statusCode: 400, body: "Invalid OAuth callback path" });
  }
  const requestPath = `${relayPath}${query ? `?${String(query).replace(/^\?/, "")}` : ""}`;
  return new Promise((resolve) => {
    const callbackRequest = http.request(
      {
        hostname: "127.0.0.1",
        port: portNumber,
        method: "GET",
        path: requestPath,
        timeout: 20_000,
      },
      (callbackResponse) => {
        const chunks = [];
        callbackResponse.on("data", (chunk) => chunks.push(chunk));
        callbackResponse.on("end", () => {
          resolve({
            ok: callbackResponse.statusCode >= 200 && callbackResponse.statusCode < 400,
            statusCode: callbackResponse.statusCode || 502,
            headers: callbackResponse.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    callbackRequest.on("error", (error) => {
      resolve({ ok: false, statusCode: 502, body: `OAuth callback relay failed: ${error.message}` });
    });
    callbackRequest.end();
  });
}

app.get("/api/status", async (_req, res) => {
  const { data, cache } = await getStatusForRoute();
  res.setHeader("x-codex-status-cache", cache);
  res.json(data);
});

app.post("/api/attention/acknowledgements", async (req, res) => {
  try {
    const rawStatus = await getStatus({ applyAttentionState: false });
    const allItems = rawStatus.attention?.items || [];
    const requestedIds = Array.isArray(req.body?.itemIds) ? req.body.itemIds.map((item) => String(item)).filter(Boolean) : [];
    const selected = req.body?.all
      ? allItems.filter((item) => item.tone !== "neutral")
      : allItems.filter((item) => requestedIds.includes(item.id));
    if (!selected.length) return res.status(400).json({ ok: false, error: "No matching attention items to acknowledge" });
    await acknowledgeAttentionItems(selected);
    const nextStatus = await getStatus();
    statusCache = { data: nextStatus, cachedAt: Date.now() };
    res.json({ ok: true, acknowledged: selected.map((item) => item.id), attention: nextStatus.attention });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || "Failed to acknowledge attention items" });
  }
});

app.delete("/api/attention/acknowledgements", async (req, res) => {
  try {
    const rawStatus = await getStatus({ applyAttentionState: false });
    const currentIds = (rawStatus.attention?.items || []).map((item) => item.id);
    const result = await clearAttentionAcknowledgements({ currentIds, all: Boolean(req.body?.all) });
    const nextStatus = await getStatus();
    statusCache = { data: nextStatus, cachedAt: Date.now() };
    res.json({ ok: true, cleared: result.cleared, attention: nextStatus.attention });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || "Failed to clear attention acknowledgements" });
  }
});

app.get("/api/notifications/external/status", async (_req, res) => {
  res.json({ ok: true, externalNotifications: await externalNotificationStatus() });
});

app.post("/api/notifications/external/test", async (_req, res) => {
  try {
    const item = {
      id: `test:${Date.now().toString(36)}`,
      type: "notification-test",
      tone: "active",
      title: "Codex Cloud 外部通知测试",
      body: "这是一条由云端 console 发送的测试通知。",
      time: new Date().toISOString(),
      action: "settings",
    };
    const result = await notifyAttentionItems([item], "manual-test");
    const status = await externalNotificationStatus();
    if (result.skipped) return res.status(400).json({ ok: false, result, externalNotifications: status });
    res.status(result.ok ? 200 : 502).json({ ok: result.ok, result, externalNotifications: status });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || "External notification test failed" });
  }
});

app.post("/api/notifications/external/check", async (_req, res) => {
  try {
    const result = await runExternalNotificationCheck("manual-check");
    const status = await externalNotificationStatus();
    res.status(result.ok || result.skipped ? 200 : 502).json({ ok: result.ok, result, externalNotifications: status });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || "External notification check failed" });
  }
});

app.get("/api/notifications/push/status", async (_req, res) => {
  try {
    res.json({ ok: true, pushNotifications: await pushNotificationStatus() });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || "Push notification status failed" });
  }
});

app.post("/api/notifications/push/subscribe", async (req, res) => {
  try {
    const subscription = normalizePushSubscription({
      ...(req.body?.subscription || req.body || {}),
      userAgent: req.get("user-agent") || req.body?.userAgent || "",
      lastSeenAt: new Date().toISOString(),
    });
    if (!subscription) return res.status(400).json({ ok: false, error: "Invalid push subscription" });
    const state = await ensurePushState(await readNotificationState());
    state.push.subscriptions[subscription.id] = {
      ...(state.push.subscriptions[subscription.id] || {}),
      ...subscription,
      createdAt: state.push.subscriptions[subscription.id]?.createdAt || subscription.createdAt,
      lastSeenAt: new Date().toISOString(),
    };
    await writeNotificationState(state);
    res.json({ ok: true, subscriptionId: subscription.id, pushNotifications: await pushNotificationStatus() });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || "Push subscribe failed" });
  }
});

app.delete("/api/notifications/push/subscribe", async (req, res) => {
  try {
    const endpoint = String(req.body?.endpoint || "").trim();
    const id = String(req.body?.id || (endpoint ? pushSubscriptionId(endpoint) : "")).trim();
    if (!id) return res.status(400).json({ ok: false, error: "Missing push subscription id" });
    const state = await ensurePushState(await readNotificationState());
    const existed = Boolean(state.push.subscriptions[id]);
    delete state.push.subscriptions[id];
    await writeNotificationState(state);
    res.json({ ok: true, removed: existed, pushNotifications: await pushNotificationStatus() });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || "Push unsubscribe failed" });
  }
});

app.post("/api/notifications/push/test", async (_req, res) => {
  try {
    const state = await ensurePushState(await readNotificationState());
    const item = {
      id: `push-test:${Date.now().toString(36)}`,
      type: "notification-test",
      tone: "active",
      title: "Codex Cloud Push 测试",
      body: "这是一条由云端 console 发送的浏览器 push 测试通知。",
      time: new Date().toISOString(),
      action: "settings",
    };
    state.push.lastTestAt = new Date().toISOString();
    const result = await sendPushNotifications(state, item, "manual-push-test");
    await writeNotificationState(state);
    const status = await pushNotificationStatus();
    res.status(result.ok ? 200 : 400).json({ ok: result.ok, result, pushNotifications: status });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || "Push notification test failed" });
  }
});

app.get("/healthz", async (_req, res) => {
  const { data, cache } = await getStatusForRoute();
  const health = data?.health || fastStatusFallback("health snapshot unavailable").health;
  res.setHeader("x-codex-status-cache", cache);
  if (data?.partial) res.setHeader("x-codex-health-partial", "true");
  const reachable =
    Boolean(health.layers?.ec2Console?.ok) &&
    (Boolean(health.layers?.appServer?.ok) || Boolean(health.layers?.codexAuth?.ok));
  const responseHealth =
    {
      ...health,
      ok: Boolean(health.ok),
      strictOk: Boolean(health.ok),
      partial: !health.ok && reachable,
    };
  res.status(responseHealth.strictOk ? 200 : 503).json(responseHealth);
});

app.post("/api/repos", async (req, res) => {
  const remote = String(req.body?.remote || req.body?.url || "").trim();
  const requestedName = String(req.body?.name || "").trim();
  const id = slugifyRepoId(req.body?.id || requestedName || remote);
  if (!id) return res.status(400).json({ ok: false, error: "Project name or remote is required" });
  if (repos.some((repo) => repo.id === id)) return res.status(409).json({ ok: false, error: `项目 ${id} 已存在` });

  const repo = normalizeCustomRepo({
    id,
    name: requestedName || id,
    remote,
    cloneUrl: repoCloneUrl(remote),
  }, repos.length);
  const targetPath = repo.path;
  if (!targetPath.startsWith(`${workspaceRoot}${path.sep}`)) {
    return res.status(400).json({ ok: false, error: "Project path escapes workspace root" });
  }

  await fs.mkdir(workspaceRoot, { recursive: true });
  if (repo.cloneUrl) {
    if (await exists(targetPath)) return res.status(409).json({ ok: false, error: `目录已存在: ${targetPath}` });
    const clone = await run("git", ["clone", repo.cloneUrl, targetPath], { timeout: 180_000, cwd: workspaceRoot });
    if (!clone.ok) return res.status(500).json({ ok: false, error: clone.stderr || clone.stdout || "git clone failed" });
  } else {
    await fs.mkdir(targetPath, { recursive: true });
    await run("git", ["init"], { timeout: 20_000, cwd: targetPath });
  }

  repos.push(repo);
  const customRepos = repos.filter((item) => item.custom).map((item) => ({
    id: item.id,
    name: item.name,
    remote: item.remote,
    cloneUrl: item.cloneUrl || repoCloneUrl(item.remote),
  }));
  await writeCustomRepos(customRepos);
  const session = await ensureChatSession(repo.id, "", "新会话");
  res.json({ ok: true, repo: await getRepo(repo), activeSessionId: session.id });
});

app.get("/api/codex/capabilities", async (_req, res) => {
  const [version, login, help, execHelp] = await Promise.all([
    run("codex", ["--version"], { timeout: 8_000 }),
    run("codex", ["login", "status"], { timeout: 8_000 }),
    run("codex", ["--help"], { timeout: 8_000 }),
    run("codex", ["exec", "--help"], { timeout: 8_000 }),
  ]);
  res.json({
    ok: version.ok && login.ok,
    version: version.stdout || version.stderr,
    login: login.stdout || login.stderr,
    commands: compactLines(help.stdout || help.stderr, 80),
    execOptions: compactLines(execHelp.stdout || execHelp.stderr, 80),
    webSurface: {
      mode: "codex app-server session host",
      covered: [
        "app-server thread/start and thread/resume",
        "app-server turn/start, turn/steer, turn/interrupt",
        "app-server model, config, permission, MCP, plugin, skill status",
        "app-server file read/write/search and command execution",
        "goal and context compaction through app-server thread APIs",
      ],
      debugCliEnabled: enableCliDebug,
      gaps: [
        "raw interactive CLI terminal is disabled in production unless CODEX_ENABLE_CLI_DEBUG=1",
        "shell completion installation UI is not exposed",
      ],
    },
  });
});

function normalizeCodexModelsResult(result = {}) {
  return (result?.data || []).map((model) => ({
    id: String(model.id || model.model),
    model: String(model.model || model.id),
    displayName: String(model.displayName || model.id || model.model),
    description: String(model.description || ""),
    hidden: Boolean(model.hidden),
    isDefault: Boolean(model.isDefault),
    upgrade: model.upgrade || null,
    defaultReasoningEffort: model.defaultReasoningEffort || "medium",
    supportedReasoningEfforts: (model.supportedReasoningEfforts || []).map((effort) => effort.reasoningEffort || effort).filter(Boolean),
    inputModalities: model.inputModalities || [],
    serviceTiers: model.serviceTiers || [],
    additionalSpeedTiers: model.additionalSpeedTiers || [],
  }));
}

async function readStoredModelListCache() {
  if (modelListCache) return modelListCache;
  try {
    const parsed = JSON.parse(await fs.readFile(codexModelsCachePath, "utf8"));
    if (parsed?.ok === true && parsed?.source === "app-server" && Array.isArray(parsed?.models) && parsed.models.length) {
      modelListCache = { data: parsed, cachedAt: Date.parse(parsed.cachedAt || "") || 0 };
      return modelListCache;
    }
  } catch {
    // Cache is optional; app-server remains the source of truth.
  }
  return null;
}

async function refreshModelList() {
  const response = await codexAppServerRequest("model/list", { includeHidden: false }, 45_000);
  if (!response.ok) {
    throw new Error(response.error || "model/list failed");
  }
  const data = {
    ok: true,
    source: "app-server",
    authoritative: true,
    models: normalizeCodexModelsResult(response.result || {}),
    cachedAt: new Date().toISOString(),
  };
  if (!data.models.length) throw new Error("model/list returned no models");
  modelListCache = { data, cachedAt: Date.now() };
  atomicWriteJson(codexModelsCachePath, data).catch(() => null);
  return data;
}

function startModelListRefresh() {
  if (modelListRefreshPromise) return modelListRefreshPromise;
  modelListRefreshPromise = refreshModelList()
    .catch((error) => {
      if (modelListCache?.data) return { ...modelListCache.data, refreshing: false, refreshError: sanitizeCloudPathText(error.message || String(error), 320) };
      throw error;
    })
    .finally(() => {
      modelListRefreshPromise = null;
    });
  return modelListRefreshPromise;
}

async function getModelListForRoute(options = {}) {
  const forceRefresh = options.forceRefresh === true;
  const cached = await readStoredModelListCache();
  const age = cached ? Date.now() - cached.cachedAt : Infinity;
  if (!forceRefresh && cached && age <= modelListCacheTtlMs) return { data: cached.data, cache: "fresh" };
  const refresh = startModelListRefresh();
  try {
    return {
      data: await Promise.race([refresh, deadline(modelListFirstResponseMs)]),
      cache: cached ? "refreshed" : "live",
    };
  } catch (error) {
    refresh.catch(() => null);
    if (cached) {
      return {
        data: {
          ...cached.data,
          stale: true,
          refreshing: true,
          refreshError: sanitizeCloudPathText(error.message || String(error), 320),
        },
        cache: "stale",
      };
    }
    return {
      data: {
        ok: false,
        source: "app-server-unavailable",
        authoritative: false,
        error: sanitizeCloudPathText(error.message || String(error), 320),
        models: [],
      },
      cache: "miss",
    };
  }
}

app.get("/api/codex/models", async (req, res) => {
  const forceRefresh = req.query?.refresh === "1" || req.query?.sync === "1";
  const { data, cache } = await getModelListForRoute({ forceRefresh });
  res.setHeader("x-codex-model-list-cache", cache);
  res.status(data.ok === false ? 502 : 200).json(data);
});

app.get("/api/codex/app-status", async (req, res) => {
  const repo = getRepoById(req.query?.repoId);
  const { data, cache } = await getCodexAppStatusForRoute(repo);
  res.setHeader("x-codex-app-status-cache", cache);
  res.status(data.ok === false || data.authoritative !== true || data.partial === true ? 503 : 200).json(data);
});

app.post("/api/codex/diagnostics", async (req, res) => {
  try {
    const repo = getRepoById(req.body?.repoId || req.query?.repoId);
    const diagnostics = await runCodexDiagnostics(repo);
    await writeDiagnosticsState({ latest: diagnostics });
    res.status(diagnostics.ok ? 200 : 207).json({ ok: diagnostics.ok, diagnostics });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || "Codex diagnostics failed" });
  }
});

app.post("/api/codex/account/login", async (req, res) => {
  const requestedType = String(req.body?.type || req.query?.type || "chatgptDeviceCode");
  const type = requestedType === "chatgpt" ? "chatgpt" : "chatgptDeviceCode";
  const params = type === "chatgpt" ? { type, codexStreamlinedLogin: true } : { type };
  const response = await codexAppServerRequest("account/login/start", params, 20_000);
  if (!response.ok) return res.status(500).json({ ok: false, error: response.error });
  const flow = accountLoginFlowFromResponse(response.result || {});
  res.json({ ok: true, flow, result: response.result || null, accountLogin: accountLoginSnapshot() });
});

app.post("/api/codex/account/login/cancel", async (req, res) => {
  const loginId = String(req.body?.loginId || req.query?.loginId || "").trim();
  if (!loginId) return res.status(400).json({ ok: false, error: "loginId is required" });
  const response = await codexAppServerRequest("account/login/cancel", { loginId }, 20_000);
  if (!response.ok) return res.status(500).json({ ok: false, error: response.error });
  const flow = cancelAccountLoginFlow(loginId, response.result || {});
  res.json({ ok: true, flow, result: response.result || null, accountLogin: accountLoginSnapshot() });
});

app.post("/api/codex/account/logout", async (_req, res) => {
  const response = await codexAppServerRequest("account/logout", undefined, 20_000);
  if (!response.ok) return res.status(500).json({ ok: false, error: response.error });
  res.json({ ok: true, result: response.result || null });
});

app.post("/api/codex/mcp/oauth-login", async (req, res) => {
  const name = String(req.body?.name || req.query?.name || "").trim();
  if (!name) return res.status(400).json({ ok: false, error: "MCP server name is required" });
  const response = await codexAppServerRequest("mcpServer/oauth/login", { name }, 20_000);
  if (!response.ok) return res.status(500).json({ ok: false, error: response.error });
  const authorizationUrl = response.result?.authorizationUrl || response.result?.authorization_url || "";
  res.json({ ok: true, name, authorizationUrl });
});

app.post("/api/codex/mcp/reload", async (_req, res) => {
  const response = await codexAppServerRequest("config/mcpServer/reload", undefined, 20_000);
  if (!response.ok) return res.status(500).json({ ok: false, error: response.error });
  res.json({ ok: true });
});

app.post("/api/codex/mcp/oauth-callback-relay", async (req, res) => {
  const result = await relayLoopbackHttp({
    port: req.body?.port,
    path: req.body?.path,
    query: req.body?.query || "",
  });
  res.status(result.statusCode || (result.ok ? 200 : 502));
  res.setHeader("Content-Type", result.headers?.["content-type"] || "text/html; charset=utf-8");
  res.send(result.body || "");
});

app.get("/api/codex/app-host/status", (_req, res) => {
  const client = getAppServerClient();
  res.json({
    ok: true,
    appHost: client.status(),
    activeTurns: activeTurns.size,
    activeCompactions: activeCompactions.size,
    activeJobs: activeJobSummaries({ includeEvents: true }),
  });
});

app.get("/api/codex/thread-state", async (req, res) => {
  const repo = getRepoById(req.query?.repoId);
  const resolved = await resolveSyncedChatSessionForRequest(repo, req.query?.sessionId);
  const { session, summary, requestedSessionId } = resolved;
  if (!session && requestedSessionId) return res.status(404).json({ ok: false, repoId: repo.id, error: "Unknown session" });
  if (!session && (!summary?.ok || summary.authoritative !== true)) {
    return res.status(503).json({
      ok: false,
      repoId: repo.id,
      source: summary?.source || "app-server-unavailable",
      authoritative: false,
      partial: true,
      error: summary?.error || "Codex app-server thread/list failed",
    });
  }
  if (!session) {
    res.setHeader("x-codex-thread-state-cache", "live");
    return res.json({ ...authoritativeEmptyThreadState(repo.id), repoId: repo.id, sessionId: null });
  }
  const state = await getThreadState(session, { timeout: appServerFastReadTimeoutMs });
  res.setHeader("x-codex-thread-state-cache", state.partial ? "partial" : state.refreshing ? "stale" : state.cached ? "fresh" : "live");
  res.status(state.ok === false ? 503 : 200).json({ ...state, repoId: repo.id, sessionId: session.id });
});

app.get("/api/codex/threads", async (req, res) => {
  const repo = getRepoById(req.query?.repoId);
  const listed = await syncAppServerThreads(repo);
  const summary = await getRepoSessions(repo.id, { sync: false });
  res.status(listed.ok ? 200 : 502).json({
    ok: listed.ok,
    repoId: repo.id,
    error: listed.ok ? null : listed.error,
    threads: listed.threads || [],
    sessions: summary.sessions,
    activeSessionId: summary.activeSessionId,
  });
});

app.get("/api/codex/thread-read", async (req, res) => {
  const repo = getRepoById(req.query?.repoId);
  const session = await resolveChatSessionForRequest(repo.id, req.query?.sessionId);
  if (!session) return res.status(404).json({ ok: false, repoId: repo.id, error: "Unknown session" });
  if (!session.codexSessionId) return res.status(400).json({ ok: false, error: "当前会话还没有 app-server thread。" });
  const response = await codexAppServerRequest("thread/read", { threadId: session.codexSessionId, includeTurns: true }, 20_000);
  if (!response.ok) return res.status(502).json({ ok: false, error: response.error });
  const messages = normalizeAppServerThreadMessages(response.result?.thread || {}, appServerNormalizerOptions(repo));
  await updateStoredSessionFromOfficialThread(session, repo, { ok: true, messages, thread: response.result?.thread || null }, { makeActive: false }).catch(() => null);
  res.json({
    ok: true,
    repoId: repo.id,
    sessionId: session.id,
    threadId: session.codexSessionId,
    thread: response.result?.thread || null,
    messages,
  });
});

app.get("/api/codex/git-diff-to-remote", async (req, res) => {
  const repo = getRepoById(req.query?.repoId);
  const response = await codexAppServerRequest("gitDiffToRemote", { cwd: repo.path }, 30_000);
  if (!response.ok) return res.status(502).json({ ok: false, repoId: repo.id, error: response.error });
  res.json({ ok: true, repoId: repo.id, diff: response.result || null });
});

app.get("/api/codex/review/summary", async (req, res) => {
  const repo = getRepoById(req.query?.repoId);
  if (!enableLocalReviewRead) {
    try {
      const snapshot = await buildAppServerReviewSnapshot(repo, {
        scope: "workspace",
        workspaceView: req.query?.workspaceView,
      });
      return res.json({ ok: true, source: "app-server-command", authoritative: true, data: snapshot.summary });
    } catch (error) {
      return res.status(502).json({ ok: false, source: "app-server-unavailable", error: error.message || "Failed to read app-server review summary" });
    }
  }
  await serveReviewGitRoute(req, res, "/codex-api/review/summary", {
    cwd: repo.path,
    workspaceView: req.query?.workspaceView,
  });
});

app.get("/api/codex/review/snapshot", async (req, res) => {
  const repo = getRepoById(req.query?.repoId);
  if (!enableLocalReviewRead) {
    try {
      const snapshot = await buildAppServerReviewSnapshot(repo, {
        scope: req.query?.scope,
        workspaceView: req.query?.workspaceView,
        baseBranch: req.query?.baseBranch,
      });
      return res.json({ ok: true, source: "app-server-command", authoritative: true, data: snapshot });
    } catch (error) {
      return res.status(502).json({ ok: false, source: "app-server-unavailable", error: error.message || "Failed to read app-server review snapshot" });
    }
  }
  await serveReviewGitRoute(req, res, "/codex-api/review/snapshot", {
    cwd: repo.path,
    scope: req.query?.scope,
    workspaceView: req.query?.workspaceView,
    baseBranch: req.query?.baseBranch,
    commitSha: req.query?.commitSha,
  });
});

app.get("/api/codex/review/pr-context", async (req, res) => {
  if (!enableLocalReviewRead) {
    return sendAppServerOnlyError(res, "Local PR context is disabled. Use app-server review workflow.");
  }
  const repo = getRepoById(req.query?.repoId);
  await serveReviewGitRoute(req, res, "/codex-api/review/pr-context", {
    cwd: repo.path,
  });
});

app.post("/api/codex/review/action", async (req, res) => {
  if (!enableLocalReviewMutation) {
    return sendAppServerOnlyError(res, "Local review mutation is disabled. Use app-server review/start and file-change actions.");
  }
  const repo = getRepoById(req.body?.repoId);
  await serveReviewGitRoute(req, res, "/codex-api/review/action", {}, {
    ...req.body,
    cwd: repo.path,
  });
});

app.post("/api/codex/review/pr-comment", async (req, res) => {
  if (!enableLocalReviewMutation) {
    return sendAppServerOnlyError(res, "Local PR comment mutation is disabled. Use app-server review workflow.");
  }
  const repo = getRepoById(req.body?.repoId);
  await serveReviewGitRoute(req, res, "/codex-api/review/pr-comment", {}, {
    ...req.body,
    cwd: repo.path,
  });
});

app.post("/api/codex/review/git/init", async (req, res) => {
  if (!enableLocalReviewMutation) {
    return sendAppServerOnlyError(res, "Local git initialization is disabled. Repository setup must be handled outside the app-server session path.");
  }
  const repo = getRepoById(req.body?.repoId);
  await serveReviewGitRoute(req, res, "/codex-api/review/git/init", {}, {
    ...req.body,
    cwd: repo.path,
  });
});

app.post("/api/codex/thread-goal", async (req, res) => {
  const repo = getRepoById(req.body?.repoId);
  const session = await ensureChatSession(repo.id, String(req.body?.sessionId || ""));
  if (!session.codexSessionId) return res.status(400).json({ ok: false, error: "先发送一条消息建立 app-server thread，再设置 goal。" });
  const objective = String(req.body?.objective || "").trim();
  if (!objective) return res.status(400).json({ ok: false, error: "Goal objective is required" });
  const tokenBudget = Number(req.body?.tokenBudget || 0);
  const response = await codexAppServerRequest("thread/goal/set", {
    threadId: session.codexSessionId,
    objective,
    status: req.body?.status || "active",
    tokenBudget: tokenBudget > 0 ? tokenBudget : null,
  }, 20_000);
  if (!response.ok) return res.status(500).json({ ok: false, error: response.error });
  await updateSessionRuntime(repo.id, session.id, { goal: response.result?.goal || null });
  patchThreadStateCache(session, { goal: response.result?.goal || null });
  res.json({ ok: true, goal: response.result?.goal || null });
});

app.delete("/api/codex/thread-goal", async (req, res) => {
  const repo = getRepoById(req.query?.repoId);
  const session = await ensureChatSession(repo.id, String(req.query?.sessionId || ""));
  if (!session.codexSessionId) return res.status(400).json({ ok: false, error: "当前会话还没有 app-server thread。" });
  const response = await codexAppServerRequest("thread/goal/clear", { threadId: session.codexSessionId }, 20_000);
  if (!response.ok) return res.status(500).json({ ok: false, error: response.error });
  await updateSessionRuntime(repo.id, session.id, { goal: null });
  patchThreadStateCache(session, { goal: null });
  res.json({ ok: true, goal: null });
});

app.post("/api/codex/thread-name", async (req, res) => {
  const repo = getRepoById(req.body?.repoId);
  const session = await ensureChatSession(repo.id, String(req.body?.sessionId || ""));
  if (!session.codexSessionId) return res.status(400).json({ ok: false, error: "当前会话还没有 app-server thread。" });
  const name = sessionTitle(req.body?.title || req.body?.name || "");
  if (!name) return res.status(400).json({ ok: false, error: "Thread name is required" });
  const response = await codexAppServerRequest("thread/name/set", { threadId: session.codexSessionId, name }, 20_000);
  if (!response.ok) return res.status(500).json({ ok: false, error: response.error });
  await updateSessionRuntime(repo.id, session.id, { title: name });
  res.json({ ok: true, repoId: repo.id, sessionId: session.id, title: name, thread: response.result?.thread || null });
});

app.post("/api/codex/thread-fork", async (req, res) => {
  const repo = getRepoById(req.body?.repoId);
  const session = await ensureChatSession(repo.id, String(req.body?.sessionId || ""));
  if (!session.codexSessionId) return res.status(400).json({ ok: false, error: "当前会话还没有 app-server thread。" });
  const response = await codexAppServerRequest("thread/fork", { threadId: session.codexSessionId, cwd: repo.path }, 30_000);
  if (!response.ok) return res.status(500).json({ ok: false, error: response.error });
  const thread = response.result?.thread || response.result?.data || response.result || {};
  const threadId = thread.id || response.result?.threadId;
  if (!threadId) return res.status(500).json({ ok: false, error: "thread/fork did not return a thread id", raw: response.result });
  const forkSession = normalizeSession(
    {
      id: sessionId(),
      repoId: repo.id,
      title: `${session.title || "会话"} 分支`,
      messages: [],
      codexSessionId: String(threadId),
      model: session.model,
      reasoning: session.reasoning,
      sandbox: session.sandbox,
      approval: session.approval,
      search: session.search,
      tokenUsage: null,
      goal: null,
    },
    repo.id,
  );
  await mutateChatStore((current) => {
    current.sessions[forkSession.id] = forkSession;
    current.activeByRepo[repo.id] = forkSession.id;
  });
  const messages = await getChatMessages(repo.id, forkSession.id, { timeout: appServerFastReadTimeoutMs });
  const summary = await getRepoSessions(repo.id, { sync: false });
  res.json({ ok: true, repoId: repo.id, activeSessionId: forkSession.id, threadId: String(threadId), sessions: summary.sessions, messages });
});

app.post("/api/codex/thread-archive", async (req, res) => {
  const repo = getRepoById(req.body?.repoId);
  const session = await ensureChatSession(repo.id, String(req.body?.sessionId || ""));
  if (!session.codexSessionId) return res.status(400).json({ ok: false, error: "当前会话还没有 app-server thread。" });
  const response = await codexAppServerRequest("thread/archive", { threadId: session.codexSessionId }, 20_000);
  if (!response.ok) return res.status(500).json({ ok: false, error: response.error });
  await mutateChatStore((store) => {
    delete store.sessions[session.id];
    const remaining = Object.values(store.sessions)
      .filter((item) => item.repoId === repo.id)
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    store.activeByRepo[repo.id] = remaining[0]?.id || "";
  });
  const summary = await getRepoSessions(repo.id, { sync: false });
  const active = summary.activeSessionId
    ? await resolveChatSessionForRead(repo.id, summary.activeSessionId, { strictHint: true })
    : await ensureChatSession(repo.id);
  const messages = active ? await getChatMessages(repo.id, active.id, { timeout: appServerFastReadTimeoutMs }) : [];
  res.json({ ok: true, repoId: repo.id, activeSessionId: active?.id || summary.activeSessionId || "", sessions: summary.sessions, messages });
});

app.post("/api/codex/thread-compact", async (req, res) => {
  const repo = getRepoById(req.body?.repoId);
  const session = await ensureChatSession(repo.id, String(req.body?.sessionId || ""));
  if (!session.codexSessionId) return res.status(400).json({ ok: false, error: "先发送一条消息建立 app-server thread，再压缩上下文。" });
  const runtime = normalizeRuntime(req.body, session);
  const job = await startCompactJob(repo, session, runtime);
  const result = await job.promise;
  res.status(result.ok ? 200 : 500).json({
    ok: result.ok,
    error: result.error || job.error || null,
    sessionId: session.id,
    threadId: session.codexSessionId,
    tokenUsage: job.latestTokenUsage || session.tokenUsage || null,
  });
  if (result.ok) patchThreadStateCache(session, { tokenUsage: job.latestTokenUsage || session.tokenUsage || null });
});

app.post("/api/codex/thread-compact/stream", async (req, res) => {
  const repo = getRepoById(req.body?.repoId);
  const session = await ensureChatSession(repo.id, String(req.body?.sessionId || ""));
  if (!session.codexSessionId) return res.status(400).json({ ok: false, error: "先发送一条消息建立 app-server thread，再压缩上下文。" });
  const runtime = normalizeRuntime(req.body, session);

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  try {
    const job = await startCompactJob(repo, session, runtime);
    subscribeJobEvents(job, res);
    await job.promise;
  } catch (error) {
    writeSse(res, "error", { message: error.message || "主动压缩失败" });
    writeSse(res, "done", { ok: false, code: 1, sessionId: session.id, threadId: session.codexSessionId, error: error.message || "主动压缩失败" });
  } finally {
    if (!res.writableEnded && !res.destroyed) res.end();
  }
});

app.post("/api/codex/review/stream", async (req, res) => {
  const repo = getRepoById(req.body?.repoId);
  const session = await ensureChatSession(repo.id, String(req.body?.sessionId || ""), "Review");
  const runtime = normalizeRuntime(req.body, session);
  const targetType = String(req.body?.targetType || "uncommittedChanges");
  const target =
    targetType === "baseBranch"
      ? { type: "baseBranch", branch: String(req.body?.branch || "main") }
      : targetType === "commit"
        ? { type: "commit", sha: String(req.body?.sha || ""), title: req.body?.title ? String(req.body.title) : null }
        : targetType === "custom"
          ? { type: "custom", instructions: String(req.body?.instructions || "Review current changes.") }
          : { type: "uncommittedChanges" };
  if (target.type === "commit" && !target.sha) return res.status(400).json({ ok: false, error: "commit review requires sha" });
  const delivery = req.body?.delivery === "detached" ? "detached" : "inline";

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  try {
    const job = await startReviewJob(repo, session, runtime, target, delivery);
    subscribeJobEvents(job, res);
    await job.promise;
  } catch (error) {
    writeSse(res, "error", { message: error.message || "启动 review 失败" });
    writeSse(res, "done", { ok: false, code: 1, sessionId: session.id, error: error.message || "启动 review 失败" });
  } finally {
    if (!res.writableEnded && !res.destroyed) res.end();
  }
});

app.post("/api/codex/auto-compact", async (req, res) => {
  const enabled = Boolean(req.body?.enabled);
  const rawLimit = Number(req.body?.tokenLimit || 0);
  const tokenLimit = enabled ? Math.max(8000, Math.floor(rawLimit || 160000)) : null;
  const scope = req.body?.scope === "total" ? "total" : "body_after_prefix";
  const limitResponse = await writeCodexConfigValue("model_auto_compact_token_limit", tokenLimit);
  if (!limitResponse.ok) return res.status(500).json({ ok: false, error: limitResponse.error });
  const scopeResponse = await writeCodexConfigValue("model_auto_compact_token_limit_scope", enabled ? scope : null);
  if (!scopeResponse.ok) return res.status(500).json({ ok: false, error: scopeResponse.error });
  res.json({ ok: true, config: (await getCodexAppConfig()).config });
});

app.post("/api/codex/turn-steer", async (req, res) => {
  const message = String(req.body?.message || "").trim();
  const repo = getRepoById(req.body?.repoId);
  const session = await ensureChatSession(repo.id, String(req.body?.sessionId || ""));
  if (!message) return res.status(400).json({ ok: false, error: "Message is required" });
  const active = activeTurns.get(`${repo.id}:${session.id}`);
  if (!active) return res.status(409).json({ ok: false, error: "当前没有正在运行的 turn。" });
  await getAppServerClient().request("turn/steer", {
    threadId: active.threadId,
    expectedTurnId: active.turnId,
    input: [{ type: "text", text: message, text_elements: [] }],
  }, 20_000);
  emitJobEvent(active, "status", { text: "已向当前 turn 补充指令" });
  res.json({ ok: true, sessionId: session.id, threadId: active.threadId, turnId: active.turnId });
});

app.post("/api/codex/turn-interrupt", async (req, res) => {
  const repo = getRepoById(req.body?.repoId);
  const session = await ensureChatSession(repo.id, String(req.body?.sessionId || ""));
  const active = activeTurns.get(`${repo.id}:${session.id}`);
  if (!active) return res.status(409).json({ ok: false, error: "当前没有正在运行的 turn。" });
  await getAppServerClient().request("turn/interrupt", { threadId: active.threadId, turnId: active.turnId }, 20_000);
  emitJobEvent(active, "status", { text: "已请求打断当前 turn" });
  res.json({ ok: true, sessionId: session.id, threadId: active.threadId, turnId: active.turnId });
});

app.get("/api/logs/:name", async (req, res) => {
  const name = path.basename(req.params.name);
  const filePath = path.join(logsRoot, name);
  if (!(await exists(filePath))) {
    return res.json({
      ok: true,
      unavailable: true,
      name,
      content: "云端日志文件暂未生成或已轮转。",
    });
  }
  const content = await fs.readFile(filePath, "utf8").catch((error) => `Failed to read log: ${error.message}`);
  res.json({ ok: true, name, content });
});

app.get("/api/audit/events", async (req, res) => {
  const store = await readAuditEvents();
  const type = req.query?.type ? String(req.query.type) : "";
  const repoId = req.query?.repoId ? String(req.query.repoId) : "";
  const events = store.events.map(auditEventForStatus).filter((event) => {
    if (type && event.type !== type) return false;
    if (repoId && event.repoId !== repoId) return false;
    return true;
  });
  res.json({ ok: true, events: events.slice(0, 100) });
});

app.post("/api/repos/:id/pull", async (req, res) => {
  const repo = repos.find((item) => item.id === req.params.id);
  if (!repo) return res.status(404).json({ ok: false, output: "Unknown repository" });
  if (!(await exists(repo.path))) {
    if (!allowLocalFallback) return res.status(503).json({ ok: false, output: "Repository path is not available", source: "app-server-unavailable" });
    return res.json({ ok: true, mocked: true, output: `${repo.name}: mock pull completed` });
  }
  const result = await run("git", ["-C", repo.path, "pull", "--ff-only"], { timeout: 60_000 });
  res.json({ ok: result.ok, output: result.stdout || result.stderr });
});

app.get("/api/chat/search", async (req, res) => {
  const query = String(req.query?.q || req.query?.query || "").trim();
  const limit = Math.min(Math.max(Number(req.query?.limit || 16), 1), 40);
  if (query.length < 2) return res.json({ ok: true, query, sessions: [], errors: {} });

  const repoId = String(req.query?.repoId || "").trim();
  const searchRepos = repoId ? [getRepoById(repoId)] : repos;
  const perRepoLimit = repoId ? limit : Math.max(6, Math.ceil(limit / Math.max(searchRepos.length, 1)) + 4);
  const results = await Promise.all(
    searchRepos.map(async (repo) => {
      const listed = await listAppServerThreads(repo, { searchTerm: query, limit: perRepoLimit });
      if (!listed.ok) return { repoId: repo.id, sessions: [], error: listed.error };
      return { repoId: repo.id, sessions: await upsertAppServerThreads(repo, listed.threads), error: null };
    }),
  );
  const sessions = results
    .flatMap((result) => result.sessions)
    .sort((a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime())
    .slice(0, limit);
  const errors = Object.fromEntries(results.filter((result) => result.error).map((result) => [result.repoId, result.error]));
  res.json({ ok: true, query, sessions, errors });
});

app.get("/api/chat/sessions", async (req, res) => {
  const repo = getRepoById(req.query?.repoId);
  const summary = await getRepoSessions(repo.id, { timeout: appServerFastReadTimeoutMs, requireAppServerSync: false });
  const requestedSessionId = String(req.query?.sessionId || "");
  if (!summary.ok) {
    if (requestedSessionId) {
      const store = await readChatStore();
      const requested = findStoredSessionByHint(store, repo.id, requestedSessionId);
      if (requested && !requested.codexSessionId) {
        return res.json({
          ok: true,
          degraded: true,
          repoId: repo.id,
          source: "local-draft",
          authoritative: false,
          sessionListSource: summary.source || "app-server-unavailable",
          sessionListAuthoritative: false,
          activeSessionId: requested.id,
          sessions: summary.sessions,
          messages: requested.messages || [],
          error: summary.error || "Codex app-server thread/list failed",
        });
      }
    }
    return res.status(503).json({
      ok: false,
      degraded: true,
      repoId: repo.id,
      source: summary.source || "app-server-unavailable",
      authoritative: false,
      error: summary.error || "Codex app-server thread/list failed",
      activeSessionId: summary.activeSessionId,
      sessions: summary.sessions,
      messages: [],
    });
  }
  if (!requestedSessionId && summary.authoritative !== true) {
    return res.status(503).json({
      ok: false,
      degraded: true,
      repoId: repo.id,
      source: summary.source,
      authoritative: false,
      sessionListSource: summary.source,
      sessionListAuthoritative: false,
      activeSessionId: summary.activeSessionId,
      sessions: summary.sessions,
      messages: [],
      error: summary.error || "Codex app-server thread/list failed",
    });
  }
  const active = requestedSessionId
    ? await resolveChatSessionForRead(repo.id, requestedSessionId, { strictHint: true })
    : summary.activeSessionId
      ? await resolveChatSessionForRead(repo.id, summary.activeSessionId, { strictHint: true })
      : null;
  if (!active) {
    return res.json({
      ok: true,
      repoId: repo.id,
      source: summary.source,
      authoritative: summary.authoritative === true,
      sessionListSource: summary.source,
      sessionListAuthoritative: summary.authoritative === true,
      activeSessionId: null,
      sessions: summary.sessions,
      messages: [],
    });
  }
  if (active.codexSessionId) {
    await refreshSessionRuntimeFromAppServer(repo, active, { timeout: appServerFastReadTimeoutMs }).catch(() => active);
  }
  const messages = await getChatMessages(repo.id, active.id, { timeout: appServerFastReadTimeoutMs });
  const refreshedSummary = await getRepoSessions(repo.id, { sync: false });
  const activeIsAppServer = Boolean(active.codexSessionId);
  res.json({
    ok: true,
    repoId: repo.id,
    source: activeIsAppServer ? summary.source : "local-draft",
    authoritative: activeIsAppServer ? summary.authoritative === true : false,
    sessionListSource: summary.source,
    sessionListAuthoritative: summary.authoritative === true,
    activeSessionId: active.id,
    sessions: refreshedSummary.sessions,
    messages,
  });
});

app.post("/api/chat/sessions", async (req, res) => {
  const repo = getRepoById(req.body?.repoId);
  const session = normalizeSession(
    { id: sessionId(), repoId: repo.id, title: sessionTitle(req.body?.title || "新会话"), messages: [] },
    repo.id,
  );
  await mutateChatStore((store) => {
    store.sessions[session.id] = session;
    store.activeByRepo[repo.id] = session.id;
    compactEmptyDraftSessions(store, repo.id, session.id);
  });
  const summary = await getRepoSessions(repo.id, { sync: false, preserveLocalActive: true });
  res.json({ ok: true, repoId: repo.id, activeSessionId: session.id, sessions: summary.sessions, messages: [] });
});

app.post("/api/chat/sessions/:id/select", async (req, res) => {
  const repo = getRepoById(req.body?.repoId || req.query?.repoId);
  const session = await mutateChatStore((store) => {
    const selected = store.sessions[req.params.id];
    if (!selected || selected.repoId !== repo.id) return null;
    store.activeByRepo[repo.id] = selected.id;
    return selected;
  });
  if (!session || session.repoId !== repo.id) return res.status(404).json({ ok: false, error: "Unknown session" });
  if (session.codexSessionId) await refreshSessionRuntimeFromAppServer(repo, session, { timeout: appServerFastReadTimeoutMs });
  const messages = await getChatMessages(repo.id, session.id, { timeout: appServerFastReadTimeoutMs });
  const summary = await getRepoSessions(repo.id, { sync: false, preserveLocalActive: !session.codexSessionId });
  res.json({ ok: true, repoId: repo.id, activeSessionId: session.id, sessions: summary.sessions, messages });
});

app.patch("/api/chat/sessions/:id/runtime", async (req, res) => {
  const repo = getRepoById(req.body?.repoId || req.query?.repoId);
  const store = await readChatStore();
  const session = store.sessions[req.params.id];
  if (!session || session.repoId !== repo.id) return res.status(404).json({ ok: false, error: "Unknown session" });

  const requestedRuntime = normalizeRuntime(req.body, session);
  const storedRuntime = normalizeRuntime({}, session);
  const turnRuntimeChanged =
    requestedRuntime.model !== storedRuntime.model || requestedRuntime.reasoning !== storedRuntime.reasoning;
  const modelList = await getModelListForRoute();
  const availableModels = Array.isArray(modelList.data?.models) ? modelList.data.models : [];
  const selectedModel = availableModels.find((model) => model.id === requestedRuntime.model);
  if (availableModels.length && !selectedModel) {
    return res.status(400).json({ ok: false, error: `Unknown Codex model: ${requestedRuntime.model}` });
  }
  if (
    selectedModel?.supportedReasoningEfforts?.length &&
    !selectedModel.supportedReasoningEfforts.includes(requestedRuntime.reasoning)
  ) {
    return res.status(400).json({
      ok: false,
      error: `${requestedRuntime.model} does not support reasoning effort ${requestedRuntime.reasoning}`,
    });
  }
  let runtime = requestedRuntime;
  let appServerSynced = false;
  let appServerRuntime = null;
  let pendingTurnRuntime = null;
  let thread = null;

  if (session.codexSessionId) {
    const response = await codexAppServerRequest(
      "thread/resume",
      { threadId: session.codexSessionId, ...appServerThreadParams(repo, requestedRuntime) },
      20_000,
    );
    if (!response.ok) {
      return res.status(502).json({
        ok: false,
        error: response.error,
        repoId: repo.id,
        sessionId: session.id,
        runtime: normalizeRuntime({}, session),
        appServerSynced: false,
      });
    }
    appServerSynced = true;
    thread = response.result?.thread || null;
    appServerRuntime = runtimeFromAppServerSettings(response.result || {}, requestedRuntime);
    if (turnRuntimeChanged || session.pendingTurnRuntime) {
      pendingTurnRuntime = {
        model: requestedRuntime.model,
        reasoning: requestedRuntime.reasoning,
        updatedAt: new Date().toISOString(),
      };
    }
    runtime = requestedRuntime;
    rememberOwner({ threadId: session.codexSessionId }, { repoId: repo.id, sessionId: session.id });
  }

  const updated = await updateSessionRuntime(
    repo.id,
    session.id,
    { ...runtime, pendingTurnRuntime },
    { makeActive: req.body?.makeActive !== false },
  );
  if (updated) {
    patchThreadStateCache(updated, { runtime: normalizeRuntime({}, updated) });
  }
  const summary = await getRepoSessions(repo.id, { sync: false, preserveLocalActive: req.body?.makeActive !== false && !session.codexSessionId });
  res.json({
    ok: true,
    repoId: repo.id,
    sessionId: session.id,
    runtime: normalizeRuntime({}, updated || session),
    session: updated ? sessionSummary(updated) : null,
    sessions: summary.sessions,
    activeSessionId: summary.activeSessionId,
    appServerSynced,
    appServerRuntime,
    appliesOnNextTurn: Boolean(pendingTurnRuntime),
    thread,
  });
});

app.get("/api/chat/sessions/:id/draft", async (req, res) => {
  const repo = getRepoById(req.query?.repoId);
  const store = await readChatStore();
  const session = findStoredSessionByHint(store, repo.id, req.params.id);
  if (!session) return res.status(404).json({ ok: false, error: "Unknown session" });
  res.json({ ok: true, repoId: repo.id, sessionId: session.id, draft: normalizeChatDraft(session.draft || {}) });
});

app.patch("/api/chat/sessions/:id/draft", async (req, res) => {
  const repo = getRepoById(req.body?.repoId || req.query?.repoId);
  const draft = normalizeChatDraft({
    input: req.body?.input || "",
    attachments: Array.isArray(req.body?.attachments) ? req.body.attachments : [],
    updatedAt: new Date().toISOString(),
  });
  const updated = await mutateChatStore((store) => {
    const session = findStoredSessionByHint(store, repo.id, req.params.id);
    if (!session) return null;
    const next = normalizeSession({ ...session, draft, updatedAt: session.updatedAt || new Date().toISOString() }, repo.id);
    store.sessions[next.id] = next;
    return next;
  });
  if (!updated) return res.status(404).json({ ok: false, error: "Unknown session" });
  const summary = await getRepoSessions(repo.id, { sync: false, preserveLocalActive: true });
  res.json({ ok: true, repoId: repo.id, sessionId: updated.id, draft: updated.draft, sessions: summary.sessions });
});

app.delete("/api/chat/sessions/:id/draft", async (req, res) => {
  const repo = getRepoById(req.query?.repoId);
  const updated = await mutateChatStore((store) => {
    const session = findStoredSessionByHint(store, repo.id, req.params.id);
    if (!session) return null;
    const next = normalizeSession({ ...session, draft: { input: "", attachments: [], updatedAt: null } }, repo.id);
    store.sessions[next.id] = next;
    return next;
  });
  if (!updated) return res.status(404).json({ ok: false, error: "Unknown session" });
  const summary = await getRepoSessions(repo.id, { sync: false, preserveLocalActive: true });
  res.json({ ok: true, repoId: repo.id, sessionId: updated.id, draft: updated.draft, sessions: summary.sessions });
});

app.delete("/api/chat/sessions/:id", async (req, res) => {
  const repo = getRepoById(req.query?.repoId);
  const store = await readChatStore();
  const session = store.sessions[req.params.id];
  if (!session || session.repoId !== repo.id) return res.status(404).json({ ok: false, error: "Unknown session" });
  const activeTurn = activeTurns.get(makeSessionKey(repo.id, session.id));
  const activeCompact = activeCompactions.get(makeSessionKey(repo.id, session.id));
  if (activeTurn || activeCompact) {
    if (String(req.query?.force || "") !== "1") {
      return res.status(409).json({ ok: false, error: "Session has an active Codex job; interrupt it before deletion" });
    }
    if (activeCompact) {
      return res.status(409).json({ ok: false, error: "Active compaction cannot be deleted safely; wait for it to finish" });
    }
    activeTurn.cancelRequested = true;
    if (activeTurn.threadId && activeTurn.turnId) {
      await getAppServerClient()
        .request("turn/interrupt", { threadId: activeTurn.threadId, turnId: activeTurn.turnId }, 20_000)
        .catch(() => null);
    }
    await Promise.race([activeTurn.promise, new Promise((resolve) => setTimeout(resolve, 10_000))]);
    if (!activeTurn.completed) {
      return res.status(409).json({ ok: false, error: "Session cancellation is still pending; retry deletion shortly" });
    }
  }
  let archived = false;
  if (session.codexSessionId) {
    const response = await codexAppServerRequest("thread/archive", { threadId: session.codexSessionId }, 20_000);
    if (!response.ok) return res.status(500).json({ ok: false, error: response.error });
    archived = true;
  }
  const uploadCleanup = await cleanupSessionUploadFiles(repo, session, store);
  await mutateChatStore((current) => {
    const currentSession = current.sessions[req.params.id];
    if (!currentSession || currentSession.repoId !== repo.id) return;
    const previousActiveId = current.activeByRepo[repo.id] || "";
    delete current.sessions[req.params.id];
    const remaining = Object.values(current.sessions)
      .filter((item) => item.repoId === repo.id)
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    current.activeByRepo[repo.id] = previousActiveId && current.sessions[previousActiveId] ? previousActiveId : remaining[0]?.id || "";
  });
  const summary = await getRepoSessions(repo.id, { sync: false, allowLocalActive: true });
  const active = summary.activeSessionId
    ? await resolveChatSessionForRead(repo.id, summary.activeSessionId, { strictHint: true })
    : null;
  const messages = active ? await getChatMessages(repo.id, active.id, { timeout: appServerFastReadTimeoutMs }) : [];
  res.json({
    ok: true,
    repoId: repo.id,
    deletedSessionId: session.id,
    activeSessionId: active?.id || summary.activeSessionId || "",
    sessions: summary.sessions,
    messages,
    archived,
    uploadCleanup,
  });
});

app.get("/api/chat/history", async (req, res) => {
  const repo = getRepoById(req.query?.repoId);
  const resolved = await resolveSyncedChatSessionForRequest(repo, req.query?.sessionId);
  const { session, summary, requestedSessionId } = resolved;
  if (!session && requestedSessionId) return res.status(404).json({ ok: false, repoId: repo.id, error: "Unknown session" });
  if (!session && (!summary?.ok || summary.authoritative !== true)) {
    return res.status(503).json({
      ok: false,
      degraded: true,
      repoId: repo.id,
      source: summary?.source || "app-server-unavailable",
      authoritative: false,
      error: summary?.error || "Codex app-server thread/list failed",
      activeSessionId: null,
      sessions: summary?.sessions || [],
      messages: [],
    });
  }
  if (!session) {
    return res.json({
      ok: true,
      repoId: repo.id,
      source: "app-server",
      authoritative: true,
      activeSessionId: null,
      sessions: summary.sessions,
      messages: [],
    });
  }
  const messages = await getChatMessages(repo.id, session.id, { timeout: appServerFastReadTimeoutMs });
  res.json({
    ok: true,
    repoId: repo.id,
    activeSessionId: session.id,
    sessions: (await getRepoSessions(repo.id, { sync: false })).sessions,
    messages,
  });
});

app.get("/api/chat/active", async (req, res) => {
  const repo = getRepoById(req.query?.repoId);
  const resolved = await resolveSyncedChatSessionForRequest(repo, req.query?.sessionId);
  const { session, summary, requestedSessionId } = resolved;
  if (!session && requestedSessionId) return res.status(404).json({ ok: false, repoId: repo.id, error: "Unknown session" });
  if (!session && (!summary?.ok || summary.authoritative !== true)) {
    return res.status(503).json({
      ok: false,
      degraded: true,
      repoId: repo.id,
      source: summary?.source || "app-server-unavailable",
      authoritative: false,
      partial: true,
      error: summary?.error || "Codex app-server thread/list failed",
      sessionId: null,
      threadId: null,
      threadState: null,
      turn: null,
      compact: null,
    });
  }
  if (!session) {
    return res.json({
      ok: true,
      repoId: repo.id,
      sessionId: null,
      threadId: null,
      source: "app-server",
      authoritative: true,
      partial: false,
      threadState: authoritativeEmptyThreadState(repo.id),
      turn: null,
      compact: null,
    });
  }
  const key = makeSessionKey(repo.id, session.id);
  const turn = activeTurns.get(key);
  const compact = activeCompactions.get(key);
  const threadState = session.codexSessionId
    ? await getThreadState(session, { timeout: appServerFastReadTimeoutMs })
    : fastThreadStateFallback(session, "draft session has no app-server thread");
  const summarize = (job) =>
    job
      ? {
          id: job.id,
          kind: job.kind,
          repoId: job.repoId,
          sessionId: job.sessionId,
          threadId: job.threadId,
          turnId: job.turnId,
          startedAt: job.startedAt,
          completed: job.completed,
          ok: job.ok,
          code: job.code,
          error: job.error,
          events: job.events.slice(-80),
        }
      : null;
  res.json({
    ok: true,
    repoId: repo.id,
    sessionId: session.id,
    threadId: session.codexSessionId || null,
    source: session.codexSessionId ? "app-server" : "draft",
    authoritative: session.codexSessionId ? threadState.authoritative === true : false,
    partial: session.codexSessionId ? threadState.partial === true : true,
    threadState: {
      ok: threadState.ok === true,
      source: threadState.source || null,
      authoritative: threadState.authoritative === true,
      partial: threadState.partial === true,
      threadId: threadState.threadId || session.codexSessionId || null,
      tokenUsage: threadState.tokenUsage || null,
      goal: threadState.goal || null,
      runtime: threadState.runtime || normalizeRuntime({}, session),
    },
    turn: summarize(turn),
    compact: summarize(compact),
  });
});

app.get("/api/chat/job-events", async (req, res) => {
  const repo = getRepoById(req.query?.repoId);
  const session = await resolveChatSessionForRequest(repo.id, req.query?.sessionId);
  if (!session) return res.status(404).json({ ok: false, repoId: repo.id, error: "Unknown session" });
  const key = makeSessionKey(repo.id, session.id);
  const requestedKind = String(req.query?.kind || "turn");
  const job = requestedKind === "compact" ? activeCompactions.get(key) : activeTurns.get(key);

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  if (!job) {
    const threadState = session.codexSessionId
      ? await getThreadState(session, { timeout: appServerFastReadTimeoutMs }).catch(() => null)
      : null;
    writeSse(res, "state", {
      source: "process-local",
      eventReplay: false,
      appServerThreadState: threadState
        ? { source: threadState.source || null, authoritative: threadState.authoritative === true, partial: threadState.partial === true }
        : null,
    });
    writeSse(res, "done", { ok: true, code: 0, sessionId: session.id, repoId: repo.id, inactive: true, source: "process-local", eventReplay: false });
    res.end();
    return;
  }

  subscribeJobEvents(job, res);
  await job.promise;
  if (!res.writableEnded && !res.destroyed) res.end();
});

app.delete("/api/chat/history", async (req, res) => {
  const repo = getRepoById(req.query?.repoId);
  const session = await ensureChatSession(repo.id, String(req.query?.sessionId || ""));
  if (session.codexSessionId) {
    return res.status(409).json({
      ok: false,
      error: "app-server thread history cannot be cleared from the web cache. Archive the thread or start a new session.",
    });
  }
  const cleared = await saveChatMessages(repo.id, session.id, []);
  await updateSessionRuntime(repo.id, cleared.id, { draft: { input: "", attachments: [], updatedAt: null } });
  res.json({ ok: true, repoId: repo.id, activeSessionId: cleared.id, sessions: (await getRepoSessions(repo.id, { sync: false, preserveLocalActive: true })).sessions, messages: [] });
});

app.post("/api/uploads", async (req, res) => {
  try {
    const payload = await uploadRequestPayload(req);
    const repo = getRepoById(payload.repoId);
    const incoming = Array.isArray(payload.files) ? payload.files.slice(0, maxUploadFiles) : [];
    if (!incoming.length) return res.status(400).json({ ok: false, error: "No files uploaded" });
    const uploadDir = await assertRepoPathAccess(
      repo,
      path.join(".codex-cloud", "uploads", new Date().toISOString().slice(0, 10)),
      { allowMissing: true },
    );
    const mkdirResponse = await codexAppServerRequest(
      "command/exec",
      {
        command: ["/bin/bash", "-lc", `mkdir -p ${shellQuote(uploadDir)}`],
        cwd: repo.path,
        timeoutMs: 20_000,
        sandboxPolicy: appServerSandboxPolicy(defaultRuntime, repo),
        disableOutputCap: true,
      },
      30_000,
    );
    if (!mkdirResponse.ok || Number(mkdirResponse.result?.exitCode ?? 1) !== 0) {
      if (!allowLocalFallback) {
        return res.status(502).json({
          ok: false,
          error: mkdirResponse.error || mkdirResponse.result?.stderr || "Codex app-server upload directory creation failed",
          source: "app-server-unavailable",
        });
      }
      await fs.mkdir(uploadDir, { recursive: true });
    }
    const files = [];
    for (const file of incoming) {
      const { mimeType, buffer } = uploadFileBytes(file);
      const fileName = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}-${safeUploadName(file?.name || "upload")}`;
      const target = path.join(uploadDir, fileName);
      await assertRepoPathAccess(repo, target, { allowMissing: true });
      const writeResponse = await codexAppServerRequest("fs/writeFile", { path: target, dataBase64: buffer.toString("base64") }, 30_000);
      if (!writeResponse.ok) {
        if (!allowLocalFallback) {
          return res.status(502).json({
            ok: false,
            error: writeResponse.error || "Codex app-server upload write failed",
            source: "app-server-unavailable",
          });
        }
        await fs.mkdir(uploadDir, { recursive: true });
        await fs.writeFile(target, buffer, { mode: 0o600 });
      }
      files.push({
        name: safeUploadName(file?.name || fileName),
        path: path.relative(repo.path, target),
        absolutePath: target,
        mimeType,
        size: buffer.length,
        kind: mimeType.startsWith("image/") ? "image" : "file",
        source: writeResponse.ok ? "app-server" : "local-fallback",
      });
    }
    res.json({ ok: true, repoId: repo.id, files });
  } catch (error) {
    sendRouteError(res, error);
  }
});

app.delete("/api/uploads", async (req, res) => {
  const repo = getRepoById(req.body?.repoId || req.query?.repoId);
  const requested = Array.isArray(req.body?.paths) ? req.body.paths.slice(0, 32) : [];
  if (!requested.length) return res.status(400).json({ ok: false, error: "No upload paths supplied" });
  const deleted = [];
  const errors = [];
  let errorStatus = 400;
  for (const relativePath of requested) {
    let target;
    try {
      target = resolveRepoPath(repo, relativePath);
      if (!isUploadedAttachmentPath(repo, target)) throw repoPathError("Path is outside the upload directory");
      await assertRepoPathAccess(repo, target, { allowMissing: true });
      await fs.unlink(target);
      deleted.push(path.relative(repo.path, target));
      await fs.rmdir(path.dirname(target)).catch(() => null);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      if (!error?.statusCode) errorStatus = 500;
      errors.push(`${String(relativePath)}: ${error.message}`);
    }
  }
  res.status(errors.length ? errorStatus : 200).json({ ok: errors.length === 0, repoId: repo.id, deleted, errors });
});

app.post("/api/chat", async (req, res) => {
  const message = String(req.body?.message || "").trim();
  const repo = getRepoById(req.body?.repoId);
  if (!message) return res.status(400).json({ ok: false, output: "Message is required" });
  const session = await ensureChatSession(repo.id, String(req.body?.sessionId || ""), sessionTitle(message));
  const runtime = normalizeRuntime(req.body, session);

  if (!(await exists(repo.path))) {
    if (!allowLocalFallback) {
      return res.status(503).json({
        ok: false,
        sessionId: session.id,
        output: "Repository path is not available and local mock fallback is disabled.",
        source: "app-server-unavailable",
      });
    }
    const output = `本地开发模式：会把这条消息发送给云端 Codex，并在 ${repo.name} 工作目录中执行。\n\n> ${message}`;
    await appendChatTurn(repo.id, session.id, message, output, true);
    return res.json({
      ok: true,
      mocked: true,
      sessionId: session.id,
      output,
    });
  }

  const job = await startTurnJob(repo, session, runtime, message, [], message);
  const result = await Promise.race([
    job.promise,
    new Promise((resolve) => setTimeout(() => resolve({ ok: false, code: 124, error: "Codex turn timed out" }), codexTurnTimeoutMs)),
  ]);

  res.json({
    ok: result.ok,
    sessionId: session.id,
    codexSessionId: job.threadId,
    output: job.output || job.stderr || result.error || "Codex completed without output.",
    code: result.code,
  });
});

app.post("/api/chat/stream", async (req, res) => {
  const message = String(req.body?.message || "").trim();
  const repo = getRepoById(req.body?.repoId);
  let attachments = [];
  try {
    attachments = Array.isArray(req.body?.attachments)
      ? req.body.attachments.slice(0, maxUploadFiles).map((item) => normalizeAttachment(repo, item))
      : [];
  } catch (error) {
    return res.status(400).json({ ok: false, output: error.message });
  }
  if (!message && !attachments.length) return res.status(400).json({ ok: false, output: "Message or attachment is required" });
  const attachmentLabel = attachments.length ? `\n\n附件: ${attachments.map((item) => item.relativePath).join(", ")}` : "";
  const storedMessage = `${message || "请查看我上传的附件。"}${attachmentLabel}`;
  const session = await ensureChatSession(repo.id, String(req.body?.sessionId || ""), sessionTitle(message || attachments[0]?.name || "附件"));
  const runtime = normalizeRuntime(req.body, session);

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  if (!(await exists(repo.path))) {
    if (!allowLocalFallback) {
      writeSse(res, "error", { message: "Repository path is not available and local mock fallback is disabled.", source: "app-server-unavailable" });
      writeSse(res, "done", { ok: false, code: 1, sessionId: session.id, source: "app-server-unavailable" });
      res.end();
      return;
    }
    writeSse(res, "meta", { mocked: true, repo: repo.name, sessionId: session.id });
    const chunks = [
      "本地开发模式：会把这条消息发送给云端 Codex，",
      `并在 ${repo.name} 工作目录中执行。\n\n`,
      `> ${storedMessage}`,
    ];
    for (const chunk of chunks) {
      writeSse(res, "delta", { text: chunk });
      await new Promise((resolve) => setTimeout(resolve, 220));
    }
    await appendChatTurn(repo.id, session.id, storedMessage, chunks.join(""), true);
    writeSse(res, "done", { ok: true, code: 0, mocked: true, sessionId: session.id });
    res.end();
    return;
  }

  try {
    const job = await startTurnJob(repo, session, runtime, message, attachments, storedMessage);
    subscribeJobEvents(job, res);
    await job.promise;
  } catch (error) {
    writeSse(res, "error", { message: error.message || "云端 Codex 对话失败" });
    writeSse(res, "done", { ok: false, code: 1, sessionId: session.id, codexSessionId: session.codexSessionId || null, error: error.message || "云端 Codex 对话失败" });
  } finally {
    if (!res.writableEnded && !res.destroyed) res.end();
  }
  return;
});

app.get("/api/files/tree", async (req, res) => {
  try {
    const repo = getRepoById(req.query?.repoId);
    res.json({ ok: true, repoId: repo.id, ...(await listRepoFiles(repo, req.query?.path || ".")) });
  } catch (error) {
    sendRouteError(res, error);
  }
});

app.get("/api/files/search", async (req, res) => {
  try {
    const repo = getRepoById(req.query?.repoId);
    const result = await searchRepoFiles(repo, req.query?.q || req.query?.query || "", {
      limit: req.query?.limit,
      cancellationToken: req.query?.cancellationToken ? String(req.query.cancellationToken) : null,
    });
    res.json({ ok: true, repoId: repo.id, ...result });
  } catch (error) {
    sendRouteError(res, error);
  }
});

app.get("/api/files/read", async (req, res) => {
  try {
    const repo = getRepoById(req.query?.repoId);
    const filePath = await assertRepoPathAccess(repo, req.query?.path || ".");
    const metadata = await codexAppServerRequest("fs/getMetadata", { path: filePath }, 12_000);
    if (metadata.ok && !metadata.result?.isFile) return res.status(400).json({ ok: false, error: "Path is not a file" });
    const readResponse = await codexAppServerRequest("fs/readFile", { path: filePath }, 20_000);
    if (readResponse.ok) {
      const buffer = Buffer.from(String(readResponse.result?.dataBase64 || ""), "base64");
      if (buffer.length > 512_000) return res.status(400).json({ ok: false, error: "File is larger than 512 KB" });
      return res.json({
        ok: true,
        repoId: repo.id,
        path: path.relative(repo.path, filePath),
        size: buffer.length,
        updatedAt: metadata.result?.modifiedAtMs ? new Date(Number(metadata.result.modifiedAtMs)).toISOString() : new Date().toISOString(),
        content: buffer.toString("utf8"),
        source: "app-server",
      });
    }

    if (!allowLocalFallback) {
      return res.status(502).json({
        ok: false,
        error: readResponse.error || "Codex app-server file read failed",
        source: "app-server-unavailable",
      });
    }

    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return res.status(400).json({ ok: false, error: "Path is not a file" });
    if (stat.size > 512_000) return res.status(400).json({ ok: false, error: "File is larger than 512 KB" });
    const content = await fs.readFile(filePath, "utf8");
    res.json({
      ok: true,
      repoId: repo.id,
      path: path.relative(repo.path, filePath),
      size: stat.size,
      updatedAt: stat.mtime.toISOString(),
      content,
      source: "local-fallback",
      fallbackError: readResponse.error,
    });
  } catch (error) {
    sendRouteError(res, error);
  }
});

app.get("/api/files/blob", async (req, res) => {
  try {
    const repo = getRepoById(req.query?.repoId);
    const filePath = await assertRepoPathAccess(repo, req.query?.path || ".");
    const imageMimeType = imageMimeForPath(filePath);
    const isUpload = isUploadedAttachmentPath(repo, filePath);
    if (!imageMimeType && !isUpload) {
      return res.status(415).json({ ok: false, error: "Only raster image previews or uploaded attachments are supported" });
    }
    const mimeType = imageMimeType || attachmentMimeForPath(filePath);
    const disposition = imageMimeType ? "inline" : "attachment";
    const metadata = await codexAppServerRequest("fs/getMetadata", { path: filePath }, 12_000);
    if (metadata.ok && !metadata.result?.isFile) return res.status(400).json({ ok: false, error: "Path is not a file" });
    const readResponse = await codexAppServerRequest("fs/readFile", { path: filePath }, 20_000);
    if (readResponse.ok) {
      const buffer = Buffer.from(String(readResponse.result?.dataBase64 || ""), "base64");
      if (buffer.length > maxUploadBytes) return res.status(400).json({ ok: false, error: `Attachment exceeds ${Math.round(maxUploadBytes / 1024 / 1024)} MB` });
      res.setHeader("Content-Type", mimeType);
      res.setHeader("Content-Length", String(buffer.length));
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Content-Disposition", `${disposition}; filename="${safeUploadName(path.basename(filePath))}"`);
      res.setHeader("X-Codex-Source", "app-server");
      return res.end(buffer);
    }
    if (!allowLocalFallback) {
      return res.status(502).json({
        ok: false,
        error: readResponse.error || "Codex app-server file read failed",
        source: "app-server-unavailable",
      });
    }
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return res.status(400).json({ ok: false, error: "Path is not a file" });
    if (stat.size > maxUploadBytes) return res.status(400).json({ ok: false, error: `Attachment exceeds ${Math.round(maxUploadBytes / 1024 / 1024)} MB` });
    res.setHeader("Content-Type", mimeType);
    res.setHeader("Content-Length", String(stat.size));
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Content-Disposition", `${disposition}; filename="${safeUploadName(path.basename(filePath))}"`);
    res.setHeader("X-Codex-Source", "local-fallback");
    res.end(await fs.readFile(filePath));
  } catch (error) {
    sendRouteError(res, error);
  }
});

app.get("/api/codex/generated-image", async (req, res) => {
  try {
    const filePath = await assertGeneratedImagePathAccess(req.query?.path);
    const mimeType = imageMimeForPath(filePath);
    const metadata = await codexAppServerRequest("fs/getMetadata", { path: filePath }, 12_000);
    if (metadata.ok && !metadata.result?.isFile) return res.status(400).json({ ok: false, error: "Path is not a file" });
    const readResponse = await codexAppServerRequest("fs/readFile", { path: filePath }, 20_000);
    if (readResponse.ok) {
      const buffer = Buffer.from(String(readResponse.result?.dataBase64 || ""), "base64");
      if (buffer.length > maxUploadBytes) return res.status(400).json({ ok: false, error: `Generated image exceeds ${Math.round(maxUploadBytes / 1024 / 1024)} MB` });
      res.setHeader("Content-Type", mimeType);
      res.setHeader("Content-Length", String(buffer.length));
      res.setHeader("Cache-Control", "private, max-age=300");
      res.setHeader("Content-Disposition", `inline; filename="${safeUploadName(path.basename(filePath))}"`);
      res.setHeader("X-Codex-Source", "app-server");
      return res.end(buffer);
    }
    if (!allowLocalFallback) {
      return res.status(502).json({
        ok: false,
        error: readResponse.error || "Codex app-server generated image read failed",
        source: "app-server-unavailable",
      });
    }
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return res.status(400).json({ ok: false, error: "Path is not a file" });
    if (stat.size > maxUploadBytes) return res.status(400).json({ ok: false, error: `Generated image exceeds ${Math.round(maxUploadBytes / 1024 / 1024)} MB` });
    res.setHeader("Content-Type", mimeType);
    res.setHeader("Content-Length", String(stat.size));
    res.setHeader("Cache-Control", "private, max-age=300");
    res.setHeader("Content-Disposition", `inline; filename="${safeUploadName(path.basename(filePath))}"`);
    res.setHeader("X-Codex-Source", "local-fallback");
    return res.end(await fs.readFile(filePath));
  } catch (error) {
    sendRouteError(res, error);
  }
});

app.post("/api/files/write", async (req, res) => {
  try {
    const repo = getRepoById(req.body?.repoId);
    const filePath = await assertRepoPathAccess(repo, req.body?.path || ".", { allowMissing: true });
    const content = String(req.body?.content || "");
    const writeResponse = await codexAppServerRequest(
      "fs/writeFile",
      { path: filePath, dataBase64: Buffer.from(content, "utf8").toString("base64") },
      20_000,
    );
    if (writeResponse.ok) {
      const metadata = await codexAppServerRequest("fs/getMetadata", { path: filePath }, 12_000);
      return res.json({
        ok: true,
        repoId: repo.id,
        path: path.relative(repo.path, filePath),
        size: Buffer.byteLength(content),
        updatedAt: metadata.result?.modifiedAtMs ? new Date(Number(metadata.result.modifiedAtMs)).toISOString() : new Date().toISOString(),
        source: "app-server",
      });
    }

    if (!allowLocalFallback) {
      return res.status(502).json({
        ok: false,
        error: writeResponse.error || "Codex app-server file write failed",
        source: "app-server-unavailable",
      });
    }

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content);
    const stat = await fs.stat(filePath);
    res.json({ ok: true, repoId: repo.id, path: path.relative(repo.path, filePath), size: stat.size, updatedAt: stat.mtime.toISOString(), source: "local-fallback", fallbackError: writeResponse.error });
  } catch (error) {
    sendRouteError(res, error);
  }
});

app.post("/api/terminal/run", async (req, res) => {
  try {
    const repo = getRepoById(req.body?.repoId);
    const result = await runShellCommand(repo, req.body?.command);
    if (!result.ok && result.source === "app-server-unavailable") {
      return res.status(502).json({ ok: false, repoId: repo.id, command: req.body?.command || "", ...result });
    }
    res.json({ ok: result.ok, repoId: repo.id, command: req.body?.command || "", ...result });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post("/api/browser/check", async (req, res) => {
  res.json(await runBrowserCheck(req.body?.url));
});

async function getCliSessions(repo) {
  const script = `
import datetime
import json
import os
import sqlite3
import sys

repo_path = sys.argv[1]
limit = int(sys.argv[2])
db_path = os.path.expanduser("~/.codex/state_5.sqlite")
con = sqlite3.connect(db_path)
con.row_factory = sqlite3.Row
rows = con.execute(
    """
    select id, title, cwd, source, model, reasoning_effort, sandbox_policy,
           approval_mode, tokens_used, has_user_event, git_branch,
           first_user_message, preview, created_at, updated_at,
           created_at_ms, updated_at_ms
      from threads
     where archived = 0 and source != 'exec' and (cwd = ? or cwd like ?)
     order by coalesce(updated_at_ms, updated_at * 1000, created_at_ms, created_at * 1000) desc
     limit ?
    """,
    (repo_path, repo_path.rstrip("/") + "/%", limit),
).fetchall()

def iso(ms, seconds):
    value = ms if ms is not None else (seconds * 1000 if seconds is not None else None)
    if value is None:
        return None
    return datetime.datetime.fromtimestamp(value / 1000, datetime.UTC).isoformat().replace("+00:00", "Z")

items = []
for row in rows:
    preview = row["preview"] or row["first_user_message"] or row["title"] or ""
    title = row["title"] or row["first_user_message"] or row["id"]
    items.append({
        "id": row["id"],
        "title": title,
        "cwd": row["cwd"],
        "source": row["source"],
        "model": row["model"],
        "reasoning": row["reasoning_effort"],
        "sandbox": row["sandbox_policy"],
        "approval": row["approval_mode"],
        "tokensUsed": row["tokens_used"],
        "hasUserEvent": bool(row["has_user_event"]),
        "gitBranch": row["git_branch"],
        "preview": preview[:180],
        "createdAt": iso(row["created_at_ms"], row["created_at"]),
        "updatedAt": iso(row["updated_at_ms"], row["updated_at"]),
    })
print(json.dumps({"sessions": items}))
`;
  const result = await run("python3", ["-c", script, repo.path, "40"], { timeout: 8_000 });
  if (!result.ok) {
    return { sessions: [], error: result.stderr || result.stdout };
  }
  return JSON.parse(result.stdout || '{"sessions":[]}');
}

app.get("/api/cli/sessions", async (req, res) => {
  if (!enableCliDebug) {
    return res.status(404).json({
      ok: false,
      source: "app-server-only",
      error: "Raw CLI debug sessions are disabled. Use app-server thread/session APIs.",
    });
  }
  try {
    const repo = getRepoById(req.query?.repoId);
    const sessions = await getCliSessions(repo);
    res.json({ ok: true, repoId: repo.id, ...sessions });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

const cliTerminalServer = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
  if (url.pathname !== "/api/cli/terminal") {
    socket.destroy();
    return;
  }
  if (!enableCliDebug) {
    socket.write(
      [
        "HTTP/1.1 403 Forbidden",
        "Content-Type: application/json; charset=utf-8",
        "Connection: close",
        "",
        JSON.stringify({ ok: false, source: "app-server-only", error: "Raw CLI terminal is disabled. Use app-server thread/session APIs." }),
      ].join("\r\n"),
    );
    socket.destroy();
    return;
  }
  cliTerminalServer.handleUpgrade(request, socket, head, (ws) => {
    cliTerminalServer.emit("connection", ws, request, url);
  });
});

cliTerminalServer.on("connection", (ws, _request, url) => {
  let repo;
  try {
    repo = getRepoById(url.searchParams.get("repoId"));
  } catch (error) {
    ws.close(1008, error.message || "Invalid repository");
    return;
  }
  const cols = Number(url.searchParams.get("cols") || 120);
  const rows = Number(url.searchParams.get("rows") || 36);
  const cwd = repo.path;
  const action = url.searchParams.get("action") || "new";
  const sessionId = url.searchParams.get("sessionId") || "";
  const baseCommand = "codex --no-alt-screen --search --dangerously-bypass-approvals-and-sandbox";
  const cliCommand =
    action === "resume" && sessionId
      ? `${baseCommand} resume ${shellQuote(sessionId)}`
      : action === "fork" && sessionId
        ? `${baseCommand} fork ${shellQuote(sessionId)}`
        : baseCommand;
  const command = [
    `cd ${shellQuote(cwd)}`,
    `exec ${cliCommand}`,
  ].join(" && ");
  const child = spawn("script", ["-qfec", command, "/dev/null"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      COLUMNS: String(Number.isFinite(cols) ? cols : 120),
      LINES: String(Number.isFinite(rows) ? rows : 36),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  ws.send(
    [
      "",
      `[cloud] starting full Codex CLI in ${cwd}`,
      `[cloud] command: ${cliCommand}`,
      "[cloud] permissions: danger-full-access, approval never, web search enabled",
      "",
      "",
    ].join("\r\n"),
  );

  child.stdout.on("data", (chunk) => {
    if (ws.readyState === 1) ws.send(chunk);
  });
  child.stderr.on("data", (chunk) => {
    if (ws.readyState === 1) ws.send(chunk);
  });
  child.on("error", (error) => {
    if (ws.readyState === 1) ws.send(`\r\n[cloud] failed to start CLI: ${error.message}\r\n`);
  });
  child.on("close", (code) => {
    if (ws.readyState === 1) {
      ws.send(`\r\n[cloud] Codex CLI exited with code ${code ?? "unknown"}\r\n`);
      ws.close();
    }
  });

  ws.on("message", (data) => {
    try {
      const text = data.toString();
      if (text.startsWith("{")) {
        const payload = JSON.parse(text);
        if (payload.type === "input") child.stdin.write(String(payload.data || ""));
        return;
      }
      child.stdin.write(text);
    } catch {
      child.stdin.write(data);
    }
  });
  ws.on("close", () => {
    child.kill("SIGTERM");
  });
});

app.get("/api/automations/runs", async (req, res) => {
  const [store, auditStore] = await Promise.all([readAutomationRuns(), readAuditEvents()]);
  const auditEvents = (auditStore.events || []).map(auditEventForStatus);
  const repoId = req.query?.repoId ? String(req.query.repoId) : "";
  const automationId = req.query?.automationId ? String(req.query.automationId) : "";
  const status = req.query?.status ? String(req.query.status) : "";
  const requestedVerificationLimit = Number(req.query?.verifyLimit);
  const verificationLimit = Number.isFinite(requestedVerificationLimit)
    ? Math.min(Math.max(requestedVerificationLimit, 0), 50)
    : automationThreadVerificationDefaultLimit;
  const runs = await verifyAutomationRunThreads(store.runs
    .map(summarizeAutomationRun)
    .map((run) => enrichAutomationRunForStatus(run, auditEvents))
    .filter((run) => {
      if (repoId && run.repoId !== repoId) return false;
      if (automationId && run.automationId !== automationId) return false;
      if (status && run.status !== status) return false;
      return true;
    }), { limit: verificationLimit });
  const threadRuns = runs.filter((run) => run.threadId);
  const verifiedCount = threadRuns.filter((run) => run.threadVerified === true).length;
  res.json({
    ok: true,
    source: "local-run-store+app-server-thread-verification",
    verification: {
      limit: verificationLimit,
      threadRunCount: threadRuns.length,
      verifiedCount,
      complete: verifiedCount === threadRuns.length,
    },
    runs,
    activeRunIds: [...activeAutomationRuns.keys()],
  });
});

app.get("/api/automations/inbox", async (_req, res) => {
  const [store, auditStore] = await Promise.all([readAutomationRuns(), readAuditEvents()]);
  const auditEvents = (auditStore.events || []).map(auditEventForStatus);
  const runs = await verifyAutomationRunThreads((store.runs || [])
    .map(summarizeAutomationRun)
    .map((run) => enrichAutomationRunForStatus(run, auditEvents)));
  res.json({ ok: true, source: "local-run-store+app-server-thread-verification", ...automationInboxBuckets(runs, auditEvents) });
});

async function handleAutomationTriggerRequest(req, res, trigger) {
  if (!validateAutomationTrigger(req)) {
    return res.status(401).json({
      ok: false,
      error: "Automation trigger token is required",
      hint: "Set CODEX_CLOUD_WEBHOOK_TOKEN and send it as x-codex-cloud-token.",
    });
  }
  const automation = automations.find((item) => item.id === req.params.id);
  if (!automation) return res.status(404).json({ ok: false, output: "Unknown automation" });
  const idempotency = automationTriggerIdempotencyKey(req, automation.id, trigger);
  if (idempotency.error) return res.status(400).json({ ok: false, error: idempotency.error });
  pruneAutomationTriggerIdempotency();
  const existing = idempotency.key ? automationTriggerIdempotency.get(idempotency.key) : null;
  if (existing) {
    try {
      const payload = existing.payload || await existing.promise;
      return res.json({ ...payload, deduplicated: true });
    } catch {
      automationTriggerIdempotency.delete(idempotency.key);
    }
  }
  const rate = consumeAutomationTriggerRate(req, automation.id);
  if (!rate.ok) {
    res.setHeader("Retry-After", String(Math.ceil(rate.retryAfterMs / 1000)));
    return res.status(429).json({ ok: false, error: "Automation trigger rate limit exceeded", retryAfterMs: rate.retryAfterMs });
  }
  const repo = getRepoById(automation.repoId);
  const runPromise = startAppServerAutomationRun(automation, repo, automationTriggerOptions(req, trigger)).then((runRecord) => ({
    ok: true,
    run: runRecord,
    output: `${automation.name}: ${trigger} app-server run started`,
  }));
  if (idempotency.key) {
    automationTriggerIdempotency.set(idempotency.key, {
      promise: runPromise,
      payload: null,
      expiresAt: Date.now() + automationTriggerIdempotencyTtlMs,
    });
  }
  try {
    const payload = await runPromise;
    const runRecord = payload.run;
    if (idempotency.key) {
      automationTriggerIdempotency.set(idempotency.key, {
        promise: Promise.resolve(payload),
        payload,
        expiresAt: Date.now() + automationTriggerIdempotencyTtlMs,
      });
    }
    appendAuditEvent({
      source: "automation",
      type: "automation-trigger",
      repoId: repo.id,
      sessionId: runRecord.sessionId || null,
      threadId: runRecord.threadId || null,
      summary: `${trigger}: ${automation.id}`,
      detail: jsonDetail({ runId: runRecord.id, automationId: automation.id, trigger, worktreePolicy: runRecord.worktreePolicy }),
    }).catch(() => null);
    return res.json(payload);
  } catch (error) {
    if (idempotency.key) automationTriggerIdempotency.delete(idempotency.key);
    return res.status(500).json({ ok: false, error: error.message, output: error.message });
  }
}

app.post("/api/automations/:id/webhook", (req, res) => {
  return handleAutomationTriggerRequest(req, res, "webhook");
});

app.post("/api/automations/:id/heartbeat", (req, res) => {
  return handleAutomationTriggerRequest(req, res, "heartbeat");
});

app.post("/api/automations/:id/run", async (req, res) => {
  const automation = automations.find((item) => item.id === req.params.id);
  if (!automation) return res.status(404).json({ ok: false, output: "Unknown automation" });
  const repo = getRepoById(automation.repoId);
  if (req.body?.runner === "app-server" || req.query?.runner === "app-server") {
    try {
      const runRecord = await startAppServerAutomationRun(automation, repo, {
        trigger: "manual",
        prompt: req.body?.prompt,
        model: req.body?.model,
        reasoning: req.body?.reasoning,
        worktree: req.body?.worktree !== false,
      });
      return res.json({ ok: true, run: runRecord, output: `${automation.name}: app-server automation run started` });
    } catch (error) {
      return res.status(500).json({ ok: false, error: error.message, output: error.message });
    }
  }

  const runId = automationRunId(automation.id);
  await upsertAutomationRun({
    id: runId,
    automationId: automation.id,
    repoId: repo.id,
    name: automation.name,
    trigger: "manual",
    runner: "systemd",
    status: "queued",
    model: automation.model,
    reasoning: automation.reasoning,
    prompt: automation.prompt || "",
  }, { type: "queued", text: `Starting ${automation.service}` });
  const result = await run("systemctl", ["start", automation.service], { timeout: 20_000 });
  if (!result.ok) {
    const output = result.stderr || result.stdout || "systemctl start failed";
    await appendAutomationRunEvent(runId, {
      status: "failed",
      finishedAt: new Date().toISOString(),
      error: output,
    }, { type: "error", text: output });
    if (!allowLocalFallback) {
      return res.status(500).json({ ok: false, runId, output });
    }
    return res.json({ ok: true, mocked: true, runId, output: `${automation.name}: mock run queued` });
  }
  await appendAutomationRunEvent(runId, {
    status: "running",
  }, { type: "systemd", text: `${automation.service} started` });
  res.json({ ok: true, runId, output: `${automation.service} started` });
});

app.post("/api/automations/:id/:mode", async (req, res) => {
  const automation = automations.find((item) => item.id === req.params.id);
  if (!automation) return res.status(404).json({ ok: false, output: "Unknown automation" });
  const action = { pause: "disable", resume: "enable" }[req.params.mode];
  if (!action) {
    return res.status(400).json({ ok: false, output: "Automation mode must be pause or resume" });
  }
  const result = await run("systemctl", [action, "--now", automation.timer], { timeout: 20_000 });
  if (!result.ok) {
    const output = result.stderr || result.stdout || `${automation.name}: ${req.params.mode} failed`;
    if (!allowLocalFallback) {
      return res.status(500).json({ ok: false, output });
    }
    return res.json({ ok: true, mocked: true, output: `${automation.name}: mock ${req.params.mode}` });
  }
  res.json({ ok: true, output: `${automation.timer} ${action}d` });
});

app.use("/api", (req, res) => {
  res.status(404).json({ ok: false, error: `Unknown API route: ${req.method} ${req.path}` });
});

app.use(express.static(path.join(projectRoot, "dist")));
app.get(/.*/, (_req, res) => {
  res.sendFile(path.join(projectRoot, "dist", "index.html"));
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const statusCode = Number(error?.statusCode || error?.status || 500);
  res.status(statusCode >= 400 && statusCode <= 599 ? statusCode : 500).json({
    ok: false,
    error: error?.message || "Internal server error",
    ...(error?.source ? { source: error.source } : {}),
    path: req.path,
  });
});

const removedStateTempFiles = await cleanupStaleStateTempFiles().catch((error) => {
  console.warn(`State temp cleanup failed: ${error.message}`);
  return [];
});
if (removedStateTempFiles.length) {
  console.log(`Removed ${removedStateTempFiles.length} stale state temp file(s).`);
}

await reconcileStaleAutomationRuns().catch((error) => {
  console.warn(`Automation run reconciliation failed: ${error.message}`);
});

function startExternalNotificationWatcher() {
  const pollMs = Math.max(30_000, Number(process.env.CODEX_CLOUD_NOTIFY_POLL_MS || 60_000));
  if (!notificationChannels().some((channel) => channel.enabled)) return;
  const tick = () => {
    runExternalNotificationCheck("poll").catch((error) => {
      console.warn(`External notification check failed: ${error.message}`);
    });
  };
  setTimeout(tick, 5_000).unref?.();
  setInterval(tick, pollMs).unref?.();
}

startExternalNotificationWatcher();

server.listen(port, host, () => {
  console.log(`Codex Cloud Console listening on http://${host}:${port}`);
});
