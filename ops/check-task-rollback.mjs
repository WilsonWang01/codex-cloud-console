#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const [stateRoot, previousRelease] = process.argv.slice(2);
if (!stateRoot || !previousRelease) throw new Error("Usage: check-task-rollback.mjs STATE_ROOT PREVIOUS_RELEASE");
const file = path.join(stateRoot, "run-usage.sqlite");
if (!fs.existsSync(file)) process.exit(0);
const db = new DatabaseSync(file, { readOnly: true });
try {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='external_tasks'").get();
  if (!table || db.prepare("SELECT count(*) AS n FROM external_tasks").get().n === 0) process.exitCode = 0;
  else {
    const modulePath = path.join(previousRelease, "server/external-task-store.mjs");
    const version = db.prepare("SELECT value FROM external_tasks_meta WHERE key='schema_version'").get()?.value;
    if (!fs.existsSync(modulePath) || (await import(pathToFileURL(modulePath))).externalTaskSchemaVersion !== version) {
      throw new Error("已有持久任务数据，不能自动退回不支持该格式的旧版本；数据和当前版本已保留，请修复或选择兼容版本。");
    }
  }
} finally { db.close(); }
