export async function waitForConsoleReady({ child, baseUrl, logs, timeoutMs = 15000 }) {
  const start = performance.now(), deadline = start + timeoutMs;
  let spawnError;
  const onError = error => { spawnError = error; };
  child.once("error", onError);
  try {
    while (performance.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode) throw new Error(`临时控制台已退出：${logs().slice(-4000)}`);
      try {
        const response = await fetch(new URL("/api/release", baseUrl), { redirect: "error", signal: AbortSignal.timeout(Math.max(1, Math.min(500, Math.ceil(deadline - performance.now())))) });
        const body = await response.json();
        if (logs().includes("listening on") && response.status === 200 && body.ok === true && body.release?.schemaVersion === 1) return performance.now() - start;
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error(`临时控制台未在 ${timeoutMs} 毫秒内通过就绪检查：${logs().slice(-4000)}`);
  } finally { child.removeListener("error", onError); }
}
