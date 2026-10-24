import { Check, Loader2, RefreshCw, ThumbsDown, ThumbsUp } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

type Decision = "helpful" | "not_helpful" | null;
export type PersonalFeedbackEntry = { threadId: string; turnId: string; messageId: string; contentDigest: string; decision: Decision; revision: number };
export type PersonalFeedbackInput = Omit<PersonalFeedbackEntry, "threadId" | "revision"> & { expectedRevision: number };
type FeedbackScope = { sessionId: string };
type FeedbackState = { scope: FeedbackScope | null; threadId: string | null; status: "loading" | "ready" | "unavailable" | "error"; entries: PersonalFeedbackEntry[]; error: string };
const validEntry = (value: PersonalFeedbackEntry) => value && typeof value.threadId === "string" && typeof value.turnId === "string"
  && typeof value.messageId === "string" && /^[a-f0-9]{64}$/.test(value.contentDigest)
  && ["helpful", "not_helpful", null].includes(value.decision) && Number.isSafeInteger(value.revision) && value.revision > 0;

async function feedbackRequest(url: string, options: RequestInit, signal?: AbortSignal) {
  const controller = new AbortController(), cancel = () => controller.abort();
  const timer = setTimeout(cancel, 20_000);
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) controller.abort();
  try {
    const response = await fetch(url, { ...options, cache: "no-store", signal: controller.signal });
    const body = await response.json();
    if (!response.ok) throw Object.assign(new Error(typeof body.error === "string" ? body.error : "评价暂不可用"), { statusCode: response.status, code: body.code });
    if (body.ok !== true || body.version !== 1) throw new Error("评价记录格式无法核对");
    return body;
  } catch (error) {
    if (controller.signal.aborted && !signal?.aborted) throw new Error("评价请求等待已结束，请刷新核对保存结果；未自动重复提交");
    if (error instanceof TypeError || error instanceof SyntaxError) throw new Error("评价请求未能核对，请刷新查看保存结果；未自动重复提交");
    throw error;
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", cancel); }
}

export function usePersonalMessageFeedback(sessionId: string | null, enabled: boolean) {
  const scope = enabled && sessionId ? sessionId : "";
  const current = useRef<FeedbackScope>({ sessionId: scope });
  // Returning to the same session is a new view; old requests cannot own it again.
  if (current.current.sessionId !== scope) current.current = { sessionId: scope };
  const owner = current.current;
  const pending = useRef<FeedbackScope | null>(null);
  const [reload, setReload] = useState(0);
  const [state, setState] = useState<FeedbackState>({ scope: null, threadId: null, status: "unavailable", entries: [], error: "" });
  const [saving, setSaving] = useState<{ scope: FeedbackScope; turnId: string } | null>(null);
  const [saveError, setSaveError] = useState<{ scope: FeedbackScope; turnId: string; message: string } | null>(null);
  const url = `/api/personal/sessions/${encodeURIComponent(scope)}/feedback`;
  useEffect(() => {
    const controller = new AbortController();
    if (!scope) return () => controller.abort();
    setState(previous => ({ scope: owner, threadId: previous.scope === owner ? previous.threadId : null, status: "loading", entries: previous.scope === owner ? previous.entries : [], error: "" }));
    void feedbackRequest(url, {}, controller.signal).then(body => {
      if (controller.signal.aborted || current.current !== owner) return;
      if (typeof body.enabled !== "boolean" || (body.enabled ? typeof body.threadId !== "string" || !body.threadId : body.threadId !== null)
        || !Array.isArray(body.feedback) || body.feedback.length > 1000
        || body.feedback.some((entry: PersonalFeedbackEntry) => !validEntry(entry) || entry.threadId !== body.threadId)
        || new Set(body.feedback.map((entry: PersonalFeedbackEntry) => entry.turnId)).size !== body.feedback.length) throw new Error("评价记录格式无法核对");
      setState(previous => {
        const merged = new Map<string, PersonalFeedbackEntry>(body.feedback.map((entry: PersonalFeedbackEntry) => [entry.turnId, entry]));
        if (previous.scope === owner && previous.threadId === body.threadId) for (const entry of previous.entries) {
          if ((merged.get(entry.turnId)?.revision || 0) < entry.revision) merged.set(entry.turnId, entry);
        }
        return { scope: owner, threadId: body.threadId, status: body.enabled ? "ready" : "unavailable", entries: [...merged.values()], error: "" };
      });
    }).catch(cause => {
      if (controller.signal.aborted || current.current !== owner) return;
      const unsupported = cause.statusCode === 404 && !cause.code;
      setState(previous => ({ scope: owner, threadId: previous.scope === owner ? previous.threadId : null, status: unsupported ? "unavailable" : "error", entries: previous.scope === owner ? previous.entries : [], error: unsupported ? "" : cause.message || "评价读取失败" }));
    });
    return () => controller.abort();
  }, [scope, owner, url, reload]);
  const save = useCallback(async (input: PersonalFeedbackInput) => {
    if (!scope || current.current !== owner || pending.current === owner || state.scope !== owner || !state.threadId || state.status !== "ready") return;
    pending.current = owner; setSaving({ scope: owner, turnId: input.turnId }); setSaveError(null);
    try {
      const body = await feedbackRequest(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
      const entry = body.feedback as PersonalFeedbackEntry;
      if (!validEntry(entry) || entry.threadId !== state.threadId || entry.turnId !== input.turnId || entry.messageId !== input.messageId || entry.contentDigest !== input.contentDigest || entry.decision !== input.decision) {
        throw new Error("保存回执无法核对，请刷新评价状态；未自动重复提交");
      }
      if (current.current !== owner) return;
      setState(previous => previous.scope !== owner || previous.threadId !== entry.threadId || previous.entries.some(item => item.turnId === entry.turnId && item.revision > entry.revision)
        ? previous : { ...previous, entries: [...previous.entries.filter(item => item.turnId !== entry.turnId), entry] });
    } catch (cause) {
      if (current.current !== owner) return;
      setSaveError({ scope: owner, turnId: input.turnId, message: cause instanceof Error ? cause.message : "评价保存失败" });
      if ((cause as { statusCode?: number }).statusCode === 409) setReload(value => value + 1);
    } finally {
      if (pending.current === owner) pending.current = null;
      if (current.current === owner) setSaving(null);
    }
  }, [scope, owner, url, state.scope, state.threadId, state.status]);
  return { status: state.scope === owner ? state.status : "loading", entries: state.scope === owner ? state.entries : [],
    error: state.scope === owner ? state.error : "", saveError: saveError?.scope === owner ? saveError : null,
    saving: saving?.scope === owner ? saving.turnId : null, save, retry: () => setReload(value => value + 1) };
}

export function PersonalFeedbackReadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <div className="personal-feedback-error" role="alert"><span>{message}</span><button type="button" className="icon-command" title="重试读取评价" aria-label="重试读取评价" onClick={onRetry}><RefreshCw size={15} /></button></div>;
}

export function PersonalMessageFeedback({ message, entry, disabled, saving, error, onSave }: {
  message: { id: string; turnId: string; text: string }; entry?: PersonalFeedbackEntry; disabled: boolean; saving: boolean; error?: string;
  onSave: (input: PersonalFeedbackInput) => Promise<void>;
}) {
  const [content, setContent] = useState({ text: "", digest: "", error: "" });
  useEffect(() => {
    let canceled = false;
    void (async () => {
      try {
        const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(message.text));
        const digest = [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
        if (!canceled) setContent({ text: message.text, digest, error: "" });
      } catch { if (!canceled) setContent({ text: message.text, digest: "", error: "当前浏览器无法核对回复内容，暂不能评价" }); }
    })();
    return () => { canceled = true; };
  }, [message.text]);
  const digest = content.text === message.text ? content.digest : "";
  const selected = entry?.messageId === message.id && entry.contentDigest === digest ? entry.decision : null;
  const choose = (decision: Exclude<Decision, null>) => onSave({ turnId: message.turnId, messageId: message.id, contentDigest: digest, decision: selected === decision ? null : decision, expectedRevision: entry?.revision || 0 });
  return <div className="personal-message-feedback" aria-label="回复评价" aria-busy={saving}>
    <button type="button" className="icon-command" disabled={disabled || saving || !digest} aria-label="有帮助" title={selected === "helpful" ? "撤销有帮助评价" : "有帮助"} aria-pressed={selected === "helpful"} onClick={() => void choose("helpful")}><ThumbsUp size={15} /></button>
    <button type="button" className="icon-command" disabled={disabled || saving || !digest} aria-label="没有帮助" title={selected === "not_helpful" ? "撤销没有帮助评价" : "没有帮助"} aria-pressed={selected === "not_helpful"} onClick={() => void choose("not_helpful")}><ThumbsDown size={15} /></button>
    <span className="personal-feedback-status" aria-live="polite">{saving ? <Loader2 size={14} className="spin" aria-label="正在保存评价" /> : selected ? <Check size={14} aria-label="评价已保存" /> : null}</span>
    {(error || content.error) && <span className="warn-text" role="alert">{error || content.error}</span>}
  </div>;
}
