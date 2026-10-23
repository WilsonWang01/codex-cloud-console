export function recordDuration(histogram, value) {
  if (Number.isSafeInteger(value) && value >= 0) histogram.set(value, (histogram.get(value) || 0) + 1);
}

export function summarizeDurations(histogram) {
  const entries = [...histogram].sort((a, b) => a[0] - b[0]);
  const samples = entries.reduce((sum, [, count]) => sum + count, 0);
  const percentile = fraction => {
    if (!samples) return null;
    const rank = Math.ceil(samples * fraction);
    let seen = 0;
    for (const [value, count] of entries) { seen += count; if (seen >= rank) return value; }
  };
  return { samples, p50Ms: percentile(0.5), p95Ms: percentile(0.95) };
}

export function requestErrorType(status) {
  if (status < 400) return null;
  if ([401, 403].includes(status)) return "authorization";
  if (status === 429) return "rate_limited";
  if ([408, 499, 504].includes(status)) return "wait_ended";
  if (status === 409) return "conflict";
  if ([404, 410].includes(status)) return "unavailable_object";
  return status < 500 ? "input_rejected" : "service_error";
}
