import fs from "node:fs/promises";
import { spawn } from "node:child_process";

export async function withPublicationLock(file, task) {
  try { await fs.access(file); }
  catch (error) { if (error.code === "ENOENT") return task(); throw error; }
  const unavailable = () => Object.assign(new Error("暂时无法取得任务接收锁，请在发布结束后使用原事件键重试"), { statusCode: 503, retryAfterMs: 5000 });
  const child = spawn("flock", ["--shared", "--nonblock", file, process.execPath, "-e", "process.stdout.write('ready\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));"], { stdio: ["pipe", "pipe", "ignore"] });
  const closed = new Promise((resolve) => child.once("close", resolve));
  child.stdin.on("error", () => {});
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(unavailable()); }, 3000);
      let output = "";
      child.once("error", () => { clearTimeout(timer); reject(unavailable()); });
      child.once("close", () => { clearTimeout(timer); reject(unavailable()); });
      child.stdout.on("data", (chunk) => { output += chunk; if (output.includes("ready\n")) { clearTimeout(timer); resolve(); } });
    });
    return await task();
  } finally { child.stdin.end(); await closed; }
}
