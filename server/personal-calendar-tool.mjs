import { z } from "zod";
import { isActivePersonalToolCall } from "./personal-memory.mjs";
import { calendarProposalPayload, calendarContentDigest, calendarModelClientKey } from "./personal-calendar-proposals.mjs";

export const personalCalendarTool = {
  type: "function", name: "personal_calendar_propose",
  description: "Save a pending calendar proposal explicitly requested in this personal conversation. Ask for missing title, full local dates/times, IANA time zone and attendees; never guess ambiguous dates, DST offsets or recipients. This tool only saves a draft, does not read calendar events, check availability, create events or send invitations. At most three proposals per foreground turn. The user must review the concrete account, contents, conflicts and effects in Today before a separate confirmation. Never use raw calendar write tools or console APIs to bypass this review. Do not repeat rejected proposals.",
  inputSchema: { type: "object", additionalProperties: false, required: ["form", "reason"], properties: {
    reason: { type: "string", minLength: 1, maxLength: 300, description: "Brief explanation grounded in the user's current request; not a claim of approval or calendar availability." },
    form: { type: "object", additionalProperties: false, required: ["title", "description", "location", "attendees", "timeZone", "allDay", "startLocal", "endLocal"], properties: {
      title: { type: "string", minLength: 1, maxLength: 200 }, description: { type: "string", maxLength: 2000 }, location: { type: "string", maxLength: 300 },
      attendees: { type: "array", maxItems: 10, uniqueItems: true, items: { type: "string", maxLength: 254, format: "email" } }, timeZone: { type: "string", minLength: 1, maxLength: 80 }, allDay: { type: "boolean" },
      startLocal: { type: "string", maxLength: 20, description: "YYYY-MM-DDTHH:mm, or YYYY-MM-DD for an all-day event." }, endLocal: { type: "string", maxLength: 20, description: "Local end time; exclusive end date for all-day events." },
      startOffset: { type: "integer", minimum: -840, maximum: 840, description: "UTC offset in minutes only when explicitly disambiguated with the user." }, endOffset: { type: "integer", minimum: -840, maximum: 840 },
    } },
  } },
};

const reply = (success, text) => ({ success, contentItems: [{ type: "inputText", text }] });
const inputSchema = z.object({ form: z.unknown().refine(value => value && typeof value === "object" && !Array.isArray(value)
  && personalCalendarTool.inputSchema.properties.form.required.every(key => Object.hasOwn(value, key) && value[key] !== undefined)),
  reason: z.string().trim().min(1).max(300).refine(value => !/[\x00-\x1f\x7f]/.test(value)) }).strict();

export async function handlePersonalCalendarCall(params, job, actions) {
  const allowed = () => isActivePersonalToolCall(params, job, personalCalendarTool) && !job.unattendedPersonalSchedule;
  if (!allowed()) return reply(false, "日程草稿只允许由当前前台个人回合提出，未保存提案或修改日历。");
  const parsed = inputSchema.safeParse(params.arguments);
  if (!parsed.success) return reply(false, "请提供日程信息和简短来源说明，不接受授权、执行或其他字段；未保存提案。");
  try {
    const payload = calendarProposalPayload(parsed.data.form);
    const origin = { sessionId: job.sessionId, threadId: job.threadId, turnId: job.turnId, callId: params.callId, reason: parsed.data.reason, contentDigest: calendarContentDigest(payload) };
    const proposal = await actions.create(calendarModelClientKey(origin), payload, { origin, authorize: allowed });
    return reply(true, JSON.stringify({ type: "personal_calendar_proposal", version: 1, proposalId: proposal.id, threadId: job.threadId, turnId: job.turnId, callId: params.callId,
      status: proposal.status, account: proposal.target.email, message: "日程草稿已保存或找到原记录；未检查空闲、创建日程或发送邀请。请用户到今日的日程提案核对并单独确认；已拒绝或已执行的记录未恢复或重试。" }));
  } catch (error) {
    return reply(false, typeof error.code === "string" && error.code.startsWith("calendar_") && error.statusCode < 500 ? error.message : "日程提案保存未确认，请用户核对连接和已有草稿；不要声称已经创建日程。");
  }
}

export function personalCalendarProposalMessages(messages, threadId, proposals) {
  return messages.map(message => {
    const detail = message.details;
    if (message.messageType !== "dynamicToolCall" || detail?.tool !== personalCalendarTool.name || detail.namespace != null || detail.status !== "completed" || detail.success !== true || detail.contentItems?.length !== 1) return message;
    const content = detail.contentItems[0];
    if (content?.type !== "inputText" || typeof content.text !== "string" || content.text.length > 6000) return message;
    try {
      const receipt = JSON.parse(content.text);
      if (receipt.type !== "personal_calendar_proposal" || receipt.version !== 1 || !z.string().uuid().safeParse(receipt.proposalId).success || receipt.threadId !== threadId || receipt.turnId !== message.turnId || receipt.callId !== message.id) return message;
      const item = proposals?.find(item => item.id === receipt.proposalId && item.origin?.threadId === threadId && item.origin.turnId === message.turnId && item.origin.callId === message.id);
      if (item) {
        const input = inputSchema.parse(detail.arguments);
        if (calendarContentDigest(calendarProposalPayload(input.form)) !== item.origin.contentDigest || input.reason !== item.origin.reason) return message;
      }
      const available = Boolean(item);
      return { ...message, text: available ? `日程提案已保存：${item.payload.title}` : "日程提案原记录暂不可用，请到今日核对；未据此重建或执行。",
        details: { ...detail, personalCalendarProposal: { id: receipt.proposalId, available, ...(item ? { title: item.payload.title, status: item.status } : {}) } } };
    } catch { return message; }
  });
}
