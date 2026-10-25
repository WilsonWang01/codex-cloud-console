import { createHmac, timingSafeEqual } from "node:crypto";

// Call with the raw request bytes, before a JSON parser changes their representation.
// The receiver must persist event.id uniquely with its enqueue transaction before returning 2xx.
export function verifyCallback({ headers, rawBody, secret, now = Date.now() }) {
  const reject = () => { throw Object.assign(new Error("回调签名或内容无效"), { statusCode: 401 }); };
  const timestamp = headers["x-codex-timestamp"], signature = headers["x-codex-signature"], eventId = headers["x-codex-event-id"];
  if (!Buffer.isBuffer(rawBody) || rawBody.length > 2048 || typeof secret !== "string" || Buffer.byteLength(secret) < 32 ||
      typeof timestamp !== "string" || !/^\d{10}$/.test(timestamp) || Math.abs(Math.floor(now/1000)-Number(timestamp)) > 300 ||
      typeof signature !== "string" || !/^v1=[a-f0-9]{64}$/.test(signature) || typeof eventId !== "string") reject();
  const expected = createHmac("sha256",secret).update(timestamp+".").update(rawBody).digest();
  if (!timingSafeEqual(expected,Buffer.from(signature.slice(3),"hex"))) reject();
  let event;
  try { event=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(rawBody)); } catch { reject(); }
  if (!event || Object.keys(event).sort().join(",") !== "created_at,data,id,type" || event.id !== eventId ||
      !/^[a-f0-9-]{36}$/.test(event.id) || event.type !== "automation.run.terminal" || !Number.isFinite(Date.parse(event.created_at)) ||
      !event.data || Object.keys(event.data).some(key=>!["run_id","automation_id","status","result_path","output_path"].includes(key))) reject();
  const data = event.data;
  if (typeof data.run_id !== "string" || !data.run_id || data.run_id.length > 240 || typeof data.automation_id !== "string" || !data.automation_id || data.automation_id.length > 160 ||
      !["completed","failed","canceled","interrupted","needs_reconciliation"].includes(data.status)) reject();
  let resultPath;
  try { resultPath = `/api/automations/${encodeURIComponent(data.automation_id)}/runs/${encodeURIComponent(data.run_id)}`; }
  catch { reject(); }
  if (data.result_path !== resultPath || data.output_path !== undefined && data.output_path !== resultPath+"/output") reject();
  return event;
}
