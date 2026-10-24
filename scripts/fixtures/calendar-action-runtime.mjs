// Synthetic connector contract and receipts, not a recording of a real account.
export function createCalendarActionFixture({ now = () => Date.now(), readEvents = () => [], writeEvents = () => {} } = {}) {
  let serial = 0, mode = "ok", email = "calendar@example.test", linkId = "fixture-link", events = readEvents(), writes = 0;
  const calls = [];
  const string = { type: "string" };
  const schema = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
  const fields = { calendar_id: { const: "primary" }, title: string, attendees: { type: "array", items: string }, description: string, location: string, timezone_str: string,
    start_time: string, end_time: string, start_date: string, end_date: string, add_google_meet: { const: false }, reminders: { type: "object" }, visibility: { const: "private" }, transparency: { const: "opaque" }, event_type: { const: "default" }, self_attendance: { const: "omit" }, guests_can_modify: { const: false } };
  const schemas = { get_profile: schema({}), search: schema({ calendar_id: fields.calendar_id, time_min: string, time_max: string, max_results: { const: 20 } }, ["time_min", "time_max"]), fetch: schema({ calendar_id: fields.calendar_id, event_id: string }, ["event_id"]), create_event: schema(fields, ["title", "attendees"]) };
  const catalog = () => ({ data: [{ name: "codex_apps", httpOrigin: mode === "bad-origin" ? "https://untrusted.example.test" : "https://chatgpt.com", tools: Object.fromEntries(Object.entries(schemas).map(([name, inputSchema]) => [`google_calendar.${name}`, { name: `google_calendar.${name}`, inputSchema, annotations: { readOnlyHint: name !== "create_event", destructiveHint: false, openWorldHint: name === "create_event" }, _meta: { connector_id: "fixture-calendar", link_id: linkId } }])) }], nextCursor: null });
  const request = async (method, params) => {
    calls.push({ method, params: structuredClone(params) });
    if (method === "thread/start") return { thread: { id: "fixture-calendar-" + ++serial, ephemeral: true } };
    if (method === "thread/unsubscribe") return { status: "unsubscribed" };
    if (method === "mcpServerStatus/list") return catalog();
    if (method === "app/installed") return { apps: [{ id: "fixture-calendar", enabled: mode !== "revoked", callable: mode !== "revoked" }] };
    if (method !== "mcpServer/tool/call") throw new Error("Synthetic calendar fixture refuses " + method);
    const args = params.arguments;
    let data;
    if (params.tool === "google_calendar.get_profile") data = { email };
    else if (params.tool === "google_calendar.search") data = { events: mode === "conflict" ? [{ id: "existing", summary: "合成冲突日程", status: "confirmed", start: args.time_min, end: args.time_max, htmlLink: "https://calendar.google.com/calendar/event?eid=synthetic" }] : [], next_page_token: mode === "incomplete" ? "more" : null };
    else if (params.tool === "google_calendar.create_event") {
      writes++;
      const event = { id: "synthetic-event-" + (events.length + 1), summary: args.title, description: args.description, location: args.location, attendees: args.attendees.map(email => ({ email })),
        status: "confirmed", start: args.start_date ? { date: args.start_date, timeZone: args.timezone_str } : { dateTime: args.start_time, timeZone: args.timezone_str }, end: args.end_date ? { date: args.end_date, timeZone: args.timezone_str } : { dateTime: args.end_time, timeZone: args.timezone_str },
        visibility: args.visibility, transparency: args.transparency, guestsCanModify: args.guests_can_modify, reminders: { useDefault: false, overrides: [] }, htmlLink: "https://calendar.google.com/calendar/event?eid=synthetic", updated: new Date(now()).toISOString() };
      events.push(event); writeEvents(events);
      if (mode === "lost-receipt") throw new Error("Synthetic write may have succeeded before disconnect");
      data = { id: event.id };
    } else if (params.tool === "google_calendar.fetch") {
      const event = events.find(item => item.id === args.event_id);
      if (!event || mode === "fetch-failed") throw new Error("Synthetic fetch unavailable");
      data = mode === "mismatch" ? { ...event, summary: "第三方已修改" } : event;
      if (mode === "connector-partial") {
        const { guestsCanModify, transparency, htmlLink, ...rest } = event;
        data = { ...rest, description: event.description || "\n\n", location: event.location || null, guests_can_modify: null,
          web_link: htmlLink, hangout_link: "", recurrence: null, reminders: { use_default: false, overrides: [] } };
      }
    } else throw new Error("Synthetic calendar fixture refuses tool " + params.tool);
    return { content: [{ type: "text", text: "Synthetic action result" }], structuredContent: data, isError: false };
  };
  return { request, calls, schemas, writes: () => writes, events: () => events, setMode: value => { mode = value; }, setAccount: (address, link) => { email = address; linkId = link; } };
}
