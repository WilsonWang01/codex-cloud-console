type Reference = { id: string; revision: number; state: string; label?: string };
export type PersonalFactReferenceData = { source: string; recordedAt: string; checkedAt: string; turnId: string; references: Reference[] };

export function personalFactReferenceData(value: unknown): PersonalFactReferenceData | null {
  if (!value || typeof value !== "object") return null;
  const record = value as PersonalFactReferenceData;
  return record.source === "model_report" && typeof record.turnId === "string" && typeof record.recordedAt === "string" && typeof record.checkedAt === "string"
    && Array.isArray(record.references) && record.references.length > 0 && record.references.length <= 50
    && record.references.every(reference => reference && typeof reference.id === "string" && Number.isSafeInteger(reference.revision)
      && (reference.label === undefined || typeof reference.label === "string") && typeof reference.state === "string") ? record : null;
}

const states: Record<string, string> = {
  active: "当前有效", reconfirmed: "之后已重新确认", changed: "资料已更正", disabled: "资料已停用",
  expired: "资料已到期", removed: "资料已删除", unavailable: "当前资料无法核对", unconfirmed: "资料未经用户确认",
};
const date = (value: string) => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "时间未知";

export default function PersonalFactReferences({ record }: { record: PersonalFactReferenceData }) {
  return <section className="personal-fact-references" aria-label="本回合个人资料引用">
    <p>模型主动报告的引用，不等同于内部推理证明或任务成功回执。</p>
    <dl>
      <dt>登记时间</dt><dd><time dateTime={record.recordedAt}>{date(record.recordedAt)}</time></dd>
      <dt>状态核对</dt><dd><time dateTime={record.checkedAt}>{date(record.checkedAt)}</time></dd>
      <dt>回合</dt><dd><code>{record.turnId}</code></dd>
    </dl>
    <ul>{record.references.map(reference => <li key={reference.id}>
      <strong>{reference.label || `个人资料 ${reference.id.slice(0, 8)}`}</strong>
      <span>引用版本 {reference.revision} · {Object.hasOwn(states, reference.state) ? states[reference.state] : "状态待核对"}</span>
    </li>)}</ul>
  </section>;
}
