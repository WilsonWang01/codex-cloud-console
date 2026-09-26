import { CalendarDays, FileText, Globe2, Link2, Mail } from "lucide-react";
import { useEffect, useState } from "react";

const tasks = [
  { icon: Globe2, title: "调研一个问题", prompt: "帮我调研这个问题，核对最新资料，给出结论和来源：", hint: "公开资料" },
  { icon: Mail, title: "整理邮件待办", prompt: "整理最近三天的重要邮件，列出待回复事项并起草回复。先检查邮箱连接；不要代我发送邮件。", hint: "需要邮箱连接" },
  { icon: CalendarDays, title: "安排我的一天", prompt: "帮我安排今天的优先事项。如果日历已连接，先核对已有安排；否则先问我的时间和待办。修改日历前先和我确认。", hint: "日历可选" },
  { icon: FileText, title: "整理一份文档", prompt: "帮我把以下材料整理成清晰的摘要和行动清单：", hint: "可上传材料或连接文档服务" },
];

function taskHint(title: string, fallback: string, connected: { mail: boolean | null; calendar: boolean | null } | null) {
  if (title === "整理邮件待办") return connected?.mail === true ? "邮箱已可调用" : connected?.mail === false ? "需要邮箱连接" : "检查邮箱连接";
  if (title === "安排我的一天") return connected?.calendar === true ? "日历已可调用" : connected?.calendar === false ? "日历未连接，可先规划" : "日历状态待确认，可先规划";
  return fallback;
}

export default function PersonalAssistantGuide({ onChoose, onConnect }: { onChoose: (prompt: string) => void; onConnect: () => void }) {
  const [connected, setConnected] = useState<{ mail: boolean | null; calendar: boolean | null } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/codex/apps?repoId=_personal", { signal: controller.signal }).then((response) => response.json()).then((data: { runtimeVerified?: boolean; directoryError?: string; apps?: Array<{ name: string; callable: boolean | null }> }) => {
      if (!controller.signal.aborted && data.runtimeVerified && Array.isArray(data.apps)) {
        const serviceStatus = (pattern: RegExp) => {
          const matches = data.apps?.filter((app) => pattern.test(app.name)) || [];
          if (matches.some((app) => app.callable === true)) return true;
          return matches.length || !data.directoryError ? false : null;
        };
        setConnected({ mail: serviceStatus(/gmail|outlook|mail/i), calendar: serviceStatus(/calendar|日历/i) });
      }
    }).catch(() => null);
    return () => controller.abort();
  }, []);
  return <section className="personal-guide" aria-label="个人助理任务建议">
    <h3>今天想处理什么？</h3>
    <div className="personal-task-list">
      {tasks.map(({ icon: Icon, title, prompt, hint }) => <div className="personal-task-choice" key={title}>
        <button className="personal-task-primary" type="button" onClick={() => onChoose(prompt)}>
          <Icon size={18} /><span><strong>{title}</strong><small>{taskHint(title, hint, connected)}</small></span>
        </button>
        {((title === "整理邮件待办" && connected?.mail !== true) || (title === "安排我的一天" && connected?.calendar === false)) && <button className="personal-task-connect" type="button" onClick={onConnect} title={title === "整理邮件待办" ? "连接邮箱" : "连接日历"} aria-label={title === "整理邮件待办" ? "连接邮箱" : "连接日历"}><Link2 size={17} /></button>}
      </div>)}
    </div>
  </section>;
}
