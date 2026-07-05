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
  }

  status() {
    return {
      running: Boolean(this.child),
      startedAt: this.startedAt,
      restartCount: this.restartCount,
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
    this.child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.readyPromise = new Promise((resolve, reject) => {
      this.sendRequest("initialize", {
        clientInfo: this.clientInfo,
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          optOutNotificationMethods: [],
        },
      }, this.initializeTimeoutMs, { bypassReady: true })
        .then((result) => {
          this.sendNotification("initialized", {});
          this.emit("ready", result);
          resolve(result);
        })
        .catch((error) => {
          this.lastError = error.message;
          reject(error);
        });
    });

    this.child.stdout.on("data", (chunk) => this.handleStdout(chunk));
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk.toString();
      this.stderr = this.stderr.slice(-16_000);
    });
    this.child.on("error", (error) => this.handleExit(error));
    this.child.on("close", (code, signal) => this.handleExit(null, code, signal));
  }

  stop() {
    const child = this.child;
    this.child = null;
    this.readyPromise = null;
    if (child && !child.killed) child.kill("SIGTERM");
  }

  async restart() {
    this.stop();
    this.restartCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 250));
    return this.ensureStarted();
  }

  async request(method, params = {}, timeoutMs = 20_000) {
    await this.ensureStarted();
    return this.sendRequest(method, params, timeoutMs);
  }

  sendRequest(method, params = {}, timeoutMs = 20_000, options = {}) {
    if (!this.child) {
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
      this.pending.set(id, { method, resolve, reject, timer });
      this.write(payload);
    });
  }

  rememberOrphanedRequest(entry = {}) {
    this.orphanedRequests.push(entry);
    this.orphanedRequests = this.orphanedRequests.slice(-50);
  }

  sendNotification(method, params = {}) {
    this.write({ method, params });
  }

  write(payload) {
    if (!this.child || !this.child.stdin.writable) throw new Error("codex app-server stdin is closed");
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  handleStdout(chunk) {
    this.buffer += chunk.toString();
    let newlineIndex;
    while ((newlineIndex = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (!line) continue;
      try {
        this.handleMessage(JSON.parse(line));
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

  handleMessage(message) {
    if (message.id && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const error = new Error(message.error.message || `${pending.method} failed`);
        error.appServerError = message.error;
        pending.reject(error);
      } else {
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
      this.handleServerRequest(message);
      return;
    }

    if (message.method) {
      this.emit("notification", message);
      if (message.method === "error") {
        this.emit("app-server-error", message.params || {}, message);
      } else {
        this.emit(message.method, message.params || {}, message);
      }
    }
  }

  handleServerRequest(message) {
    Promise.resolve()
      .then(() => this.onServerRequest(message.method, message.params || {}, message))
      .then((result) => {
        if (result) {
          this.write({ id: message.id, result });
        } else {
          this.write({ id: message.id, error: { code: -32601, message: "Unsupported app-server request" } });
        }
      })
      .catch((error) => {
        this.write({ id: message.id, error: { code: -32000, message: error.message || "Server request failed" } });
      });
  }

  handleExit(error, code = null, signal = null) {
    if (error) this.lastError = error.message;
    const message = error?.message || `codex app-server exited${code === null ? "" : ` with code ${code}`}${signal ? ` (${signal})` : ""}`;
    if (!error && code !== 0 && code !== null) this.lastError = message;
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const item of pending) {
      clearTimeout(item.timer);
      item.reject(new Error(message));
    }
    this.child = null;
    this.readyPromise = null;
    this.emit("exit", { error, code, signal, message });
  }
}
