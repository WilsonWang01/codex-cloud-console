type Snapshot = { expiresAt: string; window: { date: string; timeZone: string } };

export function personalSourceFresh(snapshot: Snapshot | null | undefined, timeZone: string, now = Date.now()) {
  if (!snapshot || !Number.isFinite(now) || snapshot.window.timeZone !== timeZone || !(Date.parse(snapshot.expiresAt) > now)) return false;
  try {
    return snapshot.window.date === new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch { return false; }
}
