import {
  Activity,
  Bell,
  Bot,
  Brain,
  CheckCircle2,
  ChevronRight,
  Circle,
  Cloud,
  Code2,
  Command,
  Copy,
  FileText,
  FolderOpen,
  Gauge,
  GitBranch,
  GitPullRequestArrow,
  Globe2,
  HardDrive,
  History,
  Loader2,
  Menu,
  MessageSquare,
  Paperclip,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Target,
  Terminal,
  Timer,
  Trash2,
  Wifi,
  X,
} from "lucide-react";
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import type { AppServerLiveSnapshot, AttentionItem, AttentionSummary, AuditEvent, Automation, AutomationRun, CodexDiagnostics, ConsoleStatus, LogFile, Repo } from "./types";

const LazyChatMarkdown = lazy(() => import("./ChatMarkdownRenderer"));
const LazyCodexPluginManager = lazy(() => import("./CodexPluginManager"));

type RunEvent = {
  id: string;
  time: string;
  tone: "ok" | "warn" | "info";
  title: string;
  body: string;
};

type ActiveView = "inbox" | "automations" | "cli" | "agent" | "logs" | "settings";
type CloudConnection = "checking" | "cloud" | "degraded" | "local" | "offline";
type ActiveCodexJob = NonNullable<ConsoleStatus["activeJobs"]>[number];

type BrowserPushReadiness = {
  secureContext: boolean;
  localOrigin: boolean;
  serviceWorker: boolean;
  pushManager: boolean;
  notifications: boolean;
  supported: boolean;
  permission: string;
  workerRegistered: boolean;
  workerScope: string | null;
  endpoint: string | null;
  error: string | null;
};

type AppRoute = {
  view: ActiveView;
  repoId?: string;
  sessionId?: string;
  automationId?: string;
};

const defaultRepoId = "sample-app";
const defaultAutomationId = "sample-maintenance";
const routeViews = new Set<ActiveView>(["inbox", "automations", "cli", "agent", "logs", "settings"]);

type GlobalSearchResult = {
  id: string;
  kind: "project" | "session" | "automation" | "view" | "log";
  label: string;
  hint: string;
  repoId?: string;
  sessionId?: string;
  automationId?: string;
  view?: ActiveView;
  logName?: string;
};

type ChatMessage = {
  id: string;
  role: "user" | "codex";
  text: string;
  time: string;
  attachments?: UploadedAttachment[];
  mocked?: boolean;
  streaming?: boolean;
  status?: string;
  messageType?: string;
  details?: Record<string, unknown>;
};

type ChatHistoryResponse = {
  ok: boolean;
  repoId: string;
  activeSessionId: string;
  sessions: ChatSession[];
  messages: ChatMessage[];
  archived?: boolean;
  source?: string;
  authoritative?: boolean;
  degraded?: boolean;
  error?: string;
};

type ChatRuntimeResponse = {
  ok: boolean;
  repoId: string;
  sessionId: string;
  activeSessionId?: string;
  runtime: ChatRuntime;
  session?: ChatSession | null;
  sessions?: ChatSession[];
  appServerSynced?: boolean;
  appServerRuntime?: ChatRuntime | null;
  appliesOnNextTurn?: boolean;
};

type ChatSearchResponse = {
  ok: boolean;
  query: string;
  sessions: ChatSession[];
  errors?: Record<string, string>;
};

type CreateProjectResponse = {
  ok: boolean;
  repo: Repo;
  activeSessionId: string;
  error?: string;
};

type HealthCheckResponse = NonNullable<ConsoleStatus["health"]>;

type ChatSession = {
  id: string;
  repoId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  codexSessionId?: string | null;
  threadId?: string | null;
  isDraft?: boolean;
  source?: "app-server" | "local" | string;
  model?: string | null;
  reasoning?: string | null;
  sandbox?: string | null;
  approval?: string | null;
  search?: boolean | null;
  tokenUsage?: ThreadTokenUsage | null;
  goal?: ThreadGoal | null;
  compactedAt?: string | null;
  runtimePending?: boolean;
  draft?: ChatDraft | null;
};

type ChatRuntime = {
  model: string;
  reasoning: string;
  sandbox: string;
  approval: string;
  search: boolean;
};

type CompactStatus = {
  running: boolean;
  text: string;
  ok?: boolean | null;
  error?: string | null;
  compactedAt?: string | null;
  threadId?: string | null;
};

type ServerJobEvent = {
  id: number;
  event: string;
  data: Record<string, unknown>;
  time: string;
};

type ActiveJob = {
  id: string;
  kind: "turn" | "compact";
  repoId: string;
  sessionId: string;
  threadId: string | null;
  turnId: string | null;
  startedAt: string;
  completed: boolean;
  ok: boolean | null;
  code: number | null;
  error: string | null;
  events: ServerJobEvent[];
};

type ActiveJobsResponse = {
  ok: boolean;
  repoId: string;
  sessionId: string;
  turn: ActiveJob | null;
  compact: ActiveJob | null;
};

const runtimeReasoning = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const defaultChatRuntime: ChatRuntime = {
  model: "gpt-5.6-terra",
  reasoning: "medium",
  sandbox: "danger-full-access",
  approval: "never",
  search: true,
};

type CodexModelOption = {
  id: string;
  model?: string;
  displayName: string;
  description?: string;
  isDefault?: boolean;
  upgrade?: string | null;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: string[];
  inputModalities?: string[];
  serviceTiers?: Array<{ id: string; name: string; description?: string }>;
  additionalSpeedTiers?: string[];
};

type CodexModelsResponse = {
  ok: boolean;
  source?: string;
  authoritative?: boolean;
  stale?: boolean;
  refreshing?: boolean;
  error?: string;
  models: CodexModelOption[];
};

type TokenUsageBreakdown = {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
};

type ThreadTokenUsage = {
  total: TokenUsageBreakdown;
  last: TokenUsageBreakdown;
  modelContextWindow: number | null;
};

type ThreadGoal = {
  threadId: string;
  objective: string;
  status: string;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
};

type ThreadStateResponse = {
  ok: boolean;
  source?: string;
  authoritative?: boolean;
  partial?: boolean;
  cached?: boolean;
  refreshing?: boolean;
  error?: string | null;
  threadId: string | null;
  goal: ThreadGoal | null;
  tokenUsage: ThreadTokenUsage | null;
  runtime?: ChatRuntime | null;
  config?: {
    modelContextWindow: number | null;
    autoCompactTokenLimit: number | null;
    autoCompactTokenLimitScope: string | null;
    compactPrompt?: string | null;
  };
};

type GitDiffResponse = {
  ok: boolean;
  repoId: string;
  diff: unknown;
  error?: string;
};

type ReviewScope = "workspace" | "baseBranch";
type ReviewWorkspaceView = "unstaged" | "staged";
type ReviewAction = "stage" | "unstage" | "revert";
type ReviewActionLevel = "all" | "file" | "hunk";

type ReviewDiffLine = {
  key: string;
  kind: "meta" | "hunk" | "add" | "remove" | "context";
  text: string;
  oldLine: number | null;
  newLine: number | null;
};

type ReviewHunk = {
  id: string;
  header: string;
  patch: string;
  addedLineCount: number;
  removedLineCount: number;
  lines: ReviewDiffLine[];
};

type ReviewFile = {
  id: string;
  path: string;
  previousPath: string | null;
  operation: "add" | "delete" | "update" | "rename";
  addedLineCount: number;
  removedLineCount: number;
  diff: string;
  hunks: ReviewHunk[];
};

type ReviewSummary = {
  fileCount: number;
  addedLineCount: number;
  removedLineCount: number;
};

type ReviewSnapshot = {
  cwd: string;
  gitRoot: string | null;
  isGitRepo: boolean;
  scope: ReviewScope | "commit";
  workspaceView: ReviewWorkspaceView;
  baseBranch: string | null;
  baseBranchOptions: string[];
  commitSha: string | null;
  headBranch: string | null;
  mergeBaseSha: string | null;
  generatedAtIso: string;
  summary: ReviewSummary;
  files: ReviewFile[];
  source?: string;
  readOnly?: boolean;
};

type ReviewApiResponse = {
  data?: ReviewSnapshot;
  error?: string;
};

type ReviewPrContext = {
  available: boolean;
  reason: string;
  ghInstalled: boolean;
  authenticated: boolean;
  repo: { owner: string; name: string; url: string } | null;
  pr: {
    number: number;
    url: string;
    title: string;
    state: string;
    headRefName: string;
    baseRefName: string;
    headRefOid: string;
  } | null;
};

type ReviewPrContextResponse = {
  data?: ReviewPrContext;
  error?: string;
};

type ReviewPrCommentResponse = {
  data?: ReviewPrContext & {
    published?: boolean;
    mode?: "inline" | "conversation" | string;
    url?: string;
  };
  error?: string;
};

type ReviewActivity = {
  repoId: string;
  sessionId: string;
  running: boolean;
  status: string;
  text: string;
  diff: string;
  error?: string;
  updatedAt: string;
};

type ReviewFinding = {
  id: string;
  title: string;
  body: string;
  path: string | null;
  absolutePath: string | null;
  startLine: number | null;
  endLine: number | null;
  rawText: string;
};

type ReviewResult = {
  reviewText: string;
  summary: string;
  findings: ReviewFinding[];
};

type CodexSkillItem = {
  name: string;
  displayName?: string;
  description?: string;
  path: string;
  scope?: string;
  enabled?: boolean;
};

type CodexAccountLoginFlow = {
  loginId: string;
  type: string;
  status: "pending" | "completed" | "failed" | "canceled" | "notFound" | string;
  authUrl?: string | null;
  verificationUrl?: string | null;
  userCode?: string | null;
  error?: string | null;
  startedAt?: string;
  updatedAt?: string;
  completedAt?: string;
};

type CodexAccountLoginState = {
  active?: CodexAccountLoginFlow | null;
  latest?: CodexAccountLoginFlow | null;
  flows?: CodexAccountLoginFlow[];
};

type CodexAppStatus = {
  ok: boolean;
  source?: string;
  authoritative?: boolean;
  partial?: boolean;
  failedCriticalKeys?: string[];
  capabilityWarnings?: Array<{ key: string; error?: string | null }>;
  account?: { email?: string; planType?: string; type?: string } | null;
  rateLimits?: {
    primary?: { usedPercent?: number; windowDurationMins?: number; resetsAt?: number };
    secondary?: { usedPercent?: number; windowDurationMins?: number; resetsAt?: number };
    credits?: { hasCredits?: boolean; unlimited?: boolean; balance?: string | null } | null;
    individualLimit?: { limit?: string; used?: string; remainingPercent?: number; resetsAt?: number } | null;
    spendControlReached?: boolean | null;
    planType?: string;
    rateLimitReachedType?: string | null;
  } | null;
  accountUsage?: {
    summary?: {
      lifetimeTokens?: number | string | null;
      peakDailyTokens?: number | string | null;
      longestRunningTurnSec?: number | string | null;
      currentStreakDays?: number | string | null;
      longestStreakDays?: number | string | null;
    };
    dailyUsageBuckets?: Array<{ startDate: string; tokens: number | string }> | null;
  } | null;
  usageLimit?: {
    code?: string | null;
    message?: string;
    retryAtText?: string | null;
    title?: string;
    body?: string;
  } | null;
  mcpServers: Array<{ name: string; authStatus: string; toolCount: number; resourceCount: number }>;
  plugins: { installed: number; enabled: number; available: number; names: string[] };
  skills: { enabled: number; total: number; names: string[]; items?: CodexSkillItem[] };
  features: { enabled: number; total: number; names: string[] };
  permissionProfiles: Array<{ id: string; description?: string | null }>;
  config: {
    model: string;
    reasoning: string;
    sandbox: string;
    approval: string;
    autoCompactTokenLimit?: number | null;
    autoCompactTokenLimitScope?: string | null;
  };
  providerCapabilities?: { namespaceTools?: boolean; imageGeneration?: boolean; webSearch?: boolean } | null;
  auth?: { ok: boolean; issue?: string | null };
  accountLogin?: CodexAccountLoginState;
  appHost?: {
    running: boolean;
    startedAt: string | null;
    restartCount: number;
    lastError: string | null;
    pending: number;
    stderrTail: string[];
  };
  live?: AppServerLiveSnapshot;
  mcpOauthResults?: Array<{ name: string; success: boolean; error?: string | null; time: string }>;
  rawErrors?: Record<string, string>;
  gaps: string[];
};

type SlashCommand = {
  id: string;
  label: string;
  group: string;
  hint: string;
  icon: ReactNode;
  aliases?: string[];
  run: () => void;
  disabled?: boolean;
};

const fallbackAppStatus: CodexAppStatus = {
  ok: false,
  source: "app-server-unavailable",
  authoritative: false,
  partial: true,
  account: null,
  rateLimits: null,
  accountUsage: null,
  usageLimit: null,
  mcpServers: [],
  plugins: { installed: 0, enabled: 0, available: 0, names: [] },
  skills: { enabled: 0, total: 0, names: [], items: [] },
  features: { enabled: 0, total: 0, names: [] },
  auth: { ok: false, issue: "等待云端 Codex 能力探测。" },
  accountLogin: { active: null, latest: null, flows: [] },
  permissionProfiles: [],
  live: { latestEvents: [], mcpStartup: {}, skillsChangedAt: null, appListUpdated: null, remoteControl: null },
  config: {
    model: defaultChatRuntime.model,
    reasoning: defaultChatRuntime.reasoning,
    sandbox: defaultChatRuntime.sandbox,
    approval: defaultChatRuntime.approval,
  },
  gaps: ["等待云端 Codex 能力探测。"],
};

type AgentFileEntry = {
  name: string;
  path: string;
  type: "directory" | "file";
  size: number;
  updatedAt: string | null;
  source?: string;
  score?: number;
  indices?: number[] | null;
};

type AgentFileTree = {
  ok: boolean;
  repoId: string;
  path: string;
  entries: AgentFileEntry[];
  query?: string;
  source?: string;
  fallback?: boolean;
  error?: string;
};

type AgentFileRead = {
  ok: boolean;
  repoId: string;
  path: string;
  size: number;
  updatedAt: string;
  content: string;
};

type ComposerTrigger = {
  prefix: "$" | "@";
  start: number;
  end: number;
  query: string;
};

type ComposerSuggestion = {
  id: string;
  label: string;
  hint: string;
  insert: string;
  icon: ReactNode;
  disabled?: boolean;
};

type TerminalResult = {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
};

type BrowserResult = {
  ok: boolean;
  status?: number;
  title?: string;
  url?: string;
  errors?: string[];
  screenshot?: string;
  error?: string;
};

type UploadedAttachment = {
  name: string;
  path: string;
  absolutePath?: string;
  mimeType: string;
  size: number;
  kind: "image" | "file";
  previewUrl?: string;
  generated?: boolean;
};

type ChatDraft = {
  input: string;
  attachments: UploadedAttachment[];
  updatedAt?: string | null;
};

type ChatDraftResponse = {
  ok: boolean;
  repoId: string;
  sessionId: string;
  draft: ChatDraft;
  sessions?: ChatSession[];
};

type UploadResponse = {
  ok: boolean;
  repoId: string;
  files: UploadedAttachment[];
};

const fallbackRun = {
  activeState: "inactive",
  failedState: "inactive",
  exitCode: "0",
  logName: "sample-data-refresh-latest.log",
  logUpdatedAt: new Date().toISOString(),
  logTail: ["Sample run completed", "Timer waiting for next run"],
};

const fallbackStatus: ConsoleStatus = {
  generatedAt: new Date().toISOString(),
  localMode: false,
  publicConfig: {
    publicOrigin: "https://console.example.com",
    webhook: {
      tokenConfigured: false,
      tokenHeader: "x-codex-cloud-token",
      idempotencyHeader: "Idempotency-Key",
      basicAuthRequired: false,
    },
  },
  health: {
    ok: false,
    layers: {
      ec2Console: { ok: true, port: 8787, host: "127.0.0.1", time: new Date().toISOString() },
      appServer: { ok: false, running: false, startedAt: null, restartCount: 0, lastError: "等待云端状态同步" },
      codexAuth: { ok: true, mode: "ChatGPT subscription", detail: "等待云端状态同步" },
      repos: [],
    },
  },
  instance: {
    name: "codex-cloud-worker",
    region: "ap-northeast-1",
    publicIp: "203.0.113.10",
    privateIp: "10.0.1.10",
    type: "t3.small",
    root: "/home/ubuntu/codex-cloud",
  },
  codex: {
    authenticated: true,
    mode: "ChatGPT subscription",
    detail: "Logged in using ChatGPT",
  },
  repos: [
    {
      id: "sample-app",
      name: "sample-app",
      path: "/home/ubuntu/codex-cloud/workspace/sample-app",
      remote: "example-org/sample-app",
      accent: "teal",
      present: true,
      branch: "main",
      commit: "abcdef0",
      dirty: false,
      statusText: "## main...origin/main",
      lastCommit: "Update sample application",
    },
    {
      id: "sample-service",
      name: "sample-service",
      path: "/home/ubuntu/codex-cloud/workspace/sample-service",
      remote: "example-org/sample-service",
      accent: "blue",
      present: true,
      branch: "main",
      commit: "bcdef01",
      dirty: false,
      statusText: "## main...origin/main",
      lastCommit: "Update sample service",
    },
    {
      id: "sample-data",
      name: "sample-data",
      path: "/home/ubuntu/codex-cloud/workspace/sample-data",
      remote: "example-org/sample-data",
      accent: "amber",
      present: true,
      branch: "main",
      commit: "cdef012",
      dirty: false,
      statusText: "## main...origin/main",
      lastCommit: "Refresh sample data",
    },
  ],
  automations: [
    {
      id: "sample-maintenance",
      name: "Sample repository maintenance",
      repoId: "sample-app",
      timer: "codex-auto-sample-maintenance.timer",
      service: "codex-auto-sample-maintenance.service",
      schedule: "Weekdays 09:30",
      model: "gpt-5.6-terra",
      reasoning: "high",
      enabled: true,
      nextRun: "今天 09:30",
      lastRun: "尚未运行",
      run: fallbackRun,
    },
    {
      id: "sample-research",
      name: "Sample research queue",
      repoId: "sample-app",
      timer: "codex-auto-sample-research.timer",
      service: "codex-auto-sample-research.service",
      schedule: "Every 30 minutes",
      model: "gpt-5.6-terra",
      reasoning: "high",
      enabled: true,
      nextRun: "等待调度",
      lastRun: "尚未运行",
      run: fallbackRun,
    },
    {
      id: "sample-hourly",
      name: "Sample hourly analysis",
      repoId: "sample-app",
      timer: "codex-auto-sample-hourly.timer",
      service: "codex-auto-sample-hourly.service",
      schedule: "Hourly",
      model: "gpt-5.6-terra",
      reasoning: "high",
      enabled: true,
      nextRun: "等待调度",
      lastRun: "尚未运行",
      run: fallbackRun,
    },
    {
      id: "sample-verification",
      name: "Sample completion check",
      repoId: "sample-app",
      timer: "codex-auto-sample-verification.timer",
      service: "codex-auto-sample-verification.service",
      schedule: "Weekdays 09:50",
      model: "gpt-5.6-terra",
      reasoning: "medium",
      enabled: true,
      nextRun: "今天 09:50",
      lastRun: "尚未运行",
      run: fallbackRun,
    },
    {
      id: "sample-service-refresh",
      name: "Sample service refresh",
      repoId: "sample-service",
      timer: "codex-auto-sample-service-refresh.timer",
      service: "codex-auto-sample-service-refresh.service",
      schedule: "Daily 18:30",
      model: "gpt-5.6-terra",
      reasoning: "medium",
      enabled: true,
      nextRun: "今天 18:30",
      lastRun: "尚未运行",
      run: fallbackRun,
    },
    {
      id: "sample-data-refresh",
      name: "Sample data refresh",
      repoId: "sample-data",
      timer: "codex-auto-sample-data-refresh.timer",
      service: "codex-auto-sample-data-refresh.service",
      schedule: "Every 24 hours",
      model: "gpt-5.6-terra",
      reasoning: "high",
      enabled: true,
      nextRun: "明天 00:38",
      lastRun: "今天 00:38",
      run: fallbackRun,
    },
  ],
  automationRuns: [],
  automationInbox: {
    needsAttention: [],
    active: [],
    recent: [],
    archived: [],
  },
  externalNotifications: {
    configured: false,
    channels: [
      { id: "webhook", label: "Generic webhook", enabled: false, target: "", lastDeliveredAt: null, lastError: null },
      { id: "slack", label: "Slack webhook", enabled: false, target: "", lastDeliveredAt: null, lastError: null },
      { id: "telegram", label: "Telegram bot", enabled: false, target: "", lastDeliveredAt: null, lastError: null },
    ],
    deliveredCount: 0,
    lastCheckAt: null,
    lastSentAt: null,
    lastError: null,
    pollMs: 60000,
  },
  pushNotifications: {
    supported: true,
    configured: false,
    publicKey: "",
    subject: "",
    subscriptionCount: 0,
    subscriptions: [],
    lastDeliveredAt: null,
    lastTestAt: null,
    lastError: null,
  },
  diagnostics: null,
  appServerLive: { latestEvents: [], mcpStartup: {}, skillsChangedAt: null, appListUpdated: null, remoteControl: null },
  logs: [
    {
      id: "mock-log",
      job: "sample-data-refresh",
      name: "sample-data-refresh-latest.log",
      size: 619,
      updatedAt: new Date().toISOString(),
      tail: ["Codex 运行已完成", "定时器等待下一次运行"],
    },
  ],
  events: [
    { tone: "ok", text: "云端 GitHub 凭据可用。" },
    { tone: "ok", text: "系统定时器已启用并等待运行。" },
    { tone: "info", text: "云端控制台已就绪。" },
  ],
};

function cx(...classes: Array<string | false | undefined>) {
  return classes.filter(Boolean).join(" ");
}

function browserPushSupported() {
  return typeof window !== "undefined" && window.isSecureContext && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function baseBrowserPushReadiness(): BrowserPushReadiness {
  if (typeof window === "undefined") {
    return {
      secureContext: false,
      localOrigin: false,
      serviceWorker: false,
      pushManager: false,
      notifications: false,
      supported: false,
      permission: "unsupported",
      workerRegistered: false,
      workerScope: null,
      endpoint: null,
      error: null,
    };
  }
  const hostname = window.location.hostname;
  const localOrigin = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  const serviceWorker = "serviceWorker" in navigator;
  const pushManager = "PushManager" in window;
  const notifications = "Notification" in window;
  const secureContext = window.isSecureContext;
  return {
    secureContext,
    localOrigin,
    serviceWorker,
    pushManager,
    notifications,
    supported: secureContext && serviceWorker && pushManager && notifications,
    permission: notifications ? window.Notification.permission : "unsupported",
    workerRegistered: false,
    workerScope: null,
    endpoint: null,
    error: null,
  };
}

async function detectBrowserPushReadiness(): Promise<BrowserPushReadiness> {
  const base = baseBrowserPushReadiness();
  if (typeof window === "undefined" || !base.serviceWorker) return base;
  try {
    const registrations = typeof navigator.serviceWorker.getRegistrations === "function" ? await navigator.serviceWorker.getRegistrations() : [];
    const registration =
      registrations.find((item) => {
        const scripts = [item.active?.scriptURL, item.installing?.scriptURL, item.waiting?.scriptURL].filter(Boolean);
        return scripts.some((script) => script?.endsWith("/codex-cloud-sw.js"));
      }) ||
      registrations[0] ||
      (await navigator.serviceWorker.getRegistration());
    const subscription = base.pushManager ? await registration?.pushManager.getSubscription() : null;
    return {
      ...base,
      workerRegistered: Boolean(registration),
      workerScope: registration?.scope || null,
      endpoint: subscription?.endpoint || null,
      error: null,
    };
  } catch (error) {
    return {
      ...base,
      error: error instanceof Error ? error.message : "Service Worker 状态读取失败",
    };
  }
}

function urlBase64ToUint8Array(value: string) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = `${value}${padding}`.replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  return Uint8Array.from([...raw].map((char) => char.charCodeAt(0)));
}

function apiErrorMessage(data: unknown, fallback: string) {
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    for (const key of ["error", "message", "output"]) {
      if (typeof record[key] === "string" && record[key]) return String(record[key]);
    }
  }
  return fallback;
}

function nonJsonResponseError(text: string, status: number, fallback = "请求失败") {
  const compact = String(text || "").replace(/\s+/g, " ").trim();
  if (!compact || /<!doctype\s+html|<html[\s>]/i.test(compact)) return `${fallback}（HTTP ${status}）`;
  return compact.slice(0, 500);
}

async function responseFailureMessage(response: Response, fallback = "请求失败") {
  const text = await response.text();
  if (text) {
    try {
      return apiErrorMessage(JSON.parse(text), `${fallback}（HTTP ${response.status}）`);
    } catch {
      return nonJsonResponseError(text, response.status, fallback);
    }
  }
  return `${fallback}（HTTP ${response.status}）`;
}

async function parseJsonResponse(response: Response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    if (!response.ok) throw new Error(nonJsonResponseError(text, response.status));
    throw new Error(`API returned non-JSON response: ${text.slice(0, 200)}`);
  }
}

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  const data = await parseJsonResponse(response);
  if (!response.ok) {
    throw new Error(apiErrorMessage(data, `HTTP ${response.status}`));
  }
  if (data && typeof data === "object" && (data as { ok?: unknown }).ok === false) {
    throw new Error(apiErrorMessage(data, "API returned ok:false"));
  }
  return data as T;
}

async function apiWithDeadline<T>(url: string, options: RequestInit = {}, timeoutMs = 15_000): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await api<T>(url, { ...options, signal: options.signal || controller.signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("请求超时，请稍后重试");
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function apiWithRetry<T>(url: string, options?: RequestInit, attempts = 4): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await api<T>(url, options);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => window.setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("API request failed");
}

function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
}

function filesFromTransfer(transfer: DataTransfer | null) {
  if (!transfer) return [];
  const files = Array.from(transfer.files || []);
  if (files.length) return files;
  return Array.from(transfer.items || [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
}

function attachmentPayload(attachments: UploadedAttachment[]) {
  return attachments.map(({ previewUrl: _previewUrl, ...attachment }) => attachment);
}

function persistedDraftInput(input = "") {
  const trimmed = input.trim();
  if (trimmed.startsWith("/") && !trimmed.includes("\n")) return "";
  return input;
}

function draftPayload(input: string, attachments: UploadedAttachment[]) {
  return {
    input: persistedDraftInput(input),
    attachments: attachmentPayload(attachments),
  };
}

function draftSnapshot(input: string, attachments: UploadedAttachment[]) {
  return JSON.stringify(draftPayload(input, attachments));
}

function draftStorageKey(repoId: string, sessionId: string) {
  return `${repoId}:${sessionId}`;
}

function inlineComposerTrigger(value: string): ComposerTrigger | null {
  const match = value.match(/(^|\s)([$@])([^\s]*)$/);
  if (!match) return null;
  return {
    prefix: match[2] as "$" | "@",
    start: (match.index ?? 0) + match[1].length,
    end: value.length,
    query: match[3] || "",
  };
}

function replaceComposerToken(value: string, trigger: ComposerTrigger, insert: string) {
  return `${value.slice(0, trigger.start)}${insert}${value.slice(trigger.end)}`;
}

function attachmentIcon(attachment: Pick<UploadedAttachment, "kind" | "mimeType">) {
  if (attachment.kind === "image") return <Sparkles size={14} />;
  return <Paperclip size={14} />;
}

function MessageAttachments({ attachments }: { attachments?: UploadedAttachment[] }) {
  if (!attachments?.length) return null;
  return (
    <div className="message-attachments">
      {attachments.map((attachment, index) => (
        <a
          className={cx("message-attachment", attachment.kind === "image" && "image", attachment.generated && "generated")}
          href={attachment.previewUrl || "#"}
          target={attachment.previewUrl ? "_blank" : undefined}
          rel={attachment.previewUrl ? "noreferrer" : undefined}
          download={attachment.previewUrl && attachment.kind === "file" ? attachment.name : undefined}
          key={`${attachment.path}-${index}`}
          onClick={(event) => {
            if (!attachment.previewUrl) event.preventDefault();
          }}
          title={attachment.path}
        >
          {attachment.kind === "image" && attachment.previewUrl ? (
            <img alt={attachment.name} src={attachment.previewUrl} loading="lazy" />
          ) : (
            <span>{attachmentIcon(attachment)}</span>
          )}
          <strong>{attachment.name}</strong>
          <small>{attachment.size > 0 ? formatBytes(attachment.size) : attachment.kind === "image" ? "图片" : "文件"}</small>
        </a>
      ))}
    </div>
  );
}

function fileNameFromPath(value: string, fallback = "image") {
  const parts = value.replaceAll("\\", "/").split("/").filter(Boolean);
  return parts.at(-1) || fallback;
}

function pathIsAbsolute(value: string) {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

function imageMimeFromPath(value: string) {
  const ext = fileNameFromPath(value).split(".").pop()?.toLowerCase() || "";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  if (ext === "avif") return "image/avif";
  if (ext === "apng") return "image/apng";
  return "image/*";
}

function repoRelativeImagePath(repo: Repo, value: string) {
  const clean = String(value || "").replaceAll("\\", "/").trim();
  if (!clean) return null;
  const root = repo.path.replaceAll("\\", "/").replace(/\/+$/, "");
  if (clean === root) return null;
  if (clean.startsWith(`${root}/`)) return clean.slice(root.length + 1);
  if (!clean.startsWith("/")) return clean;
  return null;
}

function attachmentBlobUrl(repo: Repo, attachment: Pick<UploadedAttachment, "kind" | "path" | "absolutePath" | "previewUrl">) {
  if (attachment.previewUrl) return attachment.previewUrl;
  const relativePath = repoRelativeImagePath(repo, attachment.absolutePath || attachment.path);
  if (!relativePath) return undefined;
  if (attachment.kind !== "image" && !relativePath.startsWith(".codex-cloud/uploads/")) return undefined;
  const params = new URLSearchParams({ repoId: repo.id, path: relativePath });
  return `/api/files/blob?${params.toString()}`;
}

function withAttachmentPreview(repo: Repo, attachment: UploadedAttachment): UploadedAttachment {
  return {
    ...attachment,
    previewUrl: attachmentBlobUrl(repo, attachment),
  };
}

function imageAttachmentFromDetails(message: ChatMessage, repo: Repo): UploadedAttachment | null {
  const details = message.details || {};
  const kind = String(details.kind || "");
  if (kind !== "imageView" && kind !== "imageGeneration") return null;
  const imagePath = String(details.path || details.savedPath || "");
  if (kind === "imageGeneration" && pathIsAbsolute(imagePath)) {
    const params = new URLSearchParams({ path: imagePath });
    return {
      name: String(details.name || fileNameFromPath(imagePath)),
      path: imagePath,
      absolutePath: imagePath,
      mimeType: imageMimeFromPath(imagePath),
      size: Number(details.size || 0),
      kind: "image",
      previewUrl: `/api/codex/generated-image?${params.toString()}`,
      generated: true,
    };
  }
  const relativePath = repoRelativeImagePath(repo, imagePath);
  if (!relativePath) return null;
  const params = new URLSearchParams({ repoId: repo.id, path: relativePath });
  const name = String(details.name || fileNameFromPath(relativePath));
  return {
    name,
    path: relativePath,
    absolutePath: imagePath.startsWith("/") ? imagePath : undefined,
    mimeType: imageMimeFromPath(relativePath),
    size: Number(details.size || 0),
    kind: "image",
    previewUrl: `/api/files/blob?${params.toString()}`,
  };
}

function messageTimelineAttachments(message: ChatMessage, repo: Repo) {
  const attachments = (message.attachments || []).map((attachment) => withAttachmentPreview(repo, attachment));
  const imageAttachment = imageAttachmentFromDetails(message, repo);
  if (imageAttachment && !attachments.some((attachment) => attachment.path === imageAttachment.path || attachment.absolutePath === imageAttachment.absolutePath)) {
    attachments.push(imageAttachment);
  }
  return attachments;
}

function hydrateChatDraft(repo: Repo, draft?: ChatDraft | null): ChatDraft {
  return {
    input: persistedDraftInput(draft?.input || ""),
    attachments: (draft?.attachments || []).map((attachment) => withAttachmentPreview(repo, attachment)),
    updatedAt: draft?.updatedAt || null,
  };
}

function mentionQueryParts(query: string) {
  const clean = query.replace(/^\.?\//, "");
  const slashIndex = clean.lastIndexOf("/");
  if (slashIndex < 0) return { directory: ".", leaf: clean };
  return {
    directory: clean.slice(0, slashIndex) || ".",
    leaf: clean.slice(slashIndex + 1),
  };
}

function timeLabel(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
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

function dateKeyFromParts(parts: { year: string; month: string; day: string }) {
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function relativeDateLabel(year: string, month: string, day: string) {
  const today = dateKeyFromParts(datePartsInShanghai());
  const target = `${year}-${month}-${day}`;
  if (target === today) return "今天";
  const tomorrow = new Date(`${today}T00:00:00+08:00`);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (target === dateKeyFromParts(datePartsInShanghai(tomorrow))) return "明天";
  return `${Number(month)}月${Number(day)}日`;
}

function displayHumanDateTime(value?: string | null) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const systemd = text.match(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::\d{2})?\s+[A-Z]+/i);
  if (systemd) return `${relativeDateLabel(systemd[1], systemd[2], systemd[3])} ${systemd[4]}:${systemd[5]}`;
  const months: Record<string, string> = {
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
      if (english[6].toUpperCase() === "PM" && hour < 12) hour += 12;
      if (english[6].toUpperCase() === "AM" && hour === 12) hour = 0;
      return `${relativeDateLabel(english[3], month, String(Number(english[2])).padStart(2, "0"))} ${String(hour).padStart(2, "0")}:${english[5]}`;
    }
  }
  return text;
}

function sessionSubtitle(session: ChatSession) {
  const draftInput = persistedDraftInput(session.draft?.input || "").trim();
  const draftAttachmentCount = session.draft?.attachments?.length || 0;
  const draftLabel =
    draftInput || draftAttachmentCount
      ? `草稿${draftAttachmentCount ? ` · ${draftAttachmentCount} 附件` : ""}`
      : "";
  const threadLabel = session.codexSessionId ? `会话 ${session.codexSessionId.slice(0, 8)}` : "";
  const parts = [threadLabel, session.messageCount > 0 ? `${session.messageCount} 条消息` : "", draftLabel].filter(Boolean);
  if (parts.length) return parts.join(" · ");
  return "草稿";
}

function isDraftChatSession(session: ChatSession) {
  if (typeof session.isDraft === "boolean") return session.isDraft;
  const title = (session.title || "").trim();
  return !session.codexSessionId && session.messageCount === 0 && (!title || title === "新会话" || title === "新对话");
}

function sessionDisplayTitle(session?: ChatSession | null) {
  if (!session) return "新对话";
  if (isDraftChatSession(session)) return "新对话";
  return session.title || "新对话";
}

function isVerificationChatSession(session: ChatSession) {
  const title = String(session.title || "").trim();
  const replyOnly = /^只回复\s+/i.test(title);
  const marker = title.replace(/^只回复\s+/i, "").replace(/\s+/g, "_").trim().toUpperCase();
  return (
    /^(?:GOAL_)?COMPACT_READY$/.test(marker) ||
    /^CLOUD_APP_[A-Z0-9_]*OK$/.test(marker) ||
    /^CODEX_[A-Z0-9_]*SMOKE[A-Z0-9_]*$/.test(marker) ||
    (replyOnly && /^[A-Z0-9]+(?:_[A-Z0-9]+)*_OK$/.test(marker))
  );
}

function visibleSessionList(sessions: ChatSession[], activeSessionId: string) {
  return sessions.filter((session) => !isDraftChatSession(session) || session.id === activeSessionId);
}

function attentionMatchesSession(item: AttentionItem, session: ChatSession) {
  if (item.repoId && item.repoId !== session.repoId) return false;
  const candidates = new Set([session.id, session.codexSessionId || "", session.codexSessionId ? `app-${session.codexSessionId}` : ""]);
  return Boolean(
    (item.sessionId && candidates.has(item.sessionId)) ||
      (item.threadId && candidates.has(item.threadId)) ||
      (item.runId && session.title?.includes(item.runId)),
  );
}

type SessionStateKind = "current" | "running" | "attention" | "draft" | "history" | "local" | "verification";

type SessionUiState = {
  kind: SessionStateKind;
  label: string;
  detail: string;
};

function activeJobMatchesSession(job: ActiveCodexJob, session: ChatSession) {
  const candidates = new Set([session.id, session.codexSessionId || "", session.codexSessionId ? `app-${session.codexSessionId}` : ""]);
  return Boolean((job.sessionId && candidates.has(job.sessionId)) || (job.threadId && candidates.has(job.threadId)));
}

function sessionAttentionItems(session: ChatSession, attention: AttentionSummary) {
  return attention.items.filter((item) => item.tone !== "neutral" && attentionMatchesSession(item, session));
}

function sessionUiState(session: ChatSession, activeSessionId: string, attention: AttentionSummary, activeJobs: ActiveCodexJob[] = []): SessionUiState {
  const runningJobs = activeJobs.filter((job) => activeJobMatchesSession(job, session));
  if (session.id === activeSessionId) {
    return {
	      kind: "current",
	      label: "当前",
	      detail: session.codexSessionId ? "当前云端会话" : "当前草稿",
    };
  }
  if (runningJobs.length) {
    return {
      kind: "running",
      label: "运行中",
      detail: runningJobs.map((job) => [activeJobKindLabel(job.kind), activeJobRuntimeLabel(job)].filter(Boolean).join(" · ")).join(" / "),
    };
  }
  const attentionItems = sessionAttentionItems(session, attention);
  if (attentionItems.length) {
    return {
      kind: "attention",
      label: "待处理",
	      detail: attentionItems[0]?.title || "这个会话有待处理事件",
    };
  }
	  if (isDraftChatSession(session)) return { kind: "draft", label: "草稿", detail: "尚未建立云端会话" };
  if (isVerificationChatSession(session)) return { kind: "verification", label: "验证", detail: "内部验证会话" };
	  return session.codexSessionId
	    ? { kind: "history", label: "历史", detail: "可恢复的云端会话" }
	    : { kind: "local", label: "本地", detail: "本地临时会话" };
}

function sessionGroupOrder(kind: SessionStateKind) {
  return {
    current: 0,
    running: 1,
    attention: 2,
    draft: 3,
    history: 4,
    local: 5,
    verification: 6,
  }[kind];
}

function sessionGroupTitle(kind: SessionStateKind) {
  return {
    current: "当前",
    running: "运行中",
    attention: "需要处理",
    draft: "草稿",
    history: "最近",
    local: "本地",
    verification: "验证",
  }[kind];
}

function sessionGroupHint(kind: SessionStateKind) {
  return {
	    current: "正在打开的会话",
	    running: "后端正在继续运行",
	    attention: "来自收件箱、审批或审计事件",
	    draft: "还没有绑定云端会话",
	    history: "可恢复的云端会话",
    local: "本地临时记录",
    verification: "用于回归测试的会话",
  }[kind];
}

function groupedSessions(
  sessions: ChatSession[],
  activeSessionId: string,
  attention: AttentionSummary,
  activeJobs: ActiveCodexJob[] = [],
) {
  const groups = new Map<SessionStateKind, ChatSession[]>();
  for (const session of sessions) {
    const state = sessionUiState(session, activeSessionId, attention, activeJobs);
    const bucket = groups.get(state.kind) || [];
    bucket.push(session);
    groups.set(state.kind, bucket);
  }
  return Array.from(groups.entries())
    .sort(([a], [b]) => sessionGroupOrder(a) - sessionGroupOrder(b))
    .map(([kind, items]) => ({
      kind,
      title: sessionGroupTitle(kind),
      hint: sessionGroupHint(kind),
      items,
    }));
}

// Adapted from MIT-licensed codexui's sidebar thread list: keep the default
// list short and reveal the rest with an explicit Show more affordance. The
// first screen is prioritized like Codex App: current thread, actionable
// threads, then recent resumable threads.
function compactSidebarSessions(
  sessions: ChatSession[],
  activeSessionId: string,
  expanded: boolean,
  attention: AttentionSummary,
  activeJobs: ActiveCodexJob[] = [],
  limit = 5,
) {
  const defaultSessions = sessions.filter((session) => session.id === activeSessionId || !isVerificationChatSession(session));
  if (expanded) return sessions;
  if (defaultSessions.length <= limit) return defaultSessions;
  const active = defaultSessions.find((session) => session.id === activeSessionId);
  const selected: ChatSession[] = [];
  const add = (session?: ChatSession) => {
    if (!session || selected.some((item) => item.id === session.id)) return;
    selected.push(session);
  };
  add(active);
  defaultSessions
    .filter((session) => activeJobs.some((job) => activeJobMatchesSession(job, session)))
    .forEach(add);
  defaultSessions
    .filter((session) => attention.items.some((item) => item.tone !== "neutral" && attentionMatchesSession(item, session)))
    .forEach(add);
  defaultSessions
    .filter((session) => session.codexSessionId && !isDraftChatSession(session))
    .forEach(add);
  defaultSessions.forEach(add);
  const visible = selected.slice(0, limit);
  if (!active || visible.some((session) => session.id === active.id)) return visible;
  return [...visible.slice(0, Math.max(0, limit - 1)), active];
}

function fallbackAttentionSummary(status: ConsoleStatus): AttentionSummary {
  const inbox = status.automationInbox || { needsAttention: [], active: [], recent: [], archived: [] };
  const auditIssues = (status.auditEvents || []).filter((event) => /error|failed|approval|elicitation|request/i.test(`${event.type} ${event.summary}`));
  return {
    count: inbox.needsAttention.length + inbox.active.length + auditIssues.length + (status.codex.authenticated ? 0 : 1),
    unreadCount: inbox.needsAttention.length + inbox.active.length + auditIssues.length + (status.codex.authenticated ? 0 : 1),
    totalCount: inbox.needsAttention.length + inbox.active.length + auditIssues.length,
    acknowledgedCount: 0,
    needsAttentionCount: inbox.needsAttention.length,
    activeCount: inbox.active.length,
    dirtyRepoCount: status.repos.filter((repo) => repo.dirty).length,
    auditIssueCount: auditIssues.length,
    latestItemId: auditIssues[0]?.id || inbox.needsAttention[0]?.id || inbox.active[0]?.id || "",
    latestTitle: auditIssues[0]?.summary || inbox.needsAttention[0]?.name || inbox.active[0]?.name || "",
    items: [],
  };
}

function getAttentionSummary(status: ConsoleStatus) {
  return status.attention || fallbackAttentionSummary(status);
}

function attentionCount(status: ConsoleStatus) {
  return getAttentionSummary(status).count;
}

function connectionFromStatus(status: ConsoleStatus): CloudConnection {
  if (statusIsPending(status)) return "checking";
  if (status.localMode) return "local";
  if (!status.health) return "cloud";
  if (status.health.ok && status.health.strictOk !== false && !status.health.partial) return "cloud";
  if (status.health.layers.ec2Console?.ok) return "degraded";
  return "offline";
}

function statusWithHealth(status: ConsoleStatus, health: HealthCheckResponse): ConsoleStatus {
  const repoHealth = new Map(health.layers.repos.map((repo) => [repo.id, repo]));
  return {
    ...status,
    generatedAt: new Date().toISOString(),
    localMode: false,
    health,
    codex: {
      ...status.codex,
      authenticated: health.layers.codexAuth.ok,
      mode: health.layers.codexAuth.mode || status.codex.mode,
      detail: health.layers.codexAuth.detail || status.codex.detail,
    },
    repos: status.repos.map((repo) => {
      const layer = repoHealth.get(repo.id);
      if (!layer) return repo;
      return {
        ...repo,
        path: layer.path || repo.path,
        present: layer.ok,
        branch: layer.branch || repo.branch,
        dirty: layer.dirty,
      };
    }),
  };
}

function statusIsPending(status: ConsoleStatus) {
  const appServer = status.health?.layers.appServer;
  return Boolean(
    appServer &&
      !appServer.running &&
      !appServer.startedAt &&
      appServer.lastError === "等待云端状态同步",
  );
}

function cloudEntryLabel(status: ConsoleStatus, cloudConnection?: CloudConnection) {
  if (cloudConnection === "checking" || statusIsPending(status)) return "同步中";
  if (cloudConnection === "offline") return "连接断开";
  if (status.localMode) return "本地开发";
  return "EC2 在线";
}

function appServerLayerLabel(status: ConsoleStatus, cloudConnection?: CloudConnection) {
  if (cloudConnection === "checking" || statusIsPending(status)) return "同步中";
  if (cloudConnection === "offline") return "断开";
  return status.health?.layers.appServer?.ok ? "在线" : "异常";
}

function connectionState(status: ConsoleStatus, cloudConnection: CloudConnection) {
  const health = status.health;
  if (cloudConnection === "checking") return { label: "同步中", tone: "warn" as const, detail: "云端状态后台同步中" };
  if (cloudConnection === "offline") return { label: "连接断开", tone: "warn" as const, detail: "本地入口无法连接云端 console" };
  if (statusIsPending(status)) return { label: "同步中", tone: "warn" as const, detail: "云端分层状态后台同步中" };
  if (cloudConnection === "local") return { label: "本地开发", tone: "warn" as const, detail: "当前使用本地开发快照" };
  if (health?.partial || health?.strictOk === false) {
    return {
      label: "云端 Codex 降级",
      tone: "warn" as const,
      detail: health.layers.appServer?.lastError || "入口可达，但核心能力未通过严格健康检查",
    };
  }
  if (health && !health.layers.appServer?.ok) {
    return {
	      label: "云端 Codex 异常",
	      tone: "warn" as const,
	      detail: health.layers.appServer?.lastError || "云端 Codex 探测失败",
    };
  }
  if (health && !health.layers.codexAuth?.ok) {
    return { label: "Codex 登录失效", tone: "warn" as const, detail: health.layers.codexAuth?.detail || "需要重新登录 Codex" };
  }
  const missingRepo = health?.layers.repos?.find((repo) => !repo.ok);
  if (missingRepo) {
    return { label: "仓库异常", tone: "warn" as const, detail: `${missingRepo.id} 不可用` };
  }
  if (health?.ok) {
	    return { label: "云端 Codex 在线", tone: "ok" as const, detail: "EC2 console、云端 Codex、登录和仓库状态均可用" };
  }
  if (cloudConnection === "cloud") {
    return { label: "云端已连接", tone: "ok" as const, detail: "本地入口可达，正在等待完整分层健康状态" };
  }
  return { label: "状态异常", tone: "warn" as const, detail: "云端分层状态未完全通过" };
}

function attentionTone(status: string) {
  if (/failed|error|interrupted|attention/i.test(status)) return "danger";
  if (/running|queued|active/i.test(status)) return "active";
  return "neutral";
}

function runStatusLabel(status: string) {
  if (/archived/i.test(status)) return "已归档";
  if (/failed|error/i.test(status)) return "失败";
  if (/interrupted/i.test(status)) return "已中断";
  if (/running/i.test(status)) return "运行中";
  if (/queued/i.test(status)) return "排队中";
  if (/completed|success/i.test(status)) return "已完成";
  if (/ready|ok/i.test(status)) return "就绪";
  if (/starting|activating/i.test(status)) return "启动中";
  if (/stopped|inactive/i.test(status)) return "空闲";
  if (/disabled/i.test(status)) return "未启用";
  return status || "未知";
}

function automationRunnerLabel(value = "") {
  const lower = value.toLowerCase();
  if (!value) return "云端 Codex";
  if (lower === "app-server" || lower === "codex-app-server") return "云端 Codex";
  if (lower === "codex" || lower === "cli") return "Codex CLI";
  if (lower === "local") return "本地";
  return value;
}

function automationTriggerLabel(value = "") {
  const lower = value.toLowerCase();
  if (!value) return "未知触发";
  if (lower.includes("heartbeat")) return "继续会话";
  if (lower.includes("webhook")) return "外部触发";
  if (lower.includes("manual") || lower.includes("run")) return "手动运行";
  if (lower.includes("schedule") || lower.includes("timer") || lower.includes("cron") || lower.includes("systemd")) return "定时运行";
  return value;
}

function automationWorktreeLabel(value = "") {
  const lower = value.toLowerCase();
  if (!value || lower === "none") return "未启用隔离";
  if (lower === "detached-worktree" || lower.includes("isolated")) return "隔离工作区";
  if (lower === "existing-thread") return "继续现有会话";
  if (lower === "repo-cwd" || lower === "repo") return "当前仓库";
  return value;
}

function serviceStateLabel(value = "") {
  const lower = value.toLowerCase();
  if (!value) return "未知";
  if (lower === "inactive") return "空闲";
  if (lower === "active") return "运行中";
  if (lower === "failed") return "失败";
  if (lower === "activating") return "启动中";
  if (lower === "deactivating") return "停止中";
  return value;
}

function exitCodeLabel(value = "") {
  if (!value) return "未知";
  if (value === "0") return "成功";
  if (/non-zero/i.test(value)) return "异常结束";
  return value;
}

function enabledFlagLabel(value?: boolean | null) {
  return value ? "开" : "关";
}

function activeJobKindLabel(kind = "") {
  if (kind === "compact") return "压缩上下文";
  if (kind === "turn") return "运行任务";
  return kind || "运行中";
}

function activeJobOpenTarget(job: ActiveCodexJob) {
  if (!job.repoId) return null;
  const sessionId = job.threadId || job.sessionId || "";
  if (!sessionId) return null;
  return { repoId: job.repoId, sessionId };
}

function activeJobRuntimeLabel(job: ActiveCodexJob) {
  return [job.repoId, job.runtime?.model, job.runtime?.reasoning].filter(Boolean).join(" · ");
}

function ActiveJobList({
  jobs,
  onOpenThread,
  limit = 3,
}: {
  jobs: ActiveCodexJob[];
  onOpenThread?: (repoId: string, sessionId: string) => void;
  limit?: number;
}) {
  const visible = jobs.slice(0, limit);
  if (!visible.length) return null;
  return (
	    <div className="active-job-list" aria-label="运行中的 Codex 任务">
      {visible.map((job) => {
        const target = activeJobOpenTarget(job);
        const body = (
          <>
            <span className="active-job-kind">
              <Loader2 size={13} className="spin" />
              {activeJobKindLabel(job.kind)}
              {job.threadId && <code>{job.threadId.slice(0, 8)}</code>}
            </span>
            <strong>{job.title || activeJobKindLabel(job.kind)}</strong>
	            <small>{job.body || "云端 Codex 正在运行..."}</small>
	            <em>{activeJobRuntimeLabel(job) || "云端 Codex"}</em>
          </>
        );
        if (target && onOpenThread) {
          return (
            <button className="active-job-row" type="button" key={job.id} onClick={() => onOpenThread(target.repoId, target.sessionId)}>
              {body}
            </button>
          );
        }
        return (
          <div className="active-job-row" key={job.id}>
            {body}
          </div>
        );
      })}
      {jobs.length > visible.length && <span className="active-job-more">还有 {jobs.length - visible.length} 个运行中任务</span>}
    </div>
  );
}

function notificationLabel(enabled: boolean, permission: string) {
  if (enabled) return "通知已开";
  if (permission === "unsupported") return "通知不可用";
  if (permission === "denied") return "通知被拒";
  return "开启通知";
}

function externalChannelLabel(channel: { id?: string; label?: string }) {
  if (channel.id === "webhook") return "通用通知";
  if (channel.id === "slack") return "Slack 通知";
  if (channel.id === "telegram") return "Telegram 通知";
  return channel.label || "外部通知";
}

function browserPermissionLabel(permission = "") {
  if (permission === "granted") return "已允许";
  if (permission === "denied") return "已拒绝";
  if (permission === "unsupported") return "不支持";
  if (permission === "default" || !permission) return "订阅时询问";
  return permission;
}

function mcpAuthNeedsLogin(authStatus?: string | null) {
  const normalized = String(authStatus || "").trim().replace(/[\s_-]+/g, "").toLowerCase();
  return ["notloggedin", "authrequired", "requiresoauth", "oauthrequired", "expired", "invalidtoken", "tokeninvalidated"].includes(normalized);
}

function mcpAuthStatusLabel(authStatus?: string | null) {
  const normalized = String(authStatus || "").trim().replace(/[\s_-]+/g, "").toLowerCase();
  if (!normalized) return "未知状态";
  if (normalized === "notloggedin") return "未登录";
  if (["authrequired", "requiresoauth", "oauthrequired"].includes(normalized)) return "需要登录";
  if (["expired", "invalidtoken", "tokeninvalidated"].includes(normalized)) return "登录失效";
  if (normalized === "bearertoken") return "令牌已配置";
  if (normalized === "unsupported") return "不支持登录";
  return authStatus || "未知状态";
}

function displayUsageLimitText(value?: string | null) {
  const text = String(value || "").trim();
  if (/^Codex 额度已达上限[。.]?$/.test(text)) return "";
  if (!/usageLimitExceeded|usage limit|purchase more credits|rateLimitReachedType|rate limit reached|Codex 额度已达上限/i.test(text)) return "";
  const retryAtText =
    text.match(/try again at ([^."\n)]+)/i)?.[1]?.trim() ||
    text.match(/可在\s*([^。]+?)\s*后重试/)?.[1]?.trim();
  const mergedText = text.match(/（已合并\s*\d+\s*条自动化失败）/)?.[0] || "";
  const retryAtLabel = retryAtText ? displayHumanDateTime(retryAtText) : "";
  const body = retryAtText
    ? `Codex 额度已达上限，可在 ${retryAtLabel} 后重试。`
    : "Codex 额度已达上限。请稍后重试，或打开额度设置查看可用额度。";
  return `${body}${mergedText}`;
}

function displayQuotaValue(
  usageLimit?: { title?: string | null; retryAtText?: string | null } | null,
  fallback = "未知",
) {
  if (!usageLimit) return fallback;
  const retryText = usageLimit.retryAtText ? ` · ${displayHumanDateTime(usageLimit.retryAtText)}` : "";
  const title = String(usageLimit.title || "").trim();
  const value = /额度已达上限/.test(title) ? "已达上限" : title || "受限";
  return `${value}${retryText}`;
}

function displayCapabilityText(value?: string | null) {
  const usageLimitText = displayUsageLimitText(value);
  if (usageLimitText) return usageLimitText;
  return displayAutomationText(value)
    .replace(/^Plugins:/i, "插件：")
    .replace(/^App list/i, "App 列表")
    .replace(/^appList:/i, "App 列表：")
    .replace(/Realtime voice\/audio/gi, "实时语音/音频")
    .replace(/The ([\w-]+) MCP server is not logged in\. Run `codex mcp login [^`]+`\./gi, "$1 MCP 未登录。")
    .replace(/failed to list apps:/gi, "无法读取 App 列表：")
    .replace(/\bauthStatus:\s*notLoggedIn\b/gi, "需要登录")
    .replace(/\bauthStatus:\s*bearerToken\b/gi, "令牌已配置")
    .replace(/\bauthStatus:\s*unsupported\b/gi, "不支持登录")
    .replace(/\bstatus:\s*ready\b/gi, "状态：就绪")
    .replace(/\bstatus:\s*failed\b/gi, "状态：失败")
    .replace(/Request failed with status 403 Forbidden:[\s\S]*/gi, "请求被拒绝（403）")
    .replace(/<html>[\s\S]*/gi, "请求返回了 HTML 错误页。")
    .replace(/App 列表 当前/g, "App 列表当前")
    .replace(/实时语音\/音频 是/g, "实时语音/音频是")
    .replace(/：\s+/g, "：");
}

function shortDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatTokenCount(value?: number | null) {
  if (!value) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 100) / 10}k`;
  return String(value);
}

function contextTokenCount(usage?: ThreadTokenUsage | null) {
  return usage?.last?.inputTokens || usage?.last?.totalTokens || 0;
}

function contextDisplayTokenCount(usage?: ThreadTokenUsage | null) {
  const raw = contextTokenCount(usage);
  const windowSize = usage?.modelContextWindow || 0;
  return windowSize > 0 ? Math.min(raw, windowSize) : raw;
}

function contextPercent(usage?: ThreadTokenUsage | null) {
  if (!usage?.modelContextWindow) return 0;
  return Math.min(100, Math.round((contextTokenCount(usage) / usage.modelContextWindow) * 100));
}

function contextUsageDetail(usage?: ThreadTokenUsage | null) {
  const raw = contextTokenCount(usage);
  const windowSize = usage?.modelContextWindow || 0;
  if (!raw && !windowSize) return "等待 token";
  if (!windowSize) return `${formatTokenCount(raw)} ctx`;
  const visible = contextDisplayTokenCount(usage);
  const overflow = raw > windowSize ? ` · raw ${formatTokenCount(raw)}` : "";
  return `${formatTokenCount(visible)} / ${formatTokenCount(windowSize)}${overflow}`;
}

function contextTone(usage?: ThreadTokenUsage | null, compact?: CompactStatus | null) {
  if (compact?.running) return "active";
  if (compact?.ok === false) return "warn";
  const percent = contextPercent(usage);
  if (percent >= 95) return "warn";
  if (percent >= 80) return "notice";
  return "ok";
}

function autoCompactScopeLabel(value?: string | null) {
  if (value === "total") return "全部上下文";
  if (value === "body_after_prefix") return "正文";
  return value || "正文";
}

function isCompactStatus(text = "") {
  return /压缩|摘要|compact/i.test(text);
}

function settleStaleStreamingMessages(messages: ChatMessage[]) {
  return messages.map((message) => {
    if (!message.streaming) return message;
    const marker = `${message.text || ""} ${message.status || ""}`;
    if (!isCompactStatus(marker)) return message;
    return {
      ...message,
      streaming: false,
      status: "已结束",
      text: message.text || "上一次上下文压缩已结束；最新状态请看状态面板。",
    };
  });
}

function timelineMessageMeta(message: ChatMessage) {
  const type = message.messageType || "";
  const status = message.status || "";
  const marker = `${type} ${status}`;
  if (/commandExecution|command/i.test(marker)) return { label: "命令", className: "tool-item", pre: false };
  if (/hookPrompt|hook /i.test(marker)) return { label: "Hook", className: "hook-item", pre: false };
  if (/fileChange|filePatch/i.test(marker)) return { label: "文件", className: "file-item", pre: false };
  if (/diff/i.test(marker)) return { label: "差异", className: "diff-item", pre: true };
  if (/functionCallOutput/i.test(marker)) return { label: "结果", className: "tool-item", pre: false };
  if (/subAgentActivity/i.test(marker)) return { label: "子 Agent", className: "agent-item", pre: false };
  if (/collabAgentToolCall|collabAgent|agent /i.test(marker)) return { label: "Agent", className: "agent-item", pre: false };
  if (/mcpToolCall|mcp/i.test(marker)) return { label: "MCP", className: "tool-item", pre: false };
  if (/dynamicToolCall|tool/i.test(marker)) return { label: "工具", className: "tool-item", pre: false };
  if (/guardian|autoApprovalReview|auto review/i.test(marker)) return { label: "权限", className: "approval-item guardian-item", pre: false };
  if (/approval|elicitation|requestUserInput/i.test(marker)) return { label: "权限", className: "approval-item", pre: false };
  if (/reasoning/i.test(marker)) return { label: "推理", className: "reasoning-item", pre: false };
  if (/contextCompaction|compact/i.test(marker)) return { label: "压缩", className: "compact-item", pre: false };
  if (/review/i.test(marker)) return { label: "审查", className: "review-item", pre: false };
  if (/webSearch/i.test(marker)) return { label: "搜索", className: "tool-item", pre: false };
  if (/imageGeneration/i.test(marker) && /failed/i.test(marker)) return { label: "图片失败", className: "error-item", pre: false };
  if (/imageView|imageGeneration|image/i.test(marker)) return { label: "图片", className: "tool-item", pre: false };
  if (/sleep/i.test(marker)) return { label: "等待", className: "tool-item", pre: false };
  if (/turnError|failed/i.test(marker)) return { label: "错误", className: "error-item", pre: false };
  return { label: "", className: "", pre: false };
}

function timelineStatusLabel(status = ""): string {
  const value = String(status || "").trim();
  if (!value) return "";
  const lower = value.toLowerCase();
  if (lower === "unknown") return "未知";
  if (lower === "none") return "无";
  if (lower === "default") return "默认";
  if (lower.startsWith("filechange ")) return `文件 ${timelineStatusLabel(value.replace(/^fileChange\s+/i, "")) || value.replace(/^fileChange\s+/i, "")}`;
  if (lower.startsWith("command ")) return `命令 ${timelineStatusLabel(value.replace(/^command\s+/i, "")) || value.replace(/^command\s+/i, "")}`;
  if (lower.startsWith("mcp ")) return `MCP ${timelineStatusLabel(value.replace(/^mcp\s+/i, "")) || value.replace(/^mcp\s+/i, "")}`;
  if (lower.startsWith("tool ")) return `工具 ${timelineStatusLabel(value.replace(/^tool\s+/i, "")) || value.replace(/^tool\s+/i, "")}`;
  if (lower.startsWith("agent ")) return `Agent ${timelineStatusLabel(value.replace(/^agent\s+/i, "")) || value.replace(/^agent\s+/i, "")}`;
  if (lower.startsWith("hook ")) return `Hook ${timelineStatusLabel(value.replace(/^hook\s+/i, "")) || value.replace(/^hook\s+/i, "")}`;
  if (lower.startsWith("guardian ")) return `权限审查 ${timelineStatusLabel(value.replace(/^guardian\s+/i, "")) || value.replace(/^guardian\s+/i, "")}`;
  if (lower === "started" || lower.endsWith(" started")) return "已开始";
  if (lower === "pending" || lower === "queued" || lower.endsWith(" pending") || lower.endsWith(" queued")) return "排队中";
  if (lower === "running" || lower.endsWith(" running") || lower === "streaming" || lower.endsWith(" streaming")) return "进行中";
  if (lower === "completed" || lower.endsWith(" completed")) return "已完成";
  if (lower === "inprogress" || lower.endsWith(" inprogress") || lower.includes("in_progress")) return "进行中";
  if (lower === "success" || lower.endsWith(" success")) return "成功";
  if (lower === "ok" || lower.endsWith(" ok")) return "正常";
  if (lower === "approved" || lower.endsWith(" approved")) return "已通过";
  if (lower === "denied" || lower.endsWith(" denied")) return "已拒绝";
  if (lower === "timedout" || lower.endsWith(" timedout")) return "已超时";
  if (lower === "aborted" || lower.endsWith(" aborted")) return "已取消";
  if (lower === "failed" || lower.endsWith(" failed")) return "失败";
  if (lower === "declined" || lower.endsWith(" declined")) return "已拒绝";
  if (lower === "interrupted" || lower.endsWith(" interrupted")) return "已中断";
  if (lower === "recorded" || lower.endsWith(" recorded")) return "已记录";
  return value;
}

function detailText(value: unknown) {
  if (value == null || value === "") return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value, null, 2);
}

function detailFallback(value: unknown, fallback = "未返回") {
  return detailText(value) || fallback;
}

function escapeRegExpText(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function displayProjectMessageText(value: unknown, repo?: Repo) {
  let text = detailText(value);
  const repoPath = String(repo?.path || "").replaceAll("\\", "/").replace(/\/+$/, "");
  if (repoPath) {
    const escapedRepoPath = escapeRegExpText(repoPath);
    text = text
      .replace(new RegExp(`${escapedRepoPath}/`, "g"), "")
    .replace(new RegExp(escapedRepoPath, "g"), ".");
  }
  return text
    .replace(/\/home\/ubuntu\/codex-cloud\/workspace\/[^/\s)\]]+\//g, "")
    .replace(/\/home\/ubuntu\/codex-cloud\/console\//g, "")
    .replace(/\/home\/ubuntu\/codex-cloud\/worktrees\/[^/\s)\]]+\//g, "隔离工作区/")
    .replace(/\/home\/ubuntu\/codex-cloud\/worktrees\/[^/\s)\]]+/g, "隔离工作区")
    .replace(/\bworktrees?\b/gi, "隔离工作区")
    .replace(/独立\s+隔离工作区/g, "独立隔离工作区")
    .replace(/隔离工作区\s+来/g, "隔离工作区来");
}

function displayFileChangePathText(value: unknown) {
  const text = detailText(value).replaceAll("\\", "/").trim();
  if (!text) return "";
  const workspaceMatch = text.match(/(?:^|\/)codex-cloud\/workspace\/[^/]+\/(.+)$/);
  if (workspaceMatch?.[1]) return workspaceMatch[1];
  const consoleMatch = text.match(/(?:^|\/)codex-cloud\/console\/(.+)$/);
  if (consoleMatch?.[1]) return consoleMatch[1];
  const worktreeMatch = text.match(/(?:^|\/)codex-cloud\/worktrees\/[^/]+\/(.+)$/);
  if (worktreeMatch?.[1]) return worktreeMatch[1];
  return text;
}

function displayFileChangeDiffText(value: unknown) {
  const text = detailText(value);
  if (!text) return "";
  return text
    .replace(/\/home\/ubuntu\/codex-cloud\/workspace\/[^/\s]+\/?/g, "")
    .replace(/\/home\/ubuntu\/codex-cloud\/console\/?/g, "")
    .replace(/\/home\/ubuntu\/codex-cloud\/worktrees\/[^/\s]+\/?/g, "");
}

function displayCommandLineText(value: unknown, fallback = "命令未返回") {
  const text = detailText(value)
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\/bin\/(?:bash|sh)\s+-lc\s*/i, "")
    .trim()
    .replace(/^(['"])([\s\S]*)\1$/, "$2")
    .trim();
  if (!text) return fallback;
  if (/printf\s+['"]?%s['"]?/i.test(text) && /(opaque payload redacted|[A-Za-z0-9+/=_-]{80,})/.test(text)) {
    return "printf '<payload>'";
  }
  if (/(base64|payload|blob)/i.test(text) && /[A-Za-z0-9+/=_-]{80,}/.test(text)) {
    return text.replace(/[A-Za-z0-9+/=_-]{80,}/g, "<payload>");
  }
  if (text.length > 260) return `${text.slice(0, 259)}…`;
  return text;
}

function timelineDetailTitle(kind: string) {
  const labels: Record<string, string> = {
    command: "命令",
    hookPrompt: "Hook 请求",
    agentMessage: "消息",
    reasoning: "推理",
    approval: "权限请求",
    guardianReview: "权限自动审查",
    mcpProgress: "MCP 进度",
    terminalInteraction: "终端输入",
    requestResolved: "请求已处理",
    modelRerouted: "模型切换",
    modelVerification: "模型验证",
    mcp: "MCP 工具",
    tool: "动态工具",
    functionCallOutput: "函数结果",
    collabAgent: "Agent 协作",
    subAgentActivity: "子 Agent 活动",
    webSearch: "联网搜索",
    imageView: "图片查看",
    imageGeneration: "图片生成",
    sleep: "等待",
    review: "代码审查",
  };
  return labels[kind] || "事件详情";
}

function detailSourceLabel(value?: string | null) {
  const text = String(value || "").trim();
  const normalized = text.replace(/[\s_-]+/g, "").toLowerCase();
  if (!normalized) return "未返回";
  if (normalized === "appserver") return "云端 Codex";
  if (normalized === "appservercommand") return "云端命令";
  if (normalized === "localfallback") return "本地兜底";
  if (normalized === "automation") return "自动化";
  if (normalized === "host") return "主机";
  if (normalized === "audit") return "审计";
  if (normalized === "local") return "本地";
  if (normalized === "cli" || normalized === "codexcli") return "Codex CLI";
  if (normalized === "live" || normalized === "stream") return "实时事件";
  return text;
}

function detailPhaseLabel(value?: string | null, fallback = "已开始") {
  const text = detailText(value);
  if (!text) return fallback;
  const normalized = text.replace(/[\s_-]+/g, "").toLowerCase();
  const labels: Record<string, string> = {
    commentary: "进展更新",
    finalanswer: "最终回复",
    assistantmessage: "Codex 回复",
    assistant: "Codex 回复",
    user: "用户消息",
    analysis: "推理过程",
    toolcall: "工具调用",
    toolresult: "工具结果",
    command: "命令",
    mcp: "MCP",
  };
  if (labels[normalized]) return labels[normalized];
  return timelineStatusLabel(text) || text;
}

function detailSuccessLabel(value: unknown) {
  if (value === true) return "成功";
  if (value === false) return "失败";
  return "未返回";
}

function guardianMessagePatch(payload: Record<string, unknown>, fallback = "Codex 已处理权限自动审查") {
  return {
    status: String(payload.summary || fallback),
    messageType: "approval",
    details: {
      kind: "guardianReview",
      phase: payload.phase,
      method: payload.method,
      reviewId: payload.reviewId,
      threadId: payload.threadId,
      turnId: payload.turnId,
      itemId: payload.itemId,
      targetItemId: payload.targetItemId,
      status: payload.status,
      riskLevel: payload.riskLevel,
      userAuthorization: payload.userAuthorization,
      rationale: payload.rationale,
      actionType: payload.actionType,
      actionSummary: payload.actionSummary,
      decisionSource: payload.decisionSource,
      startedAtMs: payload.startedAtMs,
      completedAtMs: payload.completedAtMs,
      review: payload.review,
      action: payload.action,
    },
  };
}

function liveToolEventLabel(payload: Record<string, unknown>, review = false) {
  const type = String(payload.type || "");
  if (type === "command") return `运行命令: ${displayCommandLineText(payload.command, "shell")}`;
  if (type === "filePatch") return review ? "更新 review diff" : "更新文件补丁";
  if (type === "diff") return "更新 diff";
  if (type === "plan") return review ? "更新 review 计划" : "更新计划";
  if (type === "reasoning") return review ? "正在整理 review 推理摘要" : "正在整理推理摘要";
  if (type === "mcpProgress") return `MCP 进度: ${String(payload.message || "工具仍在运行").slice(0, 180)}`;
  if (type === "terminalInteraction") return "终端交互已发送";
  if (type === "requestResolved") return "请求已处理";
  if (type === "modelRerouted") return `模型已切换: ${String(payload.fromModel || "未知模型")} -> ${String(payload.toModel || "未知模型")}`;
  if (type === "modelVerification") return "模型验证已更新";
  return "";
}

function liveToolEventPatch(payload: Record<string, unknown>, review = false): Partial<ChatMessage> {
  const type = String(payload.type || "");
  const label = liveToolEventLabel(payload, review);
  if (type === "mcpProgress") {
    return {
      status: label,
      messageType: "mcpToolCall",
      details: {
        kind: "mcpProgress",
        message: payload.message,
        itemId: payload.itemId,
        threadId: payload.threadId,
        turnId: payload.turnId,
      },
    };
  }
  if (type === "terminalInteraction") {
    return {
      status: label,
      messageType: "commandExecution",
      details: {
        kind: "terminalInteraction",
        processId: payload.processId,
        stdin: payload.stdin,
        itemId: payload.itemId,
        threadId: payload.threadId,
        turnId: payload.turnId,
      },
    };
  }
  if (type === "requestResolved") {
    return {
      status: label,
      messageType: "approval",
      details: {
        kind: "requestResolved",
        requestId: payload.requestId,
        threadId: payload.threadId,
      },
    };
  }
  if (type === "modelRerouted") {
    return {
      status: label,
      messageType: "model",
      details: {
        kind: "modelRerouted",
        fromModel: payload.fromModel,
        toModel: payload.toModel,
        reason: payload.reason,
        threadId: payload.threadId,
        turnId: payload.turnId,
      },
    };
  }
  if (type === "modelVerification") {
    return {
      status: label,
      messageType: "model",
      details: {
        kind: "modelVerification",
        verifications: payload.verifications,
        threadId: payload.threadId,
        turnId: payload.turnId,
      },
    };
  }
  return label ? { status: label } : {};
}

async function copyText(value: string) {
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    return;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "true");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    document.body.removeChild(textarea);
  }
}

function TimelineDetailsPanel({ details }: { details?: Record<string, unknown> }) {
  const [copied, setCopied] = useState("");
  if (!details) return null;
  const kind = String(details.kind || "details");
  const changes = Array.isArray(details.changes) ? (details.changes as Array<Record<string, unknown>>) : [];
  const hookFragments = Array.isArray(details.fragments) ? (details.fragments as Array<Record<string, unknown>>) : [];
  const hookText = detailText(hookFragments.map((fragment, index) => `${detailText(fragment.hookRunId) || `Hook-${index + 1}`}\n${detailText(fragment.text)}`).join("\n\n"));
  const memoryCitation = details.memoryCitation && typeof details.memoryCitation === "object" ? (details.memoryCitation as Record<string, unknown>) : null;
  const memoryEntries = Array.isArray(memoryCitation?.entries) ? (memoryCitation.entries as Array<Record<string, unknown>>) : [];
  const memoryThreadIds = Array.isArray(memoryCitation?.threadIds) ? (memoryCitation.threadIds as unknown[]) : [];
  const memoryCitationText = detailText(memoryCitation);
  const reasoningSummary = detailText(details.summary);
  const reasoningContent = detailText(details.content);
  const commandActions = Array.isArray(details.commandActions) ? (details.commandActions as unknown[]) : [];
  const commandActionsText = detailText(details.commandActions);
  const toolArguments = detailText(details.arguments);
  const toolResult = detailText(details.result);
  const toolError = detailText(details.error);
  const toolContentItems = detailText(details.contentItems);
  const liveEventText = detailText(details.message || details.stdin || details.requestId || details.verifications || details);
  const guardianReview = details.review && typeof details.review === "object" ? (details.review as Record<string, unknown>) : null;
  const guardianAction = details.action && typeof details.action === "object" ? (details.action as Record<string, unknown>) : null;
  const guardianReviewText = detailText({ review: guardianReview, action: guardianAction });
  const collabReceivers = Array.isArray(details.receiverThreadIds) ? (details.receiverThreadIds as unknown[]) : [];
  const collabPrompt = detailText(details.prompt);
  const collabStates = detailText(details.agentsStates);
  const asyncQuestions = Array.isArray(details.questions) ? (details.questions as Array<Record<string, unknown>>) : [];
  const webSearchResults = Array.isArray(details.results) ? (details.results as Array<Record<string, unknown>>) : [];
  const imageFailure = details.failure && typeof details.failure === "object" ? (details.failure as Record<string, unknown>) : null;
  const copyDetail = async (key: string, text: string) => {
    await copyText(text);
    setCopied(key);
    window.setTimeout(() => setCopied((current) => (current === key ? "" : current)), 1400);
  };
  return (
    <details className="timeline-details">
      <summary>详情</summary>
      {kind === "command" && (
        <div className="command-detail-card">
          <div className="timeline-detail-toolbar">
            <span>{timelineDetailTitle(kind)}</span>
            <button
              className="mini-action"
              type="button"
              onClick={() => copyDetail("command", detailText(details.command))}
              disabled={!detailText(details.command)}
              aria-label={copied === "command" ? "命令已复制" : "复制命令"}
            >
              {copied === "command" ? <CheckCircle2 size={13} /> : <Copy size={13} />}
              {copied === "command" ? "已复制" : "复制命令"}
            </button>
          </div>
          <code className="command-detail-line">{displayCommandLineText(details.command)}</code>
          <div className="detail-grid command-detail-meta">
            <span>目录</span>
            <code>{displayWorktreePath(detailText(details.cwd)) || "未知目录"}</code>
            <span>状态</span>
            <strong>{timelineStatusLabel(details.status ? `command ${detailText(details.status)}` : "command inProgress") || "运行中"}</strong>
            <span>退出码</span>
            <strong>{detailText(details.exitCode) || "未返回"}</strong>
            <span>来源</span>
            <strong>{detailSourceLabel(detailText(details.source))}</strong>
            <span>耗时</span>
            <strong>{detailText(details.durationMs) ? `${detailText(details.durationMs)}ms` : "未返回"}</strong>
            {Boolean(details.processId) && (
              <>
                <span>进程</span>
                <code>{detailText(details.processId)}</code>
              </>
            )}
            <span>输出</span>
            <strong>
              {detailText(details.outputLineCount) || "0"} 行
              {details.outputTruncated ? " · 已截断" : ""}
            </strong>
          </div>
          {Boolean(details.output) && (
            <>
              <div className="timeline-detail-toolbar output-toolbar">
                <span>输出</span>
                <button
                  className="mini-action"
                  type="button"
                  onClick={() => copyDetail("output", detailText(details.output))}
                  aria-label={copied === "output" ? "输出已复制" : "复制输出"}
                >
                  {copied === "output" ? <CheckCircle2 size={13} /> : <Copy size={13} />}
                  {copied === "output" ? "已复制" : "复制输出"}
                </button>
              </div>
              <pre className="command-output">{detailText(details.output)}</pre>
            </>
          )}
          {commandActions.length > 0 && (
            <>
              <div className="timeline-detail-toolbar output-toolbar">
                <span>动作</span>
                <button
                  className="mini-action"
                  type="button"
                  onClick={() => copyDetail("command-actions", commandActionsText)}
                  aria-label={copied === "command-actions" ? "动作已复制" : "复制动作"}
                >
                  {copied === "command-actions" ? <CheckCircle2 size={13} /> : <Copy size={13} />}
                  {copied === "command-actions" ? "已复制" : "复制动作"}
                </button>
              </div>
              <pre className="tool-json-block">{commandActionsText}</pre>
            </>
          )}
        </div>
      )}
      {kind === "hookPrompt" && (
        <div className="command-detail-card hook-detail-card">
          <div className="timeline-detail-toolbar">
            <span>{timelineDetailTitle(kind)}</span>
            <button
              className="mini-action"
              type="button"
              onClick={() => copyDetail("hook-prompt", hookText)}
              disabled={!hookText}
              aria-label={copied === "hook-prompt" ? "Hook 已复制" : "复制 Hook"}
            >
              {copied === "hook-prompt" ? <CheckCircle2 size={13} /> : <Copy size={13} />}
              {copied === "hook-prompt" ? "已复制" : "复制 Hook"}
            </button>
          </div>
          <div className="detail-grid command-detail-meta">
            <span>片段</span>
            <strong>{detailText(details.fragmentCount) || hookFragments.length || "0"}</strong>
            <span>状态</span>
            <strong>{timelineStatusLabel("hook recorded")}</strong>
          </div>
          {hookFragments.length > 0 && (
            <div className="hook-fragment-list">
              {hookFragments.map((fragment, index) => (
                <article key={`${detailText(fragment.hookRunId)}-${index}`}>
                  <code>{detailText(fragment.hookRunId) || `Hook-${index + 1}`}</code>
                  {Boolean(fragment.text) && <pre>{detailText(fragment.text)}</pre>}
                </article>
              ))}
            </div>
          )}
        </div>
      )}
      {kind === "agentMessage" && (
        <div className="command-detail-card message-detail-card">
          <div className="timeline-detail-toolbar">
            <span>{timelineDetailTitle(kind)}</span>
            <button
              className="mini-action"
              type="button"
              onClick={() => copyDetail("memory-citation", memoryCitationText)}
              disabled={!memoryCitationText}
              aria-label={copied === "memory-citation" ? "引用已复制" : "复制引用"}
            >
              {copied === "memory-citation" ? <CheckCircle2 size={13} /> : <Copy size={13} />}
              {copied === "memory-citation" ? "已复制" : "复制引用"}
            </button>
          </div>
          <div className="detail-grid command-detail-meta">
            <span>阶段</span>
            <strong>{detailPhaseLabel(detailText(details.phase), "未知阶段")}</strong>
            <span>投递</span>
            <strong>{detailText(details.delivery) === "async" ? "异步" : detailText(details.delivery) || "同步"}</strong>
            <span>记忆</span>
            <strong>{detailText(details.memoryCitationSummary) || "无"}</strong>
          </div>
          {asyncQuestions.length > 0 && (
            <div className="question-preview-list">
              {asyncQuestions.map((question, index) => {
                const options = Array.isArray(question.options) ? question.options : [];
                return (
                  <article key={`${detailText(question.title)}-${index}`}>
                    <strong>{detailText(question.title) || `问题 ${index + 1}`}</strong>
                    {options.length > 0 && <small>{options.map((option) => detailText(option)).join(" / ")}</small>}
                  </article>
                );
              })}
            </div>
          )}
          {memoryThreadIds.length > 0 && (
            <div className="memory-thread-list">
              {memoryThreadIds.map((threadId, index) => (
                <code key={`${detailText(threadId)}-${index}`}>{detailText(threadId)}</code>
              ))}
            </div>
          )}
          {memoryEntries.length > 0 && (
            <div className="memory-citation-list">
              {memoryEntries.map((entry, index) => (
                <article key={`${detailText(entry.path)}-${index}`}>
                  <strong>{detailText(entry.path) || `memory-${index + 1}`}</strong>
                  <small>
                    {detailText(entry.lineStart) || "?"}-{detailText(entry.lineEnd) || "?"}
                  </small>
                  {Boolean(entry.note) && <p>{detailText(entry.note)}</p>}
                </article>
              ))}
            </div>
          )}
        </div>
      )}
      {kind === "reasoning" && (
        <div className="command-detail-card reasoning-detail-card">
          <div className="timeline-detail-toolbar">
            <span>{timelineDetailTitle(kind)}</span>
            <button
              className="mini-action"
              type="button"
              onClick={() => copyDetail("reasoning-content", reasoningContent || reasoningSummary)}
              disabled={!reasoningContent && !reasoningSummary}
              aria-label={copied === "reasoning-content" ? "推理内容已复制" : "复制推理内容"}
            >
              {copied === "reasoning-content" ? <CheckCircle2 size={13} /> : <Copy size={13} />}
              {copied === "reasoning-content" ? "已复制" : "复制推理"}
            </button>
          </div>
          <div className="detail-grid command-detail-meta">
            <span>摘要</span>
            <strong>{Array.isArray(details.summary) ? details.summary.length : 0}</strong>
            <span>内容</span>
            <strong>{Array.isArray(details.content) ? details.content.length : 0}</strong>
          </div>
          {Boolean(reasoningSummary) && (
            <>
              <div className="timeline-detail-toolbar output-toolbar">
                <span>摘要</span>
              </div>
              <pre className="tool-json-block">{reasoningSummary}</pre>
            </>
          )}
          {Boolean(reasoningContent) && (
            <>
              <div className="timeline-detail-toolbar output-toolbar">
                <span>内容</span>
              </div>
              <pre className="tool-json-block">{reasoningContent}</pre>
            </>
          )}
        </div>
      )}
      {kind === "fileChange" && changes.length > 0 && (
        <div className="file-change-list">
          {changes.map((change, index) => {
            const filePath = displayFileChangePathText(change.path || change.rawPath);
            const movedToPath = displayFileChangePathText(change.movedToPath || change.rawMovedToPath);
            const diffText = displayFileChangeDiffText(change.diff);
            return (
              <article key={`${filePath || detailText(change.rawPath)}-${index}`}>
                <strong>{detailText(change.operation)} {filePath || "未知文件"}</strong>
                <span>+{detailText(change.addedLineCount) || "0"} -{detailText(change.removedLineCount) || "0"}</span>
                {Boolean(movedToPath) && <small>{movedToPath}</small>}
                {Boolean(diffText) && <pre>{diffText}</pre>}
              </article>
            );
          })}
        </div>
      )}
      {kind === "approval" && (
        <div className="detail-grid">
          <span>方式</span>
          <code>{detailText(details.method) || "未返回"}</code>
          <span>决定</span>
          <strong>{timelineStatusLabel(detailText(details.decision)) || "未返回"}</strong>
          <span>项目</span>
          <code>{detailFallback(details.itemId, "未知项目")}</code>
        </div>
      )}
      {kind === "guardianReview" && (
        <div className="command-detail-card guardian-review-card">
          <div className="timeline-detail-toolbar">
            <span>{timelineDetailTitle(kind)}</span>
            <button className="mini-action" type="button" onClick={() => copyDetail("guardian-review", guardianReviewText)} disabled={!guardianReviewText}>
              {copied === "guardian-review" ? <CheckCircle2 size={13} /> : <Copy size={13} />}
              {copied === "guardian-review" ? "已复制" : "复制审查"}
            </button>
          </div>
          <div className="detail-grid command-detail-meta">
            <span>阶段</span>
            <strong>{detailPhaseLabel(detailText(details.phase))}</strong>
            <span>状态</span>
            <strong>{timelineStatusLabel(`guardian ${detailText(details.status) || "inProgress"}`)}</strong>
            <span>风险</span>
            <strong>{detailText(details.riskLevel) || "未返回"}</strong>
            <span>授权</span>
            <strong>{timelineStatusLabel(detailText(details.userAuthorization)) || "未返回"}</strong>
            <span>动作</span>
            <code>{detailText(details.actionSummary) || detailText(details.actionType) || "权限动作"}</code>
            <span>目标</span>
            <code>{detailText(details.targetItemId) || detailText(details.itemId) || "无"}</code>
            {Boolean(details.decisionSource) && (
              <>
                <span>来源</span>
                <strong>{detailText(details.decisionSource)}</strong>
              </>
            )}
          </div>
          {Boolean(details.rationale) && (
            <p className="guardian-rationale">{detailText(details.rationale)}</p>
          )}
          <pre className="tool-json-block">{guardianReviewText}</pre>
        </div>
      )}
      {(kind === "mcpProgress" || kind === "terminalInteraction" || kind === "requestResolved" || kind === "modelRerouted" || kind === "modelVerification") && (
        <div className="command-detail-card tool-detail-card">
          <div className="timeline-detail-toolbar">
            <span>{timelineDetailTitle(kind)}</span>
            <button className="mini-action" type="button" onClick={() => copyDetail("live-event", liveEventText)} disabled={!liveEventText}>
              {copied === "live-event" ? <CheckCircle2 size={13} /> : <Copy size={13} />}
              {copied === "live-event" ? "已复制" : "复制事件"}
            </button>
          </div>
          <div className="detail-grid command-detail-meta">
            <span>项目</span>
            <code>{detailText(details.itemId) || "无"}</code>
            <span>会话</span>
            <code>{detailFallback(details.threadId, "未知会话")}</code>
            {Boolean(details.turnId) && (
              <>
                <span>回复</span>
                <code>{detailText(details.turnId)}</code>
              </>
            )}
            {Boolean(details.processId) && (
              <>
                <span>进程</span>
                <code>{detailText(details.processId)}</code>
              </>
            )}
            {Boolean(details.requestId) && (
              <>
                <span>请求</span>
                <code>{detailText(details.requestId)}</code>
              </>
            )}
            {Boolean(details.fromModel || details.toModel) && (
              <>
                <span>模型</span>
                <code>{detailText(details.fromModel) || "未知模型"} {"->"} {detailText(details.toModel) || "未知模型"}</code>
              </>
            )}
            {Boolean(details.reason) && (
              <>
                <span>原因</span>
                <strong>{detailText(details.reason)}</strong>
              </>
            )}
            {Array.isArray(details.verifications) && (
              <>
                <span>验证</span>
                <strong>{(details.verifications as unknown[]).map((item) => detailText(item)).join(", ") || "无"}</strong>
              </>
            )}
          </div>
          {Boolean(liveEventText) && <pre className="tool-json-block">{liveEventText}</pre>}
        </div>
      )}
      {(kind === "mcp" || kind === "tool") && (
        <div className="command-detail-card tool-detail-card">
          <div className="timeline-detail-toolbar">
            <span>{timelineDetailTitle(kind)}</span>
            <button
              className="mini-action"
              type="button"
              onClick={() => copyDetail("tool-arguments", toolArguments)}
              disabled={!toolArguments}
              aria-label={copied === "tool-arguments" ? "工具参数已复制" : "复制工具参数"}
            >
              {copied === "tool-arguments" ? <CheckCircle2 size={13} /> : <Copy size={13} />}
              {copied === "tool-arguments" ? "已复制" : "复制参数"}
            </button>
          </div>
          <div className="detail-grid command-detail-meta">
            <span>{kind === "mcp" ? "服务器" : "命名空间"}</span>
            <code>{detailText(kind === "mcp" ? details.server : details.namespace) || "默认"}</code>
            <span>工具</span>
            <code>{detailText(details.tool) || "工具"}</code>
            <span>状态</span>
            <strong>{timelineStatusLabel(`${kind} ${detailText(details.status) || "unknown"}`)}</strong>
            <span>耗时</span>
            <strong>{detailText(details.durationMs) ? `${detailText(details.durationMs)}ms` : "未返回"}</strong>
            {kind === "tool" && (
              <>
                <span>结果</span>
                <strong>{detailSuccessLabel(details.success)}</strong>
              </>
            )}
            {kind === "mcp" && Boolean(details.pluginId) && (
              <>
                <span>插件</span>
                <code>{detailText(details.pluginId)}</code>
              </>
            )}
            {kind === "mcp" && Boolean(details.mcpAppResourceUri) && (
              <>
                <span>资源</span>
                <code>{detailText(details.mcpAppResourceUri)}</code>
              </>
            )}
          </div>
          {Boolean(toolArguments) && <pre className="tool-json-block">{toolArguments}</pre>}
          {Boolean(toolError) && (
            <>
              <div className="timeline-detail-toolbar output-toolbar">
                <span>错误</span>
                <button
                  className="mini-action"
                  type="button"
                  onClick={() => copyDetail("tool-error", toolError)}
                  aria-label={copied === "tool-error" ? "工具错误已复制" : "复制工具错误"}
                >
                  {copied === "tool-error" ? <CheckCircle2 size={13} /> : <Copy size={13} />}
                  {copied === "tool-error" ? "已复制" : "复制错误"}
                </button>
              </div>
              <pre className="tool-json-block tool-error-block">{toolError}</pre>
            </>
          )}
          {Boolean(toolResult) && (
            <>
              <div className="timeline-detail-toolbar output-toolbar">
                <span>结果</span>
                <button
                  className="mini-action"
                  type="button"
                  onClick={() => copyDetail("tool-result", toolResult)}
                  aria-label={copied === "tool-result" ? "工具结果已复制" : "复制工具结果"}
                >
                  {copied === "tool-result" ? <CheckCircle2 size={13} /> : <Copy size={13} />}
                  {copied === "tool-result" ? "已复制" : "复制结果"}
                </button>
              </div>
              <pre className="tool-json-block">{toolResult}</pre>
            </>
          )}
          {Boolean(toolContentItems) && (
            <>
              <div className="timeline-detail-toolbar output-toolbar">
                <span>输出</span>
                <button
                  className="mini-action"
                  type="button"
                  onClick={() => copyDetail("tool-output", toolContentItems)}
                  aria-label={copied === "tool-output" ? "工具输出已复制" : "复制工具输出"}
                >
                  {copied === "tool-output" ? <CheckCircle2 size={13} /> : <Copy size={13} />}
                  {copied === "tool-output" ? "已复制" : "复制输出"}
                </button>
              </div>
              <pre className="tool-json-block">{toolContentItems}</pre>
            </>
          )}
        </div>
      )}
      {kind === "collabAgent" && (
        <div className="command-detail-card agent-detail-card">
          <div className="timeline-detail-toolbar">
            <span>{timelineDetailTitle(kind)}</span>
            <button
              className="mini-action"
              type="button"
              onClick={() => copyDetail("agent-prompt", collabPrompt)}
              disabled={!collabPrompt}
              aria-label={copied === "agent-prompt" ? "Agent prompt 已复制" : "复制 Agent prompt"}
            >
              {copied === "agent-prompt" ? <CheckCircle2 size={13} /> : <Copy size={13} />}
              {copied === "agent-prompt" ? "已复制" : "复制 prompt"}
            </button>
          </div>
          <div className="detail-grid command-detail-meta">
            <span>工具</span>
            <code>{detailText(details.tool) || "Agent"}</code>
            <span>状态</span>
            <strong>{timelineStatusLabel(`agent ${detailText(details.status) || "unknown"}`)}</strong>
            <span>发起会话</span>
            <code>{detailFallback(details.senderThreadId, "未知会话")}</code>
            <span>接收会话</span>
            <strong>{collabReceivers.length || "0"}</strong>
            <span>模型</span>
            <code>{detailText(details.model) || "未指定"}</code>
            <span>推理深度</span>
            <strong>{reasoningLabel(detailText(details.reasoningEffort)) || "未指定"}</strong>
          </div>
          {collabReceivers.length > 0 && (
            <div className="agent-receiver-list">
              {collabReceivers.map((receiver, index) => (
                <code key={`${detailText(receiver)}-${index}`}>{detailText(receiver)}</code>
              ))}
            </div>
          )}
          {Boolean(collabPrompt) && <pre className="tool-json-block">{collabPrompt}</pre>}
          {Boolean(collabStates) && (
            <>
              <div className="timeline-detail-toolbar output-toolbar">
                <span>Agent 状态</span>
                <button
                  className="mini-action"
                  type="button"
                  onClick={() => copyDetail("agent-states", collabStates)}
                  aria-label={copied === "agent-states" ? "Agent 状态已复制" : "复制 Agent 状态"}
                >
                  {copied === "agent-states" ? <CheckCircle2 size={13} /> : <Copy size={13} />}
                  {copied === "agent-states" ? "已复制" : "复制状态"}
                </button>
              </div>
              <pre className="tool-json-block">{collabStates}</pre>
            </>
          )}
        </div>
      )}
      {kind === "webSearch" && (
        <>
          <div className="detail-grid">
            <span>查询</span>
            <code>{detailText(details.query) || "搜索"}</code>
            <span>动作</span>
            <strong>{detailText(details.action) || "搜索"}</strong>
            <span>结果</span>
            <strong>{detailText(details.resultCount) || webSearchResults.length || "等待返回"}</strong>
          </div>
          {webSearchResults.length > 0 && <pre>{detailText(webSearchResults)}</pre>}
        </>
      )}
      {kind === "imageView" && (
        <div className="detail-grid">
          <span>图片</span>
          <code>{detailText(details.name) || "图片"}</code>
          <span>路径</span>
          <code>{detailFallback(details.path, "未知路径")}</code>
        </div>
      )}
      {kind === "imageGeneration" && (
        <>
          <div className="detail-grid">
            <span>状态</span>
            <strong>{timelineStatusLabel(detailText(details.status)) || "图片生成"}</strong>
            <span>保存位置</span>
            <code>{detailText(details.savedPath) || "等待保存"}</code>
            <span>背景</span>
            <strong>{details.transparentBackground ? "透明" : "默认"}</strong>
          </div>
          {imageFailure && <p className="detail-error">{imageFailure.type === "usageLimitExceeded" ? "图片生成额度已用尽，请在额度恢复后重试。" : detailText(imageFailure)}</p>}
          {Boolean(details.revisedPrompt) && <pre>{detailText(details.revisedPrompt)}</pre>}
          {Boolean(details.result) && !details.savedPath && <pre>{detailText(details.result)}</pre>}
        </>
      )}
      {kind === "functionCallOutput" && (
        <div className="command-detail-card tool-detail-card">
          <div className="detail-grid">
            <span>函数</span>
            <code>{`${detailText(details.namespace) ? `${detailText(details.namespace)}.` : ""}${detailText(details.name) || "function"}`}</code>
          </div>
          {Boolean(details.output) && <pre>{detailText(details.output)}</pre>}
        </div>
      )}
      {kind === "subAgentActivity" && (
        <div className="detail-grid">
          <span>状态</span>
          <strong>{timelineStatusLabel(detailText(details.activity)) || "已更新"}</strong>
          <span>Agent</span>
          <code>{detailText(details.agentPath) || detailText(details.agentThreadId) || "未知"}</code>
        </div>
      )}
      {kind === "sleep" && (
        <div className="detail-grid">
          <span>等待时间</span>
          <strong>{detailText(details.durationMs) || "0"} 毫秒</strong>
        </div>
      )}
      {kind === "review" && (
        <div className="detail-grid">
          <span>状态</span>
          <strong>{timelineStatusLabel(detailText(details.status)) || "代码审查"}</strong>
          <span>差异</span>
          <pre>{detailText(details.diff) || "暂无审查差异事件"}</pre>
        </div>
      )}
      {!["command", "hookPrompt", "agentMessage", "reasoning", "fileChange", "approval", "guardianReview", "mcpProgress", "terminalInteraction", "requestResolved", "modelRerouted", "modelVerification", "mcp", "tool", "functionCallOutput", "collabAgent", "subAgentActivity", "webSearch", "imageView", "imageGeneration", "sleep", "review"].includes(kind) && (
        <pre>{JSON.stringify(details, null, 2)}</pre>
      )}
    </details>
  );
}

type AuditCategory = "all" | "shell" | "file" | "network" | "mcp" | "approval" | "automation" | "host";

const auditCategoryTabs: Array<{ id: AuditCategory; label: string }> = [
  { id: "all", label: "全部" },
  { id: "shell", label: "命令" },
  { id: "file", label: "文件" },
  { id: "network", label: "网络" },
  { id: "mcp", label: "MCP" },
  { id: "approval", label: "权限" },
  { id: "automation", label: "自动化" },
  { id: "host", label: "主机" },
];

function parseAuditDetail(detail?: string | null) {
  const value = String(detail || "").trim();
  if (!value) return { value, parsed: null as Record<string, unknown> | null };
  try {
    const candidate = JSON.parse(value);
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      return { value, parsed: candidate as Record<string, unknown> };
    }
  } catch {
    // Keep raw detail visible below.
  }
  return { value, parsed: null as Record<string, unknown> | null };
}

function auditValue(payload: Record<string, unknown> | null, keys: string[]) {
  if (!payload) return "";
  for (const key of keys) {
    const value = payload[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return "";
}

function auditEventCategory(event: Pick<AuditEvent, "source" | "type" | "summary">): AuditCategory {
  const marker = `${event.source} ${event.type} ${event.summary}`.toLowerCase();
  if (/automation|heartbeat|webhook/.test(marker)) return "automation";
  if (/commandexecution|execcommand|shell|command approval/.test(marker)) return "shell";
  if (/filechange|applypatch|file-edit|file edit|file approval|patch/.test(marker)) return "file";
  if (/websearch|network|web search|browser|fetch|http/.test(marker)) return "network";
  if (/mcptool|mcp|elicitation/.test(marker)) return "mcp";
  if (/approval|permission|requestuserinput|user-input/.test(marker)) return "approval";
  return "host";
}

function auditRowsForEvent(event: AuditEvent, payload: Record<string, unknown> | null): Array<[string, unknown]> {
  const category = auditEventCategory(event);
  const rows: Array<[string, unknown]> = [
    ["来源", event.source],
    ["类型", event.type],
  ];
  const add = (label: string, keys: string[]) => {
    const value = auditValue(payload, keys);
    if (value !== "") rows.push([label, value]);
  };

  if (category === "shell") {
    add("命令", ["command", "cmd"]);
    add("目录", ["cwd", "workingDirectory"]);
    add("状态", ["status", "exitCode", "code"]);
    add("权限", ["sandbox"]);
    add("审批", ["approval", "approvalPolicy"]);
  } else if (category === "file") {
    add("方式", ["method"]);
    add("路径", ["path", "filePath", "targetPath"]);
    add("操作", ["operation", "action", "type"]);
    add("移动到", ["movedToPath", "newPath"]);
    add("决定", ["decision"]);
  } else if (category === "network") {
    add("查询", ["query"]);
    add("地址", ["url", "href"]);
    add("工具", ["tool", "toolName", "name"]);
    add("状态", ["status", "code"]);
  } else if (category === "mcp") {
    add("服务器", ["server", "serverName", "mcpServer"]);
    add("工具", ["tool", "toolName", "name"]);
    add("方式", ["method"]);
    add("决定", ["decision"]);
    add("状态", ["status", "authStatus"]);
  } else if (category === "approval") {
    add("方式", ["method"]);
    add("决定", ["decision"]);
    add("权限", ["sandbox"]);
    add("审批", ["approval", "approvalPolicy"]);
    add("项目", ["itemId"]);
  } else if (category === "automation") {
    add("自动化", ["automationId", "id"]);
    add("运行", ["runId"]);
    add("触发方式", ["trigger"]);
    add("工作区", ["worktreePolicy", "worktreePath"]);
    add("状态", ["status"]);
  } else {
    add("方式", ["method"]);
    add("状态", ["status"]);
    add("错误", ["error", "lastError"]);
    add("消息", ["message", "reason"]);
  }

  return rows.filter(([, value]) => detailText(value));
}

function auditDetailDisplayValue(label: string, item: unknown) {
  const text = detailText(item);
  if (!text) return "";
  if (label === "来源") return detailSourceLabel(text);
  if (label === "类型") return auditTypeLabel(text);
  if (label === "命令") return displayCommandText(text);
  if (label === "目录" || label === "路径") return displayWorktreePath(text);
  if (label === "状态" || label === "决定" || label === "授权") return timelineStatusLabel(text) || runStatusLabel(text);
  if (label === "权限") return permissionLabel(text);
  if (label === "审批") return text === "never" ? "不询问" : timelineStatusLabel(text) || text;
  if (label === "触发方式") return automationTriggerLabel(text);
  if (label === "工作区") {
    const worktree = automationWorktreeLabel(text);
    return worktree === text ? displayWorktreePath(text) : worktree;
  }
  if (label === "操作") return displayAutomationText(text);
  return displayAutomationText(text);
}

function auditTypeLabel(value = "") {
  const text = String(value || "").trim();
  const normalized = text.replace(/[\s_-]+/g, "").toLowerCase();
  const labels: Record<string, string> = {
    appserver: "云端 Codex",
    mcpstartup: "MCP 启动",
    automationreconcile: "自动化同步",
    websearch: "联网搜索",
    network: "网络访问",
    commandexecution: "命令执行",
    execcommand: "命令执行",
    filechange: "文件变更",
    filepatch: "文件补丁",
    guardianreview: "权限审查",
    approval: "权限请求",
    ratelimitsupdated: "额度状态更新",
    accountratelimitsupdated: "额度状态更新",
  };
  if (labels[normalized]) return labels[normalized];
  if (/^account\/rateLimits\/updated$/i.test(text)) return "额度状态更新";
  if (/mcp.*startup/i.test(text)) return "MCP 启动";
  return attentionTypeLabel(text);
}

function displayAuditText(value?: string | null) {
  const text = String(value || "").trim();
  const terminalMatch = text.match(/^terminal(?:\s+fallback)?:\s*([\s\S]+)$/i);
  if (terminalMatch?.[1]) return `云端命令：${displayCommandText(terminalMatch[1])}`;
  const shellMatch = text.match(/^shell:\s*([\s\S]+)$/i);
  if (shellMatch?.[1]) return `命令：${displayCommandText(shellMatch[1])}`;
  const shellCompletedMatch = text.match(/^shell\s+(?:completed|failed):\s*([\s\S]+)$/i);
  if (shellCompletedMatch?.[1]) return `命令：${displayCommandText(shellCompletedMatch[1])}`;
  if (/^Codex rate limits updated$/i.test(text)) return "额度状态更新";
  if (/^Codex app-server ready$/i.test(text)) return "云端 Codex 就绪";
  return displayCapabilityText(text)
    .replace(/\bapp-server-command\b/gi, "云端命令")
    .replace(/\bapp-server\b/gi, "云端 Codex")
    .replace(/\bweb search\b/gi, "联网搜索")
    .replace(/\bready\b/gi, "就绪");
}

function auditLongField(payload: Record<string, unknown> | null) {
  if (!payload) return "";
  for (const key of ["diff", "patch", "params", "error", "stderr", "stdout", "message"]) {
    const value = payload[key];
    if (value !== undefined && value !== null && value !== "") {
      const text = detailText(value);
      return key === "error" || key === "message" ? displayProjectMessageText(displayAuditText(text)) : displayProjectMessageText(text);
    }
  }
  return "";
}

function AuditEventIcon({ category }: { category: AuditCategory }) {
  if (category === "shell") return <Terminal size={15} />;
  if (category === "file") return <FileText size={15} />;
  if (category === "network") return <Globe2 size={15} />;
  if (category === "mcp") return <Sparkles size={15} />;
  if (category === "approval") return <ShieldCheck size={15} />;
  if (category === "automation") return <Timer size={15} />;
  return <Activity size={15} />;
}

function auditCategoryLabel(category: AuditCategory) {
  return auditCategoryTabs.find((item) => item.id === category)?.label || category;
}

function AuditDetailPanel({ event }: { event: AuditEvent }) {
  const [showRawDetail, setShowRawDetail] = useState(false);
  const { value, parsed } = parseAuditDetail(event.detail);
  const rows = auditRowsForEvent(event, parsed);
  const longField = auditLongField(parsed);
  if (!value && rows.length <= 2) return null;
  return (
    <details className="audit-details">
      <summary>结构化详情</summary>
      {rows.length > 0 && (
        <div className="audit-detail-grid">
          {rows.map(([key, item]) => (
            <span key={String(key)}>
              <strong>{String(key)}</strong>
              <code>{auditDetailDisplayValue(String(key), item)}</code>
            </span>
          ))}
        </div>
      )}
      {longField && <pre>{longField}</pre>}
      {value && (
        <details className="audit-raw-details" onToggle={(event) => setShowRawDetail(event.currentTarget.open)}>
          <summary>原始记录</summary>
          {showRawDetail && <pre>{value}</pre>}
        </details>
      )}
    </details>
  );
}

function formatDiffPayload(value: unknown) {
  if (!value) return "当前没有可显示的 diff。";
  if (typeof value === "string") return value || "当前没有可显示的 diff。";
  if (typeof value === "object") {
    const candidate = value as Record<string, unknown>;
    for (const key of ["diff", "text", "patch", "summary"]) {
      if (typeof candidate[key] === "string" && candidate[key]) return String(candidate[key]);
    }
    return JSON.stringify(value, null, 2);
  }
  return String(value);
}

function routePart(value?: string | null) {
  return encodeURIComponent(String(value || "").trim());
}

function unroutePart(value?: string | null) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
}

function parseAppHash(hash = typeof window === "undefined" ? "" : window.location.hash): AppRoute {
  const parts = hash
    .replace(/^#\/?/u, "")
    .split("/")
    .map(unroutePart)
    .filter(Boolean);
  const [head, second, third, fourth] = parts;
  if (head === "project" && second) {
    return { view: "cli", repoId: second, sessionId: third === "thread" ? fourth : third };
  }
  if (head === "thread" && second) {
    return { view: "cli", repoId: third || undefined, sessionId: second };
  }
  if (head === "automations") {
    return { view: "automations", repoId: second || undefined, automationId: third || undefined };
  }
  if (routeViews.has(head as ActiveView)) return { view: head as ActiveView };
  return { view: "cli" };
}

function buildAppHash(route: AppRoute) {
  if (route.view === "cli") {
    const repo = routePart(route.repoId || defaultRepoId);
    const session = route.sessionId ? `/thread/${routePart(route.sessionId)}` : "";
    return `#/project/${repo}${session}`;
  }
  if (route.view === "automations") {
    const repo = route.repoId ? `/${routePart(route.repoId)}` : "";
    const automation = route.automationId ? `/${routePart(route.automationId)}` : "";
    return `#/automations${repo}${automation}`;
  }
  return `#/${route.view}`;
}

function replaceAppHash(route: AppRoute) {
  if (typeof window === "undefined") return;
  const nextHash = buildAppHash(route);
  if (window.location.hash === nextHash) return;
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${nextHash}`);
}

// Adapted from friuns2/codexui's MIT-licensed parseReviewText helpers.
function parseReviewLocation(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return { absolutePath: null as string | null, startLine: null as number | null, endLine: null as number | null };
  const match = trimmed.match(/^(.*?):(\d+)-(\d+)$/u);
  if (!match) return { absolutePath: trimmed || null, startLine: null, endLine: null };
  return {
    absolutePath: match[1]?.trim() || null,
    startLine: Number(match[2]),
    endLine: Number(match[3]),
  };
}

function parseReviewText(reviewText: string): ReviewResult {
  const normalized = reviewText.replace(/\r\n/g, "\n").trim();
  if (!normalized) return { reviewText: "", summary: "", findings: [] };
  const markerIndex = normalized.search(/\n(?:Full review comments|Review comment):\n/iu);
  const summary = markerIndex >= 0 ? normalized.slice(0, markerIndex).trim() : normalized;
  const findingsSection = markerIndex >= 0 ? normalized.slice(markerIndex).trim() : "";
  const findings: ReviewFinding[] = [];
  if (findingsSection) {
    const body = findingsSection.replace(/^(?:Full review comments|Review comment):\n*/iu, "").trim();
    const matches = body.matchAll(/^- (.+?) — (.+)\n?((?:  .*(?:\n|$))*)/gmu);
    let index = 0;
    for (const match of matches) {
      const title = match[1]?.trim() ?? "";
      const location = parseReviewLocation(match[2] ?? "");
      const block = (match[0] ?? "").trim();
      const findingBody = (match[3] ?? "")
        .split("\n")
        .map((line) => line.replace(/^  /u, ""))
        .join("\n")
        .trim();
      findings.push({
        id: `finding:${index}`,
        title: title || `Finding ${index + 1}`,
        body: findingBody,
        path: location.absolutePath ? (location.absolutePath.split("/").filter(Boolean).at(-1) ?? location.absolutePath) : null,
        absolutePath: location.absolutePath,
        startLine: location.startLine,
        endLine: location.endLine,
        rawText: block,
      });
      index += 1;
    }
  }
  return { reviewText: normalized, summary, findings };
}

export function App() {
  const initialRouteRef = useRef(parseAppHash());
  const initialRoute = initialRouteRef.current;
  const [status, setStatus] = useState<ConsoleStatus>(fallbackStatus);
  const [cloudConnection, setCloudConnection] = useState<CloudConnection>("checking");
  const [selectedAutomationId, setSelectedAutomationId] = useState(initialRoute.automationId || defaultAutomationId);
  const [selectedRepoId, setSelectedRepoId] = useState(initialRoute.repoId || defaultRepoId);
  const [activeView, setActiveView] = useState<ActiveView>(initialRoute.view);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatSessions, setChatSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState("");
  const [chatInput, setChatInput] = useState("");
  const [chatAttachments, setChatAttachments] = useState<UploadedAttachment[]>([]);
  const [uploadingAttachments, setUploadingAttachments] = useState(false);
  const [chatRuntime, setChatRuntime] = useState<ChatRuntime>(defaultChatRuntime);
  const [codexModels, setCodexModels] = useState<CodexModelOption[]>([]);
  const [codexAppStatus, setCodexAppStatus] = useState<CodexAppStatus>(fallbackAppStatus);
  const [codexAppStatusLoading, setCodexAppStatusLoading] = useState(true);
  const [threadGoal, setThreadGoal] = useState<ThreadGoal | null>(null);
  const [goalDraft, setGoalDraft] = useState("");
  const [goalBudgetDraft, setGoalBudgetDraft] = useState("");
  const [reviewActivity, setReviewActivity] = useState<ReviewActivity | null>(null);
  const [reviewPrContext, setReviewPrContext] = useState<ReviewPrContext | null>(null);
  const [reviewPrLoading, setReviewPrLoading] = useState(false);
  const [reviewPrPublishBusy, setReviewPrPublishBusy] = useState("");
  const [threadTokenUsage, setThreadTokenUsage] = useState<ThreadTokenUsage | null>(null);
  const [compactStatus, setCompactStatus] = useState<CompactStatus | null>(null);
  const [autoCompactEnabled, setAutoCompactEnabled] = useState(false);
  const [autoCompactLimit, setAutoCompactLimit] = useState("160000");
  const [autoCompactScope, setAutoCompactScope] = useState("body_after_prefix");
  const [isLoadingChatHistory, setIsLoadingChatHistory] = useState(false);
  const [chatHistoryError, setChatHistoryError] = useState("");
  const [filePath, setFilePath] = useState(".");
  const [fileTree, setFileTree] = useState<AgentFileEntry[]>([]);
  const [selectedFile, setSelectedFile] = useState<AgentFileRead | null>(null);
  const [fileDraft, setFileDraft] = useState("");
  const [terminalCommand, setTerminalCommand] = useState("git status --short --branch");
  const [terminalResult, setTerminalResult] = useState<TerminalResult | null>(null);
  const [browserUrl, setBrowserUrl] = useState("https://console.example.com/");
  const [browserResult, setBrowserResult] = useState<BrowserResult | null>(null);
  const [fullLog, setFullLog] = useState<{ name: string; content: string; mocked?: boolean } | null>(null);
  const [statusReady, setStatusReady] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [mcpLoginBusy, setMcpLoginBusy] = useState<string | null>(null);
  const [codexAccountBusy, setCodexAccountBusy] = useState<"login" | "cancel" | "logout" | null>(null);
  const [attentionBusy, setAttentionBusy] = useState<string | null>(null);
  const [externalNotificationBusy, setExternalNotificationBusy] = useState<string | null>(null);
  const [pushNotificationBusy, setPushNotificationBusy] = useState<"subscribe" | "unsubscribe" | "test" | null>(null);
  const [browserPushEndpoint, setBrowserPushEndpoint] = useState<string | null>(null);
  const [browserPushReadiness, setBrowserPushReadiness] = useState<BrowserPushReadiness>(() => baseBrowserPushReadiness());
  const [diagnosticsBusy, setDiagnosticsBusy] = useState(false);
  const [codexDiagnostics, setCodexDiagnostics] = useState<CodexDiagnostics | null>(null);
  const [query, setQuery] = useState("");
  const [globalSessionMatches, setGlobalSessionMatches] = useState<ChatSession[]>([]);
  const [globalSessionSearchLoading, setGlobalSessionSearchLoading] = useState(false);
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [projectRemote, setProjectRemote] = useState("");
  const [pendingRouteSession, setPendingRouteSession] = useState<{ repoId: string; sessionId: string } | null>(() =>
    initialRoute.repoId && initialRoute.sessionId ? { repoId: initialRoute.repoId, sessionId: initialRoute.sessionId } : null,
  );
  const [notificationsEnabled, setNotificationsEnabled] = useState(() => window.localStorage.getItem("codex-cloud-notifications") === "enabled");
  const [notificationPermission, setNotificationPermission] = useState(() =>
    typeof window.Notification === "undefined" ? "unsupported" : window.Notification.permission,
  );
  const chatLoadSeq = useRef(0);
  const globalSearchSeq = useRef(0);
  const runtimePersistSeq = useRef(0);
  const threadStateLoadSeq = useRef(0);
  const codexAppStatusLoadSeq = useRef(0);
  const draftPersistSeq = useRef(0);
  const hydratedDraftRef = useRef<{ key: string; snapshot: string } | null>(null);
  const chatRuntimeRef = useRef<ChatRuntime>(defaultChatRuntime);
  const statusRef = useRef<ConsoleStatus>(fallbackStatus);
  const selectedRepoIdRef = useRef(selectedRepoId);
  const activeSessionIdRef = useRef(activeSessionId);
  const chatInputRef = useRef(chatInput);
  const chatAttachmentsRef = useRef<UploadedAttachment[]>(chatAttachments);
  const flushComposerDraftRef = useRef<() => Promise<void>>(async () => undefined);
  const pendingRouteSessionRef = useRef<{ repoId: string; sessionId: string } | null>(
    initialRoute.repoId && initialRoute.sessionId ? { repoId: initialRoute.repoId, sessionId: initialRoute.sessionId } : null,
  );
  const codexAppStatusLoadedRef = useRef(false);
  const attachedJobIds = useRef<Set<string>>(new Set());
  const lastNotifiedAttentionId = useRef("");
  statusRef.current = status;
  selectedRepoIdRef.current = selectedRepoId;
  activeSessionIdRef.current = activeSessionId;
  chatInputRef.current = chatInput;
  chatAttachmentsRef.current = chatAttachments;
  chatRuntimeRef.current = chatRuntime;

  const selectedRepo = useMemo(
    () => status.repos.find((item) => item.id === selectedRepoId) || status.repos[0],
    [selectedRepoId, status.repos],
  );
  const repoSelectionReady = statusReady && status.repos.some((item) => item.id === selectedRepoId);
  const selectedAutomation = useMemo(
    () =>
      status.automations.find((item) => item.id === selectedAutomationId && item.repoId === selectedRepoId) ||
      status.automations.find((item) => item.repoId === selectedRepoId) ||
      status.automations[0],
    [selectedAutomationId, selectedRepoId, status.automations],
  );
  const selectedAutomationRuns = useMemo(
    () =>
      (status.automationRuns || [])
        .filter((run) => run.automationId === selectedAutomation?.id)
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
        .slice(0, 8),
    [selectedAutomation?.id, status.automationRuns],
  );
  const activeChatSession = useMemo(
    () => chatSessions.find((session) => session.id === activeSessionId && session.repoId === selectedRepoId) || null,
    [activeSessionId, chatSessions, selectedRepoId],
  );
  const activeRouteSessionId = activeChatSession?.codexSessionId || activeSessionId;

  const pushEvent = useCallback((event: Omit<RunEvent, "id" | "time">) => {
    setEvents((current) => [
      {
        ...event,
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        time: new Date().toISOString(),
      },
      ...current,
    ].slice(0, 20));
  }, []);

  const switchRepoConversation = useCallback((repoId: string) => {
    if (selectedRepoIdRef.current !== repoId) {
      void flushComposerDraftRef.current();
      chatLoadSeq.current += 1;
      setChatSessions([]);
      setActiveSessionId("");
      setChatMessages([]);
      setThreadGoal(null);
      setThreadTokenUsage(null);
      setCompactStatus(null);
      setReviewPrContext(null);
      setChatInput("");
      setChatAttachments([]);
      setChatHistoryError("");
      hydratedDraftRef.current = null;
    }
    selectedRepoIdRef.current = repoId;
    setSelectedRepoId(repoId);
  }, []);

  useEffect(() => {
    if (!statusReady || status.repos.length === 0 || status.repos.some((repo) => repo.id === selectedRepoId)) return;
    switchRepoConversation(status.repos[0].id);
  }, [selectedRepoId, status.repos, statusReady, switchRepoConversation]);

  const selectRepo = useCallback(
    (repoId: string) => {
      switchRepoConversation(repoId);
      const repoAutomation = status.automations.find((automation) => automation.repoId === repoId);
      if (repoAutomation) setSelectedAutomationId(repoAutomation.id);
    },
    [status.automations, switchRepoConversation],
  );

  const createProject = async () => {
    if (busyAction || (!projectName.trim() && !projectRemote.trim())) return;
    setBusyAction("create-project");
    try {
      const result = await api<CreateProjectResponse>("/api/repos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: projectName, remote: projectRemote }),
      });
      setProjectDialogOpen(false);
      setProjectName("");
      setProjectRemote("");
      await refresh();
      switchRepoConversation(result.repo.id);
      setActiveView("cli");
      await loadChatHistory(result.repo.id, result.activeSessionId);
      pushEvent({ tone: "ok", title: "项目已创建", body: `${result.repo.name} 已加入云端 workspace` });
    } catch (error) {
      pushEvent({ tone: "warn", title: "项目创建失败", body: error instanceof Error ? error.message : "无法创建项目" });
    } finally {
      setBusyAction(null);
    }
  };

  const refresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const quick = await api<HealthCheckResponse>("/healthz");
      const quickStatus = statusWithHealth(statusRef.current, quick);
      statusRef.current = quickStatus;
      setStatus(quickStatus);
      setCloudConnection(connectionFromStatus(quickStatus));

      const next = await api<ConsoleStatus>("/api/status");
      statusRef.current = next;
      setStatus(next);
      setStatusReady(true);
      setCloudConnection(connectionFromStatus(next));
      pushEvent({
        tone: connectionFromStatus(next) === "cloud" ? "ok" : "warn",
        title: "状态刷新",
        body: connectionState(next, connectionFromStatus(next)).detail,
      });
    } catch (error) {
      setCloudConnection("offline");
      pushEvent({
        tone: "warn",
        title: "状态刷新",
        body: error instanceof Error ? error.message : "API 暂不可用，正在等待隧道恢复",
      });
    } finally {
      setIsRefreshing(false);
    }
  }, [pushEvent]);

  useEffect(() => {
    refresh();
    const interval = window.setInterval(refresh, 45_000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  useEffect(() => {
    window.localStorage.setItem("codex-cloud-notifications", notificationsEnabled ? "enabled" : "disabled");
  }, [notificationsEnabled]);

  const toggleNotifications = async () => {
    if (typeof window.Notification === "undefined") {
      setNotificationPermission("unsupported");
      pushEvent({ tone: "warn", title: "通知", body: "当前浏览器不支持桌面通知" });
      return;
    }
    if (notificationsEnabled) {
      setNotificationsEnabled(false);
      pushEvent({ tone: "ok", title: "通知", body: "已关闭 Codex Cloud 通知" });
      return;
    }
    const permission = window.Notification.permission === "granted" ? "granted" : await window.Notification.requestPermission();
    setNotificationPermission(permission);
    if (permission !== "granted") {
      pushEvent({ tone: "warn", title: "通知", body: "浏览器没有授予通知权限" });
      return;
    }
    setNotificationsEnabled(true);
    lastNotifiedAttentionId.current = getAttentionSummary(status).latestItemId;
    pushEvent({ tone: "ok", title: "通知", body: "已开启 Codex Cloud 待处理通知" });
  };

  const acknowledgeAttention = useCallback(
    async (itemIds: string[] = [], all = false) => {
      if (attentionBusy) return;
      const marker = all ? "all" : itemIds[0] || "selected";
      setAttentionBusy(marker);
      try {
        const result = await api<{ ok: boolean; acknowledged: string[]; attention: AttentionSummary }>("/api/attention/acknowledgements", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ itemIds, all }),
        });
        setStatus((current) => ({ ...current, attention: result.attention || current.attention }));
        lastNotifiedAttentionId.current = result.attention?.latestItemId || "";
        pushEvent({
          tone: "ok",
          title: "收件箱",
          body: all ? "已把当前待处理项标记为已读" : "已标记为已读",
        });
      } catch (error) {
        pushEvent({ tone: "warn", title: "收件箱", body: error instanceof Error ? error.message : "标记已读失败" });
      } finally {
        setAttentionBusy(null);
      }
    },
    [attentionBusy, pushEvent],
  );

  const clearResolvedAttention = useCallback(async () => {
    if (attentionBusy) return;
    setAttentionBusy("clear");
    try {
      const result = await api<{ ok: boolean; cleared: number; attention: AttentionSummary }>("/api/attention/acknowledgements", {
        method: "DELETE",
      });
      setStatus((current) => ({ ...current, attention: result.attention || current.attention }));
      pushEvent({ tone: "ok", title: "收件箱", body: `已清理 ${result.cleared || 0} 条已解决记录` });
    } catch (error) {
      pushEvent({ tone: "warn", title: "收件箱", body: error instanceof Error ? error.message : "清理已解决记录失败" });
    } finally {
      setAttentionBusy(null);
    }
  }, [attentionBusy, pushEvent]);

  const runExternalNotificationAction = useCallback(
    async (mode: "test" | "check") => {
      if (externalNotificationBusy) return;
      setExternalNotificationBusy(mode);
      try {
        const result = await api<{
          ok: boolean;
          result?: { sent?: Array<{ itemId: string }>; failed?: Array<{ itemId: string }>; skipped?: boolean; reason?: string };
          externalNotifications: ConsoleStatus["externalNotifications"];
        }>(`/api/notifications/external/${mode}`, { method: "POST" });
        setStatus((current) => ({ ...current, externalNotifications: result.externalNotifications || current.externalNotifications }));
        const sent = result.result?.sent?.length || 0;
        const failed = result.result?.failed?.length || 0;
        const skipped = result.result?.skipped;
        const skippedReason = result.result?.reason === "not-configured" ? "未配置外部通知渠道" : result.result?.reason || "已跳过";
        pushEvent({
          tone: failed || skipped ? "warn" : "ok",
          title: "外部通知",
          body: skipped
            ? skippedReason
            : mode === "test"
              ? `测试通知已发送 ${sent} 条`
              : `检查完成，发送 ${sent} 条${failed ? `，失败 ${failed} 条` : ""}`,
        });
      } catch (error) {
        pushEvent({
          tone: "warn",
          title: "外部通知",
          body: error instanceof Error ? error.message : "外部通知操作失败",
        });
      } finally {
        setExternalNotificationBusy(null);
      }
    },
    [externalNotificationBusy, pushEvent],
  );

  const syncBrowserPushEndpoint = useCallback(async () => {
    const readiness = await detectBrowserPushReadiness();
    setBrowserPushReadiness(readiness);
    setBrowserPushEndpoint(readiness.endpoint);
    setNotificationPermission(readiness.permission);
    return readiness.endpoint;
  }, []);

  useEffect(() => {
    void syncBrowserPushEndpoint();
  }, [syncBrowserPushEndpoint]);

  const enableBrowserPushNotifications = useCallback(async () => {
    if (pushNotificationBusy) return;
    if (!browserPushSupported()) {
      pushEvent({ tone: "warn", title: "浏览器通知", body: "当前浏览器不支持后台通知" });
      return;
    }
    setPushNotificationBusy("subscribe");
    try {
      const statusResult = await api<{ ok: boolean; pushNotifications: ConsoleStatus["pushNotifications"] }>("/api/notifications/push/status");
      const publicKey = statusResult.pushNotifications?.publicKey || status.pushNotifications?.publicKey || "";
      if (!publicKey) throw new Error("云端没有可用的 Push public key");
      const permission = window.Notification.permission === "granted" ? "granted" : await window.Notification.requestPermission();
      setNotificationPermission(permission);
      if (permission !== "granted") throw new Error("浏览器没有授予通知权限");
      const registration = await navigator.serviceWorker.register("/codex-cloud-sw.js");
      const existing = await registration.pushManager.getSubscription();
      const subscription =
        existing ||
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        }));
      const result = await api<{ ok: boolean; pushNotifications: ConsoleStatus["pushNotifications"] }>("/api/notifications/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: subscription.toJSON() }),
      });
      setStatus((current) => ({ ...current, pushNotifications: result.pushNotifications || current.pushNotifications }));
      await syncBrowserPushEndpoint();
      pushEvent({ tone: "ok", title: "浏览器通知", body: "当前浏览器已订阅云端 Codex 待处理事件" });
    } catch (error) {
      pushEvent({ tone: "warn", title: "浏览器通知", body: error instanceof Error ? error.message : "订阅浏览器通知失败" });
    } finally {
      setPushNotificationBusy(null);
    }
  }, [pushEvent, pushNotificationBusy, status.pushNotifications?.publicKey, syncBrowserPushEndpoint]);

  const disableBrowserPushNotifications = useCallback(async () => {
    if (pushNotificationBusy) return;
    setPushNotificationBusy("unsubscribe");
    try {
      const registration = browserPushSupported() ? await navigator.serviceWorker.getRegistration() : null;
      const subscription = await registration?.pushManager.getSubscription();
      const endpoint = subscription?.endpoint || browserPushEndpoint || "";
      if (subscription) await subscription.unsubscribe();
      const result = await api<{ ok: boolean; pushNotifications: ConsoleStatus["pushNotifications"] }>("/api/notifications/push/subscribe", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint }),
      });
      setStatus((current) => ({ ...current, pushNotifications: result.pushNotifications || current.pushNotifications }));
      await syncBrowserPushEndpoint();
      pushEvent({ tone: "ok", title: "浏览器通知", body: "当前浏览器已取消订阅" });
    } catch (error) {
      pushEvent({ tone: "warn", title: "浏览器通知", body: error instanceof Error ? error.message : "取消浏览器通知订阅失败" });
    } finally {
      setPushNotificationBusy(null);
    }
  }, [browserPushEndpoint, pushEvent, pushNotificationBusy, syncBrowserPushEndpoint]);

  const testBrowserPushNotifications = useCallback(async () => {
    if (pushNotificationBusy) return;
    setPushNotificationBusy("test");
    try {
      const result = await api<{ ok: boolean; pushNotifications: ConsoleStatus["pushNotifications"]; result?: unknown }>("/api/notifications/push/test", {
        method: "POST",
      });
      setStatus((current) => ({ ...current, pushNotifications: result.pushNotifications || current.pushNotifications }));
      await syncBrowserPushEndpoint();
      pushEvent({ tone: result.ok ? "ok" : "warn", title: "浏览器通知", body: result.ok ? "测试通知已发送" : "测试通知未发送" });
    } catch (error) {
      pushEvent({ tone: "warn", title: "浏览器通知", body: error instanceof Error ? error.message : "测试浏览器通知失败" });
    } finally {
      setPushNotificationBusy(null);
    }
  }, [pushEvent, pushNotificationBusy, syncBrowserPushEndpoint]);

  const runCodexDiagnostics = useCallback(async () => {
    if (diagnosticsBusy) return;
    setDiagnosticsBusy(true);
    try {
      const result = await api<{ ok: boolean; diagnostics: CodexDiagnostics }>("/api/codex/diagnostics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoId: selectedRepoIdRef.current }),
      });
      setCodexDiagnostics(result.diagnostics);
      pushEvent({
        tone: result.diagnostics?.summary?.danger ? "warn" : "ok",
        title: "Codex 诊断",
        body: result.diagnostics?.summary
          ? `${result.diagnostics.summary.ok} 正常 · ${result.diagnostics.summary.warn} 提醒 · ${result.diagnostics.summary.danger} 问题`
          : "诊断完成",
      });
    } catch (error) {
      pushEvent({ tone: "warn", title: "Codex 诊断", body: error instanceof Error ? error.message : "诊断失败" });
    } finally {
      setDiagnosticsBusy(false);
    }
  }, [diagnosticsBusy, pushEvent]);

  const loadCodexModels = useCallback(async (forceRefresh = false) => {
    try {
      const result = await api<CodexModelsResponse>(`/api/codex/models${forceRefresh ? "?refresh=1" : ""}`);
      if (!result.ok || result.source !== "app-server" || result.authoritative !== true) {
        throw new Error(result.error || "模型列表不是 app-server 权威响应");
      }
      if (!result.models?.length) throw new Error("app-server 未返回可用模型");
      setCodexModels(result.models);
      const defaultModel = result.models.find((model) => model.id === defaultChatRuntime.model) || result.models.find((model) => model.isDefault);
      if (defaultModel) {
        setChatRuntime((current) => ({
          ...current,
          model: current.model || defaultModel.id,
          reasoning: current.reasoning || defaultModel.defaultReasoningEffort || defaultChatRuntime.reasoning,
        }));
      }
    } catch (error) {
      setCodexModels((current) => current);
    }
  }, []);

  useEffect(() => {
    loadCodexModels(true);
  }, [loadCodexModels]);

  const loadCodexAppStatus = useCallback(async () => {
    const repoId = selectedRepoIdRef.current;
    const requestSeq = ++codexAppStatusLoadSeq.current;
    if (!codexAppStatusLoadedRef.current) setCodexAppStatusLoading(true);
    try {
      const params = new URLSearchParams({ repoId });
      const nextStatus = await api<CodexAppStatus>(`/api/codex/app-status?${params.toString()}`);
      if (requestSeq !== codexAppStatusLoadSeq.current || selectedRepoIdRef.current !== repoId) return;
      if (!nextStatus.ok || nextStatus.source !== "app-server" || nextStatus.authoritative !== true) {
        throw new Error(nextStatus.gaps?.[0] || nextStatus.auth?.issue || "云端 Codex 能力状态不是 app-server 权威响应");
      }
      codexAppStatusLoadedRef.current = true;
      setCodexAppStatus(nextStatus);
    } catch (error) {
      if (requestSeq !== codexAppStatusLoadSeq.current || selectedRepoIdRef.current !== repoId) return;
      setCodexAppStatus((current) => ({
        ...current,
        ok: false,
        gaps: [error instanceof Error ? error.message : "无法读取云端 Codex 能力状态"],
      }));
    } finally {
      if (requestSeq === codexAppStatusLoadSeq.current && selectedRepoIdRef.current === repoId) setCodexAppStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!repoSelectionReady) return;
    loadCodexAppStatus();
    const interval = window.setInterval(loadCodexAppStatus, 90_000);
    return () => window.clearInterval(interval);
  }, [loadCodexAppStatus, repoSelectionReady, selectedRepoId]);

  useEffect(() => {
    if (!codexAppStatus.accountLogin?.active) return;
    const interval = window.setInterval(loadCodexAppStatus, 4000);
    return () => window.clearInterval(interval);
  }, [codexAppStatus.accountLogin?.active?.loginId, loadCodexAppStatus]);

  const startCodexAccountLogin = async (type: "chatgptDeviceCode" | "chatgpt" = "chatgptDeviceCode") => {
    if (codexAccountBusy) return;
    const loginTab = window.open("about:blank", "_blank", "noopener,noreferrer");
    setCodexAccountBusy("login");
    try {
      const result = await api<{
        ok: boolean;
        flow?: CodexAccountLoginFlow | null;
        result?: Partial<CodexAccountLoginFlow> | null;
        accountLogin?: CodexAccountLoginState;
        error?: string;
      }>("/api/codex/account/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type }),
      });
      const flow = result.flow || null;
      const loginUrl = flow?.verificationUrl || flow?.authUrl || result.result?.verificationUrl || result.result?.authUrl || "";
      if (loginUrl && loginTab) {
        loginTab.location.href = loginUrl;
      } else if (loginUrl) {
        window.open(loginUrl, "_blank", "noopener,noreferrer");
      } else {
        loginTab?.close();
      }
      setCodexAppStatus((current) => ({
        ...current,
        accountLogin: result.accountLogin || { active: flow, latest: flow, flows: flow ? [flow] : [] },
      }));
      pushEvent({
        tone: "ok",
        title: "Codex 登录",
        body: flow?.userCode ? `已打开授权页，输入验证码 ${flow.userCode}` : "已打开 Codex 登录授权页",
      });
      window.setTimeout(loadCodexAppStatus, 2500);
    } catch (error) {
      loginTab?.close();
      pushEvent({ tone: "warn", title: "Codex 登录失败", body: error instanceof Error ? error.message : "无法启动 Codex 登录" });
    } finally {
      setCodexAccountBusy(null);
    }
  };

  const cancelCodexAccountLogin = async (loginId: string) => {
    if (!loginId || codexAccountBusy) return;
    setCodexAccountBusy("cancel");
    try {
      const result = await api<{ ok: boolean; accountLogin?: CodexAccountLoginState; error?: string }>("/api/codex/account/login/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ loginId }),
      });
      setCodexAppStatus((current) => ({ ...current, accountLogin: result.accountLogin || current.accountLogin }));
      pushEvent({ tone: "info", title: "Codex 登录", body: "已取消等待中的授权流程" });
      await loadCodexAppStatus();
    } catch (error) {
      pushEvent({ tone: "warn", title: "Codex 登录", body: error instanceof Error ? error.message : "取消登录失败" });
    } finally {
      setCodexAccountBusy(null);
    }
  };

  const logoutCodexAccount = async () => {
    if (codexAccountBusy) return;
    setCodexAccountBusy("logout");
    try {
      await api("/api/codex/account/logout", { method: "POST" });
      await loadCodexAppStatus();
      pushEvent({ tone: "info", title: "Codex 登录", body: "已退出 Codex 账号" });
    } catch (error) {
      pushEvent({ tone: "warn", title: "Codex 登录", body: error instanceof Error ? error.message : "退出登录失败" });
    } finally {
      setCodexAccountBusy(null);
    }
  };

  const startMcpLogin = async (serverName: string) => {
    if (!serverName || mcpLoginBusy) return;
    const loginTab = window.open("about:blank", "_blank", "noopener,noreferrer");
    setMcpLoginBusy(serverName);
    try {
      const result = await api<{ ok: boolean; authorizationUrl?: string; error?: string }>("/api/codex/mcp/oauth-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: serverName }),
      });
      if (!result.authorizationUrl) throw new Error(result.error || "MCP OAuth 没有返回登录链接");
      try {
        await api("/api/local/mcp-oauth-relay/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ authorizationUrl: result.authorizationUrl }),
        });
      } catch {
        // Direct HTTPS access cannot install the local loopback relay; the auth URL is still useful over an SSH/local proxy.
      }
      if (loginTab) {
        loginTab.location.href = result.authorizationUrl;
      } else {
        window.open(result.authorizationUrl, "_blank", "noopener,noreferrer");
      }
      pushEvent({ tone: "ok", title: "MCP 登录", body: `${serverName} OAuth 已打开；本地代理会转发 loopback 回调到云端` });
      window.setTimeout(loadCodexAppStatus, 2500);
    } catch (error) {
      loginTab?.close();
      pushEvent({ tone: "warn", title: "MCP 登录失败", body: error instanceof Error ? error.message : "无法启动 MCP OAuth" });
    } finally {
      setMcpLoginBusy(null);
    }
  };

  const reloadMcpServers = async () => {
    if (busyAction) return;
    setBusyAction("mcp-reload");
    try {
      await api("/api/codex/mcp/reload", { method: "POST" });
      await loadCodexAppStatus();
      pushEvent({ tone: "ok", title: "MCP", body: "已重新加载 MCP 服务器状态" });
    } catch (error) {
      pushEvent({ tone: "warn", title: "MCP", body: error instanceof Error ? error.message : "MCP reload 失败" });
    } finally {
      setBusyAction(null);
    }
  };

  const loadThreadState = useCallback(
    async (sessionId = activeSessionId) => {
      if (!sessionId) return;
      const repoId = selectedRepo.id;
      const requestSeq = ++threadStateLoadSeq.current;
      const runtimeSeq = runtimePersistSeq.current;
      try {
        const params = new URLSearchParams({ repoId, sessionId });
        const result = await apiWithRetry<ThreadStateResponse>(`/api/codex/thread-state?${params.toString()}`, undefined, 3);
        if (
          requestSeq !== threadStateLoadSeq.current ||
          selectedRepoIdRef.current !== repoId ||
          activeSessionIdRef.current !== sessionId
        ) return;
        if (!result.ok || result.source !== "app-server" || result.authoritative !== true) {
          throw new Error(result.error || "当前 thread-state 不是 app-server 权威响应");
        }
        setThreadGoal(result.goal || null);
        setGoalDraft(result.goal?.objective || "");
        setGoalBudgetDraft(result.goal?.tokenBudget ? String(result.goal.tokenBudget) : "");
        setThreadTokenUsage(result.tokenUsage || null);
        if (result.runtime && runtimeSeq === runtimePersistSeq.current) {
          setChatRuntime((current) => ({ ...current, ...result.runtime }));
          setChatSessions((current) =>
            current.map((session) => (session.id === sessionId ? { ...session, ...result.runtime } : session)),
          );
        }
        const limit = result.config?.autoCompactTokenLimit || null;
        setAutoCompactEnabled(Boolean(limit));
        setAutoCompactLimit(String(limit || 160000));
        setAutoCompactScope(result.config?.autoCompactTokenLimitScope || "body_after_prefix");
      } catch (error) {
        if (
          requestSeq !== threadStateLoadSeq.current ||
          selectedRepoIdRef.current !== repoId ||
          activeSessionIdRef.current !== sessionId
        ) return;
        setThreadGoal(activeChatSession?.goal || null);
        setThreadTokenUsage(activeChatSession?.tokenUsage || null);
      }
    },
    [activeChatSession?.goal, activeChatSession?.tokenUsage, activeSessionId, selectedRepo.id],
  );

  useEffect(() => {
    loadThreadState();
  }, [loadThreadState]);

  const persistChatRuntime = useCallback(
    async (runtime: ChatRuntime, sessionId = activeSessionId, repoId = selectedRepoIdRef.current) => {
      if (!sessionId) return;
      const requestSeq = ++runtimePersistSeq.current;
      try {
        const result = await api<ChatRuntimeResponse>(`/api/chat/sessions/${encodeURIComponent(sessionId)}/runtime`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repoId, ...runtime }),
        });
        if (requestSeq !== runtimePersistSeq.current || selectedRepoIdRef.current !== repoId) return;
        const nextRuntime = result.runtime ? { ...chatRuntimeRef.current, ...result.runtime } : runtime;
        chatRuntimeRef.current = nextRuntime;
        setChatRuntime(nextRuntime);
        if (result.sessions?.length) {
          setChatSessions(result.sessions);
        } else if (result.session) {
          setChatSessions((current) => current.map((session) => (session.id === sessionId ? { ...session, ...result.session } : session)));
        } else {
          setChatSessions((current) => current.map((session) => (session.id === sessionId ? { ...session, ...nextRuntime } : session)));
        }
        if (result.appliesOnNextTurn) {
          pushEvent({
            tone: "ok",
            title: "模型已选择",
            body: `${nextRuntime.model} · ${reasoningLabel(nextRuntime.reasoning)}，从下一条消息开始生效。`,
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "runtime 设置保存失败";
        pushEvent({ tone: "warn", title: "设置未保存", body: message });
        if (sessionId === activeSessionId && selectedRepoIdRef.current === repoId) void loadThreadState(sessionId);
      }
    },
    [activeSessionId, loadThreadState, pushEvent],
  );

  const updateChatRuntime = useCallback(
    (value: ChatRuntime | ((current: ChatRuntime) => ChatRuntime)) => {
      const nextRuntime = typeof value === "function" ? value(chatRuntimeRef.current) : value;
      chatRuntimeRef.current = nextRuntime;
      setChatRuntime(nextRuntime);
      if (!activeSessionId) return;
      setChatSessions((current) => current.map((session) => (session.id === activeSessionId ? { ...session, ...nextRuntime } : session)));
      void persistChatRuntime(nextRuntime, activeSessionId, selectedRepoIdRef.current);
    },
    [activeSessionId, persistChatRuntime],
  );

  useEffect(() => {
    setCompactStatus(null);
  }, [activeSessionId]);

  const loadChatHistory = useCallback(
    async (repoId: string, sessionId?: string) => {
      if (selectedRepoIdRef.current !== repoId) return;
      const requestSeq = ++chatLoadSeq.current;
      setIsLoadingChatHistory(true);
      try {
        const params = new URLSearchParams({ repoId });
        if (sessionId) params.set("sessionId", sessionId);
        const result = await apiWithRetry<ChatHistoryResponse>(`/api/chat/sessions?${params.toString()}`, undefined, 5);
        if (requestSeq !== chatLoadSeq.current || selectedRepoIdRef.current !== repoId || result.repoId !== repoId) return;
        if (result.degraded && !sessionId) {
          throw new Error(result.error || "云端会话暂时不可用；已保留当前消息，稍后将自动重试");
        }
        const nextSessions = result.sessions || [];
        const nextActiveSessionId = result.activeSessionId || "";
        const repo =
          statusRef.current.repos.find((item) => item.id === repoId) ||
          fallbackStatus.repos.find((item) => item.id === repoId) ||
          statusRef.current.repos[0] ||
          fallbackStatus.repos[0];
        const activeSession = nextSessions.find((session) => session.id === nextActiveSessionId);
        const draft = hydrateChatDraft(repo, activeSession?.draft || null);
        hydratedDraftRef.current = {
          key: draftStorageKey(repoId, nextActiveSessionId),
          snapshot: draftSnapshot(draft.input, draft.attachments),
        };
        setChatSessions(nextSessions);
        setActiveSessionId(nextActiveSessionId);
        setChatMessages(result.messages || []);
        setChatInput(draft.input);
        setChatAttachments(draft.attachments);
        setChatHistoryError(result.degraded ? result.error || "当前仅显示本地草稿，云端会话暂时不可用" : "");
      } catch (error) {
        if (requestSeq !== chatLoadSeq.current) return;
        setChatHistoryError(error instanceof Error ? error.message : "无法读取云端会话历史");
        pushEvent({
          tone: "warn",
          title: "会话加载",
          body: error instanceof Error ? error.message : "无法读取云端会话历史",
        });
      } finally {
        if (requestSeq === chatLoadSeq.current) setIsLoadingChatHistory(false);
      }
    },
    [pushEvent],
  );

  useEffect(() => {
    if (!repoSelectionReady) return;
    const routedSessionId = pendingRouteSession?.repoId === selectedRepoId ? pendingRouteSession.sessionId : "";
    if (!routedSessionId && activeSessionIdRef.current) return;
    void loadChatHistory(selectedRepoId, routedSessionId || undefined).finally(() => {
      if (routedSessionId) {
        pendingRouteSessionRef.current = null;
        setPendingRouteSession(null);
      }
    });
  }, [loadChatHistory, pendingRouteSession, repoSelectionReady, selectedRepoId]);

  const saveComposerDraft = useCallback(
    async (repoId: string, sessionId: string, input: string, attachments: UploadedAttachment[]) => {
      if (!repoId || !sessionId) return null;
      const result = await api<ChatDraftResponse>(`/api/chat/sessions/${encodeURIComponent(sessionId)}/draft`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoId, ...draftPayload(input, attachments) }),
      });
      if (result.sessions && selectedRepoIdRef.current === repoId) setChatSessions(result.sessions);
      return result;
    },
    [],
  );

  const flushComposerDraft = useCallback(async () => {
    const repoId = selectedRepoIdRef.current;
    const sessionId = activeSessionIdRef.current;
    if (!repoId || !sessionId) return;
    await saveComposerDraft(repoId, sessionId, chatInputRef.current, chatAttachmentsRef.current).catch(() => null);
  }, [saveComposerDraft]);

  flushComposerDraftRef.current = flushComposerDraft;

  useEffect(() => {
    if (!activeSessionId || isLoadingChatHistory) return;
    const key = draftStorageKey(selectedRepoId, activeSessionId);
    const snapshot = draftSnapshot(chatInput, chatAttachments);
    if (hydratedDraftRef.current?.key === key && hydratedDraftRef.current.snapshot === snapshot) {
      hydratedDraftRef.current = null;
      return;
    }
    const requestSeq = ++draftPersistSeq.current;
    const timer = window.setTimeout(() => {
      saveComposerDraft(selectedRepoId, activeSessionId, chatInput, chatAttachments).catch(() => {
        if (requestSeq === draftPersistSeq.current) {
          // Best-effort UI metadata; the next successful edit will retry.
        }
      });
    }, 450);
    return () => window.clearTimeout(timer);
  }, [activeSessionId, chatAttachments, chatInput, isLoadingChatHistory, saveComposerDraft, selectedRepoId]);

  useEffect(() => {
    const pendingTarget = pendingRouteSession || pendingRouteSessionRef.current;
    if (
      activeView === "cli" &&
      pendingTarget?.repoId === selectedRepoId &&
      pendingTarget.sessionId &&
      pendingTarget.sessionId !== activeRouteSessionId
    ) {
      return;
    }
    replaceAppHash({
      view: activeView,
      repoId: selectedRepoId,
      sessionId: activeView === "cli" ? activeRouteSessionId || undefined : undefined,
      automationId: activeView === "automations" ? selectedAutomationId : undefined,
    });
  }, [activeRouteSessionId, activeView, pendingRouteSession, selectedAutomationId, selectedRepoId]);

  useEffect(() => {
    const onHashChange = () => {
      const route = parseAppHash();
      setActiveView(route.view);
      if (route.automationId) setSelectedAutomationId(route.automationId);
      if (route.repoId && route.repoId !== selectedRepoIdRef.current) {
        switchRepoConversation(route.repoId);
      }
      if (route.view === "cli" && route.sessionId) {
        const repoId = route.repoId || selectedRepoIdRef.current;
        void flushComposerDraft();
        const pending = { repoId, sessionId: route.sessionId };
        pendingRouteSessionRef.current = pending;
        setPendingRouteSession(pending);
        if (repoId === selectedRepoIdRef.current) void loadChatHistory(repoId, route.sessionId);
      }
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [flushComposerDraft, loadChatHistory, switchRepoConversation]);

  useEffect(() => {
    const activeSession = chatSessions.find((session) => session.id === activeSessionId);
    if (!activeSession) return;
    setChatRuntime((current) => ({
      model: activeSession.model || current.model,
      reasoning: activeSession.reasoning || current.reasoning,
      sandbox: activeSession.sandbox || current.sandbox,
      approval: activeSession.approval || current.approval,
      search: typeof activeSession.search === "boolean" ? activeSession.search : current.search,
    }));
  }, [activeSessionId, chatSessions]);

  useEffect(() => {
    if (busyAction === "compact") return;
    setChatMessages((current) => {
      const next = settleStaleStreamingMessages(current);
      return next.some((message, index) => message !== current[index]) ? next : current;
    });
  }, [busyAction]);

  const attachToActiveJob = useCallback(
    async (kind: "turn" | "compact", job: ActiveJob, repoId: string, sessionId: string) => {
      if (attachedJobIds.current.has(job.id)) return;
      attachedJobIds.current.add(job.id);
      const responseId = `active-${job.id}`;
      setBusyAction(kind === "compact" ? "compact" : "chat");
      if (kind === "compact") {
        setCompactStatus({ running: true, text: "正在恢复主动压缩状态...", threadId: job.threadId });
      }
      setChatMessages((current) => {
        if (current.some((message) => message.id === responseId)) return current;
        return [
          ...settleStaleStreamingMessages(current),
          {
            id: responseId,
            role: "codex",
            text: "",
            time: job.startedAt || new Date().toISOString(),
            streaming: true,
            status: kind === "compact" ? "正在恢复压缩事件..." : "正在恢复运行中的任务...",
          },
        ];
      });

      const patchResponse = (patch: Partial<ChatMessage> | ((message: ChatMessage) => Partial<ChatMessage>)) => {
        setChatMessages((current) =>
          current.map((item) => {
            if (item.id !== responseId) return item;
            const nextPatch = typeof patch === "function" ? patch(item) : patch;
            return { ...item, ...nextPatch };
          }),
        );
      };

      try {
        const params = new URLSearchParams({ repoId, sessionId, kind });
        const response = await fetch(`/api/chat/job-events?${params.toString()}`);
        if (!response.ok || !response.body) throw new Error(await responseFailureMessage(response, "无法恢复云端任务事件"));
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let terminalEventReceived = false;

        const handleFrame = (frame: string) => {
          const lines = frame.split("\n");
          const event = lines.find((line) => line.startsWith("event: "))?.slice(7) || "message";
          const data = lines
            .filter((line) => line.startsWith("data: "))
            .map((line) => line.slice(6))
            .join("\n");
          const payload = data ? (JSON.parse(data) as Record<string, unknown>) : {};
          if (selectedRepoIdRef.current !== repoId) return;

          if (event === "status") {
            const text = String(payload.text || "");
            patchResponse({ status: text });
            if (kind === "compact") setCompactStatus((current) => ({ ...(current || { running: true, text }), running: true, text }));
            return;
          }
          if (event === "delta") {
            const text = String(payload.text || "");
            patchResponse((item) => ({ text: `${item.text}${text}`, status: "正在生成..." }));
            return;
          }
          if (event === "tokenUsage") {
            const nextUsage = payload.tokenUsage as ThreadTokenUsage | null;
            setThreadTokenUsage(nextUsage);
            setChatSessions((current) => current.map((session) => (session.id === sessionId ? { ...session, tokenUsage: nextUsage } : session)));
            return;
          }
          if (event === "goal") {
            const nextGoal = payload.goal as ThreadGoal | null;
            setThreadGoal(nextGoal);
            setGoalDraft(nextGoal?.objective || "");
            setGoalBudgetDraft(nextGoal?.tokenBudget ? String(nextGoal.tokenBudget) : "");
            setChatSessions((current) => current.map((session) => (session.id === sessionId ? { ...session, goal: nextGoal } : session)));
            return;
          }
          if (event === "tool") {
            const patch = liveToolEventPatch(payload);
            if (patch.status) patchResponse(patch);
            return;
          }
          if (event === "guardian") {
            patchResponse(guardianMessagePatch(payload));
            return;
          }
          if (event === "approval") {
            patchResponse({
              status: String(payload.summary || "Codex 已处理 approval request"),
              messageType: "approval",
              details: {
                kind: "approval",
                method: payload.method,
                decision: payload.decision,
                itemId: payload.itemId,
                detail: payload.detail,
              },
            });
            return;
          }
          if (event === "compacted") {
            const text = String(payload.text || "上下文已压缩");
            setCompactStatus((current) => ({ ...(current || { running: true, text }), running: true, text }));
            patchResponse({ text: "上下文摘要已生成，正在同步云端会话。", status: text });
            return;
          }
          if (event === "error") {
            terminalEventReceived = true;
            const message = String(payload.message || "云端 Codex 任务失败");
            patchResponse({ text: message, messageType: "error", streaming: false, status: "失败" });
            if (kind === "compact") setCompactStatus({ running: false, ok: false, text: "压缩失败", error: message });
            return;
          }
          if (event === "done") {
            terminalEventReceived = true;
            const ok = Boolean(payload.ok);
            const inactive = Boolean(payload.inactive);
            const error = ok ? "" : String(payload.error || "任务失败");
            const compactedAt = payload.compactedAt ? String(payload.compactedAt) : null;
            const nextUsage = (payload.tokenUsage as ThreadTokenUsage | null) || null;
            if (nextUsage) {
              setThreadTokenUsage(nextUsage);
              setChatSessions((current) => current.map((session) => (session.id === sessionId ? { ...session, tokenUsage: nextUsage } : session)));
            }
            patchResponse((item) => ({
              text: item.text || (inactive ? "云端 Codex 任务已结束，正在同步最新会话状态。" : ok ? "云端 Codex 任务已完成。" : error),
              messageType: ok ? item.messageType : "error",
              streaming: false,
              status: inactive ? "已结束" : ok ? "完成" : "失败",
            }));
            if (kind === "compact") {
              setCompactStatus({
                running: false,
                ok,
                compactedAt,
                threadId: payload.threadId ? String(payload.threadId) : job.threadId,
                text: inactive ? "压缩状态已结束" : ok ? "上下文已压缩" : "压缩失败",
                error: ok ? null : error,
              });
            }
          }
        };

        while (true) {
          const { value, done } = await reader.read();
          buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
          const frames = buffer.split("\n\n");
          buffer = frames.pop() || "";
          frames.filter(Boolean).forEach(handleFrame);
          if (done) break;
        }
        if (buffer.trim()) handleFrame(buffer);
        if (!terminalEventReceived) throw new Error("云端 Codex 任务连接已断开，未收到完成事件。");
        if (selectedRepoIdRef.current === repoId) {
          await loadChatHistory(repoId, sessionId);
          await loadThreadState(sessionId);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "云端 Codex 任务恢复失败";
        patchResponse({ text: message, messageType: "error", streaming: false, status: "失败" });
        pushEvent({ tone: "warn", title: "任务恢复", body: message });
      } finally {
        attachedJobIds.current.delete(job.id);
        setBusyAction(null);
      }
    },
    [loadChatHistory, loadThreadState, pushEvent],
  );

  useEffect(() => {
    if (!activeSessionId || busyAction) return;
    let cancelled = false;
    const repoId = selectedRepo.id;
    const sessionId = activeSessionId;
    api<ActiveJobsResponse>(`/api/chat/active?${new URLSearchParams({ repoId, sessionId }).toString()}`)
      .then((result) => {
        if (cancelled || selectedRepoIdRef.current !== repoId) return;
        if (result.turn) attachToActiveJob("turn", result.turn, repoId, sessionId);
        if (result.compact) attachToActiveJob("compact", result.compact, repoId, sessionId);
      })
      .catch(() => null);
    return () => {
      cancelled = true;
    };
  }, [activeSessionId, attachToActiveJob, busyAction, selectedRepo.id]);

  const newChatSession = async () => {
    if (busyAction === "chat") return;
    setBusyAction("new-session");
    try {
      await saveComposerDraft(selectedRepo.id, activeSessionId, chatInput, chatAttachments).catch(() => null);
      setChatRuntime(defaultChatRuntime);
      const result = await api<ChatHistoryResponse>("/api/chat/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoId: selectedRepo.id, title: "新会话" }),
      });
      const nextSessions = result.sessions || [];
      const nextActiveSessionId = result.activeSessionId || "";
      const activeSession = nextSessions.find((session) => session.id === nextActiveSessionId);
      const draft = hydrateChatDraft(selectedRepo, activeSession?.draft || null);
      hydratedDraftRef.current = {
        key: draftStorageKey(selectedRepo.id, nextActiveSessionId),
        snapshot: draftSnapshot(draft.input, draft.attachments),
      };
      setChatSessions(nextSessions);
      setActiveSessionId(nextActiveSessionId);
      setChatMessages(result.messages || []);
      setChatInput(draft.input);
      setChatAttachments(draft.attachments);
    } catch (error) {
      pushEvent({ tone: "warn", title: "新建会话", body: error instanceof Error ? error.message : "新建会话失败" });
    } finally {
      setBusyAction(null);
    }
  };

  const selectChatSession = async (sessionId: string) => {
    if (!sessionId || sessionId === activeSessionId || busyAction === "chat") return;
    setBusyAction("select-session");
    try {
      await saveComposerDraft(selectedRepo.id, activeSessionId, chatInput, chatAttachments).catch(() => null);
      const result = await api<ChatHistoryResponse>(`/api/chat/sessions/${encodeURIComponent(sessionId)}/select`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoId: selectedRepo.id }),
      });
      const nextSessions = result.sessions || [];
      const nextActiveSessionId = result.activeSessionId || "";
      const activeSession = nextSessions.find((session) => session.id === nextActiveSessionId);
      const draft = hydrateChatDraft(selectedRepo, activeSession?.draft || null);
      hydratedDraftRef.current = {
        key: draftStorageKey(selectedRepo.id, nextActiveSessionId),
        snapshot: draftSnapshot(draft.input, draft.attachments),
      };
      setChatSessions(nextSessions);
      setActiveSessionId(nextActiveSessionId);
      setChatMessages(result.messages || []);
      setChatInput(draft.input);
      setChatAttachments(draft.attachments);
    } catch (error) {
      pushEvent({ tone: "warn", title: "切换会话", body: error instanceof Error ? error.message : "切换会话失败" });
    } finally {
      setBusyAction(null);
    }
  };

  const deleteChatSession = async (sessionId: string) => {
    if (!sessionId || busyAction === "chat") return;
    setBusyAction("delete-session");
    try {
      const result = await api<ChatHistoryResponse>(
        `/api/chat/sessions/${encodeURIComponent(sessionId)}?repoId=${encodeURIComponent(selectedRepo.id)}`,
        { method: "DELETE" },
      );
      const nextSessions = result.sessions || [];
      const nextActiveSessionId = result.activeSessionId || "";
      const activeSession = nextSessions.find((session) => session.id === nextActiveSessionId);
      const draft = hydrateChatDraft(selectedRepo, activeSession?.draft || null);
      hydratedDraftRef.current = {
        key: draftStorageKey(selectedRepo.id, nextActiveSessionId),
        snapshot: draftSnapshot(draft.input, draft.attachments),
      };
      setChatSessions(nextSessions);
      setActiveSessionId(nextActiveSessionId);
      setChatMessages(result.messages || []);
      setChatInput(draft.input);
      setChatAttachments(draft.attachments);
      pushEvent({
        tone: "ok",
        title: result.archived ? "会话归档" : "草稿删除",
	        body: result.archived ? "已归档当前会话" : "已删除本地草稿",
      });
    } catch (error) {
      pushEvent({ tone: "warn", title: "会话操作", body: error instanceof Error ? error.message : "会话操作失败" });
    } finally {
      setBusyAction(null);
    }
  };

  const forkThread = async () => {
    if (!activeSessionId || busyAction) return;
    setBusyAction("fork-thread");
    try {
      await flushComposerDraft();
      const result = await api<ChatHistoryResponse>("/api/codex/thread-fork", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoId: selectedRepo.id, sessionId: activeSessionId }),
      });
      const nextSessions = result.sessions || [];
      const nextActiveSessionId = result.activeSessionId || "";
      const activeSession = nextSessions.find((session) => session.id === nextActiveSessionId);
      const draft = hydrateChatDraft(selectedRepo, activeSession?.draft || null);
      hydratedDraftRef.current = {
        key: draftStorageKey(selectedRepo.id, nextActiveSessionId),
        snapshot: draftSnapshot(draft.input, draft.attachments),
      };
      setChatSessions(nextSessions);
      setActiveSessionId(nextActiveSessionId);
      setChatMessages(result.messages || []);
      setChatInput(draft.input);
      setChatAttachments(draft.attachments);
	      pushEvent({ tone: "ok", title: "会话分支", body: "已从当前会话创建分支" });
    } catch (error) {
      pushEvent({ tone: "warn", title: "会话分支", body: error instanceof Error ? error.message : "分支会话失败" });
    } finally {
      setBusyAction(null);
    }
  };

  const archiveThread = async () => {
    if (!activeSessionId || busyAction) return;
    setBusyAction("archive-thread");
    try {
      await flushComposerDraft();
      const result = await api<ChatHistoryResponse>("/api/codex/thread-archive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoId: selectedRepo.id, sessionId: activeSessionId }),
      });
      const nextSessions = result.sessions || [];
      const nextActiveSessionId = result.activeSessionId || "";
      const activeSession = nextSessions.find((session) => session.id === nextActiveSessionId);
      const draft = hydrateChatDraft(selectedRepo, activeSession?.draft || null);
      hydratedDraftRef.current = {
        key: draftStorageKey(selectedRepo.id, nextActiveSessionId),
        snapshot: draftSnapshot(draft.input, draft.attachments),
      };
      setChatSessions(nextSessions);
      setActiveSessionId(nextActiveSessionId);
      setChatMessages(result.messages || []);
      setChatInput(draft.input);
      setChatAttachments(draft.attachments);
      pushEvent({ tone: "ok", title: "会话归档", body: "已归档当前会话" });
    } catch (error) {
      pushEvent({ tone: "warn", title: "会话归档", body: error instanceof Error ? error.message : "归档会话失败" });
    } finally {
      setBusyAction(null);
    }
  };

  const renameChatSession = async (sessionId: string, title: string) => {
    const nextTitle = title.trim();
    if (!sessionId || !nextTitle || busyAction) return;
    setBusyAction("rename-session");
    try {
      const result = await api<{ ok: boolean; sessionId: string; title: string }>("/api/codex/thread-name", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoId: selectedRepo.id, sessionId, title: nextTitle }),
      });
      const updatedTitle = result.title || nextTitle;
      setChatSessions((current) =>
        current.map((session) => (session.id === sessionId ? { ...session, title: updatedTitle, updatedAt: new Date().toISOString() } : session)),
      );
      pushEvent({ tone: "ok", title: "会话命名", body: updatedTitle });
    } catch (error) {
      pushEvent({ tone: "warn", title: "会话命名", body: error instanceof Error ? error.message : "重命名会话失败" });
    } finally {
      setBusyAction(null);
    }
  };

  const clearChatHistory = async () => {
    if (busyAction === "chat") return;
    if (activeChatSession?.codexSessionId) {
      pushEvent({
        tone: "warn",
        title: "会话清空",
	        body: "这段云端会话的历史由 Codex 管理，不能只在网页端清空。请归档当前会话或新建会话。",
      });
      return;
    }
    setBusyAction("clear-chat");
    try {
      const params = new URLSearchParams({ repoId: selectedRepo.id });
      if (activeSessionId) params.set("sessionId", activeSessionId);
      const result = await api<ChatHistoryResponse>(`/api/chat/history?${params.toString()}`, { method: "DELETE" });
      const nextSessions = result.sessions || [];
      const nextActiveSessionId = result.activeSessionId || "";
      const activeSession = nextSessions.find((session) => session.id === nextActiveSessionId);
      const draft = hydrateChatDraft(selectedRepo, activeSession?.draft || null);
      hydratedDraftRef.current = {
        key: draftStorageKey(selectedRepo.id, nextActiveSessionId),
        snapshot: draftSnapshot(draft.input, draft.attachments),
      };
      setChatSessions(nextSessions);
      setActiveSessionId(nextActiveSessionId);
      setChatMessages(result.messages || []);
      setChatInput(draft.input);
      setChatAttachments(draft.attachments);
      pushEvent({
        tone: "ok",
        title: "会话清空",
        body: `${selectedRepo.name} 的云端会话已清空`,
      });
    } catch (error) {
      pushEvent({
        tone: "warn",
        title: "会话清空",
        body: error instanceof Error ? error.message : "清空会话失败",
      });
    } finally {
      setBusyAction(null);
    }
  };

  const saveThreadGoal = async () => {
    if (!activeSessionId || !goalDraft.trim()) return;
    setBusyAction("goal");
    try {
      const result = await api<{ ok: boolean; goal: ThreadGoal }>("/api/codex/thread-goal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoId: selectedRepo.id,
          sessionId: activeSessionId,
          objective: goalDraft,
          tokenBudget: Number(goalBudgetDraft || 0) || null,
          status: "active",
        }),
      });
      setThreadGoal(result.goal || null);
      setChatSessions((current) => current.map((session) => (session.id === activeSessionId ? { ...session, goal: result.goal || null } : session)));
	      pushEvent({ tone: "ok", title: "Goal", body: "已写入会话目标" });
    } catch (error) {
      pushEvent({ tone: "warn", title: "Goal", body: error instanceof Error ? error.message : "设置 goal 失败" });
    } finally {
      setBusyAction(null);
    }
  };

  const clearThreadGoal = async () => {
    if (!activeSessionId) return;
    setBusyAction("goal");
    try {
      const params = new URLSearchParams({ repoId: selectedRepo.id, sessionId: activeSessionId });
      await api(`/api/codex/thread-goal?${params.toString()}`, { method: "DELETE" });
      setThreadGoal(null);
      setGoalDraft("");
      setGoalBudgetDraft("");
      setChatSessions((current) => current.map((session) => (session.id === activeSessionId ? { ...session, goal: null } : session)));
	      pushEvent({ tone: "ok", title: "Goal", body: "已清除会话目标" });
    } catch (error) {
      pushEvent({ tone: "warn", title: "Goal", body: error instanceof Error ? error.message : "清除 goal 失败" });
    } finally {
      setBusyAction(null);
    }
  };

  const compactThread = async () => {
    if (!activeSessionId) return;
    const chatRepoId = selectedRepo.id;
    const compactSessionId = activeSessionId;
    const responseId = `${Date.now()}-compact`;
    setBusyAction("compact");
	    setCompactStatus({ running: true, text: "正在连接云端 Codex..." });
    setChatMessages((current) => [
      ...settleStaleStreamingMessages(current),
      {
        id: responseId,
        role: "codex",
        text: "正在准备主动压缩当前上下文。",
        time: new Date().toISOString(),
        streaming: true,
	        status: "正在连接云端 Codex...",
      },
    ]);

    const patchCompactMessage = (patch: Partial<ChatMessage> | ((message: ChatMessage) => Partial<ChatMessage>)) => {
      setChatMessages((current) =>
        current.map((item) => {
          if (item.id !== responseId) return item;
          const nextPatch = typeof patch === "function" ? patch(item) : patch;
          return { ...item, ...nextPatch };
        }),
      );
    };

    try {
      const response = await fetch("/api/codex/thread-compact/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoId: chatRepoId, sessionId: compactSessionId, ...chatRuntime }),
      });
      if (!response.ok || !response.body) throw new Error(await responseFailureMessage(response, "无法启动上下文压缩"));

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let terminalEventReceived = false;

      const handleFrame = (frame: string) => {
        const lines = frame.split("\n");
        const event = lines.find((line) => line.startsWith("event: "))?.slice(7) || "message";
        const data = lines
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice(6))
          .join("\n");
        const payload = data ? JSON.parse(data) : {};
        if (selectedRepoIdRef.current !== chatRepoId) return;

        if (event === "meta") {
          const threadId = payload.threadId ? String(payload.threadId) : null;
          setCompactStatus((current) => ({ ...(current || { running: true, text: "" }), threadId }));
          return;
        }
        if (event === "status") {
          const text = String(payload.text || "正在压缩上下文...");
          setCompactStatus((current) => ({ ...(current || { running: true, text }), running: true, text }));
          patchCompactMessage({ text: "Codex 正在压缩当前会话的上下文。", status: text });
          return;
        }
        if (event === "tokenUsage") {
          const nextUsage = payload.tokenUsage as ThreadTokenUsage | null;
          setThreadTokenUsage(nextUsage);
          setChatSessions((current) =>
            current.map((session) => (session.id === compactSessionId ? { ...session, tokenUsage: nextUsage } : session)),
          );
          return;
        }
        if (event === "compacted") {
          const text = String(payload.text || "上下文已压缩");
          setCompactStatus((current) => ({ ...(current || { running: true, text }), running: true, text }));
          patchCompactMessage({ text: "上下文摘要已生成，正在同步云端会话。", status: text });
          return;
        }
        if (event === "error") {
          terminalEventReceived = true;
          const message = String(payload.message || "主动压缩失败");
          setCompactStatus({ running: false, ok: false, text: "压缩失败", error: message });
          patchCompactMessage({ text: message, messageType: "error", streaming: false, status: "失败" });
          return;
        }
        if (event === "done") {
          terminalEventReceived = true;
          const ok = Boolean(payload.ok);
          const compactedAt = payload.compactedAt ? String(payload.compactedAt) : null;
          const nextUsage = (payload.tokenUsage as ThreadTokenUsage | null) || null;
          if (nextUsage) setThreadTokenUsage(nextUsage);
          setChatSessions((current) =>
            current.map((session) =>
              session.id === compactSessionId
                ? {
                    ...session,
                    compactedAt: compactedAt || session.compactedAt,
                    tokenUsage: nextUsage || session.tokenUsage,
                    updatedAt: compactedAt || session.updatedAt,
                  }
                : session,
            ),
          );
          setCompactStatus({
            running: false,
            ok,
            compactedAt,
            threadId: payload.threadId ? String(payload.threadId) : null,
            text: ok ? "上下文已压缩" : "压缩失败",
            error: ok ? null : String(payload.error || "主动压缩失败"),
          });
          patchCompactMessage({
            text: ok ? "上下文已压缩。后续消息会从压缩后的会话继续执行。" : String(payload.error || "主动压缩失败"),
            messageType: ok ? "compact" : "error",
            streaming: false,
            status: ok ? "完成" : "失败",
          });
          pushEvent({
            tone: ok ? "ok" : "warn",
            title: "上下文压缩",
            body: ok ? "主动压缩已完成" : String(payload.error || "主动压缩失败"),
          });
        }
      };

      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() || "";
        frames.filter(Boolean).forEach(handleFrame);
        if (done) break;
      }
      if (buffer.trim()) handleFrame(buffer);
      if (!terminalEventReceived) throw new Error("主动压缩连接已断开，未收到完成事件。");
      if (selectedRepoIdRef.current === chatRepoId) await loadThreadState(compactSessionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "主动压缩失败";
      setCompactStatus({ running: false, ok: false, text: "压缩失败", error: message });
      patchCompactMessage({ text: message, messageType: "error", streaming: false, status: "失败" });
      pushEvent({ tone: "warn", title: "上下文压缩", body: message });
    } finally {
      setBusyAction(null);
    }
  };

  const saveAutoCompact = async () => {
    setBusyAction("auto-compact");
    try {
      const result = await api<ThreadStateResponse>("/api/codex/auto-compact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: autoCompactEnabled,
          tokenLimit: Number(autoCompactLimit || 0),
          scope: autoCompactScope,
        }),
      });
      const limit = result.config?.autoCompactTokenLimit || null;
      setAutoCompactEnabled(Boolean(limit));
      setAutoCompactLimit(String(limit || 160000));
      setAutoCompactScope(result.config?.autoCompactTokenLimitScope || "body_after_prefix");
      pushEvent({ tone: "ok", title: "自动压缩", body: limit ? `阈值 ${formatTokenCount(limit)} tokens` : "已关闭自动压缩" });
    } catch (error) {
      pushEvent({ tone: "warn", title: "自动压缩", body: error instanceof Error ? error.message : "保存自动压缩配置失败" });
    } finally {
      setBusyAction(null);
    }
  };

  const runAction = async (key: string, title: string, action: () => Promise<{ output: string; mocked?: boolean }>) => {
    setBusyAction(key);
    try {
      const result = await action();
      pushEvent({
        tone: result.mocked ? "warn" : "ok",
        title,
        body: result.output || "操作已完成",
      });
      await refresh();
    } catch (error) {
      pushEvent({
        tone: "warn",
        title,
        body: error instanceof Error ? error.message : "操作失败",
      });
    } finally {
      setBusyAction(null);
    }
  };

  const openFullLog = async (name: string) => {
    setBusyAction(`log-${name}`);
    try {
      const result = await api<{ name: string; content: string; mocked?: boolean }>(`/api/logs/${encodeURIComponent(name)}`);
      setFullLog(result);
      pushEvent({
        tone: result.mocked ? "warn" : "ok",
        title: "日志读取",
        body: `${result.name} 已加载`,
      });
    } catch (error) {
      pushEvent({
        tone: "warn",
        title: "日志读取",
        body: error instanceof Error ? error.message : "读取完整日志失败",
      });
    } finally {
      setBusyAction(null);
    }
  };

  const filteredAutomations = status.automations.filter((automation) => {
    const repo = status.repos.find((item) => item.id === automation.repoId);
    const haystack = `${automation.name} ${automation.id} ${repo?.name || ""}`.toLowerCase();
    return haystack.includes(query.toLowerCase());
  });

  useEffect(() => {
    const search = query.trim();
    if (search.length < 2) {
      globalSearchSeq.current += 1;
      setGlobalSessionMatches([]);
      setGlobalSessionSearchLoading(false);
      return;
    }
    const requestSeq = ++globalSearchSeq.current;
    const controller = new AbortController();
    setGlobalSessionSearchLoading(true);
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ q: search, limit: "12" });
      api<ChatSearchResponse>(`/api/chat/search?${params.toString()}`, { signal: controller.signal })
        .then((result) => {
          if (requestSeq !== globalSearchSeq.current || result.query !== search) return;
          setGlobalSessionMatches(result.sessions || []);
        })
        .catch((error) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          if (requestSeq === globalSearchSeq.current) setGlobalSessionMatches([]);
        })
        .finally(() => {
          if (requestSeq === globalSearchSeq.current) setGlobalSessionSearchLoading(false);
        });
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  const globalSearchResults = useMemo<GlobalSearchResult[]>(() => {
    const search = query.trim().toLowerCase();
    if (!search) return [];
    const matches = (...values: Array<string | null | undefined>) => values.some((value) => String(value || "").toLowerCase().includes(search));
    const results: GlobalSearchResult[] = [];
    const sessionResultIds = new Set<string>();
    const pushSessionResult = (session: ChatSession) => {
      if (isDraftChatSession(session)) return;
      const repo = status.repos.find((item) => item.id === session.repoId);
      const resultId = `session:${session.repoId}:${session.id}`;
      if (sessionResultIds.has(resultId)) return;
      if (!matches(sessionDisplayTitle(session), session.id, session.codexSessionId, repo?.name, sessionSubtitle(session))) return;
      sessionResultIds.add(resultId);
      results.push({
        id: resultId,
        kind: "session",
        label: sessionDisplayTitle(session),
        hint: `${repo?.name || session.repoId} · ${sessionSubtitle(session)}`,
        repoId: session.repoId,
        sessionId: session.id,
      });
    };
    const viewItems: Array<{ view: ActiveView; label: string; hint: string }> = [
	      { view: "cli", label: "新对话", hint: "回到云端 Codex 会话" },
      { view: "inbox", label: "收件箱", hint: `${attentionCount(status)} 个待关注项` },
      { view: "automations", label: "自动化", hint: `${status.automations.length} 个云端任务` },
      { view: "agent", label: "Agent", hint: "文件、终端和浏览器工具" },
      { view: "logs", label: "日志", hint: `${status.logs.length} 个最近日志` },
      { view: "settings", label: "设置", hint: "云端入口、权限和实例信息" },
    ];
    for (const item of viewItems) {
      if (matches(item.label, item.hint, item.view)) results.push({ id: `view:${item.view}`, kind: "view", label: item.label, hint: item.hint, view: item.view });
    }
    for (const repo of status.repos) {
      if (matches(repo.name, repo.id, repo.remote, repo.branch, repo.path)) {
        results.push({
          id: `project:${repo.id}`,
          kind: "project",
          label: repo.name,
          hint: `${repo.branch || "branch"} · ${repo.dirty ? "有未提交改动" : "工作区干净"}`,
          repoId: repo.id,
        });
      }
    }
    for (const session of chatSessions) pushSessionResult(session);
    for (const session of globalSessionMatches) pushSessionResult(session);
    for (const automation of status.automations) {
      const repo = status.repos.find((item) => item.id === automation.repoId);
      if (matches(automation.name, automation.id, automation.schedule, automation.prompt, repo?.name)) {
        results.push({
          id: `automation:${automation.id}`,
          kind: "automation",
          label: automation.name,
          hint: `${repo?.name || automation.repoId} · ${automation.enabled ? "启用" : "暂停"} · ${automation.schedule}`,
          repoId: automation.repoId,
          automationId: automation.id,
        });
      }
    }
    for (const log of status.logs) {
      if (matches(log.name, log.job, log.tail.join(" "))) {
        results.push({
          id: `log:${log.name}`,
          kind: "log",
          label: log.name,
          hint: `${log.job} · ${timeLabel(log.updatedAt)}`,
          logName: log.name,
        });
      }
    }
    return results.slice(0, 12);
  }, [chatSessions, globalSessionMatches, query, status]);

  const openGlobalSearchResult = (result: GlobalSearchResult) => {
    setQuery("");
    if (result.kind === "project" && result.repoId) {
      selectRepo(result.repoId);
      setActiveView("cli");
      return;
    }
    if (result.kind === "session" && result.repoId && result.sessionId) {
      const sameRepo = selectedRepoIdRef.current === result.repoId;
      switchRepoConversation(result.repoId);
      setActiveView("cli");
      if (sameRepo) void selectChatSession(result.sessionId);
      else void loadChatHistory(result.repoId, result.sessionId);
      return;
    }
    if (result.kind === "automation" && result.repoId && result.automationId) {
      switchRepoConversation(result.repoId);
      setSelectedAutomationId(result.automationId);
      setActiveView("automations");
      return;
    }
    if (result.kind === "log" && result.logName) {
      setActiveView("logs");
      void openFullLog(result.logName);
      return;
    }
    if (result.view) setActiveView(result.view);
  };

  const loadFileTree = useCallback(
    async (nextPath = filePath) => {
      setBusyAction("files");
      try {
        const params = new URLSearchParams({ repoId: selectedRepo.id, path: nextPath || "." });
        const result = await api<AgentFileTree>(`/api/files/tree?${params.toString()}`);
        setFilePath(result.path || ".");
        setFileTree(result.entries || []);
      } catch (error) {
        pushEvent({ tone: "warn", title: "文件列表", body: error instanceof Error ? error.message : "读取文件列表失败" });
      } finally {
        setBusyAction(null);
      }
    },
    [filePath, pushEvent, selectedRepo.id],
  );

  useEffect(() => {
    if (activeView === "agent") loadFileTree(".");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeView, selectedRepoId]);

  const openAgentFile = async (entry: AgentFileEntry) => {
    if (entry.type === "directory") {
      await loadFileTree(entry.path);
      return;
    }
    setBusyAction("file-read");
    try {
      const params = new URLSearchParams({ repoId: selectedRepo.id, path: entry.path });
      const result = await api<AgentFileRead>(`/api/files/read?${params.toString()}`);
      setSelectedFile(result);
      setFileDraft(result.content);
    } catch (error) {
      pushEvent({ tone: "warn", title: "文件读取", body: error instanceof Error ? error.message : "读取文件失败" });
    } finally {
      setBusyAction(null);
    }
  };

  const saveAgentFile = async () => {
    if (!selectedFile) return;
    setBusyAction("file-write");
    try {
      const result = await api<AgentFileRead>("/api/files/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoId: selectedRepo.id, path: selectedFile.path, content: fileDraft }),
      });
      setSelectedFile({ ...selectedFile, ...result, content: fileDraft });
      pushEvent({ tone: "ok", title: "文件保存", body: `${result.path} 已写入云端工作区` });
      await refresh();
    } catch (error) {
      pushEvent({ tone: "warn", title: "文件保存", body: error instanceof Error ? error.message : "保存文件失败" });
    } finally {
      setBusyAction(null);
    }
  };

  const runTerminalCommand = async () => {
    setBusyAction("terminal");
    try {
      const result = await api<TerminalResult>("/api/terminal/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoId: selectedRepo.id, command: terminalCommand }),
      });
      setTerminalResult(result);
      pushEvent({ tone: result.ok ? "ok" : "warn", title: "终端执行", body: terminalCommand });
      await refresh();
    } catch (error) {
      pushEvent({ tone: "warn", title: "终端执行", body: error instanceof Error ? error.message : "命令执行失败" });
    } finally {
      setBusyAction(null);
    }
  };

  const runBrowserCheck = async () => {
    setBusyAction("browser");
    try {
      const result = await api<BrowserResult>("/api/browser/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: browserUrl }),
      });
      setBrowserResult(result);
      pushEvent({ tone: result.ok ? "ok" : "warn", title: "浏览器验证", body: result.title || result.error || browserUrl });
    } catch (error) {
      pushEvent({ tone: "warn", title: "浏览器验证", body: error instanceof Error ? error.message : "浏览器验证失败" });
    } finally {
      setBusyAction(null);
    }
  };

  const uploadChatFiles = async (files: FileList | File[]) => {
    const selected = Array.from(files).slice(0, 8);
    if (!selected.length || busyAction === "chat") return;
    setUploadingAttachments(true);
    try {
      const encoded = await Promise.all(
        selected.map(async (file) => ({
          name: file.name,
          type: file.type || "application/octet-stream",
          dataUrl: await fileToDataUrl(file),
        })),
      );
      const result = await api<UploadResponse>("/api/uploads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoId: selectedRepo.id, files: encoded }),
      });
      const filesWithPreview = (result.files || []).map((file, index) => ({
        ...file,
        previewUrl: file.kind === "image" ? encoded[index]?.dataUrl : attachmentBlobUrl(selectedRepo, file),
      }));
      setChatAttachments((current) => [...current, ...filesWithPreview].slice(0, 8));
      pushEvent({ tone: "ok", title: "附件已上传", body: `${selected.length} 个文件已保存到 ${selectedRepo.name}` });
    } catch (error) {
      pushEvent({ tone: "warn", title: "附件上传失败", body: error instanceof Error ? error.message : "无法上传附件" });
    } finally {
      setUploadingAttachments(false);
    }
  };

  const sendChat = async (overrideMessage?: string, overrideAttachments?: UploadedAttachment[]) => {
    const usingOverride = overrideMessage !== undefined || overrideAttachments !== undefined;
    const message = (overrideMessage ?? chatInput).trim();
    const attachments = overrideAttachments ?? chatAttachments;
    if (!message && attachments.length === 0) return;
    const chatRepoId = selectedRepo.id;
    if (busyAction === "chat") {
      if (attachments.length) {
        pushEvent({ tone: "warn", title: "附件", body: "当前回复运行中，附件请等本轮完成后再发送。" });
        return;
      }
      if (!usingOverride) setChatInput("");
      setChatMessages((current) => [...current, { id: `${Date.now()}-user-steer`, role: "user", text: message, time: new Date().toISOString() }]);
      try {
        if (!usingOverride) {
          await api<ChatDraftResponse>(
            `/api/chat/sessions/${encodeURIComponent(activeSessionId)}/draft?repoId=${encodeURIComponent(chatRepoId)}`,
            { method: "DELETE" },
          ).catch(() => null);
        }
        await api("/api/codex/turn-steer", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repoId: chatRepoId, sessionId: activeSessionId, message }),
        });
      } catch (error) {
        pushEvent({ tone: "warn", title: "补充指令", body: error instanceof Error ? error.message : "当前回复无法补充指令" });
      }
      return;
    }
    if (busyAction) return;
    const displayMessage = message || "请查看我上传的附件。";
    const now = new Date().toISOString();
    const responseId = `${Date.now()}-codex`;
    if (!usingOverride) {
      setChatInput("");
      setChatAttachments([]);
    }
    setChatMessages((current) => [
      ...settleStaleStreamingMessages(current),
      { id: `${Date.now()}-user`, role: "user", text: displayMessage, attachments, time: now },
      {
        id: responseId,
        role: "codex",
        text: "",
        time: new Date().toISOString(),
        streaming: true,
        status: "正在连接云端 Codex...",
      },
    ]);
    setBusyAction("chat");
    try {
      const response = await fetch("/api/chat/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoId: chatRepoId, sessionId: activeSessionId, message, attachments: attachmentPayload(attachments), ...chatRuntime }),
      });
      if (!response.ok || !response.body) {
        throw new Error(await responseFailureMessage(response, "云端 Codex 对话失败"));
      }
      if (!usingOverride) {
        await api<ChatDraftResponse>(
          `/api/chat/sessions/${encodeURIComponent(activeSessionId)}/draft?repoId=${encodeURIComponent(chatRepoId)}`,
          { method: "DELETE" },
        ).catch(() => null);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let mocked = false;
      let collected = "";
      let stderr = "";
      let streamSessionId = activeSessionId;
      let terminalEventReceived = false;

      const patchResponse = (patch: Partial<ChatMessage> | ((message: ChatMessage) => Partial<ChatMessage>)) => {
        setChatMessages((current) =>
          current.map((item) => {
            if (item.id !== responseId) return item;
            const nextPatch = typeof patch === "function" ? patch(item) : patch;
            return { ...item, ...nextPatch };
          }),
        );
      };

      const handleFrame = (frame: string) => {
        const lines = frame.split("\n");
        const event = lines.find((line) => line.startsWith("event: "))?.slice(7) || "message";
        const data = lines
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice(6))
          .join("\n");
        const payload = data ? JSON.parse(data) : {};
        if (event === "meta") {
          if (selectedRepoIdRef.current !== chatRepoId) return;
          mocked = Boolean(payload.mocked);
          if (payload.sessionId) {
            streamSessionId = String(payload.sessionId);
            setActiveSessionId(streamSessionId);
          }
          patchResponse({ mocked });
          return;
        }
        if (event === "session") {
          if (selectedRepoIdRef.current !== chatRepoId) return;
          const codexSessionId = payload.codexSessionId ? String(payload.codexSessionId) : "";
          if (codexSessionId) {
	            patchResponse({ status: `云端会话 ${codexSessionId.slice(0, 8)} 已建立` });
          }
          return;
        }
        if (event === "status") {
          if (selectedRepoIdRef.current !== chatRepoId) return;
          patchResponse({ status: String(payload.text || "") });
          return;
        }
        if (event === "tokenUsage") {
          if (selectedRepoIdRef.current !== chatRepoId) return;
          const nextUsage = payload.tokenUsage as ThreadTokenUsage | null;
          setThreadTokenUsage(nextUsage);
          setChatSessions((current) => current.map((session) => (session.id === streamSessionId ? { ...session, tokenUsage: nextUsage } : session)));
          return;
        }
        if (event === "goal") {
          if (selectedRepoIdRef.current !== chatRepoId) return;
          const nextGoal = payload.goal as ThreadGoal | null;
          setThreadGoal(nextGoal);
          setGoalDraft(nextGoal?.objective || "");
          setGoalBudgetDraft(nextGoal?.tokenBudget ? String(nextGoal.tokenBudget) : "");
          setChatSessions((current) => current.map((session) => (session.id === streamSessionId ? { ...session, goal: nextGoal } : session)));
          return;
        }
        if (event === "tool") {
          if (selectedRepoIdRef.current !== chatRepoId) return;
          const patch = liveToolEventPatch(payload);
          if (patch.status) patchResponse(patch);
          return;
        }
        if (event === "guardian") {
          if (selectedRepoIdRef.current !== chatRepoId) return;
          patchResponse(guardianMessagePatch(payload));
          return;
        }
        if (event === "approval") {
          if (selectedRepoIdRef.current !== chatRepoId) return;
          patchResponse({
            status: String(payload.summary || "Codex 已处理 approval request"),
            messageType: "approval",
            details: {
              kind: "approval",
              method: payload.method,
              decision: payload.decision,
              itemId: payload.itemId,
              detail: payload.detail,
            },
          });
          return;
        }
        if (event === "stderr") {
          if (selectedRepoIdRef.current !== chatRepoId) return;
          stderr += String(payload.text || "");
          patchResponse({ status: "Codex 正在运行，收到运行日志..." });
          return;
        }
        if (event === "delta") {
          if (selectedRepoIdRef.current !== chatRepoId) return;
          const text = String(payload.text || "");
          collected += text;
          patchResponse((item) => ({ text: `${item.text}${text}`, status: "正在生成..." }));
          return;
        }
        if (event === "error") {
          if (selectedRepoIdRef.current !== chatRepoId) return;
          terminalEventReceived = true;
          patchResponse({ text: String(payload.message || "云端 Codex 对话失败"), messageType: "error", streaming: false, status: "失败" });
          return;
        }
        if (event === "done") {
          if (selectedRepoIdRef.current !== chatRepoId) return;
          terminalEventReceived = true;
          const ok = Boolean(payload.ok);
          if (payload.sessionId) {
            streamSessionId = String(payload.sessionId);
            setActiveSessionId(streamSessionId);
          }
          patchResponse({
            text: collected || stderr || (ok ? "Codex 已完成但没有返回内容。" : "云端 Codex 没有返回内容。"),
            mocked,
            streaming: false,
            status: ok ? "完成" : `退出码 ${payload.code ?? "未知"}`,
          });
        }
      };

      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() || "";
        frames.filter(Boolean).forEach(handleFrame);
        if (done) break;
      }
      if (buffer.trim()) handleFrame(buffer);
      if (!terminalEventReceived) throw new Error("云端 Codex 连接已断开，未收到完成事件。");
      if (selectedRepoIdRef.current === chatRepoId) await loadChatHistory(chatRepoId, streamSessionId);
    } catch (error) {
      if (selectedRepoIdRef.current !== chatRepoId) return;
      setChatMessages((current) =>
        current.map((item) =>
          item.id === responseId
            ? {
                ...item,
                role: "codex",
                text: error instanceof Error ? error.message : "云端 Codex 对话失败",
                time: new Date().toISOString(),
                messageType: "error",
                streaming: false,
                status: "失败",
              }
            : item,
        ),
      );
    } finally {
      setBusyAction(null);
    }
  };

  const runReview = async () => {
    if (!activeSessionId || busyAction) return;
    const chatRepoId = selectedRepo.id;
    const responseId = `${Date.now()}-review`;
    const reviewStartedAt = new Date().toISOString();
    setReviewActivity({
      repoId: chatRepoId,
      sessionId: activeSessionId,
      running: true,
	      status: "正在启动 Codex Review...",
      text: "",
      diff: "",
      updatedAt: reviewStartedAt,
    });
    setChatMessages((current) => [
      ...settleStaleStreamingMessages(current),
      { id: `${Date.now()}-user-review`, role: "user", text: "/review 当前未提交改动", time: reviewStartedAt },
      {
        id: responseId,
        role: "codex",
        text: "",
        time: reviewStartedAt,
        streaming: true,
	        status: "正在启动 Codex Review...",
        messageType: "review",
      },
    ]);
    setBusyAction("chat");
    try {
      const response = await fetch("/api/codex/review/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoId: chatRepoId, sessionId: activeSessionId, targetType: "uncommittedChanges", delivery: "inline", ...chatRuntime }),
      });
      if (!response.ok || !response.body) throw new Error(await responseFailureMessage(response, "无法启动 Codex Review"));
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let collected = "";
      let reviewDiff = "";
      let terminalEventReceived = false;
      let streamSessionId = activeSessionId;
      const updateReviewActivity = (patch: Partial<ReviewActivity>) => {
        setReviewActivity((current) => {
          if (current && current.repoId !== chatRepoId) return current;
          return {
            repoId: chatRepoId,
            sessionId: streamSessionId,
            running: true,
            status: "Codex review 正在运行...",
            text: collected,
            diff: reviewDiff,
            updatedAt: new Date().toISOString(),
            ...current,
            ...patch,
          };
        });
      };
      const patchResponse = (patch: Partial<ChatMessage> | ((message: ChatMessage) => Partial<ChatMessage>)) => {
        setChatMessages((current) =>
          current.map((item) => {
            if (item.id !== responseId) return item;
            const nextPatch = typeof patch === "function" ? patch(item) : patch;
            return { ...item, ...nextPatch };
          }),
        );
      };
      const handleFrame = (frame: string) => {
        const lines = frame.split("\n");
        const event = lines.find((line) => line.startsWith("event: "))?.slice(7) || "message";
        const data = lines
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice(6))
          .join("\n");
        const payload = data ? JSON.parse(data) : {};
        if (selectedRepoIdRef.current !== chatRepoId) return;
        if (event === "meta" && payload.sessionId) {
          streamSessionId = String(payload.sessionId);
          setActiveSessionId(streamSessionId);
          return;
        }
	        if (event === "session" && payload.codexSessionId) {
	          patchResponse({ status: `云端会话 ${String(payload.codexSessionId).slice(0, 8)} 已建立` });
	          updateReviewActivity({ sessionId: streamSessionId, status: `会话 ${String(payload.codexSessionId).slice(0, 8)} 已建立` });
          return;
        }
        if (event === "status") {
          const text = String(payload.text || "Codex review 正在运行...");
          patchResponse({ status: text });
          updateReviewActivity({ status: text });
          return;
        }
        if (event === "tool") {
          const label = liveToolEventLabel(payload, true);
          if (payload.type === "filePatch" || payload.type === "diff") {
            reviewDiff = formatDiffPayload(payload.diff ?? payload.patch ?? payload.text ?? payload);
            patchResponse({
              status: label || "更新 review diff",
              messageType: "review",
              details: {
                kind: "review",
                status: label || "更新 review diff",
                diff: reviewDiff,
                tool: payload.type,
              },
            });
            updateReviewActivity({ status: label || "更新 review diff", diff: reviewDiff });
            return;
          }
          const patch = liveToolEventPatch(payload, true);
          if (patch.status) {
            patchResponse(patch);
            updateReviewActivity({ status: label });
          }
          return;
        }
        if (event === "guardian") {
          patchResponse(guardianMessagePatch(payload, "Codex review 已处理权限自动审查"));
          updateReviewActivity({ status: String(payload.summary || "Codex review 已处理权限自动审查") });
          return;
        }
        if (event === "approval") {
          patchResponse({
            status: String(payload.summary || "Codex review 已处理 approval request"),
            messageType: "approval",
            details: {
              kind: "approval",
              method: payload.method,
              decision: payload.decision,
              itemId: payload.itemId,
              detail: payload.detail,
            },
          });
          updateReviewActivity({ status: String(payload.summary || "Codex review 已处理 approval request") });
          return;
        }
        if (event === "delta") {
          const text = String(payload.text || "");
          collected += text;
          patchResponse((item) => ({ text: `${item.text}${text}`, status: "正在生成 review..." }));
          updateReviewActivity({ text: collected, status: "正在生成 review..." });
          return;
        }
        if (event === "error") {
          terminalEventReceived = true;
          const message = String(payload.message || "Codex review 失败");
          patchResponse({ text: message, messageType: "review", streaming: false, status: "失败" });
          updateReviewActivity({ running: false, status: "失败", error: message });
          return;
        }
        if (event === "done") {
          terminalEventReceived = true;
          const ok = Boolean(payload.ok);
          if (payload.sessionId) streamSessionId = String(payload.sessionId);
          const finalText = collected || (ok ? "Codex review completed without output." : String(payload.error || "Codex review 失败"));
          patchResponse({
            text: finalText,
            streaming: false,
            status: ok ? "完成" : "失败",
            messageType: "review",
            details: reviewDiff ? { kind: "review", status: ok ? "完成" : "失败", diff: reviewDiff } : undefined,
          });
          updateReviewActivity({
            running: false,
            status: ok ? "完成" : "失败",
            text: finalText,
            diff: reviewDiff,
            error: ok ? undefined : String(payload.error || "Codex review 失败"),
          });
        }
      };
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() || "";
        frames.filter(Boolean).forEach(handleFrame);
        if (done) break;
      }
      if (buffer.trim()) handleFrame(buffer);
      if (!terminalEventReceived) throw new Error("Codex review 连接已断开，未收到完成事件。");
      if (selectedRepoIdRef.current === chatRepoId) await loadChatHistory(chatRepoId, streamSessionId);
    } catch (error) {
      if (selectedRepoIdRef.current !== chatRepoId) return;
      setChatMessages((current) =>
        current.map((item) =>
          item.id === responseId
            ? {
                ...item,
                text: error instanceof Error ? error.message : "Codex review 失败",
                messageType: "review",
                streaming: false,
                status: "失败",
              }
            : item,
        ),
      );
      setReviewActivity((current) => ({
        repoId: chatRepoId,
        sessionId: activeSessionId,
        running: false,
        status: "失败",
        text: current?.text || "",
        diff: current?.diff || "",
        error: error instanceof Error ? error.message : "Codex review 失败",
        updatedAt: new Date().toISOString(),
      }));
    } finally {
      setBusyAction(null);
    }
  };

  const loadReviewPrContext = useCallback(async () => {
    setReviewPrLoading(true);
    try {
      const params = new URLSearchParams({ repoId: selectedRepo.id });
      const payload = await apiWithDeadline<ReviewPrContextResponse>(`/api/codex/review/pr-context?${params.toString()}`, {}, 12_000);
      if (payload.error) throw new Error(payload.error);
      setReviewPrContext(payload.data || null);
    } catch (error) {
      setReviewPrContext({
        available: false,
        reason: error instanceof Error ? error.message : "无法读取 PR 状态",
        ghInstalled: false,
        authenticated: false,
        repo: null,
        pr: null,
      });
    } finally {
      setReviewPrLoading(false);
    }
  }, [selectedRepo.id]);

  const publishReviewPrComment = useCallback(
    async (finding: ReviewFinding, draft: string, fallbackPath: string) => {
      if (reviewPrPublishBusy) return;
      setReviewPrPublishBusy(finding.id);
      try {
        const body = reviewPrCommentBody(finding, draft, fallbackPath);
        const payload = await apiWithDeadline<ReviewPrCommentResponse>("/api/codex/review/pr-comment", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            repoId: selectedRepo.id,
            path: finding.path || fallbackPath,
            startLine: finding.startLine,
            endLine: finding.endLine,
            body,
          }),
        }, 30_000);
        if (payload.error) throw new Error(payload.error);
        const result = payload.data;
        pushEvent({
          tone: "ok",
          title: "Review",
          body:
            result?.mode === "inline"
              ? `已发布到 PR #${result.pr?.number || ""} 行内评论`
              : `已发布到 PR #${result?.pr?.number || ""} 评论`,
        });
        if (result?.url) window.open(result.url, "_blank", "noopener,noreferrer");
        void loadReviewPrContext();
      } catch (error) {
        pushEvent({ tone: "warn", title: "Review 发布失败", body: error instanceof Error ? error.message : "无法发布到 PR" });
      } finally {
        setReviewPrPublishBusy("");
      }
    },
    [loadReviewPrContext, pushEvent, reviewPrPublishBusy, selectedRepo.id],
  );

  const interruptChat = async () => {
    if (busyAction !== "chat") return;
    try {
      await api("/api/codex/turn-interrupt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoId: selectedRepo.id, sessionId: activeSessionId }),
      });
      pushEvent({ tone: "ok", title: "打断", body: "已请求 Codex 停止当前回复" });
    } catch (error) {
      pushEvent({ tone: "warn", title: "打断", body: error instanceof Error ? error.message : "当前回复无法打断" });
    }
  };

  const openAutomationRun = (run: AutomationRun) => {
    switchRepoConversation(run.repoId);
    setSelectedAutomationId(run.automationId);
    const targetSessionId = run.threadId || run.sessionId || "";
    if (targetSessionId) {
      openAttentionThread(run.repoId, targetSessionId);
      return;
    }
    setActiveView("automations");
  };

  const openAttentionThread = useCallback((repoId: string, sessionId: string) => {
    if (!repoId || !sessionId) return;
    void flushComposerDraft();
    const pending = { repoId, sessionId };
    pendingRouteSessionRef.current = pending;
    switchRepoConversation(repoId);
    setPendingRouteSession(pending);
    setActiveView("cli");
    replaceAppHash({ view: "cli", repoId, sessionId });
    void loadChatHistory(repoId, sessionId);
  }, [flushComposerDraft, loadChatHistory, switchRepoConversation]);

  useEffect(() => {
    if (!notificationsEnabled || typeof window.Notification === "undefined" || window.Notification.permission !== "granted") return;
    const attention = getAttentionSummary(status);
    const latestItem = attention.items.find((item) => item.id === attention.latestItemId) || attention.items[0] || null;
    const latestId = latestItem?.id || attention.latestItemId;
    if (!latestId || latestId === lastNotifiedAttentionId.current) return;
    lastNotifiedAttentionId.current = latestId;
    if (document.visibilityState === "visible") return;
    const notification = new window.Notification("Codex Cloud 需要关注", {
      body: latestItem?.title || attention.latestTitle || `${attention.count} 个事件需要处理`,
      tag: latestId,
    });
    notification.onclick = () => {
      window.focus();
      notification.close();
      if (latestItem?.action === "thread") {
        const repoId = latestItem.repoId || "";
        const sessionId = latestItem.threadId || latestItem.sessionId || "";
        if (repoId && sessionId) {
          openAttentionThread(repoId, sessionId);
          return;
        }
      }
      if (latestItem?.action === "repo" && latestItem.repoId) {
        selectRepo(latestItem.repoId);
        setActiveView("cli");
        return;
      }
      if (latestItem?.action === "automation") {
        setActiveView("automations");
        replaceAppHash({ view: "automations", repoId: latestItem.repoId || selectedRepoId, automationId: latestItem.automationId || undefined });
        return;
      }
      if (latestItem?.action === "logs") {
        setActiveView("logs");
        replaceAppHash({ view: "logs" });
        return;
      }
      const externalActionUrl = safeExternalActionUrl(latestItem?.actionUrl);
      if (externalActionUrl) {
        window.open(externalActionUrl, "_blank", "noopener,noreferrer");
        return;
      }
      if (["settings", "codex-login", "mcp-login"].includes(String(latestItem?.action || ""))) {
        setActiveView("settings");
        replaceAppHash({ view: "settings" });
        return;
      }
      setActiveView("inbox");
      replaceAppHash({ view: "inbox" });
    };
  }, [notificationsEnabled, openAttentionThread, selectRepo, selectedRepoId, status]);

  return (
    <main className="app-shell">
      <Sidebar
        status={status}
        statusReady={statusReady}
        activeView={activeView}
        selectedRepoId={selectedRepoId}
        sessions={chatSessions}
        activeSessionId={activeSessionId}
        historyLoading={isLoadingChatHistory}
        mobileOpen={mobileSidebarOpen}
        onClose={() => setMobileSidebarOpen(false)}
        onSelectView={setActiveView}
        onNewChat={() => {
          setActiveView("cli");
          newChatSession();
        }}
        onSelectSession={(sessionId) => {
          setActiveView("cli");
          void selectChatSession(sessionId);
        }}
        onNewProject={() => setProjectDialogOpen(true)}
        onSelectRepo={(repoId) => {
          selectRepo(repoId);
          setActiveView("cli");
        }}
      />
      {mobileSidebarOpen && (
        <button className="mobile-sidebar-backdrop" aria-label="关闭侧边栏" onClick={() => setMobileSidebarOpen(false)} type="button" />
      )}

      <section className="workspace">
        <TopBar
          status={status}
          activeView={activeView}
          cloudConnection={cloudConnection}
          isRefreshing={isRefreshing}
          onRefresh={refresh}
          onOpenSidebar={() => setMobileSidebarOpen(true)}
          query={query}
          setQuery={setQuery}
          searchResults={globalSearchResults}
          searchLoading={globalSessionSearchLoading}
          onSearchSelect={openGlobalSearchResult}
        />

        {activeView === "inbox" && (
          <div className="content-grid inbox-content-grid">
            <AttentionView
              status={status}
              statusReady={statusReady}
              notificationsEnabled={notificationsEnabled}
              notificationPermission={notificationPermission}
              onOpenRun={openAutomationRun}
              onOpenThread={openAttentionThread}
              onOpenRepo={(repoId) => {
                selectRepo(repoId);
                setActiveView("cli");
              }}
              onOpenAutomations={() => setActiveView("automations")}
              onOpenLogs={() => setActiveView("logs")}
              onOpenSettings={() => setActiveView("settings")}
              onCodexLogin={() => startCodexAccountLogin("chatgptDeviceCode")}
              onMcpLogin={startMcpLogin}
              onToggleNotifications={toggleNotifications}
              onAcknowledge={acknowledgeAttention}
              onClearResolved={clearResolvedAttention}
              attentionBusy={attentionBusy}
            />
          </div>
        )}

        {activeView === "automations" && (
          <div className="content-grid">
            <section className="panel automation-panel" aria-label="自动化任务">
              <PanelTitle title="自动化" eyebrow="云端任务" onRefresh={refresh} spinning={isRefreshing} />

              <div className="automation-list">
                {filteredAutomations.map((automation) => (
                  <AutomationRow
                    key={automation.id}
                    automation={automation}
                    repo={status.repos.find((repo) => repo.id === automation.repoId)}
                    selected={automation.id === selectedAutomation.id}
                    onSelect={() => {
                      switchRepoConversation(automation.repoId);
                      setSelectedAutomationId(automation.id);
                    }}
                  />
                ))}
              </div>
            </section>

            <section className="thread-panel">
              <RunThread
                status={status}
                automation={selectedAutomation}
                repo={selectedRepo}
                runs={selectedAutomationRuns}
                events={events}
                busyAction={busyAction}
                onRun={() =>
                  runAction(`run-${selectedAutomation.id}`, "立即运行", () =>
                    api(`/api/automations/${selectedAutomation.id}/run`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ runner: "app-server", worktree: true }),
                    }),
                  )
                }
                onOpenRun={(run) => {
                  openAutomationRun(run);
                }}
                onPause={() =>
                  runAction(`pause-${selectedAutomation.id}`, selectedAutomation.enabled ? "暂停定时器" : "恢复定时器", () =>
                    api(`/api/automations/${selectedAutomation.id}/${selectedAutomation.enabled ? "pause" : "resume"}`, {
                      method: "POST",
                    }),
                  )
                }
                onPull={() =>
                  runAction(`pull-${selectedRepo.id}`, "同步仓库", () =>
                    api(`/api/repos/${selectedRepo.id}/pull`, { method: "POST" }),
                  )
                }
                onOpenLog={openFullLog}
              />
            </section>

            <aside className="right-rail">
              <CloudStatus status={status} cloudConnection={cloudConnection} onOpenThread={openAttentionThread} />
              <RepoCard repo={selectedRepo} />
            </aside>
          </div>
        )}

        {activeView === "cli" && (
          <div className="content-grid session-content-grid">
            <CloudChat
              status={status}
              cloudConnection={cloudConnection}
              repo={selectedRepo}
              sessions={chatSessions}
              activeSessionId={activeSessionId}
              onNewSession={newChatSession}
              onNewProject={() => setProjectDialogOpen(true)}
              onSelectSession={selectChatSession}
              onOpenThread={openAttentionThread}
              onDeleteSession={deleteChatSession}
              onRenameSession={renameChatSession}
              onForkThread={forkThread}
              onArchiveThread={archiveThread}
              messages={chatMessages}
              input={chatInput}
              attachments={chatAttachments}
              uploadingAttachments={uploadingAttachments}
              runtime={chatRuntime}
              modelOptions={codexModels}
              appStatus={codexAppStatus}
              appStatusLoading={codexAppStatusLoading}
              tokenUsage={threadTokenUsage}
              compactStatus={compactStatus}
              goal={threadGoal}
              goalDraft={goalDraft}
              goalBudgetDraft={goalBudgetDraft}
              reviewActivity={reviewActivity}
              reviewPrContext={reviewPrContext}
              reviewPrLoading={reviewPrLoading}
              reviewPrPublishBusy={reviewPrPublishBusy}
              autoCompactEnabled={autoCompactEnabled}
              autoCompactLimit={autoCompactLimit}
              autoCompactScope={autoCompactScope}
              onRuntime={updateChatRuntime}
              onInput={setChatInput}
              onFilesSelected={uploadChatFiles}
              onRemoveAttachment={(index) => setChatAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))}
              onGoalDraft={setGoalDraft}
              onGoalBudgetDraft={setGoalBudgetDraft}
              onAutoCompactEnabled={setAutoCompactEnabled}
              onAutoCompactLimit={setAutoCompactLimit}
              onAutoCompactScope={setAutoCompactScope}
              onSaveGoal={saveThreadGoal}
              onClearGoal={clearThreadGoal}
              onCompact={compactThread}
              onReview={runReview}
              onRefreshReviewPrContext={loadReviewPrContext}
              onPublishReviewComment={publishReviewPrComment}
              onSaveAutoCompact={saveAutoCompact}
              onCodexLogin={startCodexAccountLogin}
              onCodexLoginCancel={cancelCodexAccountLogin}
              onCodexLogout={logoutCodexAccount}
              onMcpLogin={startMcpLogin}
              onMcpReload={reloadMcpServers}
              onSend={() => sendChat()}
              onSubmitReviewComment={(message) => sendChat(message, [])}
              onInterrupt={interruptChat}
              onClear={clearChatHistory}
              busy={busyAction === "chat"}
              busyAction={busyAction}
              codexAccountBusy={codexAccountBusy}
              mcpLoginBusy={mcpLoginBusy}
              historyLoading={isLoadingChatHistory}
              historyError={chatHistoryError}
            />
          </div>
        )}

        {activeView === "agent" && (
          <div className="content-grid">
            <AgentTools
              status={status}
              cloudConnection={cloudConnection}
              repo={selectedRepo}
              selectedRepoId={selectedRepoId}
              onSelectRepo={selectRepo}
              filePath={filePath}
              fileTree={fileTree}
              selectedFile={selectedFile}
              fileDraft={fileDraft}
              terminalCommand={terminalCommand}
              terminalResult={terminalResult}
              browserUrl={browserUrl}
              browserResult={browserResult}
              busyAction={busyAction}
              onFilePath={setFilePath}
              onFileDraft={setFileDraft}
              onBrowserUrl={setBrowserUrl}
              onTerminalCommand={setTerminalCommand}
              onLoadTree={loadFileTree}
              onOpenFile={openAgentFile}
              onSaveFile={saveAgentFile}
              onRunTerminal={runTerminalCommand}
              onRunBrowser={runBrowserCheck}
            />
            <aside className="right-rail">
              <CloudStatus status={status} cloudConnection={cloudConnection} onOpenThread={openAttentionThread} />
              <RepoCard repo={selectedRepo} />
              <LogCard logs={status.logs} automation={selectedAutomation} />
            </aside>
          </div>
        )}

        {activeView === "logs" && (
          <div className="content-grid">
            <LogsView status={status} statusReady={statusReady} cloudConnection={cloudConnection} logs={status.logs} />
            <aside className="right-rail">
              <CloudStatus status={status} cloudConnection={cloudConnection} onOpenThread={openAttentionThread} />
              <RepoCard repo={selectedRepo} />
            </aside>
          </div>
        )}

        {activeView === "settings" && (
          <div className="content-grid">
            <SettingsView
              status={status}
              repo={selectedRepo}
              repoSelectionReady={repoSelectionReady}
              appStatus={codexAppStatus}
              appStatusLoading={codexAppStatusLoading}
              onRefresh={() => {
                refresh();
                loadCodexAppStatus();
              }}
              isRefreshing={isRefreshing}
              onMcpLogin={startMcpLogin}
              onMcpReload={reloadMcpServers}
              onCodexLogin={startCodexAccountLogin}
              onCodexLoginCancel={cancelCodexAccountLogin}
              onCodexLogout={logoutCodexAccount}
              codexAccountBusy={codexAccountBusy}
              mcpLoginBusy={mcpLoginBusy}
              busyAction={busyAction}
              externalNotificationBusy={externalNotificationBusy}
              pushNotificationBusy={pushNotificationBusy}
              browserPushEndpoint={browserPushEndpoint}
              browserPushReadiness={browserPushReadiness}
              diagnostics={codexDiagnostics || status.diagnostics || null}
              diagnosticsBusy={diagnosticsBusy}
              onExternalNotificationTest={() => runExternalNotificationAction("test")}
              onExternalNotificationCheck={() => runExternalNotificationAction("check")}
              onPushSubscribe={enableBrowserPushNotifications}
              onPushUnsubscribe={disableBrowserPushNotifications}
              onPushTest={testBrowserPushNotifications}
              onRunDiagnostics={runCodexDiagnostics}
            />
            <aside className="right-rail">
              <CloudStatus status={status} cloudConnection={cloudConnection} onOpenThread={openAttentionThread} />
              <RepoCard repo={selectedRepo} />
              <LogCard logs={status.logs} automation={selectedAutomation} />
            </aside>
          </div>
        )}
        {fullLog && <FullLogDrawer log={fullLog} onClose={() => setFullLog(null)} />}
        {projectDialogOpen && (
          <ProjectDialog
            name={projectName}
            remote={projectRemote}
            busy={busyAction === "create-project"}
            onName={setProjectName}
            onRemote={setProjectRemote}
            onCreate={createProject}
            onClose={() => setProjectDialogOpen(false)}
          />
        )}
      </section>
    </main>
  );
}

function Sidebar({
  status,
  statusReady,
  activeView,
  selectedRepoId,
  sessions,
  activeSessionId,
  historyLoading,
  mobileOpen,
  onClose,
  onSelectView,
  onNewChat,
  onSelectSession,
  onNewProject,
  onSelectRepo,
}: {
  status: ConsoleStatus;
  statusReady: boolean;
  activeView: ActiveView;
  selectedRepoId: string;
  sessions: ChatSession[];
  activeSessionId: string;
  historyLoading: boolean;
  mobileOpen: boolean;
  onClose: () => void;
  onSelectView: (view: ActiveView) => void;
  onNewChat: () => void;
  onSelectSession: (sessionId: string) => void;
  onNewProject: () => void;
  onSelectRepo: (id: string) => void;
}) {
  const [sessionsExpanded, setSessionsExpanded] = useState(false);
  const repoSessions = sessions
    .filter((session) => session.repoId === selectedRepoId)
    .sort((a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime());
  const projectSessions = visibleSessionList(repoSessions, activeSessionId);
  const attention = getAttentionSummary(status);
  const activeJobs = status.activeJobs || [];
  const visibleProjectSessions = compactSidebarSessions(projectSessions, activeSessionId, sessionsExpanded, attention, activeJobs);
  const sidebarSessionGroups = groupedSessions(visibleProjectSessions, activeSessionId, attention, activeJobs);
  const hiddenSessionCount = Math.max(0, projectSessions.length - visibleProjectSessions.length);
  const choose = (action: () => void) => () => {
    action();
    onClose();
  };

  return (
    <aside className={cx("sidebar", mobileOpen && "mobile-open")}>
      <div className="brand-row">
        <div className="brand-mark">
          <Bot size={20} />
        </div>
        <div>
          <strong>Codex</strong>
          <span>Cloud</span>
        </div>
        <button className="icon-command mobile-sidebar-close" onClick={onClose} aria-label="关闭侧边栏" type="button">
          <X size={16} />
        </button>
      </div>

      <nav className="nav-stack">
        <button className={cx("nav-item", activeView === "inbox" && "active")} onClick={choose(() => onSelectView("inbox"))}>
          <CheckCircle2 size={18} />
          <span>收件箱</span>
          <small>{statusReady ? attentionCount(status) : "..."}</small>
        </button>
        <button className={cx("nav-item", activeView === "automations" && "active")} onClick={choose(() => onSelectView("automations"))}>
          <Activity size={18} />
          <span>自动化</span>
          <small>{status.automations.length}</small>
        </button>
        <button className={cx("nav-item", activeView === "cli" && "active")} onClick={choose(onNewChat)}>
          <MessageSquare size={18} />
          <span>新对话</span>
        </button>
        <button className={cx("nav-item", activeView === "agent" && "active")} onClick={choose(() => onSelectView("agent"))}>
          <SlidersHorizontal size={18} />
          <span>Agent</span>
        </button>
        <button className={cx("nav-item", activeView === "logs" && "active")} onClick={choose(() => onSelectView("logs"))}>
          <History size={18} />
          <span>日志</span>
        </button>
        <button className={cx("nav-item", activeView === "settings" && "active")} onClick={choose(() => onSelectView("settings"))}>
          <Settings2 size={18} />
          <span>设置</span>
        </button>
      </nav>

      <div className="sidebar-section">
        <div className="sidebar-section-title">
          <p>项目</p>
          <button onClick={choose(onNewProject)} title="新建项目" type="button">
            <Plus size={14} />
          </button>
        </div>
        {status.repos.map((repo) => (
          <button
            key={repo.id}
            className={cx("project-item", selectedRepoId === repo.id && "selected")}
            onClick={choose(() => onSelectRepo(repo.id))}
          >
            <span className={cx("repo-dot", repo.accent)} />
            <span>{repo.name}</span>
            <ChevronRight size={15} />
          </button>
        ))}
      </div>

      <div className="sidebar-section thread-sidebar-section">
        <div className="sidebar-section-title">
          <span className="sidebar-section-heading">
            <span>对话</span>
            {projectSessions.length > 0 && <small>{projectSessions.length}</small>}
          </span>
          <button onClick={choose(onNewChat)} title="新建对话" type="button">
            <Plus size={14} />
          </button>
        </div>
        {historyLoading && projectSessions.length === 0 && <div className="sidebar-session-empty">同步会话中...</div>}
        {!historyLoading && projectSessions.length === 0 && <div className="sidebar-session-empty">暂无对话</div>}
        {projectSessions.length > 0 && (
          <div className="sidebar-session-list">
            {sidebarSessionGroups.map((group) => (
              <section className="sidebar-session-group" key={group.kind} aria-label={group.title}>
                <div className="sidebar-session-group-title">
                  <span>{group.title}</span>
                  <small>{group.items.length}</small>
                </div>
                {group.items.map((session) => {
                  const state = sessionUiState(session, activeSessionId, attention, activeJobs);
                  return (
                    <button
                      className={cx("sidebar-session-item", `session-state-${state.kind}`, session.id === activeSessionId && "selected")}
                      disabled={historyLoading}
                      key={session.id}
                      onClick={choose(() => onSelectSession(session.id))}
                      title={`${sessionDisplayTitle(session)} · ${sessionSubtitle(session)} · ${state.detail}`}
                      type="button"
                    >
                      <span className="sidebar-session-dot" />
                      <span>
                        <strong>{sessionDisplayTitle(session)}</strong>
                        <small>
                          {sessionSubtitle(session)}
                          {session.updatedAt ? ` · ${timeLabel(session.updatedAt)}` : ""}
                        </small>
                      </span>
                    </button>
                  );
                })}
              </section>
            ))}
            {hiddenSessionCount > 0 && (
              <button
                className="sidebar-session-more"
                onClick={(event) => {
                  event.stopPropagation();
                  setSessionsExpanded((value) => !value);
                }}
                type="button"
              >
                {sessionsExpanded ? "收起" : `显示更多 ${hiddenSessionCount}`}
              </button>
            )}
          </div>
        )}
      </div>

      <div className="account-card">
        <ShieldCheck size={18} />
        <div>
          <strong>{status.codex.mode}</strong>
          <span>{status.codex.authenticated ? "已登录" : "未登录"}</span>
        </div>
      </div>
    </aside>
  );
}

function ExpandableText({
  text,
  limit = 260,
  className,
}: {
  text?: string | null;
  limit?: number;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const value = String(text || "").trim();
  if (!value) return null;
  const verbose = value.length > limit;
  const visible = !verbose || expanded ? value : `${value.slice(0, Math.max(40, limit - 20)).trimEnd()}...`;
  return (
    <div className="expandable-text">
      <p className={cx(className, verbose && !expanded && "attention-summary-preview")}>{visible}</p>
      {verbose && (
        <button className="text-button compact" type="button" onClick={() => setExpanded((current) => !current)}>
          {expanded ? "收起" : "展开"}
        </button>
      )}
    </div>
  );
}

function sanitizeChatDisplayText(value?: string | null) {
  return String(value || "")
    .replace(/\bINVEST_DASHBOARD_CLOUD_SYNC_TOKEN\s*=\s*[^\s`'"]+/gi, "云端同步 Token=<redacted>")
    .replace(/\bINVEST_DASHBOARD_CLOUD_BASE_URL\s*=\s*[^\s`'"]+/gi, "云端同步地址=<redacted>")
    .replace(/\$?INVEST_DASHBOARD_CLOUD_SYNC_TOKEN\b/gi, "云端同步 Token")
    .replace(/\$?INVEST_DASHBOARD_CLOUD_BASE_URL\b/gi, "云端同步地址")
    .replace(/(?:token|secret|password|api[_-]?key)\s*[:=]\s*[A-Za-z0-9_./+=-]{16,}/gi, (match) => {
      const key = match.split(/[:=]/)[0]?.trim() || "token";
      return `${key}=<redacted>`;
    });
}

function ChatMarkdown({ text, streaming }: { text: string; streaming?: boolean }) {
  const safeText = sanitizeChatDisplayText(text);
  const fallback = (
    <div className="chat-markdown chat-markdown-fallback">
      <p>{safeText}</p>
      {streaming && <span className="stream-cursor" />}
    </div>
  );

  return (
    <Suspense fallback={fallback}>
      <LazyChatMarkdown text={safeText} streaming={streaming} />
    </Suspense>
  );
}

function ChatMessageText({
  text,
  pre,
  streaming,
  limit,
}: {
  text: string;
  pre: boolean;
  streaming?: boolean;
  limit?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const value = sanitizeChatDisplayText(text);
  const maxLength = limit || (pre ? 2200 : 1200);
  const verbose = !streaming && value.length > maxLength;
  const visible = verbose && !expanded ? `${value.slice(0, Math.max(80, maxLength - 20)).trimEnd()}...` : value;
  const cursor = streaming ? <span className="stream-cursor" /> : null;
  return (
    <>
      {pre ? (
        <pre className={cx("timeline-pre", verbose && !expanded && "chat-message-preview", verbose && expanded && "chat-message-expanded")}>
          {visible}
          {cursor}
        </pre>
      ) : (
        <div className={cx(verbose && !expanded && "chat-message-preview")}>
          <ChatMarkdown text={visible} streaming={streaming} />
        </div>
      )}
      {verbose && (
        <button className="text-button compact chat-expand-button" type="button" onClick={() => setExpanded((current) => !current)}>
          {expanded ? "收起" : "展开全文"}
        </button>
      )}
    </>
  );
}

function AttentionRunCard({
  run,
  status,
  onOpenRun,
}: {
  run: AutomationRun;
  status: ConsoleStatus;
  onOpenRun: (run: AutomationRun) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const repo = status.repos.find((item) => item.id === run.repoId);
  const tone = attentionTone(run.status);
  const detailText = displayAutomationText(run.error || run.summary || "");
  const hasVerboseDetail = detailText.length > 260 || Boolean(run.diffStat);
  const visibleDetail = !hasVerboseDetail || expanded ? detailText : `${detailText.slice(0, 240).trimEnd()}...`;
  return (
    <article className={cx("attention-card", `attention-${tone}`)}>
      <div className="attention-card-main">
        <span className="attention-icon">{tone === "active" ? <Loader2 size={15} className="spin" /> : <Activity size={15} />}</span>
        <div>
          <strong>{run.name}</strong>
          <span>
            {repo?.name || run.repoId} · {runStatusLabel(run.status)} · {timeLabel(run.updatedAt)}
          </span>
        </div>
      </div>
      {visibleDetail && <p className={cx(!expanded && "attention-summary-preview", Boolean(run.error) && "warn-text")}>{visibleDetail}</p>}
      {run.diffStat && expanded && <pre>{run.diffStat}</pre>}
      <div className="attention-actions">
        <button className="command-button" type="button" onClick={() => onOpenRun(run)}>
          {run.sessionId ? "打开对话" : "打开任务"}
        </button>
        {hasVerboseDetail && (
          <button className="text-button compact" type="button" onClick={() => setExpanded((value) => !value)}>
            {expanded ? "收起" : "展开"}
          </button>
        )}
        {run.worktreePath && <code>{automationWorktreeLabel(run.worktreePolicy)}</code>}
      </div>
    </article>
  );
}

function attentionIcon(item: AttentionItem) {
  if (item.type === "automation") return item.tone === "active" ? <Loader2 size={15} className="spin" /> : <Activity size={15} />;
  if (item.type === "job") return <Loader2 size={15} className="spin" />;
  if (item.type === "repo") return <GitBranch size={15} />;
  if (item.type === "mcp") return <Sparkles size={15} />;
  if (item.type === "audit") return <ShieldCheck size={15} />;
  if (item.type === "auth") return <ShieldCheck size={15} />;
  return <CheckCircle2 size={15} />;
}

function attentionTypeLabel(type = "") {
  const lower = type.toLowerCase();
  if (lower === "automation") return "自动化";
  if (lower === "job") return "运行任务";
  if (lower === "repo") return "仓库";
  if (lower === "mcp") return "MCP";
  if (lower === "audit") return "审计";
  if (lower === "auth" || lower === "account") return "账户";
  if (lower === "capability") return "能力";
  if (lower === "diagnostics") return "诊断";
  return type || "事件";
}

function displayAutomationText(value?: string | null) {
  const usageLimitText = displayUsageLimitText(value);
  if (usageLimitText) return usageLimitText;
  return String(value || "")
    .replace(/Cloud console proxy error:\s*/gi, "云端控制台代理错误：")
    .replace(/Client network socket disconnected before secure TLS connection was established/gi, "安全连接建立前网络连接中断")
    .replace(/read ECONNRESET/gi, "连接被远端重置")
    .replace(/\[Errno 98\] address already in use/gi, "端口已被占用")
    .replace(/Console restarted while app-server automation was running/gi, "云端控制台重启时，自动化任务仍在运行")
    .replace(/Marked (\d+) stale app-server automation run\(s\) as failed/gi, "已将 $1 条中断的自动化运行标记为失败")
    .replace(/Started Codex app-server automation thread/gi, "已启动云端自动化会话")
    .replace(/app-server automation run started/gi, "云端自动化运行已启动")
    .replace(/app-server automation/gi, "云端自动化")
    .replace(/app-server/gi, "云端 Codex");
}

function displayCommandText(value?: string | null) {
  const text = String(value || "").trim();
  if (!text) return "";
  const compact = text
    .replace(/\s+/g, " ")
    .replace(/^\/bin\/(?:bash|sh)\s+-lc\s*/i, "")
    .trim()
    .replace(/^(['"])([\s\S]*)\1$/, "$2")
    .trim();
  if (/^deployment file chunk$/i.test(compact)) return "部署文件分片同步";
  if (/^deployment file prepare$/i.test(compact)) return "部署文件准备";
  if (/^deployment file sync$/i.test(compact)) return "部署文件写入";
  if (/^sync gap plan document$/i.test(compact)) return "同步方案文档";
  if (/^deploy backend service$/i.test(compact)) return "部署后端服务";
  if (/^deploy frontend bundle$/i.test(compact)) return "部署前端产物";
  if (/^restart cloud console service$/i.test(compact)) return "重启云端控制台服务";
  if (/^check cloud console service$/i.test(compact)) return "检查云端控制台服务";
  if (/^frontend build$/i.test(compact)) return "前端构建";
  if (/^schema check$/i.test(compact)) return "云端协议 schema 检查";
  if (/^server syntax check$/i.test(compact)) return "服务端语法检查";
  if (/^health check$/i.test(compact)) return "健康检查";
  if (/^inspect git diff$/i.test(compact)) return "查看 Git 改动";
  if (/^inspect git status$/i.test(compact)) return "检查仓库状态";
  if (/^inspect data files$/i.test(compact)) return "查看数据文件";
  if (/^inspect data directory$/i.test(compact)) return "查看数据目录";
  if (/^run project CLI$/i.test(compact)) return "运行项目 CLI";
  if (/^cloud sync configuration check$/i.test(compact)) return "检查云端同步配置";
  if (/^shell profile inspection$/i.test(compact)) return "读取 Shell 配置";
  const deployBlob = /(?:\.deploy\.b64|\/tmp\/codex-cloud-[\w.-]*\.b64)/i.test(compact);
  const gapPlanBlob = /codex-cloud-gap-plan\.md\.b64|docs\/research\/codex-cloud-gap-plan\.md/i.test(compact);
  const uiBlob = /codex-cloud-ui-(?:deploy|chunk)|dist\/assets|src\/App\.tsx/i.test(compact);
  const serverBlob = /codex-cloud-(?:server-deploy|index\.mjs)|server\/index\.mjs/i.test(compact);
  if (deployBlob && /:\s*>/i.test(compact)) return "部署文件准备";
  if (deployBlob && /cat\s*>>/i.test(compact)) return "部署文件分片同步";
  if (gapPlanBlob && /base64\s+-d/i.test(compact)) return "同步方案文档";
  if (serverBlob && /base64\s+-d/i.test(compact)) return "部署后端服务";
  if (uiBlob && /base64\s+-d/i.test(compact)) return "部署前端产物";
  if (deployBlob && /base64\s+-d/i.test(compact)) return "部署文件写入";
  if (/systemctl\s+restart\s+codex-cloud-console\.service/i.test(compact)) return "重启云端控制台服务";
  if (/systemctl\s+is-active\s+codex-cloud-console\.service/i.test(compact)) return "检查云端控制台服务";
  if (/npm\s+run\s+build/i.test(compact)) return "前端构建";
  if (/codex:schema:check/i.test(compact)) return "云端协议 schema 检查";
  if (/node\s+--check/i.test(compact)) return "服务端语法检查";
  if (/curl\s+-sS.*\/healthz/i.test(compact)) return "健康检查";
  if (/INVEST_DASHBOARD_CLOUD_(SYNC_TOKEN|BASE_URL)/i.test(compact)) return "检查云端同步配置";
  if (/~\/\.(?:bash_profile|bash_login|profile)/i.test(compact)) return "读取 Shell 配置";
  if (/git\s+diff\b/i.test(compact)) return "查看 Git 改动";
  if (/git\s+check-ignore\b|git\s+status/i.test(compact)) return "检查仓库状态";
  if (/git\s+(fetch|pull)/i.test(compact)) return "同步 Git 仓库";
  if (/\bfind\s+data\b/i.test(compact)) return "查看数据文件";
  if (/\bls\s+-la\s+data\b/i.test(compact)) return "查看数据目录";
  if (/invest_dashboard\.cli\b/i.test(compact)) return "运行项目 CLI";
  if (/^python3?\s+-m\s+json\.tool\b/i.test(compact)) return "查看 JSON 数据";
  if (/^python3?\b/i.test(compact)) return "运行 Python 脚本";
  if (/^rg\b/i.test(compact)) return "搜索代码";
  if (/^sqlite3\b/i.test(compact)) return "查询本地数据库";
  if (compact.length > 180) return `${displayAutomationText(compact.slice(0, 170)).trimEnd()}...`;
  return displayAutomationText(compact);
}

function displayWorktreePath(value?: string | null) {
  const text = String(value || "").trim();
  if (!text) return "";
  const worktreeMatch = text.match(/\/worktrees\/([^/\s]+)/);
  if (worktreeMatch?.[1]) return "隔离工作区";
  const workspaceMatch = text.match(/\/workspace\/([^/\s]+)/);
  if (workspaceMatch?.[1]) return `项目工作区 · ${workspaceMatch[1]}`;
  if (text === "/home/ubuntu/codex-cloud" || text === "/home/ubuntu/codex-cloud/") return "云端工作区";
  if (text.startsWith("/home/ubuntu/codex-cloud/")) return "云端工作区";
  return displayAutomationText(text);
}

function displayRunEventText(event: AutomationRun["events"][number]) {
  const type = String(event.type || "").trim();
  const rawText = String(event.text || "").trim();
  const normalizedType = type.replace(/[\s_-]+/g, "").toLowerCase();
  const normalizedText = displayProjectMessageText(rawText.replace(/\s+/g, " ").trim());
  if (!normalizedText) {
    if (normalizedType === "tokenusage") return "上下文已更新";
    if (normalizedType === "done") return "自动化已完成";
    if (normalizedType === "status") return "状态已更新";
    return attentionTypeLabel(type);
  }
  if (/^tool:\s*processExited$/i.test(normalizedText)) return "命令已结束";
  if (/^tool:\s*terminalInteraction$/i.test(normalizedText)) return "终端交互";
  if (/^tool:\s*commandOutput$/i.test(normalizedText)) return "命令输出";
  if (/^command exited$/i.test(normalizedText)) return "命令已结束";
  if (/^terminal interaction$/i.test(normalizedText)) return "终端交互";
  if (/^command output$/i.test(normalizedText)) return "命令输出";
  if (/^tool:/i.test(normalizedText)) return `工具调用：${displayAutomationText(normalizedText.replace(/^tool:\s*/i, ""))}`;
  if (/^tokenUsage\b/i.test(normalizedText) || /^context usage updated$/i.test(normalizedText) || normalizedType === "tokenusage") return "上下文已更新";
  if (/^thread\s+状态:\s*idle$/i.test(normalizedText)) return "会话已空闲";
  if (/^thread idle$/i.test(normalizedText)) return "会话已空闲";
  if (/^thread\s+状态:\s*running$/i.test(normalizedText)) return "会话正在运行";
  if (/^worktree[:：]\s*Created worktree\b/i.test(normalizedText)) return "已创建隔离工作区";
  if (/^thread[:：]\s*/i.test(normalizedText)) return displayAutomationText(normalizedText.replace(/^thread[:：]\s*/i, "会话："));
  if (/^session[:：]\s*session\b/i.test(normalizedText)) return "云端会话已建立";
  if (/^error[:：]\s*Skill descriptions were shortened/i.test(normalizedText)) return "Skills 描述已压缩以节省上下文";
  if (/^(done|Automation completed|automation completed)$/i.test(normalizedText)) return "自动化已完成";
  const commandRun = normalizedText.match(/^(?:运行命令|command):\s*([\s\S]+)$/i);
  if (commandRun?.[1]) return `运行命令：${displayCommandText(commandRun[1])}`;
  if (/INVEST_DASHBOARD_CLOUD_(SYNC_TOKEN|BASE_URL)/i.test(normalizedText)) return "运行命令：检查云端同步配置";
  if (/^interrupted\b/i.test(normalizedText)) return displayAutomationText(normalizedText.replace(/^interrupted:\s*/i, "任务已中断："));
  if (/^status:\s*/i.test(normalizedText)) return displayAutomationText(normalizedText.replace(/^status:\s*/i, ""));
  return displayAutomationText(normalizedText);
}

function displayRunEventLine(event: AutomationRun["events"][number]) {
  const type = String(event.type || "").trim().replace(/[\s_-]+/g, "").toLowerCase();
  const text = displayRunEventText(event);
  if (type === "done" || type === "tokenusage" || type === "status" || type === "tool" || type === "interrupted") {
    return `${timeLabel(event.time)} ${text}`;
  }
  return `${timeLabel(event.time)} ${attentionTypeLabel(event.type)}：${text}`;
}

function displayLogLine(value?: string | null) {
  const text = String(value || "").trim();
  if (!text) return "";
  const eventDone = text.match(/^\[[^\]]+\]\s+event=done\s+([\s\S]+)$/i);
  if (eventDone?.[1]) return `运行完成：${displayRunEventText({ time: new Date().toISOString(), type: "done", text: eventDone[1] })}`;
  const finished = text.match(/^\[[^\]]+\]\s+finished(?:\s+job=[^\s]+)?\s+status=([A-Za-z_-]+)/i);
  if (finished?.[1]) return `运行结束：${runStatusLabel(finished[1])}`;
  const error = text.match(/^\[[^\]]+\]\s+error(?:\[[^\]]+\])?=([\s\S]+)$/i);
  if (error?.[1]) {
    const message = error[1].trim();
    if (/Unknown automation/i.test(message)) return "错误：自动化任务不存在或已被移除";
    if (/fetch failed/i.test(message)) return "错误：网络请求失败";
    return `错误：${displayCapabilityText(message)}`;
  }
  if (/^Unknown automation$/i.test(text)) return "自动化任务不存在或已被移除";
  if (/^Automation completed$/i.test(text)) return "自动化已完成";
  if (/^Automation failed$/i.test(text)) return "自动化失败";
  if (/^codex exec completed$/i.test(text)) return "Codex 运行已完成";
  if (/^Timer waiting for next run$/i.test(text)) return "定时器等待下一次运行";
  if (/^CLOUD_PULL_DONE$/i.test(text)) return "云端拉取完成";
  if (/^No log file found for this automation\\.?$/i.test(text)) return "暂无自动化日志";
  if (/You've hit your usage limit/i.test(text)) return displayCapabilityText(text);
  return displayCapabilityText(displayAutomationText(text));
}

function displayLogTail(lines?: string[] | null) {
  return (lines || []).map(displayLogLine).filter(Boolean).join("\n");
}

function displayLiveEventTitle(event?: { title?: string | null; type?: string | null } | null) {
  if (!event) return "暂无最新通知";
  const title = displayCapabilityText(event.title || event.type || "");
  const appList = title.match(/^App 列表已更新:\s*(\d+)/i);
  if (appList) return `App 列表已更新 · ${appList[1]} 个`;
  const mcpStartup = title.match(/^MCP\s+([^:：]+)[:：]\s*(\w+)/i);
  if (mcpStartup) return `MCP ${mcpStartup[1]} · ${runStatusLabel(mcpStartup[2])}`;
  if (/apps?\s+changed/i.test(title)) return "App 列表已更新";
  if (/skills?\s+changed/i.test(title)) return "Skills 元数据已变更";
  if (/remote\s+control/i.test(title)) return "远端控制状态已更新";
  return title.replace(/\bapp-server\b/gi, "云端 Codex");
}

function displayLiveEventBody(event?: { body?: string | null } | null) {
  if (!event?.body) return "";
  return displayCapabilityText(event.body)
    .replace(/连接器\/App 列表已由\s*云端 Codex\s*推送更新。/g, "连接器列表已由云端更新。")
    .replace(/app-server/gi, "云端 Codex");
}

function displayLiveEventLine(event: { title?: string | null; type?: string | null; body?: string | null; time: string }) {
  const title = displayLiveEventTitle(event);
  const body = displayLiveEventBody(event);
  return `${title}${body ? ` · ${body}` : ""} · ${timeLabel(event.time)}`;
}

function diagnosticToneLabel(value?: string | null) {
  const tone = String(value || "").toLowerCase();
  if (tone === "ok") return "正常";
  if (tone === "warn") return "提醒";
  if (tone === "danger") return "问题";
  if (tone === "active") return "运行中";
  return value || "未知";
}

function diagnosticCheckLabel(check: CodexDiagnostics["checks"][number]) {
  const id = String(check.id || "");
  const labels: Record<string, string> = {
    "codex-version": "Codex CLI",
    "codex-auth": "Codex 账号",
    "schema-drift": "云端协议 schema",
    "app-server-capabilities": "云端能力探测",
    "thread-list": "会话列表事实源",
  };
  if (labels[id]) return labels[id];
  if (id.startsWith("gap-")) return "已知能力差异";
  return displayDiagnosticText(check.label || id);
}

function displayDiagnosticText(value?: string | null) {
  return displayCapabilityText(value)
    .replace(/Codex auth/gi, "Codex 账号")
    .replace(/App-server schema/gi, "云端协议 schema")
    .replace(/App-server capabilities/gi, "云端能力探测")
    .replace(/Known app gap/gi, "已知能力差异")
    .replace(/Thread list\/read source/gi, "会话列表事实源")
    .replace(/codex version available/gi, "Codex CLI 可用")
    .replace(/Codex app-server schema is up to date\./gi, "云端协议 schema 已是最新。")
    .replace(/Codex app-server schema is out of date\./gi, "云端协议 schema 已过期。")
    .replace(/Run `npm run codex:schema` to refresh\./gi, "运行 npm run codex:schema 刷新。")
    .replace(/(\d+) 个 app-server capability probe 失败/gi, "$1 个云端能力探测失败")
    .replace(/config\/model\/MCP\/plugin\/skills\/permissions\/provider probes 均通过/gi, "配置、模型、MCP、插件、Skills、权限和模型能力均可读取")
    .replace(/当前项目可读取 (\d+) 条 app-server thread/gi, "当前项目可读取 $1 条云端会话")
    .replace(/无法读取 app-server thread\/list/gi, "无法读取云端会话列表")
    .replace(/\bthread\b/gi, "会话")
    .replace(/\bok\b/g, "正常")
    .replace(/\bwarn\b/g, "提醒")
    .replace(/\bdanger\b/g, "问题");
}

function safeExternalActionUrl(value?: string | null) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function AttentionItemCard({
  item,
  run,
  onOpenRun,
  onOpenThread,
  onOpenRepo,
  onOpenAutomations,
  onOpenLogs,
  onOpenSettings,
  onCodexLogin,
  onMcpLogin,
  onAcknowledge,
  attentionBusy,
}: {
  item: AttentionItem;
  run?: AutomationRun;
  onOpenRun: (run: AutomationRun) => void;
  onOpenThread: (repoId: string, sessionId: string) => void;
  onOpenRepo: (repoId: string) => void;
  onOpenAutomations: () => void;
  onOpenLogs: () => void;
  onOpenSettings: () => void;
  onCodexLogin: () => void;
  onMcpLogin: (serverName: string) => void;
  onAcknowledge: (itemIds?: string[], all?: boolean) => void;
  attentionBusy: string | null;
}) {
  const tone = item.tone === "danger" ? "danger" : item.tone === "active" ? "active" : "neutral";
  const targetRepoId = item.repoId || run?.repoId || "";
  const targetSessionId = item.threadId || item.sessionId || run?.threadId || run?.sessionId || "";
  const targetMcpServer = item.serverName || item.id.replace(/^mcp-auth:/, "");
  const externalActionUrl = safeExternalActionUrl(item.actionUrl);
  const itemBodyText = displayCapabilityText(item.body);
  const itemBodyIsUsageLimit = Boolean(displayUsageLimitText(item.body));
  const runErrorText = displayCapabilityText(run?.error);
  const runErrorIsUsageLimit = Boolean(displayUsageLimitText(run?.error));
  const runSummaryText = displayCapabilityText(run?.summary);
  const showRunError = Boolean(runErrorText && run?.error !== item.body && !(itemBodyIsUsageLimit && runErrorIsUsageLimit));
  const showRunSummary = Boolean(runSummaryText && run?.summary !== item.body && runSummaryText !== itemBodyText);
  const action =
    externalActionUrl
      ? { label: item.actionLabel || "打开", run: () => window.open(externalActionUrl, "_blank", "noopener,noreferrer") }
      : item.action === "codex-login"
      ? { label: "重新登录", run: onCodexLogin }
      : item.action === "mcp-login" && targetMcpServer
        ? { label: "登录 MCP", run: () => onMcpLogin(targetMcpServer) }
        : item.action === "thread" && targetRepoId && targetSessionId
      ? { label: "打开对话", run: () => onOpenThread(targetRepoId, targetSessionId) }
      : item.action === "thread" && run
      ? { label: run.sessionId ? "打开对话" : "打开任务", run: () => onOpenRun(run) }
      : item.action === "repo" && item.repoId
        ? { label: "进入项目", run: () => onOpenRepo(item.repoId || "") }
        : item.action === "automation"
          ? { label: "自动化", run: onOpenAutomations }
          : item.action === "logs"
            ? { label: "查看日志", run: onOpenLogs }
            : item.action === "settings"
              ? { label: "打开设置", run: onOpenSettings }
              : null;
  return (
    <article className={cx("attention-card", "attention-flow-item", `attention-${tone}`, item.acknowledged && "acknowledged")}>
      <div className="attention-card-main">
        <span className="attention-icon">{attentionIcon(item)}</span>
        <div>
          <strong>{displayCapabilityText(item.title)}</strong>
          <span>
            {attentionTypeLabel(item.type)}
            {item.repoId ? ` · ${item.repoId}` : ""}
            {item.time ? ` · ${timeLabel(item.time)}` : ""}
            {item.acknowledgedAt ? ` · 已读 ${timeLabel(item.acknowledgedAt)}` : ""}
          </span>
        </div>
      </div>
      <ExpandableText text={itemBodyText} limit={260} />
      {showRunError && <ExpandableText text={runErrorText} limit={260} className="warn-text" />}
      {showRunSummary && <ExpandableText text={runSummaryText} limit={260} />}
      <div className="attention-actions">
        {action && (
          <button
            className="command-button"
            type="button"
            data-action-kind={item.action}
            data-target-repo={targetRepoId || undefined}
            data-target-session={targetSessionId || undefined}
            data-target-server={item.action === "mcp-login" ? targetMcpServer : undefined}
            data-action-url={externalActionUrl || undefined}
            onClick={action.run}
          >
            {action.label}
          </button>
        )}
        {item.tone !== "neutral" && (
          <button
            className="text-button compact"
            type="button"
            onClick={() => onAcknowledge([item.id])}
            disabled={Boolean(item.acknowledged) || Boolean(attentionBusy)}
          >
            {attentionBusy === item.id ? "处理中" : item.acknowledged ? "已读" : "标记已读"}
          </button>
        )}
        {run?.worktreePolicy && <code>{automationWorktreeLabel(run.worktreePolicy)}</code>}
        {item.threadId && <code>会话 {item.threadId.slice(0, 8)}</code>}
      </div>
    </article>
  );
}

function AttentionView({
  status,
  statusReady,
  notificationsEnabled,
  notificationPermission,
  onOpenRun,
  onOpenThread,
  onOpenRepo,
  onOpenAutomations,
  onOpenLogs,
  onOpenSettings,
  onCodexLogin,
  onMcpLogin,
  onToggleNotifications,
  onAcknowledge,
  onClearResolved,
  attentionBusy,
}: {
  status: ConsoleStatus;
  statusReady: boolean;
  notificationsEnabled: boolean;
  notificationPermission: string;
  onOpenRun: (run: AutomationRun) => void;
  onOpenThread: (repoId: string, sessionId: string) => void;
  onOpenRepo: (repoId: string) => void;
  onOpenAutomations: () => void;
  onOpenLogs: () => void;
  onOpenSettings: () => void;
  onCodexLogin: () => void;
  onMcpLogin: (serverName: string) => void;
  onToggleNotifications: () => void;
  onAcknowledge: (itemIds?: string[], all?: boolean) => void;
  onClearResolved: () => void;
  attentionBusy: string | null;
}) {
  const inbox = status.automationInbox || { needsAttention: [], active: [], recent: [], archived: [] };
  const attention = getAttentionSummary(status);
  const attentionLoaded = statusReady || Boolean(status.attention);
  const allRuns = [...inbox.needsAttention, ...inbox.active, ...inbox.recent, ...inbox.archived, ...(status.automationRuns || [])];
  const dirtyRepos = status.repos.filter((repo) => repo.dirty);
  const feedItems = !attentionLoaded
    ? []
    : attention.items.length
    ? attention.items.filter((item) => item.tone !== "neutral")
    : [
        ...inbox.needsAttention.map((run) => ({
          id: `automation:${run.id}`,
          type: "automation",
          tone: "danger",
          title: run.name,
          body: run.error || run.summary || "",
          time: run.updatedAt,
          repoId: run.repoId,
          automationId: run.automationId,
          runId: run.id,
          sessionId: run.sessionId,
          threadId: run.threadId,
          action: "thread",
        })),
      ] as AttentionItem[];
  const recentRuns = attentionLoaded ? [...inbox.active, ...inbox.recent].slice(0, 5) : [];
  const unreadCount = attentionLoaded ? attention.unreadCount ?? attention.count : 0;
  const acknowledgedCount = attentionLoaded ? attention.acknowledgedCount || 0 : 0;
  const accountAndCapabilityCount = attentionLoaded ? feedItems.filter((item) => ["account", "auth", "mcp", "capability", "diagnostics"].includes(item.type)).length : 0;
  const runningItemCount = attentionLoaded ? feedItems.filter((item) => item.type === "job" || (item.type === "automation" && item.tone === "active")).length : 0;
  const calm = attentionLoaded && feedItems.length === 0;
  const firstActiveJobTarget = (status.activeJobs || []).reduce<ReturnType<typeof activeJobOpenTarget>>(
    (target, job) => target || activeJobOpenTarget(job),
    null,
  );
  const scrollToNextActions = () => document.querySelector(".attention-feed")?.scrollIntoView({ behavior: "smooth", block: "start" });
  const summaryActions = [
    {
      id: "unread",
      label: "未读",
      value: attentionLoaded ? unreadCount : "...",
      tone: unreadCount ? "warn" : "ok",
      run: scrollToNextActions,
      disabled: !attentionLoaded || feedItems.length === 0,
    },
    {
      id: "active",
      label: "运行中",
      value: attentionLoaded ? runningItemCount : "...",
      tone: runningItemCount ? "active" : "neutral",
      run: () => {
        if (firstActiveJobTarget) onOpenThread(firstActiveJobTarget.repoId, firstActiveJobTarget.sessionId);
        else onOpenAutomations();
      },
      disabled: !attentionLoaded || runningItemCount === 0,
    },
    {
      id: "capabilities",
      label: "账户",
      value: attentionLoaded ? accountAndCapabilityCount : "...",
      tone: accountAndCapabilityCount ? "warn" : "neutral",
      run: onOpenSettings,
      disabled: !attentionLoaded || accountAndCapabilityCount === 0,
    },
    {
      id: "dirty",
      label: "改动",
      value: attentionLoaded ? attention.dirtyRepoCount : "...",
      tone: attentionLoaded && attention.dirtyRepoCount ? "warn" : "neutral",
      run: () => dirtyRepos[0] && onOpenRepo(dirtyRepos[0].id),
      disabled: !attentionLoaded || !dirtyRepos.length,
    },
  ];

  return (
    <section className="attention-panel wide-panel">
      <div className="thread-header">
        <div className="thread-title">
          <div className="thread-avatar">
            <CheckCircle2 size={19} />
          </div>
          <div>
            <p className="eyebrow">收件箱</p>
            <h2>需要关注</h2>
            <div className="attention-summary-strip" aria-label="活动摘要">
              {summaryActions.map((item) => (
                <button
                  key={item.id}
                  className={cx("attention-summary-chip", item.tone)}
                  type="button"
                  onClick={item.run}
                  disabled={item.disabled}
                >
                  <strong>{item.value}</strong>
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="attention-header-actions">
          {attentionLoaded && unreadCount > 0 && (
            <button
              className="command-button"
              type="button"
              onClick={() => onAcknowledge([], true)}
              disabled={Boolean(attentionBusy)}
            >
              <CheckCircle2 size={16} />
              全部已读
            </button>
          )}
          <details className="attention-actions-menu">
            <summary>
              <SlidersHorizontal size={16} />
              操作
            </summary>
            <div>
              <button className={cx("command-button", notificationsEnabled && "active-command")} type="button" onClick={onToggleNotifications}>
                <Bell size={16} />
                {notificationLabel(notificationsEnabled, notificationPermission)}
              </button>
              <button className={cx("command-button", status.externalNotifications?.configured && "active-command")} type="button" onClick={onOpenSettings}>
                <Globe2 size={16} />
                {status.externalNotifications?.configured ? "外部通知开" : "外部通知未配"}
              </button>
              <button className="command-button" type="button" onClick={onClearResolved} disabled={acknowledgedCount === 0 || Boolean(attentionBusy)}>
                <Trash2 size={16} />
                清理已解决
              </button>
              <button className="command-button" type="button" onClick={onOpenAutomations}>
                <Activity size={16} />
                自动化
              </button>
            </div>
          </details>
        </div>
      </div>

      {calm && (
        <div className="attention-empty">
          <CheckCircle2 size={18} />
          <div>
            <strong>收件箱已清理</strong>
            <span>云端 Codex 当前平稳。</span>
          </div>
        </div>
      )}

      <div className="attention-workflow">
        <section className="attention-feed">
          <div className="mini-header">
            <div>
              <p className="eyebrow">待处理</p>
              <h3>下一步</h3>
            </div>
            <span className={cx("run-badge", unreadCount ? "warn" : "ok")}>{attentionLoaded ? `${unreadCount} 条` : "同步中"}</span>
          </div>
          {feedItems.slice(0, 12).map((item) => (
            <AttentionItemCard
              item={item}
              key={item.id}
              run={allRuns.find((run) => run.id === item.runId || run.sessionId === item.sessionId || run.threadId === item.threadId)}
              onOpenRun={onOpenRun}
              onOpenThread={onOpenThread}
              onOpenRepo={onOpenRepo}
              onOpenAutomations={onOpenAutomations}
              onOpenLogs={onOpenLogs}
              onOpenSettings={onOpenSettings}
              onCodexLogin={onCodexLogin}
              onMcpLogin={onMcpLogin}
              onAcknowledge={onAcknowledge}
              attentionBusy={attentionBusy}
            />
          ))}
          {!attentionLoaded && <p className="empty-copy">同步收件箱中。</p>}
          {attentionLoaded && feedItems.length === 0 && <p className="empty-copy">没有待处理事项。</p>}
        </section>

        <section className="attention-side">
          <details className="attention-disclosure">
            <summary>
              <span>最近任务</span>
              <small>{recentRuns.length} 条</small>
            </summary>
            <div className="attention-disclosure-body">
            {recentRuns.map((run) => (
              <AttentionRunCard key={run.id} run={run} status={status} onOpenRun={onOpenRun} />
            ))}
            {!recentRuns.length && <p className="empty-copy">还没有最近任务。</p>}
            </div>
          </details>

          <details className="attention-disclosure">
            <summary>
              <span>项目状态</span>
              <small>{dirtyRepos.length ? `${dirtyRepos.length} 个有改动` : "工作区干净"}</small>
            </summary>
            <div className="attention-disclosure-body">
            {dirtyRepos.slice(0, 5).map((repo) => (
              <article className="attention-card attention-neutral" key={repo.id}>
                <div className="attention-card-main">
                  <span className="attention-icon">
                    <GitBranch size={15} />
                  </span>
                  <div>
                    <strong>{repo.name}</strong>
                    <span>{repo.branch} · {repo.commit}</span>
                  </div>
                </div>
                <ExpandableText text={repo.statusText || repo.lastCommit} limit={180} />
                <button className="text-button compact" type="button" onClick={() => onOpenRepo(repo.id)}>
                  进入项目
                </button>
              </article>
            ))}
            {!dirtyRepos.length && <p className="empty-copy">所有项目工作区干净。</p>}
            </div>
          </details>

          {acknowledgedCount > 0 && (
            <button className="text-button compact attention-clear-inline" type="button" onClick={onClearResolved} disabled={Boolean(attentionBusy)}>
              清理 {acknowledgedCount} 条已读记录
            </button>
          )}
        </section>
      </div>
    </section>
  );
}

function PanelTitle({
  title,
  eyebrow,
  onRefresh,
  spinning,
}: {
  title: string;
  eyebrow: string;
  onRefresh: () => void;
  spinning: boolean;
}) {
  return (
    <div className="panel-header">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
      </div>
      <button className="icon-button" onClick={onRefresh} aria-label="刷新状态">
        <RefreshCw size={18} className={cx(spinning && "spin")} />
      </button>
    </div>
  );
}

function TopBar({
  status,
  activeView,
  cloudConnection,
  isRefreshing,
  onRefresh,
  onOpenSidebar,
  query,
  setQuery,
  searchResults,
  searchLoading,
  onSearchSelect,
}: {
  status: ConsoleStatus;
  activeView: ActiveView;
  cloudConnection: CloudConnection;
  isRefreshing: boolean;
  onRefresh: () => void;
  onOpenSidebar: () => void;
  query: string;
  setQuery: (value: string) => void;
  searchResults: GlobalSearchResult[];
  searchLoading: boolean;
  onSearchSelect: (result: GlobalSearchResult) => void;
}) {
  const connection = connectionState(status, cloudConnection);
  const placeholder = activeView === "cli" ? "搜索对话、项目、服务" : "搜索任务、项目、服务";
  const [searchIndex, setSearchIndex] = useState(0);
  const searchOpen = Boolean(query.trim());
  useEffect(() => {
    setSearchIndex(0);
  }, [query, searchResults.length]);
  const chooseSearch = (index = searchIndex) => {
    const result = searchResults[index];
    if (result) onSearchSelect(result);
  };
  return (
    <header className={cx("topbar", activeView === "cli" && "topbar-session")}>
      <button className="icon-command mobile-menu-button" onClick={onOpenSidebar} aria-label="打开侧边栏" type="button">
        <Menu size={18} />
      </button>
      <div className="search-area">
        <div className="search-box">
          <Search size={17} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (!searchOpen) return;
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setSearchIndex((current) => Math.min(current + 1, Math.max(searchResults.length - 1, 0)));
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setSearchIndex((current) => Math.max(current - 1, 0));
              }
              if (event.key === "Enter") {
                event.preventDefault();
                chooseSearch();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setQuery("");
              }
            }}
            placeholder={placeholder}
          />
        </div>
        {searchOpen && (
          <div className="global-search-popover" onMouseDown={(event) => event.preventDefault()}>
            <div className="global-search-head">
              <strong>快速打开</strong>
              <small>Enter 选择，Esc 关闭</small>
            </div>
            {searchResults.map((result, index) => (
              <button
                key={result.id}
                className={cx(index === searchIndex && "selected")}
                onClick={() => chooseSearch(index)}
                type="button"
              >
                <span className="search-result-icon">{searchResultIcon(result.kind)}</span>
                <span>
                  <strong>{result.label}</strong>
                  <small>{result.hint}</small>
                </span>
              </button>
            ))}
            {searchLoading && <p className="empty-copy">正在搜索云端会话...</p>}
            {!searchLoading && searchResults.length === 0 && <p className="empty-copy">没有匹配的项目、会话或任务。</p>}
          </div>
        )}
      </div>

      <div className="topbar-actions">
        {activeView !== "cli" && (
          <>
            <span className={cx("status-pill", connection.tone)} title={connection.detail}>
              <Wifi size={15} />
              {connection.label}
            </span>
            <span className="status-pill">
              <Cloud size={15} />
              {status.instance.region}
            </span>
          </>
        )}
        <button className="text-button" onClick={onRefresh}>
          <RefreshCw size={16} className={cx(isRefreshing && "spin")} />
          刷新
        </button>
      </div>
    </header>
  );
}

function searchResultIcon(kind: GlobalSearchResult["kind"]) {
  if (kind === "project") return <FolderOpen size={15} />;
  if (kind === "session") return <MessageSquare size={15} />;
  if (kind === "automation") return <Activity size={15} />;
  if (kind === "log") return <History size={15} />;
  return <Command size={15} />;
}

function AutomationRow({
  automation,
  repo,
  selected,
  onSelect,
}: {
  automation: Automation;
  repo?: Repo;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button className={cx("automation-row", selected && "selected")} onClick={onSelect}>
      <span className={cx("run-dot", automation.enabled ? "ok" : "muted")}>
        {automation.enabled ? <CheckCircle2 size={17} /> : <Circle size={17} />}
      </span>
      <span className="automation-copy">
        <strong>{automation.name}</strong>
        <small>
          {repo?.name || automation.repoId} · {automation.model} · {reasoningLabel(automation.reasoning)}
        </small>
      </span>
      <span className="next-run">
        <Timer size={15} />
        {displayHumanDateTime(automation.nextRun)}
      </span>
    </button>
  );
}

function RunThread({
  status,
  automation,
  repo,
  runs,
  events,
  busyAction,
  onRun,
  onOpenRun,
  onPause,
  onPull,
  onOpenLog,
}: {
  status: ConsoleStatus;
  automation: Automation;
  repo: Repo;
  runs: AutomationRun[];
  events: RunEvent[];
  busyAction: string | null;
  onRun: () => void;
  onOpenRun: (run: AutomationRun) => void;
  onPause: () => void;
  onPull: () => void;
  onOpenLog: (name: string) => void;
}) {
  const actionBusy = (prefix: string) => busyAction?.startsWith(prefix);

  return (
    <div className="thread-surface">
      <div className="thread-header">
        <div className="thread-title">
          <div className="thread-avatar">
            <Sparkles size={19} />
          </div>
          <div>
            <p className="eyebrow">自动化会话</p>
            <h2>{automation.name}</h2>
          </div>
        </div>
        <div className="thread-actions">
          <button className="command-button" onClick={onPull} disabled={Boolean(busyAction)}>
            {actionBusy("pull") ? <Loader2 size={17} className="spin" /> : <GitPullRequestArrow size={17} />}
            同步
          </button>
          <button className="command-button" onClick={onPause} disabled={Boolean(busyAction)}>
            {actionBusy("pause") ? <Loader2 size={17} className="spin" /> : <Pause size={17} />}
            {automation.enabled ? "暂停" : "恢复"}
          </button>
          <button className="primary-command" onClick={onRun} disabled={Boolean(busyAction)}>
            {actionBusy("run") ? <Loader2 size={17} className="spin" /> : <Play size={17} />}
            Codex 运行
          </button>
        </div>
      </div>

      <div className="automation-brief">
        <span className={cx("run-badge", automation.enabled ? "ok" : "warn")}>
          {automation.enabled ? "启用" : "暂停"}
        </span>
        <span>{automation.model} · {reasoningLabel(automation.reasoning)}</span>
        <span>{automation.schedule}</span>
      </div>

      <div className="task-grid automation-task-grid">
        <Metric label="后台任务" value="系统定时器已配置" icon={<Terminal size={16} />} />
        <Metric label="仓库" value={repo.name} icon={<GitBranch size={16} />} />
        <Metric label="运行方式" value="云端 Codex · 隔离工作区" icon={<Bot size={16} />} />
        <Metric label="下次运行" value={displayHumanDateTime(automation.nextRun)} icon={<Timer size={16} />} />
      </div>

      <AutomationRunsPanel runs={runs} onOpenRun={onOpenRun} />
      <AutomationWebhookPanel automation={automation} status={status} />
      <RunLogPanel automation={automation} onOpenLog={onOpenLog} />

      <div className="conversation">
        <Message tone="info" title="云端 Codex" body={`工作区 ${displayWorktreePath(repo.path) || repo.name}`} />
        <Message
          tone={automation.enabled ? "ok" : "warn"}
          title={automation.enabled ? "定时器已启用" : "定时器已暂停"}
          body={`系统定时器 · ${automation.schedule}`}
        />
        {events.map((event) => (
          <Message key={event.id} title={`${displayLiveEventTitle(event)} · ${timeLabel(event.time)}`} tone={event.tone} body={displayLiveEventBody(event)} />
        ))}
      </div>
    </div>
  );
}

function runStatusTone(status: string) {
  if (["failed", "blocked", "cancelled"].includes(status)) return "warn";
  if (["queued", "running"].includes(status)) return "active";
  if (status === "archived") return "neutral";
  return "ok";
}

function AutomationRunsPanel({ runs, onOpenRun }: { runs: AutomationRun[]; onOpenRun: (run: AutomationRun) => void }) {
  return (
    <section className="automation-runs-panel">
      <div className="run-log-header">
        <div>
          <p className="eyebrow">运行记录</p>
          <h3>任务运行</h3>
        </div>
        <span className="run-badge ok">隔离工作区</span>
      </div>
      {runs.length === 0 ? (
        <p className="muted-line">还没有云端自动化运行记录。</p>
      ) : (
        <div className="automation-run-list">
          {runs.map((run) => (
            <article className="automation-run-item" key={run.id}>
              <div className="automation-run-head">
                <span className={cx("run-badge", runStatusTone(run.status))}>{runStatusLabel(run.status)}</span>
                <strong>{automationRunnerLabel(run.runner)}</strong>
                <small>{timeLabel(run.updatedAt)}</small>
              </div>
              <div className="automation-run-meta">
                <span>{automationTriggerLabel(run.trigger)}</span>
                <span title={run.threadId || undefined}>{run.threadId ? "已关联会话" : "会话待建立"}</span>
                <span>{automationWorktreeLabel(run.worktreePolicy)}</span>
                {run.diffStat && <span>有 diff</span>}
              </div>
              <ExpandableText text={displayAutomationText(run.error)} limit={220} className="warn-text" />
              <ExpandableText text={displayAutomationText(run.summary)} limit={220} />
              {run.events.length > 0 && <small className="muted-line">{displayRunEventText(run.events[run.events.length - 1])}</small>}
              <div className="automation-run-actions">
                <button className="text-button compact" type="button" onClick={() => onOpenRun(run)} disabled={!run.sessionId}>
                  <MessageSquare size={14} />
                  打开会话
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function AutomationWebhookPanel({ automation, status }: { automation: Automation; status: ConsoleStatus }) {
  const [copied, setCopied] = useState("");
  const [guide, setGuide] = useState<"curl" | "systemd" | "github" | "cloudflare">("curl");
  const [openSnippet, setOpenSnippet] = useState("");
  const [wizardOpen, setWizardOpen] = useState(false);
  const origin = status.publicConfig?.publicOrigin || `https://${status.instance.publicIp}.sslip.io`;
  const webhookConfigured = Boolean(status.publicConfig?.webhook.tokenConfigured);
  const webhookUrl = `${origin}/api/automations/${automation.id}/webhook`;
  const heartbeatUrl = `${origin}/api/automations/${automation.id}/heartbeat`;
  const payload = JSON.stringify({ prompt: automation.name, worktree: true });
  const webhookCurl = `curl -X POST '${webhookUrl}' \\\n  -H 'x-codex-cloud-token: $CODEX_CLOUD_WEBHOOK_TOKEN' \\\n  -H 'Idempotency-Key: <unique-request-id>' \\\n  -H 'Content-Type: application/json' \\\n  -d '{\"prompt\":\"${automation.name}\",\"worktree\":true}'`;
  const heartbeatCurl = `curl -X POST '${heartbeatUrl}' \\\n  -H 'x-codex-cloud-token: $CODEX_CLOUD_WEBHOOK_TOKEN' \\\n  -H 'Idempotency-Key: <unique-request-id>' \\\n  -H 'Content-Type: application/json' \\\n  -d '{\"sessionId\":\"<cloud-session-id>\",\"prompt\":\"继续检查这个任务\"}'`;
  const systemdName = `codex-webhook-${automation.id}`;
  const systemdSnippet = `[Unit]
Description=Codex Cloud webhook ${automation.id}

[Service]
Type=oneshot
EnvironmentFile=/etc/codex-cloud-webhook.env
ExecStart=/usr/bin/curl -fsS -X POST '${webhookUrl}' \\
  -H 'x-codex-cloud-token: \${CODEX_CLOUD_WEBHOOK_TOKEN}' \\
  -H 'Idempotency-Key: systemd-${automation.id}-\${INVOCATION_ID}' \\
  -H 'Content-Type: application/json' \\
  -d '${payload}'

# /etc/systemd/system/${systemdName}.timer
[Unit]
Description=Run Codex Cloud webhook ${automation.id}

[Timer]
OnCalendar=*-*-* 09:30:00
Persistent=true

[Install]
WantedBy=timers.target`;
  const githubSnippet = `name: Codex Cloud ${automation.id}

on:
  workflow_dispatch:
  schedule:
    - cron: '30 0 * * 1-5'

jobs:
  trigger:
    runs-on: ubuntu-latest
    steps:
      - name: Trigger Codex Cloud
        run: |
          curl -fsS -X POST '${webhookUrl}' \\
            -H 'x-codex-cloud-token: \${{ secrets.CODEX_CLOUD_WEBHOOK_TOKEN }}' \\
            -H 'Idempotency-Key: github-\${{ github.run_id }}-\${{ github.run_attempt }}' \\
            -H 'Content-Type: application/json' \\
            -d '${payload}'`;
  const cloudflareSnippet = `export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(fetch('${webhookUrl}', {
      method: 'POST',
      headers: {
        'x-codex-cloud-token': env.CODEX_CLOUD_WEBHOOK_TOKEN,
        'Idempotency-Key': \`cloudflare-\${event.scheduledTime}\`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(${payload})
    }));
  }
};`;
  const guideSnippets = {
    curl: webhookCurl,
    systemd: systemdSnippet,
    github: githubSnippet,
    cloudflare: cloudflareSnippet,
  };
  const guideLabels = {
    curl: "命令行",
    systemd: "系统定时器",
    github: "GitHub Actions",
    cloudflare: "Cloudflare Worker",
  };
  const copy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      window.setTimeout(() => setCopied((current) => (current === key ? "" : current)), 1600);
    } catch {
      setCopied("");
    }
  };
  return (
    <section className="automation-webhook-panel">
      <div className="run-log-header">
        <div>
          <p className="eyebrow">外部触发</p>
          <h3>自动运行入口</h3>
        </div>
        <span className={cx("run-badge", webhookConfigured ? "ok" : "warn")}>{webhookConfigured ? "已配置" : "待配置"}</span>
      </div>
      <div className="webhook-grid">
        <article>
          <div className="webhook-head">
            <strong>独立运行</strong>
            <button className="mini-action" type="button" onClick={() => copy("webhook", webhookCurl)}>
              {copied === "webhook" ? <CheckCircle2 size={13} /> : <FileText size={13} />}
              {copied === "webhook" ? "已复制" : "复制"}
            </button>
          </div>
          <small>在新的隔离工作区运行一次任务</small>
          <code>{webhookConfigured ? origin : "需要配置 webhook token"}</code>
          <details className="webhook-snippet" onToggle={(event) => setOpenSnippet(event.currentTarget.open ? "webhook" : "")}>
            <summary>查看命令</summary>
            {openSnippet === "webhook" && <pre>{webhookCurl}</pre>}
          </details>
        </article>
        <article>
          <div className="webhook-head">
            <strong>继续会话</strong>
            <button className="mini-action" type="button" onClick={() => copy("heartbeat", heartbeatCurl)}>
              {copied === "heartbeat" ? <CheckCircle2 size={13} /> : <FileText size={13} />}
              {copied === "heartbeat" ? "已复制" : "复制"}
            </button>
          </div>
          <small>绑定已有云端会话继续推进</small>
          <code>{webhookConfigured ? origin : "需要配置 webhook token"}</code>
          <details className="webhook-snippet" onToggle={(event) => setOpenSnippet(event.currentTarget.open ? "heartbeat" : "")}>
            <summary>查看命令</summary>
            {openSnippet === "heartbeat" && <pre>{heartbeatCurl}</pre>}
          </details>
        </article>
      </div>
      <details className="webhook-wizard" onToggle={(event) => setWizardOpen(event.currentTarget.open)}>
        <summary>
          <span>
            <strong>更多触发方式</strong>
            <small>生成可复制配置，外部平台负责调度。</small>
          </span>
        </summary>
        <div className="webhook-head">
          <div>
            <strong>{guideLabels[guide]}</strong>
            <small>收到请求后会在云端启动一次自动化运行。</small>
          </div>
          <button className="mini-action" type="button" onClick={() => copy(`guide-${guide}`, guideSnippets[guide])}>
            {copied === `guide-${guide}` ? <CheckCircle2 size={13} /> : <FileText size={13} />}
            {copied === `guide-${guide}` ? "已复制" : "复制配置"}
          </button>
        </div>
        <div className="webhook-tabs" aria-label="选择外部触发器">
          {(["curl", "systemd", "github", "cloudflare"] as const).map((item) => (
            <button key={item} type="button" className={cx(guide === item && "selected")} onClick={() => setGuide(item)}>
              {guideLabels[item]}
            </button>
          ))}
        </div>
        {wizardOpen && <pre>{guideSnippets[guide]}</pre>}
      </details>
      <p className="muted-line">外部入口仅接受专用 token header，并支持幂等键与速率限制。</p>
    </section>
  );
}

function Metric({ label, value, icon, title }: { label: string; value: string; icon: React.ReactNode; title?: string }) {
  return (
    <div className="metric">
      <span>{icon}</span>
      <div>
        <small>{label}</small>
        <strong title={title || value}>{value}</strong>
      </div>
    </div>
  );
}

function RunLogPanel({
  automation,
  onOpenLog,
}: {
  automation: Automation;
  onOpenLog: (name: string) => void;
}) {
  const failed = automation.run.failedState === "failed" || automation.run.exitCode.startsWith("non-zero");
  return (
    <section className="run-log-panel">
      <div className="run-log-header">
        <div>
          <p className="eyebrow">最近状态</p>
          <h3>最近运行状态</h3>
        </div>
        <span className={cx("run-badge", failed ? "warn" : "ok")}>
          {failed ? "需要检查" : "正常"}
        </span>
      </div>
      <div className="run-log-stats">
        <Metric label="运行状态" value={serviceStateLabel(automation.run.activeState)} icon={<Activity size={16} />} />
        <Metric label="故障状态" value={serviceStateLabel(automation.run.failedState)} icon={<ShieldCheck size={16} />} />
        <Metric label="退出结果" value={exitCodeLabel(automation.run.exitCode)} icon={<Terminal size={16} />} />
        <Metric label="日志更新" value={automation.run.logUpdatedAt ? shortDate(automation.run.logUpdatedAt) : "无日志"} icon={<History size={16} />} />
      </div>
      <div className="run-log-tail">
        <div className="run-log-name">
          <strong>{automation.run.logName || "未找到日志文件"}</strong>
          {automation.run.logName && (
            <button className="text-button compact" onClick={() => onOpenLog(automation.run.logName!)}>
              <HardDrive size={15} />
              查看完整日志
            </button>
          )}
        </div>
        <pre>{displayLogTail(automation.run.logTail)}</pre>
      </div>
    </section>
  );
}

function FullLogDrawer({
  log,
  onClose,
}: {
  log: { name: string; content: string; mocked?: boolean };
  onClose: () => void;
}) {
  return (
    <div className="log-drawer" role="dialog" aria-modal="true" aria-label="完整日志">
      <div className="log-drawer-card">
        <div className="thread-header">
          <div>
            <p className="eyebrow">{log.mocked ? "日志不可用" : "完整日志"}</p>
            <h2>{log.name}</h2>
          </div>
          <button className="command-button" onClick={onClose}>关闭</button>
        </div>
        <pre>{log.content}</pre>
      </div>
    </div>
  );
}

function ProjectDialog({
  name,
  remote,
  busy,
  onName,
  onRemote,
  onCreate,
  onClose,
}: {
  name: string;
  remote: string;
  busy: boolean;
  onName: (value: string) => void;
  onRemote: (value: string) => void;
  onCreate: () => void;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="新建项目">
      <div className="project-dialog">
        <div className="command-panel-head">
          <strong>新建项目</strong>
          <button className="icon-command" onClick={onClose} disabled={busy} type="button">×</button>
        </div>
        <div className="panel-form project-form">
          <input value={name} onChange={(event) => onName(event.target.value)} placeholder="项目名称，可选" disabled={busy} autoFocus />
          <input
            value={remote}
            onChange={(event) => onRemote(event.target.value)}
            placeholder="GitHub owner/repo 或 git URL；留空创建空目录"
            disabled={busy}
          />
          <div className="dialog-actions">
            <button className="command-button" onClick={onClose} disabled={busy} type="button">取消</button>
            <button className="primary-command" onClick={onCreate} disabled={busy || (!name.trim() && !remote.trim())} type="button">
              {busy ? <Loader2 size={16} className="spin" /> : <Plus size={16} />}
              创建
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Message({
  tone,
  title,
  body,
}: {
  tone: "ok" | "warn" | "info";
  title: string;
  body: string;
}) {
  return (
    <article className={cx("message", tone)}>
      <span className="message-icon">
        {tone === "ok" ? <CheckCircle2 size={16} /> : tone === "warn" ? <Activity size={16} /> : <Code2 size={16} />}
      </span>
      <div>
        <strong>{title}</strong>
        <p>{body}</p>
      </div>
    </article>
  );
}

function reviewOperationLabel(operation: ReviewFile["operation"]) {
  if (operation === "add") return "新增";
  if (operation === "delete") return "删除";
  if (operation === "rename") return "重命名";
  return "修改";
}

function reviewActionLabel(action: ReviewAction, level: ReviewActionLevel) {
  const scope = level === "all" ? "全部" : level === "file" ? "文件" : "hunk";
  if (action === "stage") return `暂存${scope}`;
  if (action === "unstage") return `取消暂存${scope}`;
  return `还原${scope}`;
}

function reviewLineMarker(kind: ReviewDiffLine["kind"]) {
  if (kind === "add") return "+";
  if (kind === "remove") return "-";
  if (kind === "hunk") return "@@";
  return "";
}

function reviewFindingLocation(finding: ReviewFinding, fallbackPath = "") {
  const file = finding.absolutePath || finding.path || fallbackPath || "unknown";
  const line = finding.startLine ? `:${finding.startLine}${finding.endLine && finding.endLine !== finding.startLine ? `-${finding.endLine}` : ""}` : "";
  return `${file}${line}`;
}

function reviewCommentThreadPrompt(finding: ReviewFinding, draft: string, fallbackPath = "") {
  const filePath = finding.path || fallbackPath;
  const mention = filePath ? `@${filePath}` : "";
  return [
    "请处理这条 Codex Review 发现的问题，并按需要修改代码或解释为什么不修改。",
    "",
    `位置: ${mention || reviewFindingLocation(finding, fallbackPath)}`,
    finding.startLine ? `行号: ${finding.startLine}${finding.endLine && finding.endLine !== finding.startLine ? `-${finding.endLine}` : ""}` : "",
    `标题: ${finding.title}`,
    finding.body ? `内容:\n${finding.body}` : "",
    draft.trim() ? `评论草稿:\n${draft.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function reviewPrCommentBody(finding: ReviewFinding, draft: string, fallbackPath = "") {
  const location = reviewFindingLocation(finding, fallbackPath);
  return [
    `**${finding.title}**`,
    "",
    draft.trim() || finding.body || finding.title,
    "",
    `位置: \`${location}\``,
  ]
    .filter(Boolean)
    .join("\n");
}

function inlineCommentDirective(finding: ReviewFinding, draft: string, fallbackPath = "") {
  const escape = (value: string) => value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
  const file = finding.absolutePath || finding.path || fallbackPath;
  const start = finding.startLine ? ` start=${finding.startLine}` : "";
  const end = finding.endLine && finding.endLine !== finding.startLine ? ` end=${finding.endLine}` : "";
  return `::code-comment{title="${escape(finding.title)}" body="${escape(draft.trim() || finding.body || finding.title)}" file="${escape(file)}"${start}${end} priority=2}`;
}

function ReviewPanel({
  repo,
  activity,
  summary,
  snapshot,
  loading,
  summaryLoading,
  error,
  actionBusy,
  prContext,
  prLoading,
  prPublishBusy,
  scope,
  workspaceView,
  baseBranch,
  busyAction,
  onScope,
  onWorkspaceView,
  onBaseBranch,
  onRefresh,
  onRunReview,
  onApply,
  onInitGit,
  onSubmitReviewComment,
  onRefreshPrContext,
  onPublishReviewComment,
}: {
  repo: Repo;
  activity: ReviewActivity | null;
  summary: ReviewSummary | null;
  snapshot: ReviewSnapshot | null;
  loading: boolean;
  summaryLoading: boolean;
  error: string;
  actionBusy: string;
  prContext: ReviewPrContext | null;
  prLoading: boolean;
  prPublishBusy: string;
  scope: ReviewScope;
  workspaceView: ReviewWorkspaceView;
  baseBranch: string;
  busyAction: string | null;
  onScope: (value: ReviewScope) => void;
  onWorkspaceView: (value: ReviewWorkspaceView) => void;
  onBaseBranch: (value: string) => void;
  onRefresh: () => void;
  onRunReview: () => void;
  onApply: (action: ReviewAction, level: ReviewActionLevel, patch?: string) => void;
  onInitGit: () => void;
  onSubmitReviewComment: (message: string) => void;
  onRefreshPrContext: () => void;
  onPublishReviewComment: (finding: ReviewFinding, draft: string, fallbackPath: string) => void;
}) {
  const [selectedFileId, setSelectedFileId] = useState("");
  const [findingDrafts, setFindingDrafts] = useState<Record<string, string>>({});
  const [copiedFindingId, setCopiedFindingId] = useState("");
  const files = snapshot?.files || [];
  const visibleSummary = snapshot?.summary || summary;
  const selectedFile = files.find((file) => file.id === selectedFileId) || files[0] || null;
  const canApply = scope === "workspace" && Boolean(selectedFile) && !snapshot?.readOnly;
  const rowActions: ReviewAction[] = workspaceView === "staged" ? ["unstage"] : ["stage", "revert"];
  const reviewResult = parseReviewText(activity?.text || "");
  const findingFileId = (finding: ReviewFinding) => {
    const absolute = finding.absolutePath || "";
    return (
      files.find(
        (file) =>
          absolute === file.path ||
          absolute.endsWith(`/${file.path}`) ||
          finding.path === file.path ||
          finding.path === file.path.split("/").pop(),
      )?.id || ""
    );
  };
  const selectedFindings = selectedFile
    ? reviewResult.findings.filter((finding) => findingFileId(finding) === selectedFile.id)
    : [];
  const prLabel = prLoading
    ? "同步 PR 中..."
    : prContext?.available && prContext.pr
      ? `PR #${prContext.pr.number} · ${prContext.pr.headRefName || "当前分支"} -> ${prContext.pr.baseRefName || "base"}`
      : prContext?.reason || "未连接 PR";

  useEffect(() => {
    if (!files.length) {
      if (selectedFileId) setSelectedFileId("");
      return;
    }
    if (!files.some((file) => file.id === selectedFileId)) {
      setSelectedFileId(files[0].id);
    }
  }, [files, selectedFileId]);

  return (
    <div className="review-panel">
      <div className="mini-header">
        <div>
          <p className="eyebrow">Codex Review</p>
          <h3>{repo.name}</h3>
          <small className="review-summary-line">
            {summaryLoading && !visibleSummary
              ? "同步变更中..."
              : visibleSummary
                ? `${visibleSummary.fileCount} 个文件 · +${visibleSummary.addedLineCount} / -${visibleSummary.removedLineCount}`
                : "等待变更摘要"}
          </small>
        </div>
        <div className="review-panel-actions">
          <button className="mini-action" type="button" onClick={onRefresh} disabled={loading || Boolean(actionBusy)}>
            {loading ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
            刷新
          </button>
          <button className="mini-action" type="button" onClick={onRunReview} disabled={Boolean(busyAction)}>
            {activity?.running ? <Loader2 size={13} className="spin" /> : <GitPullRequestArrow size={13} />}
            运行 Review
          </button>
        </div>
      </div>

      <div className="review-toolbar">
        <div className="choice-row compact">
          <button type="button" className={cx(scope === "workspace" && "selected")} onClick={() => onScope("workspace")}>工作区</button>
          <button type="button" className={cx(scope === "baseBranch" && "selected")} onClick={() => onScope("baseBranch")}>Base 分支</button>
        </div>
        {scope === "workspace" && (
          <div className="choice-row compact">
            <button type="button" className={cx(workspaceView === "unstaged" && "selected")} onClick={() => onWorkspaceView("unstaged")}>未暂存</button>
            <button type="button" className={cx(workspaceView === "staged" && "selected")} onClick={() => onWorkspaceView("staged")}>已暂存</button>
          </div>
        )}
        {scope === "baseBranch" && (
          <select value={baseBranch || snapshot?.baseBranch || ""} onChange={(event) => onBaseBranch(event.target.value)} className="review-branch-select">
            {(snapshot?.baseBranchOptions?.length ? snapshot.baseBranchOptions : [snapshot?.baseBranch || "main"]).filter((branch): branch is string => Boolean(branch)).map((branch) => (
              <option key={branch} value={branch}>{branch}</option>
            ))}
          </select>
        )}
      </div>

      <div className={cx("review-pr-context", prContext?.available && "available")}>
        <span>
          <GitPullRequestArrow size={14} />
          {prLabel}
        </span>
        <button className="mini-action" type="button" onClick={onRefreshPrContext} disabled={prLoading || Boolean(actionBusy)}>
          {prLoading ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
          刷新 PR
        </button>
      </div>

      {activity && activity.repoId === repo.id && (
        <details className="review-activity" open={activity.running}>
          <summary>
            <span>{activity.running ? "Review 运行中" : "最近 Review"}</span>
            <small>{activity.status} · {timeLabel(activity.updatedAt)}</small>
          </summary>
          {activity.error && <p className="warn-text">{activity.error}</p>}
          {reviewResult.findings.length > 0 ? (
            <div className="review-findings">
              {reviewResult.summary && <p className="muted-line">{reviewResult.summary}</p>}
              {reviewResult.findings.map((finding) => {
                const targetFileId = findingFileId(finding);
                return (
                  <button
                    key={finding.id}
                    type="button"
                    className={cx(targetFileId && selectedFileId === targetFileId && "selected")}
                    onClick={() => targetFileId && setSelectedFileId(targetFileId)}
                    disabled={!targetFileId}
                  >
                    <strong>{finding.title}</strong>
                    <small>
                      {finding.absolutePath || finding.path || "未知文件"}
                      {finding.startLine ? `:${finding.startLine}${finding.endLine && finding.endLine !== finding.startLine ? `-${finding.endLine}` : ""}` : ""}
                    </small>
                    {finding.body && <span>{finding.body}</span>}
                  </button>
                );
              })}
            </div>
          ) : (
            activity.text && <pre className="timeline-pre">{activity.text}</pre>
          )}
          {activity.diff && <pre className="timeline-pre">{activity.diff}</pre>}
        </details>
      )}

      {error && <p className="warn-text">{error}</p>}
      {loading && !snapshot && <p className="muted-line">同步变更中...</p>}
      {!loading && !snapshot && visibleSummary && visibleSummary.fileCount > 0 && (
        <div className="review-empty">
          <strong>{visibleSummary.fileCount} 个文件有变更</strong>
          <span>打开变更后可以浏览 diff、暂存、回滚或运行 Review。</span>
          <button className="command-button" type="button" onClick={onRefresh} disabled={loading || Boolean(actionBusy)}>
            打开变更
          </button>
        </div>
      )}

      {snapshot && !snapshot.isGitRepo && (
        <div className="review-empty">
          <strong>这个目录还不是 Git 仓库</strong>
          <span>初始化后才能使用工作区和 Base 分支对比。</span>
          <button className="command-button" type="button" onClick={onInitGit} disabled={Boolean(actionBusy)}>初始化 Git</button>
        </div>
      )}

      {snapshot?.isGitRepo && (
        <>
          <div className="review-meta">
            <span>{snapshot.summary.fileCount} 个文件</span>
            <span className="review-add">+{snapshot.summary.addedLineCount}</span>
            <span className="review-remove">-{snapshot.summary.removedLineCount}</span>
            {snapshot.headBranch && <span>{snapshot.headBranch}</span>}
            {scope === "baseBranch" && snapshot.baseBranch && <span>vs {snapshot.baseBranch}</span>}
            {snapshot.readOnly && <span>只读</span>}
          </div>

          {canApply && (
            <div className="review-bulk-actions">
              {rowActions.map((action) => (
                <button key={action} type="button" className="mini-action" onClick={() => onApply(action, "all")} disabled={Boolean(actionBusy)}>
                  {actionBusy === `${action}:all` ? <Loader2 size={13} className="spin" /> : <CheckCircle2 size={13} />}
                  {reviewActionLabel(action, "all")}
                </button>
              ))}
            </div>
          )}

          {!files.length ? (
            <div className="review-empty">
              <strong>当前范围没有变更</strong>
              <span>{scope === "workspace" ? "可以切换未暂存/已暂存，或运行 Review。" : "可以切换 Base 分支后刷新。"}</span>
            </div>
          ) : (
            <div className="review-main">
              <aside className="review-file-list" aria-label="Review 文件列表">
                {files.map((file) => (
                  <button
                    key={file.id}
                    type="button"
                    className={cx(selectedFile?.id === file.id && "selected")}
                    onClick={() => setSelectedFileId(file.id)}
                    title={file.path}
                  >
                    <span>
                      <strong>{file.path.split("/").pop() || file.path}</strong>
                      <small>{reviewOperationLabel(file.operation)}{file.previousPath ? ` · ${file.previousPath}` : ""}</small>
                    </span>
                    <span className="review-file-stat">+{file.addedLineCount} / -{file.removedLineCount}</span>
                  </button>
                ))}
              </aside>

              <section className="review-diff">
                {selectedFile && (
                  <>
                    {selectedFindings.length > 0 && (
                      <div className="review-selected-findings">
              <strong>发现的问题</strong>
                        {selectedFindings.map((finding) => (
                          <article key={finding.id}>
                            <span>
                              {finding.startLine ? `L${finding.startLine}${finding.endLine && finding.endLine !== finding.startLine ? `-L${finding.endLine}` : ""}` : "File"}
                            </span>
                            <div>
                              <b>{finding.title}</b>
                              {finding.body && <p>{finding.body}</p>}
                              <textarea
                                value={findingDrafts[finding.id] ?? finding.body}
                                onChange={(event) => setFindingDrafts((current) => ({ ...current, [finding.id]: event.target.value }))}
                placeholder="为这条问题写评论或给 Codex 的处理指令"
                              />
                              <div className="review-comment-actions">
                                <button
                                  type="button"
                                  className="mini-action"
                                  onClick={() => onSubmitReviewComment(reviewCommentThreadPrompt(finding, findingDrafts[finding.id] ?? finding.body, selectedFile.path))}
                                  disabled={Boolean(busyAction)}
                                >
                                  <Send size={13} />
                                  发给 Codex
                                </button>
                                <button
                                  type="button"
                                  className="mini-action"
                                  onClick={() => onPublishReviewComment(finding, findingDrafts[finding.id] ?? finding.body, selectedFile.path)}
                                  disabled={!prContext?.available || Boolean(prPublishBusy) || Boolean(busyAction)}
                                  title={prContext?.available ? "发布到当前 GitHub PR" : prContext?.reason || "当前没有可发布的 PR"}
                                >
                                  {prPublishBusy === finding.id ? <Loader2 size={13} className="spin" /> : <GitPullRequestArrow size={13} />}
                                  {prContext?.available ? "发布到 PR" : "PR 不可用"}
                                </button>
                                <button
                                  type="button"
                                  className="mini-action"
                                  onClick={() => {
                                    void navigator.clipboard.writeText(inlineCommentDirective(finding, findingDrafts[finding.id] ?? finding.body, selectedFile.path));
                                    setCopiedFindingId(finding.id);
                                    window.setTimeout(() => setCopiedFindingId(""), 1400);
                                  }}
                                >
                                  {copiedFindingId === finding.id ? <CheckCircle2 size={13} /> : <FileText size={13} />}
                  {copiedFindingId === finding.id ? "已复制" : "复制评论指令"}
                                </button>
                              </div>
                            </div>
                          </article>
                        ))}
                      </div>
                    )}
                    <div className="review-file-head">
                      <div>
                        <strong>{selectedFile.path}</strong>
                        <small>{reviewOperationLabel(selectedFile.operation)} · +{selectedFile.addedLineCount} / -{selectedFile.removedLineCount}</small>
                      </div>
                      {canApply && (
                        <div className="review-row-actions">
                          {rowActions.map((action) => (
                            <button key={action} type="button" className="mini-action" onClick={() => onApply(action, "file", selectedFile.diff)} disabled={Boolean(actionBusy)}>
                              {reviewActionLabel(action, "file")}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>

                    {selectedFile.hunks.length === 0 ? (
                      <pre className="timeline-pre">{selectedFile.diff || "这个文件没有可显示的 hunk。"}</pre>
                    ) : (
                      <div className="review-hunks">
                        {selectedFile.hunks.map((hunk) => (
                          <article className="review-hunk" key={hunk.id}>
                            <div className="review-hunk-head">
                              <span>{hunk.header}</span>
                              <small>+{hunk.addedLineCount} / -{hunk.removedLineCount}</small>
                              {canApply && (
                                <div className="review-row-actions">
                                  {rowActions.map((action) => (
                                    <button key={action} type="button" className="mini-action" onClick={() => onApply(action, "hunk", hunk.patch)} disabled={Boolean(actionBusy)}>
                                      {reviewActionLabel(action, "hunk")}
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                            <div className="review-lines">
                              {hunk.lines.map((line) => (
                                <div className="review-line" data-kind={line.kind} key={line.key}>
                                  <span>{line.oldLine ?? ""}</span>
                                  <span>{line.newLine ?? ""}</span>
                                  <span>{reviewLineMarker(line.kind)}</span>
                                  <code>{line.text || " "}</code>
                                </div>
                              ))}
                            </div>
                          </article>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </section>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function CloudChat({
  status,
  cloudConnection,
  repo,
  sessions,
  activeSessionId,
  onNewSession,
  onNewProject,
  onSelectSession,
  onOpenThread,
  onDeleteSession,
  onRenameSession,
  onForkThread,
  onArchiveThread,
  messages,
  input,
  attachments,
  uploadingAttachments,
  runtime,
  modelOptions,
  appStatus,
  appStatusLoading,
  tokenUsage,
  compactStatus,
  goal,
  goalDraft,
  goalBudgetDraft,
  reviewActivity,
  reviewPrContext,
  reviewPrLoading,
  reviewPrPublishBusy,
  autoCompactEnabled,
  autoCompactLimit,
  autoCompactScope,
  onRuntime,
  onInput,
  onFilesSelected,
  onRemoveAttachment,
  onGoalDraft,
  onGoalBudgetDraft,
  onAutoCompactEnabled,
  onAutoCompactLimit,
  onAutoCompactScope,
  onSaveGoal,
  onClearGoal,
  onCompact,
  onReview,
  onRefreshReviewPrContext,
  onPublishReviewComment,
  onSaveAutoCompact,
  onCodexLogin,
  onCodexLoginCancel,
  onCodexLogout,
  onMcpLogin,
  onMcpReload,
  onSend,
  onSubmitReviewComment,
  onInterrupt,
  onClear,
  busy,
  busyAction,
  codexAccountBusy,
  mcpLoginBusy,
  historyLoading,
  historyError,
}: {
  status: ConsoleStatus;
  cloudConnection: CloudConnection;
  repo: Repo;
  sessions: ChatSession[];
  activeSessionId: string;
  onNewSession: () => void;
  onNewProject: () => void;
  onSelectSession: (id: string) => void;
  onOpenThread: (repoId: string, sessionId: string) => void;
  onDeleteSession: (id: string) => void;
  onRenameSession: (id: string, title: string) => Promise<void> | void;
  onForkThread: () => void;
  onArchiveThread: () => void;
  messages: ChatMessage[];
  input: string;
  attachments: UploadedAttachment[];
  uploadingAttachments: boolean;
  runtime: ChatRuntime;
  modelOptions: CodexModelOption[];
  appStatus: CodexAppStatus;
  appStatusLoading: boolean;
  tokenUsage: ThreadTokenUsage | null;
  compactStatus: CompactStatus | null;
  goal: ThreadGoal | null;
  goalDraft: string;
  goalBudgetDraft: string;
  reviewActivity: ReviewActivity | null;
  reviewPrContext: ReviewPrContext | null;
  reviewPrLoading: boolean;
  reviewPrPublishBusy: string;
  autoCompactEnabled: boolean;
  autoCompactLimit: string;
  autoCompactScope: string;
  onRuntime: (value: ChatRuntime | ((current: ChatRuntime) => ChatRuntime)) => void;
  onInput: (value: string) => void;
  onFilesSelected: (files: FileList | File[]) => void;
  onRemoveAttachment: (index: number) => void;
  onGoalDraft: (value: string) => void;
  onGoalBudgetDraft: (value: string) => void;
  onAutoCompactEnabled: (value: boolean) => void;
  onAutoCompactLimit: (value: string) => void;
  onAutoCompactScope: (value: string) => void;
  onSaveGoal: () => void;
  onClearGoal: () => void;
  onCompact: () => void;
  onReview: () => void;
  onRefreshReviewPrContext: () => void;
  onPublishReviewComment: (finding: ReviewFinding, draft: string, fallbackPath: string) => void;
  onSaveAutoCompact: () => void;
  onCodexLogin: (type?: "chatgptDeviceCode" | "chatgpt") => void;
  onCodexLoginCancel: (loginId: string) => void;
  onCodexLogout: () => void;
  onMcpLogin: (serverName: string) => void;
  onMcpReload: () => void;
  onSend: () => void;
  onSubmitReviewComment: (message: string) => void;
  onInterrupt: () => void;
  onClear: () => void;
  busy: boolean;
  busyAction: string | null;
  codexAccountBusy: "login" | "cancel" | "logout" | null;
  mcpLoginBusy: string | null;
  historyLoading: boolean;
  historyError: string;
}) {
  const endRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [commandIndex, setCommandIndex] = useState(0);
  const [draggingAttachments, setDraggingAttachments] = useState(false);
  const [activePanel, setActivePanel] = useState<"model" | "reasoning" | "goal" | "status" | "auto" | "sessions" | "capabilities" | "permissions" | "diff" | "review" | null>(null);
  const [diffResult, setDiffResult] = useState<GitDiffResponse | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState("");
  const [reviewScope, setReviewScope] = useState<ReviewScope>("workspace");
  const [reviewWorkspaceView, setReviewWorkspaceView] = useState<ReviewWorkspaceView>("unstaged");
  const [reviewBaseBranch, setReviewBaseBranch] = useState("");
  const [reviewSummary, setReviewSummary] = useState<ReviewSummary | null>(null);
  const [reviewSnapshot, setReviewSnapshot] = useState<ReviewSnapshot | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState("");
  const [reviewActionBusy, setReviewActionBusy] = useState("");
  const [mentionFiles, setMentionFiles] = useState<AgentFileEntry[]>([]);
  const [mentionLoading, setMentionLoading] = useState(false);
  const [mentionError, setMentionError] = useState("");
  const [sessionQuery, setSessionQuery] = useState("");
  const [sessionSearchResults, setSessionSearchResults] = useState<ChatSession[]>([]);
  const [sessionSearchLoading, setSessionSearchLoading] = useState(false);
  const [sessionSearchErrors, setSessionSearchErrors] = useState<Record<string, string>>({});
  const [renamingSessionId, setRenamingSessionId] = useState("");
  const [renameDraft, setRenameDraft] = useState("");
  const activeSession = sessions.find((session) => session.id === activeSessionId);
  const displaySessions = useMemo(() => visibleSessionList(sessions, activeSessionId), [activeSessionId, sessions]);
  const activeSessionTitle = sessionDisplayTitle(activeSession);
  const activeSessionSubtitle = activeSession
    ? `${sessionSubtitle(activeSession)} · ${timeLabel(activeSession.updatedAt)}`
    : historyLoading
      ? "同步中"
      : "未选择";
  const localFilteredSessions = useMemo(() => {
    const query = sessionQuery.trim().toLowerCase();
    if (!query) return displaySessions;
    return displaySessions.filter((session) => {
      const haystack = `${sessionDisplayTitle(session)} ${session.id} ${session.codexSessionId || ""} ${session.messageCount}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [displaySessions, sessionQuery]);
  const sessionSearchActive = activePanel === "sessions" && sessionQuery.trim().length >= 2;
  const filteredSessions = useMemo(() => {
    if (!sessionSearchActive) return localFilteredSessions;
    const merged = new Map<string, ChatSession>();
    for (const session of sessionSearchResults.filter((item) => item.repoId === repo.id)) merged.set(session.id, session);
    for (const session of localFilteredSessions) merged.set(session.id, session);
    return Array.from(merged.values()).sort((a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime());
  }, [localFilteredSessions, repo.id, sessionSearchActive, sessionSearchResults]);
  const activeModel = modelOptions.find((model) => model.id === runtime.model);
  const activeReasoning = activeModel?.supportedReasoningEfforts?.length
    ? runtimeReasoning.filter((level) => activeModel.supportedReasoningEfforts?.includes(level))
    : runtimeReasoning;
  const percent = contextPercent(tokenUsage);
  const contextDetail = contextUsageDetail(tokenUsage);
  const rawContextTokens = contextTokenCount(tokenUsage);
  const displayedContextTokens = contextDisplayTokenCount(tokenUsage);
  const contextState = contextTone(tokenUsage, compactStatus);
  const activeReviewSummary = reviewSnapshot?.summary || reviewSummary;
  const reviewFileCount = activeReviewSummary?.fileCount ?? 0;
  const showFooterContext = Boolean(tokenUsage?.modelContextWindow || compactStatus?.running || compactStatus?.ok === false);
  const reviewChangeHint = activeReviewSummary
    ? `${reviewFileCount} 个文件变更 · +${activeReviewSummary.addedLineCount} / -${activeReviewSummary.removedLineCount}`
    : "查看当前工作区改动";
  const canUseThreadControls = Boolean(activeSession?.codexSessionId);
  const baseConnection = connectionState(status, cloudConnection);
  const connection = historyError
    ? { label: "会话服务降级", tone: "warn" as const, detail: historyError }
    : baseConnection;
  const attention = getAttentionSummary(status);
  const activeAccountLogin = appStatus.accountLogin?.active || null;
  const latestAccountLogin = appStatus.accountLogin?.latest || null;
  const usageLimit = appStatus.usageLimit || null;
  const appServerLive = status.appServerLive || appStatus.live || fallbackAppStatus.live!;
  const appStatusHasData =
    Boolean(appStatus.account) ||
    appStatus.mcpServers.length > 0 ||
    appStatus.plugins.available > 0 ||
    appStatus.skills.total > 0 ||
    appStatus.features.total > 0 ||
    appStatus.permissionProfiles.length > 0;
  const appStatusPending = appStatusLoading && !appStatusHasData;
  const appStatusIssue = appStatus.gaps?.[0] || appStatus.auth?.issue || "";
  const accountHint = appStatusPending
    ? "同步 Codex 账号中"
    : appStatus.auth?.ok === false
      ? appStatusIssue || "需要重新登录 Codex"
      : appStatus.account?.email || "Codex 登录状态";
  const mcpHint = appStatusPending ? "同步 MCP 状态中" : `${appStatus.mcpServers.length} 个服务器`;
  const pluginHint = appStatusPending ? "同步插件状态中" : `${appStatus.plugins.enabled} 已启用 / ${appStatus.plugins.installed} 已安装`;
  const toolsSummary = appStatusPending
    ? "同步云端工具状态中"
    : `MCP ${appStatus.mcpServers.length} · 插件 ${appStatus.plugins.enabled} 已启用 · Skills ${appStatus.skills.enabled}`;
  const providerSummary = appStatusPending
    ? "同步模型能力中"
    : `联网 ${enabledFlagLabel(appStatus.providerCapabilities?.webSearch)} · 图片 ${enabledFlagLabel(appStatus.providerCapabilities?.imageGeneration)} · 工具 ${enabledFlagLabel(appStatus.providerCapabilities?.namespaceTools)}`;
  const projectActiveJobs = (status.activeJobs || []).filter((job) => job.repoId === repo.id);
  const currentSessionJobKeys = new Set([activeSession?.id, activeSession?.codexSessionId].filter(Boolean));
  const currentThreadJobs = projectActiveJobs.filter(
    (job) => Boolean((job.sessionId && currentSessionJobKeys.has(job.sessionId)) || (job.threadId && currentSessionJobKeys.has(job.threadId))),
  );
  const visibleActiveJobs = currentThreadJobs.length ? currentThreadJobs : projectActiveJobs;
  const sessionGroups = useMemo(
    () => groupedSessions(filteredSessions, activeSessionId, attention, projectActiveJobs),
    [activeSessionId, attention, filteredSessions, projectActiveJobs],
  );
  const accountLoginMessage = activeAccountLogin
    ? activeAccountLogin.userCode
      ? `等待授权 · ${activeAccountLogin.userCode}`
      : "等待浏览器授权"
    : latestAccountLogin?.status === "completed"
      ? "最近登录完成"
      : "";
  const quotaText = displayQuotaValue(
    usageLimit,
    `${typeof appStatus.rateLimits?.primary?.usedPercent === "number" ? `${appStatus.rateLimits.primary.usedPercent}% / 5h` : "未知"} · ${
      typeof appStatus.rateLimits?.secondary?.usedPercent === "number" ? `${appStatus.rateLimits.secondary.usedPercent}% / 7d` : "未知"
    }`,
  );
  const slashMode = input.startsWith("/") && !input.includes("\n") && !busyAction;
  const commandQuery = slashMode ? input.slice(1).trim().toLowerCase() : "";
  const inlineTrigger = !slashMode && !busyAction ? inlineComposerTrigger(input) : null;
  const skillMode = inlineTrigger?.prefix === "$";
  const mentionMode = inlineTrigger?.prefix === "@";
  const mentionParts = mentionMode ? mentionQueryParts(inlineTrigger?.query || "") : { directory: ".", leaf: "" };
  const slashSummaryItems = [
    {
      id: "connection",
      icon: <Cloud size={14} />,
      label: connection.label,
      title: connection.detail,
      tone: connection.tone,
      open: () => setActivePanel("status"),
    },
    {
      id: "runtime",
      icon: <Sparkles size={14} />,
      label: activeModel?.displayName || runtime.model,
      title: `${runtime.model} · reasoning ${runtime.reasoning}`,
      tone: "neutral",
      open: () => setActivePanel("model"),
    },
    {
      id: "context",
      icon: compactStatus?.running ? <Loader2 size={14} className="spin" /> : <Gauge size={14} />,
      label: tokenUsage?.modelContextWindow || compactStatus?.running ? (compactStatus?.running ? "压缩中" : `${percent}% ctx`) : "等待 token",
      title: contextDetail,
      tone: contextState,
      open: () => setActivePanel("status"),
    },
    ...(goal ? [{
      id: "goal",
      icon: <Target size={14} />,
      label: "Goal",
      title: goal.objective,
      tone: "ok",
      open: () => setActivePanel("goal"),
    }] : []),
  ];
  const loadDiff = async () => {
    setActivePanel("diff");
    setDiffLoading(true);
    setDiffError("");
    try {
      const params = new URLSearchParams({ repoId: repo.id });
      setDiffResult(await api<GitDiffResponse>(`/api/codex/git-diff-to-remote?${params.toString()}`));
    } catch (error) {
      setDiffError(error instanceof Error ? error.message : "无法读取 diff");
    } finally {
      setDiffLoading(false);
    }
  };
  const loadReviewSnapshot = useCallback(async () => {
    setReviewLoading(true);
    setReviewError("");
    try {
      const params = new URLSearchParams({
        repoId: repo.id,
        scope: reviewScope,
        workspaceView: reviewWorkspaceView,
      });
      if (reviewScope === "baseBranch" && reviewBaseBranch) params.set("baseBranch", reviewBaseBranch);
      const payload = await api<ReviewApiResponse>(`/api/codex/review/snapshot?${params.toString()}`);
      if (payload.error) throw new Error(payload.error);
      const snapshot = payload.data || null;
      setReviewSnapshot(snapshot);
      if (reviewScope === "workspace") setReviewSummary(snapshot?.summary || null);
      if (snapshot?.baseBranch && !reviewBaseBranch) setReviewBaseBranch(snapshot.baseBranch);
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : "无法读取变更");
    } finally {
      setReviewLoading(false);
    }
  }, [repo.id, reviewScope, reviewWorkspaceView, reviewBaseBranch]);
  const runReviewFromPanel = () => {
    setActivePanel("review");
    onReview();
    onRefreshReviewPrContext();
    window.setTimeout(() => {
      void loadReviewSnapshot();
    }, 800);
  };
  const applyReviewAction = async (action: ReviewAction, level: ReviewActionLevel, patch = "") => {
    setReviewActionBusy(`${action}:${level}`);
    setReviewError("");
    try {
      const payload = await api<ReviewApiResponse>("/api/codex/review/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoId: repo.id,
          scope: reviewScope,
          workspaceView: reviewWorkspaceView,
          action,
          level,
          patch,
        }),
      });
      if (payload.error) throw new Error(payload.error);
      setReviewSnapshot(payload.data || null);
      setReviewSummary(payload.data?.summary || null);
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : "无法应用 review 操作");
    } finally {
      setReviewActionBusy("");
    }
  };
  const initReviewGit = async () => {
    setReviewActionBusy("git:init");
    setReviewError("");
    try {
      const payload = await api<{ ok?: boolean; error?: string }>("/api/codex/review/git/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoId: repo.id }),
      });
      if (payload.error) throw new Error(payload.error);
      await loadReviewSnapshot();
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : "无法初始化 Git");
    } finally {
      setReviewActionBusy("");
    }
  };
  useEffect(() => {
    if (activePanel === "review") void loadReviewSnapshot();
  }, [activePanel, loadReviewSnapshot]);

  useEffect(() => {
    setSessionQuery("");
    setSessionSearchResults([]);
    setSessionSearchErrors({});
    setRenamingSessionId("");
    setRenameDraft("");
    setReviewSnapshot(null);
    setReviewSummary(null);
  }, [repo.id]);

  useEffect(() => {
    const query = sessionQuery.trim();
    if (activePanel !== "sessions" || query.length < 2) {
      setSessionSearchResults([]);
      setSessionSearchErrors({});
      setSessionSearchLoading(false);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setSessionSearchLoading(true);
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ q: query, repoId: repo.id, limit: "24" });
      api<ChatSearchResponse>(`/api/chat/search?${params.toString()}`, { signal: controller.signal })
        .then((result) => {
          if (cancelled || result.query !== query) return;
          setSessionSearchResults(result.sessions || []);
          setSessionSearchErrors(result.errors || {});
        })
        .catch((error) => {
          if (cancelled) return;
          if (error instanceof DOMException && error.name === "AbortError") return;
          setSessionSearchResults([]);
	          setSessionSearchErrors({ [repo.id]: error instanceof Error ? error.message : "会话搜索失败" });
        })
        .finally(() => {
          if (!cancelled) setSessionSearchLoading(false);
        });
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [activePanel, repo.id, sessionQuery]);

  useEffect(() => {
    if (renamingSessionId && !sessions.some((session) => session.id === renamingSessionId)) {
      setRenamingSessionId("");
      setRenameDraft("");
    }
  }, [renamingSessionId, sessions]);

  useEffect(() => {
    const rawQuery = inlineTrigger?.query || "";
    if (!mentionMode || rawQuery.startsWith("project:")) {
      setMentionFiles([]);
      setMentionError("");
      setMentionLoading(false);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setMentionLoading(true);
    setMentionError("");
    const timer = window.setTimeout(() => {
      const query = rawQuery.trim();
      const params = new URLSearchParams({ repoId: repo.id, limit: "16" });
      const endpoint = query ? "/api/files/search" : "/api/files/tree";
      if (query) params.set("q", query);
      else params.set("path", ".");
      api<AgentFileTree>(`${endpoint}?${params.toString()}`, { signal: controller.signal })
        .then((result) => {
          if (cancelled) return;
          setMentionFiles(result.entries || []);
	          setMentionError(result.fallback && result.error ? `文件搜索已回退：${result.error}` : "");
        })
        .catch((error) => {
          if (cancelled) return;
          if (error instanceof DOMException && error.name === "AbortError") return;
          setMentionFiles([]);
          setMentionError(error instanceof Error ? error.message : "无法读取文件引用");
        })
        .finally(() => {
          if (!cancelled) setMentionLoading(false);
        });
    }, 140);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [inlineTrigger?.query, mentionMode, repo.id]);
  const permissionProfiles = [
    {
      id: "read-only",
      label: "只读",
      description: "只允许读取文件和运行低风险检查。",
      sandbox: "read-only",
      approval: "never",
    },
    {
      id: "workspace-write",
      label: "工作区写入",
      description: "可修改当前仓库工作区，适合普通开发任务。",
      sandbox: "workspace-write",
      approval: "never",
    },
    {
      id: "danger-full-access",
      label: "全权限",
      description: "云端专属空间默认模式，不再弹出审批询问。",
      sandbox: "danger-full-access",
      approval: "never",
    },
  ];
  const slashCommands: SlashCommand[] = [
    {
      id: "status",
      label: "状态",
      group: "对话",
      hint: "显示会话、上下文和额度状态",
      icon: <Gauge size={17} />,
      aliases: ["ctx", "context", "quota", "usage", "token"],
      run: () => setActivePanel("status"),
    },
    {
      id: "capabilities",
      label: "能力",
      group: "工具",
      hint: "查看账号、工具、插件、权限和剩余差异",
      icon: <SlidersHorizontal size={17} />,
      aliases: ["tools", "server", "app-server", "gap"],
      run: () => setActivePanel("capabilities"),
    },
    {
      id: "account",
      label: "账号",
      group: "配置",
      hint: accountHint,
      icon: <ShieldCheck size={17} />,
      aliases: ["login", "auth", "subscription"],
      run: () => setActivePanel("capabilities"),
    },
    {
      id: "mcp",
      label: "MCP",
      group: "工具",
      hint: mcpHint,
      icon: <HardDrive size={17} />,
      aliases: ["server", "tool"],
      run: () => setActivePanel("capabilities"),
    },
    {
      id: "plugins",
      label: "插件",
      group: "工具",
      hint: pluginHint,
      icon: <Code2 size={17} />,
      aliases: ["plugin", "skills"],
      run: () => setActivePanel("capabilities"),
    },
    {
      id: "permissions",
      label: "权限",
      group: "配置",
      hint: permissionRuntimeLabel(runtime.sandbox, runtime.approval),
      icon: <ShieldCheck size={17} />,
      aliases: ["approval", "sandbox", "access"],
      run: () => setActivePanel("permissions"),
    },
    {
      id: "goal",
      label: "目标",
      group: "上下文",
      hint: canUseThreadControls ? "设置 Codex 将持续努力实现的目标" : "先发送一条消息建立会话",
      icon: <Target size={17} />,
      aliases: ["objective", "task"],
      run: () => setActivePanel("goal"),
    },
    {
      id: "compact",
      label: "压缩",
      group: "上下文",
      hint: canUseThreadControls ? "主动压缩当前上下文" : "先发送一条消息建立会话",
      icon: <RefreshCw size={17} />,
      aliases: ["compress", "context", "summary"],
      run: onCompact,
      disabled: !canUseThreadControls || Boolean(busyAction),
    },
    {
      id: "auto-compact",
      label: "自动压缩",
      group: "上下文",
      hint: "设置全局自动压缩阈值",
      icon: <Settings2 size={17} />,
      aliases: ["auto", "threshold"],
      run: () => setActivePanel("auto"),
    },
    {
      id: "model",
      label: "模型",
      group: "配置",
      hint: activeModel?.displayName || runtime.model,
      icon: <Sparkles size={17} />,
      aliases: ["gpt", "runtime"],
      run: () => setActivePanel("model"),
    },
    {
      id: "reasoning",
      label: "推理模式",
      group: "配置",
      hint: reasoningLabel(runtime.reasoning),
      icon: <Brain size={17} />,
      aliases: ["think", "effort"],
      run: () => setActivePanel("reasoning"),
    },
    {
      id: "search",
      label: "联网搜索",
      group: "配置",
      hint: runtime.search ? "当前开启" : "当前关闭",
      icon: <Globe2 size={17} />,
      aliases: ["web", "browse"],
      run: () => onRuntime((current) => ({ ...current, search: !current.search })),
    },
    {
      id: "session",
      label: "会话",
      group: "对话",
      hint: "切换或新建会话",
      icon: <MessageSquare size={17} />,
      aliases: ["thread", "history"],
      run: () => setActivePanel("sessions"),
    },
    {
      id: "fork",
      label: "分支",
      group: "对话",
      hint: canUseThreadControls ? "从当前会话分叉新会话" : "先发送一条消息建立会话",
      icon: <GitBranch size={17} />,
      aliases: ["branch", "clone"],
      run: onForkThread,
      disabled: !canUseThreadControls || Boolean(busyAction),
    },
    {
      id: "archive",
      label: "归档",
      group: "对话",
      hint: canUseThreadControls ? "归档当前会话" : "先发送一条消息建立会话",
      icon: <History size={17} />,
      aliases: ["delete", "close"],
      run: onArchiveThread,
      disabled: !canUseThreadControls || Boolean(busyAction),
    },
    {
      id: "review",
      label: "Review",
      group: "代码",
      hint: canUseThreadControls ? `用 Codex 检查当前改动 · ${reviewChangeHint}` : "先发送一条消息建立会话",
      icon: <GitPullRequestArrow size={17} />,
      aliases: ["code-review", "pr"],
      run: runReviewFromPanel,
      disabled: !canUseThreadControls || Boolean(busyAction),
    },
    {
      id: "diff",
      label: "Diff",
      group: "代码",
      hint: reviewChangeHint,
      icon: <FileText size={17} />,
      aliases: ["changes", "review"],
      run: loadDiff,
      disabled: Boolean(busyAction),
    },
    {
      id: "new",
      label: "新会话",
      group: "对话",
      hint: "开始新的会话",
      icon: <Plus size={17} />,
      aliases: ["thread", "chat"],
      run: onNewSession,
      disabled: Boolean(busyAction),
    },
    {
      id: "project",
      label: "新建项目",
      group: "项目",
      hint: "clone GitHub 仓库或创建空工作区",
      icon: <FolderOpen size={17} />,
      aliases: ["repo", "workspace"],
      run: onNewProject,
      disabled: Boolean(busyAction),
    },
    {
      id: "clear",
      label: "清空",
      group: "对话",
	      hint: canUseThreadControls ? "云端会话不能清空，请归档或新建会话" : "清空本地草稿会话显示历史",
      icon: <Trash2 size={17} />,
      aliases: ["reset"],
      run: onClear,
      disabled: canUseThreadControls || historyLoading || messages.length === 0 || Boolean(busyAction),
    },
  ];
  const filteredCommands = slashCommands.filter((command) => {
    const haystack = `${command.id} ${command.label} ${command.hint} ${(command.aliases || []).join(" ")}`.toLowerCase();
    return haystack.includes(commandQuery);
  });
  const groupedCommands = filteredCommands.reduce<Array<{ group: string; items: Array<{ command: SlashCommand; index: number }> }>>(
    (groups, command, index) => {
      const groupName = command.group || "指令";
      const existing = groups.find((group) => group.group === groupName);
      if (existing) {
        existing.items.push({ command, index });
      } else {
        groups.push({ group: groupName, items: [{ command, index }] });
      }
      return groups;
    },
    [],
  );
  const skillCandidates = useMemo<ComposerSuggestion[]>(() => {
    const query = (inlineTrigger?.query || "").toLowerCase();
    const skills =
      appStatus.skills.items?.length
        ? appStatus.skills.items
        : appStatus.skills.names.map((name) => ({ name, displayName: name, description: "", path: "", enabled: true }));
    return skills
      .filter((skill) => skill.enabled !== false)
      .filter((skill) => {
        const haystack = `${skill.name} ${skill.displayName || ""} ${skill.description || ""}`.toLowerCase();
        return !query || haystack.includes(query);
      })
      .slice(0, 12)
      .map((skill) => ({
        id: `skill:${skill.path || skill.name}`,
        label: skill.displayName || skill.name,
        hint: skill.description || skill.name,
        insert: `$${skill.name} `,
        icon: <Sparkles size={17} />,
      }));
  }, [appStatus.skills.items, appStatus.skills.names, inlineTrigger?.query]);
  const mentionCandidates = useMemo<ComposerSuggestion[]>(() => {
    const rawQuery = inlineTrigger?.query || "";
    const query = rawQuery.toLowerCase();
    const projectMode = query.startsWith("project:");
    const projectQuery = projectMode ? query.slice("project:".length) : query;
    const projectCandidates = status.repos
      .filter((item) => !projectQuery || item.id.toLowerCase().includes(projectQuery) || item.name.toLowerCase().includes(projectQuery))
      .slice(0, 6)
      .map((item) => ({
        id: `project:${item.id}`,
        label: item.name,
        hint: item.path || item.id,
        insert: `@project:${item.id} `,
        icon: <FolderOpen size={17} />,
      }));
    if (projectMode) return projectCandidates;
    const leafQuery = mentionParts.leaf.toLowerCase();
    const fileCandidates = mentionFiles
      .filter((entry) => {
        if (!leafQuery || entry.source === "app-server-fuzzy") return true;
        return entry.name.toLowerCase().includes(leafQuery) || entry.path.toLowerCase().includes(leafQuery);
      })
      .slice(0, 12)
      .map((entry) => ({
        id: `file:${entry.path}`,
        label: entry.name,
	        hint: `${entry.source === "app-server-fuzzy" ? "智能搜索" : entry.type === "directory" ? "目录" : formatBytes(entry.size)} · ${entry.path}`,
        insert: `@${entry.path}${entry.type === "directory" ? "/" : " "}`,
        icon: entry.type === "directory" ? <FolderOpen size={17} /> : <FileText size={17} />,
      }));
    const shouldShowProjects = !query || "project".includes(query) || status.repos.some((item) => item.name.toLowerCase().includes(query));
    return [...fileCandidates, ...(shouldShowProjects ? projectCandidates : [])].slice(0, 14);
  }, [inlineTrigger?.query, mentionFiles, mentionParts.leaf, status.repos]);
  const inlineSuggestions = skillMode ? skillCandidates : mentionMode ? mentionCandidates : [];
  const startRenameSession = (session: ChatSession, options: { openPanel?: boolean } = {}) => {
    if (options.openPanel !== false) setActivePanel("sessions");
    setRenamingSessionId(session.id);
    setRenameDraft(session.title || "新会话");
  };
  const cancelRenameSession = () => {
    setRenamingSessionId("");
    setRenameDraft("");
  };
  const commitRenameSession = async (session: ChatSession) => {
    const title = renameDraft.trim();
    if (!title || title === session.title) {
      cancelRenameSession();
      return;
    }
    await onRenameSession(session.id, title);
    cancelRenameSession();
  };
  const chooseCommand = (index = commandIndex) => {
    const command = filteredCommands[index];
    if (!command || command.disabled) return;
    command.run();
    onInput("");
  };
  const chooseInlineSuggestion = (index = commandIndex) => {
    const suggestion = inlineSuggestions[index];
    if (!inlineTrigger || !suggestion || suggestion.disabled) return;
    onInput(replaceComposerToken(input, inlineTrigger, suggestion.insert));
  };
  const hasDragFiles = (transfer: DataTransfer | null) =>
    Boolean(transfer && (transfer.files?.length || Array.from(transfer.items || []).some((item) => item.kind === "file")));
  const handleComposerDragEnter = (event: DragEvent<HTMLElement>) => {
    if (!hasDragFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDraggingAttachments(true);
  };
  const handleComposerDragOver = (event: DragEvent<HTMLElement>) => {
    if (!hasDragFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDraggingAttachments(true);
  };
  const handleComposerDragLeave = (event: DragEvent<HTMLElement>) => {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    setDraggingAttachments(false);
  };
  const handleComposerDrop = (event: DragEvent<HTMLElement>) => {
    const files = filesFromTransfer(event.dataTransfer);
    setDraggingAttachments(false);
    if (!files.length) return;
    event.preventDefault();
    event.stopPropagation();
    onFilesSelected(files);
  };

  useEffect(() => {
    const scroller = endRef.current?.closest(".chat-window");
    if (scroller instanceof HTMLElement) {
      scroller.scrollTop = scroller.scrollHeight;
      return;
    }
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, busy]);

  useEffect(() => {
    setCommandIndex(0);
  }, [commandQuery, inlineTrigger?.prefix, inlineTrigger?.query]);

  return (
    <section className="chat-panel wide-panel">
      <div className="thread-header">
        <div className="thread-title">
          <div className="thread-avatar">
            <MessageSquare size={19} />
          </div>
          <div>
            <p className="eyebrow">云端会话</p>
            <h2>云端 Codex</h2>
          </div>
        </div>
        <div className="thread-actions">
          <button className={cx("status-pill", connection.tone)} onClick={() => setActivePanel("status")} title={connection.detail} type="button">
            <Cloud size={15} />
            {connection.label}
          </button>
        </div>
      </div>

      <div className="session-strip app-session-strip" aria-label="当前项目会话">
        <span className="repo-choice selected">
          <Circle size={9} className={cx("repo-dot", repo.accent)} />
          {repo.name}
        </span>
        {renamingSessionId === activeSessionId && activeSession ? (
          <form
            className="session-inline-rename"
            onSubmit={(event) => {
              event.preventDefault();
              void commitRenameSession(activeSession);
            }}
          >
            <input
              autoFocus
              value={renameDraft}
              onChange={(event) => setRenameDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") cancelRenameSession();
              }}
              disabled={Boolean(busyAction)}
              aria-label="会话名称"
            />
            <button className="icon-command" disabled={!renameDraft.trim() || Boolean(busyAction)} title="保存" type="submit">
              <CheckCircle2 size={15} />
            </button>
            <button className="icon-command" onClick={cancelRenameSession} title="取消" type="button">
              <X size={15} />
            </button>
          </form>
        ) : (
          <button
            className="session-current"
            data-session-id={activeSessionId}
            onClick={() => setActivePanel("sessions")}
            type="button"
            title={`${activeSessionTitle} · ${activeSessionSubtitle}`}
          >
            <span className="session-current-copy">
              <strong>{activeSessionTitle}</strong>
              <small>{activeSessionSubtitle}</small>
            </span>
            <ChevronRight size={15} />
          </button>
        )}
        <div className="session-actions">
          <button className="icon-command" onClick={() => setActivePanel("sessions")} disabled={historyLoading} title="会话">
            <History size={16} />
          </button>
          <button className="icon-command" onClick={onNewSession} disabled={Boolean(busyAction)} title="新会话">
            <Plus size={16} />
          </button>
          <button
            className="icon-command"
            onClick={() => activeSession && startRenameSession(activeSession, { openPanel: false })}
            disabled={!canUseThreadControls || Boolean(busyAction)}
            title={canUseThreadControls ? "重命名" : "先发送消息建立会话"}
          >
            <Pencil size={15} />
          </button>
        </div>
      </div>

      {historyError && (
        <div className="chat-degraded-banner" role="alert">
          <Cloud size={15} />
          <span>{historyError}</span>
        </div>
      )}

      <div className="chat-window">
        {historyLoading && messages.length === 0 && (
          <article className="chat-bubble codex compact">
            <span className="chat-avatar">
              <Loader2 size={16} className="spin" />
            </span>
            <div>
              <strong>云端 Codex</strong>
              <p>同步会话中...</p>
            </div>
          </article>
        )}
        {messages.map((message) => {
          const meta = timelineMessageMeta(message);
          const body = displayProjectMessageText(message.text || (message.streaming ? " " : "Codex 没有返回内容。"), repo);
          const timelineAttachments = messageTimelineAttachments(message, repo);
          return (
            <article key={message.id} className={cx("chat-bubble", message.role, message.streaming && "streaming", meta.className)}>
              <span className="chat-avatar">{message.role === "user" ? <Sparkles size={16} /> : <Bot size={16} />}</span>
              <div>
                <strong>
                  {message.role === "user" ? "你" : "云端 Codex"}
                  {meta.label && <span className="item-kind">{meta.label}</span>}
                  <small>{timeLabel(message.time)}</small>
                </strong>
                <ChatMessageText text={body} pre={meta.pre} streaming={message.streaming} />
                <MessageAttachments attachments={timelineAttachments} />
                <TimelineDetailsPanel details={message.details} />
                {timelineStatusLabel(message.status) && <em className="chat-status">{timelineStatusLabel(message.status)}</em>}
              </div>
            </article>
          );
        })}
        {busy && !messages.some((message) => message.streaming) && (
          <article className="chat-bubble codex">
            <span className="chat-avatar">
              <Loader2 size={16} className="spin" />
            </span>
            <div>
              <strong>云端 Codex</strong>
              <p>正在运行云端 Codex...</p>
            </div>
          </article>
        )}
        <div ref={endRef} />
      </div>

      <div
        className={cx("composer-shell", draggingAttachments && "drag-over")}
        onDragEnter={handleComposerDragEnter}
        onDragLeave={handleComposerDragLeave}
        onDragOver={handleComposerDragOver}
        onDrop={handleComposerDrop}
      >
        {draggingAttachments && (
          <div className="composer-drop-overlay" data-testid="composer-drop-overlay">
            <Paperclip size={18} />
            <strong>释放以上传</strong>
          </div>
        )}
        {slashMode && (
          <div className="slash-menu command-menu" data-testid="slash-command-center" onMouseDown={(event) => event.preventDefault()} role="listbox" aria-label="Codex 指令">
            <div className="slash-command-head">
              <div>
                <strong>Codex 指令</strong>
                <small>会话操作、模型、工具和状态</small>
              </div>
              <kbd>/</kbd>
            </div>
            <div className="slash-command-summary" aria-label="当前会话状态">
              {slashSummaryItems.map((item) => (
                <button
                  key={item.id}
                  className={cx("slash-summary-chip", item.tone)}
                  onClick={() => {
                    item.open();
                    onInput("");
                  }}
                  title={item.title}
                  type="button"
                >
                  {item.icon}
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
            {groupedCommands.map((group) => (
              <section className="slash-group" key={group.group}>
                <p className="slash-group-label">{group.group}</p>
                {group.items.map(({ command, index }) => (
                  <button
                    key={command.id}
                    className={cx(index === commandIndex && "selected")}
                    disabled={command.disabled}
                    onClick={() => chooseCommand(index)}
                    onMouseEnter={() => setCommandIndex(index)}
                    role="option"
                    aria-selected={index === commandIndex}
                    type="button"
                  >
                    <span className="slash-icon">{command.icon}</span>
                    <strong>{command.label}</strong>
                    <small>{command.hint}</small>
                  </button>
                ))}
              </section>
            ))}
            {filteredCommands.length === 0 && <p>没有匹配的指令</p>}
          </div>
        )}

        {(skillMode || mentionMode) && (
          <div className="slash-menu inline-mention-menu" onMouseDown={(event) => event.preventDefault()}>
            <div className="inline-menu-title">
              <strong>{skillMode ? "$ Skills" : "@ 文件与项目"}</strong>
              <small>{skillMode ? "选择一个 skill" : "选择一个文件或项目"}</small>
            </div>
            {inlineSuggestions.map((suggestion, index) => (
              <button
                key={suggestion.id}
                className={cx(index === commandIndex && "selected")}
                disabled={suggestion.disabled}
                onClick={() => chooseInlineSuggestion(index)}
                type="button"
              >
                <span className="slash-icon">{suggestion.icon}</span>
                <strong>{suggestion.label}</strong>
                <small>{suggestion.hint}</small>
              </button>
            ))}
            {mentionMode && mentionLoading && <p>正在搜索文件...</p>}
            {mentionMode && mentionError && <p className="warn-text">{mentionError}</p>}
            {!mentionLoading && inlineSuggestions.length === 0 && <p>{skillMode ? "没有匹配的 skill" : "没有匹配的文件或项目"}</p>}
          </div>
        )}

        {activePanel && (
          <div className="command-panel">
            <div className="command-panel-head">
              <strong>
                {activePanel === "model" && "模型"}
                {activePanel === "reasoning" && "推理模式"}
                {activePanel === "goal" && "目标"}
                {activePanel === "status" && "状态"}
                {activePanel === "auto" && "全局自动压缩"}
                {activePanel === "sessions" && "会话"}
                {activePanel === "capabilities" && "能力"}
                {activePanel === "permissions" && "权限"}
                {activePanel === "diff" && "Diff"}
                {activePanel === "review" && "Review"}
              </strong>
              <button className="icon-command" onClick={() => setActivePanel(null)} type="button">
                ×
              </button>
            </div>

            {activePanel === "status" && (
              <div className="context-status-panel">
                <div className={cx("context-meter-card", contextState)}>
                  <div>
                    <strong>{tokenUsage?.modelContextWindow ? `${percent}%` : "--"}</strong>
                    <span>{contextDetail}</span>
                  </div>
                  <div className="meter-track">
                    <span style={{ width: `${Math.max(percent, tokenUsage ? 2 : 0)}%` }} />
                  </div>
                </div>
                <div className="status-grid">
                  <span>连接</span>
                  <strong title={connection.detail}>{connection.label}</strong>
                  <span>云端 Codex</span>
                  <strong>
                    {status.health?.layers.appServer?.ok ? "在线" : "异常"}
                    {status.health?.layers.appServer?.restartCount ? ` · 重启 ${status.health.layers.appServer.restartCount}` : ""}
                  </strong>
                  <span>Codex 登录</span>
                  <strong>{status.health?.layers.codexAuth?.ok ? status.codex.mode : status.health?.layers.codexAuth?.detail || "未登录"}</strong>
                  <span>仓库</span>
                  <strong>
                    {status.health?.layers.repos?.length
                      ? `${status.health.layers.repos.filter((item) => item.ok).length}/${status.health.layers.repos.length} 可用`
                      : `${status.repos.filter((item) => item.present).length}/${status.repos.length} 可用`}
                  </strong>
                  <span>工作区</span>
                  <strong title={repo.path}>{displayWorktreePath(repo.path) || repo.name}</strong>
                  <span>会话</span>
                  <strong>{activeSession?.codexSessionId ? activeSession.codexSessionId.slice(0, 8) : "未建立"}</strong>
                  <span>运行中</span>
                  <strong>{visibleActiveJobs.length ? `${visibleActiveJobs.length} 个` : "无"}</strong>
                  <span>当前窗口</span>
                  <strong>{contextDetail}</strong>
                  <span>累计</span>
                  <strong>{formatTokenCount(tokenUsage?.total.totalTokens)}</strong>
                  <span>Goal</span>
                  <strong>{goal?.objective || "未设置"}</strong>
                  <span>全局自动压缩</span>
                  <strong title={autoCompactScope}>{autoCompactEnabled ? `${formatTokenCount(Number(autoCompactLimit))} · ${autoCompactScopeLabel(autoCompactScope)}` : "关闭"}</strong>
                  <span>主动压缩</span>
                  <strong>
                    {compactStatus?.running
                      ? compactStatus.text
                      : compactStatus?.ok === false
                        ? compactStatus.error || "压缩失败"
                        : activeSession?.compactedAt
                          ? timeLabel(activeSession.compactedAt)
                          : "未压缩"}
                  </strong>
                </div>
                <ActiveJobList jobs={visibleActiveJobs} onOpenThread={onOpenThread} limit={4} />
                <div className="context-status-actions">
                  <button className="command-button" onClick={onCompact} disabled={!canUseThreadControls || Boolean(busyAction)} type="button">
                    {compactStatus?.running ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
                    主动压缩
                  </button>
                  <button className="command-button" onClick={() => setActivePanel("auto")} disabled={Boolean(busyAction)} type="button">
                    自动压缩
                  </button>
                </div>
              </div>
            )}

            {activePanel === "diff" && (
              <div className="diff-panel">
                <div className="mini-header">
                  <div>
                    <p className="eyebrow">相对远端</p>
                    <h3>{repo.name}</h3>
                  </div>
                  <button className="mini-action" type="button" onClick={loadDiff} disabled={diffLoading || Boolean(busyAction)}>
                    {diffLoading ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
                    刷新
                  </button>
                </div>
                {diffError && <p className="warn-text">{diffError}</p>}
                <pre className="timeline-pre">{diffLoading ? "同步 diff 中..." : formatDiffPayload(diffResult?.diff)}</pre>
              </div>
            )}

            {activePanel === "review" && (
              <ReviewPanel
                repo={repo}
                activity={reviewActivity}
                summary={activeReviewSummary || null}
                snapshot={reviewSnapshot}
                loading={reviewLoading}
                summaryLoading={false}
                error={reviewError}
                actionBusy={reviewActionBusy}
                prContext={reviewPrContext}
                prLoading={reviewPrLoading}
                prPublishBusy={reviewPrPublishBusy}
                scope={reviewScope}
                workspaceView={reviewWorkspaceView}
                baseBranch={reviewBaseBranch}
                busyAction={busyAction}
                onScope={setReviewScope}
                onWorkspaceView={setReviewWorkspaceView}
                onBaseBranch={setReviewBaseBranch}
                onRefresh={loadReviewSnapshot}
                onRunReview={runReviewFromPanel}
                onApply={applyReviewAction}
                onInitGit={initReviewGit}
                onSubmitReviewComment={onSubmitReviewComment}
                onRefreshPrContext={onRefreshReviewPrContext}
                onPublishReviewComment={onPublishReviewComment}
              />
            )}

            {activePanel === "permissions" && (
              <div className="choice-list">
                {permissionProfiles.map((profile) => (
                  <button
                    key={profile.id}
                    className={cx(runtime.sandbox === profile.sandbox && runtime.approval === profile.approval && "selected")}
                    onClick={() => {
                      onRuntime((current) => ({ ...current, sandbox: profile.sandbox, approval: profile.approval }));
                      setActivePanel(null);
                    }}
                    type="button"
                  >
                    <strong>{profile.label}</strong>
                    <span title={`${profile.sandbox} · approval ${profile.approval}`}>{permissionRuntimeLabel(profile.sandbox, profile.approval)}</span>
                    <small>{profile.description}</small>
                  </button>
                ))}
                <div className="mini-list">
                  {appStatus.permissionProfiles.length > 0 && (
                    <span>权限配置: {appStatus.permissionProfiles.map((profile) => profile.id).join(", ")}</span>
                  )}
                  <span>后续消息会按所选权限运行；底层设置会同步到云端 Codex。</span>
                </div>
              </div>
            )}

            {activePanel === "capabilities" && (
              <div className="capability-panel">
                <div className="status-grid">
                  <span>账号</span>
                  <strong className="status-action-row">
	                    <span>{appStatusPending ? "同步账号中" : `${appStatus.account?.email || "未知"} · ${appStatus.account?.planType || "未知套餐"}`}</span>
                    <button
                      className="mini-action"
                      type="button"
                      onClick={() => onCodexLogin("chatgptDeviceCode")}
                      disabled={Boolean(codexAccountBusy) || Boolean(busyAction)}
                    >
                      {codexAccountBusy === "login" ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
                      重新登录
                    </button>
                  </strong>
                  <span>Codex 登录</span>
                  <strong className={cx("status-action-row", appStatus.auth?.ok === false ? "warn-text" : undefined)}>
                    <span>{appStatusPending ? "同步账号状态中" : appStatus.auth?.ok === false ? appStatus.auth.issue || "需要重新登录" : accountLoginMessage || "有效"}</span>
                  </strong>
                  <span>额度</span>
                  <strong className={usageLimit ? "warn-text" : undefined} title={usageLimit?.message || usageLimit?.body || quotaText}>
                    {appStatusPending ? "同步额度中" : quotaText}
                  </strong>
                  <span>权限</span>
                  <strong title={`${appStatus.config.sandbox} · approval ${appStatus.config.approval}`}>
                    {appStatusPending ? "同步权限中" : permissionRuntimeLabel(appStatus.config.sandbox, appStatus.config.approval)}
                  </strong>
                  <span>服务</span>
                  <strong>
                    {appStatus.appHost?.running && appStatus.authoritative !== false && !appStatus.partial && !appStatus.appHost.lastError
                      ? "云端 Codex 在线"
                      : appStatus.appHost?.running
                        ? "云端 Codex 降级"
                        : "云端 Codex 未运行"}
                    {appStatus.appHost?.restartCount ? ` · 重启 ${appStatus.appHost.restartCount}` : ""}
                  </strong>
                  <span>工具</span>
                  <strong>{toolsSummary}</strong>
                  <span>模型能力</span>
                  <strong>{providerSummary}</strong>
                  <span>实时事件</span>
                  <strong>{displayLiveEventTitle(appServerLive.latestEvents?.[0])}</strong>
                </div>
                <div className="mini-list">
                  {Boolean(appServerLive.latestEvents?.length) && (
                    <span className="mcp-row">
                      <span>云端实时事件</span>
                      <small>{appServerLive.latestEvents.slice(0, 3).map((event) => `${displayLiveEventTitle(event)} · ${timeLabel(event.time)}`).join(" / ")}</small>
                    </span>
                  )}
                  {appServerLive.skillsChangedAt && (
	                    <span>Skills 元数据已变更 · {timeLabel(appServerLive.skillsChangedAt)}</span>
                  )}
                  {appServerLive.appListUpdated && (
                    <span>App 列表 {appServerLive.appListUpdated.count} 个 · {timeLabel(appServerLive.appListUpdated.updatedAt)}</span>
                  )}
                  {appServerLive.remoteControl && (
	                    <span>远端控制 {runStatusLabel(appServerLive.remoteControl.status)} · {appServerLive.remoteControl.serverName || "未知服务"}</span>
                  )}
                  {Object.values(appServerLive.mcpStartup || {}).slice(0, 4).map((server) => (
                    <span key={`startup-${server.name}`} className={server.status === "failed" ? "warn-text" : ""}>
	                      MCP {server.name} 启动 {runStatusLabel(server.status)}{server.error ? ` · ${displayCapabilityText(server.error)}` : ""}
                    </span>
                  ))}
                  {activeAccountLogin && (
                    <div className="account-flow-card">
                      <div className="account-flow-head">
                        <strong>授权码 {activeAccountLogin.userCode || activeAccountLogin.loginId.slice(0, 8)}</strong>
                        <button
                          className="mini-action"
                          type="button"
                          onClick={() => onCodexLoginCancel(activeAccountLogin.loginId)}
                          disabled={Boolean(codexAccountBusy) || Boolean(busyAction)}
                        >
                          {codexAccountBusy === "cancel" ? <Loader2 size={13} className="spin" /> : <X size={13} />}
                          取消授权
                        </button>
                      </div>
                      <span>在打开的 OpenAI 页面完成授权后，这里会自动刷新账号状态。</span>
                    </div>
                  )}
                  <span className="mcp-row">
                    <span>账号会话</span>
                    <button
                      className="mini-action"
                      type="button"
                      onClick={onCodexLogout}
                      disabled={Boolean(codexAccountBusy) || Boolean(busyAction)}
                    >
                      {codexAccountBusy === "logout" ? <Loader2 size={13} className="spin" /> : <X size={13} />}
                      退出
                    </button>
                  </span>
                  {appStatus.mcpServers.slice(0, 5).map((server) => {
                    const startup = appServerLive.mcpStartup?.[server.name];
                    return (
                      <span key={server.name} className="mcp-row">
                        <span>
		                          {server.name}: {mcpAuthStatusLabel(server.authStatus)} · {server.toolCount} 个工具
		                          {startup ? ` · 启动 ${runStatusLabel(startup.status)}` : ""}
                        </span>
                        {mcpAuthNeedsLogin(server.authStatus) && (
                          <button
                            type="button"
                            className="mini-action"
                            onClick={() => onMcpLogin(server.name)}
                            disabled={Boolean(mcpLoginBusy) || Boolean(busyAction)}
                          >
                            {mcpLoginBusy === server.name ? <Loader2 size={13} className="spin" /> : <Globe2 size={13} />}
                            登录
                          </button>
                        )}
                      </span>
                    );
                  })}
                  <span className="mcp-row">
                    <span>MCP 状态来自云端 Codex</span>
                    <button className="mini-action" type="button" onClick={onMcpReload} disabled={Boolean(busyAction)}>
                      {busyAction === "mcp-reload" ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
                      刷新
                    </button>
                  </span>
          {appStatus.mcpOauthResults?.slice(0, 3).map((result) => (
            <span key={`${result.name}-${result.time}`} className={result.success ? "" : "warn-text"}>
              {result.name} OAuth {result.success ? "已完成" : displayCapabilityText(result.error || "失败")} · {timeLabel(result.time)}
            </span>
          ))}
	                  {appStatus.plugins.names.length > 0 && <span>插件：{appStatus.plugins.names.join(", ")}</span>}
	                  {appStatus.gaps.map((gap) => (
	                    <span key={gap} className="warn-text">{displayCapabilityText(gap)}</span>
	                  ))}
	                  {Object.entries(appStatus.rawErrors || {}).map(([key, value]) => (
	                    <span key={key} className="warn-text">{displayCapabilityText(`${key}: ${value}`)}</span>
	                  ))}
                </div>
              </div>
            )}

            {activePanel === "model" && (
              <div className="choice-list">
                {modelOptions.map((model) => (
                  <button
                    key={model.id}
                    className={cx(runtime.model === model.id && "selected")}
                    onClick={() => {
                      const supportedReasoning = model.supportedReasoningEfforts?.length
                        ? runtimeReasoning.filter((level) => model.supportedReasoningEfforts?.includes(level))
                        : runtimeReasoning;
                      onRuntime((current) => ({
                        ...current,
                        model: model.id,
                        reasoning: supportedReasoning.includes(current.reasoning)
                          ? current.reasoning
                          : model.defaultReasoningEffort || defaultChatRuntime.reasoning,
                      }));
                      setActivePanel(null);
                    }}
                    type="button"
                  >
                    <strong>{model.displayName || model.id}</strong>
                    <small>{model.description || model.id}</small>
                  </button>
                ))}
              </div>
            )}

            {activePanel === "reasoning" && (
              <div className="choice-row">
                {activeReasoning.map((level) => (
                  <button
                    key={level}
                    className={cx(runtime.reasoning === level && "selected")}
                    onClick={() => {
                      onRuntime((current) => ({ ...current, reasoning: level }));
                      setActivePanel(null);
                    }}
                    type="button"
                  >
                    {reasoningLabel(level)}
                  </button>
                ))}
              </div>
            )}

            {activePanel === "goal" && (
              <div className="panel-form">
                <input value={goalDraft} onChange={(event) => onGoalDraft(event.target.value)} placeholder="Codex 要持续努力实现的目标" disabled={!canUseThreadControls || Boolean(busyAction)} />
                <input value={goalBudgetDraft} onChange={(event) => onGoalBudgetDraft(event.target.value.replace(/[^\d]/g, ""))} placeholder="token budget，可选" disabled={!canUseThreadControls || Boolean(busyAction)} />
                <button className="command-button" onClick={onSaveGoal} disabled={!canUseThreadControls || !goalDraft.trim() || Boolean(busyAction)} type="button">
                  保存目标
                </button>
                <button className="command-button" onClick={onClearGoal} disabled={!goal || Boolean(busyAction)} type="button">
                  清除目标
                </button>
              </div>
            )}

            {activePanel === "auto" && (
              <div className="panel-form compact">
                <label className="checkbox-chip">
                  <input type="checkbox" checked={autoCompactEnabled} onChange={(event) => onAutoCompactEnabled(event.target.checked)} disabled={Boolean(busyAction)} />
                  全局自动压缩
                </label>
                <input value={autoCompactLimit} onChange={(event) => onAutoCompactLimit(event.target.value.replace(/[^\d]/g, ""))} disabled={!autoCompactEnabled || Boolean(busyAction)} />
                <select value={autoCompactScope} onChange={(event) => onAutoCompactScope(event.target.value)} disabled={!autoCompactEnabled || Boolean(busyAction)}>
                  <option value="body_after_prefix">正文</option>
                  <option value="total">全部上下文</option>
                </select>
                <button className="command-button" onClick={onSaveAutoCompact} disabled={Boolean(busyAction)} type="button">
                  保存
                </button>
              </div>
            )}

            {activePanel === "sessions" && (
              <div className="session-manager">
                <div className="session-manager-head">
                  <label className="session-search">
                    <Search size={15} />
                    <input value={sessionQuery} onChange={(event) => setSessionQuery(event.target.value)} placeholder="搜索会话" />
                  </label>
                  <button className="mini-action" onClick={onNewSession} disabled={Boolean(busyAction)} type="button">
                    <Plus size={13} />
                    新会话
                  </button>
                </div>
                {sessionSearchActive && (
                  <div className="session-search-status">
                    <span>
                      {sessionSearchLoading ? <Loader2 size={13} className="spin" /> : <Search size={13} />}
	                      云端会话搜索
                    </span>
                    <small>
                      {sessionSearchLoading
	                        ? "同步历史会话中..."
                        : sessionSearchErrors[repo.id]
                          ? sessionSearchErrors[repo.id]
                          : `${filteredSessions.length} 个匹配结果`}
                    </small>
                  </div>
                )}
                <div className="session-manager-list" role="tablist" aria-label="会话历史">
                  {sessionGroups.map((group) => (
                    <section className="session-group" key={group.kind} aria-label={group.title}>
                      <div className="session-group-heading">
                        <span>{group.title}</span>
                        <small>{group.hint} · {group.items.length}</small>
                      </div>
                      {group.items.map((session) => {
                        const selected = session.id === activeSessionId;
                        const isRenaming = renamingSessionId === session.id;
                        const canRename = Boolean(session.codexSessionId);
                        const canArchiveSession = Boolean(session.codexSessionId);
                        const state = sessionUiState(session, activeSessionId, attention, projectActiveJobs);
                        return (
                          <article className={cx("session-row", `session-state-${state.kind}`, selected && "selected", isRenaming && "editing")} key={session.id}>
                            {isRenaming ? (
                              <form
                                className="session-rename-row"
                                onSubmit={(event) => {
                                  event.preventDefault();
                                  void commitRenameSession(session);
                                }}
                              >
                                <input
                                  autoFocus
                                  value={renameDraft}
                                  onChange={(event) => setRenameDraft(event.target.value)}
                                  onKeyDown={(event) => {
                                    if (event.key === "Escape") cancelRenameSession();
                                  }}
                                  disabled={Boolean(busyAction)}
                                  aria-label="会话名称"
                                />
                                <button className="icon-command" disabled={!renameDraft.trim() || Boolean(busyAction)} title="保存" type="submit">
                                  <CheckCircle2 size={15} />
                                </button>
                                <button className="icon-command" onClick={cancelRenameSession} title="取消" type="button">
                                  <X size={15} />
                                </button>
                              </form>
                            ) : (
                              <>
                                <button
                                  className="session-row-main"
                                  onClick={() => {
                                    if (!selected) onSelectSession(session.id);
                                    setActivePanel(null);
                                  }}
                                  disabled={busy}
                                  title={`${sessionDisplayTitle(session)} · ${sessionSubtitle(session)} · ${state.detail}`}
                                  type="button"
                                  role="tab"
                                  aria-selected={selected}
                                >
                                  <strong>{sessionDisplayTitle(session)}</strong>
                                  <small>
                                    <em className={cx("session-state-chip", state.kind)}>{state.label}</em>
                                    {sessionSubtitle(session)}
                                    {session.updatedAt ? ` · ${timeLabel(session.updatedAt)}` : ""}
                                  </small>
                                </button>
                                <div className="session-row-actions">
                                  <button
                                    className="icon-command"
                                    onClick={() => startRenameSession(session)}
                                    disabled={!canRename || Boolean(busyAction)}
                                    title={canRename ? "重命名" : "先发送消息建立会话"}
                                    type="button"
                                  >
                                    <Pencil size={14} />
                                  </button>
                                  {selected && (
                                    <button
                                      className="icon-command"
                                      onClick={onForkThread}
                                      disabled={!canUseThreadControls || Boolean(busyAction)}
                                      title="分支"
                                      type="button"
                                    >
                                      <GitBranch size={14} />
                                    </button>
                                  )}
                                  <button
                                    className={cx("icon-command", !canArchiveSession && "danger")}
                                    onClick={() => onDeleteSession(session.id)}
                                    disabled={busy || Boolean(busyAction) || (!canArchiveSession && sessions.length <= 1)}
                                    title={canArchiveSession ? "归档" : "删除草稿"}
                                    type="button"
                                  >
                                    {canArchiveSession ? <History size={14} /> : <Trash2 size={14} />}
                                  </button>
                                </div>
                              </>
                            )}
                          </article>
                        );
                      })}
                    </section>
                  ))}
                  {filteredSessions.length === 0 && (
                    <div className="session-empty-state">
                      <Search size={16} />
                      <span>没有匹配的会话</span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {attachments.length > 0 && (
          <div className="attachment-strip">
            {attachments.map((attachment, index) => (
              <span className={cx("attachment-chip", attachment.kind === "image" && "image")} key={`${attachment.path}-${index}`} title={attachment.path}>
                {attachment.kind === "image" && attachment.previewUrl ? (
                  <img alt={attachment.name} src={attachment.previewUrl} />
                ) : (
                  attachmentIcon(attachment)
                )}
                <span>
                  <strong>{attachment.name}</strong>
                  <small>{formatBytes(attachment.size)}</small>
                </span>
                <button
                  type="button"
                  onClick={() => onRemoveAttachment(index)}
                  disabled={busy}
                  title={`移除 ${attachment.name}`}
                  aria-label={`移除附件 ${attachment.name}`}
                >
                  <X size={13} />
                </button>
              </span>
            ))}
          </div>
        )}

        {(compactStatus?.running || compactStatus?.ok === false || percent >= 85) && (
          <div className={cx("context-inline-status", contextState)}>
            <span>
              {compactStatus?.running ? <Loader2 size={15} className="spin" /> : <Gauge size={15} />}
              上下文 {tokenUsage?.modelContextWindow ? `${percent}%` : "--"}
            </span>
            <small>{compactStatus?.running ? compactStatus.text : compactStatus?.ok === false ? compactStatus.error || "压缩失败" : contextDetail}</small>
            <button className="mini-action" onClick={onCompact} disabled={!canUseThreadControls || Boolean(busyAction)} type="button">
              {rawContextTokens > displayedContextTokens ? "立即压缩" : "压缩"}
            </button>
          </div>
        )}

        <div className="composer">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden-file-input"
            onChange={(event) => {
              if (event.target.files) onFilesSelected(event.target.files);
              event.currentTarget.value = "";
            }}
          />
          <textarea
            value={input}
            onChange={(event) => onInput(event.target.value)}
            onPaste={(event) => {
              const files = filesFromTransfer(event.clipboardData);
              if (files.length) {
                event.preventDefault();
                onFilesSelected(files);
              }
            }}
            onKeyDown={(event) => {
              const composing = Boolean(event.nativeEvent.isComposing);
              if (slashMode) {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setCommandIndex((current) => Math.min(current + 1, Math.max(filteredCommands.length - 1, 0)));
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setCommandIndex((current) => Math.max(current - 1, 0));
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  onInput("");
                  return;
                }
                if (event.key === "Enter" && !event.shiftKey && !composing) {
                  event.preventDefault();
                  chooseCommand();
                  return;
                }
              }
              if (skillMode || mentionMode) {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setCommandIndex((current) => Math.min(current + 1, Math.max(inlineSuggestions.length - 1, 0)));
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setCommandIndex((current) => Math.max(current - 1, 0));
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  onInput(input.slice(0, inlineTrigger?.start ?? input.length));
                  return;
                }
                if (event.key === "Enter" && !event.shiftKey && !composing && inlineSuggestions.length > 0) {
                  event.preventDefault();
                  chooseInlineSuggestion();
                  return;
                }
              }
              if (event.key === "Enter" && !event.shiftKey && !composing) {
                event.preventDefault();
                onSend();
              }
            }}
            placeholder={
              busy
                ? "继续补充当前回复"
                : busyAction === "compact"
                  ? "正在压缩上下文"
                  : "向云端 Codex 发送消息"
            }
          />
          <button
            className="icon-command attach-button"
            onClick={() => fileInputRef.current?.click()}
            disabled={Boolean(busyAction) || uploadingAttachments}
            title="上传截图或文件"
            aria-label={uploadingAttachments ? "正在上传附件" : "上传截图或文件"}
            type="button"
          >
            {uploadingAttachments ? <Loader2 size={17} className="spin" /> : <Paperclip size={17} />}
          </button>
          <button
            className="primary-command send-button"
            onClick={onSend}
            disabled={(!input.trim() && attachments.length === 0) || slashMode || uploadingAttachments || (Boolean(busyAction) && !busy)}
            aria-label={
              busy || busyAction === "compact"
                ? "云端 Codex 正在处理"
                : input.trim() || attachments.length > 0
                  ? "发送消息"
                  : "输入消息后发送"
            }
            type="button"
          >
            {busy || busyAction === "compact" ? <Loader2 size={17} className="spin" /> : <Send size={17} />}
          </button>
          <button
            className="icon-command clear-chat"
            onClick={busy ? onInterrupt : onClear}
            disabled={(Boolean(busyAction) && !busy) || (!busy && (canUseThreadControls || historyLoading || messages.length === 0))}
	            title={busy ? "打断当前回复" : canUseThreadControls ? "云端会话不能清空，请归档或新建会话" : "清空本地草稿会话"}
            aria-label={busy ? "打断当前回复" : canUseThreadControls ? "云端会话不能清空" : "清空本地草稿会话"}
            type="button"
          >
            {busy ? <Pause size={17} /> : <Trash2 size={17} />}
          </button>
        </div>
        <div className="composer-footer app-composer-footer">
          <div className="composer-footer-left">
            <button type="button" onClick={() => onInput("/")} disabled={Boolean(busyAction)} title="指令" aria-label="打开 Codex 指令">
              <Command size={14} />
              /
            </button>
            <button
              className={cx("footer-permission-chip", runtime.sandbox === "danger-full-access" && "full-access")}
              type="button"
              onClick={() => setActivePanel("permissions")}
              title={`${runtime.sandbox} · approval ${runtime.approval}`}
              aria-label={`权限：${permissionRuntimeLabel(runtime.sandbox, runtime.approval)}`}
            >
              <ShieldCheck size={14} />
              {permissionLabel(runtime.sandbox)}
            </button>
          </div>
          <div className="composer-footer-right">
            {goal && (
              <button className="footer-goal-chip" type="button" onClick={() => setActivePanel("goal")} title={goal.objective}>
                <Target size={12} />
                目标
              </button>
            )}
            <button type="button" onClick={() => setActivePanel("model")} aria-label={`模型：${activeModel?.displayName || runtime.model}`}>{activeModel?.displayName || runtime.model}</button>
            <button type="button" onClick={() => setActivePanel("reasoning")} aria-label={`推理深度：${reasoningLabel(runtime.reasoning)}`}>{reasoningLabel(runtime.reasoning)}</button>
            {showFooterContext && (
              <button className={cx("footer-context-chip", contextState)} type="button" onClick={() => setActivePanel("status")} title={contextDetail} aria-label={`上下文：${contextDetail}`}>
                {compactStatus?.running && <Loader2 size={12} className="spin" />}
                {compactStatus?.running ? "压缩中" : `${percent}% ctx`}
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function reasoningLabel(value: string) {
  const labels: Record<string, string> = {
    none: "无",
    minimal: "最少",
    low: "低",
    medium: "中",
    high: "高",
    xhigh: "超高",
    max: "最大",
    ultra: "Ultra",
  };
  return labels[value] || value;
}

function permissionLabel(sandbox: string) {
  if (sandbox === "read-only") return "只读";
  if (sandbox === "workspace-write") return "工作区写入";
  if (sandbox === "danger-full-access") return "全权限";
  return sandbox || "权限";
}

function approvalLabel(approval: string) {
  if (approval === "never") return "不询问";
  if (approval === "on-request") return "按需确认";
  if (approval === "on-failure") return "失败时确认";
  if (approval === "untrusted") return "受限确认";
  return approval || "审批";
}

function permissionRuntimeLabel(sandbox: string, approval: string) {
  return `${permissionLabel(sandbox)} · ${approvalLabel(approval)}`;
}

function agentFileEntryMeta(entry: AgentFileEntry) {
  if (entry.type === "directory") return "文件夹";
  return entry.size > 0 ? formatBytes(entry.size) : "文件";
}

function AgentTools({
  status,
  cloudConnection,
  repo,
  selectedRepoId,
  onSelectRepo,
  filePath,
  fileTree,
  selectedFile,
  fileDraft,
  terminalCommand,
  terminalResult,
  browserUrl,
  browserResult,
  busyAction,
  onFilePath,
  onFileDraft,
  onBrowserUrl,
  onTerminalCommand,
  onLoadTree,
  onOpenFile,
  onSaveFile,
  onRunTerminal,
  onRunBrowser,
}: {
  status: ConsoleStatus;
  cloudConnection: CloudConnection;
  repo: Repo;
  selectedRepoId: string;
  onSelectRepo: (id: string) => void;
  filePath: string;
  fileTree: AgentFileEntry[];
  selectedFile: AgentFileRead | null;
  fileDraft: string;
  terminalCommand: string;
  terminalResult: TerminalResult | null;
  browserUrl: string;
  browserResult: BrowserResult | null;
  busyAction: string | null;
  onFilePath: (value: string) => void;
  onFileDraft: (value: string) => void;
  onBrowserUrl: (value: string) => void;
  onTerminalCommand: (value: string) => void;
  onLoadTree: (path?: string) => void;
  onOpenFile: (entry: AgentFileEntry) => void;
  onSaveFile: () => void;
  onRunTerminal: () => void;
  onRunBrowser: () => void;
}) {
  const entryWarn = status.localMode || statusIsPending(status) || ["checking", "offline", "degraded"].includes(cloudConnection);
  return (
    <section className="agent-panel wide-panel">
      <div className="thread-header">
        <div className="thread-title">
          <div className="thread-avatar">
            <SlidersHorizontal size={19} />
          </div>
          <div>
            <p className="eyebrow">Agent 工作区</p>
            <h2>远端文件、终端与浏览器</h2>
          </div>
        </div>
        <span className={cx("status-pill", entryWarn ? "warn" : "ok")}>
          <Cloud size={15} />
          {cloudEntryLabel(status, cloudConnection)}
        </span>
      </div>

      <div className="repo-switcher" aria-label="选择工作目录">
        {status.repos.map((item) => (
          <button
            key={item.id}
            className={cx("repo-choice", selectedRepoId === item.id && "selected")}
            onClick={() => onSelectRepo(item.id)}
          >
            <span className={cx("repo-dot", item.accent)} />
            {item.name}
          </button>
        ))}
      </div>

      <div className="agent-grid">
        <section className="agent-card files-card">
          <div className="mini-header">
            <div>
              <p className="eyebrow">文件</p>
              <h3>{repo.name}</h3>
            </div>
            <button className="command-button" onClick={() => onLoadTree(filePath)} disabled={busyAction === "files"}>
              {busyAction === "files" ? <Loader2 size={16} className="spin" /> : <FolderOpen size={16} />}
              打开
            </button>
          </div>
          <div className="path-row">
            <input value={filePath} onChange={(event) => onFilePath(event.target.value)} />
          </div>
          <div className="file-list">
            {filePath !== "." && (
              <button onClick={() => onLoadTree(pathParent(filePath))}>
                <FolderOpen size={15} />
                ..
              </button>
            )}
            {busyAction === "files" && <p className="empty-copy">同步目录中...</p>}
            {!busyAction && fileTree.length === 0 && <p className="empty-copy">这个目录暂时没有可显示的文件。</p>}
            {fileTree.map((entry) => (
              <button key={entry.path} onClick={() => onOpenFile(entry)}>
                {entry.type === "directory" ? <FolderOpen size={15} /> : <FileText size={15} />}
                <span>{entry.name}</span>
                <small>{agentFileEntryMeta(entry)}</small>
              </button>
            ))}
          </div>
        </section>

        <section className="agent-card file-editor-card">
          <div className="mini-header">
            <div>
              <p className="eyebrow">编辑器</p>
              <h3>{selectedFile?.path || "未选择文件"}</h3>
            </div>
            <button className="primary-command" onClick={onSaveFile} disabled={!selectedFile || busyAction === "file-write"}>
              {busyAction === "file-write" ? <Loader2 size={16} className="spin" /> : <FileText size={16} />}
              保存
            </button>
          </div>
          <textarea
            value={fileDraft}
            onChange={(event) => onFileDraft(event.target.value)}
            placeholder="选择一个文件后可以查看和编辑云端工作区内容"
          />
        </section>

        <section className="agent-card terminal-card">
          <div className="mini-header">
            <div>
              <p className="eyebrow">终端</p>
              <h3 title="项目工作区">{displayWorktreePath(repo.path)}</h3>
            </div>
            <button className="primary-command" onClick={onRunTerminal} disabled={busyAction === "terminal" || !terminalCommand.trim()}>
              {busyAction === "terminal" ? <Loader2 size={16} className="spin" /> : <Terminal size={16} />}
              运行
            </button>
          </div>
          <textarea value={terminalCommand} onChange={(event) => onTerminalCommand(event.target.value)} />
          <pre>{terminalResult ? `$ ${terminalCommand}\n\n${terminalResult.stdout || ""}${terminalResult.stderr ? `\n${terminalResult.stderr}` : ""}` : "等待运行命令..."}</pre>
        </section>

        <section className="agent-card browser-card">
          <div className="mini-header">
            <div>
              <p className="eyebrow">浏览器</p>
              <h3>Playwright 验证</h3>
            </div>
            <button className="primary-command" onClick={onRunBrowser} disabled={busyAction === "browser" || !browserUrl.trim()}>
              {busyAction === "browser" ? <Loader2 size={16} className="spin" /> : <Globe2 size={16} />}
              检查
            </button>
          </div>
          <input value={browserUrl} onChange={(event) => onBrowserUrl(event.target.value)} />
          {browserResult ? (
            <div className="browser-result">
              <p className={cx("repo-state", browserResult.ok ? "ok" : "warn")}>
                {browserResult.ok ? `HTTP ${browserResult.status} · ${browserResult.title || "loaded"}` : browserResult.error || "检查失败"}
              </p>
              {Boolean(browserResult.errors?.length) && <pre>{browserResult.errors?.join("\n")}</pre>}
              {browserResult.screenshot && <img src={browserResult.screenshot} alt="Browser check screenshot" />}
            </div>
          ) : (
            <p className="empty-copy">运行后会展示标题、控制台错误和截图。</p>
          )}
        </section>
      </div>
    </section>
  );
}

function pathParent(value: string) {
  const parts = value.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/") || ".";
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function LogsView({
  status,
  statusReady,
  cloudConnection,
  logs,
}: {
  status: ConsoleStatus;
  statusReady: boolean;
  cloudConnection: CloudConnection;
  logs: LogFile[];
}) {
  const [auditFilter, setAuditFilter] = useState<AuditCategory>("all");
  const auditEvents = status.auditEvents || [];
  const auditLoaded = statusReady || auditEvents.length > 0 || Boolean(status.automationRuns?.length);
  const auditCounts = useMemo(() => {
    const counts: Record<AuditCategory, number> = {
      all: auditEvents.length,
      shell: 0,
      file: 0,
      network: 0,
      mcp: 0,
      approval: 0,
      automation: 0,
      host: 0,
    };
    for (const event of auditEvents) counts[auditEventCategory(event)] += 1;
    return counts;
  }, [auditEvents]);
  const filteredAuditEvents = auditFilter === "all" ? auditEvents : auditEvents.filter((event) => auditEventCategory(event) === auditFilter);

  return (
    <section className="logs-panel wide-panel">
      <div className="thread-header">
        <div className="thread-title">
          <div className="thread-avatar">
            <History size={19} />
          </div>
          <div>
              <p className="eyebrow">日志</p>
            <h2>运行日志</h2>
          </div>
        </div>
      </div>
      <div className="audit-grid">
        <section className="audit-block">
          <div className="mini-header">
            <div>
              <p className="eyebrow">审计</p>
              <h3>自动化运行</h3>
            </div>
            <span className="run-badge ok">{auditLoaded ? `${status.automationRuns?.length || 0} 条` : "同步中"}</span>
          </div>
          <div className="audit-list">
            {(status.automationRuns || []).slice(0, 8).map((run) => (
              <article key={run.id} className="audit-item">
                <strong>{run.name}</strong>
                <span>{runStatusLabel(run.status)} · {automationRunnerLabel(run.runner)} · {timeLabel(run.updatedAt)}</span>
                <small title={run.threadId || undefined}>{run.threadId ? "已关联会话" : "会话待建立"} · {automationWorktreeLabel(run.worktreePolicy)}</small>
                {run.worktreePath && <small title={displayWorktreePath(run.worktreePath)}>{displayWorktreePath(run.worktreePath)}</small>}
                {run.diffStat && <pre>{run.diffStat}</pre>}
                {run.error && <p className="warn-text">{displayAutomationText(run.error)}</p>}
                {run.events.length > 0 && (
                  <details className="audit-details">
                    <summary>事件</summary>
                    <pre>{run.events.slice(-12).map(displayRunEventLine).join("\n")}</pre>
                  </details>
                )}
              </article>
            ))}
            {!auditLoaded && <p className="empty-copy">同步自动化审计记录中。</p>}
            {auditLoaded && !status.automationRuns?.length && <p className="empty-copy">暂无自动化审计记录。</p>}
          </div>
        </section>
        <section className="audit-block">
          <div className="mini-header">
            <div>
              <p className="eyebrow">安全</p>
              <h3>权限、工具与仓库状态</h3>
            </div>
            <ShieldCheck size={16} />
          </div>
          <div className="status-grid compact">
            <span>Codex</span>
            <strong>{status.codex.mode}</strong>
            <span>默认权限</span>
            <strong title="danger-full-access · approval never">全权限 · 不询问</strong>
            <span>脏工作区</span>
            <strong>{status.repos.filter((repo) => repo.dirty).map((repo) => repo.name).join(", ") || "无"}</strong>
            <span>入口</span>
            <strong>{cloudEntryLabel(status, cloudConnection)}</strong>
          </div>
          <div className="audit-filter-row" aria-label="审计事件筛选">
            {auditCategoryTabs.map((tab) => (
              <button
                key={tab.id}
                className={cx("audit-filter", auditFilter === tab.id && "active")}
                type="button"
                onClick={() => setAuditFilter(tab.id)}
              >
                <span>{tab.label}</span>
                <strong>{auditLoaded ? auditCounts[tab.id] || 0 : "..."}</strong>
              </button>
            ))}
          </div>
          <div className="audit-list compact">
            {filteredAuditEvents.slice(0, 24).map((event) => {
              const category = auditEventCategory(event);
              return (
                <article className={cx("audit-item", "audit-event-item", `audit-${category}`)} key={event.id}>
                  <div className="audit-event-heading">
                    <span className="audit-event-icon">
                      <AuditEventIcon category={category} />
                    </span>
                    <div>
                      <strong>{displayAuditText(event.summary) || auditTypeLabel(event.type)}</strong>
                      <span>{timeLabel(event.time)} · {detailSourceLabel(event.source)}</span>
                    </div>
                    <em>{auditCategoryLabel(category)}</em>
                  </div>
                  <div className="audit-meta-line">
                    <small>{event.repoId || "仓库待识别"}</small>
                    <small>{event.threadId ? `会话 ${event.threadId.slice(0, 8)}` : "会话待建立"}</small>
                  </div>
                  <AuditDetailPanel event={event} />
                </article>
              );
            })}
            {!auditLoaded && <p className="empty-copy">同步工具审计事件中。</p>}
            {auditLoaded && !auditEvents.length && <p className="empty-copy">暂无工具审计事件。</p>}
            {auditLoaded && auditEvents.length > 0 && !filteredAuditEvents.length && <p className="empty-copy">当前分类没有审计事件。</p>}
          </div>
        </section>
      </div>
      <div className="log-grid">
        {logs.map((log) => (
          <article key={log.id} className="log-item">
            <div className="log-title">
              <strong>{log.name}</strong>
              <span>{shortDate(log.updatedAt)} · {log.size} bytes</span>
            </div>
            <pre>{displayLogTail(log.tail)}</pre>
          </article>
        ))}
      </div>
    </section>
  );
}

function SettingsView({
  status,
  repo,
  repoSelectionReady,
  appStatus,
  appStatusLoading,
  onRefresh,
  isRefreshing,
  onMcpLogin,
  onMcpReload,
  onCodexLogin,
  onCodexLoginCancel,
  onCodexLogout,
  codexAccountBusy,
  mcpLoginBusy,
  busyAction,
  externalNotificationBusy,
  pushNotificationBusy,
  browserPushEndpoint,
  browserPushReadiness,
  diagnostics,
  diagnosticsBusy,
  onExternalNotificationTest,
  onExternalNotificationCheck,
  onPushSubscribe,
  onPushUnsubscribe,
  onPushTest,
  onRunDiagnostics,
}: {
  status: ConsoleStatus;
  repo: Repo;
  repoSelectionReady: boolean;
  appStatus: CodexAppStatus;
  appStatusLoading: boolean;
  onRefresh: () => void;
  isRefreshing: boolean;
  onMcpLogin: (serverName: string) => void;
  onMcpReload: () => void;
  onCodexLogin: (type?: "chatgptDeviceCode" | "chatgpt") => void;
  onCodexLoginCancel: (loginId: string) => void;
  onCodexLogout: () => void;
  codexAccountBusy: "login" | "cancel" | "logout" | null;
  mcpLoginBusy: string | null;
  busyAction: string | null;
  externalNotificationBusy: string | null;
  pushNotificationBusy: "subscribe" | "unsubscribe" | "test" | null;
  browserPushEndpoint: string | null;
  browserPushReadiness: BrowserPushReadiness;
  diagnostics: CodexDiagnostics | null;
  diagnosticsBusy: boolean;
  onExternalNotificationTest: () => void;
  onExternalNotificationCheck: () => void;
  onPushSubscribe: () => void;
  onPushUnsubscribe: () => void;
  onPushTest: () => void;
  onRunDiagnostics: () => void;
}) {
  const external = status.externalNotifications || fallbackStatus.externalNotifications!;
  const push = status.pushNotifications || fallbackStatus.pushNotifications!;
  const currentBrowserSubscribed = Boolean(browserPushEndpoint);
  const pushSupported = browserPushReadiness.supported && push.supported;
  const pushBlocked = !push.configured || !pushSupported || browserPushReadiness.permission === "denied";
  const [showApiDetails, setShowApiDetails] = useState(false);
  const missingBrowserPushApis = [
    !browserPushReadiness.serviceWorker && "后台服务",
    !browserPushReadiness.pushManager && "后台通知",
    !browserPushReadiness.notifications && "系统通知",
  ].filter(Boolean);
  const permissionTone =
    browserPushReadiness.permission === "granted" ? "ok" : browserPushReadiness.permission === "denied" || browserPushReadiness.permission === "unsupported" ? "warn" : "neutral";
  const pushReadinessItems = [
    {
      id: "origin",
      label: "入口",
      value: browserPushReadiness.secureContext ? (browserPushReadiness.localOrigin ? "本地安全入口" : "HTTPS") : "需要 HTTPS",
      tone: browserPushReadiness.secureContext ? "ok" : "warn",
    },
    {
      id: "browser",
      label: "浏览器能力",
      value: missingBrowserPushApis.length ? `缺少 ${missingBrowserPushApis.join(" / ")}` : "后台通知可用",
      tone: missingBrowserPushApis.length ? "warn" : "ok",
    },
    {
      id: "permission",
      label: "通知权限",
      value:
        browserPushReadiness.permission === "granted"
          ? "已允许"
          : browserPushReadiness.permission === "denied"
            ? "已拒绝"
            : browserPushReadiness.permission === "unsupported"
              ? "不支持"
              : "订阅时询问",
      tone: permissionTone,
    },
    {
      id: "worker",
      label: "后台订阅",
      value: currentBrowserSubscribed ? "已订阅" : browserPushReadiness.workerRegistered ? "Worker 已注册" : browserPushReadiness.supported ? "订阅时创建" : "不可用",
      tone: currentBrowserSubscribed ? "ok" : browserPushReadiness.error ? "warn" : "neutral",
    },
  ];
  const activeAccountLogin = appStatus.accountLogin?.active || null;
  const codexAuthOk = appStatus.auth?.ok !== false && status.codex.authenticated;
  const usageLimit = appStatus.usageLimit || status.usageLimit || null;
  const accountUsage = appStatus.accountUsage?.summary;
  const lifetimeTokens = Number(accountUsage?.lifetimeTokens || 0);
  const peakDailyTokens = Number(accountUsage?.peakDailyTokens || 0);
  const credits = appStatus.rateLimits?.credits;
  const spendLimit = appStatus.rateLimits?.individualLimit;
  const appServerLive = status.appServerLive || appStatus.live || fallbackAppStatus.live!;
  const appStatusHasData =
    Boolean(appStatus.account) ||
    appStatus.mcpServers.length > 0 ||
    appStatus.plugins.available > 0 ||
    appStatus.skills.total > 0 ||
    appStatus.features.total > 0 ||
    appStatus.permissionProfiles.length > 0;
  const appStatusPending = appStatusLoading && !appStatusHasData;
  const quotaText = displayQuotaValue(
    usageLimit,
    `${typeof appStatus.rateLimits?.primary?.usedPercent === "number" ? `${appStatus.rateLimits.primary.usedPercent}% / 5h` : "未知"} · ${
      typeof appStatus.rateLimits?.secondary?.usedPercent === "number" ? `${appStatus.rateLimits.secondary.usedPercent}% / 7d` : "未知"
    }`,
  );
  return (
    <section className="settings-panel wide-panel">
      <div className="thread-header">
        <div className="thread-title">
          <div className="thread-avatar">
            <SlidersHorizontal size={19} />
          </div>
          <div>
            <p className="eyebrow">设置</p>
            <h2>控制台设置</h2>
          </div>
        </div>
        <button className="command-button" onClick={onRefresh}>
          <RefreshCw size={17} className={cx(isRefreshing && "spin")} />
          刷新
        </button>
      </div>
      <div className="settings-grid">
        <Metric label="云端工作区" value={status.instance.root ? "已连接" : "未配置"} title={status.instance.root} icon={<HardDrive size={16} />} />
        <Metric label="公网 IP" value={status.instance.publicIp} icon={<Cloud size={16} />} />
        <Metric label="私网 IP" value={status.instance.privateIp} icon={<Wifi size={16} />} />
        <Metric label="Codex 认证" value={status.codex.mode} icon={<ShieldCheck size={16} />} />
      </div>
      {Boolean(status.capabilityWarnings?.length) && (
        <div className="settings-copy warning-copy">
          <strong>能力提示</strong>
          {status.capabilityWarnings?.map((item) => (
            <p key={item.id}>
              <code>{attentionTypeLabel(item.type)}</code> {displayCapabilityText(item.title)}
              {item.body ? ` · ${displayCapabilityText(item.body)}` : ""}
            </p>
          ))}
        </div>
      )}
      <div className="settings-copy diagnostic-panel">
        <div className="settings-section-head">
          <strong>Codex 诊断</strong>
          <button className="mini-action" type="button" onClick={onRunDiagnostics} disabled={diagnosticsBusy || Boolean(busyAction)}>
            {diagnosticsBusy ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
            运行诊断
          </button>
        </div>
        <p>
          {diagnostics
            ? `最近 ${timeLabel(diagnostics.generatedAt)} · ${diagnostics.summary.ok} 正常 · ${diagnostics.summary.warn} 提醒 · ${diagnostics.summary.danger} 问题`
            : "检查 Codex CLI 版本、登录状态、云端协议、会话列表和 MCP/plugin/skills 等能力。"}
        </p>
        {diagnostics && (
          <div className="diagnostic-list">
            {diagnostics.checks.map((check) => (
              <details className="diagnostic-check" data-tone={check.tone} key={check.id} open={check.tone === "danger"}>
                <summary>
                  <span>{diagnosticCheckLabel(check)}</span>
                  <strong>{diagnosticToneLabel(check.tone)}</strong>
                </summary>
                <p>{displayDiagnosticText(check.summary)}</p>
                <small>{Math.round(check.durationMs)} 毫秒</small>
                {check.detail && <pre>{displayDiagnosticText(check.detail)}</pre>}
              </details>
            ))}
          </div>
        )}
      </div>
      <div className={cx("settings-copy", !codexAuthOk && "warning-copy")}>
        <div className="settings-section-head">
          <strong>Codex 账号</strong>
          <div className="settings-action-row">
            <button className="mini-action" type="button" onClick={() => onCodexLogin("chatgptDeviceCode")} disabled={Boolean(codexAccountBusy) || Boolean(busyAction)}>
              {codexAccountBusy === "login" ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
              重新登录
            </button>
            <button className="mini-action" type="button" onClick={onCodexLogout} disabled={Boolean(codexAccountBusy) || Boolean(busyAction)}>
              {codexAccountBusy === "logout" ? <Loader2 size={13} className="spin" /> : <X size={13} />}
              退出
            </button>
          </div>
        </div>
        <div className="mini-list">
          <span>
            {appStatus.account?.email || "未知账号"} · {appStatus.account?.planType || status.codex.mode || "未知套餐"}
          </span>
          <span className={codexAuthOk ? "" : "warn-text"}>
            {codexAuthOk ? "登录有效" : appStatus.auth?.issue || status.codex.detail || "需要重新登录 Codex"}
          </span>
          <span className={usageLimit ? "warn-text" : ""} title={usageLimit?.message || usageLimit?.body || quotaText}>
            额度 {appStatusPending ? "同步中" : quotaText}
          </span>
          {lifetimeTokens > 0 && <span>累计使用 {formatTokenCount(lifetimeTokens)} tokens · 单日峰值 {formatTokenCount(peakDailyTokens)}</span>}
          {credits?.hasCredits && <span>Codex 余额 {credits.unlimited ? "不限量" : credits.balance || "可用"}</span>}
          {spendLimit && (
            <span className={appStatus.rateLimits?.spendControlReached ? "warn-text" : ""}>
              用量控制 {spendLimit.used || "0"} / {spendLimit.limit || "未知"} · 剩余 {Math.max(0, Number(spendLimit.remainingPercent || 0))}%
            </span>
          )}
          {activeAccountLogin && (
            <div className="account-flow-card">
              <div className="account-flow-head">
                <strong>授权码 {activeAccountLogin.userCode || activeAccountLogin.loginId.slice(0, 8)}</strong>
                <button
                  className="mini-action"
                  type="button"
                  onClick={() => onCodexLoginCancel(activeAccountLogin.loginId)}
                  disabled={Boolean(codexAccountBusy) || Boolean(busyAction)}
                >
                  {codexAccountBusy === "cancel" ? <Loader2 size={13} className="spin" /> : <X size={13} />}
                  取消授权
                </button>
              </div>
              <span>在打开的 OpenAI 页面完成授权后，云端 Codex 会自动刷新账号状态。</span>
            </div>
          )}
        </div>
      </div>
      <div className="settings-copy">
        <div className="settings-section-head">
          <strong>MCP 服务器</strong>
          <button className="mini-action" type="button" onClick={onMcpReload} disabled={Boolean(busyAction)}>
            {busyAction === "mcp-reload" ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
            刷新
          </button>
        </div>
        <div className="mini-list">
          {appStatus.mcpServers.map((server) => {
            const startup = appServerLive.mcpStartup?.[server.name];
            return (
              <span key={server.name} className="mcp-row">
                <span>
                  {server.name}: {mcpAuthStatusLabel(server.authStatus)} · {server.toolCount} 个工具
                  {startup ? ` · 启动 ${runStatusLabel(startup.status)}${startup.error ? ` (${displayCapabilityText(startup.error)})` : ""}` : ""}
                </span>
                {mcpAuthNeedsLogin(server.authStatus) && (
                  <button
                    type="button"
                    className="mini-action"
                    onClick={() => onMcpLogin(server.name)}
                    disabled={Boolean(mcpLoginBusy) || Boolean(busyAction)}
                  >
                    {mcpLoginBusy === server.name ? <Loader2 size={13} className="spin" /> : <Globe2 size={13} />}
                    登录
                  </button>
                )}
              </span>
            );
          })}
          {!appStatus.mcpServers.length && <span>同步云端 MCP 状态中。</span>}
                  {appStatus.mcpOauthResults?.slice(0, 3).map((result) => (
                    <span key={`${result.name}-${result.time}`} className={result.success ? "" : "warn-text"}>
                      {result.name} OAuth {result.success ? "已完成" : displayCapabilityText(result.error || "失败")} · {timeLabel(result.time)}
                    </span>
                  ))}
        </div>
      </div>
      {repoSelectionReady ? (
        <Suspense fallback={<div className="settings-copy"><span className="empty-copy">正在载入插件目录...</span></div>}>
          <LazyCodexPluginManager repoId={repo.id} onChanged={onRefresh} />
        </Suspense>
      ) : (
        <div className="settings-copy"><span className="empty-copy">正在读取项目配置...</span></div>
      )}
      <div className="settings-copy">
        <div className="settings-section-head">
          <strong>云端实时事件</strong>
          <small>{appServerLive.latestEvents?.[0] ? `最近 ${timeLabel(appServerLive.latestEvents[0].time)}` : "暂无推送事件"}</small>
        </div>
        <div className="mini-list">
          {appServerLive.latestEvents?.slice(0, 5).map((event) => (
            <span key={event.id} className={event.tone === "warn" ? "warn-text" : ""}>
              {displayLiveEventLine(event)}
            </span>
          ))}
          {appServerLive.skillsChangedAt && <span>Skills 元数据变更 · {timeLabel(appServerLive.skillsChangedAt)}</span>}
          {appServerLive.appListUpdated && (
            <span>App 列表 {appServerLive.appListUpdated.count} 个 · {timeLabel(appServerLive.appListUpdated.updatedAt)}</span>
          )}
          {appServerLive.remoteControl && (
            <span>远端控制 {runStatusLabel(appServerLive.remoteControl.status)} · {appServerLive.remoteControl.serverName || "未知服务"}</span>
          )}
          {Object.values(appServerLive.mcpStartup || {}).slice(0, 6).map((server) => (
            <span key={`settings-startup-${server.name}`} className={server.status === "failed" ? "warn-text" : ""}>
              MCP {server.name} 启动 {runStatusLabel(server.status)}{server.error ? ` · ${displayCapabilityText(server.error)}` : ""} · {timeLabel(server.updatedAt)}
            </span>
          ))}
          {!appServerLive.latestEvents?.length && !appServerLive.skillsChangedAt && !appServerLive.appListUpdated && !appServerLive.remoteControl && !Object.keys(appServerLive.mcpStartup || {}).length && (
            <span>等待云端 Codex 推送 MCP、Skills、App 或模型状态变化。</span>
          )}
        </div>
      </div>
      <div className="settings-copy external-notification-panel">
        <div className="settings-section-head">
          <strong>外部通知</strong>
          <div className="settings-action-row">
            <button className="mini-action" type="button" onClick={onExternalNotificationCheck} disabled={Boolean(externalNotificationBusy)}>
              {externalNotificationBusy === "check" ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
              立即检查
            </button>
            <button
              className="mini-action"
              type="button"
              onClick={onExternalNotificationTest}
              disabled={Boolean(externalNotificationBusy) || !external.configured}
            >
              {externalNotificationBusy === "test" ? <Loader2 size={13} className="spin" /> : <Bell size={13} />}
              测试
            </button>
          </div>
        </div>
        <p>
          {external.configured
            ? `已启用跨设备通知。云端每 ${Math.round((external.pollMs || 60000) / 1000)} 秒检查未读待处理项，并按已读状态去重。`
            : "跨设备通知尚未配置。启用任一通知通道后，云端会把未读待处理项去重发送到外部设备。"}
        </p>
        <div className="external-channel-list">
          {external.channels.map((channel) => (
            <span className={cx("external-channel", channel.enabled && "enabled")} key={channel.id}>
              <span>
                <strong>{externalChannelLabel(channel)}</strong>
                <small>{channel.enabled ? channel.target || "已配置" : "未配置"}</small>
              </span>
              <em>{channel.lastDeliveredAt ? `最近 ${timeLabel(channel.lastDeliveredAt)}` : channel.enabled ? "等待发送" : "未启用"}</em>
            </span>
          ))}
        </div>
        <div className="mini-list">
          <span>已发送记录：{external.deliveredCount}</span>
          <span>最近检查：{external.lastCheckAt ? timeLabel(external.lastCheckAt) : "尚未检查"}</span>
          <span>最近发送：{external.lastSentAt ? timeLabel(external.lastSentAt) : "尚未发送"}</span>
          {external.lastError && <span className="warn-text">最近错误：{external.lastError}</span>}
        </div>
      </div>
      <div className={cx("settings-copy", "external-notification-panel", pushBlocked && !currentBrowserSubscribed && "warning-copy")}>
        <div className="settings-section-head">
          <strong>浏览器通知</strong>
          <div className="settings-action-row">
            <button
              className="mini-action"
              type="button"
              onClick={currentBrowserSubscribed ? onPushUnsubscribe : onPushSubscribe}
              disabled={Boolean(pushNotificationBusy) || (!currentBrowserSubscribed && pushBlocked)}
            >
              {pushNotificationBusy === "subscribe" || pushNotificationBusy === "unsubscribe" ? <Loader2 size={13} className="spin" /> : <Bell size={13} />}
              {currentBrowserSubscribed ? "取消订阅" : "订阅本机"}
            </button>
            <button
              className="mini-action"
              type="button"
              onClick={onPushTest}
              disabled={Boolean(pushNotificationBusy) || !push.subscriptionCount}
            >
              {pushNotificationBusy === "test" ? <Loader2 size={13} className="spin" /> : <Send size={13} />}
              测试
            </button>
          </div>
        </div>
        <p>
          {push.configured && pushSupported
            ? currentBrowserSubscribed
              ? "当前浏览器已接入后台通知，页面关闭后也能收到未读待处理提醒。"
              : "当前入口满足后台通知条件；订阅后，通知点击会直达对应会话或任务。"
            : !push.configured
              ? "云端还没有可用的后台通知密钥，浏览器通知暂不能订阅。"
              : browserPushReadiness.permission === "denied"
                ? "浏览器已拒绝通知权限，需要先在站点设置里恢复权限。"
                : !browserPushReadiness.secureContext
                  ? "浏览器通知需要 HTTPS 或 localhost/127.0.0.1 这类安全入口。"
                  : "当前浏览器缺少后台通知能力；可继续使用页面通知或外部通知。"}
        </p>
        <div className="push-readiness-list" aria-label="浏览器通知可用性">
          {pushReadinessItems.map((item) => (
            <span className="push-readiness-item" data-tone={item.tone} key={item.id}>
              <strong>{item.label}</strong>
              <small>{item.value}</small>
            </span>
          ))}
        </div>
        {browserPushReadiness.error && <p className="warn-text">后台通知状态读取失败：{browserPushReadiness.error}</p>}
        <div className="external-channel-list push-channel-list">
          <span className={cx("external-channel", push.configured && "enabled")}>
            <span>
              <strong>后台通知密钥</strong>
              <small>{push.configured ? "已配置" : "未配置"}</small>
            </span>
            <em>{push.configured ? "已就绪" : "未启用"}</em>
          </span>
          <span className={cx("external-channel", currentBrowserSubscribed && "enabled")}>
            <span>
              <strong>当前浏览器</strong>
              <small>{currentBrowserSubscribed ? "已订阅" : browserPermissionLabel(browserPushReadiness.permission)}</small>
            </span>
            <em>{currentBrowserSubscribed ? "已订阅" : "未启用"}</em>
          </span>
          <span className={cx("external-channel", push.subscriptionCount > 0 && "enabled")}>
            <span>
              <strong>设备</strong>
              <small>{push.subscriptionCount} 个订阅</small>
            </span>
            <em>{push.lastDeliveredAt ? `最近 ${timeLabel(push.lastDeliveredAt)}` : "等待发送"}</em>
          </span>
        </div>
        <div className="mini-list">
          <span>当前入口：{browserPushReadiness.secureContext ? (browserPushReadiness.localOrigin ? "本地安全入口" : "HTTPS") : "需要 HTTPS"}</span>
          {browserPushReadiness.workerScope && <span>后台范围已注册</span>}
          <span>最近测试：{push.lastTestAt ? timeLabel(push.lastTestAt) : "尚未测试"}</span>
          {push.lastError && <span className="warn-text">最近错误：{push.lastError}</span>}
          {push.subscriptions.slice(0, 3).map((subscription) => (
            <span key={subscription.id}>
              设备订阅 · {subscription.lastSeenAt ? timeLabel(subscription.lastSeenAt) : "刚创建"}
            </span>
          ))}
        </div>
      </div>
      <div className="settings-copy">
        <strong>云端控制接口</strong>
        <p>会话、仓库同步、自动化和状态刷新都已连接到云端控制层。</p>
        <details className="settings-technical-details" onToggle={(event) => setShowApiDetails(event.currentTarget.open)}>
          <summary>查看接口详情</summary>
          {showApiDetails && (
            <p>
              默认界面隐藏底层路径；排障时可查看 <code>/api/status</code>、<code>/api/chat</code>、<code>/api/repos/:id/pull</code> 和
              <code>/api/automations/:id/run</code>。
            </p>
          )}
        </details>
      </div>
    </section>
  );
}

function CloudStatus({
  status,
  cloudConnection,
  onOpenThread,
}: {
  status: ConsoleStatus;
  cloudConnection?: CloudConnection;
  onOpenThread?: (repoId: string, sessionId: string) => void;
}) {
  const activeJobs = status.activeJobs || [];
  const appServerLabel = appServerLayerLabel(status, cloudConnection);
  return (
    <section className="rail-card">
      <div className="rail-card-header">
        <h3>云端状态</h3>
        <span className={cx("mini-dot", status.codex.authenticated && "ok")} />
      </div>
      <dl className="detail-list">
        <div>
          <dt>实例</dt>
          <dd>{status.instance.name}</dd>
        </div>
        <div>
          <dt>规格</dt>
          <dd>{status.instance.type}</dd>
        </div>
        <div>
          <dt>公网</dt>
          <dd>{status.instance.publicIp}</dd>
        </div>
        <div>
          <dt>Codex</dt>
          <dd>{status.codex.mode}</dd>
        </div>
        <div>
          <dt>云端 Codex</dt>
          <dd>{appServerLabel}</dd>
        </div>
        <div>
          <dt>运行中</dt>
          <dd>{activeJobs.length}</dd>
        </div>
      </dl>
      <ActiveJobList jobs={activeJobs} onOpenThread={onOpenThread} />
    </section>
  );
}

function RepoCard({ repo }: { repo: Repo }) {
  return (
    <section className="rail-card">
      <div className="rail-card-header">
        <h3>仓库</h3>
        <span className={cx("repo-dot", repo.accent)} />
      </div>
      <div className="repo-summary">
        <strong>{repo.name}</strong>
        <span>{repo.remote}</span>
      </div>
      <div className="repo-meta">
        <span>
          <GitBranch size={14} />
          {repo.branch}
        </span>
        <span>
          <Code2 size={14} />
          {repo.commit}
        </span>
      </div>
      <p className={cx("repo-state", repo.dirty ? "warn" : "ok")}>{repo.dirty ? "存在未提交改动" : "工作区干净"}</p>
      <p className="last-commit">{repo.lastCommit}</p>
    </section>
  );
}

function LogCard({ logs, automation }: { logs: LogFile[]; automation: Automation }) {
  const relevant = logs.find((log) => log.job.includes(automation.id)) || logs[0];

  return (
    <section className="rail-card log-card">
      <div className="rail-card-header">
        <h3>日志</h3>
        <HardDrive size={16} />
      </div>
      {relevant ? (
        <>
          <div className="log-title">
            <strong>{relevant.name}</strong>
            <span>{shortDate(relevant.updatedAt)}</span>
          </div>
          <pre>{displayLogTail(relevant.tail)}</pre>
        </>
      ) : (
        <p className="empty-copy">暂无日志</p>
      )}
    </section>
  );
}
