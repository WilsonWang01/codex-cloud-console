let active = 0;

// Share a bounded buffer/slow-response budget across personal and external file delivery.
export async function withFileResponse(res, send) {
  if (active >= 2) {
    res.setHeader("Retry-After", "1");
    throw Object.assign(new Error("当前文件下载较多，请稍后重试"), { statusCode: 503, code: "file_delivery_busy" });
  }
  active++;
  let finished;
  const done = new Promise(resolve => { finished = resolve; });
  res.once("finish", finished);
  res.once("close", finished);
  const timer = setTimeout(() => { res.destroy(); finished(); }, 120_000);
  timer.unref();
  try { await send(); if (!res.destroyed) await done; }
  finally {
    clearTimeout(timer);
    res.off("finish", finished);
    res.off("close", finished);
    active--;
  }
}
