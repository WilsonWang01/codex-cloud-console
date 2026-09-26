import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";

async function canRead(path) {
  try { await fs.access(path); return true; }
  catch { return false; }
}

async function canConnect(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const finish = (value) => { socket.destroy(); resolve(value); };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(1500, () => finish(false));
  });
}

assert.notEqual(process.getuid?.(), 0, "Probe must run as the dedicated user");
assert.equal(await canRead("/var/lib/codex-personal/workspace"), true, "Personal workspace is unavailable");
assert.equal(await canRead("/home/ubuntu/codex-cloud/state/automation-runs.json"), false, "Work state is visible");
assert.equal(await canRead("/home/ubuntu/.codex"), false, "Work Codex state is visible");
assert.equal(await canRead("/etc/codex-cloud-console.env"), false, "Console environment is visible");
assert.equal(await canConnect("127.0.0.1", 8787), false, "Local console API is reachable");
assert.equal(await canConnect("169.254.169.254", 80), false, "Instance metadata is reachable");
process.stdout.write("Personal worker isolation checks passed.\n");
