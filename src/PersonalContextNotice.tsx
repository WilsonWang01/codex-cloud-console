import { RefreshCw, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";

type Context = { issue: string | null; providedAt: string | null; providedCount: number | null; activeCount: number };

export default function PersonalContextNotice({ sessionId, disabled, onContinue }: {
  sessionId: string; disabled: boolean; onContinue: (pendingId: string) => Promise<boolean>;
}) {
  const [context, setContext] = useState<Context | null>(null);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const pendingId = useRef("");
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/chat/sessions/${encodeURIComponent(sessionId)}/personal-context?repoId=_personal`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (response.status === 404) return null;
        const data = await response.json();
        if (!response.ok || data.ok !== true || !(data.issue === null || typeof data.issue === "string")) throw new Error(data.error || "个人资料范围未能核对");
        return data as Context;
      }).then((data) => { if (!controller.signal.aborted) { setContext(data); setError(""); } })
      .catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "核对失败"); });
    const recheck = () => setRefresh((value) => value + 1);
    const timer = window.setInterval(recheck, 30_000);
    window.addEventListener("focus", recheck);
    return () => { controller.abort(); window.clearInterval(timer); window.removeEventListener("focus", recheck); };
  }, [sessionId, refresh]);
  if (!context?.issue && !error) return null;
  return <div className="external-review-banner personal-context-notice" role="alert">
    <TriangleAlert size={18} aria-hidden="true" /><span><strong>个人资料需要核对</strong><small>{context?.issue || error}</small>
      <small>已开始的任务和旧历史可能保留旧内容；新上下文只复制未发送草稿、附件与当前模型设置，不自动发送。</small></span>
    {context?.issue ? <button type="button" className="mini-action" disabled={disabled || busy} onClick={() => {
      if (!window.confirm("开启不含旧聊天历史的新上下文？原会话保留，只复制未发送草稿、附件和模型设置，不会自动运行。")) return;
      pendingId.current ||= crypto.randomUUID();
      setBusy(true);
      void onContinue(pendingId.current).finally(() => setBusy(false));
    }}>{busy ? "处理中…" : "开启新上下文"}</button>
      : <button type="button" className="mini-action" aria-label="重新核对个人资料" title="重新核对个人资料" onClick={() => setRefresh((value) => value + 1)}><RefreshCw size={16} /></button>}
  </div>;
}
