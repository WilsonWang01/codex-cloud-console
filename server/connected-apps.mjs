export function appAuthorizationUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "chatgpt.com" && !url.port && !url.username && !url.password && url.pathname.startsWith("/apps/")
      ? url.href : null;
  } catch { return null; }
}

async function read(request, method, params, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      request(method, params, timeoutMs),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), timeoutMs); }),
    ]);
  } catch { return { ok: false }; }
  finally { clearTimeout(timer); }
}

export async function readConnectedApps(request, { refresh = false, directoryTimeoutMs = 8_000 } = {}) {
  // Installed runtime state remains useful even when the public directory is incomplete.
  const installed = await read(request, "app/installed", { forceRefresh: refresh }, 20_000);
  const runtimeVerified = installed?.ok === true && Array.isArray(installed.result?.apps)
    && installed.result.apps.every((app) => typeof app?.id === "string" && app.id
      && typeof app.enabled === "boolean" && typeof app.callable === "boolean");
  const states = new Map((runtimeVerified ? installed.result.apps : []).map((app) => [app.id, app]));
  const apps = new Map();
  const cursors = new Set();
  let cursor = null;
  let directoryError = "";
  const until = Date.now() + directoryTimeoutMs;
  let pages = 0;
  do {
    if (Date.now() >= until) {
      directoryError = "服务目录读取超时，仅展示已取得的目录和已安装工具状态。";
      break;
    }
    const response = await read(request, "app/list", { cursor, limit: 100, forceRefetch: refresh && !cursor }, until - Date.now());
    if (!response?.ok) {
      directoryError = /\b403\b|forbidden/i.test(response?.error || "")
        ? "上游拒绝了云端服务目录请求（403）。这不代表 Codex 登录失效；可前往官方服务目录管理授权，但授权不保证解除该访问限制。"
        : "云端服务目录暂不可用，请稍后刷新或前往官方服务目录。";
      break;
    }
    if (!Array.isArray(response.result?.data) || response.result.data.length > 100
      || (response.result.nextCursor != null && typeof response.result.nextCursor !== "string")) {
      directoryError = "服务目录返回格式异常，仅展示已取得的目录和已安装工具状态。";
      break;
    }
    pages += 1;
    for (const app of response.result.data) {
      if (typeof app?.id !== "string" || !app.id || typeof app.name !== "string") continue;
      apps.set(app.id, {
        id: app.id, name: app.name, description: String(app.description || ""),
        installUrl: appAuthorizationUrl(app.installUrl),
        accessible: app.isAccessible === true, enabled: app.isEnabled === true,
      });
    }
    cursor = response.result?.nextCursor || null;
    if (cursor && (cursors.has(cursor) || pages >= 20)) {
      directoryError = "服务目录分页未完成，仅展示已取得的目录和已安装工具状态。";
      break;
    }
    if (cursor) cursors.add(cursor);
  } while (cursor);
  for (const app of states.values()) {
    if (!apps.has(app.id)) apps.set(app.id, { id: app.id, name: typeof app.runtimeName === "string" && app.runtimeName ? app.runtimeName : app.id, description: "", installUrl: null, accessible: true, enabled: app.enabled === true });
  }
  return {
    apps: [...apps.values()].map((app) => ({
      ...app,
      enabled: states.get(app.id)?.enabled ?? app.enabled,
      callable: runtimeVerified ? states.get(app.id)?.callable === true && states.get(app.id)?.enabled === true : null,
    })),
    runtimeVerified,
    directoryError,
  };
}
