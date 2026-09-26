const maxAttempts = 5;

export function pendingNotificationChannels(channels, delivery, now = Date.now()) {
  const previous = new Map((delivery?.channels || []).map((result) => [result.channelId, result]));
  if (!previous.size && delivery?.ok && delivery.channelId) {
    previous.set(delivery.channelId, { channelId: delivery.channelId, ok: true });
  }
  return channels.filter((channel) => {
    const result = previous.get(channel.id);
    if (!result) return true;
    if (result.ok || Number(result.attempts || 0) >= maxAttempts) return false;
    const nextAttempt = Date.parse(result.nextAttemptAt || "");
    return !Number.isFinite(nextAttempt) || nextAttempt <= now;
  });
}

export function notificationAttempt(previous, result, now = Date.now()) {
  const attempts = Math.min(maxAttempts, Number(previous?.attempts || 0) + 1);
  return {
    ok: Boolean(result.ok),
    status: result.status || null,
    error: result.ok ? null : String(result.error || "Delivery failed").slice(0, 360),
    attempts,
    lastAttemptAt: new Date(now).toISOString(),
    nextAttemptAt: result.ok || attempts >= maxAttempts
      ? null
      : new Date(now + Math.min(60 * 60_000, 60_000 * 2 ** (attempts - 1))).toISOString(),
  };
}
