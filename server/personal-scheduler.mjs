export function createPersonalRoutineScheduler({ store, automations, readRuns, startRun, sync, warn = console.warn }) {
  let busy = false;
  const starting = new Set();

  return async function tick() {
    if (busy) return;
    busy = true;
    try {
      const claims = await store.claims();
      if (!automations().some((item) => item.personalRoutine && item.personalSchedule?.enabled) &&
        !claims.some((item) => ["claimed", "running"].includes(item.status))) return;
      const runs = await readRuns();
      for (const claim of claims.filter((item) => ["claimed", "running"].includes(item.status))) {
        const run = runs.find((item) => item.id === claim.runId);
        const result = run?.status || (starting.has(claim.runId) || Date.now() - Date.parse(claim.claimedAt) < 60_000 ? null : "needs_reconciliation");
        if (result && result !== claim.status) sync(await store.settleClaim(claim.runId, result, run?.error || "启动结果不明，已暂停计划并等待核对"));
      }
      if (!automations().some((item) => item.personalRoutine && item.personalSchedule?.enabled)) return;
      if (runs.some((run) => run.runner === "app-server" && ["queued", "running", "canceling"].includes(run.status)) || starting.size) return;
      const due = await store.claimDue();
      if (!due) return;
      sync(due.routine);
      if (!due.claim) return;
      const current = (await store.list()).find((item) => item.id === due.claim.routineId);
      if (!current || current.archivedAt || !current.personalSchedule?.enabled || current.revision !== due.claim.revision) {
        sync(await store.settleClaim(due.claim.runId, "canceled", "流程已修改或暂停，旧计划未启动"));
        return;
      }
      const automation = automations().find((item) => item.id === due.claim.routineId && item.personalRoutine);
      starting.add(due.claim.runId);
      try {
        await startRun(due.claim, automation);
        sync(await store.settleClaim(due.claim.runId, "running"));
      } catch (error) {
        const persisted = (await readRuns()).find((run) => run.id === due.claim.runId);
        sync(await store.settleClaim(due.claim.runId, persisted?.status || "needs_reconciliation", error.message || String(error)));
        warn(`个人计划 ${due.claim.routineId} 启动失败：${error.message}`);
      } finally {
        starting.delete(due.claim.runId);
      }
    } catch (error) {
      warn(`个人计划调度检查失败：${error.message}`);
    } finally {
      busy = false;
    }
  };
}
