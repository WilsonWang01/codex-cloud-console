import { CronExpressionParser } from "cron-parser";

const maxLatenessMs = 10 * 60_000;

export function personalScheduleLocalDate(instant, timeZone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(instant));
}

export function nextPersonalOccurrence(schedule, after) {
  const [hour, minute] = schedule.time.split(":").map(Number);
  const days = schedule.cadence === "weekdays" ? "1-5" : "*";
  const expression = `0 ${minute} ${hour} * * ${days}`;
  return CronExpressionParser.parse(expression, { tz: schedule.timeZone, currentDate: new Date(after) }).next().toDate().toISOString();
}

export function validatePersonalSchedule(input) {
  if (!input || !["daily", "weekdays"].includes(input.cadence) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time || "")) {
    throw Object.assign(new Error("请选择每天或工作日，并填写有效的 HH:mm 时间"), { statusCode: 400 });
  }
  if (typeof input.timeZone !== "string" || input.timeZone.length > 80) {
    throw Object.assign(new Error("请选择有效的 IANA 时区"), { statusCode: 400 });
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: input.timeZone }).format();
    nextPersonalOccurrence(input, Date.now());
  } catch {
    throw Object.assign(new Error("请选择有效的 IANA 时区"), { statusCode: 400 });
  }
  return { cadence: input.cadence, time: input.time, timeZone: input.timeZone };
}

export function nextDistinctPersonalOccurrence(schedule, after) {
  const localDay = personalScheduleLocalDate(after, schedule.timeZone);
  let next = nextPersonalOccurrence(schedule, after);
  if (personalScheduleLocalDate(next, schedule.timeZone) === localDay) next = nextPersonalOccurrence(schedule, next);
  return next;
}

export function personalScheduleDue(schedule, now = Date.now()) {
  if (!schedule?.enabled || !schedule.nextRunAt) return false;
  const due = Date.parse(schedule.nextRunAt);
  return Number.isFinite(due) && due <= now;
}

export function personalScheduleExpired(schedule, now = Date.now()) {
  return personalScheduleDue(schedule, now) && now - Date.parse(schedule.nextRunAt) > maxLatenessMs;
}
