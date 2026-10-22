#!/usr/bin/env node
import fs from "node:fs";
import { backup, DatabaseSync } from "node:sqlite";

const [source, destination] = process.argv.slice(2);
if (!source || !destination) throw new Error("Usage: node ops/backup-usage-ledger.mjs SOURCE DESTINATION");
if (!fs.lstatSync(source).isFile()) throw new Error("Source must be a regular SQLite file");
const db = new DatabaseSync(source, { readOnly: true });
let created = false;
try {
  if (db.prepare("PRAGMA user_version").get().user_version !== 1) throw new Error("Unexpected ledger schema");
  fs.closeSync(fs.openSync(destination, "wx", 0o600));
  created = true;
  await backup(db, destination);
  const restored = new DatabaseSync(destination, { readOnly: true });
  try {
    if (restored.prepare("PRAGMA quick_check").get().quick_check !== "ok") throw new Error("Backup integrity check failed");
    const hasTasks = Boolean(restored.prepare("SELECT name FROM sqlite_master WHERE name='external_tasks'").get());
    console.log(JSON.stringify({ destination, rows: restored.prepare("SELECT count(*) AS count FROM usage_runs").get().count,
      externalTaskRows: hasTasks ? restored.prepare("SELECT count(*) AS n FROM external_tasks").get().n : 0,
      externalTaskRevision: hasTasks ? restored.prepare("SELECT value FROM external_tasks_meta WHERE key='revision'").get()?.value : null,
      verified: true }));
  } finally { restored.close(); }
} catch (error) {
  if (created) fs.rmSync(destination, { force: true });
  throw error;
} finally { db.close(); }
