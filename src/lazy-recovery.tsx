import { createContext, lazy, useContext, useState, type ComponentType } from "react";
import { RefreshCw, TriangleAlert } from "lucide-react";

export const PageReloadContext = createContext<(() => void) | null>(null);

function ModuleLoadFailure() {
  const reload = useContext(PageReloadContext);
  const [error, setError] = useState("");
  return <div className="module-load-failure" role="alert">
    <TriangleAlert size={18} aria-hidden="true" />
    <div><strong>这部分内容暂时无法加载</strong><p>可能是网络暂时异常，或页面资源已随服务更新。</p>
      {reload && <button type="button" className="mini-action" onClick={() => {
        try { setError(""); reload(); }
        catch (cause) { setError(cause instanceof Error ? cause.message : "未能安全保留输入，已取消重新加载"); }
      }}><RefreshCw size={16} />重新加载页面</button>}
      {error && <p>{error}</p>}
    </div>
  </div>;
}

export function recoverableLazy<P>(load: () => Promise<{ default: ComponentType<P> }>) {
  return lazy(async (): Promise<{ default: ComponentType<P> }> => {
    try { return await load(); }
    catch (cause) {
      console.error("页面模块载入失败", cause);
      return { default: ModuleLoadFailure };
    }
  });
}
