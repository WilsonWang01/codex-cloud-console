#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

const port = Number(process.env.CODEX_CLOUD_CONSOLE_PORT || 18787);
const host = process.env.CODEX_CLOUD_CONSOLE_HOST || "127.0.0.1";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const distRoot = path.join(projectRoot, "dist");
const credentialsPath =
  process.env.CODEX_CLOUD_CONSOLE_CREDENTIALS ||
  `${process.env.HOME}/.codex/cloud-console-https-credentials`;
const cachePath = process.env.CODEX_CLOUD_CONSOLE_CACHE || `${process.env.HOME}/.codex/cloud-console-proxy-cache.json`;
const proxyFreshCacheTtlMs = Number(process.env.CODEX_CLOUD_CONSOLE_FRESH_CACHE_TTL_MS || 8_000);
const proxyHeaderTimeoutMs = Math.max(500, Number(process.env.CODEX_CLOUD_CONSOLE_HEADER_TIMEOUT_MS || 15_000));
const proxyHealthHeaderTimeoutMs = Math.max(500, Number(process.env.CODEX_CLOUD_CONSOLE_HEALTH_TIMEOUT_MS || 8_000));
const proxyBufferedIdleTimeoutMs = Math.max(1_000, Number(process.env.CODEX_CLOUD_CONSOLE_BUFFER_IDLE_TIMEOUT_MS || 20_000));
const proxyGetRetryLimit = Math.min(3, Math.max(0, Number(process.env.CODEX_CLOUD_CONSOLE_GET_RETRY_LIMIT || 1)));

function isIpv4Address(value) {
  const parts = String(value || "").split(".");
  return parts.length === 4 && parts.every((part) => /^\d+$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

function isPrivateOrLoopbackIpv4(value) {
  if (!isIpv4Address(value)) return false;
  const [a, b] = value.split(".").map(Number);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

function normalizeConsoleTarget(rawTarget) {
  const target = new URL(rawTarget);
  if (
    target.protocol === "http:" &&
    isIpv4Address(target.hostname) &&
    !isPrivateOrLoopbackIpv4(target.hostname) &&
    process.env.CODEX_CLOUD_CONSOLE_ALLOW_PUBLIC_HTTP !== "1"
  ) {
    const normalized = new URL(target.href);
    normalized.protocol = "https:";
    normalized.hostname = `${target.hostname}.sslip.io`;
    normalized.port = "";
    return normalized;
  }
  return target;
}

function readCredentials() {
  const raw = fs.readFileSync(credentialsPath, "utf8");
  const values = Object.fromEntries(
    raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const index = line.indexOf("=");
        return index >= 0 ? [line.slice(0, index), line.slice(index + 1)] : [line, ""];
      }),
  );
  const rawTarget = process.env.CODEX_CLOUD_CONSOLE_TARGET || values.https_url || values.url || "https://13.231.3.21.sslip.io/";
  return {
    target: normalizeConsoleTarget(rawTarget),
    upstreamIp: process.env.CODEX_CLOUD_CONSOLE_UPSTREAM_IP || values.public_ip || values.ip || "",
    username: process.env.CODEX_CLOUD_CONSOLE_USERNAME || values.username || "codex",
    password: process.env.CODEX_CLOUD_CONSOLE_PASSWORD || values.password || "",
    token: process.env.CODEX_CLOUD_CONSOLE_TOKEN || values.token || "",
  };
}

const credentials = readCredentials();
const authHeader = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}`;
const responseCache = loadResponseCache();
const oauthRelayServers = new Map();
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
};

function upstreamHostname(targetUrl) {
  if (credentials.upstreamIp) return credentials.upstreamIp;
  const sslipMatch = targetUrl.hostname.match(/^(\d+\.\d+\.\d+\.\d+)\.sslip\.io$/);
  if (sslipMatch) return sslipMatch[1];
  return targetUrl.hostname;
}

function localStaticPath(requestPath) {
  let pathname;
  try {
    pathname = decodeURIComponent((requestPath || "/").split("?")[0]);
  } catch {
    return null;
  }
  if (pathname === "/") pathname = "/index.html";
  if (pathname.includes("\0")) return null;
  const filePath = path.resolve(distRoot, `.${pathname}`);
  if (filePath === distRoot || !filePath.startsWith(`${distRoot}${path.sep}`)) return null;
  try {
    const rootPath = fs.realpathSync(distRoot);
    const fileInfo = fs.lstatSync(filePath);
    if (fileInfo.isSymbolicLink() || !fileInfo.isFile()) return null;
    const realPath = fs.realpathSync(filePath);
    if (realPath !== rootPath && !realPath.startsWith(`${rootPath}${path.sep}`)) return null;
    return realPath;
  } catch {
    return null;
  }
}

function hasMalformedPathEncoding(requestPath) {
  try {
    decodeURIComponent((requestPath || "/").split("?")[0]);
    return false;
  } catch {
    return true;
  }
}

function loadResponseCache() {
  try {
    return new Map(Object.entries(JSON.parse(fs.readFileSync(cachePath, "utf8"))));
  } catch {
    return new Map();
  }
}

function persistResponseCache() {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(Object.fromEntries(responseCache), null, 2));
  } catch {
    // Best-effort cache only.
  }
}

function cacheKeyFor(targetUrl) {
  return `${targetUrl.protocol}//${targetUrl.host}${targetUrl.pathname}${targetUrl.search}`;
}

function cachedResponseFor(targetUrl) {
  if (!isCacheableApi(targetUrl)) return null;
  const cached = responseCache.get(cacheKeyFor(targetUrl));
  if (!cached) return null;
  const savedAt = Date.parse(cached.savedAt || "");
  const ageMs = Number.isFinite(savedAt) ? Date.now() - savedAt : Infinity;
  return { ...cached, ageMs };
}

function isCacheableApi(targetUrl) {
  return [
    "/api/notifications/external/status",
    "/api/notifications/push/status",
  ].includes(targetUrl.pathname);
}

function canServeFreshCacheImmediately(req, targetUrl, isStreamingRequest) {
  if (req.method !== "GET" || isStreamingRequest) return false;
  if (!isCacheableApi(targetUrl)) return false;
  if (targetUrl.searchParams.get("sync") === "1" || targetUrl.searchParams.get("force") === "1") return false;
  const cached = cachedResponseFor(targetUrl);
  return Boolean(cached && cached.ageMs >= 0 && cached.ageMs <= proxyFreshCacheTtlMs);
}

function cacheResponse(targetUrl, statusCode, headers, body) {
  if (!isCacheableApi(targetUrl)) return;
  if (statusCode < 200 || statusCode >= 300) return;
  if (!Buffer.isBuffer(body) || body.length > 5 * 1024 * 1024) return;
  const safeHeaders = { ...headers };
  delete safeHeaders["transfer-encoding"];
  delete safeHeaders["connection"];
  delete safeHeaders["content-encoding"];
  safeHeaders["content-length"] = String(body.length);
  safeHeaders["x-codex-cloud-cache"] = "fresh";
  responseCache.set(cacheKeyFor(targetUrl), {
    statusCode,
    headers: safeHeaders,
    body: body.toString("base64"),
    savedAt: new Date().toISOString(),
  });
  persistResponseCache();
}

function sendCachedResponse(targetUrl, res, options = {}) {
  const cached = cachedResponseFor(targetUrl);
  if (!cached) return false;
  const body = Buffer.from(cached.body || "", "base64");
  const headers = { ...(cached.headers || {}) };
  headers["content-length"] = String(body.length);
  headers["x-codex-cloud-cache"] = `${options.fresh ? "fresh-proxy" : "stale"}; saved-at=${cached.savedAt || "unknown"}`;
  if (!options.fresh) {
    headers["x-codex-cloud-proxy-fallback"] = "stale-cache";
    headers["warning"] = `110 - "Codex Cloud proxy served stale cached response"`;
  }
  if (!safeWriteHead(res, cached.statusCode || 200, headers)) return false;
  safeEnd(res, body);
  return true;
}

function refreshCacheInBackground(targetUrl, headers, method = "GET") {
  const transport = targetUrl.protocol === "http:" ? http : https;
  const upstream = transport.request(
    {
      protocol: targetUrl.protocol,
      hostname: upstreamHostname(targetUrl),
      servername: targetUrl.hostname,
      port: targetUrl.port || (targetUrl.protocol === "http:" ? 80 : 443),
      method,
      path: `${targetUrl.pathname}${targetUrl.search}`,
      headers,
      agent: false,
    },
    (upstreamRes) => {
      const chunks = [];
      let bytes = 0;
      upstreamRes.on("data", (chunk) => {
        chunks.push(chunk);
        bytes += chunk.length;
      });
      upstreamRes.on("end", () => {
        const expected = Number(upstreamRes.headers["content-length"] || 0);
        if (expected > 0 && bytes !== expected) return;
        cacheResponse(targetUrl, upstreamRes.statusCode || 502, upstreamRes.headers, method === "HEAD" ? Buffer.alloc(0) : Buffer.concat(chunks, bytes));
      });
      upstreamRes.on("error", () => null);
    },
  );
  upstream.on("error", () => null);
  upstream.setTimeout(20_000, () => upstream.destroy(new Error("background cache refresh timed out")));
  upstream.end();
}

function isTransientProxyError(error) {
  const code = String(error?.code || "");
  const message = String(error?.message || "");
  return /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|socket hang up|upstream did not send headers in time/i.test(`${code} ${message}`);
}

function readRequestBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, payload, headers = {}) {
  const body = Buffer.from(`${JSON.stringify(payload)}\n`);
  if (!safeWriteHead(res, statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-cache",
    ...headers,
  })) return;
  safeEnd(res, body);
}

function safeWriteHead(res, statusCode, headers = {}) {
  if (res.destroyed || res.headersSent || res.writableEnded) return false;
  res.writeHead(statusCode, headers);
  return true;
}

function safeEnd(res, body) {
  if (res.destroyed || res.writableEnded) return false;
  res.end(body);
  return true;
}

function sendPlainError(res, statusCode, message) {
  if (!safeWriteHead(res, statusCode, { "content-type": "text/plain; charset=utf-8" })) {
    return safeEnd(res);
  }
  return safeEnd(res, message);
}

function proxyRequestId() {
  return `proxy-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}`;
}

function wantsJsonProxyError(targetUrl) {
  return targetUrl.pathname === "/healthz" || targetUrl.pathname.startsWith("/api/");
}

function sendProxyError(res, statusCode, message, targetUrl, requestId, extra = {}) {
  const headers = {
    "x-codex-cloud-proxy-error": "1",
    "x-codex-cloud-request-id": requestId,
  };
  if (wantsJsonProxyError(targetUrl)) {
    return sendJson(
      res,
      statusCode,
      {
        ok: false,
        layer: "local-proxy",
        requestId,
        path: targetUrl.pathname,
        error: message,
        ...extra,
      },
      headers,
    );
  }
  return sendPlainError(res, statusCode, `Cloud console proxy error (${requestId}): ${message}\n`);
}

function requestCloudJson(pathname, payload) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload));
    const targetUrl = new URL(pathname, credentials.target);
    const headers = {
      "content-type": "application/json",
      "content-length": body.length,
      host: targetUrl.host,
    };
    if (credentials.token) headers["x-codex-cloud-token"] = credentials.token;
    if (targetUrl.protocol === "https:" && credentials.password) headers.authorization = authHeader;
    const transport = targetUrl.protocol === "http:" ? http : https;
    const upstream = transport.request(
      {
        protocol: targetUrl.protocol,
        hostname: upstreamHostname(targetUrl),
        servername: targetUrl.hostname,
        port: targetUrl.port || (targetUrl.protocol === "http:" ? 80 : 443),
        method: "POST",
        path: `${targetUrl.pathname}${targetUrl.search}`,
        headers,
        agent: false,
      },
      (upstreamRes) => {
        const chunks = [];
        upstreamRes.on("data", (chunk) => chunks.push(chunk));
        upstreamRes.on("end", () => {
          resolve({
            statusCode: upstreamRes.statusCode || 502,
            headers: upstreamRes.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    upstream.on("error", reject);
    upstream.end(body);
  });
}

function parseOAuthRedirect(authorizationUrl) {
  const authUrl = new URL(String(authorizationUrl || ""));
  const redirect = new URL(authUrl.searchParams.get("redirect_uri") || "");
  if (redirect.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(redirect.hostname)) {
    throw new Error("OAuth redirect_uri is not a loopback HTTP callback");
  }
  const portNumber = Number(redirect.port);
  if (!Number.isInteger(portNumber) || portNumber < 1024 || portNumber > 65535) {
    throw new Error("OAuth redirect_uri has an invalid callback port");
  }
  if (!redirect.pathname.startsWith("/callback/")) {
    throw new Error("OAuth redirect_uri has an invalid callback path");
  }
  return { port: portNumber, path: redirect.pathname };
}

function startOAuthRelay({ port, path: callbackPath }) {
  const existing = oauthRelayServers.get(port);
  if (existing) {
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => existing.server.close(), 10 * 60 * 1000);
    return Promise.resolve({ ok: true, port, path: callbackPath, reused: true });
  }

  return new Promise((resolve, reject) => {
    const relayServer = http.createServer(async (req, res) => {
      try {
        const requestUrl = new URL(req.url || "/", `http://127.0.0.1:${port}`);
        if (!requestUrl.pathname.startsWith("/callback/")) {
          sendPlainError(res, 404, "Unknown OAuth relay path\n");
          return;
        }
        const upstream = await requestCloudJson("/api/codex/mcp/oauth-callback-relay", {
          port,
          path: requestUrl.pathname,
          query: requestUrl.searchParams.toString(),
        });
        safeWriteHead(res, upstream.statusCode, {
          "content-type": upstream.headers["content-type"] || "text/html; charset=utf-8",
          "content-length": upstream.body.length,
        });
        safeEnd(res, upstream.body);
        setTimeout(() => relayServer.close(), 2500);
      } catch (error) {
        sendPlainError(res, 502, `OAuth relay failed: ${error.message}\n`);
      }
    });
    relayServer.on("error", reject);
    relayServer.listen(port, "127.0.0.1", () => {
      const state = {
        server: relayServer,
        timer: setTimeout(() => relayServer.close(), 10 * 60 * 1000),
      };
      oauthRelayServers.set(port, state);
      relayServer.on("close", () => {
        clearTimeout(state.timer);
        oauthRelayServers.delete(port);
      });
      resolve({ ok: true, port, path: callbackPath, reused: false });
    });
  });
}

async function handleLocalOAuthRelay(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "Method not allowed" });
  try {
    const payload = JSON.parse(await readRequestBody(req));
    const redirect = parseOAuthRedirect(payload.authorizationUrl);
    sendJson(res, 200, await startOAuthRelay(redirect));
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error.message });
  }
}

function sendLocalFile(clientSocket, requestPath, method) {
  const filePath = localStaticPath(requestPath);
  if (!filePath) return false;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    const type = contentTypes[path.extname(filePath)] || "application/octet-stream";
    clientSocket.write(
      [
        "HTTP/1.1 200 OK",
        `content-type: ${type}`,
        `content-length: ${stat.size}`,
        "cache-control: no-cache",
        "connection: close",
        "",
        "",
      ].join("\r\n"),
    );
    if (method === "HEAD") {
      clientSocket.end();
    } else {
      const stream = fs.createReadStream(filePath);
      stream.on("error", () => clientSocket.destroy());
      stream.pipe(clientSocket);
    }
    return true;
  } catch {
    return false;
  }
}

function sendLocalFileResponse(req, res) {
  const filePath = localStaticPath(req.url || "/");
  if (!filePath) return false;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    const type = contentTypes[path.extname(filePath)] || "application/octet-stream";
    if (!safeWriteHead(res, 200, {
      "content-type": type,
      "content-length": stat.size,
      "cache-control": "no-cache",
      connection: "close",
    })) return true;
    if (req.method === "HEAD") {
      safeEnd(res);
    } else {
      const stream = fs.createReadStream(filePath);
      stream.on("error", (error) => {
        if (!res.headersSent) sendPlainError(res, 404, "Static file is no longer available\n");
        else res.destroy(error);
      });
      stream.pipe(res);
    }
    return true;
  } catch {
    return false;
  }
}

function createHttpProxy() {
  return http.createServer((req, res) => {
    if (hasMalformedPathEncoding(req.url || "/")) {
      sendPlainError(res, 400, "Malformed URL encoding\n");
      return;
    }
    if ((req.url || "").startsWith("/api/local/mcp-oauth-relay/start")) {
      handleLocalOAuthRelay(req, res);
      return;
    }

    if ((req.method === "GET" || req.method === "HEAD") && sendLocalFileResponse(req, res)) return;

    let targetUrl;
    try {
      targetUrl = new URL(req.url || "/", credentials.target);
    } catch {
      sendPlainError(res, 400, "Invalid request URL\n");
      return;
    }
    const requestId = proxyRequestId();
    const headers = { ...req.headers, host: targetUrl.host };
    headers["x-codex-cloud-request-id"] = requestId;
    if (credentials.token) headers["x-codex-cloud-token"] = credentials.token;
    if (targetUrl.protocol === "https:" && credentials.password) headers.authorization = authHeader;
    delete headers["proxy-connection"];
    delete headers["connection"];
    delete headers["accept-encoding"];
    headers.connection = "close";

    const transport = targetUrl.protocol === "http:" ? http : https;
    const canRetry = req.method === "GET" || req.method === "HEAD";
    const isStreamingRequest =
      targetUrl.pathname.includes("/stream") ||
      targetUrl.pathname.includes("job-events") ||
      String(req.headers.accept || "").includes("text/event-stream");
    const shouldBufferResponse = canRetry && !isStreamingRequest;
    const isHealthRequest = targetUrl.pathname === "/healthz" || targetUrl.pathname === "/api/status";
    const maxRetries = isHealthRequest ? 0 : proxyGetRetryLimit;
    let completed = false;

    if (canServeFreshCacheImmediately(req, targetUrl, isStreamingRequest)) {
      completed = true;
      sendCachedResponse(targetUrl, res, { fresh: true });
      refreshCacheInBackground(targetUrl, headers, req.method);
      return;
    }

    const proxyRequest = (attempt = 0) => {
      if (completed || res.destroyed) return;
      let responded = false;
      let upstream = null;
      const responseTimer = setTimeout(() => {
        if (responded) return;
        upstream?.destroy(new Error("upstream did not send headers in time"));
      }, isHealthRequest ? proxyHealthHeaderTimeoutMs : proxyHeaderTimeoutMs);

      upstream = transport.request(
        {
          protocol: targetUrl.protocol,
          hostname: upstreamHostname(targetUrl),
          servername: targetUrl.hostname,
          port: targetUrl.port || (targetUrl.protocol === "http:" ? 80 : 443),
          method: req.method,
          path: `${targetUrl.pathname}${targetUrl.search}`,
          headers,
          agent: false,
        },
        (upstreamRes) => {
          if (completed || res.headersSent || res.destroyed) {
            upstreamRes.resume();
            return;
          }
          responded = true;
          clearTimeout(responseTimer);
          if (shouldBufferResponse) {
            upstreamRes.setTimeout(proxyBufferedIdleTimeoutMs, () => {
              upstreamRes.destroy(new Error("upstream response body timed out"));
            });
            const chunks = [];
            let bytes = 0;
            const retryBuffered = () => {
              if (completed || res.headersSent || res.destroyed) return false;
              if (attempt < maxRetries) {
                setTimeout(() => proxyRequest(attempt + 1), 200 * (attempt + 1));
                return true;
              }
              return false;
            };
            upstreamRes.on("data", (chunk) => {
              chunks.push(chunk);
              bytes += chunk.length;
            });
            upstreamRes.on("end", () => {
              if (completed || res.destroyed) return;
              const expected = Number(upstreamRes.headers["content-length"] || 0);
              if (expected > 0 && bytes !== expected) {
                if (retryBuffered()) return;
                completed = true;
                if (sendCachedResponse(targetUrl, res)) return;
                sendProxyError(res, 502, "upstream response was truncated", targetUrl, requestId, { cause: "truncated-response" });
                return;
              }
              completed = true;
              const body = req.method === "HEAD" ? Buffer.alloc(0) : Buffer.concat(chunks, bytes);
              cacheResponse(targetUrl, upstreamRes.statusCode || 502, upstreamRes.headers, body);
              if (!safeWriteHead(res, upstreamRes.statusCode || 502, upstreamRes.headers)) return;
              safeEnd(res, req.method === "HEAD" ? undefined : body);
            });
            upstreamRes.on("error", () => {
              if (completed || res.destroyed) return;
              if (retryBuffered()) return;
              completed = true;
              if (sendCachedResponse(targetUrl, res)) return;
              sendProxyError(res, 502, "upstream response was interrupted", targetUrl, requestId, { cause: "interrupted-response" });
            });
            return;
          }
          if (!safeWriteHead(res, upstreamRes.statusCode || 502, upstreamRes.headers)) {
            upstreamRes.resume();
            return;
          }
          upstreamRes.on("error", () => {
            safeEnd(res);
          });
          upstreamRes.pipe(res);
        },
      );

      upstream.on("error", (error) => {
        clearTimeout(responseTimer);
        if (completed || res.destroyed) return;
        if (canRetry && !responded && !res.headersSent && attempt < maxRetries && isTransientProxyError(error)) {
          setTimeout(() => proxyRequest(attempt + 1), 200 * (attempt + 1));
          return;
        }
        completed = true;
        if (res.headersSent) {
          safeEnd(res);
          return;
        }
        if (canRetry && sendCachedResponse(targetUrl, res)) return;
        sendProxyError(res, 502, error.message || "upstream request failed", targetUrl, requestId, { cause: String(error.code || "upstream-error") });
      });

      if (canRetry) {
        upstream.end();
      } else {
        req.pipe(upstream);
      }
    };

    proxyRequest();
  });
}

const server = createHttpProxy();

server.on("clientError", (_error, socket) => {
  if (!socket.writable) return;
  socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
});

server.listen(port, host, () => {
  console.log(`Codex Cloud Console local http proxy ready: http://${host}:${port}/ -> ${credentials.target.href}`);
});
