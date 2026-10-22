import { clientCanReadRun } from "./external-automation.mjs";
import { withFileResponse } from "./file-response.mjs";
import { externalApiToken } from "./external-auth.mjs";

const fail = (statusCode, code, message) => Object.assign(new Error(message), { statusCode, code });

export function createExternalResultHandler({ authenticate, readRun, results, rateLimit, record }) {
  async function authenticated(req) {
    const token = externalApiToken(req);
    const client = token ? await authenticate(req, token) : null;
    if (!client) throw fail(401, "authentication_required", "调用方令牌无效、过期或没有此自动化权限");
    return client;
  }
  return async (req, res) => {
    const started = Date.now();
    let client;
    let run;
    res.setHeader("Cache-Control", "no-store");
    try {
      client = await authenticated(req);
      const retry = rateLimit(client.id);
      if (retry) throw Object.assign(fail(429, "result_rate_limit", "结果查询和下载合计每分钟最多 60 次"), { retryAfterMs: retry * 1000 });
      if (req.method !== "GET" || Object.keys(req.query || {}).length) throw fail(400, "invalid_result_request", "结果接口只支持无查询参数的 GET");
      run = await readRun(req.params.runId);
      if (!clientCanReadRun(client, req.params.id, run)) throw fail(404, "run_not_found", "没有此调用方的运行");
      await withFileResponse(res, async () => {
        const store = results();
        const file = req.params.fileId ? await store.file(run, req.params.fileId) : null;
        const manifest = file ? null : await store.manifest(run);
        if ((await authenticated(req)).id !== client.id) throw fail(401, "authentication_changed", "下载期间调用方身份已变化");
        if (res.destroyed) return;
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Content-Security-Policy", "sandbox");
        if (!file) return res.json({ ok: true, result: manifest });
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Content-Length", String(file.buffer.length));
        res.setHeader("Content-Disposition", `attachment; filename="file"; filename*=UTF-8''${encodeURIComponent(file.name)}`);
        res.setHeader("X-Content-SHA256", file.sha256);
        res.end(file.buffer);
      });
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) return res.destroy();
      if (error.retryAfterMs) res.setHeader("Retry-After", String(Math.ceil(error.retryAfterMs / 1000)));
      res.status(error.statusCode || 503).json({ ok: false, error: error.statusCode ? error.message : "结果读取失败，请查询原任务，不会重复执行", code: error.statusCode ? error.code : "result_unavailable" });
    } finally {
      if (client && res.statusCode !== 429) await record({ clientId: client.id, automationId: req.params.id, trigger: "result", status: res.statusCode,
        runId: run?.id || null, durationMs: Date.now() - started }).catch(() => {});
    }
  };
}
