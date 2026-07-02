function safeNotificationUrl(value) {
  try {
    const fallback = new URL("/#/inbox", self.location.origin);
    const target = new URL(String(value || fallback.href), self.location.origin);
    if (target.origin !== self.location.origin) return fallback.href;
    if (target.pathname.startsWith("/api/") || target.pathname.startsWith("/api")) return fallback.href;
    const path = target.pathname || "/";
    const hash = target.hash || "#/inbox";
    return `${self.location.origin}${path}${target.search || ""}${hash}`;
  } catch {
    return `${self.location.origin}/#/inbox`;
  }
}

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "Codex Cloud";
  const targetUrl = safeNotificationUrl(data.url);
  const options = {
    body: data.body || "云端 Codex 有新的待处理事件",
    icon: "/codex-cloud.svg",
    badge: "/codex-cloud.svg",
    tag: data.tag || "codex-cloud-attention",
    renotify: true,
    data: {
      url: targetUrl,
    },
    actions: [
      { action: "open", title: "打开" },
      { action: "dismiss", title: "稍后处理" },
    ],
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  if (event.action === "dismiss") return;
  const targetUrl = safeNotificationUrl(event.notification.data?.url);
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        const clientUrl = new URL(client.url);
        const target = new URL(targetUrl);
        if (clientUrl.origin === target.origin && "focus" in client) {
          return client.focus().then(() => client.navigate(targetUrl));
        }
      }
      return clients.openWindow(targetUrl);
    }),
  );
});
