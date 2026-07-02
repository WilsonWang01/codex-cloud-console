#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const [jobId, workdir, promptFile, model, reasoning] = process.argv.slice(2);
if (!jobId || !workdir || !promptFile || !model || !reasoning) {
  console.error("usage: run-cloud-automation-via-api <job-id> <workdir> <prompt-file> <model> <reasoning>");
  process.exit(2);
}

const root = process.env.CODEX_CLOUD_ROOT || "/home/ubuntu/codex-cloud";
const consoleUrl = (process.env.CODEX_CLOUD_CONSOLE_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
const timeoutMs = Number(process.env.CODEX_AUTOMATION_RUN_TIMEOUT_MS || 3_600_000);
const pollMs = Number(process.env.CODEX_AUTOMATION_RUN_POLL_MS || 5_000);
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const logDir = path.join(root, "logs");
const outDir = path.join(root, "output");
const logFile = path.join(logDir, `${jobId}-${stamp}.log`);
const latestLog = path.join(logDir, `${jobId}-latest.log`);
const lastFile = path.join(outDir, `${jobId}-last.md`);

async function log(line) {
  const text = `[${new Date().toISOString()}] ${line}\n`;
  process.stdout.write(text);
  await fs.appendFile(logFile, text);
}

async function linkLatest() {
  await fs.rm(latestLog, { force: true }).catch(() => null);
  await fs.symlink(logFile, latestLog).catch(async () => {
    await fs.copyFile(logFile, latestLog).catch(() => null);
  });
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { output: text };
  }
  if (!response.ok) throw new Error(data.error || data.output || `${response.status} ${response.statusText}`);
  return data;
}

async function main() {
  await fs.mkdir(logDir, { recursive: true });
  await fs.mkdir(outDir, { recursive: true });
  const prompt = await fs.readFile(promptFile, "utf8").catch(() => "");
  await log(`job=${jobId} model=${model} reasoning=${reasoning}`);
  await log(`workdir=${workdir}`);
  await log(`prompt=${promptFile}`);
  await log(`console=${consoleUrl}`);

  const start = await requestJson(`${consoleUrl}/api/automations/${encodeURIComponent(jobId)}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      runner: "app-server",
      worktree: true,
      prompt: prompt.trim() || undefined,
      model,
      reasoning,
    }),
  });
  const runId = start.run?.id || start.runId;
  if (!runId) throw new Error(`console did not return run id: ${JSON.stringify(start).slice(0, 500)}`);
  await log(`runId=${runId}`);
  await log(`thread=${start.run?.threadId || "pending"}`);
  await log(`worktree=${start.run?.worktreePath || "pending"}`);

  const deadline = Date.now() + timeoutMs;
  let lastStatus = "";
  while (Date.now() < deadline) {
    const runs = await requestJson(`${consoleUrl}/api/automations/runs?automationId=${encodeURIComponent(jobId)}`);
    const run = (runs.runs || []).find((item) => item.id === runId);
    if (!run) throw new Error(`run ${runId} disappeared from automation store`);
    if (run.status !== lastStatus) {
      lastStatus = run.status;
      await log(`status=${run.status} thread=${run.threadId || "pending"}`);
    }
    const lastEvent = run.events?.[run.events.length - 1];
    if (lastEvent) await log(`event=${lastEvent.type} ${lastEvent.text}`);
    if (!["queued", "running"].includes(run.status)) {
      const output = [
        `# ${run.name}`,
        "",
        `- run: ${run.id}`,
        `- status: ${run.status}`,
        `- thread: ${run.threadId || "none"}`,
        `- worktree: ${run.worktreePath || "none"}`,
        "",
        run.summary || "",
        run.diffStat ? `\n## Diff\n\n${run.diffStat}` : "",
        run.error ? `\n## Error\n\n${run.error}` : "",
      ].join("\n");
      await fs.writeFile(lastFile, `${output.trim()}\n`);
      await log(`finished status=${run.status}`);
      await linkLatest();
      process.exit(run.status === "completed" ? 0 : 1);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`run ${runId} timed out after ${timeoutMs}ms`);
}

main()
  .catch(async (error) => {
    const digest = crypto.createHash("sha256").update(String(error.stack || error.message || error)).digest("hex").slice(0, 8);
    await log(`error[${digest}]=${error.message || error}`).catch(() => null);
    await linkLatest().catch(() => null);
    process.exit(1);
  });
