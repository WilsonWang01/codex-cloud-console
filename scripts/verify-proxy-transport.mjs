import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs/promises";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = new URL("../", import.meta.url).pathname;
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => server.close(resolve));

async function withProxy(target, check, extraEnv = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-proxy-transport-"));
  const credentials = path.join(dir, "credentials");
  await fs.writeFile(credentials, `url=${target}\nusername=test\npassword=PRIVATE-PASSWORD\ntoken=PRIVATE-TOKEN\n`, { mode: 0o600 });
  const child = spawn(process.execPath, [path.join(root, "scripts/local-cloud-console-proxy.mjs")], {
    cwd: root,
    env: { ...process.env, ...extraEnv, CODEX_CLOUD_CONSOLE_PORT: "0", CODEX_CLOUD_CONSOLE_HOST: "127.0.0.1",
      CODEX_CLOUD_CONSOLE_CREDENTIALS: credentials, CODEX_CLOUD_CONSOLE_CACHE: path.join(dir, "cache.json"),
      CODEX_CLOUD_CONSOLE_TARGET: target, CODEX_CLOUD_CONSOLE_UPSTREAM_IP: "127.0.0.1",
      CODEX_CLOUD_CONSOLE_HEADER_TIMEOUT_MS: "600", CODEX_CLOUD_CONSOLE_GET_RETRY_LIMIT: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    const base = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("proxy startup timed out")), 10000);
      child.stdout.on("data", (chunk) => {
        const match = String(chunk).match(/ready: (http:\/\/127\.0\.0\.1:\d+)\//);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
      child.once("exit", () => { clearTimeout(timer); reject(new Error("proxy exited before startup")); });
    });
    const events = () => stderr.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
    await check(base, events);
    assert.doesNotMatch(stderr, /PRIVATE-PASSWORD|PRIVATE-TOKEN|PRIVATE-QUERY|PRIVATE-BODY|PRIVATE-HEADER|private-command/);
    for (const event of events()) {
      assert(event.transport.length >= 1 && event.transport.length <= 2);
      assert.equal(event.transport.length, event.attempts);
      for (const attempt of event.transport) {
        assert.deepEqual(Object.keys(attempt).sort(), ["attempt", "cause", "connectMs", "durationMs", "headersMs", "phase", "requestFlushedMs", "socketMs", "tlsMs"].sort());
        for (const key of ["socketMs", "connectMs", "tlsMs", "requestFlushedMs", "headersMs", "durationMs"])
          assert(attempt[key] === null || Number.isSafeInteger(attempt[key]) && attempt[key] >= 0);
      }
    }
  } finally {
    if (child.exitCode === null) {
      const stopped = new Promise((resolve) => child.once("exit", resolve));
      child.kill(); await stopped;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("proxy records refused connections and TLS handshake resets without private data", async () => {
  const unused = net.createServer();
  const port = await listen(unused); await close(unused);
  await withProxy(`http://127.0.0.1:${port}/`, async (base, events) => {
    const response = await fetch(`${base}/api/terminal/run?secret=PRIVATE-QUERY`, { method: "POST", body: "PRIVATE-BODY", headers: { authorization: "PRIVATE-HEADER" } });
    assert.equal(response.status, 502); const body = await response.json();
    const event = events().find((item) => item.requestId === body.requestId);
    assert.equal(event.route, "/api/terminal"); assert.equal(event.attempts, 1);
    assert.equal(event.transport[0].phase, "connect"); assert.equal(event.transport[0].cause, "ECONNREFUSED");
    assert.equal(event.transport[0].connectMs, null); assert.equal(event.transport[0].headersMs, null);
  });
  let connections = 0;
  const raw = net.createServer((socket) => { connections++; socket.once("data", () => socket.destroy()); });
  const rawPort = await listen(raw);
  try {
    await withProxy(`https://localhost:${rawPort}/`, async (base, events) => {
      const response = await fetch(`${base}/api/terminal/run`, { method: "POST", body: "PRIVATE-BODY" });
      assert.equal(response.status, 502); await response.arrayBuffer();
      assert.equal(connections, 1, "TLS failure must not replay a write");
      const trace = events()[0].transport[0];
      assert.equal(trace.phase, "tls"); assert.equal(trace.cause, "ECONNRESET");
      assert.notEqual(trace.connectMs, null); assert.equal(trace.tlsMs, null); assert.equal(trace.headersMs, null);
    });
  } finally { await close(raw); }
});

test("proxy distinguishes trusted TLS, header waits, reset writes, recovered reads and interrupted bodies", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-proxy-tls-"));
  const key = path.join(dir, "key.pem"), cert = path.join(dir, "cert.pem");
  execFileSync(process.platform === "darwin" ? "/usr/bin/openssl" : "openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"], { stdio: "pipe", timeout: 15000 });
  let reads = 0, writes = 0;
  const sockets = new Set();
  const upstream = https.createServer({ key: await fs.readFile(key), cert: await fs.readFile(cert) }, (req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.method === "POST") { writes++; return req.socket.destroy(); }
      if (req.url.startsWith("/api/chat/recover")) {
        if (++reads === 1) return req.socket.destroy();
        return res.end("ok");
      }
      if (req.url === "/api/files/body") {
        res.writeHead(200, { "content-length": 100 }); res.write("partial");
        setTimeout(() => res.destroy(), 20); return;
      }
      // /api/status intentionally waits for the proxy's header deadline.
    });
  });
  upstream.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  const port = await listen(upstream);
  try {
    await withProxy(`https://localhost:${port}/`, async (base, events) => {
      const write = await fetch(`${base}/api/terminal/run?secret=PRIVATE-QUERY`, { method: "POST", body: "PRIVATE-BODY" });
      assert.equal(write.status, 502); const failed = await write.json();
      assert.equal(writes, 1);
      const writeTrace = events().find((event) => event.requestId === failed.requestId).transport[0];
      assert.equal(writeTrace.phase, "response-headers"); assert.equal(writeTrace.cause, "ECONNRESET");
      assert.notEqual(writeTrace.tlsMs, null); assert.notEqual(writeTrace.requestFlushedMs, null); assert.equal(writeTrace.headersMs, null);
      const recovered = await fetch(`${base}/api/chat/recover?secret=PRIVATE-QUERY`);
      assert.equal(await recovered.text(), "ok"); assert.equal(reads, 2);
      const recovery = events().find((event) => event.outcome === "recovered");
      assert.equal(recovery.transport[0].cause, "ECONNRESET");
      assert.equal(recovery.transport[0].phase, "response-headers");
      assert.equal(recovery.transport[1].cause, null); assert.equal(recovery.transport[1].phase, "response-body");
      const body = await fetch(`${base}/api/files/body`); assert.equal(body.status, 502); await body.arrayBuffer();
      const interrupted = events().find((event) => event.cause === "interrupted-response");
      assert.equal(interrupted.transport.length, 2);
      for (const trace of interrupted.transport) { assert.equal(trace.phase, "response-body"); assert.notEqual(trace.headersMs, null); }
      const wait = await fetch(`${base}/api/status`); assert.equal(wait.status, 502); await wait.arrayBuffer();
      const timeout = events().find((event) => event.cause === "header-timeout");
      assert.equal(timeout.transport[0].phase, "response-headers"); assert.notEqual(timeout.transport[0].tlsMs, null);
    }, { NODE_EXTRA_CA_CERTS: cert, CODEX_CLOUD_CONSOLE_HEALTH_TIMEOUT_MS: "600" });
  } finally {
    for (const socket of sockets) socket.destroy();
    await close(upstream); await fs.rm(dir, { recursive: true, force: true });
  }
});
