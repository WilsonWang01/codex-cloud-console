import { Download, FileText, FolderOpen, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

type PersonalFile = { path: string; name: string; kind: "input" | "output"; size: number; updatedAt: string; previewable: boolean; mimeType: string };

function fileUrl(file: PersonalFile, preview = false) {
  const params = new URLSearchParams({ path: file.path });
  if (preview) params.set("preview", "1");
  return `/api/personal/files/content?${params}`;
}

function fileSize(value: number) {
  return value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${Math.round(value / 1024)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export default function PersonalFiles({ initialPath = "", onContinue }: { initialPath?: string; onContinue: (file: PersonalFile) => void }) {
  const [files, setFiles] = useState<PersonalFile[]>([]);
  const [selectedPath, setSelectedPath] = useState(initialPath);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const controllerRef = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/personal/files", { signal: controller.signal, cache: "no-store" });
      const result = await response.json() as { ok: boolean; files?: PersonalFile[]; error?: string };
      if (!response.ok || !result.ok) throw new Error(result.error || "读取个人文件失败");
      if (!controller.signal.aborted) {
        setFiles(result.files || []);
        setSelectedPath((current) => result.files?.some((file) => file.path === current) ? current : "");
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "读取个人文件失败");
    } finally { if (!controller.signal.aborted) setLoading(false); }
  }, []);
  useEffect(() => { void load(); return () => controllerRef.current?.abort(); }, [load]);
  const selected = files.find((file) => file.path === selectedPath);
  const deleteSelected = async () => {
    if (!selected || selected.kind !== "input" || deleting || !window.confirm(`删除「${selected.name}」的个人上传副本？这不会删除你设备上的原文件。`)) return;
    setDeleting(true);
    setError("");
    try {
      const response = await fetch(`/api/personal/files?path=${encodeURIComponent(selected.path)}`, { method: "DELETE" });
      const result = await response.json() as { ok: boolean; error?: string };
      if (!response.ok || !result.ok) throw new Error(result.error || "删除失败");
      setSelectedPath("");
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "删除失败"); }
    finally { setDeleting(false); }
  };
  const outputs = files.filter((file) => file.kind === "output");
  const inputs = files.filter((file) => file.kind === "input");
  return <div className="personal-page personal-files">
    <header className="personal-page-header"><div><p className="eyebrow">个人助理</p><h1>资料</h1></div><button type="button" className="command-button" onClick={() => void load()} disabled={loading}>{loading ? <Loader2 size={17} className="spin" /> : <RefreshCw size={17} />}刷新</button></header>
    {error && <p className="personal-state-warning" role="alert">{error}</p>}
    {loading && <p role="status">正在读取个人空间文件…</p>}
    <section className="personal-list-section"><h2>助理生成的文件</h2>{outputs.length ? outputs.map((file) => <button type="button" className="personal-task-row" key={file.path} onClick={() => setSelectedPath(file.path)}><FileText size={17} /><span><strong>{file.name}</strong><small>{fileSize(file.size)} · {new Date(file.updatedAt).toLocaleString()}</small></span></button>) : !loading && <p className="personal-empty">还没有生成文件。让助理在个人工作区写入结果后，可在这里查看。</p>}</section>
    <section className="personal-list-section"><h2>你提供的材料</h2>{inputs.length ? inputs.map((file) => <button type="button" className="personal-task-row" key={file.path} onClick={() => setSelectedPath(file.path)}><FolderOpen size={17} /><span><strong>{file.name}</strong><small>{fileSize(file.size)} · {new Date(file.updatedAt).toLocaleString()}</small></span></button>) : !loading && <p className="personal-empty">可在个人对话中上传图片、文档或其他文件。</p>}</section>
    {selected && <section className="personal-file-preview" aria-label="文件详情"><div className="personal-file-preview-head"><div><h2>{selected.name}</h2><small>{selected.path} · {fileSize(selected.size)}</small></div><button type="button" className="mini-action" onClick={() => setSelectedPath("")}>关闭预览</button></div><div className="personal-file-actions"><a href={fileUrl(selected)} download={selected.name}><Download size={16} />下载</a><button type="button" onClick={() => onContinue(selected)}>{selected.kind === "output" ? "继续修改" : "在对话中分析"}</button>{selected.kind === "input" && <button type="button" onClick={() => void deleteSelected()} disabled={deleting}><Trash2 size={16} />{deleting ? "正在删除…" : "删除上传副本"}</button>}</div>{selected.previewable && selected.mimeType.startsWith("image/") ? <img src={fileUrl(selected, true)} alt={selected.name} /> : selected.previewable ? <iframe src={fileUrl(selected, true)} title={`${selected.name} 预览`} sandbox="" /> : <p>此文件不支持网页预览，可下载查看。</p>}</section>}
  </div>;
}
