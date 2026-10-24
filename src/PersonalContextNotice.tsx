import { ChevronRight, RefreshCw, TriangleAlert } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

type Context = { issue: string | null; providedAt: string | null; providedCount: number | null; activeCount: number };

export default function PersonalContextNotice({ sessionId, disabled, onContinue }: {
  sessionId: string; disabled: boolean; onContinue: (pendingId: string) => Promise<boolean>;
}) {
  const [context, setContext] = useState<Context | null>(null);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const pendingId = useRef("");
  const confirmation = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = confirmation.current;
    if (!context?.issue && !error) { if (confirming) setConfirming(false); return; }
    if (!dialog) return;
    if (confirming) { if (!dialog.open) dialog.showModal(); }
    else if (dialog.open) dialog.close();
  }, [confirming, context?.issue, error]);
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
  const continueContext = () => {
    if (disabled || busy || !context?.issue) return;
    pendingId.current ||= crypto.randomUUID();
    setConfirming(false);
    setBusy(true);
    void onContinue(pendingId.current).finally(() => setBusy(false));
  };
  return <><div className="external-review-banner personal-context-notice" role="alert">
    <TriangleAlert size={18} aria-hidden="true" /><span><button type="button" className="personal-context-details" aria-label="查看个人资料核对原因" title="查看核对原因与保留范围" onClick={() => setConfirming(true)}><strong>个人资料需要核对</strong><ChevronRight size={14} aria-hidden="true" /></button></span>
    {context?.issue ? <button type="button" className="mini-action" disabled={disabled || busy} onClick={() => setConfirming(true)}><RefreshCw size={16} />{busy ? "处理中…" : "开启新上下文"}</button>
      : <button type="button" className="mini-action" aria-label="重新核对个人资料" title="重新核对个人资料" onClick={() => setRefresh((value) => value + 1)}><RefreshCw size={16} /></button>}
  </div><dialog ref={confirmation} className="personal-context-dialog" aria-labelledby={titleId} onClose={() => setConfirming(false)} onCancel={() => setConfirming(false)}>
    <h3 id={titleId}>{context?.issue ? "开启新上下文？" : "资料核对未完成"}</h3>
    <p>{context?.issue || error}</p>
    <p>原会话和历史会保留，已开始的任务可能保留旧内容。新上下文只复制未发送草稿、附件及模型设置，不复制旧聊天内容，也不会自动运行任务。</p>
    <div><button type="button" className="mini-action" autoFocus onClick={() => setConfirming(false)}>{context?.issue ? "取消" : "关闭"}</button>{context?.issue && <button type="button" className="primary-command" disabled={disabled || busy} onClick={continueContext}><RefreshCw size={16} />确认开启</button>}</div>
  </dialog></>;
}
