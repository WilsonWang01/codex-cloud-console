import { CalendarDays, FileText, Globe2, Mail } from "lucide-react";

const tasks = [
  { icon: Globe2, title: "调研一个问题", prompt: "帮我调研这个问题，核对最新资料，给出结论和来源：", hint: "公开资料" },
  { icon: Mail, title: "整理邮件待办", prompt: "整理最近三天的重要邮件，列出待回复事项并起草回复。先检查邮箱连接；不要代我发送邮件。", hint: "需要邮箱连接" },
  { icon: CalendarDays, title: "安排我的一天", prompt: "帮我安排今天的优先事项。如果日历已连接，先核对已有安排；否则先问我的时间和待办。修改日历前先和我确认。", hint: "日历可选" },
  { icon: FileText, title: "整理一份文档", prompt: "帮我把以下材料整理成清晰的摘要和行动清单：", hint: "粘贴材料或连接文档服务" },
];

export default function PersonalAssistantGuide({ onChoose }: { onChoose: (prompt: string) => void }) {
  return <section className="personal-guide" aria-label="个人助理任务建议">
    <h3>今天想处理什么？</h3>
    <div className="personal-task-list">
      {tasks.map(({ icon: Icon, title, prompt, hint }) => <button key={title} type="button" onClick={() => onChoose(prompt)}>
        <Icon size={18} /><span><strong>{title}</strong><small>{hint}</small></span>
      </button>)}
    </div>
  </section>;
}
