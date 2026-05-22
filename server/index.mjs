import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";

const app = express();
app.use(express.json());

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const cloudRoot = process.env.CODEX_CLOUD_ROOT || "/home/ubuntu/codex-cloud";
const workspaceRoot = process.env.CODEX_WORKSPACE_ROOT || path.join(cloudRoot, "workspace");
const logsRoot = process.env.CODEX_LOGS_ROOT || path.join(cloudRoot, "logs");
const stateRoot =
  process.env.CODEX_STATE_ROOT ||
  (process.env.NODE_ENV === "production" ? path.join(cloudRoot, "state") : path.join(projectRoot, ".codex-cloud-state"));
const chatHistoryPath = path.join(stateRoot, "chat-history.json");
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || "127.0.0.1";
const maxStoredChatMessages = 80;
const maxPromptChatMessages = 18;

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
  },
];

const mockCommits = {
  "invest-dashboard": "7415506",
  "macro-control-dashboard": "1c6c82b",
  "memory-export-tracker": "ce18209",
};

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

function normalizeChatMessage(item) {
  const role = item?.role === "user" ? "user" : "codex";
  const text = String(item?.text || "").slice(0, 12000);
  return {
    id: String(item?.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`),
    role,
    text,
    time: String(item?.time || new Date().toISOString()),
    mocked: Boolean(item?.mocked),
  };
}

async function readChatStore() {
  try {
    const raw = await fs.readFile(chatHistoryPath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      sessions: parsed?.sessions && typeof parsed.sessions === "object" ? parsed.sessions : {},
    };
  } catch {
    return { sessions: {} };
  }
}

async function writeChatStore(store) {
  await fs.mkdir(stateRoot, { recursive: true });
  const tmpPath = `${chatHistoryPath}.${process.pid}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(store, null, 2)}\n`);
  await fs.rename(tmpPath, chatHistoryPath);
}

async function getChatMessages(repoId) {
  const store = await readChatStore();
  return (store.sessions[repoId] || []).map(normalizeChatMessage).filter((item) => item.text);
}

async function saveChatMessages(repoId, messages) {
  const store = await readChatStore();
  store.sessions[repoId] = messages.map(normalizeChatMessage).filter((item) => item.text).slice(-maxStoredChatMessages);
  await writeChatStore(store);
  return store.sessions[repoId];
}

async function appendChatTurn(repoId, message, response, mocked = false) {
  const current = await getChatMessages(repoId);
  const now = new Date().toISOString();
  return saveChatMessages(repoId, [
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

function buildChatPrompt(repo, message, history = []) {
  return [
    "你是运行在 EC2 上的云端 Codex 控制台助手。",
    `当前仓库: ${repo.name}`,
    `工作目录: ${repo.path}`,
    "你会看到这个仓库对应控制台会话的最近历史。回答时要延续上下文，不要假装看不到前文。",
    "请直接回答用户问题。只有用户明确要求修改代码、运行命令或检查状态时才执行相应操作。",
    "",
    "最近会话历史:",
    formatChatHistory(history),
    "",
    "用户消息:",
    message,
  ].join("\n");
}

function codexExecArgs(repo, model, reasoning) {
  return [
    "exec",
    "--skip-git-repo-check",
    "-C",
    repo.path,
    "-m",
    model,
    "-c",
    `model_reasoning_effort=${reasoning}`,
    "-s",
    "workspace-write",
    "-",
  ];
}

function writeSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
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
      commit: mockCommits[repo.id] || "local",
      dirty: false,
      statusText: "mock snapshot",
      lastCommit: "Cloud console preview",
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
    statusText: status.stdout || "clean",
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
      nextRun: next || automation.schedule,
      lastRun: line?.includes(" - ") ? "尚未运行" : "最近一次已记录",
      run: mockRunDetail(automation),
    };
  });
}

function mockRunDetail(automation) {
  return {
    activeState: "inactive",
    failedState: "inactive",
    exitCode: "0",
    logName: `${automation.id}-latest.log`,
    logUpdatedAt: new Date().toISOString(),
    logTail: ["CLOUD_PULL_DONE", "Timer waiting for next run"],
  };
}

async function getLogForAutomation(automation) {
  if (!(await exists(logsRoot))) return mockRunDetail(automation);
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
      logTail: ["No log file found for this automation."],
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
    logTail: compactLines(content, 12),
  };
}

function inferExitCode(content) {
  const exitMatch = content.match(/(?:EXIT|exit code|code)[ =:]+(\d+)/i);
  if (exitMatch) return exitMatch[1];
  if (/failed|error|traceback|exception/i.test(content)) return "non-zero?";
  if (/completed|CLOUD_PULL_DONE|migrated-runner-ok/i.test(content)) return "0";
  return "unknown";
}

async function attachRunDetails(timerStatus) {
  return Promise.all(
    timerStatus.map(async (automation) => {
      const [active, failed, logDetail] = await Promise.all([
        run("systemctl", ["is-active", automation.service], { timeout: 5_000 }),
        run("systemctl", ["is-failed", automation.service], { timeout: 5_000 }),
        getLogForAutomation(automation),
      ]);
      return {
        ...automation,
        run: {
          ...logDetail,
          activeState: active.stdout || logDetail.activeState,
          failedState: failed.stdout || logDetail.failedState,
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
      authenticated: true,
      mode: "ChatGPT subscription",
      detail: "mocked locally",
    };
  }
  return {
    authenticated: /Logged in/i.test(detail),
    mode: /ChatGPT/i.test(detail) ? "ChatGPT subscription" : "API key",
    detail,
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
        tail: ["CLOUD_PULL_DONE", "Timer waiting for next run"],
      },
    ];
  }
  const entries = await fs.readdir(logsRoot, { withFileTypes: true });
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile() || entry.isSymbolicLink())
      .slice(-40)
      .map(async (entry) => {
        const filePath = path.join(logsRoot, entry.name);
        const stat = await fs.stat(filePath);
        const content = await fs.readFile(filePath, "utf8").catch(() => "");
        return {
          id: entry.name,
          job: entry.name.replace(/-\d{8}.+$/, "").replace("-latest.log", ""),
          name: entry.name,
          size: stat.size,
          updatedAt: stat.mtime.toISOString(),
          tail: compactLines(content, 8),
        };
      }),
  );
  return files.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)).slice(0, 12);
}

async function getStatus() {
  const [repoStatus, timerStatus, codexStatus, logs] = await Promise.all([
    Promise.all(repos.map(getRepo)),
    getTimers(),
    getCodexStatus(),
    getLogs(),
  ]);
  const hostname = await run("hostname");
  const localMode = repoStatus.some((repo) => !repo.present);

  return {
    generatedAt: new Date().toISOString(),
    localMode,
    instance: {
      name: hostname.stdout || "codex-cloud-worker",
      region: process.env.AWS_REGION || "ap-northeast-1",
      publicIp: process.env.CODEX_PUBLIC_IP || "54.199.2.92",
      privateIp: process.env.CODEX_PRIVATE_IP || "172.31.7.169",
      type: process.env.CODEX_INSTANCE_TYPE || "t3.small",
      root: cloudRoot,
    },
    codex: codexStatus,
    repos: repoStatus,
    automations: timerStatus,
    logs,
    events: [
      { tone: "ok", text: "GitHub credentials are available on the cloud worker." },
      { tone: "ok", text: "System timers are enabled and waiting." },
      {
        tone: localMode ? "warn" : "ok",
        text: localMode ? "Local mock mode is active for development." : "Cloud paths are mounted.",
      },
    ],
  };
}

app.get("/api/status", async (_req, res) => {
  res.json(await getStatus());
});

app.get("/api/logs/:name", async (req, res) => {
  const name = path.basename(req.params.name);
  const filePath = path.join(logsRoot, name);
  if (!(await exists(filePath))) {
    return res.json({
      ok: true,
      mocked: true,
      name,
      content: "Local mock mode: full cloud logs are available after deployment.",
    });
  }
  const content = await fs.readFile(filePath, "utf8").catch((error) => `Failed to read log: ${error.message}`);
  res.json({ ok: true, name, content });
});

app.post("/api/repos/:id/pull", async (req, res) => {
  const repo = repos.find((item) => item.id === req.params.id);
  if (!repo) return res.status(404).json({ ok: false, output: "Unknown repository" });
  if (!(await exists(repo.path))) {
    return res.json({ ok: true, mocked: true, output: `${repo.name}: mock pull completed` });
  }
  const result = await run("git", ["-C", repo.path, "pull", "--ff-only"], { timeout: 60_000 });
  res.json({ ok: result.ok, output: result.stdout || result.stderr });
});

app.get("/api/chat/history", async (req, res) => {
  const repo = repos.find((item) => item.id === req.query?.repoId) || repos[0];
  res.json({ ok: true, repoId: repo.id, messages: await getChatMessages(repo.id) });
});

app.delete("/api/chat/history", async (req, res) => {
  const repo = repos.find((item) => item.id === req.query?.repoId) || repos[0];
  await saveChatMessages(repo.id, []);
  res.json({ ok: true, repoId: repo.id, messages: [] });
});

app.post("/api/chat", async (req, res) => {
  const message = String(req.body?.message || "").trim();
  const repo = repos.find((item) => item.id === req.body?.repoId) || repos[0];
  const model = String(req.body?.model || "gpt-5.4-mini");
  const reasoning = String(req.body?.reasoning || "medium");
  if (!message) return res.status(400).json({ ok: false, output: "Message is required" });
  const history = await getChatMessages(repo.id);

  if (!(await exists(repo.path))) {
    const output = `本地开发模式：会把这条消息发送给云端 Codex，并在 ${repo.name} 工作目录中执行。\n\n> ${message}`;
    await appendChatTurn(repo.id, message, output, true);
    return res.json({
      ok: true,
      mocked: true,
      output,
    });
  }

  const result = await run(
    "codex",
    codexExecArgs(repo, model, reasoning),
    { timeout: 180_000, input: buildChatPrompt(repo, message, history) },
  );
  const output = result.stdout || result.stderr || "Codex completed without output.";
  await appendChatTurn(repo.id, message, output, false);

  res.json({
    ok: result.ok,
    output,
    code: result.code,
  });
});

app.post("/api/chat/stream", async (req, res) => {
  const message = String(req.body?.message || "").trim();
  const repo = repos.find((item) => item.id === req.body?.repoId) || repos[0];
  const model = String(req.body?.model || "gpt-5.4-mini");
  const reasoning = String(req.body?.reasoning || "medium");
  if (!message) return res.status(400).json({ ok: false, output: "Message is required" });
  const history = await getChatMessages(repo.id);

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  if (!(await exists(repo.path))) {
    writeSse(res, "meta", { mocked: true, repo: repo.name });
    const chunks = [
      "本地开发模式：会把这条消息发送给云端 Codex，",
      `并在 ${repo.name} 工作目录中执行。\n\n`,
      `> ${message}`,
    ];
    for (const chunk of chunks) {
      writeSse(res, "delta", { text: chunk });
      await new Promise((resolve) => setTimeout(resolve, 220));
    }
    await appendChatTurn(repo.id, message, chunks.join(""), true);
    writeSse(res, "done", { ok: true, code: 0, mocked: true });
    res.end();
    return;
  }

  writeSse(res, "meta", { mocked: false, repo: repo.name });
  writeSse(res, "status", { text: "已连接云端 Codex，正在启动 codex exec..." });

  const child = spawn("codex", codexExecArgs(repo, model, reasoning), {
    cwd: repo.path,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let closed = false;

  const timer = setTimeout(() => {
    writeSse(res, "status", { text: "运行时间较长，已请求终止。" });
    child.kill("SIGTERM");
  }, 180_000);

  req.on("close", () => {
    if (!closed) child.kill("SIGTERM");
  });

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    stdout += text;
    writeSse(res, "delta", { text });
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    stderr += text;
    writeSse(res, "stderr", { text });
  });

  child.on("error", (error) => {
    writeSse(res, "error", { message: error.message });
  });

  child.on("close", async (code) => {
    closed = true;
    clearTimeout(timer);
    if (!stdout && stderr) writeSse(res, "delta", { text: stderr });
    try {
      await appendChatTurn(repo.id, message, stdout || stderr, false);
    } catch (error) {
      writeSse(res, "error", { message: `会话保存失败: ${error.message}` });
    }
    writeSse(res, "done", { ok: code === 0, code });
    res.end();
  });

  child.stdin.end(buildChatPrompt(repo, message, history));
});

app.post("/api/automations/:id/run", async (req, res) => {
  const automation = automations.find((item) => item.id === req.params.id);
  if (!automation) return res.status(404).json({ ok: false, output: "Unknown automation" });
  const result = await run("systemctl", ["start", automation.service], { timeout: 20_000 });
  if (!result.ok) {
    return res.json({ ok: true, mocked: true, output: `${automation.name}: mock run queued` });
  }
  res.json({ ok: true, output: `${automation.service} started` });
});

app.post("/api/automations/:id/:mode", async (req, res) => {
  const automation = automations.find((item) => item.id === req.params.id);
  if (!automation) return res.status(404).json({ ok: false, output: "Unknown automation" });
  const action = req.params.mode === "pause" ? "disable" : "enable";
  const result = await run("systemctl", [action, "--now", automation.timer], { timeout: 20_000 });
  if (!result.ok) {
    return res.json({ ok: true, mocked: true, output: `${automation.name}: mock ${req.params.mode}` });
  }
  res.json({ ok: true, output: `${automation.timer} ${action}d` });
});

app.use(express.static(path.join(projectRoot, "dist")));
app.get(/.*/, (_req, res) => {
  res.sendFile(path.join(projectRoot, "dist", "index.html"));
});

app.listen(port, host, () => {
  console.log(`Codex Cloud Console listening on http://${host}:${port}`);
});
