import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import { gzipSync, deflateSync, brotliCompressSync } from "node:zlib";
import test from "node:test";

test("压缩 JSON 尾随异常字节不能使解析进程崩溃，正常请求仍可处理", { timeout: 15000 }, async (t) => {
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import express from 'express';
    const app=express(); app.use(express.json({limit:'1mb'}));
    app.get('/health',(_req,res)=>res.json({ok:true}));
    app.post('/submit',(req,res)=>res.json({value:req.body?.value}));
    app.use((error,_req,res,_next)=>res.status(error.status||500).json({ok:false}));
    const server=app.listen(0,'127.0.0.1',()=>console.log(server.address().port));
  `], { cwd: new URL("../", import.meta.url), stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null) { const stopped = once(child, "exit"); child.kill("SIGTERM"); await stopped; }
  });
  const [data] = await once(child.stdout, "data");
  const port = Number(String(data).trim());
  assert.ok(Number.isSafeInteger(port) && port > 0);
  const url = `http://127.0.0.1:${port}`;
  const body = Buffer.from(JSON.stringify({ value: "synthetic parser regression" }));
  for (const [encoding, compress] of [["gzip", gzipSync], ["deflate", deflateSync], ["br", brotliCompressSync]]) {
    const compressed = compress(body);
    const valid = await fetch(`${url}/submit`, { method: "POST", headers: { "Content-Type": "application/json", "Content-Encoding": encoding }, body: compressed });
    assert.equal(valid.status, 200); assert.equal((await valid.json()).value, "synthetic parser regression");
    const malformed = await fetch(`${url}/submit`, { method: "POST", headers: { "Content-Type": "application/json", "Content-Encoding": encoding }, body: Buffer.concat([compressed, Buffer.from([255, 0, 255, 0, 255])]) });
    assert.ok([200, 400].includes(malformed.status)); await malformed.arrayBuffer();
    // Send the tail later, after the decoder had a chance to finish the valid frame.
    await new Promise((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1");
      const timer = setTimeout(() => { socket.destroy(); reject(new Error("Delayed compressed tail did not finish")); }, 2000);
      socket.on("error", reject); socket.on("data", () => {});
      socket.on("close", () => { clearTimeout(timer); resolve(); });
      socket.on("connect", () => {
        socket.write(`POST /submit HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Encoding: ${encoding}\r\nTransfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n`);
        socket.write(`${compressed.length.toString(16)}\r\n`); socket.write(compressed); socket.write("\r\n");
        setTimeout(() => socket.end("5\r\n\xff\0\xff\0\xff\r\n0\r\n\r\n", "latin1"), 50).unref();
      });
    });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(child.exitCode, null, stderr);
    const health = await fetch(`${url}/health`); assert.equal(health.status, 200); assert.deepEqual(await health.json(), { ok: true });
  }
});
