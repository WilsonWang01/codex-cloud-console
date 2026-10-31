import Ajv from "ajv";
import { Router } from "express";
import { z } from "zod";
import { DateTime } from "luxon";
import { approvalDigest } from "./approval-broker.mjs";
import { calendarToolData, normalizeCalendarEvent } from "./personal-calendar.mjs";
import { calendarProposalError as fail, calendarProposalLimits, calendarProposalFormatVersion, calendarAvailabilityDigest, calendarContentDigest, calendarCreateArguments, calendarProposalPayload, requireFutureCalendarProposal } from "./personal-calendar-proposals.mjs";

const methods = ["get_profile", "search", "read_event", "create_event"];
const targetDigest = value => approvalDigest("calendar-target", value);
const eventData = value => value?.event && typeof value.event === "object" ? value.event : value;
const timeoutMs = 120_000;

// Each connection is temporary and bound to one installed account and one tool contract.
export async function withCalendarActionConnection({ request, context, onThread = () => {}, closeThread = () => {}, now = () => Date.now() }, operation) {
  const deadline = now() + timeoutMs;
  const call = (method, params, max = 15_000) => {
    const remaining = Math.min(max, deadline - now());
    if (remaining <= 0) throw fail("calendar_action_timeout", "日历操作等待超时，请核对提案状态；未自动重试", 504);
    return request(method, params, remaining);
  };
  let threadId;
  try {
    const started = await call("thread/start", { ...context(), sandbox: "read-only", approvalPolicy: "on-request", ephemeral: true, serviceName: "codex_cloud_calendar_proposal" });
    threadId = started?.thread?.id;
    if (!threadId || started.thread.ephemeral !== true) throw fail("calendar_runtime_unsupported", "无法建立临时日历上下文，未执行操作", 503);
    onThread(threadId, "read");
    const servers = [], cursors = new Set();
    let cursor = null;
    do {
      const page = await call("mcpServerStatus/list", { threadId, cursor, limit: 100, detail: "toolsAndAuthOnly" });
      if (!Array.isArray(page?.data)) throw fail("calendar_catalog_unavailable", "无法核对日历工具目录", 503);
      servers.push(...page.data); cursor = page.nextCursor || null;
      if (cursor && (cursors.has(cursor) || cursors.size >= 4)) throw fail("calendar_catalog_unavailable", "日历目录不完整，未执行操作", 503);
      if (cursor) cursors.add(cursor);
    } while (cursor);
    const server = servers.find(item => item.name === "codex_apps" && item.httpOrigin === "https://chatgpt.com");
    const tools = Object.fromEntries(methods.map(name => [name, server?.tools?.[`google_calendar.${name}`]]));
    const base = tools.search?._meta;
    if (!base || ![base.connector_id, base.link_id].every(value => typeof value === "string" && /^[\w-]{1,200}$/.test(value))) throw fail("calendar_not_connected", "未找到可核对的 Google Calendar 账号", 409);
    const accounts = new Set(Object.values(server.tools).filter(tool => tool._meta?.connector_id === base.connector_id).map(tool => tool._meta?.link_id));
    if (accounts.size !== 1) throw fail("calendar_account_ambiguous", "存在多个日历账号，不能自动选择", 409);
    const ajv = new Ajv({ strict: false });
    const validators = {};
    for (const name of methods) {
      const tool = tools[name], annotations = tool?.annotations;
      const links = tool?._meta?.link_accounts;
      if (links != null && (!Array.isArray(links) || links.length !== 1 || links[0]?.link_id !== base.link_id)) throw fail("calendar_account_ambiguous", "日历工具声明了多个账号或账号来源无法确认，未读取或执行操作", 409);
      if (tool?.name !== `google_calendar.${name}` || tool._meta?.connector_id !== base.connector_id || tool._meta?.link_id !== base.link_id ||
          annotations?.readOnlyHint !== (name !== "create_event") || annotations.destructiveHint !== false || (name === "create_event" && annotations.openWorldHint !== true)) throw fail("calendar_contract_changed", "日历工具的账号或权限说明已变化，未执行操作", 409);
      try { validators[name] = ajv.compile(tool.inputSchema); }
      catch { throw fail("calendar_contract_changed", "日历参数说明无法验证，未执行操作", 409); }
    }
    const installed = await call("app/installed", { threadId });
    if (!installed?.apps?.some(app => app.id === base.connector_id && app.enabled === true && app.callable === true)) throw fail("calendar_not_connected", "Google Calendar 尚未启用或不可调用", 409);
    const invoke = async (name, args) => {
      if (!validators[name]?.(args)) throw fail("calendar_contract_changed", "日历参数不符合当前工具说明，未调用工具", 409);
      onThread(threadId, name === "create_event" ? "write" : "read");
      return calendarToolData(await call("mcpServer/tool/call", { threadId, server: "codex_apps", tool: tools[name].name, arguments: args }, name === "create_event" ? 60_000 : 20_000));
    };
    const profile = await invoke("get_profile", {});
    if (typeof profile?.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.email) || profile.email.length > 254) throw fail("calendar_account_unknown", "日历账号身份无法确认，未执行操作", 409);
    const target = { connectorId: base.connector_id, linkId: base.link_id, email: profile.email.toLowerCase(), calendarId: "primary",
      contract: approvalDigest("calendar-tools", methods.map(name => ({ name: tools[name].name, inputSchema: tools[name].inputSchema, annotations: tools[name].annotations }))) };
    return await operation({ target, invoke });
  } catch (error) {
    if (typeof error.code === "string" && error.code.startsWith("calendar_")) throw error;
    throw fail("calendar_action_unavailable", "日历操作暂不可用，请核对提案状态和连接服务；未自动重试", 503);
  } finally {
    if (threadId) {
      closeThread(threadId);
      await request("thread/unsubscribe", { threadId }, 3000).catch(() => null);
    }
  }
}

function eventWindow(payload) {
  return payload.allDay ? { from: DateTime.fromISO(payload.start, { zone: payload.timeZone }).toUTC().toISO(), to: DateTime.fromISO(payload.end, { zone: payload.timeZone }).toUTC().toISO() } : { from: payload.start, to: payload.end };
}

export async function calendarProposalAvailability(connection, payload, now = () => Date.now()) {
  const window = eventWindow(payload);
  const data = await connection.invoke("search", { calendar_id: "primary", time_min: window.from, time_max: window.to, max_results: calendarProposalLimits.conflicts });
  if (!Array.isArray(data?.events) || data.events.length > calendarProposalLimits.conflicts || data.next_page_token) throw fail("calendar_availability_incomplete", "冲突记录不完整，不能确认空闲；请在原日历核对", 409);
  const conflicts = data.events.map(normalizeCalendarEvent).filter(Boolean).map(event => {
    const start = event.start.date || event.start.dateTime, end = event.end.date || event.end.dateTime;
    const absolute = event.start.date ? eventWindow({ start, end, timeZone: payload.timeZone, allDay: true }) : { from: start, to: end };
    if (Date.parse(absolute.from) >= Date.parse(window.to) || Date.parse(absolute.to) <= Date.parse(window.from)) throw fail("calendar_window_mismatch", "返回日程不属于所核对时段，不能继续确认", 409);
    return { id: event.id, title: event.title, start, end, url: event.url, version: event.version };
  }).sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(conflicts.map(event => event.id)).size !== conflicts.length) throw fail("calendar_availability_incomplete", "冲突记录出现重复，不能继续确认", 409);
  return { conflicts, complete: true, checkedAt: new Date(now()).toISOString(), version: calendarAvailabilityDigest(connection.target, payload, conflicts) };
}

export function verifiedCalendarReceipt(data, payload, eventId, now = () => Date.now()) {
  const raw = eventData(data), event = normalizeCalendarEvent(raw);
  const unverified = () => fail("calendar_receipt_unverified", "日程内容或副作用无法完全核验，请到原日历核对；不会自动再创建", 409);
  const alias = (value, camel, snake) => {
    if (value?.[camel] != null && value?.[snake] != null && value[camel] !== value[snake]) throw unverified();
    return value?.[camel] ?? value?.[snake];
  };
  // The connector uses snake_case and may format an empty description as blank lines.
  const optionalText = value => typeof value === "string" && !value.trim() ? "" : value ?? "";
  const guestsCanModify = alias(raw, "guestsCanModify", "guests_can_modify");
  const remindersDefault = alias(raw?.reminders, "useDefault", "use_default");
  const attendees = Array.isArray(raw?.attendees) ? raw.attendees.map(item => typeof item === "string" ? item : item?.email) : [];
  const actual = event && { title: event.title, description: optionalText(raw.description), location: optionalText(raw.location), attendees: attendees.map(email => String(email).toLowerCase()).sort(),
    timeZone: payload.timeZone, allDay: Boolean(event.start.date), start: event.start.date || new Date(event.start.dateTime).toISOString(), end: event.end.date || new Date(event.end.dateTime).toISOString() };
  const expected = { ...payload, attendees: [...payload.attendees].sort() };
  if (!event || event.id !== eventId || event.status !== "confirmed" || raw.summary !== payload.title || !Array.isArray(raw.attendees) || calendarContentDigest(actual) !== calendarContentDigest(expected) || raw.visibility !== "private" ||
      (raw.transparency != null && raw.transparency !== "opaque") || (guestsCanModify != null && guestsCanModify !== false) || (raw.recurrence != null && (!Array.isArray(raw.recurrence) || raw.recurrence.length)) ||
      payload.allDay && (event.start.timeZone !== payload.timeZone || event.end.timeZone !== payload.timeZone) ||
      raw.conferenceData || raw.conference_data || raw.hangoutLink || raw.hangout_link || raw.conference_id || raw.conference_status || raw.conference_solution_type ||
      remindersDefault !== false || !Array.isArray(raw.reminders.overrides) || raw.reminders.overrides.length) throw unverified();
  const missing = [raw.transparency == null && "忙闲设置", guestsCanModify == null && "来宾修改权限"].filter(Boolean);
  if (missing.length) throw fail("calendar_receipt_unverified", `已读取到内容匹配的日程；连接器未返回${missing.join("、")}，尚不能确认全部设置。请到原日历核对；不会自动再创建。`, 409);
  return { eventId, url: event.url, checkedAt: new Date(now()).toISOString(), source: "google_calendar.read_event", contentDigest: calendarContentDigest(payload) };
}

export function createPersonalCalendarActions({ store, request, context, closeApprovals = () => {}, withLock = task => task(), now = () => Date.now() }) {
  const threads = new Map();
  let cached = [], invalid = false, active = null;
  const list = async () => {
    try { cached = await store.list(); invalid = false; return cached; }
    catch (error) { invalid = true; throw error; }
  };
  const connection = operation => withCalendarActionConnection({ request, context, now, onThread: (id, phase) => threads.set(id, phase), closeThread: id => { closeApprovals(id); threads.delete(id); } }, operation);
  const operate = async operation => {
    if (active) throw fail("calendar_action_busy", "另一个日历核对或动作正在结束，请稍后查看状态", 409);
    active = new Date(now()).toISOString();
    try { return await operation(); } finally { await list().catch(() => null); active = null; }
  };
  const sameTarget = (proposal, target) => { if (targetDigest(proposal.target) !== targetDigest(target)) throw fail("calendar_connection_changed", "目标账号或工具已变化，请重新绑定并核对", 409); };
  return {
    list,
    health: async () => { await list(); return { ok: true, writeFormat: calendarProposalFormatVersion, readableFormats: [1, 2, 3] }; },
    ownsThread: id => threads.has(id),
    canApprove: (method, params) => threads.get(params.threadId) === "write" && method === "mcpServer/elicitation/request" && params.serverName === "codex_apps" && ["form", "openai/form", "openaiForm"].includes(params.mode),
    jobs: () => {
      const items = cached.filter(item => ["executing", "needs_reconciliation"].includes(item.status));
      return [...items.map(item => ({ id: `calendar:${item.id}`, kind: "calendar-action", repoId: "_personal", title: item.payload.title, body: item.error || "日历动作尚未完成", startedAt: item.updatedAt, status: "running", completed: false })),
        ...(active && !items.length ? [{ id: "calendar:checking", kind: "calendar-action", repoId: "_personal", title: "正在核对日历提案", startedAt: active, status: "running", completed: false }] : []),
        ...(invalid ? [{ id: "calendar:invalid", kind: "calendar-action", repoId: "_personal", title: "日历提案存储需要核对", status: "running", completed: false }] : [])];
    },
    async create(clientKey, payload, options = {}) {
      const previous = (await list()).find(item => item.clientKey === clientKey);
      if (previous) return store.create(clientKey, payload, previous.target, options);
      return operate(() => connection(({ target }) => store.create(clientKey, payload, target, options)));
    },
    async update(id, input) {
      const result = input.payload ? await store.edit(id, input.revision, input.payload) : await store.defer(id, input.revision, input.status);
      await list(); return result;
    },
    async preview(id, revision) { return operate(() => connection(async connection => { const item = await store.get(id); sameTarget(item, connection.target); requireFutureCalendarProposal(item.payload, now()); return store.preview(id, revision, connection.target, await calendarProposalAvailability(connection, item.payload, now)); })); },
    async rebind(id, revision) { return operate(() => connection(({ target }) => store.rebind(id, revision, target))); },
    async execute(id, input) {
      const existing = await store.get(id);
      if (existing.attempted) return (await store.claim(id, input, existing.target, null)).proposal;
      // The lock spans the external call; publication cannot race a freshly accepted write.
      const operation = operate(() => withLock(() => connection(async connection => {
        const item = await store.get(id); sameTarget(item, connection.target); requireFutureCalendarProposal(item.payload, now());
        const claimed = await store.claim(id, input, connection.target, await calendarProposalAvailability(connection, item.payload, now));
        if (!claimed.claimed) return claimed.proposal;
        await list();
        let eventId = null;
        try {
          const created = eventData(await connection.invoke("create_event", calendarCreateArguments(item.payload)));
          const rawId = created?.id ?? created?.event_id;
          if (typeof rawId !== "string" || !rawId || rawId.length > 1024) throw fail("calendar_receipt_unverified", "创建回执缺少可核对编号，请到原日历核对；不会自动再创建", 409);
          eventId = rawId;
          const receipt = verifiedCalendarReceipt(await connection.invoke("read_event", { calendar_id: "primary", event_id: eventId }), item.payload, eventId, now);
          return await store.settle(id, { receipt });
        } catch (error) { return store.settle(id, { eventId, error: error?.code === "calendar_receipt_unverified" ? error.message : "执行已尝试，但完整结果尚未核验。请在原日历核对；不要重复创建。" }); }
      })));
      return operation;
    },
    async check(id, revision) { return operate(() => connection(async connection => {
      const item = await store.get(id);
      // Readback can use an upgraded detail tool, but never a different account.
      if (["connectorId", "linkId", "email", "calendarId"].some(key => item.target[key] !== connection.target[key])) throw fail("calendar_connection_changed", "目标账号已变化，不能核对原日程", 409);
      if (item.revision !== revision || item.status !== "needs_reconciliation" || !item.eventId) throw fail("calendar_recheck_unavailable", "此记录没有可自动核对的编号，或状态已变化，请在原日历核对", 409);
      const receipt = verifiedCalendarReceipt(await connection.invoke("read_event", { calendar_id: "primary", event_id: item.eventId }), item.payload, item.eventId, now);
      return store.settle(id, { receipt });
    })); },
    async reconcile(id, revision, note) { if (active) throw fail("calendar_action_busy", "操作仍在结束，暂不能解除核对状态", 409); const item = await store.reconcile(id, revision, note); await list(); return item; },
    async remove(id, revision) { const item = await store.remove(id, revision); await list(); return item; },
  };
}

export function calendarActionRouter(actions) {
  const router = Router(), revision = z.number().int().positive();
  const route = (method, path, schema, run) => router[method](path, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const input = schema ? schema.parse(req.body) : undefined;
      res.json({ ok: true, ...(await run(req.params.id, input)) });
    } catch (error) {
      const known = typeof error.code === "string" && error.code.startsWith("calendar_");
      res.status(error instanceof z.ZodError ? 400 : known ? error.statusCode || 503 : 503).json({
        ok: false,
        error: error instanceof z.ZodError ? "日程请求参数无效" : known ? error.message : "日程记录暂不可用，请保留原数据并核对；未自动重试",
        ...(known ? { code: error.code } : {}), ...(known && error.details ? { details: error.details } : {}),
      });
    }
  });
  route("get", "/", null, async () => ({ version: calendarProposalFormatVersion, proposals: await actions.list() }));
  route("post", "/", z.object({ clientKey: z.string().uuid(), form: z.unknown() }).strict(), async (_, input) => ({ proposal: await actions.create(input.clientKey, calendarProposalPayload(input.form)) }));
  route("patch", "/:id", z.union([z.object({ revision, form: z.unknown() }).strict(), z.object({ revision, status: z.enum(["draft", "deferred", "rejected"]) }).strict()]), async (id, input) => ({ proposal: await actions.update(id, { revision: input.revision, ...("form" in input ? { payload: calendarProposalPayload(input.form) } : { status: input.status }) }) }));
  for (const name of ["preview", "rebind", "check"]) route("post", `/:id/${name}`, z.object({ revision }).strict(), async (id, input) => ({ proposal: await actions[name](id, input.revision) }));
  route("post", "/:id/execute", z.object({ revision, digest: z.string().regex(/^[a-f0-9]{64}$/), confirm: z.literal(true), confirmConflicts: z.boolean().optional() }).strict(), async (id, input) => ({ proposal: await actions.execute(id, input) }));
  route("post", "/:id/reconcile", z.object({ revision, note: z.string().trim().min(1).max(300) }).strict(), async (id, input) => ({ proposal: await actions.reconcile(id, input.revision, input.note) }));
  route("delete", "/:id", z.object({ revision }).strict(), async (id, input) => ({ proposal: await actions.remove(id, input.revision) }));
  return router;
}
