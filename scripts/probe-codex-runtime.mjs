#!/usr/bin/env node

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { CodexAppServerClient } from "../server/codex-app-server-client.mjs";

const execFileAsync = promisify(execFile);

function optionsFromArgs(argv) {
  const options = { command: "codex", cwd: process.cwd(), model: "gpt-5.6-terra", requireAuth: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--require-auth") options.requireAuth = true;
    else if (["--codex", "--cwd", "--model"].includes(arg) && argv[index + 1]) {
      options[{ "--codex": "command", "--cwd": "cwd", "--model": "model" }[arg]] = argv[++index];
    } else throw new Error(`Unknown or incomplete option: ${arg}`);
  }
  options.cwd = resolve(options.cwd);
  return options;
}

function effortName(value) {
  return typeof value === "string" ? value : value?.reasoningEffort || value?.effort || "";
}

async function probe({ command, cwd, model, requireAuth }) {
  const started = Date.now();
  const report = {
    version: null,
    checks: { initialize: false, accountRead: false, modelList: false, threadList: false },
    authenticated: false,
    expectedModel: model,
    expectedModelAvailable: false,
    expectedMedium: false,
    modelCount: 0,
    threadCountFirstPage: null,
    turnStart: "not-tested-no-model-call",
    issues: [],
  };
  try {
    const result = await execFileAsync(command, ["--version"], { cwd, timeout: 10_000, maxBuffer: 64_000 });
    report.version = String(result.stdout || "").trim().slice(0, 120);
    if (!report.version) report.issues.push("CLI version missing");
  } catch {
    report.issues.push("CLI version command failed");
    report.elapsedMs = Date.now() - started;
    report.ok = false;
    return report;
  }

  const client = new CodexAppServerClient({ cwd, command, initializeTimeoutMs: 15_000 });
  try {
    await client.ensureStarted();
    report.checks.initialize = true;

    try {
      const account = await client.request("account/read", {}, 10_000);
      report.checks.accountRead = account && typeof account === "object" && Object.hasOwn(account, "account");
      report.authenticated = Boolean(account?.account);
      if (!report.checks.accountRead) report.issues.push("account/read response shape changed");
      if (requireAuth && !report.authenticated) report.issues.push("Codex account is not authenticated");
    } catch {
      report.issues.push("account/read unavailable");
    }

    try {
      const models = new Map();
      const cursors = new Set();
      let cursor = null;
      do {
        const result = await client.request("model/list", { includeHidden: false, limit: 100, cursor }, 15_000);
        if (!Array.isArray(result?.data)) throw new Error("invalid model/list data");
        for (const item of result.data) {
          const id = String(item?.id || item?.model || "");
          if (id) models.set(id, item);
        }
        cursor = result.nextCursor || null;
        if (cursor && cursors.has(cursor)) throw new Error("repeating model/list cursor");
        if (cursor) cursors.add(cursor);
      } while (cursor && cursors.size < 20);
      if (cursor) throw new Error("model/list page limit exceeded");
      report.checks.modelList = true;
      report.modelCount = models.size;
      const selected = models.get(model);
      report.expectedModelAvailable = Boolean(selected);
      report.expectedMedium = Boolean(selected?.supportedReasoningEfforts?.some((effort) => effortName(effort) === "medium"));
      if (!report.expectedModelAvailable) report.issues.push(`Expected model ${model} is not in model/list`);
      else if (!report.expectedMedium) report.issues.push(`Expected model ${model} does not list medium reasoning`);
    } catch {
      report.issues.push("model/list unavailable or invalid");
    }

    try {
      const threads = await client.request("thread/list", {
        cwd: [cwd], limit: 1, cursor: null, archived: false,
        useStateDbOnly: true, sortKey: "updated_at", sortDirection: "desc",
      }, 15_000);
      report.checks.threadList = Array.isArray(threads?.data);
      if (report.checks.threadList) report.threadCountFirstPage = threads.data.length;
      else report.issues.push("thread/list response shape changed");
    } catch {
      report.issues.push("thread/list unavailable");
    }
  } catch {
    report.issues.push("app-server initialization failed");
  } finally {
    await client.stop({ waitForExit: true });
  }
  report.elapsedMs = Date.now() - started;
  report.ok = Boolean(report.version) && Object.values(report.checks).every(Boolean) &&
    report.expectedModelAvailable && report.expectedMedium && (!requireAuth || report.authenticated);
  return report;
}

try {
  const report = await probe(optionsFromArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 2;
}
