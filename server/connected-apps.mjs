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
  do {
    const response = await request("app/list", { cursor, limit: 100, forceRefetch: refresh && !cursor });
    if (!response.ok) throw new Error(response.error || "服务目录暂不可用");
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
  return {
    apps: [...apps.values()].map((app) => ({
      ...app,
      callable: installed.ok ? states.get(app.id)?.callable === true && states.get(app.id)?.enabled === true : null,
    })),
    runtimeVerified: installed.ok === true,
  };
}
