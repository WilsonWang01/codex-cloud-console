import crypto from "node:crypto";
import { DateTime, IANAZone } from "luxon";
import { z } from "zod";
import { approvalDigest } from "./approval-broker.mjs";
import { createKeyedQueue } from "./run-safety.mjs";

export const calendarProposalLimits = Object.freeze({ count: 100, bytes: 2 * 1024 * 1024, previewMs: 5 * 60_000, conflicts: 20 });
export const calendarProposalFormatVersion = 1;
export const calendarProposalError = (code, message, statusCode = 400, details) => Object.assign(new Error(message), { code, statusCode, ...(details ? { details } : {}) });
const invalid = () => calendarProposalError("calendar_proposal_invalid", "日程提案数据无效，原记录未改写", 503);
const instant = z.string().datetime({ offset: true }).max(40);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const text = max => z.string().trim().max(max).refine(value => !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value));
const zone = z.string().min(1).max(80).refine(value => value === "UTC" || IANAZone.isValidZone(value));
const formSchema = z.object({ title: text(200).min(1), description: text(2000).default(""), location: text(300).default(""),
  attendees: z.array(z.string().trim().email().max(254)).max(10).default([]), timeZone: zone, allDay: z.boolean().default(false),
  startLocal: z.string().max(20), endLocal: z.string().max(20), startOffset: z.number().int().min(-840).max(840).optional(), endOffset: z.number().int().min(-840).max(840).optional(),
}).strict();
const payloadSchema = z.object({ title: text(200).min(1), description: text(2000), location: text(300), attendees: z.array(z.string().email().max(254)).max(10),
  timeZone: zone, allDay: z.boolean(), start: z.string().max(40), end: z.string().max(40),
}).strict();
const targetSchema = z.object({ connectorId: z.string().min(1).max(200), linkId: z.string().min(1).max(200), email: z.string().email().max(254),
  calendarId: z.literal("primary"), contract: hash,
}).strict();
const calendarUrl = z.string().max(2048).refine(value => {
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && !url.port && (url.hostname === "calendar.google.com" || url.hostname === "www.google.com" && url.pathname.startsWith("/calendar/")); }
  catch { return false; }
}).nullable();
const availabilitySchema = z.object({ version: hash, checkedAt: instant, complete: z.literal(true),
  conflicts: z.array(z.object({ id: z.string().min(1).max(1024), title: text(200), start: z.string().max(40), end: z.string().max(40), url: calendarUrl, version: hash }).strict()).max(calendarProposalLimits.conflicts),
}).strict();
const previewSchema = z.object({ digest: hash, expiresAt: instant, availability: availabilitySchema }).strict();
const receiptSchema = z.object({ eventId: z.string().min(1).max(1024), url: calendarUrl, checkedAt: instant,
  source: z.literal("google_calendar.fetch"), contentDigest: hash,
}).strict();
const itemSchema = z.object({ id: z.string().uuid(), clientKey: z.string().uuid(), inputDigest: hash, revision: z.number().int().positive(),
  payload: payloadSchema, target: targetSchema, source: z.literal("user"), createdAt: instant, updatedAt: instant,
  status: z.enum(["draft", "deferred", "rejected", "executing", "succeeded", "needs_reconciliation", "reconciled"]),
  attempted: z.boolean(), preview: previewSchema.nullable(), confirmation: z.object({ digest: hash, revision: z.number().int().positive(), at: instant }).strict().nullable(),
  receipt: receiptSchema.nullable(), eventId: z.string().min(1).max(1024).nullable(), error: text(500).nullable(),
  reconciliation: z.object({ at: instant, source: z.literal("user"), note: text(300).min(1) }).strict().nullable(),
}).strict();

function wallTime(value, timeZone, offset, field) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw calendarProposalError("calendar_time_invalid", "请填写完整的日期和时间");
  const time = DateTime.fromISO(value, { zone: timeZone });
  if (!time.isValid || time.toFormat("yyyy-MM-dd'T'HH:mm") !== value) throw calendarProposalError("calendar_time_invalid", "所填时间不存在或跨越夏令时跳转，请重新选择");
  const choices = time.getPossibleOffsets();
  if (offset !== undefined && !choices.some(choice => choice.offset === offset)) throw calendarProposalError("calendar_time_invalid", "时间或时区已变化，请重新核对 UTC 偏移");
  if (choices.length > 1 && offset === undefined) throw calendarProposalError("calendar_time_ambiguous", "该时间因夏令时重复，请明确选择 UTC 偏移", 428,
    { field, offsets: choices.map(choice => ({ minutes: choice.offset, label: `UTC${choice.toFormat("ZZ")}` })) });
  return choices.find(choice => offset === undefined || choice.offset === offset).toUTC().toISO();
}

export function calendarProposalPayload(input) {
  const parsed = formSchema.safeParse(input);
  if (!parsed.success) throw calendarProposalError("calendar_form_invalid", "请核对标题、时区、时间和最多 10 个普通邮箱地址");
  const form = parsed.data;
  let start, end;
  if (form.allDay) {
    const dates = [form.startLocal, form.endLocal].map(value => DateTime.fromISO(value, { zone: "UTC" }));
    if (!dates.every((date, index) => date.isValid && date.toISODate() === [form.startLocal, form.endLocal][index]) || form.startLocal.length !== 10 || form.endLocal.length !== 10) throw calendarProposalError("calendar_time_invalid", "全天日程需填写日期，结束日期不包含在日程内");
    [start, end] = [form.startLocal, form.endLocal];
  } else {
    start = wallTime(form.startLocal, form.timeZone, form.startOffset, "startOffset");
    end = wallTime(form.endLocal, form.timeZone, form.endOffset, "endOffset");
  }
  if (Date.parse(end) <= Date.parse(start) || Date.parse(end) - Date.parse(start) > 7 * 86400_000) throw calendarProposalError("calendar_time_invalid", "结束时间需晚于开始时间，本版单次日程最长 7 天");
  const attendees = form.attendees.map(email => email.toLowerCase());
  if (new Set(attendees).size !== attendees.length) throw calendarProposalError("calendar_form_invalid", "参与者邮箱不能重复");
  return { title: form.title, description: form.description, location: form.location, attendees, timeZone: form.timeZone, allDay: form.allDay, start, end };
}

export function calendarProposalForm(payload) {
  const times = [payload.start, payload.end].map(value => DateTime.fromISO(value, { zone: payload.timeZone }));
  return { title: payload.title, description: payload.description, location: payload.location, attendees: payload.attendees,
    timeZone: payload.timeZone, allDay: payload.allDay, startLocal: payload.allDay ? payload.start : times[0].toFormat("yyyy-MM-dd'T'HH:mm"),
    endLocal: payload.allDay ? payload.end : times[1].toFormat("yyyy-MM-dd'T'HH:mm"),
    ...(!payload.allDay ? { startOffset: times[0].offset, endOffset: times[1].offset } : {}),
  };
}

export function calendarCreateArguments(payload) {
  return { calendar_id: "primary", title: payload.title, attendees: payload.attendees, description: payload.description, location: payload.location,
    timezone_str: payload.timeZone, ...(payload.allDay ? { start_date: payload.start, end_date: payload.end } : { start_time: payload.start, end_time: payload.end }),
    add_google_meet: false, reminders: { use_default: false, overrides: [] }, visibility: "private", transparency: "opaque", event_type: "default",
    self_attendance: "omit", guests_can_modify: false,
  };
}

export function requireFutureCalendarProposal(payload, now) {
  const start = payload.allDay ? DateTime.fromISO(payload.start, { zone: payload.timeZone }).toMillis() : Date.parse(payload.start);
  const earliest = payload.allDay ? DateTime.fromMillis(now, { zone: payload.timeZone }).startOf("day").toMillis() : now;
  if (start < earliest || start > now + 366 * 86400_000) throw calendarProposalError("calendar_proposal_expired", "提案时间已过或超过一年，请先编辑并重新核对", 409);
}

export const calendarContentDigest = payload => approvalDigest("calendar-content", payload);
export const calendarAvailabilityDigest = (target, payload, conflicts) => approvalDigest("calendar-availability", { connectorId: target.connectorId, linkId: target.linkId, start: payload.start, end: payload.end, timeZone: payload.timeZone, conflicts });

function payloadValue(payload) {
  if (!payloadSchema.safeParse(payload).success || calendarContentDigest(calendarProposalPayload(calendarProposalForm(payload))) !== calendarContentDigest(payload)) throw calendarProposalError("calendar_form_invalid", "提案时间或内容不符合已支持格式");
  return structuredClone(payload);
}

function validAvailability(value, target, payload, now) {
  return availabilitySchema.safeParse(value).success && calendarAvailabilityDigest(target, payload, value.conflicts) === value.version
    && Date.parse(value.checkedAt) <= now && now - Date.parse(value.checkedAt) <= calendarProposalLimits.previewMs;
}

function proposalDigest(item, preview) {
  return approvalDigest("personal-calendar-create", { id: item.id, revision: item.revision, payload: item.payload, target: item.target, availability: preview.availability.version, expiresAt: preview.expiresAt });
}

export function createCalendarProposalStore({ read, write, now = () => Date.now() }) {
  const queue = createKeyedQueue();
  let initialized = false;
  const load = async () => {
    const state = await read() ?? { version: 1, proposals: [] };
    const parsed = z.object({ version: z.literal(1), proposals: z.array(itemSchema).max(calendarProposalLimits.count) }).strict().safeParse(state);
    if (!parsed.success || Buffer.byteLength(JSON.stringify(state)) > calendarProposalLimits.bytes || new Set(state.proposals.map(item => item.id)).size !== state.proposals.length || new Set(state.proposals.map(item => item.clientKey)).size !== state.proposals.length) throw invalid();
    try { for (const item of state.proposals) {
      if (calendarContentDigest(calendarProposalPayload(calendarProposalForm(item.payload))) !== calendarContentDigest(item.payload)
        || item.preview && item.preview.digest !== proposalDigest(item, item.preview)
        || item.preview && calendarAvailabilityDigest(item.target, item.payload, item.preview.availability.conflicts) !== item.preview.availability.version
        || item.attempted !== Boolean(item.confirmation) || ["executing", "succeeded", "needs_reconciliation", "reconciled"].includes(item.status) !== item.attempted
        || item.receipt && (item.receipt.eventId !== item.eventId || item.receipt.contentDigest !== calendarContentDigest(item.payload))
        || item.status === "succeeded" && !item.receipt
        || item.status === "reconciled" !== Boolean(item.reconciliation)) throw invalid();
    } } catch { throw invalid(); }
    return state;
  };
  const save = async state => { if (Buffer.byteLength(JSON.stringify(state)) > calendarProposalLimits.bytes) throw calendarProposalError("calendar_proposal_capacity", "日程提案已达到保存容量，未覆盖原记录", 503); await write(state); };
  const mutate = operation => queue("proposals", async () => {
    const state = await load();
    if (!initialized) {
      let changed = false;
      for (const item of state.proposals.filter(item => item.status === "executing")) { item.status = "needs_reconciliation"; item.error = "服务曾中断，是否已创建日程尚不明确；未自动重试。"; item.preview = null; item.revision++; item.updatedAt = new Date(now()).toISOString(); changed = true; }
      if (changed) await save(state);
      initialized = true;
    }
    const result = await operation(state);
    return structuredClone(result);
  });
  const find = (state, id, revision) => {
    const item = state.proposals.find(item => item.id === id);
    if (!item) throw calendarProposalError("calendar_proposal_missing", "日程提案不存在", 404);
    if (revision !== undefined && (!Number.isInteger(revision) || revision !== item.revision)) throw calendarProposalError("calendar_proposal_conflict", "提案已在其他页面变化，请核对最新内容；你的输入未保存", 409);
    return item;
  };
  const touch = item => { item.revision++; item.updatedAt = new Date(now()).toISOString(); };
  const editable = item => { if (item.attempted) throw calendarProposalError("calendar_proposal_attempted", "此提案已尝试执行，不能再次修改或执行；请先核对结果", 409); };
  return {
    list: () => mutate(state => state.proposals),
    get: id => mutate(state => find(state, id)),
    create: (clientKey, payload, target) => mutate(async state => {
      payload = payloadValue(payload);
      if (!z.string().uuid().safeParse(clientKey).success || !targetSchema.safeParse(target).success) throw calendarProposalError("calendar_form_invalid", "提案编号或目标账号无效");
      const inputDigest = approvalDigest("calendar-proposal-input", payload), previous = state.proposals.find(item => item.clientKey === clientKey);
      if (previous) { if (previous.inputDigest !== inputDigest) throw calendarProposalError("calendar_proposal_conflict", "同一草稿编号的内容已变化，请刷新核对", 409); return previous; }
      if (state.proposals.length >= calendarProposalLimits.count) throw calendarProposalError("calendar_proposal_capacity", "日程提案达到 100 条上限，请先清理未执行草稿", 409);
      const at = new Date(now()).toISOString(), item = { id: crypto.randomUUID(), clientKey, inputDigest, revision: 1, payload, target, source: "user", createdAt: at, updatedAt: at,
        status: "draft", attempted: false, preview: null, confirmation: null, receipt: null, eventId: null, error: null, reconciliation: null };
      state.proposals.push(item); await save(state); return item;
    }),
    edit: (id, revision, payload) => mutate(async state => { const item = find(state, id, revision); editable(item); item.payload = payloadValue(payload); item.status = "draft"; item.preview = null; item.error = null; touch(item); await save(state); return item; }),
    defer: (id, revision, status) => mutate(async state => { const item = find(state, id, revision); editable(item); if (!["deferred", "rejected", "draft"].includes(status)) throw calendarProposalError("calendar_form_invalid", "提案状态无效"); item.status = status; item.preview = null; touch(item); await save(state); return item; }),
    preview: (id, revision, target, availability) => mutate(async state => {
      const item = find(state, id, revision); editable(item); requireFutureCalendarProposal(item.payload, now());
      if (item.status !== "draft" || !targetSchema.safeParse(target).success || !validAvailability(availability, target, item.payload, now())) throw calendarProposalError("calendar_proposal_invalid", "请先恢复草稿并重新核对目标与冲突", 409);
      if (approvalDigest("calendar-target", item.target) !== approvalDigest("calendar-target", target)) throw calendarProposalError("calendar_connection_changed", "账号或连接器参数已变化，请重新核对账号", 409);
      touch(item); item.preview = { expiresAt: new Date(now() + calendarProposalLimits.previewMs).toISOString(), availability, digest: "" }; item.preview.digest = proposalDigest(item, item.preview); item.error = null;
      await save(state); return item;
    }),
    rebind: (id, revision, target) => mutate(async state => { const item = find(state, id, revision); editable(item); if (!targetSchema.safeParse(target).success) throw invalid(); item.target = target; item.preview = null; item.status = "draft"; touch(item); await save(state); return item; }),
    claim: (id, input, target, availability) => mutate(async state => {
      const item = find(state, id);
      if (!z.object({ confirm: z.literal(true), revision: z.number().int().positive(), digest: hash, confirmConflicts: z.boolean().optional() }).strict().safeParse(input).success) throw calendarProposalError("calendar_confirmation_required", "需确认具体提案内容与影响", 428);
      if (item.attempted) { if (input.digest !== item.confirmation.digest) throw calendarProposalError("calendar_proposal_conflict", "确认内容不匹配", 409); return { claimed: false, proposal: item }; }
      find(state, id, input.revision); requireFutureCalendarProposal(item.payload, now());
      const preview = item.preview;
      if (item.status !== "draft" || !preview || preview.digest !== input.digest || Date.parse(preview.expiresAt) <= now()) throw calendarProposalError("calendar_confirmation_expired", "确认内容已变化或核对已过期，请重新核对", 409);
      if (approvalDigest("calendar-target", target) !== approvalDigest("calendar-target", item.target) || !validAvailability(availability, target, item.payload, now()) || availability.version !== preview.availability.version) throw calendarProposalError("calendar_source_changed", "账号或时段安排已变化，请重新核对后确认", 409);
      if (availability.conflicts.length && input.confirmConflicts !== true) throw calendarProposalError("calendar_conflicts_unconfirmed", "所选时段已有日程，需明确确认仍要创建", 428);
      item.confirmation = { digest: input.digest, revision: item.revision, at: new Date(now()).toISOString() }; item.preview = null; item.status = "executing"; item.attempted = true; item.error = null; touch(item);
      await save(state); return { claimed: true, proposal: item };
    }),
    settle: (id, { receipt = null, eventId = null, error = null }) => mutate(async state => {
      const item = find(state, id);
      if (!["executing", "needs_reconciliation"].includes(item.status) || !item.attempted) throw calendarProposalError("calendar_proposal_conflict", "提案不在可核对状态", 409);
      if (receipt && (!receiptSchema.safeParse(receipt).success || receipt.contentDigest !== calendarContentDigest(item.payload) || item.eventId && receipt.eventId !== item.eventId)) throw invalid();
      if (eventId !== null && (typeof eventId !== "string" || !eventId || eventId.length > 1024) || error !== null && typeof error !== "string") throw invalid();
      item.status = receipt ? "succeeded" : "needs_reconciliation"; item.receipt = receipt; item.eventId = receipt?.eventId || eventId || item.eventId; item.error = error?.slice(0, 500) || null; item.preview = null; touch(item); await save(state); return item;
    }),
    reconcile: (id, revision, note) => mutate(async state => { const item = find(state, id, revision); if (item.status !== "needs_reconciliation" || !text(300).min(1).safeParse(note).success) throw calendarProposalError("calendar_form_invalid", "请先在原日历核对，并填写核对说明", 409); item.status = "reconciled"; item.reconciliation = { at: new Date(now()).toISOString(), source: "user", note: note.trim() }; touch(item); await save(state); return item; }),
    remove: (id, revision) => mutate(async state => { const item = find(state, id, revision); editable(item); state.proposals.splice(state.proposals.indexOf(item), 1); await save(state); return item; }),
  };
}
