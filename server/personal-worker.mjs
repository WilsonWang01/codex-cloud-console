import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";

const socketPath = process.env.CODEX_PERSONAL_SOCKET || "/run/codex-personal/worker.sock";
const codexBinary = process.env.CODEX_PERSONAL_CODEX_BIN || "/usr/local/bin/codex";
let active = null;

process.umask(0o007);
const server = net.createServer((socket) => {
  if (active) {
    socket.destroy();
    return;
  }
  const child = spawn(codexBinary, ["app-server", "--listen", "stdio://"], {
    cwd: process.env.HOME,
    env: {
      HOME: process.env.HOME,
      CODEX_HOME: process.env.CODEX_HOME,
      PATH: "/usr/local/bin:/usr/bin:/bin",
      LANG: "C.UTF-8",
    },
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  active = { socket, child };
  socket.pipe(child.stdin);
  child.stdout.pipe(socket);
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  let terminating = false;
  let killTimer = null;
  const signalGroup = (signal) => {
    if (!child.pid) return;
    try { process.kill(-child.pid, signal); }
    catch { if (child.exitCode === null) child.kill(signal); }
  };
  const terminate = () => {
    if (terminating) return;
    terminating = true;
    signalGroup("SIGTERM");
    killTimer = setTimeout(() => signalGroup("SIGKILL"), 2_000);
    killTimer.unref?.();
  };
  socket.on("close", terminate);
  socket.on("error", terminate);
  child.on("error", terminate);
  child.on("close", () => {
    if (active?.child !== child) return;
    active = null;
    terminating = true;
    if (killTimer) clearTimeout(killTimer);
    socket.destroy();
  });
});

server.listen(socketPath, async () => {
  await fs.chmod(socketPath, 0o660);
});
