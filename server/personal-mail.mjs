import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { calendarDayWindow } from "./personal-calendar.mjs";
import { sourceError as fail, sourceText as text, withPersonalSource } from "./personal-source.mjs";

export const mailSourceLimits = Object.freeze({ freshMs: 300000, refreshMs: 30000, timeoutMs: 45000, maxMessages: 20, resultBytes: 1024 * 1024 });
const toolNames = ["gmail.search_email_ids", "gmail.read_email"];
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const identifier = value => typeof value === "string" && /^[a-zA-Z0-9_-]{1,200}$/.test(value);
const instant = value => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

export function mailWindow(timeZone, now = Date.now()) {
  const day = calendarDayWindow(timeZone, now);
  const to = Math.floor(now / 1000), from = to - 7 * 86400;
  return { date: day.date, timeZone, from: new Date(from * 1000).toISOString(), to: new Date(to * 1000).toISOString(),
    query: `in:inbox is:unread after:${from} before:${to} -in:spam -in:trash`, key: JSON.stringify([day.date, timeZone, "unread-inbox-7d"]) };
}

export function mailAccounts(tools) {
  let accounts, connectorId;
  for (const name of toolNames) {
    const meta = tools[name]?._meta;
    if (!meta || connectorId && meta.connector_id !== connectorId) throw fail("mail_contract_changed", "邮件工具没有绑定同一个连接，未读取邮箱");
    connectorId = meta.connector_id;
    const linked = meta.link_accounts ?? [{ link_id: meta.link_id, profile_email: meta.link_owner_profile?.email, link_name: "Gmail" }];
    if (!Array.isArray(linked) || !linked.length || linked.length > 20) throw fail("mail_account_unavailable", "无法确认已连接邮箱，请在连接服务中核对", 409);
    const normalized = linked.map(item => {
      if (!identifier(item?.link_id) || !text(item.profile_email, 254) || text(item.profile_email, 254) !== item.profile_email || !/^[^\s@]+@[^\s@]+$/.test(item.profile_email)) throw fail("mail_account_unavailable", "邮箱来源信息不完整，未自动选择账号", 409);
      return { id: item.link_id, email: item.profile_email, label: text(item.link_name, 120) || "Gmail" };
    }).sort((a, b) => a.id.localeCompare(b.id));
    if (new Set(normalized.map(item => item.id)).size !== normalized.length || !normalized.some(item => item.id === meta.link_id) || accounts && !isDeepStrictEqual(accounts, normalized)) throw fail("mail_account_unavailable", "邮件工具的账号列表不一致，未读取邮箱", 409);
    accounts = normalized;
  }
  return accounts;
}

export function normalizeMailMessage(raw, account) {
  if (!identifier(raw?.id) || !identifier(raw.threadId) || !Array.isArray(raw.labelIds) ||
      !raw.labelIds.includes("INBOX") || !raw.labelIds.includes("UNREAD") || raw.labelIds.some(label => ["SPAM", "TRASH", "DRAFT"].includes(label))) throw fail("mail_changed_during_read", "邮件状态或来源已变化，请刷新核对；未将读取视为完整");
  const milliseconds = typeof raw.internalDate === "string" && /^\d{1,16}$/.test(raw.internalDate) ? Number(raw.internalDate) : NaN;
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || !Array.isArray(raw.payload?.headers)) throw fail("mail_shape_changed", "邮件时间或标头格式无法确认，未更新原记录");
  const header = name => {
    const values = raw.payload.headers.filter(item => typeof item?.name === "string" && item.name.toLowerCase() === name);
    if (values.length > 1 || values.some(item => typeof item.value !== "string")) throw fail("mail_shape_changed", "邮件标头重复或格式变化，未更新原记录");
    return values[0]?.value || "";
  };
  const item = { id: raw.id, threadId: raw.threadId, title: text(header("subject"), 300) || "无主题邮件", from: text(header("from"), 300),
    receivedAt: new Date(milliseconds).toISOString(), dateHeader: text(header("date"), 256),
    url: `https://mail.google.com/mail/?authuser=${encodeURIComponent(account.email)}#inbox/${encodeURIComponent(raw.threadId)}` };
  if (!item.from) throw fail("mail_shape_changed", "邮件缺少发件人，未更新原记录");
  return { ...item, version: digest(item) };
}

const sourceOptions = options => ({ ...options, prefix: "mail", label: "邮箱", toolNames, timeoutMs: mailSourceLimits.timeoutMs, resultBytes: mailSourceLimits.resultBytes });
export async function listMailAccounts(options) {
  return withPersonalSource(sourceOptions(options), async ({ tools }) => mailAccounts(tools));
}

export async function readUnreadMail(options) {
  const { accountId, window, now = () => Date.now() } = options;
  if (!identifier(accountId)) throw fail("mail_account_required", "请明确选择一个已连接邮箱", 400);
  return withPersonalSource(sourceOptions(options), async ({ tools, invoke }) => {
    const account = mailAccounts(tools).find(item => item.id === accountId);
    if (!account) throw fail("mail_account_unavailable", "所选邮箱已断开或不再可用，请重新选择；未读取其他账号", 409);
    const found = await invoke("gmail.search_email_ids", { link_id: account.id, query: window.query, max_results: mailSourceLimits.maxMessages });
    if (!Array.isArray(found?.message_ids) || found.message_ids.length > mailSourceLimits.maxMessages ||
        found.message_ids.some(id => !identifier(id)) || new Set(found.message_ids).size !== found.message_ids.length ||
        found.next_page_token != null && typeof found.next_page_token !== "string") throw fail("mail_shape_changed", "邮件列表格式无法确认，未将结果当作空邮箱");
    const items = [];
    for (const id of found.message_ids) {
      const raw = await invoke("gmail.read_email", { link_id: account.id, message_id: id, format: "metadata" });
      const item = normalizeMailMessage(raw, account);
      if (item.id !== id || Date.parse(item.receivedAt) < Date.parse(window.from) || Date.parse(item.receivedAt) >= Date.parse(window.to)) throw fail("mail_window_mismatch", "邮件未落在选定范围，未更新原记录");
      items.push(item);
    }
    items.sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt) || a.id.localeCompare(b.id));
    const complete = !found.next_page_token;
    return { provider: "gmail", account, window, items, complete, fetchedAt: new Date(now()).toISOString(), expiresAt: new Date(now() + mailSourceLimits.freshMs).toISOString(),
      version: digest({ account, windowKey: window.key, items, complete }) };
  });
}

export function createPersonalMailSource({ read, write, request, context, now = () => Date.now() }) {
  let active = null, lastAccountRead = 0;
  const threads = new Set();
  const load = async () => {
    const value = await read();
    try {
      if (!value || value.version !== 1 || Buffer.byteLength(JSON.stringify(value)) > mailSourceLimits.resultBytes) throw new Error();
      if (value.lastAttempt && (!instant(value.lastAttempt.at) || !["success", "error"].includes(value.lastAttempt.status) || !identifier(value.lastAttempt.accountId) ||
          value.lastAttempt.status === "success" && (value.lastAttempt.code !== null || value.lastAttempt.error !== null) ||
          value.lastAttempt.status === "error" && (!/^mail_[a-z_]+$/.test(value.lastAttempt.code || "") || !value.lastAttempt.error || text(value.lastAttempt.error, 300) !== value.lastAttempt.error))) throw new Error();
      const s = value.snapshot;
      if (s) {
        if (s.provider !== "gmail" || !identifier(s.account?.id) || typeof s.account.email !== "string" || !/^[^\s@]+@[^\s@]+$/.test(s.account.email) ||
            text(s.account.email, 254) !== s.account.email || !s.account.label || text(s.account.label, 120) !== s.account.label ||
            !instant(s.fetchedAt) || !instant(s.expiresAt) || Date.parse(s.expiresAt) <= Date.parse(s.fetchedAt) || typeof s.complete !== "boolean" ||
            !Array.isArray(s.items) || s.items.length > mailSourceLimits.maxMessages || new Set(s.items.map(item => item?.id)).size !== s.items.length ||
            !instant(s.window?.from) || !instant(s.window.to)) throw new Error();
        const expected = mailWindow(s.window.timeZone, Date.parse(s.window.to));
        if (!isDeepStrictEqual(expected, s.window)) throw new Error();
        for (const item of s.items) {
          const normalized = normalizeMailMessage({ id: item.id, threadId: item.threadId, internalDate: String(Date.parse(item.receivedAt)), labelIds: ["INBOX", "UNREAD"],
            payload: { headers: [{ name: "Subject", value: item.title }, { name: "From", value: item.from }, { name: "Date", value: item.dateHeader }] } }, s.account);
          if (!isDeepStrictEqual(normalized, item) || Date.parse(item.receivedAt) < Date.parse(s.window.from) || Date.parse(item.receivedAt) >= Date.parse(s.window.to)) throw new Error();
        }
        if (s.version !== digest({ account: s.account, windowKey: s.window.key, items: s.items, complete: s.complete })) throw new Error();
      }
    } catch { throw fail("mail_cache_invalid", "邮件缓存格式无效，需要管理员核对；未覆盖原记录", 503); }
    return value;
  };
  const save = value => {
    if (Buffer.byteLength(JSON.stringify(value)) > mailSourceLimits.resultBytes) throw fail("mail_cache_full", "邮件记录超过保存上限，未覆盖原记录", 503);
    return write(value);
  };
  const view = (value, window) => ({ window, snapshot: value.snapshot || null, lastAttempt: value.lastAttempt || null, reading: Boolean(active),
    stale: !value.snapshot || value.snapshot.window.key !== window.key || Date.parse(value.snapshot.expiresAt) <= now() || value.lastAttempt?.status === "error" });
  const run = async (key, operation) => {
    if (active) {
      if (active.key !== key) throw fail("mail_refresh_busy", "另一邮箱来源读取尚未结束，请稍后再试", 409);
      return active.promise;
    }
    if (threads.size >= 128) throw fail("mail_context_busy", "临时只读上下文尚未释放，请稍后再试", 503);
    const promise = operation(); active = { key, promise };
    try { return await promise; } finally { active = null; }
  };
  const options = () => ({ request, ...context(), now, onThread: id => threads.add(id) });
  return {
    activeCount: () => Number(Boolean(active)), ownsThread: id => threads.has(id), closedThread: id => threads.delete(id), resetRuntime: () => threads.clear(),
    async snapshot(timeZone) { return view(await load(), mailWindow(timeZone, now())); },
    async accounts() {
      return run("accounts", async () => {
        if (lastAccountRead && now() - lastAccountRead < mailSourceLimits.refreshMs) throw fail("mail_refresh_throttled", "刚刚读取过邮箱列表，请稍后再试", 429);
        lastAccountRead = now();
        return listMailAccounts(options());
      });
    },
    async refresh(timeZone, accountId) {
      if (!identifier(accountId)) throw fail("mail_account_required", "请明确选择一个已连接邮箱", 400);
      const window = mailWindow(timeZone, now());
      return run(JSON.stringify([accountId, window.key]), async () => {
        const value = await load();
        if (now() - Date.parse(value.lastAttempt?.at || "") < mailSourceLimits.refreshMs) throw fail("mail_refresh_throttled", "刚刚读取过邮件，请稍后再刷新", 429);
        const at = new Date(now()).toISOString();
        try {
          const snapshot = await readUnreadMail({ ...options(), accountId, window });
          const next = { ...value, snapshot, lastAttempt: { at, accountId, status: "success", code: null, error: null } };
          await save(next); return { ...view(next, window), reading: false };
        } catch (error) {
          if (!error.code?.startsWith("mail_")) throw error;
          const next = { ...value, lastAttempt: { at, accountId, status: "error", code: error.code, error: error.message } };
          await save(next); return { ...view(next, window), reading: false };
        }
      });
    },
  };
}
