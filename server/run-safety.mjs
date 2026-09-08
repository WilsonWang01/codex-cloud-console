import fs from "node:fs/promises";
import path from "node:path";

export function createKeyedQueue() {
  const pending = new Map();
  return async (key, task) => {
    const previous = pending.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    pending.set(key, next);
    try {
      return await next;
    } finally {
      if (pending.get(key) === next) pending.delete(key);
    }
  };
}

export function retainAutomationRuns(runs, { now, idempotencyTtlMs, recoveryMaxAgeMs, historyLimit = 200 }) {
  let historyCount = 0;
  return [...runs].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).filter((run) => {
    if (["queued", "running"].includes(run.status)) return true;
    if (run.triggerIdempotencyHash && Date.parse(run.startedAt) >= now - idempotencyTtlMs) return true;
    if (run.status === "interrupted" && Date.parse(run.interruptedLastActiveAt || run.updatedAt) >= now - recoveryMaxAgeMs) return true;
    return historyCount++ < historyLimit;
  });
}

export async function recoveryExecutionRepo(repo, run, worktreesRoot) {
  if (!run.worktreePath && run.worktreePolicy === "detached-worktree") {
    throw new Error("原任务缺少 worktree 路径，需要人工恢复");
  }
  const target = await fs.realpath(run.worktreePath || repo.path);
  const repoRoot = await fs.realpath(repo.path);
  const treeRoot = await fs.realpath(worktreesRoot).catch(() => null);
  if (target !== repoRoot && (!treeRoot || !target.startsWith(`${treeRoot}${path.sep}`))) {
    throw new Error("原任务执行目录不属于项目或受管理的 worktree");
  }
  if (!(await fs.stat(target)).isDirectory()) throw new Error("原任务执行目录不存在");
  return { ...repo, path: target };
}

export async function mapConcurrent(items, concurrency, map) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await map(items[index], index);
    }
  }));
  return results;
}
