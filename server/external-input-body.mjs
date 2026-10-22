import express from "express";
import { createRunAdmission } from "./run-admission.mjs";
import { modelApiJsonLimit, modelApiTriggers, sendModelApiError } from "./model-api.mjs";

export const inputBufferLimits = Object.freeze({ maxGlobal: 2, maxPerClient: 1, timeoutMs: 30000, jsonBytes: modelApiJsonLimit });

export function createExternalBodyParser({ maxGlobal = inputBufferLimits.maxGlobal, maxPerClient = inputBufferLimits.maxPerClient,
  timeoutMs = inputBufferLimits.timeoutMs, limit = inputBufferLimits.jsonBytes, record = async () => {} } = {}) {
  const admission = createRunAdmission({ maxGlobal, maxPerClient });
  const parse = express.json({ limit, inflate: false });
  return (req, res, next, { protocol, clientId }) => {
    const started = Date.now();
    const reject = error => {
      void record({ clientId, automationId: req.params.id, trigger: modelApiTriggers[protocol] || req.path.slice(1), status: res.destroyed ? 499 : error.statusCode,
        runId: null, durationMs: Date.now() - started }).catch(() => console.error("输入请求指标保存失败"));
      if (res.destroyed) return;
      if (error.retryAfterMs) res.setHeader("Retry-After", String(Math.ceil(error.retryAfterMs / 1000)));
      if (protocol) return sendModelApiError(res, protocol, error);
      res.status(error.statusCode).json({ ok: false, error: error.message, code: error.code });
    };
    if (!req.is("application/json")) return reject({ statusCode: 415, code: "unsupported_media_type", message: "此接口只接受 application/json；未启动任务" });
    let free;
    try { free = admission.reserve(clientId); }
    catch { return reject({ statusCode: 429, code: "input_buffer_busy", message: "正在接收其他材料，请稍后使用原事件键重试", retryAfterMs: 1000 }); }
    let reading = true, released = false;
    const release = () => {
      if (reading || released) return;
      released = true;
      clearTimeout(timer);
      req.body = undefined;
      req.inlineAttachments = undefined;
      res.off("finish", finish);
      res.off("close", close);
      free();
    };
    // A disconnected caller cannot free a buffer still used by reading or acceptance.
    const finish = () => { if (!req.inputBodyPending) release(); };
    const close = () => { if (res.writableEnded) finish(); };
    const timer = setTimeout(() => { req.destroy(); res.destroy(); }, timeoutMs);
    timer.unref();
    res.once("finish", finish);
    res.once("close", close);
    req.releaseInputBody = release;
    parse(req, res, error => {
      reading = false;
      if (error || res.destroyed || res.writableEnded) {
        release();
        if (error) reject({ statusCode: error.status || 400, code: "invalid_request_body", message: "请求需要未压缩的有效 JSON，且不得超过 12 MiB；未启动任务" });
        return;
      }
      next();
    });
  };
}
