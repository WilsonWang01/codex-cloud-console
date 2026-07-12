import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";

function unquoteProtocolValue(value = "") {
  const text = String(value || "").trim();
  if ((text.startsWith("\"") && text.endsWith("\"")) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

function parseUnhandledErrorLine(line = "") {
  const text = String(line || "").trim();
  if (!/^Unhandled error\./i.test(text)) return null;
  const matchValue = (key) => {
    const match = text.match(new RegExp(`${key}:\\s*(\"(?:[^\"\\\\]|\\\\.)*\"|'(?:[^'\\\\]|\\\\.)*'|[^,}\\n]+)`));
    if (!match) return null;
    return unquoteProtocolValue(match[1]).replace(/\\"/g, "\"").replace(/\\'/g, "'");
  };
  const message = matchValue("message") || "Codex app-server reported an unhandled error";
  return {
    message,
    params: {
      error: {
        message,
        codexErrorInfo: matchValue("codexErrorInfo"),
      },
      willRetry: /willRetry:\s*true/i.test(text),
      threadId: matchValue("threadId"),
      turnId: matchValue("turnId"),
      raw: text.slice(0, 4000),
    },
  };
}

export class CodexAppServerClient extends EventEmitter {
  constructor({
    cwd,
    env = process.env,
    command = "codex",
    args = ["app-server", "--listen", "stdio://"],
    clientInfo = { name: "codex_cloud_console", title: "Codex Cloud Console", version: "0.1.0" },
    onServerRequest = () => null,
    initializeTimeoutMs = Number(process.env.CODEX_APP_SERVER_INITIALIZE_TIMEOUT_MS || 90_000),
  }) {
    super();
    this.cwd = cwd;
    this.env = env;
    this.command = command;
    this.args = args;
    this.clientInfo = clientInfo;
    this.onServerRequest = onServerRequest;
    this.initializeTimeoutMs = initializeTimeoutMs;
    this.child = null;
    this.buffer = "";
    this.stderr = "";
    this.nextId = 1;
    this.pending = new Map();
    this.orphanedRequests = [];
    this.readyPromise = null;
    this.startedAt = null;
    this.restartCount = 0;
    this.lastError = null;
    this.generation = 0;
  }

  status() {
    return {
      running: Boolean(this.child),
      startedAt: this.startedAt,
      restartCount: this.restartCount,
      generation: this.generation,
      lastError: this.lastError,
      pending: this.pending.size,
      orphaned: this.orphanedRequests.slice(-12),
      stderrTail: this.stderr.split(/\r?\n/).filter(Boolean).slice(-8),
    };
  }

  async ensureStarted() {
    if (this.child && this.readyPromise) return this.readyPromise;
    this.start();
    return this.readyPromise;
  }

  start() {
    if (this.child) return;
    this.buffer = "";
    this.stderr = "";
    this.lastError = null;
    this.startedAt = new Date().toISOString();
    const generation = ++this.generation;
    const child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    child.stdout.on("data", (chunk) => this.handleStdout(chunk, child, generation));
    child.stderr.on("data", (chunk) => {
      if (!this.isCurrent(child, generation)) return;
      this.stderr += chunk.toString();
      this.stderr = this.stderr.slice(-16_000);
    });
    child.on("error", (error) => this.handleExit(child, generation, error));
    child.on("close", (code, signal) => this.handleExit(child, generation, null, code, signal));

    this.readyPromise = new Promise((resolve, reject) => {
      this.sendRequest("initialize", {
        clientInfo: this.clientInfo,
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          optOutNotificationMethods: [],
        },
      }, this.initializeTimeoutMs, { bypassReady: true, child, generation })
        .then((result) => {
          if (!this.isCurrent(child, generation)) {
            throw new Error("codex app-server initialize completed for a superseded generation");
          }
          this.sendNotification("initialized", {}, { child, generation });
          this.lastError = null;
          this.emit("ready", result, { generation });
          resolve(result);
        })
        .catch((error) => {
          if (this.isCurrent(child, generation)) {
            this.lastError = error.message;
            void this.stop();
            this.restartCount += 1;
          }
          reject(error);
        });
    });
  }

  isCurrent(child, generation) {
    return Boolean(child && this.child === child && this.generation === generation);
  }

  rejectPendingGeneration(generation, message) {
    for (const [id, item] of this.pending.entries()) {
      if (item.generation !== generation) continue;
      this.pending.delete(id);
      clearTimeout(item.timer);
      item.reject(new Error(message));
    }
  }

  stop({ waitForExit = false, graceMs = 1_000 } = {}) {
    const child = this.child;
    const generation = this.generation;
    if (!child) return Promise.resolve();
    this.child = null;
    this.readyPromise = null;
    this.rejectPendingGeneration(generation, "codex app-server stopped");
    const exitPromise = child.exitCode !== null
      ? Promise.resolve()
      : new Promise((resolve) => child.once("close", resolve));
    if (!child.killed) child.kill("SIGTERM");
    if (!waitForExit) return exitPromise;
    return Promise.race([
      exitPromise,
      new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (child.exitCode === null) child.kill("SIGKILL");
          resolve();
        }, Math.max(50, Number(graceMs || 1_000)));
        timer.unref?.();
      }),
    ]);
  }

  async restart() {
    await this.stop({ waitForExit: true });
    this.restartCount += 1;
    return this.ensureStarted();
  }

  async request(method, params = {}, timeoutMs = 20_000) {
    const budgetMs = Math.max(1, Number(timeoutMs || 20_000));
    const startedAt = Date.now();
    await this.waitUntilReady(budgetMs);
    const remainingMs = budgetMs - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      throw new Error(`codex app-server ${method} timed out while waiting for initialization`);
    }
    return this.sendRequest(method, params, remainingMs);
  }

  async waitUntilReady(timeoutMs = 20_000) {
    const ready = this.ensureStarted();
    const boundedTimeoutMs = Math.max(1, Math.min(Number(timeoutMs || 20_000), this.initializeTimeoutMs));
    let timer = null;
    try {
      return await Promise.race([
        ready,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`codex app-server initialize timed out after ${boundedTimeoutMs}ms`)), boundedTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  sendRequest(method, params = {}, timeoutMs = 20_000, options = {}) {
    const child = options.child || this.child;
    const generation = options.generation ?? this.generation;
    if (!child || (!options.bypassReady && !this.isCurrent(child, generation))) {
      return Promise.reject(new Error("codex app-server is not running"));
    }
    if (!options.bypassReady && !this.readyPromise) {
      return Promise.reject(new Error("codex app-server is not initialized"));
    }
    const id = this.nextId++;
    const payload = { method, id, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        this.pending.delete(id);
        this.rememberOrphanedRequest({
          id,
          method: pending?.method || method,
          timeoutMs,
          timedOutAt: new Date().toISOString(),
          status: "timedOut",
        });
        this.emit("request-timeout", { id, method: pending?.method || method, timeoutMs });
        reject(new Error(`codex app-server ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer, child, generation });
      try {
        this.write(payload, { child, generation });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  rememberOrphanedRequest(entry = {}) {
    this.orphanedRequests.push(entry);
    this.orphanedRequests = this.orphanedRequests.slice(-50);
  }

  sendNotification(method, params = {}, context = {}) {
    this.write({ method, params }, context);
  }

  write(payload, context = {}) {
    const child = context.child || this.child;
    const generation = context.generation ?? this.generation;
    if (!this.isCurrent(child, generation) || !child.stdin.writable) throw new Error("codex app-server stdin is closed");
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  handleStdout(chunk, child, generation) {
    if (!this.isCurrent(child, generation)) return;
    this.buffer += chunk.toString();
    let newlineIndex;
    while ((newlineIndex = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (!line) continue;
      try {
        this.handleMessage(JSON.parse(line), child, generation);
      } catch (error) {
        const unhandled = parseUnhandledErrorLine(line);
        if (unhandled) {
          this.lastError = unhandled.message;
          this.emit("notification", { method: "error", params: unhandled.params });
          this.emit("app-server-error", unhandled.params, { method: "error", params: unhandled.params });
          this.emit("protocol-error", { error, line, message: unhandled.message, recoverable: true });
        } else {
          this.lastError = `Invalid app-server JSON: ${error.message}`;
          this.emit("protocol-error", { error, line, message: this.lastError, recoverable: false });
        }
      }
    }
  }

  handleMessage(message, child, generation) {
    if (message.id && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      if (pending.child !== child || pending.generation !== generation) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const error = new Error(message.error.message || `${pending.method} failed`);
        error.appServerError = message.error;
        pending.reject(error);
      } else {
        if (this.isCurrent(child, generation)) this.lastError = null;
        pending.resolve(message.result || null);
      }
      return;
    }

    if (message.id) {
      const orphan = this.orphanedRequests.find((item) => item.id === message.id && item.status === "timedOut");
      if (orphan) {
        orphan.status = message.error ? "lateError" : "lateResult";
        orphan.completedAt = new Date().toISOString();
        orphan.error = message.error?.message || null;
        this.emit("orphaned-response", { ...orphan });
      }
    }

    if (message.id && message.method) {
      if (this.isCurrent(child, generation)) this.handleServerRequest(message, child, generation);
      return;
    }

    if (message.method && this.isCurrent(child, generation)) {
      this.emit("notification", message);
      if (message.method === "error") {
        this.emit("app-server-error", message.params || {}, message);
      } else {
        this.emit(message.method, message.params || {}, message);
      }
    }
  }

  handleServerRequest(message, child, generation) {
    Promise.resolve()
      .then(() => this.onServerRequest(message.method, message.params || {}, message))
      .then((result) => {
        if (!this.isCurrent(child, generation)) return;
        if (result) {
          this.write({ id: message.id, result }, { child, generation });
        } else {
          this.write({ id: message.id, error: { code: -32601, message: "Unsupported app-server request" } }, { child, generation });
        }
      })
      .catch((error) => {
        if (!this.isCurrent(child, generation)) return;
        try {
          this.write({ id: message.id, error: { code: -32000, message: error.message || "Server request failed" } }, { child, generation });
        } catch {
          // The generation ended while the host request was resolving.
        }
      });
  }

  handleExit(child, generation, error, code = null, signal = null) {
    const message = error?.message || `codex app-server exited${code === null ? "" : ` with code ${code}`}${signal ? ` (${signal})` : ""}`;
    this.rejectPendingGeneration(generation, message);
    if (!this.isCurrent(child, generation)) {
      this.emit("stale-exit", { error, code, signal, message, generation });
      return;
    }
    this.lastError = message;
    this.child = null;
    this.readyPromise = null;
    this.emit("exit", { error, code, signal, message, generation });
  }
}
