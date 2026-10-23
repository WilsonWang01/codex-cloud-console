import { authenticateModelApiRequest, sendModelApiError } from "./model-api.mjs";
import { clientCanReadRun } from "./external-automation.mjs";
import { structuredOutputLimits } from "./structured-output.mjs";
import { inlineInputLimits, pdfInputLimits } from "./inline-inputs.mjs";
import { inputBufferLimits } from "./external-input-body.mjs";

const failure = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const timestamp = (value) => Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

export function discoveryModels(catalog, runs, client, automationId) {
  const evidence = new Map();
  for (const run of runs) {
    if (!clientCanReadRun(client, automationId, run) || !["completed", "failed"].includes(run.status)) continue;
    const at = timestamp(run.finishedAt);
    if (!at || at <= (evidence.get(run.model)?.observed_at || "")) continue;
    evidence.set(run.model, { status: run.status === "completed" ? "succeeded" : "failed", observed_at: at });
  }
  const models = Array.isArray(catalog?.models) ? catalog.models : [];
  return models.filter((model) => typeof model.id === "string" && /^[A-Za-z0-9._:-]{2,64}$/.test(model.id) && !model.hidden).map((model) => ({
    id: model.id, object: "model", created: 0, owned_by: "unknown",
    codex_cloud: {
      display_name: model.displayName || model.id,
      reasoning_efforts: model.supportedReasoningEfforts || [],
      input_modalities: model.inputModalities || [],
      inference: evidence.get(model.id) || { status: "not_verified", observed_at: null },
    },
  }));
}

export function discoveryCapabilities({ automationId, defaults, catalog, cli, idempotencyTtlMs, modelWaitMs, queueLimits, resultStorage }) {
  return {
    object: "codex_cloud.capabilities", version: "2026-10-23", automation_id: automationId,
    defaults: { model: defaults.model, reasoning: defaults.reasoning },
    runtime: { cli_version: cli.version, probed_at: cli.probedAt, protocol: "codex-app-server-v2" },
    catalog: { status: catalog?.ok === true ? (catalog.stale || catalog.refreshError ? "stale" : "available") : "unavailable",
      observed_at: timestamp(catalog?.cachedAt), inference_verified: false },
    protocols: { openai_chat_completions: "subset", openai_responses: "subset", openai_images_generations: "subset", anthropic_messages: "subset", models: "openai_list_subset" },
    features: {
      text: true, image_input: { supported: true, encoding: "inline_base64", mime_types: ["image/png", "image/jpeg", "image/webp"], max_images: 8, max_bytes_each: 4 * 1024 * 1024, max_bytes_total: 8 * 1024 * 1024 },
      image_output: { supported: true, conditional: "Requires a successful native imageGeneration item in the exact turn", encoding: "base64", max_images: 4, max_bytes_total: 8 * 1024 * 1024 },
      structured_output: true, artifact_download: Boolean(resultStorage), result_manifest: Boolean(resultStorage), sse: true, async_runs: true, durable_async_queue: true, cancellation: true,
      file_input: { supported: true, mode: "inline_task_material", text_formats: ["txt", "md"], image_formats: ["png", "jpeg", "webp"],
        pdf: { supported: cli.pdfInput?.ok === true, mode: "server_text_and_page_images", runtime: cli.pdfInput || null, requires_vision_model: true },
        responses: "text_or_pdf_input_file", anthropic: "plain_text_or_pdf_document", chat_file_parts: cli.pdfInput?.ok === true, chat_file_formats: ["pdf"] },
      request_output_token_limit: false, callback: false,
    },
    limits: { json_bytes: 12 * 1024 * 1024, messages: 100, normalized_text_bytes: 64 * 1024, model_wait_ms: modelWaitMs, discovery_and_poll_requests_per_minute: 60,
      structured_output: structuredOutputLimits, inline_attachments: inlineInputLimits, pdf_input: pdfInputLimits, input_buffers: inputBufferLimits, ...(queueLimits ? { task_queue: queueLimits } : {}), ...(resultStorage ? { result_storage: resultStorage } : {}) },
    retention: { idempotency_ttl_ms: idempotencyTtlMs, pending_task_keys: "retained_until_resolved", run_results: "bounded_history_no_fixed_duration_guarantee", request_metrics_days: 30,
      model_results: resultStorage ? "new_runs_have_private_snapshots_until_expiresAt;_legacy_requires_original_turn" : "original_turn_must_remain_readable", structured_results: "retained_with_run",
      ...(resultStorage ? { result_ttl_ms_from_capture: resultStorage.retention_ms, result_cleanup: "minute_sweep;_only_delivery_copies;_uncertain_executions_retained" } : {}) },
    unsupported: ["remote_image_urls", "files_api", "audio", "video", "password_pdf", "pdf_detail_low_high", "client_tools", "schema_refs_composition_patterns_formats", "sampling_parameters", "responses_store", "images_edits"],
    notes: ["Model catalog membership does not verify account access. Inference evidence is limited to this client and automation's retained runs; a failed run does not prove model unavailability.", "Codex does not supply model creation time or owner: created=0 and owned_by=unknown are placeholders.", "Adapter support is not an end-to-end business or third-party permission guarantee."],
  };
}

export function createDiscoveryHandler({ authenticate, automation, catalog, runtime, runs, rateLimit, record, idempotencyTtlMs, modelWaitMs, queueLimits, resultStorage }) {
  return async (req, res, kind) => {
    const protocol = req.get("x-api-key") || req.get("anthropic-version") ? "anthropic" : "openai";
    res.setHeader("Cache-Control", "no-store");
    const started = Date.now();
    let client;
    try {
      // Accept either SDK header, but reject conflicting credentials before any runtime lookup.
      ({ client } = await authenticateModelApiRequest(req, "anthropic", authenticate));
      const retrySeconds = rateLimit(client.id);
      if (retrySeconds) throw Object.assign(failure(429, "能力查询和结果轮询合计每分钟最多 60 次"), { retryAfterMs: retrySeconds * 1000 });
      if (req.method !== "GET") throw failure(405, "能力发现仅支持 GET");
      if (Object.keys(req.query || {}).length) throw failure(400, "能力发现暂不支持查询参数");
      const defaults = automation(req.params.id);
      if (!defaults) throw failure(404, "自动化不存在");
      const listed = await catalog();
      if (kind === "models") {
        if (listed?.ok !== true) throw failure(503, "模型目录暂不可用，请稍后重试或查询 capabilities");
        res.json({ object: "list", data: discoveryModels(listed, await runs(client, req.params.id), client, req.params.id),
          codex_cloud: { catalog_status: listed.stale || listed.refreshError ? "stale" : "available", observed_at: timestamp(listed.cachedAt), inference_verified: false } });
      } else {
        res.json(discoveryCapabilities({ automationId: req.params.id, defaults, catalog: listed, cli: await runtime(), idempotencyTtlMs, modelWaitMs, queueLimits: queueLimits?.(), resultStorage: resultStorage?.() }));
      }
    } catch (error) {
      sendModelApiError(res, protocol, error.statusCode ? error : failure(503, "能力信息暂不可用，请稍后重试"));
    } finally {
      if (client && res.statusCode !== 429) await record({ clientId: client.id, automationId: req.params.id, trigger: "discovery", status: res.statusCode, durationMs: Date.now() - started }).catch(() => {});
    }
  };
}
