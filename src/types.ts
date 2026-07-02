export type Repo = {
  id: string;
  name: string;
  path: string;
  remote: string;
  accent: "teal" | "blue" | "amber";
  present: boolean;
  branch: string;
  commit: string;
  dirty: boolean;
  statusText: string;
  lastCommit: string;
};

export type Automation = {
  id: string;
  name: string;
  repoId: string;
  timer: string;
  service: string;
  schedule: string;
  model: string;
  reasoning: string;
  prompt?: string;
  enabled: boolean;
  nextRun: string;
  lastRun: string;
  run: {
    activeState: string;
    failedState: string;
    exitCode: string;
    logName: string | null;
    logUpdatedAt: string | null;
    logTail: string[];
  };
};

export type AutomationRunEvent = {
  time: string;
  type: string;
  text: string;
};

export type AutomationRun = {
  id: string;
  automationId: string;
  repoId: string;
  name: string;
  trigger: string;
  runner: string;
  status: string;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  threadId: string | null;
  sessionId: string | null;
  worktreePath: string | null;
  worktreePolicy: string;
  model: string | null;
  reasoning: string | null;
  prompt: string;
  summary: string;
  diffStat: string;
  error: string | null;
  events: AutomationRunEvent[];
};

export type AutomationInbox = {
  needsAttention: AutomationRun[];
  active: AutomationRun[];
  recent: AutomationRun[];
  archived: AutomationRun[];
};

export type ActiveCodexJob = {
  id: string;
  kind: "turn" | "compact" | string;
  status: "running" | "completed" | "failed" | string;
  title: string;
  body: string;
  repoId: string | null;
  sessionId: string | null;
  threadId: string | null;
  turnId: string | null;
  startedAt: string;
  message: string;
  runtime: {
    model: string | null;
    reasoning: string | null;
    sandbox: string | null;
    approval: string | null;
    search: boolean | null;
  };
  completed: boolean;
  ok: boolean | null;
  error: string | null;
  latestEvent: { id: string | number | null; event: string; time: string; text: string } | null;
  eventCount: number;
  events?: Array<{ id: string | number | null; event: string; time: string; text: string }>;
};

export type AttentionItem = {
  id: string;
  type: "auth" | "automation" | "audit" | "repo" | string;
  tone: "danger" | "active" | "neutral" | string;
  title: string;
  body: string;
  time: string;
  repoId?: string | null;
  automationId?: string | null;
  runId?: string | null;
  sessionId?: string | null;
  threadId?: string | null;
  itemId?: string | null;
  serverName?: string | null;
  actionUrl?: string | null;
  actionLabel?: string | null;
  acknowledged?: boolean;
  acknowledgedAt?: string | null;
  action: "settings" | "thread" | "automation" | "logs" | "repo" | string;
};

export type AttentionSummary = {
  count: number;
  unreadCount?: number;
  totalCount?: number;
  acknowledgedCount?: number;
  needsAttentionCount: number;
  activeCount: number;
  dirtyRepoCount: number;
  auditIssueCount: number;
  capabilityWarningCount?: number;
  diagnosticsWarningCount?: number;
  latestItemId: string;
  latestTitle: string;
  items: AttentionItem[];
};

export type ExternalNotificationChannel = {
  id: string;
  label: string;
  enabled: boolean;
  target: string;
  lastDeliveredAt: string | null;
  lastError: string | null;
};

export type ExternalNotifications = {
  configured: boolean;
  channels: ExternalNotificationChannel[];
  deliveredCount: number;
  lastCheckAt: string | null;
  lastSentAt: string | null;
  lastError: string | null;
  pollMs: number;
};

export type PushNotificationSubscription = {
  id: string;
  endpoint: string;
  userAgent: string;
  lastSeenAt: string | null;
  lastDeliveredAt: string | null;
  lastError: string | null;
};

export type PushNotifications = {
  supported: boolean;
  configured: boolean;
  publicKey: string;
  subject: string;
  subscriptionCount: number;
  subscriptions: PushNotificationSubscription[];
  lastDeliveredAt: string | null;
  lastTestAt: string | null;
  lastError: string | null;
};

export type CodexDiagnosticCheck = {
  id: string;
  label: string;
  ok: boolean;
  tone: "ok" | "warn" | "danger" | "active" | string;
  summary: string;
  detail: string;
  durationMs: number;
};

export type CodexDiagnostics = {
  ok: boolean;
  generatedAt: string;
  repoId: string;
  summary: { total: number; ok: number; warn: number; danger: number };
  checks: CodexDiagnosticCheck[];
};

export type AppServerLiveEvent = {
  id: string;
  time: string;
  type: string;
  title: string;
  body: string;
  tone: "ok" | "warn" | "info" | "active" | string;
  repoId?: string | null;
  sessionId?: string | null;
  threadId?: string | null;
  turnId?: string | null;
  data?: unknown;
};

export type AppServerLiveSnapshot = {
  latestEvents: AppServerLiveEvent[];
  mcpStartup: Record<string, { name: string; status: string; error?: string | null; updatedAt: string }>;
  skillsChangedAt?: string | null;
  appListUpdated?: { count: number; updatedAt: string } | null;
  remoteControl?: {
    status: string;
    serverName: string;
    installationId: string;
    environmentId?: string | null;
    updatedAt: string;
  } | null;
};

export type AuditEvent = {
  id: string;
  time: string;
  source: string;
  type: string;
  repoId: string | null;
  sessionId: string | null;
  threadId: string | null;
  turnId: string | null;
  itemId: string | null;
  summary: string;
  detail: string;
};

export type LogFile = {
  id: string;
  job: string;
  name: string;
  size: number;
  updatedAt: string;
  tail: string[];
};

export type ConsoleStatus = {
  generatedAt: string;
  localMode: boolean;
  health?: {
    ok: boolean;
    layers: {
      ec2Console: {
        ok: boolean;
        port?: number;
        host?: string;
        time?: string;
      };
      appServer: {
        ok: boolean;
        running: boolean;
        startedAt: string | null;
        restartCount: number;
        lastError: string | null;
      };
      codexAuth: {
        ok: boolean;
        mode: string;
        detail: string;
      };
      repos: Array<{
        id: string;
        ok: boolean;
        path: string;
        branch: string;
        dirty: boolean;
      }>;
    };
  };
  instance: {
    name: string;
    region: string;
    publicIp: string;
    privateIp: string;
    type: string;
    root: string;
  };
  codex: {
    authenticated: boolean;
    mode: string;
    detail: string;
  };
  usageLimit?: {
    code?: string | null;
    message?: string;
    retryAtText?: string | null;
    title?: string;
    body?: string;
  } | null;
  repos: Repo[];
  automations: Automation[];
  automationRuns?: AutomationRun[];
  automationInbox?: AutomationInbox;
  activeJobs?: ActiveCodexJob[];
  attention?: AttentionSummary;
  externalNotifications?: ExternalNotifications;
  pushNotifications?: PushNotifications;
  diagnostics?: CodexDiagnostics | null;
  capabilityWarnings?: AttentionItem[];
  appServerLive?: AppServerLiveSnapshot;
  auditEvents?: AuditEvent[];
  logs: LogFile[];
  events: Array<{ tone: "ok" | "warn" | "info"; text: string }>;
};

export type ChatSessionRuntime = {
  codexSessionId?: string | null;
  model?: string | null;
  reasoning?: string | null;
  sandbox?: string | null;
  approval?: string | null;
  search?: boolean | null;
};
