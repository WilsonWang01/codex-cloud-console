#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const [stateRoot, previousRelease] = process.argv.slice(2);
if (!stateRoot || !previousRelease) throw new Error("Usage: check-task-rollback.mjs STATE_ROOT PREVIOUS_RELEASE");
const file = path.join(stateRoot, "run-usage.sqlite");
if (!fs.existsSync(file)) process.exit(0);
const db = new DatabaseSync(file);
try {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='external_tasks'").get();
  if (!table) process.exitCode = 0;
  else {
    const modulePath = path.join(previousRelease, "server/external-task-store.mjs");
    const version = db.prepare("SELECT value FROM external_tasks_meta WHERE key='schema_version'").get()?.value;
    const previous = fs.existsSync(modulePath) ? (await import(pathToFileURL(modulePath))).externalTaskSchemaVersion : null;
    let compatible = previous === version;
    if (!compatible) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const empty = db.prepare("SELECT count(*) AS n FROM external_tasks").get().n === 0 && db.prepare("SELECT count(*) AS n FROM external_task_keys").get().n === 0;
        const resultsEmpty = !db.prepare("SELECT name FROM sqlite_master WHERE name='external_results'").get() || db.prepare("SELECT count(*) AS n FROM external_results").get().n === 0;
        // Only known, empty format changes are reversible without understanding new records.
        if (empty && resultsEmpty && ((version === 5 && previous === 4) || (version === 4 && previous === 3) || (version === 3 && previous === 2) || (version === 2 && previous === 1))) {
          db.prepare("UPDATE external_tasks_meta SET value=? WHERE key='schema_version'").run(previous);
          compatible = true;
        } else if (empty && resultsEmpty && [1, 2, 3, 4, 5].includes(version) && previous === null) compatible = true;
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    }
    if (!compatible) {
      throw new Error("任务存储格式不兼容，不能自动退回不支持该格式的旧版本；数据和当前版本已保留，请修复或选择兼容版本。");
    }
  }
} finally { db.close(); }
