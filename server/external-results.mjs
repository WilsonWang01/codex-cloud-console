import fs from "node:fs/promises";
import fsSync, { constants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { readRootedFile } from "./safe-file-read.mjs";

const MiB = 1024 * 1024;
export const resultLimits = Object.freeze({ packageBytes: 20 * MiB, fileBytes: 8 * MiB, requestedFiles: 4, totalFiles: 8, textBytes: 4 * MiB, minFreeBytes: 128 * MiB });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fail = (statusCode, code, message) => Object.assign(new Error(message), { statusCode, code });
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const fileName = id => {
  if (!uuid.test(id || "")) throw fail(503, "result_metadata_invalid", "结果文件记录无效，需要管理员核对");
  return `${id}.blob`;
};
export const resultPath = run => `/api/automations/${encodeURIComponent(run.automationId)}/runs/${encodeURIComponent(run.id)}/output`;
export const artifactPath = (run, id) => `${resultPath(run)}/files/${encodeURIComponent(id)}`;
const mimeTypes = new Map([[".txt", "text/plain; charset=utf-8"], [".md", "text/markdown; charset=utf-8"], [".json", "application/json"],
  [".csv", "text/csv; charset=utf-8"], [".html", "text/html; charset=utf-8"], [".pdf", "application/pdf"],
  [".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".webp", "image/webp"]]);

export function normalizeArtifactPaths(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > resultLimits.requestedFiles) throw fail(400, "invalid_artifact_paths", "artifactPaths 必须是最多四项的相对文件路径列表");
  const paths = value.map(item => {
    if (typeof item !== "string" || !item || item.length > 500 || /[\x00-\x1f\x7f\\]/.test(item) || /^[a-z]:/i.test(item)) throw fail(400, "invalid_artifact_paths", "产物路径无效");
    const parts = item.split("/");
    if (Buffer.from(item).toString("utf8") !== item || parts.length > 32 || parts.some(part => !part || Buffer.byteLength(part) > 255 || part.startsWith(".") || part === "node_modules") || !mimeTypes.has(path.extname(item).toLowerCase())) {
      throw fail(400, "invalid_artifact_paths", "产物只支持普通相对路径中的文本、HTML、PDF 和静态图片；不允许隐藏或系统文件");
    }
    return item;
  });
  if (new Set(paths).size !== paths.length) throw fail(400, "invalid_artifact_paths", "产物路径不能重复");
  return paths;
}

export async function artifactBaseline(root, requested) {
  const baseline = {};
  for (const name of requested) {
    try { baseline[name] = digest((await readRootedFile(root, name, resultLimits.fileBytes)).buffer); }
    catch (error) { if (error.statusCode !== 404) throw error; baseline[name] = null; }
  }
  return baseline;
}

export async function requestedArtifacts(root, requested, baseline) {
  const files = [];
  let bytes = 0;
  for (const name of requested) {
    const { buffer } = await readRootedFile(root, name, resultLimits.fileBytes);
    bytes += buffer.length;
    if (bytes > resultLimits.packageBytes) throw fail(502, "result_too_large", "请求的产物总计超过交付大小限制");
    if (!Object.hasOwn(baseline, name) || baseline[name] === digest(buffer)) throw fail(502, "artifact_not_generated", "请求的产物没有生成新内容，未将旧文件作为本轮交付");
    files.push({ name: path.basename(name), mimeType: mimeTypes.get(path.extname(name).toLowerCase()), buffer, provenance: "requested-path-changed-during-run" });
  }
  return files;
}

export function nativeSources(thread, turnId) {
  const sources = [];
  const seen = new Set();
  const items = thread?.turns?.find(turn => turn.id === turnId)?.items || [];
  for (const item of items) {
    if (item.type !== "webSearch" || !["openPage", "findInPage"].includes(item.action?.type) || typeof item.action.url !== "string") continue;
    try {
      const url = new URL(item.action.url);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.href.length > 2048 || seen.has(url.href)) continue;
      if (sources.length >= 100) break;
      seen.add(url.href);
      sources.push({ url: url.href, itemId: String(item.id).slice(0, 160), kind: item.action.type });
    } catch { /* Unverified URLs are not citations. */ }
  }
  return sources;
}

export function createExternalResultStore(db, root, { now = () => Date.now(), retentionMs = 86_400_000, globalBytes = 256 * MiB, clientBytes = 64 * MiB, globalRuns = 4096, clientRuns = 1024 } = {}) {
  if (![retentionMs, globalBytes, clientBytes, globalRuns, clientRuns].every(n => Number.isSafeInteger(n) && n > 0) || retentionMs > 32 * 86_400_000) throw new Error("Invalid result storage limits");
  fsSync.mkdirSync(root, { recursive: true, mode: 0o700 });
  const rootStat = fsSync.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o077)) throw new Error("Result directory must be private and not a symlink");
  db.exec(`CREATE TABLE IF NOT EXISTS external_results (
    run_id TEXT PRIMARY KEY REFERENCES external_tasks(id), client_id TEXT NOT NULL, automation_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','writing','ready','deleting','expired')),
    bytes INTEGER NOT NULL CHECK(bytes>=0), expires_ms INTEGER,
    record TEXT NOT NULL CHECK(json_valid(record))
  ) STRICT;
    CREATE INDEX IF NOT EXISTS external_results_client ON external_results(client_id);
    CREATE INDEX IF NOT EXISTS external_results_expiry ON external_results(state, expires_ms);`);
  const rowFor = id => db.prepare("SELECT * FROM external_results WHERE run_id=?").get(id);
  const openDirectory = async () => {
    const handle = await fs.open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (stat.dev !== rootStat.dev || stat.ino !== rootStat.ino) throw fail(503, "result_directory_changed", "交付目录已变化，需要管理员核对");
      return handle;
    } catch (error) { await handle.close(); throw error; }
  };
  const transaction = callback => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const before = db.prepare("SELECT total_changes() AS n").get().n;
      const value = callback();
      if (db.prepare("SELECT total_changes() AS n").get().n !== before) db.exec("UPDATE external_tasks_meta SET value=value+1 WHERE key='revision'");
      db.exec("COMMIT"); return value;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  };
  const claimed = (run, claim) => {
    const task = db.prepare("SELECT * FROM external_tasks WHERE id=?").get(run.id);
    const saved = task && JSON.parse(task.record);
    if (!task || task.state !== "running" || task.owner !== claim?.owner || task.epoch !== claim?.epoch || saved.clientId !== run.clientId ||
        saved.automationId !== run.automationId || saved.threadId !== run.threadId || saved.turnId !== run.turnId || saved.cancelRequestedAt) {
      throw fail(409, "result_claim_changed", "任务执行权或归属已变化，不能发布结果");
    }
  };
  const owned = run => {
    const row = rowFor(run.id);
    if (!row || row.client_id !== run.clientId || row.automation_id !== run.automationId) throw fail(404, "result_not_retained", "此运行没有保留可下载结果");
    if (run.status !== "completed") throw fail(409, "result_not_ready", "此运行未成功交付结果，请查询原任务状态");
    if (["deleting", "expired"].includes(row.state) || (row.expires_ms !== null && row.expires_ms <= now())) throw fail(410, "result_expired", "结果已到期，请勿通过新事件键重复执行原任务");
    if (row.state !== "ready" || run.delivery?.id !== JSON.parse(row.record).manifestId) throw fail(409, "result_not_ready", "运行尚未成功交付结果，请查询原任务状态");
    const data = JSON.parse(row.record);
    if (data.threadId !== run.threadId || data.turnId !== run.turnId) throw fail(503, "result_identity_changed", "结果回合不匹配，需要管理员核对");
    return { row, data };
  };
  const readBlob = async item => {
    const { buffer } = await readRootedFile(root, fileName(item.id), resultLimits.packageBytes);
    if (buffer.length !== item.size || digest(buffer) !== item.sha256) throw fail(503, "result_integrity_failed", "结果副本已变化，未交付不一致的文件");
    return buffer;
  };
  let sweeping;
  return {
    has(id) { return Boolean(rowFor(id)); },
    // Called after task insertion, inside the same task/key admission transaction.
    reserve(run) {
      const total = db.prepare("SELECT coalesce(sum(bytes),0) AS n FROM external_results").get().n;
      const client = db.prepare("SELECT coalesce(sum(bytes),0) AS n FROM external_results WHERE client_id=?").get(run.clientId).n;
      if (db.prepare("SELECT count(*) AS n FROM external_results").get().n >= globalRuns || db.prepare("SELECT count(*) AS n FROM external_results WHERE client_id=?").get(run.clientId).n >= clientRuns) {
        throw Object.assign(fail(429, "result_record_limit", "结果记录数量已达保留上限，未启动模型；请等待保留窗口到期后使用原事件键重试"), { retryAfterMs: 60000 });
      }
      if (total + resultLimits.packageBytes > globalBytes || client + resultLimits.packageBytes > clientBytes) {
        throw Object.assign(fail(429, "result_storage_full", "结果存储容量已满，未启动模型；请等待已有副本到期后使用原事件键重试"), { retryAfterMs: 60000 });
      }
      let available;
      try { const disk = fsSync.statfsSync(root, { bigint: true }); available = disk.bavail * disk.bsize; }
      catch { throw fail(503, "result_capacity_unavailable", "无法确认结果磁盘容量，未启动任务"); }
      if (available < BigInt(total + resultLimits.packageBytes + resultLimits.minFreeBytes)) throw fail(503, "result_disk_full", "结果磁盘预留空间不足，未启动任务；请使用原事件键稍后重试");
      db.prepare("INSERT INTO external_results VALUES (?, ?, ?, 'pending', ?, NULL, ?)").run(run.id, run.clientId, run.automationId, resultLimits.packageBytes, JSON.stringify({ retentionMs }));
    },
    async capture(run, claim, { text, structuredOutput = null, sources = [], files = [] }) {
      if (typeof text !== "string" || Buffer.byteLength(text) > resultLimits.textBytes || !Array.isArray(files) || files.length > resultLimits.totalFiles || !Array.isArray(sources) || sources.length > 100) throw fail(502, "result_too_large", "结果超出交付大小或数量限制");
      const acceptedRetention = JSON.parse(rowFor(run.id)?.record || "{}").retentionMs;
      if (!Number.isSafeInteger(acceptedRetention) || acceptedRetention < 1) throw fail(503, "result_metadata_invalid", "结果保留策略缺失，需要管理员核对");
      const keyExpiry = db.prepare("SELECT max(expires_ms) AS n FROM external_task_keys WHERE run_id=?").get(run.id).n || 0;
      const expiresMs = Math.max(now() + acceptedRetention, keyExpiry);
      const artifacts = files.map(file => {
        if (!Buffer.isBuffer(file.buffer) || file.buffer.length > resultLimits.fileBytes || typeof file.name !== "string" || !file.name || file.name.length > 500 || /[/\\\x00-\x1f\x7f]/.test(file.name) ||
            !["requested-path-changed-during-run", "native-image-item"].includes(file.provenance) || typeof file.mimeType !== "string" || file.mimeType.length > 120 || /[\x00-\x1f\x7f]/.test(file.mimeType) ||
            (file.provenance === "native-image-item" && (typeof file.nativeItemId !== "string" || !file.nativeItemId || file.nativeItemId.length > 160)) ||
            (file.revisedPrompt !== undefined && (typeof file.revisedPrompt !== "string" || Buffer.byteLength(file.revisedPrompt) > 64 * 1024))) throw fail(502, "invalid_result_file", "结果文件格式无效");
        return { id: randomUUID(), name: file.name, mimeType: file.mimeType, size: file.buffer.length, sha256: digest(file.buffer),
          provenance: file.provenance, ...(file.nativeItemId ? { nativeItemId: file.nativeItemId } : {}),
          ...(file.revisedPrompt ? { revisedPrompt: file.revisedPrompt } : {}) };
      });
      const manifest = { version: 1, runId: run.id, automationId: run.automationId, status: "completed", turnId: run.turnId,
        capturedAt: new Date(now()).toISOString(), expiresAt: new Date(expiresMs).toISOString(), text, structuredOutput, sources,
        artifacts: artifacts.map(item => ({ ...item, downloadPath: artifactPath(run, item.id) })) };
      const manifestBytes = Buffer.from(JSON.stringify(manifest));
      const manifestItem = { id: randomUUID(), size: manifestBytes.length, sha256: digest(manifestBytes), kind: "manifest" };
      const bytes = manifestBytes.length + artifacts.reduce((sum, item) => sum + item.size, 0);
      if (bytes > resultLimits.packageBytes) throw fail(502, "result_too_large", "产物和结果清单合计超过 20 MiB");
      const record = { retentionMs: acceptedRetention, manifestId: manifestItem.id, threadId: run.threadId, turnId: run.turnId, files: [...artifacts, manifestItem] };
      const encoded = JSON.stringify(record);
      transaction(() => {
        claimed(run, claim);
        const row = rowFor(run.id);
        if (!row || row.state !== "pending" || row.client_id !== run.clientId || row.automation_id !== run.automationId) throw fail(409, "result_already_published", "结果已经保存或需要核对，不能覆盖副本");
        db.prepare("UPDATE external_results SET state='writing', expires_ms=?, record=? WHERE run_id=?").run(expiresMs, encoded, run.id);
      });
      const directory = await openDirectory();
      try {
        for (const [index, item] of record.files.entries()) {
          const target = process.platform === "linux" ? `/proc/self/fd/${directory.fd}/${fileName(item.id)}` : path.join(root, fileName(item.id));
          const handle = await fs.open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          try { await handle.writeFile(index < files.length ? files[index].buffer : manifestBytes); await handle.sync(); }
          finally { await handle.close(); }
        }
        await directory.sync();
      } catch { throw fail(502, "result_persistence_failed", "结果副本保存失败，未交付成功；请查询原任务，不会自动重复执行"); }
      finally { await directory.close(); }
      transaction(() => {
        claimed(run, claim);
        const row = rowFor(run.id);
        if (row?.state !== "writing" || row.record !== encoded) throw fail(409, "result_claim_changed", "结果写入记录已变化，未发布副本");
        db.prepare("UPDATE external_results SET state='ready', bytes=? WHERE run_id=?").run(bytes, run.id);
      });
      return { status: "ready", id: manifestItem.id, expiresAt: manifest.expiresAt, artifactCount: artifacts.length };
    },
    async manifest(run) {
      const { data } = owned(run);
      const item = data.files.find(file => file.id === data.manifestId && file.kind === "manifest");
      if (!item) throw fail(503, "result_metadata_invalid", "结果清单记录不完整");
      const buffer = await readBlob(item);
      owned(run);
      const manifest = JSON.parse(buffer.toString("utf8"));
      if (manifest.version !== 1 || manifest.runId !== run.id || manifest.automationId !== run.automationId || manifest.turnId !== run.turnId || manifest.status !== "completed") {
        throw fail(503, "result_identity_changed", "结果清单归属不一致，需要管理员核对");
      }
      return manifest;
    },
    async file(run, id) {
      const { data } = owned(run);
      const item = data.files.find(file => file.id === id && file.kind !== "manifest");
      if (!item) throw fail(404, "artifact_not_found", "没有此运行可下载的文件");
      const buffer = await readBlob(item);
      owned(run);
      return { ...item, buffer };
    },
    sweep() {
      if (sweeping) return sweeping;
      sweeping = (async () => {
        const rows = transaction(() => {
          // Unknown executions keep their copies and quota until explicitly reconciled.
          const candidates = db.prepare(`SELECT r.* FROM external_results r JOIN external_tasks t ON t.id=r.run_id
            WHERE t.state='terminal' AND json_extract(t.record,'$.status')!='needs_reconciliation' AND
            (r.state='pending' OR r.state='deleting' OR (r.expires_ms<=? AND r.state!='expired')) LIMIT 16`).all(now());
          for (const row of candidates) db.prepare("UPDATE external_results SET state='deleting' WHERE run_id=?").run(row.run_id);
          return candidates;
        });
        for (const row of rows) {
          const data = JSON.parse(row.record);
          const directory = await openDirectory();
          try {
            for (const file of data.files || []) {
              const target = process.platform === "linux" ? `/proc/self/fd/${directory.fd}/${fileName(file.id)}` : path.join(root, fileName(file.id));
              await fs.unlink(target).catch(error => { if (error.code !== "ENOENT") throw error; });
            }
            await directory.sync();
          } finally { await directory.close(); }
          transaction(() => db.prepare("UPDATE external_results SET state='expired', bytes=0, record='{}' WHERE run_id=? AND state='deleting'").run(row.run_id));
        }
        transaction(() => {
          db.prepare("DELETE FROM external_results WHERE state='expired' AND (expires_ms IS NULL OR expires_ms<=?) AND run_id NOT IN (SELECT run_id FROM external_task_keys)").run(now() - retentionMs);
        });
      })().finally(() => { sweeping = null; });
      return sweeping;
    },
    info() {
      return { ...db.prepare("SELECT count(*) AS runs, coalesce(sum(bytes),0) AS reservedBytes FROM external_results").get(), globalBytes, clientBytes, globalRuns, clientRuns, retentionMs, ...resultLimits };
    },
  };
}
