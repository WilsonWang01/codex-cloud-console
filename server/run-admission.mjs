function limit(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function createRunAdmission({ maxGlobal = 2, maxPerClient = 1 } = {}) {
  const globalLimit = limit(maxGlobal, 2);
  const clientLimit = limit(maxPerClient, 1);
  const active = new Map();
  let total = 0;

  return {
    reserve(clientId = "console") {
      const key = String(clientId || "console");
      if (total >= globalLimit || (active.get(key) || 0) >= clientLimit) {
        throw Object.assign(new Error("Automation concurrency limit reached; retry after a running task finishes"), {
          statusCode: 429,
          retryAfterMs: 30_000,
        });
      }
      total += 1;
      active.set(key, (active.get(key) || 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        total -= 1;
        const remaining = (active.get(key) || 1) - 1;
        if (remaining) active.set(key, remaining);
        else active.delete(key);
      };
    },
    status() { return { active: total, maxGlobal: globalLimit, maxPerClient: clientLimit }; },
  };
}
