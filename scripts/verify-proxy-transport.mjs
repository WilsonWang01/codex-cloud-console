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
    env: { ...process.env, CODEX_CLOUD_CONSOLE_PORT: "0", CODEX_CLOUD_CONSOLE_HOST: "127.0.0.1",
      CODEX_CLOUD_CONSOLE_CREDENTIALS: credentials, CODEX_CLOUD_CONSOLE_CACHE: path.join(dir, "cache.json"),
      CODEX_CLOUD_CONSOLE_TARGET: target, CODEX_CLOUD_CONSOLE_UPSTREAM_IP: "127.0.0.1",
      CODEX_CLOUD_CONSOLE_HEADER_TIMEOUT_MS: "600", CODEX_CLOUD_CONSOLE_GET_RETRY_LIMIT: "1", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "", stdout = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
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
    assert.doesNotMatch(stdout, /PRIVATE-PASSWORD|PRIVATE-TOKEN|PRIVATE-QUERY|PRIVATE-BODY|PRIVATE-HEADER|private-command/);
    assert.doesNotMatch(stderr, /MaxListenersExceededWarning/);
    for (const event of events()) {
      assert(event.transport.length >= 1 && event.transport.length <= 2);
      assert.equal(event.transport.length, event.attempts);
      for (const attempt of event.transport) {
        assert.deepEqual(Object.keys(attempt).sort(), ["attempt", "cause", "connectMs", "durationMs", "headersMs", "phase", "requestFlushedMs", "reusedSocket", "socketMs", "tlsMs"].sort());
        assert.equal(typeof attempt.reusedSocket, "boolean");
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
    await withProxy(`https://PRIVATE-HEADER:PRIVATE-PASSWORD@localhost:${rawPort}/?secret=PRIVATE-QUERY#PRIVATE-BODY`, async (base, events) => {
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
  let reads = 0, writes = 0, calendarReads = 0, calendarActions = 0;
  const sockets = new Set();
  const upstream = https.createServer({ key: await fs.readFile(key), cert: await fs.readFile(cert) }, (req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/api/personal/calendar/refresh") {
        calendarReads++;
        return setTimeout(() => res.end(JSON.stringify({ ok: true })), 1000);
      }
      if (req.method === "POST" && req.url.startsWith("/api/personal/calendar-proposals")) {
        calendarActions++;
        if (req.url.includes("000000000002")) return req.socket.destroy();
        return setTimeout(() => res.end(JSON.stringify({ ok: true })), 1000);
      }
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
      const calendar = await fetch(`${base}/api/personal/calendar/refresh`, { method: "POST", body: "{}" });
      assert.equal(calendar.status, 200); assert.deepEqual(await calendar.json(), { ok: true });
      assert.equal(calendarReads, 1, "source read has a sufficient header wait without replaying the POST");
      for (const route of ["/api/personal/calendar-proposals", "/api/personal/calendar-proposals/00000000-0000-4000-8000-000000000001/execute"]) {
        const action = await fetch(base + route, { method: "POST", body: "{}" });
        assert.equal(action.status, 200); assert.deepEqual(await action.json(), { ok: true });
      }
      const uncertainAction = await fetch(base + "/api/personal/calendar-proposals/00000000-0000-4000-8000-000000000002/execute", { method: "POST", body: "{}" });
      assert.equal(uncertainAction.status, 502); await uncertainAction.arrayBuffer();
      assert.equal(calendarActions, 3, "calendar confirmation waits long enough and an uncertain write is never replayed");
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

test("bounded TLS reuse retains streaming, rotates closed sockets and never repeats uncertain writes", { timeout: 50000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-proxy-pool-"));
  const key = path.join(dir, "key.pem"), cert = path.join(dir, "cert.pem");
  execFileSync(process.platform === "darwin" ? "/usr/bin/openssl" : "openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"], { stdio: "pipe", timeout: 15000 });
  let connections = 0, writes = 0, holds = 0, peak = 0, activeStreams = 0, releaseHeld;
  const live = new Set(), timers = new Set();
  const held = new Promise(resolve => { releaseHeld = resolve; });
  let sixteenReady;
  const sixteen = new Promise(resolve => { sixteenReady = resolve; });
  const upstream = https.createServer({ key: await fs.readFile(key), cert: await fs.readFile(cert) }, (req, res) => {
    req.resume();
    req.once("end", async () => {
      if (req.method === "POST") { writes++; req.socket.destroy(); return; }
      if (req.url === "/api/chat/stalled/stream") {
        activeStreams++;
        res.once("close", () => { activeStreams--; });
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: subscribed\n\n"); return;
      }
      if (req.url === "/api/chat/stream") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: start\n\n");
        const timer = setTimeout(() => { timers.delete(timer); res.end("data: finished\n\n"); }, 31000);
        timers.add(timer); return;
      }
      if (req.url.startsWith("/api/chat/held")) {
        if (++holds === 16) sixteenReady();
        await held;
      }
      res.end("ok");
    });
  });
  upstream.on("secureConnection", socket => {
    connections++; live.add(socket); peak = Math.max(peak, live.size);
    socket.once("close", () => live.delete(socket));
  });
  const port = await listen(upstream);
  try {
    await withProxy(`https://localhost:${port}/`, async (base, events) => {
      for (let n = 0; n < 20; n++) assert.equal(await (await fetch(`${base}/api/chat/reuse/${n}`)).text(), "ok");
      assert.equal(connections, 1, "successive HTTPS requests should reuse a single verified TLS connection");
      upstream.closeIdleConnections();
      for (let n = 0; n < 200 && live.size; n++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(live.size, 0);
      assert.equal(await (await fetch(`${base}/api/chat/rotated`)).text(), "ok");
      assert.equal(connections, 2);
      const failed = await fetch(`${base}/api/terminal/run`, { method: "POST", body: "PRIVATE-BODY" });
      assert.equal(failed.status, 502);
      const failure = await failed.json();
      assert.equal(writes, 1, "a reset pooled write must not be replayed");
      const trace = events().find(event => event.requestId === failure.requestId).transport[0];
      assert.equal(trace.phase, "response-headers");
      assert.equal(trace.reusedSocket, true);
      assert.notEqual(trace.tlsMs, null, "already verified pooled TLS must not be mislabeled as a new handshake");
      assert.notEqual(trace.connectMs, null);
      const stream = await fetch(`${base}/api/chat/stream`);
      assert.match(await stream.text(), /data: start[\s\S]*data: finished/, "the 30s free-socket timeout must not close a 31s active stream");
      const requests = Array.from({ length: 24 }, (_, n) => fetch(`${base}/api/chat/held/${n}`).then(async response => { assert.equal(response.status, 200); assert.equal(await response.text(), "ok"); }));
      const allRequests = Promise.all(requests);
      allRequests.catch(() => {});
      for (let n = 0; n < 300 && holds < 16; n++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(holds, 16);
      await sixteen;
      assert.ok(live.size <= 32, "both connection lanes must remain bounded");
      releaseHeld();
      await allRequests;
      for (let n = 0; n < 100 && live.size > 6; n++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.ok(live.size <= 6, "control and streaming lanes retain at most four plus two idle connections");
      assert.ok(peak <= 32);
      assert.equal(writes, 1);
      const subscriptions = await Promise.all(Array.from({ length: 16 }, async () => {
        const controller = new AbortController();
        const response = await fetch(`${base}/api/chat/stalled/stream`, { signal: controller.signal });
        assert.equal(response.status, 200);
        const reader = response.body.getReader(); await reader.read();
        return { controller, reader };
      }));
      assert.equal(activeStreams, 16);
      assert.equal(await (await fetch(`${base}/api/chat/control-while-streaming`)).text(), "ok", "long-lived streams must not starve control requests");
      for (const { controller, reader } of subscriptions) { controller.abort(); await reader.read().catch(() => null); }
      for (let n = 0; n < 100 && activeStreams; n++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(activeStreams, 0);
      for (let n = 0; n < 20; n++) {
        const controller = new AbortController();
        const response = await fetch(`${base}/api/chat/stalled/stream`, { signal: controller.signal });
        assert.equal(response.status, 200);
        const reader = response.body.getReader();
        assert.match(Buffer.from((await reader.read()).value).toString(), /subscribed/);
        controller.abort();
        await reader.read().catch(() => null);
        for (let attempt = 0; attempt < 50 && activeStreams; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(activeStreams, 0, "closing a browser subscription must release its upstream pool slot without canceling a model task");
      }
    }, { NODE_EXTRA_CA_CERTS: cert, CODEX_CLOUD_CONSOLE_HEADER_TIMEOUT_MS: "5000" });
    const acceptedBeforeUntrusted = writes;
    await withProxy(`https://localhost:${port}/`, async base => {
      const response = await fetch(`${base}/api/terminal/run`, { method: "POST", body: "PRIVATE-BODY" });
      assert.equal(response.status, 502, "an untrusted TLS certificate must still fail closed");
      await response.arrayBuffer();
      assert.equal(writes, acceptedBeforeUntrusted);
    }, { NODE_EXTRA_CA_CERTS: "" });
  } finally {
    releaseHeld();
    for (const timer of timers) clearTimeout(timer);
    for (const socket of live) socket.destroy();
    await close(upstream); await fs.rm(dir, { recursive: true, force: true });
  }
});
