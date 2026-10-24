import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { normalizeRunUsage } from "./run-usage.mjs";

const terminal = new Set(["completed", "failed", "interrupted", "needs_reconciliation", "canceled", "cancelled"]);
const dayMs = 86_400_000;
const retentionDays = 32;
const tokenFields = ["inputTokens", "outputTokens", "totalTokens", "cachedInputTokens", "reasoningOutputTokens"];
const safeTokens = (value) => Number.isSafeInteger(value) && value >= 0;

function usageSnapshot(run) {
  const usage = normalizeRunUsage(run.usage);
  if (usage?.status !== "complete" || !tokenFields.slice(0, 3).every((field) => safeTokens(usage[field]))) {
    return { status: "unknown", reason: String(usage?.reason || "Missing or invalid per-turn token usage").slice(0, 320),
      ...(usage?.reportedLastRequest ? { reportedLastRequest: usage.reportedLastRequest } : {}) };
  }
  return Object.fromEntries([
    ["status", "complete"], ["source", String(usage.source || "retained-run").slice(0, 80)],
    ...tokenFields.map((field) => [field, safeTokens(usage[field]) ? usage[field] : null]),
  ]);
}

function snapshot(run) {
  if (!run.id || !Number.isFinite(Date.parse(run.startedAt))) throw new Error("Invalid usage ledger run identity or start time");
  return {
    id: String(run.id), clientId: run.clientId || null, automationId: run.automationId || "", runner: run.runner || "systemd",
    threadId: run.threadId || null, turnId: run.turnId || null,
    status: run.status === "cancelled" ? "canceled" : run.status,
    startedAt: new Date(run.startedAt).toISOString(), finishedAt: run.finishedAt || null,
    ...(run.executionStartedAt ? { executionStartedAt: run.executionStartedAt } : {}),
    updatedAt: run.updatedAt || run.finishedAt || run.startedAt,
    model: run.model || null, reasoning: run.reasoning || null, usage: usageSnapshot(run),
  };
}

export function mergeUsageRuns(runs, ledgerRows) {
  const merged = new Map(ledgerRows.map(run => [run.id, { ...run, usage: usageSnapshot(run) }]));
  for (const run of runs) {
    const saved = merged.get(run.id);
    const usage = usageSnapshot(run), savedUsage = saved ? usageSnapshot(saved) : null;
    merged.set(run.id, { ...saved, ...run, usage: usage.status === "complete" ? usage : savedUsage?.status === "complete" ? savedUsage : usage });
  }
  return [...merged.values()];
}

export function openRunUsageLedger(filePath, { now = () => Date.now() } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    if (!fs.lstatSync(filePath).isFile()) throw new Error("Usage ledger must be a regular file");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const db = new DatabaseSync(filePath);
  try {
    fs.chmodSync(filePath, 0o600);
    const version = db.prepare("PRAGMA user_version").get().user_version;
    if (![0, 1].includes(version)) throw new Error("Unsupported usage ledger schema version");
    if (version === 0) db.exec("PRAGMA auto_vacuum=INCREMENTAL");
    db.exec(`PRAGMA busy_timeout=5000;
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA wal_autocheckpoint=256;
      PRAGMA journal_size_limit=1048576;
      CREATE TABLE IF NOT EXISTS usage_runs (
        id TEXT PRIMARY KEY, started_ms INTEGER NOT NULL, turn_key TEXT UNIQUE,
        snapshot TEXT NOT NULL CHECK(json_valid(snapshot))
      ) STRICT;
      CREATE INDEX IF NOT EXISTS usage_started ON usage_runs(started_ms);
      CREATE TABLE IF NOT EXISTS usage_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      PRAGMA user_version=1;`);
  } catch (error) { db.close(); throw error; }
  const read = db.prepare("SELECT snapshot FROM usage_runs WHERE id=?");
  const put = db.prepare("INSERT INTO usage_runs VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET started_ms=excluded.started_ms, turn_key=excluded.turn_key, snapshot=excluded.snapshot");
  const meta = db.prepare("INSERT INTO usage_meta VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  const cutoff = () => Math.floor(now() / dayMs) * dayMs - retentionDays * dayMs;
  return {
    database: db,
    sync(runs) {
      const time = now(), floor = cutoff();
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("INSERT OR IGNORE INTO usage_meta VALUES ('seeded_at', ?)").run(new Date(time).toISOString());
        for (const run of runs) {
          if (!terminal.has(run.status)) continue;
          const next = snapshot(run);
          const accountedAt = Date.parse(next.executionStartedAt || next.startedAt);
          if (accountedAt < floor) continue;
          const existing = read.get(next.id);
          if (existing) {
            const previous = JSON.parse(existing.snapshot);
            for (const field of ["clientId", "automationId", "runner", "startedAt"]) {
              if (previous[field] !== next[field]) throw new Error("Usage ledger run ownership or start time changed");
            }
            for (const field of ["threadId", "turnId"]) {
              if (previous[field] && next[field] && previous[field] !== next[field]) throw new Error("Usage ledger run changed its Codex turn");
              next[field] ||= previous[field];
            }
            if (Date.parse(next.updatedAt) < Date.parse(previous.updatedAt)) continue;
            if (previous.usage.status === "complete" && next.usage.status !== "complete") next.usage = previous.usage;
          }
          const turnKey = next.threadId && next.turnId ? JSON.stringify([next.threadId, next.turnId]) : null;
          const value = JSON.stringify(next);
          if (existing?.snapshot !== value) put.run(next.id, accountedAt, turnKey, value);
        }
        const day = new Date(time).toISOString().slice(0, 10);
        if (db.prepare("SELECT value FROM usage_meta WHERE key='pruned_day'").get()?.value !== day) {
          db.prepare("DELETE FROM usage_runs WHERE started_ms < ?").run(floor);
          meta.run("pruned_day", day);
        }
        meta.run("synced_at", new Date(time).toISOString());
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      db.exec("PRAGMA incremental_vacuum(32)");
    },
    rows({ from, to }) {
      return db.prepare("SELECT snapshot FROM usage_runs WHERE started_ms >= ? AND started_ms < ? ORDER BY started_ms").all(from, to).map((row) => {
        const run = JSON.parse(row.snapshot);
        return { ...run, usage: normalizeRunUsage(run.usage) };
      });
    },
    info() {
      const values = Object.fromEntries(db.prepare("SELECT key, value FROM usage_meta").all().map((row) => [row.key, row.value]));
      return {
        source: "sqlite-terminal-runs", timezone: "UTC", retentionDays,
        seededAt: values.seeded_at || null, syncedAt: values.synced_at || null,
        retainedFrom: new Date(cutoff()).toISOString(), historicalCoverage: "retained_records_only",
        rows: db.prepare("SELECT count(*) AS count FROM usage_runs").get().count,
        allocatedBytes: db.prepare("PRAGMA page_count").get().page_count * db.prepare("PRAGMA page_size").get().page_size,
        diskBytes: ["", "-wal", "-shm"].reduce((size, suffix) => {
          try { return size + fs.statSync(filePath + suffix).size; }
          catch (error) { if (error.code === "ENOENT") return size; throw error; }
        }, 0),
      };
    },
    close() { db.close(); },
  };
}
