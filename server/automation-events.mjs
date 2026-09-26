const eventLimit = 80;

function validSequence(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function eventKey(event) {
  return `${event.time}|${event.type}|${event.text}`;
}

function normalizeEvent(event, sequence) {
  return {
    seq: sequence,
    time: String(event.time || new Date().toISOString()),
    type: String(event.type || "status"),
    text: String(event.text || "").slice(0, 1200),
  };
}

export function normalizeAutomationEvents(rawEvents, storedSequence = 0) {
  const source = Array.isArray(rawEvents) ? rawEvents.slice(-eventLimit).filter(Boolean) : [];
  const highWatermark = validSequence(storedSequence);
  const hasSequence = source.some((event) => validSequence(event.seq));
  let sequence = hasSequence ? 0 : Math.max(0, highWatermark - source.length);
  const events = source.map((event) => {
    sequence = Math.max(sequence + 1, validSequence(event.seq));
    return normalizeEvent(event, sequence);
  });
  return { events, eventSeq: Math.max(sequence, highWatermark) };
}

export function mergeAutomationEvents(currentRun, ...groups) {
  const current = normalizeAutomationEvents(currentRun?.events, currentRun?.eventSeq);
  const events = [...current.events];
  const seen = new Set(events.map(eventKey));
  let eventSeq = current.eventSeq;
  for (const raw of groups.flat().filter(Boolean)) {
    const event = normalizeEvent(raw, eventSeq + 1);
    const key = eventKey(event);
    if (seen.has(key)) continue;
    seen.add(key);
    eventSeq += 1;
    events.push(event);
  }
  return { events: events.slice(-eventLimit), eventSeq };
}

export function automationEventsSince(run, afterSequence) {
  const { events, eventSeq } = normalizeAutomationEvents(run?.events, run?.eventSeq);
  const after = Math.max(0, validSequence(afterSequence));
  const available = events.filter((event) => event.seq > after);
  return {
    eventCursor: eventSeq,
    eventGap: after < eventSeq && (!available.length || available[0].seq > after + 1 || available.at(-1).seq < eventSeq),
    events: available.map(({ seq, time, type }) => ({ seq, time, type })),
  };
}
