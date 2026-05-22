import {
  Activity,
  Bot,
  CheckCircle2,
  ChevronRight,
  Circle,
  Cloud,
  Code2,
  GitBranch,
  GitPullRequestArrow,
  HardDrive,
  History,
  Loader2,
  MessageSquare,
  Pause,
  Play,
  RefreshCw,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Terminal,
  Timer,
  Wifi,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Automation, ConsoleStatus, LogFile, Repo } from "./types";

type RunEvent = {
  id: string;
  time: string;
  tone: "ok" | "warn" | "info";
  title: string;
  body: string;
};

type ActiveView = "automations" | "console" | "logs" | "settings";

type ChatMessage = {
  id: string;
  role: "user" | "codex";
  text: string;
  time: string;
  mocked?: boolean;
  streaming?: boolean;
  status?: string;
};

const fallbackRun = {
  activeState: "inactive",
  failedState: "inactive",
  exitCode: "0",
  logName: "memory-export-refresh-latest.log",
  logUpdatedAt: new Date().toISOString(),
  logTail: ["CLOUD_PULL_DONE", "Timer waiting for next run"],
};

const fallbackStatus: ConsoleStatus = {
  generatedAt: new Date().toISOString(),
  localMode: true,
  instance: {
    name: "codex-cloud-worker",
    region: "ap-northeast-1",
    publicIp: "54.199.2.92",
    privateIp: "172.31.7.169",
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
      id: "invest-dashboard",
      name: "invest-dashboard",
      path: "/home/ubuntu/codex-cloud/workspace/invest-dashboard",
      remote: "WilsonWang01/invest-dashboard",
      accent: "teal",
      present: true,
      branch: "main",
      commit: "7415506",
      dirty: false,
      statusText: "## main...origin/main",
      lastCommit: "Refresh dashboard research workflow",
    },
    {
      id: "macro-control-dashboard",
      name: "macro-control-dashboard",
      path: "/home/ubuntu/codex-cloud/workspace/macro-control-dashboard",
      remote: "WilsonWang01/macro-control-dashboard",
      accent: "blue",
      present: true,
      branch: "main",
      commit: "1c6c82b",
      dirty: false,
      statusText: "## main...origin/main",
      lastCommit: "Update macro dashboard",
    },
    {
      id: "memory-export-tracker",
      name: "memory-export-tracker",
      path: "/home/ubuntu/codex-cloud/workspace/memory-export-tracker",
      remote: "WilsonWang01/memory-export-tracker",
      accent: "amber",
      present: true,
      branch: "main",
      commit: "ce18209",
      dirty: false,
      statusText: "## main...origin/main",
      lastCommit: "Update Korea semiconductor export tracking data",
    },
  ],
  automations: [
    {
      id: "invest-daily-update",
      name: "投资监控每日更新",
      repoId: "invest-dashboard",
      timer: "codex-auto-invest-daily-update.timer",
      service: "codex-auto-invest-daily-update.service",
      schedule: "工作日 09:30",
      model: "gpt-5.5",
      reasoning: "high",
      enabled: true,
      nextRun: "今天 09:30",
      lastRun: "尚未运行",
      run: fallbackRun,
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
      enabled: true,
      nextRun: "今天 09:50",
      lastRun: "尚未运行",
      run: fallbackRun,
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
      enabled: true,
      nextRun: "今天 18:30",
      lastRun: "尚未运行",
      run: fallbackRun,
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
      enabled: true,
      nextRun: "明天 00:38",
      lastRun: "今天 00:38",
      run: fallbackRun,
    },
  ],
  logs: [
    {
      id: "mock-log",
      job: "memory-export-refresh",
      name: "memory-export-refresh-latest.log",
      size: 619,
      updatedAt: new Date().toISOString(),
      tail: ["codex exec completed", "Timer waiting for next run"],
    },
  ],
  events: [
    { tone: "ok", text: "GitHub credentials are available on the cloud worker." },
    { tone: "ok", text: "System timers are enabled and waiting." },
    { tone: "info", text: "Cloud console is ready." },
  ],
};

function cx(...classes: Array<string | false | undefined>) {
  return classes.filter(Boolean).join(" ");
}

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json() as Promise<T>;
}

function timeLabel(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function shortDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function App() {
  const [status, setStatus] = useState<ConsoleStatus>(fallbackStatus);
  const [selectedAutomationId, setSelectedAutomationId] = useState("invest-daily-update");
  const [selectedRepoId, setSelectedRepoId] = useState("invest-dashboard");
  const [activeView, setActiveView] = useState<ActiveView>("automations");
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [fullLog, setFullLog] = useState<{ name: string; content: string; mocked?: boolean } | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const selectedAutomation = useMemo(
    () => status.automations.find((item) => item.id === selectedAutomationId) || status.automations[0],
    [selectedAutomationId, status.automations],
  );
  const selectedRepo = useMemo(
    () => status.repos.find((item) => item.id === selectedRepoId) || status.repos[0],
    [selectedRepoId, status.repos],
  );

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

  const refresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const next = await api<ConsoleStatus>("/api/status");
      setStatus(next);
      pushEvent({
        tone: next.localMode ? "warn" : "ok",
        title: "状态刷新",
        body: next.localMode ? "本地 mock 快照已加载" : "云端 worker 状态已同步",
      });
    } catch (error) {
      setStatus(fallbackStatus);
      pushEvent({
        tone: "warn",
        title: "状态刷新",
        body: error instanceof Error ? error.message : "API 暂不可用，已使用内置快照",
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

  const sendChat = async () => {
    const message = chatInput.trim();
    if (!message || busyAction) return;
    const now = new Date().toISOString();
    const responseId = `${Date.now()}-codex`;
    setChatInput("");
    setChatMessages((current) => [
      ...current,
      { id: `${Date.now()}-user`, role: "user", text: message, time: now },
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
        body: JSON.stringify({ repoId: selectedRepo.id, message }),
      });
      if (!response.ok || !response.body) {
        throw new Error(await response.text());
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let mocked = false;
      let collected = "";
      let stderr = "";

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
          mocked = Boolean(payload.mocked);
          patchResponse({ mocked });
          return;
        }
        if (event === "status") {
          patchResponse({ status: String(payload.text || "") });
          return;
        }
        if (event === "stderr") {
          stderr += String(payload.text || "");
          patchResponse({ status: "Codex 正在运行，收到运行日志..." });
          return;
        }
        if (event === "delta") {
          const text = String(payload.text || "");
          collected += text;
          patchResponse((item) => ({ text: `${item.text}${text}`, status: "正在生成..." }));
          return;
        }
        if (event === "error") {
          patchResponse({ text: String(payload.message || "云端 Codex 对话失败"), mocked: true, streaming: false });
          return;
        }
        if (event === "done") {
          const ok = Boolean(payload.ok);
          patchResponse({
            text: collected || stderr || (ok ? "Codex completed without output." : "云端 Codex 没有返回内容。"),
            mocked,
            streaming: false,
            status: ok ? "完成" : `退出码 ${payload.code ?? "unknown"}`,
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
    } catch (error) {
      setChatMessages((current) =>
        current.map((item) =>
          item.id === responseId
            ? {
                ...item,
                role: "codex",
                text: error instanceof Error ? error.message : "云端 Codex 对话失败",
                time: new Date().toISOString(),
                mocked: true,
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

  return (
    <main className="app-shell">
      <Sidebar
        status={status}
        activeView={activeView}
        selectedRepoId={selectedRepoId}
        onSelectView={setActiveView}
        onSelectRepo={(repoId) => {
          setSelectedRepoId(repoId);
          setActiveView("console");
        }}
      />

      <section className="workspace">
        <TopBar status={status} isRefreshing={isRefreshing} onRefresh={refresh} query={query} setQuery={setQuery} />

        {activeView === "automations" && (
          <div className="content-grid">
            <section className="panel automation-panel" aria-label="自动化任务">
              <PanelTitle title="云端 Codex 控制台" eyebrow="Automations" onRefresh={refresh} spinning={isRefreshing} />

              <div className="automation-list">
                {filteredAutomations.map((automation) => (
                  <AutomationRow
                    key={automation.id}
                    automation={automation}
                    repo={status.repos.find((repo) => repo.id === automation.repoId)}
                    selected={automation.id === selectedAutomation.id}
                    onSelect={() => {
                      setSelectedAutomationId(automation.id);
                      setSelectedRepoId(automation.repoId);
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
                events={events}
                busyAction={busyAction}
                onRun={() =>
                  runAction(`run-${selectedAutomation.id}`, "立即运行", () =>
                    api(`/api/automations/${selectedAutomation.id}/run`, { method: "POST" }),
                  )
                }
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
              <CloudStatus status={status} />
              <RepoCard repo={selectedRepo} />
              <LogCard logs={status.logs} automation={selectedAutomation} />
            </aside>
          </div>
        )}

        {activeView === "console" && (
          <div className="content-grid">
            <CloudChat
              status={status}
              repo={selectedRepo}
              selectedRepoId={selectedRepoId}
              onSelectRepo={setSelectedRepoId}
              messages={chatMessages}
              input={chatInput}
              onInput={setChatInput}
              onSend={sendChat}
              busy={busyAction === "chat"}
            />
            <aside className="right-rail">
              <CloudStatus status={status} />
              <RepoCard repo={selectedRepo} />
              <LogCard logs={status.logs} automation={selectedAutomation} />
            </aside>
          </div>
        )}

        {activeView === "logs" && (
          <div className="content-grid">
            <LogsView logs={status.logs} />
            <aside className="right-rail">
              <CloudStatus status={status} />
              <RepoCard repo={selectedRepo} />
            </aside>
          </div>
        )}

        {activeView === "settings" && (
          <div className="content-grid">
            <SettingsView status={status} onRefresh={refresh} isRefreshing={isRefreshing} />
            <aside className="right-rail">
              <CloudStatus status={status} />
              <RepoCard repo={selectedRepo} />
              <LogCard logs={status.logs} automation={selectedAutomation} />
            </aside>
          </div>
        )}
        {fullLog && <FullLogDrawer log={fullLog} onClose={() => setFullLog(null)} />}
      </section>
    </main>
  );
}

function Sidebar({
  status,
  activeView,
  selectedRepoId,
  onSelectView,
  onSelectRepo,
}: {
  status: ConsoleStatus;
  activeView: ActiveView;
  selectedRepoId: string;
  onSelectView: (view: ActiveView) => void;
  onSelectRepo: (id: string) => void;
}) {
  return (
    <aside className="sidebar">
      <div className="brand-row">
        <div className="brand-mark">
          <Bot size={20} />
        </div>
        <div>
          <strong>Codex</strong>
          <span>Cloud</span>
        </div>
      </div>

      <nav className="nav-stack">
        <button className={cx("nav-item", activeView === "automations" && "active")} onClick={() => onSelectView("automations")}>
          <Activity size={18} />
          <span>自动化</span>
          <small>{status.automations.length}</small>
        </button>
        <button className={cx("nav-item", activeView === "console" && "active")} onClick={() => onSelectView("console")}>
          <Terminal size={18} />
          <span>控制台</span>
        </button>
        <button className={cx("nav-item", activeView === "logs" && "active")} onClick={() => onSelectView("logs")}>
          <History size={18} />
          <span>日志</span>
        </button>
        <button className={cx("nav-item", activeView === "settings" && "active")} onClick={() => onSelectView("settings")}>
          <Settings2 size={18} />
          <span>设置</span>
        </button>
      </nav>

      <div className="sidebar-section">
        <p>项目</p>
        {status.repos.map((repo) => (
          <button
            key={repo.id}
            className={cx("project-item", selectedRepoId === repo.id && "selected")}
            onClick={() => onSelectRepo(repo.id)}
          >
            <span className={cx("repo-dot", repo.accent)} />
            <span>{repo.name}</span>
            <ChevronRight size={15} />
          </button>
        ))}
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
  isRefreshing,
  onRefresh,
  query,
  setQuery,
}: {
  status: ConsoleStatus;
  isRefreshing: boolean;
  onRefresh: () => void;
  query: string;
  setQuery: (value: string) => void;
}) {
  return (
    <header className="topbar">
      <div className="search-box">
        <Search size={17} />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索任务、项目、服务" />
      </div>

      <div className="topbar-actions">
        <span className={cx("status-pill", status.localMode ? "warn" : "ok")}>
          <Wifi size={15} />
          {status.localMode ? "Local mock" : "Cloud live"}
        </span>
        <span className="status-pill">
          <Cloud size={15} />
          {status.instance.region}
        </span>
        <button className="text-button" onClick={onRefresh}>
          <RefreshCw size={16} className={cx(isRefreshing && "spin")} />
          刷新
        </button>
      </div>
    </header>
  );
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
          {repo?.name || automation.repoId} · {automation.model} · {automation.reasoning}
        </small>
      </span>
      <span className="next-run">
        <Timer size={15} />
        {automation.nextRun}
      </span>
    </button>
  );
}

function RunThread({
  status,
  automation,
  repo,
  events,
  busyAction,
  onRun,
  onPause,
  onPull,
  onOpenLog,
}: {
  status: ConsoleStatus;
  automation: Automation;
  repo: Repo;
  events: RunEvent[];
  busyAction: string | null;
  onRun: () => void;
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
            <p className="eyebrow">Current Runbook</p>
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
            运行
          </button>
        </div>
      </div>

      <div className="task-grid">
        <Metric label="服务" value={automation.service} icon={<Terminal size={16} />} />
        <Metric label="仓库" value={repo.name} icon={<GitBranch size={16} />} />
        <Metric label="下次运行" value={automation.nextRun} icon={<Timer size={16} />} />
        <Metric label="生成时间" value={timeLabel(status.generatedAt)} icon={<Activity size={16} />} />
      </div>

      <RunLogPanel automation={automation} onOpenLog={onOpenLog} />

      <div className="conversation">
        <Message tone="info" title="Codex Cloud" body={`工作目录 ${repo.path}`} />
        <Message
          tone={automation.enabled ? "ok" : "warn"}
          title={automation.enabled ? "定时器已启用" : "定时器已暂停"}
          body={`${automation.timer} · ${automation.schedule}`}
        />
        {status.events.map((event) => (
          <Message key={event.text} title="系统检查" tone={event.tone} body={event.text} />
        ))}
        {events.map((event) => (
          <Message key={event.id} title={`${event.title} · ${timeLabel(event.time)}`} tone={event.tone} body={event.body} />
        ))}
      </div>
    </div>
  );
}

function Metric({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  return (
    <div className="metric">
      <span>{icon}</span>
      <div>
        <small>{label}</small>
        <strong title={value}>{value}</strong>
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
          <p className="eyebrow">Recent Run</p>
          <h3>最近运行状态</h3>
        </div>
        <span className={cx("run-badge", failed ? "warn" : "ok")}>
          {failed ? "需要检查" : "正常"}
        </span>
      </div>
      <div className="run-log-stats">
        <Metric label="service active" value={automation.run.activeState} icon={<Activity size={16} />} />
        <Metric label="service failed" value={automation.run.failedState} icon={<ShieldCheck size={16} />} />
        <Metric label="exit code" value={automation.run.exitCode} icon={<Terminal size={16} />} />
        <Metric label="log updated" value={automation.run.logUpdatedAt ? shortDate(automation.run.logUpdatedAt) : "无日志"} icon={<History size={16} />} />
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
        <pre>{automation.run.logTail.join("\n")}</pre>
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
            <p className="eyebrow">{log.mocked ? "Mock Log" : "Full Log"}</p>
            <h2>{log.name}</h2>
          </div>
          <button className="command-button" onClick={onClose}>关闭</button>
        </div>
        <pre>{log.content}</pre>
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

function CloudChat({
  status,
  repo,
  selectedRepoId,
  onSelectRepo,
  messages,
  input,
  onInput,
  onSend,
  busy,
}: {
  status: ConsoleStatus;
  repo: Repo;
  selectedRepoId: string;
  onSelectRepo: (id: string) => void;
  messages: ChatMessage[];
  input: string;
  onInput: (value: string) => void;
  onSend: () => void;
  busy: boolean;
}) {
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, busy]);

  return (
    <section className="chat-panel wide-panel">
      <div className="thread-header">
        <div className="thread-title">
          <div className="thread-avatar">
            <MessageSquare size={19} />
          </div>
          <div>
            <p className="eyebrow">Cloud Codex</p>
            <h2>和云端 Codex 对话</h2>
          </div>
        </div>
        <span className={cx("status-pill", status.localMode ? "warn" : "ok")}>
          <Cloud size={15} />
          {status.localMode ? "本地模拟" : "EC2 在线"}
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

      <div className="chat-window">
        <article className="chat-bubble codex">
          <span className="chat-avatar">
            <Bot size={16} />
          </span>
          <div>
            <strong>云端 Codex</strong>
            <p>
              当前工作目录是 <code>{repo.path}</code>。你可以让我检查仓库、运行更新、解释日志、修改代码，或直接问 research
              任务的状态。
            </p>
          </div>
        </article>
        {messages.map((message) => (
          <article key={message.id} className={cx("chat-bubble", message.role, message.streaming && "streaming")}>
            <span className="chat-avatar">{message.role === "user" ? <Sparkles size={16} /> : <Bot size={16} />}</span>
            <div>
              <strong>
                {message.role === "user" ? "你" : message.mocked ? "Codex 模拟响应" : "云端 Codex"}
                <small>{timeLabel(message.time)}</small>
              </strong>
              <p>
                {message.text || (message.streaming ? " " : "Codex 没有返回内容。")}
                {message.streaming && <span className="stream-cursor" />}
              </p>
              {message.status && <em className="chat-status">{message.status}</em>}
            </div>
          </article>
        ))}
        {busy && !messages.some((message) => message.streaming) && (
          <article className="chat-bubble codex">
            <span className="chat-avatar">
              <Loader2 size={16} className="spin" />
            </span>
            <div>
              <strong>云端 Codex</strong>
              <p>正在运行 codex exec...</p>
            </div>
          </article>
        )}
        <div ref={endRef} />
      </div>

      <div className="composer">
        <textarea
          value={input}
          onChange={(event) => onInput(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              onSend();
            }
          }}
          placeholder="问云端 Codex：检查当前仓库状态 / 看最近一次日志 / 帮我跑一次宏观刷新..."
        />
        <button className="primary-command send-button" onClick={onSend} disabled={busy || !input.trim()}>
          {busy ? <Loader2 size={17} className="spin" /> : <Send size={17} />}
          发送
        </button>
      </div>
    </section>
  );
}

function LogsView({ logs }: { logs: LogFile[] }) {
  return (
    <section className="logs-panel wide-panel">
      <div className="thread-header">
        <div className="thread-title">
          <div className="thread-avatar">
            <History size={19} />
          </div>
          <div>
            <p className="eyebrow">Logs</p>
            <h2>运行日志</h2>
          </div>
        </div>
      </div>
      <div className="log-grid">
        {logs.map((log) => (
          <article key={log.id} className="log-item">
            <div className="log-title">
              <strong>{log.name}</strong>
              <span>{shortDate(log.updatedAt)} · {log.size} bytes</span>
            </div>
            <pre>{log.tail.join("\n")}</pre>
          </article>
        ))}
      </div>
    </section>
  );
}

function SettingsView({
  status,
  onRefresh,
  isRefreshing,
}: {
  status: ConsoleStatus;
  onRefresh: () => void;
  isRefreshing: boolean;
}) {
  return (
    <section className="settings-panel wide-panel">
      <div className="thread-header">
        <div className="thread-title">
          <div className="thread-avatar">
            <SlidersHorizontal size={19} />
          </div>
          <div>
            <p className="eyebrow">Settings</p>
            <h2>控制台设置</h2>
          </div>
        </div>
        <button className="command-button" onClick={onRefresh}>
          <RefreshCw size={17} className={cx(isRefreshing && "spin")} />
          刷新
        </button>
      </div>
      <div className="settings-grid">
        <Metric label="云端根目录" value={status.instance.root} icon={<HardDrive size={16} />} />
        <Metric label="公网 IP" value={status.instance.publicIp} icon={<Cloud size={16} />} />
        <Metric label="私网 IP" value={status.instance.privateIp} icon={<Wifi size={16} />} />
        <Metric label="Codex 认证" value={status.codex.mode} icon={<ShieldCheck size={16} />} />
      </div>
      <div className="settings-copy">
        <strong>API</strong>
        <p>
          这个控制台通过 <code>/api/status</code>、<code>/api/chat</code>、<code>/api/repos/:id/pull</code> 和
          <code>/api/automations/:id/run</code> 操作云端 worker。
        </p>
      </div>
    </section>
  );
}

function CloudStatus({ status }: { status: ConsoleStatus }) {
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
      </dl>
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
          <pre>{relevant.tail.join("\n")}</pre>
        </>
      ) : (
        <p className="empty-copy">暂无日志</p>
      )}
    </section>
  );
}
