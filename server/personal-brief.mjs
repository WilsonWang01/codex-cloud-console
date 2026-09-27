const DAY_MS = 24 * 60 * 60 * 1000;

function validTime(value) {
  const time = Date.parse(value || "");
  return Number.isFinite(time) ? time : null;
}

export function buildPersonalBrief(commitments, runs, reviewedAt, now = new Date()) {
  const until = now.toISOString();
  const since = validTime(reviewedAt) ?? now.getTime() - DAY_MS;
  const items = [];
  for (const item of commitments) {
    const completed = item.status === "done" && validTime(item.completedAt);
    const due = item.status === "active" && validTime(item.dueAt);
    const changed = item.status === "active" && validTime(item.updatedAt);
    const candidates = [
      completed && { id: `commitment:done:${item.id}:${item.completedAt}`, kind: "completed", title: item.title, detail: "关注事项已完成", time: item.completedAt, sessionId: item.sessionId },
      due && due <= now.getTime() && { id: `commitment:due:${item.id}:${item.dueAt}`, kind: "due", title: item.title, detail: "关注事项已到期", time: item.dueAt, sessionId: item.sessionId },
      changed && { id: `commitment:changed:${item.id}:${item.updatedAt}`, kind: "changed", title: item.title, detail: item.createdAt === item.updatedAt ? "新增关注事项" : "关注事项已更新", time: item.updatedAt, sessionId: item.sessionId },
    ];
    for (const candidate of candidates) {
      if (candidate && validTime(candidate.time) > since && validTime(candidate.time) <= now.getTime()) items.push(candidate);
    }
  }
  for (const run of runs) {
    if (run.repoId !== "_personal" || !["completed", "failed", "cancelled", "needs_reconciliation"].includes(run.status)) continue;
    const time = validTime(run.finishedAt || run.updatedAt);
    if (!time || time <= since || time > now.getTime()) continue;
    items.push({
      id: `run:${run.id}:${run.status}`, kind: run.status === "completed" ? "completed" : "attention",
      title: run.name || "个人定时任务", detail: run.status === "completed" ? "定时任务已完成" : run.status === "failed" ? "定时任务失败" : run.status === "cancelled" ? "定时任务已取消" : "定时任务待核对",
      time: new Date(time).toISOString(), sessionId: run.sessionId || null,
    });
  }
  items.sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
  return { until, reviewedAt: validTime(reviewedAt) ? reviewedAt : null, items: items.slice(0, 30), total: items.length };
}

export function personalReminderItems(commitments, now = new Date()) {
  const earliest = now.getTime() - DAY_MS;
  return commitments
    .filter((item) => item.status === "active" && validTime(item.dueAt) && validTime(item.dueAt) >= earliest && validTime(item.dueAt) <= now.getTime())
    .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))
    .map((item) => ({
      id: `personal-due:${item.id}:${item.dueAt}`, type: "personal-reminder", tone: "warning",
      title: "个人关注事项已到期", body: "打开个人助理的今日页面查看详情。",
      time: item.dueAt, repoId: "_personal", sessionId: item.sessionId || null,
      action: item.sessionId ? "thread" : "repo",
    }));
}

export function normalizePersonalReminderSettings(value = {}) {
  const timeZone = String(value.timeZone || "UTC");
  if (timeZone.length > 80 || (value.enabled !== undefined && typeof value.enabled !== "boolean")) {
    throw Object.assign(new Error("提醒设置无效"), { statusCode: 400 });
  }
  try { new Intl.DateTimeFormat("en", { timeZone }); }
  catch { throw Object.assign(new Error("时区无效"), { statusCode: 400 }); }
  const quietStart = String(value.quietStart || "22:00");
  const quietEnd = String(value.quietEnd || "08:00");
  if (![quietStart, quietEnd].every((time) => /^([01]\d|2[0-3]):[0-5]\d$/.test(time))) {
    throw Object.assign(new Error("安静时段格式无效"), { statusCode: 400 });
  }
  return { enabled: value.enabled === true, timeZone, quietStart, quietEnd };
}

export function inPersonalQuietHours(settings, now = new Date()) {
  if (settings.quietStart === settings.quietEnd) return false;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: settings.timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  const current = hour * 60 + minute;
  const toMinutes = (value) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  const start = toMinutes(settings.quietStart);
  const end = toMinutes(settings.quietEnd);
  return start < end ? current >= start && current < end : current >= start || current < end;
}
