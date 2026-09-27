import { useEffect, useState } from "react";

type Settings = { enabled: boolean; timeZone: string; quietStart: string; quietEnd: string };

export default function PersonalReminders({ endpoint }: { endpoint: string | null }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setSettings(null);
    setSaved(false);
    if (!endpoint) { setSettings(null); setError(""); return; }
    const controller = new AbortController();
    void fetch("/api/personal/reminders/status", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint }), signal: controller.signal })
      .then(async (response) => {
        const body = await response.json() as { settings?: Settings; error?: string };
        if (!response.ok || !body.settings) throw new Error(body.error || "读取提醒设置失败");
        return body.settings;
      })
      .then((value) => { if (!controller.signal.aborted) { setSettings(value); setError(""); } })
      .catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "读取提醒设置失败"); });
    return () => controller.abort();
  }, [endpoint]);
  const save = async () => {
    if (!endpoint || !settings || busy) return;
    setBusy(true); setSaved(false);
    try {
      const response = await fetch("/api/personal/reminders", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint, settings }) });
      const body = await response.json() as { settings?: Settings; error?: string };
      if (!response.ok || !body.settings) throw new Error(body.error || "保存提醒设置失败");
      setSettings(body.settings); setError(""); setSaved(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "保存提醒设置失败"); }
    finally { setBusy(false); }
  };
  if (!endpoint) return <p>订阅本机浏览器通知后，可单独开启个人事项的到期提醒；默认关闭。</p>;
  if (!settings) return <p role={error ? "alert" : "status"}>{error || "正在读取个人提醒设置…"}</p>;
  return <div className="personal-reminder-settings">
    <label className="personal-reminder-toggle"><input type="checkbox" checked={settings.enabled} onChange={(event) => { setSettings({ ...settings, enabled: event.target.checked }); setSaved(false); }} />到期时在本机浏览器提醒我</label>
    <div className="personal-reminder-times"><label>安静时段开始<input aria-label="安静时段开始" type="time" value={settings.quietStart} onChange={(event) => { setSettings({ ...settings, quietStart: event.target.value }); setSaved(false); }} /></label><label>安静时段结束<input aria-label="安静时段结束" type="time" value={settings.quietEnd} onChange={(event) => { setSettings({ ...settings, quietEnd: event.target.value }); setSaved(false); }} /></label></div>
    <div className="personal-reminder-foot"><span>时区：{settings.timeZone}</span><button type="button" className="mini-action" onClick={() => { setSettings({ ...settings, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" }); setSaved(false); }}>使用本机时区</button></div>
    <p>安静时段结束后补发最近 24 小时内到期的事项；按到期时间去重，网络失败重试仍可能重复。仅发送到已开启此项的浏览器，不转发工作通知渠道。</p>
    {error && <p role="alert" className="warn-text">{error}</p>}
    {saved && <p role="status">提醒设置已保存。</p>}
    <button type="button" className="mini-action" disabled={busy} onClick={() => void save()}>{busy ? "保存中…" : "保存提醒设置"}</button>
  </div>;
}
