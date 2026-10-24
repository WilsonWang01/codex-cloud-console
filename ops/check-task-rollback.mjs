#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const [stateRoot, previousRelease] = process.argv.slice(2);
if (!stateRoot || !previousRelease) throw new Error("Usage: check-task-rollback.mjs STATE_ROOT PREVIOUS_RELEASE");
const calendarFile = path.join(stateRoot, "personal-calendar-proposals.json");
if (fs.existsSync(calendarFile)) {
  const calendar = JSON.parse(fs.readFileSync(calendarFile, "utf8"));
  if (calendar?.version !== 1 || !Array.isArray(calendar.proposals)) throw new Error("日程提案格式未知，不能自动回退；原数据已保留。");
  if (calendar.proposals.length) {
    const modulePath = path.join(previousRelease, "server/personal-calendar-proposals.mjs");
    const previous = fs.existsSync(modulePath) ? (await import(pathToFileURL(modulePath))).calendarProposalFormatVersion : null;
    if (previous !== calendar.version) throw new Error("旧版本不支持已保存的日程提案和执行回执，不能自动回退；原数据和当前版本已保留，请使用兼容版本。");
  }
}
const factsFile = path.join(stateRoot, "personal-facts.json");
if (fs.existsSync(factsFile)) {
  const facts = JSON.parse(fs.readFileSync(factsFile, "utf8"));
  if (![1, 2, 3].includes(facts?.version) || !Array.isArray(facts.facts)) throw new Error("个人资料格式未知，不能自动回退；原数据已保留。");
  if (facts.version >= 2) {
    const modulePath = path.join(previousRelease, "server/personal-facts.mjs");
    const previous = fs.existsSync(modulePath) ? (await import(pathToFileURL(modulePath))).personalFactsFormatVersion : null;
    if (!Number.isSafeInteger(previous) || previous < facts.version) throw new Error("旧版本不支持当前个人资料或记忆候选，不能自动回退；新数据和当前版本已保留，请修复或使用兼容版本。");
  }
}
const clientsFile = path.join(stateRoot, "api-clients.json");
if (fs.existsSync(clientsFile)) {
  const clients = JSON.parse(fs.readFileSync(clientsFile, "utf8"));
  if (clients.version != null && clients.version !== 1 || !Array.isArray(clients.clients) || clients.clients.some(client => !client || typeof client !== "object")) throw new Error("调用方记录格式未知，不能自动回退；原配置已保留。");
  if (clients.clients.some(client => client.maxConcurrent != null || client.dailyKnownTokenLimit != null)) {
    const modulePath = path.join(previousRelease, "server/api-clients.mjs");
    const previous = fs.existsSync(modulePath) ? (await import(pathToFileURL(modulePath))).apiClientPolicyVersion : null;
    if (previous !== 1) throw new Error("旧版本不支持已保存的调用方限制，不能自动回退；原配置和当前版本已保留。");
  }
}
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
        const callbacksEmpty = !db.prepare("SELECT name FROM sqlite_master WHERE name='external_callbacks'").get() || db.prepare("SELECT count(*) AS n FROM external_callbacks").get().n === 0;
        if (empty && resultsEmpty && callbacksEmpty && ((version === 6 && previous === 5) || (version === 5 && previous === 4) || (version === 4 && previous === 3) || (version === 3 && previous === 2) || (version === 2 && previous === 1))) {
          db.prepare("UPDATE external_tasks_meta SET value=? WHERE key='schema_version'").run(previous);
          compatible = true;
        } else if (empty && resultsEmpty && callbacksEmpty && [1, 2, 3, 4, 5, 6].includes(version) && previous === null) compatible = true;
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    }
    if (!compatible) {
      throw new Error("任务存储格式不兼容，不能自动退回不支持该格式的旧版本；数据和当前版本已保留，请修复或选择兼容版本。");
    }
  }
} finally { db.close(); }
