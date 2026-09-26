export function appAuthorizationUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "chatgpt.com" && !url.port && !url.username && !url.password && url.pathname.startsWith("/apps/")
      ? url.href : null;
  } catch { return null; }
}

export async function readConnectedApps(request, { refresh = false } = {}) {
  const apps = new Map();
  const cursors = new Set();
  let cursor = null;
  let directoryError = "";
  do {
    const response = await request("app/list", { cursor, limit: 100, forceRefetch: refresh && !cursor });
    if (!response.ok) {
      directoryError = /\b403\b|forbidden/i.test(response.error || "")
        ? "上游拒绝了云端服务目录请求（403）。这不代表 Codex 登录失效；可前往官方服务目录管理授权，但授权不保证解除该访问限制。"
        : "云端服务目录暂不可用，请稍后刷新或前往官方服务目录。";
      break;
    }
    for (const app of response.result?.data || []) {
      if (typeof app.id !== "string" || !app.id || typeof app.name !== "string") continue;
      apps.set(app.id, {
        id: app.id, name: app.name, description: String(app.description || ""),
        installUrl: appAuthorizationUrl(app.installUrl),
        accessible: app.isAccessible === true, enabled: app.isEnabled === true,
      });
    }
    cursor = response.result?.nextCursor || null;
    if (cursor && (cursors.has(cursor) || cursors.size >= 20)) throw new Error("服务目录分页未完成，请稍后重试");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  const installed = await request("app/installed", { forceRefresh: refresh });
  const states = new Map((installed.result?.apps || []).map((app) => [app.id, app]));
  for (const app of installed.ok ? installed.result?.apps || [] : []) {
    if (!apps.has(app.id)) apps.set(app.id, { id: app.id, name: app.runtimeName || app.id, description: "", installUrl: null, accessible: true, enabled: app.enabled === true });
  }
  return {
    apps: [...apps.values()].map((app) => ({
      ...app,
      callable: installed.ok ? states.get(app.id)?.callable === true && states.get(app.id)?.enabled === true : null,
    })),
    runtimeVerified: installed.ok === true,
    directoryError,
  };
}
