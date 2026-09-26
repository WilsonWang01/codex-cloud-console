import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { listPersonalFiles, resolvePersonalFile } from "./personal-files.mjs";

const defaultMaxBytes = 20 * 1024 * 1024;

function bridgeError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

export function personalFileSocketPath(appServerSocketPath) {
  return path.join(path.dirname(appServerSocketPath), "files.sock");
}

function relativeParts(value) {
  const requested = String(value || "").replaceAll("\\", "/");
  if (requested === ".") return [];
  if (!requested || path.isAbsolute(requested)) throw bridgeError("Invalid personal path");
  const parts = requested.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.includes("\0"))) throw bridgeError("Invalid personal path");
  const uploadPath = parts[0] === ".codex-cloud" && parts[1] === "uploads";
  if (parts.some((part, index) => part.startsWith(".") && !(uploadPath && index === 0))) throw bridgeError("Personal system files are not available", 403);
  if (parts.includes("node_modules") || parts.includes(".git")) throw bridgeError("Personal system files are not available", 403);
  return parts;
}

async function validatePersonalPath(root, requested, allowMissing = false) {
  const parts = relativeParts(requested);
  let target = root;
  for (const part of parts) {
    target = path.join(target, part);
    let stat;
    try { stat = await fs.lstat(target); }
    catch (error) {
      if (error?.code === "ENOENT") {
        if (allowMissing) return path.join(root, ...parts);
        throw bridgeError("Personal path does not exist", 404);
      }
      throw error;
    }
    if (stat.isSymbolicLink()) throw bridgeError("Personal path symlinks are not available", 403);
  }
  return target;
}

async function ensureUploadDirectory(root, date) {
  let target = root;
  for (const part of [".codex-cloud", "uploads", date]) {
    target = path.join(target, part);
    try { await fs.mkdir(target, { mode: 0o700 }); }
    catch (error) { if (error?.code !== "EEXIST") throw error; }
    const stat = await fs.lstat(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw bridgeError("Personal upload directory is unsafe", 403);
  }
  return target;
}

async function readJsonRequest(req, maxBytes) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > maxBytes) throw bridgeError("Personal file request is too large", 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw bridgeError("Invalid personal file request"); }
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(payload));
}

function safeFileName(value) {
  return (String(value || "upload").replaceAll("\\", "/").split("/").at(-1) || "upload")
    .replace(/[\x00-\x1f\x7f]/g, "_").slice(0, 150).trim() || "upload";
}

export function createPersonalFileBridgeServer({ root, socketPath, maxBytes = defaultMaxBytes }) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://personal.local");
      if (req.method === "GET" && url.pathname === "/files") {
        return sendJson(res, 200, { ok: true, files: await listPersonalFiles(root) });
      }
      if (req.method === "POST" && url.pathname === "/validate") {
        const body = await readJsonRequest(req, 4096);
        await validatePersonalPath(root, body.path, body.allowMissing === true);
        return sendJson(res, 200, { ok: true });
      }
      if (["GET", "HEAD"].includes(req.method) && url.pathname === "/files/content") {
        const file = await resolvePersonalFile(root, url.searchParams.get("path"), maxBytes);
        const inline = url.searchParams.get("preview") === "1" && file.mimeType !== "application/octet-stream";
        const headers = {
          "Content-Type": inline ? file.mimeType : "application/octet-stream",
          "Content-Length": String(file.stat.size),
          "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="file"; filename*=UTF-8''${encodeURIComponent(path.basename(file.target))}`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "sandbox",
        };
        if (req.method === "HEAD") { res.writeHead(200, headers); return res.end(); }
        const handle = await fs.open(file.target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        const opened = await handle.stat().catch(async (error) => { await handle.close(); throw error; });
        if (!opened.isFile() || opened.dev !== file.stat.dev || opened.ino !== file.stat.ino || opened.size !== file.stat.size) {
          await handle.close();
          throw bridgeError("Personal file changed before read", 409);
        }
        res.writeHead(200, headers);
        const stream = handle.createReadStream();
        stream.on("error", (error) => res.destroy(error));
        res.on("close", () => stream.destroy());
        return stream.pipe(res);
      }
      if (req.method === "POST" && url.pathname === "/uploads") {
        const body = await readJsonRequest(req, Math.ceil(maxBytes * 4 / 3) + 4096);
        const encoded = String(body.dataBase64 || "");
        if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw bridgeError("Invalid upload data");
        const buffer = Buffer.from(encoded, "base64");
        if (!buffer.length || buffer.length > maxBytes || buffer.toString("base64") !== encoded) throw bridgeError("Invalid upload size or data", 413);
        const date = new Date().toISOString().slice(0, 10);
        const uploadDir = await ensureUploadDirectory(root, date);
        const name = safeFileName(body.name);
        const fileName = `${Date.now()}-${crypto.randomBytes(3).toString("hex")}-${name}`;
        const target = path.join(uploadDir, fileName);
        await fs.writeFile(target, buffer, { flag: "wx", mode: 0o600 });
        return sendJson(res, 201, {
          ok: true,
          file: { name, path: path.relative(root, target), size: buffer.length, mimeType: String(body.mimeType || "application/octet-stream").slice(0, 120) },
        });
      }
      if (req.method === "DELETE" && url.pathname === "/uploads") {
        const relativePath = url.searchParams.get("path") || "";
        if (!/^\.codex-cloud\/uploads\/\d{4}-\d{2}-\d{2}\/[^/]+$/.test(relativePath)) throw bridgeError("Invalid upload path");
        const file = await resolvePersonalFile(root, relativePath, Number.MAX_SAFE_INTEGER);
        if (!file.input) throw bridgeError("Not a personal upload");
        await fs.unlink(file.target);
        await fs.rmdir(path.dirname(file.target)).catch(() => null);
        return sendJson(res, 200, { ok: true, deleted: file.relativePath });
      }
      return sendJson(res, 404, { ok: false, error: "Unknown personal file operation" });
    } catch (error) {
      if (res.headersSent) return res.destroy(error);
      return sendJson(res, error?.statusCode || 500, { ok: false, error: error?.message || "Personal file operation failed" });
    }
  });
  return {
    server,
    listen: () => new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, async () => {
        server.removeListener("error", reject);
        try { await fs.chmod(socketPath, 0o660); resolve(); }
        catch (error) { reject(error); }
      });
    }),
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

export function personalFileBridgeStream(socketPath, method, pathname, body = null, timeoutMs = 30_000) {
  const payload = body === null ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, path: pathname, method, timeout: timeoutMs, headers: payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {} }, resolve);
    request.on("timeout", () => request.destroy(bridgeError("Personal file worker timed out", 503)));
    request.on("error", (error) => reject(bridgeError(error.message, error.statusCode || 503)));
    request.end(payload);
  });
}

export async function personalFileBridgeJson(socketPath, method, pathname, body = null, timeoutMs = 30_000) {
  const response = await personalFileBridgeStream(socketPath, method, pathname, body, timeoutMs);
  const chunks = [];
  let length = 0;
  for await (const chunk of response) {
    length += chunk.length;
    if (length > 1024 * 1024) throw bridgeError("Personal file response is too large", 502);
    chunks.push(chunk);
  }
  let payload;
  try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw bridgeError("Invalid personal file worker response", 502); }
  if (response.statusCode < 200 || response.statusCode >= 300 || !payload?.ok) {
    throw bridgeError(payload?.error || "Personal file worker rejected request", response.statusCode || 502);
  }
  return payload;
}
