import { Check, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

type BriefItem = { id: string; kind: string; title: string; detail: string; time: string; sessionId: string | null };
type Brief = { until: string; reviewedAt: string | null; items: BriefItem[]; total: number };

export default function PersonalBrief({ refreshKey, onContinue }: { refreshKey: string; onContinue: (sessionId: string) => void }) {
  const [brief, setBrief] = useState<Brief | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/personal/brief", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const body = await response.json() as { brief?: Brief; error?: string };
        if (!response.ok || !body.brief) throw new Error(body.error || "读取变化失败");
        return body.brief;
      })
      .then((value) => { if (!controller.signal.aborted) { setBrief(value); setError(""); } })
      .catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "读取变化失败"); });
    return () => controller.abort();
  }, [refreshKey, reload]);
  const review = async () => {
    if (!brief || busy) return;
    setBusy(true);
    try {
      const response = await fetch("/api/personal/brief/review", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ through: brief.until }) });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || "标记失败");
      setBrief({ ...brief, reviewedAt: brief.until, items: [], total: 0 });
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "标记失败"); }
    finally { setBusy(false); }
  };
  if (!brief && !error) return <section className="personal-list-section" aria-label="新变化"><p className="personal-empty" role="status">正在读取变化…</p></section>;
  return <section className="personal-list-section personal-brief" aria-label="新变化">
    <div className="personal-section-heading"><h2>新变化 {brief && brief.total > 0 && <small>{brief.total}</small>}</h2><div className="personal-section-actions"><button type="button" title="刷新变化" aria-label="刷新变化" onClick={() => setReload((value) => value + 1)}><RefreshCw size={16} /></button>{brief && brief.total > 0 && <button type="button" className="mini-action" disabled={busy} onClick={() => void review()}><Check size={16} />全部标记已查看</button>}</div></div>
    <p className="personal-brief-source">关注事项与个人定时任务的记录变化；不包含尚未读取的邮件或日历。</p>
    {error && <p role="alert" className="warn-text">{error}</p>}
    {brief?.items.map((item) => <div className="personal-brief-row" key={item.id}>
      <span><strong>{item.title}</strong><small>{item.detail} · {new Date(item.time).toLocaleString()}</small></span>
      {item.sessionId && <button type="button" className="mini-action" onClick={() => onContinue(item.sessionId!)}>查看</button>}
    </div>)}
    {brief && brief.total === 0 && <p className="personal-empty">{brief.reviewedAt ? "上次查看后暂无新变化。" : "最近 24 小时暂无变化。"}</p>}
    {brief && brief.total > brief.items.length && <p className="personal-empty">显示最近 {brief.items.length} 条，共 {brief.total} 条；全部标记已查看也会清除未展示的变化。</p>}
  </section>;
}
