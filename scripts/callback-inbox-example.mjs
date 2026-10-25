import fs, { constants } from "node:fs";
import { createHash } from "node:crypto";
import http from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { verifyCallback } from "./callback-receiver-example.mjs";

const applicationId = 0x43435849;
const failure = (message, statusCode = 503) => Object.assign(new Error(message), { statusCode });

export function openCallbackInbox({ file, secret, automationId, capacity = 4096, readOnly = false }) {
  const validSecret = typeof secret === "string" && Buffer.byteLength(secret) >= 32 && Buffer.byteLength(secret) <= 256 && !/[\x00-\x1f\x7f]/.test(secret);
  if (typeof file !== "string" || !path.isAbsolute(file) || typeof automationId !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(automationId) ||
      (!readOnly && !validSecret) || !Number.isSafeInteger(capacity) || capacity < 1 || capacity > 4096 || typeof readOnly !== "boolean") throw failure("状态文件或绑定配置无效；接收模式需要有效私有密钥");
  const parent = fs.lstatSync(path.dirname(file));
  if (!parent.isDirectory() || parent.mode & 0o022 || process.getuid && parent.uid !== process.getuid()) throw failure("状态目录必须由当前用户拥有，且不能由其他用户写入");
  let created = false;
  if (!readOnly) {
    try { fs.closeSync(fs.openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)); created = true; }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1 || stat.mode & 0o077 || process.getuid && stat.uid !== process.getuid()) throw failure("状态文件必须是当前用户拥有且没有链接的私有普通文件");
  const db = new DatabaseSync(file, { readOnly });
  try {
    db.exec("PRAGMA busy_timeout=1000;");
    if (created) {
      db.exec(`BEGIN IMMEDIATE;
        PRAGMA application_id=${applicationId}; PRAGMA user_version=1;
        CREATE TABLE inbox_meta (id INTEGER PRIMARY KEY CHECK(id=1), automation_id TEXT NOT NULL) STRICT;
        CREATE TABLE callback_inbox (event_id TEXT PRIMARY KEY, body_hash TEXT NOT NULL,
          payload TEXT NOT NULL CHECK(json_valid(payload)), received_at TEXT NOT NULL) STRICT;`);
      db.prepare("INSERT INTO inbox_meta VALUES (1,?)").run(automationId);
      db.exec("COMMIT");
    } else if (db.prepare("PRAGMA application_id").get().application_id !== applicationId ||
        db.prepare("PRAGMA user_version").get().user_version !== 1 ||
        db.prepare("SELECT automation_id FROM inbox_meta WHERE id=1").get()?.automation_id !== automationId) {
      throw failure("状态文件不属于本接收端或自动化范围不一致，未覆盖原文件");
    }
    if (!readOnly) db.exec("PRAGMA synchronous=FULL;");
  } catch (error) { db.close(); throw error; }
  let closed = false;
  return {
    receive({ headers, rawBody }) {
      if (readOnly) throw failure("只读模式不接收事件");
      const event = verifyCallback({ headers, rawBody, secret });
      if (event.data.automation_id !== automationId || [".", ".."].includes(event.data.run_id) || /[\s\x00-\x1f\x7f]/u.test(event.data.run_id)) throw failure("回调签名或内容无效", 401);
      const hash = createHash("sha256").update(rawBody).digest("hex");
      db.exec("BEGIN IMMEDIATE");
      try {
        const existing = db.prepare("SELECT body_hash FROM callback_inbox WHERE event_id=?").get(event.id);
        if (existing && existing.body_hash !== hash) throw failure("同一事件 ID 的内容发生变化，未覆盖原记录", 409);
        if (!existing) {
          // ponytail: bounded append-only receipts; use the caller's transactional inbox for larger workloads.
          if (db.prepare("SELECT count(*) AS n FROM callback_inbox").get().n >= capacity) throw failure("接收容量已满，未确认新事件；请轮询原任务");
          db.prepare("INSERT INTO callback_inbox VALUES (?,?,?,?)").run(event.id, hash, JSON.stringify(event), new Date().toISOString());
        }
        db.exec("COMMIT");
        return { ok: true, duplicate: Boolean(existing), eventId: event.id };
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    list({ after = 0, limit = 20 } = {}) {
      if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw failure("读取游标或数量无效");
      const rows = db.prepare("SELECT rowid AS cursor,payload,received_at FROM callback_inbox WHERE rowid>? ORDER BY rowid LIMIT ?").all(after, limit);
      return { items: rows.map(row => ({ cursor: row.cursor, event: JSON.parse(row.payload), receivedAt: row.received_at })), nextCursor: rows.at(-1)?.cursor ?? after };
    },
    close() { if (!closed) { db.close(); closed = true; } },
  };
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    request.on("data", chunk => {
      size += chunk.length;
      if (size > 2048) { request.pause(); reject(failure("回调正文超过限制", 413)); }
      else chunks.push(chunk);
    });
    request.once("end", () => resolve(Buffer.concat(chunks)));
    request.once("error", reject);
  });
}

export function createCallbackInboxServer(inbox) {
  return http.createServer({ requestTimeout: 5000, headersTimeout: 5000, connectionsCheckingInterval: 1000 }, async (request, response) => {
    response.setHeader("content-type", "application/json");
    response.setHeader("cache-control", "no-store");
    try {
      if (request.method !== "POST" || request.url !== "/codex/completed") throw failure("未找到回调入口", 404);
      if (request.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json" ||
          request.headers["content-encoding"] && request.headers["content-encoding"] !== "identity") throw failure("只接受未压缩的 JSON 正文", 415);
      const result = inbox.receive({ headers: request.headers, rawBody: await readBody(request) });
      response.writeHead(result.duplicate ? 200 : 202); response.end(JSON.stringify(result));
    } catch (error) {
      if (response.destroyed || response.writableEnded) return;
      response.setHeader("connection", "close");
      response.once("finish", () => request.destroy());
      response.writeHead(error.statusCode || 503);
      response.end(JSON.stringify({ ok: false, error: error.statusCode ? error.message : "回调尚未可靠保存；请重试通知或轮询原任务" }));
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let inbox;
  try {
    const { values } = parseArgs({ options: { list: { type: "boolean" }, after: { type: "string" }, limit: { type: "string" } } });
    if (!values.list && (values.after !== undefined || values.limit !== undefined)) throw failure("读取游标只能用于 --list");
    const rawPort = process.env.CODEX_CALLBACK_RECEIVER_PORT ?? "0", port = Number(rawPort);
    if (!values.list && (!/^\d+$/.test(rawPort) || !Number.isSafeInteger(port) || port < 0 || port > 65535)) throw failure("监听端口无效");
    inbox = openCallbackInbox({ file: process.env.CODEX_CALLBACK_RECEIVER_STATE, secret: process.env.CODEX_CALLBACK_RECEIVER_SECRET,
      automationId: process.env.CODEX_CALLBACK_RECEIVER_AUTOMATION_ID, readOnly: Boolean(values.list) });
    if (values.list) {
      console.log(JSON.stringify(inbox.list({ after: Number(values.after ?? 0), limit: Number(values.limit ?? 20) })));
      inbox.close();
    } else {
      const server = createCallbackInboxServer(inbox);
      let stopping = false;
      const stop = () => { if (stopping) return; stopping = true; server.close(() => inbox.close()); server.closeAllConnections(); };
      process.once("SIGTERM", stop); process.once("SIGINT", stop);
      server.once("error", () => { inbox.close(); console.error("回调接收端无法监听，请检查端口与状态配置"); process.exitCode = 1; });
      server.listen(port, "127.0.0.1", () => console.log(JSON.stringify({ ok: true, url: `http://127.0.0.1:${server.address().port}/codex/completed`, file: process.env.CODEX_CALLBACK_RECEIVER_STATE })));
    }
  } catch (error) { inbox?.close(); console.error(`回调接收端启动失败：${error.message}`); process.exitCode = 1; }
}
