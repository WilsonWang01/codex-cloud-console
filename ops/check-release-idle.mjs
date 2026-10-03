#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const backupPath = process.argv[2] || process.env.CODEX_CLOUD_PRE_SWITCH_BACKUP;
if (!backupPath) throw new Error("需要发布前备份的 before.json 路径");
const before = JSON.parse(await fs.readFile(backupPath, "utf8"));
const root = "/home/ubuntu/codex-cloud";
const current = await fs.realpath(path.join(root, "console-current"));
if (current !== before.current) throw new Error("当前版本已变化，停止发布");
for (const [name, expected] of Object.entries(before.hashes)) {
  const bytes = await fs.readFile(path.join(root, "state", name)).catch((error) => { if (error.code !== "ENOENT") throw error; return null; });
  const actual = bytes ? createHash("sha256").update(bytes).digest("hex") : null;
  if (actual !== expected) throw new Error("受保护状态已变化，停止发布");
}
const runs = JSON.parse(await fs.readFile(path.join(root, "state/automation-runs.json"), "utf8"));
if (runs.runs.some((run) => ["queued", "running", "canceling"].includes(run.status))) throw new Error("存在运行任务，停止发布");
const units = execFileSync("systemctl", ["list-units", "--state=running", "--no-legend", "--plain"], { encoding: "utf8" });
if (units.split("\n").some((line) => line.trim().split(/\s+/)[0]?.startsWith("codex-auto-"))) throw new Error("存在运行定时服务，停止发布");
// Read deployment authentication only into memory; never print the configuration or token.
const require = createRequire(path.join(current, "package.json"));
const env = require("dotenv").parse(execFileSync("sudo", ["cat", "/etc/codex-cloud-console.env"], { stdio: ["ignore", "pipe", "ignore"] }));
const headers = { "x-codex-cloud-token": env.CODEX_CLOUD_WEBHOOK_TOKEN };
const response = await fetch("http://127.0.0.1:8787/api/codex/app-host/status", { headers, signal: AbortSignal.timeout(10_000) });
if (!response.ok) throw new Error("无法确认控制台任务空闲，停止发布");
const status = await response.json();
if (status.ok !== true || !Array.isArray(status.activeJobs) || status.activeJobs.length || status.activeCompactions !== 0) throw new Error("控制台仍有任务或状态不明确，停止发布");
process.stdout.write("发布前门禁通过：状态未变化，无活动任务。\n");
