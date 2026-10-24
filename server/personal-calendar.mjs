import { createHash } from "node:crypto";
import { CronDate } from "cron-parser";
import { withPersonalSource } from "./personal-source.mjs";

const minute = 60_000;
export const calendarSourceLimits = Object.freeze({ freshMs: 5 * minute, refreshMs: 30_000, timeoutMs: 45_000, pageSize: 50, pages: 2, resultBytes: 1024 * 1024 });
const fail = (code, message, statusCode = 502) => Object.assign(new Error(message), { code, statusCode });
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const text = (value, max) => typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, max) : "";
const date = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + "T00:00:00Z")) && new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value;
const instant = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value) && date(value.slice(0, 10)) && Number.isFinite(Date.parse(value));

export function calendarDayWindow(timeZone, now = Date.now()) {
  try {
    if (typeof timeZone !== "string" || !timeZone || timeZone.length > 80 || !Number.isFinite(now)) throw new Error();
    new Intl.DateTimeFormat("en", { timeZone }).format(now);
    const day = new CronDate(new Date(now), timeZone);
    day.setStartOfDay();
    const from = day.toISOString();
    day.addDay();
    const to = day.toISOString();
    const localDate = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
    return { date: localDate, timeZone, from, to, key: JSON.stringify([localDate, timeZone]) };
  } catch { throw fail("invalid_time_zone", "请选择有效的 IANA 时区", 400); }
}

function sourceUrl(value) {
  try {
    const url = new URL(value);
    return url.href.length <= 2048 && url.protocol === "https:" && !url.username && !url.password && !url.port &&
      (url.hostname === "calendar.google.com" || url.hostname === "www.google.com" && url.pathname.startsWith("/calendar/")) ? url.href : null;
  } catch { return null; }
}

function eventTime(value) {
  if (typeof value === "string") value = date(value) ? { date: value } : { dateTime: value };
  if (!value || typeof value !== "object") throw fail("calendar_shape_changed", "日历时间格式无法确认，请在原日历核对");
  if (value.timeZone != null) {
    try { if (typeof value.timeZone !== "string" || value.timeZone.length > 80) throw new Error(); new Intl.DateTimeFormat("en", { timeZone: value.timeZone }); }
    catch { throw fail("calendar_shape_changed", "日历原始时区无法确认，请在原日历核对"); }
  }
  if (date(value.date) && value.dateTime == null) return { date: value.date, dateTime: null, timeZone: value.timeZone || null };
  if (instant(value.dateTime) && value.date == null) return { date: null, dateTime: value.dateTime, timeZone: value.timeZone || null };
  throw fail("calendar_shape_changed", "日历时间缺少有效日期或时区偏移，请在原日历核对");
}

export function normalizeCalendarEvent(value) {
  if (!value || typeof value !== "object" || !text(value.id, 1024) || text(value.id, 1024) !== value.id) throw fail("calendar_shape_changed", "日程缺少可追溯标识，未将读取视为完整");
  if (value.status === "cancelled") return null;
  const start = eventTime(value.start), end = eventTime(value.end);
  if (Boolean(start.date) !== Boolean(end.date) || (start.date ? end.date <= start.date : Date.parse(end.dateTime) <= Date.parse(start.dateTime))) throw fail("calendar_shape_changed", "日历起止时间无法确认，请在原日历核对");
  const event = { id: value.id, title: text(value.summary, 200) || "未命名日程", start, end, url: sourceUrl(value.web_link ?? value.htmlLink),
    status: ["confirmed", "tentative"].includes(value.status) ? value.status : "unspecified", updatedAt: instant(value.updated) ? value.updated : null };
  return { ...event, version: digest(event) };
}

function inWindow(event, window) {
  return event.start.date
    ? event.start.date < calendarDayWindow(window.timeZone, Date.parse(window.to)).date && event.end.date > window.date
    : Date.parse(event.start.dateTime) < Date.parse(window.to) && Date.parse(event.end.dateTime) > Date.parse(window.from);
}

export async function readTodayCalendar({ request, cwd, model = "gpt-6-sol", window, onThread = () => {}, now = () => Date.now() }) {
  return withPersonalSource({ request, cwd, model, prefix: "calendar", label: "日历", toolNames: ["google_calendar.search"],
    timeoutMs: calendarSourceLimits.timeoutMs, resultBytes: calendarSourceLimits.resultBytes, onThread, now }, async ({ server, tools, invoke }) => {
    const tool = tools["google_calendar.search"];
    const accounts = new Set(Object.values(server.tools).filter(item => item._meta?.connector_id === tool._meta.connector_id).map(item => item._meta?.link_id));
    if (accounts.size !== 1 || tool._meta.link_accounts != null && (!Array.isArray(tool._meta.link_accounts) || tool._meta.link_accounts.length !== 1 || tool._meta.link_accounts[0]?.link_id !== tool._meta.link_id)) throw fail("calendar_account_ambiguous", "连接了多个日历账号或来源无法确认，尚未选择来源，未自动读取任一账号", 409);
    const args = { calendar_id: "primary", time_min: window.from, time_max: window.to, max_results: calendarSourceLimits.pageSize };
    const events = new Map(), seen = new Set();
    let next = null, pages = 0;
    do {
      const input = { ...args, ...(next ? { next_page_token: next } : {}) };
      const data = await invoke(tool.name, input);
      if (!Array.isArray(data?.events) || data.events.length > calendarSourceLimits.pageSize ||
          (data.next_page_token != null && (typeof data.next_page_token !== "string" || data.next_page_token.length > 4096))) throw fail("calendar_shape_changed", "日历返回格式无法确认，未将读取视为完整");
      for (const raw of data.events) {
        const event = normalizeCalendarEvent(raw);
        if (!event) continue;
        if (!inWindow(event, window)) throw fail("calendar_window_mismatch", "日程没有落在请求的日期内，未将读取视为完整");
        const previous = events.get(event.id);
        if (previous && previous.version !== event.version) throw fail("calendar_changed_during_read", "日程在分页读取时变化，请刷新核对");
        events.set(event.id, event);
      }
      pages++;
      next = data.next_page_token || null;
      if (next && seen.has(next)) throw fail("calendar_pagination_invalid", "日历分页重复，未将读取视为完整");
      if (next) seen.add(next);
    } while (next && pages < calendarSourceLimits.pages);
    const items = [...events.values()].sort((a, b) => {
      if (Boolean(a.start.date) !== Boolean(b.start.date)) return a.start.date ? -1 : 1;
      return (a.start.date ? a.start.date.localeCompare(b.start.date) : Date.parse(a.start.dateTime) - Date.parse(b.start.dateTime)) || a.id.localeCompare(b.id);
    });
    const fetchedAt = new Date(now()).toISOString();
    const account = { id: text(tool._meta.link_id, 200), label: text(tool._meta.link_owner_profile?.email || tool._meta.link_owner_profile?.name, 160) || "当前 Google Calendar 账号" };
    return { provider: "google-calendar", calendarId: "primary", account, window, fetchedAt, expiresAt: new Date(now() + calendarSourceLimits.freshMs).toISOString(),
      complete: !next, items, version: digest({ account: account.id, window, items, complete: !next }) };
  });
}

export function createPersonalCalendarSource({ read, write, request, context, now = () => Date.now() }) {
  let active = null;
  const threads = new Set();
  const save = value => {
    if (Buffer.byteLength(JSON.stringify(value)) > calendarSourceLimits.resultBytes) throw fail("calendar_cache_full", "日历记录超过保存上限，未覆盖原记录", 503);
    return write(value);
  };
  const load = async () => {
    const value = await read();
    try {
      if (!value || value.version !== 1 || Buffer.byteLength(JSON.stringify(value)) > calendarSourceLimits.resultBytes) throw new Error();
      if (value.lastAttempt && (!instant(value.lastAttempt.at) || !["success", "error"].includes(value.lastAttempt.status))) throw new Error();
      const s = value.snapshot;
      if (s) {
        if (s.provider !== "google-calendar" || s.calendarId !== "primary" || !s.account?.id || text(s.account.id, 200) !== s.account.id || !s.account.label || text(s.account.label, 160) !== s.account.label ||
            !instant(s.fetchedAt) || !instant(s.expiresAt) || Date.parse(s.expiresAt) <= Date.parse(s.fetchedAt) || typeof s.complete !== "boolean" ||
            !Array.isArray(s.items) || s.items.length > 100 || !s.window?.key || !instant(s.window.from) || !instant(s.window.to)) throw new Error();
        const expected = calendarDayWindow(s.window.timeZone, Date.parse(s.window.from) + 1000);
        if (expected.key !== s.window.key || expected.from !== s.window.from || expected.to !== s.window.to || expected.date !== s.window.date || new Set(s.items.map(item => item?.id)).size !== s.items.length) throw new Error();
        for (const item of s.items) {
          const normalized = normalizeCalendarEvent({ id: item?.id, summary: item?.title, start: item?.start, end: item?.end, htmlLink: item?.url, status: item?.status, updated: item?.updatedAt });
          if (!normalized || Object.keys(item).length !== Object.keys(normalized).length || Object.entries(normalized).some(([key, value]) => JSON.stringify(item[key]) !== JSON.stringify(value)) || !inWindow(item, s.window)) throw new Error();
        }
        if (s.version !== digest({ account: s.account.id, window: s.window, items: s.items, complete: s.complete })) throw new Error();
      }
    } catch { throw fail("calendar_cache_invalid", "日历缓存格式无效，需要管理员核对；未覆盖原记录", 503); }
    return value;
  };
  const view = (value, window) => ({ window, snapshot: value.snapshot || null, lastAttempt: value.lastAttempt || null, reading: Boolean(active),
    stale: !value.snapshot || value.snapshot.window.key !== window.key || Date.parse(value.snapshot.expiresAt) <= now() || value.lastAttempt?.status === "error" });
  return {
    activeCount: () => Number(Boolean(active)),
    ownsThread: id => threads.has(id),
    closedThread: id => threads.delete(id),
    resetRuntime: () => threads.clear(),
    async snapshot(timeZone) { const window = calendarDayWindow(timeZone, now()); return view(await load(), window); },
    async refresh(timeZone) {
      const window = calendarDayWindow(timeZone, now());
      if (active) {
        if (active.key !== window.key) throw fail("calendar_refresh_busy", "另一日历读取尚未结束，请稍后刷新", 409);
        return active.promise;
      }
      const operation = (async () => {
        const value = await load();
        if (now() - Date.parse(value.lastAttempt?.at || "") < calendarSourceLimits.refreshMs) throw fail("calendar_refresh_throttled", "刚刚读取过日历，请稍后再刷新", 429);
        if (threads.size >= 128) throw fail("calendar_context_busy", "临时只读上下文尚未释放，请稍后再试", 503);
        const at = new Date(now()).toISOString();
        try {
          const snapshot = await readTodayCalendar({ request, ...context(), window, now, onThread: id => threads.add(id) });
          const next = { ...value, snapshot, lastAttempt: { at, status: "success", code: null, error: null } };
          await save(next);
          return { ...view(next, window), reading: false };
        } catch (error) {
          if (!error.code?.startsWith("calendar_")) throw error;
          const next = { ...value, lastAttempt: { at, status: "error", code: error.code, error: error.message } };
          await save(next);
          return { ...view(next, window), reading: false };
        }
      })();
      active = { key: window.key, promise: operation };
      try { return await operation; } finally { active = null; }
    },
  };
}
