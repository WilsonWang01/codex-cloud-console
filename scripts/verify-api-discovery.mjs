import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs/promises";
import { createDiscoveryHandler } from "../server/api-discovery.mjs";

async function fixture(task) {
  const state = { lookups: 0, rate: 0, pdfInput: { ok: true, parser: "pdfjs:fixture", checkedAt: "2026-10-23T00:00:00Z" }, catalog: { ok: true, cachedAt: "2026-10-22T00:00:00Z", models: [{ id: "gpt-6-sol", supportedReasoningEfforts: ["medium"] }] }, metrics: [] };
  const app = express();
  const handler = createDiscoveryHandler({
    authenticate: async (req, token) => token === "allowed" && req.params.id === "demo" ? { id: "client-a" } : null,
    automation: () => ({ model: "gpt-6-sol", reasoning: "medium" }),
    catalog: async () => { state.lookups++; return state.catalog; },
    runtime: async () => ({ version: "0.157.1", probedAt: "2026-10-22T00:00:00Z", pdfInput: state.pdfInput }),
    runs: async () => [
      { clientId: "client-a", automationId: "demo", model: "gpt-6-sol", status: "completed", finishedAt: "2026-10-21T00:00:00Z", prompt: "PRIVATE" },
      { clientId: "client-b", automationId: "demo", model: "gpt-6-sol", status: "failed", finishedAt: "2026-10-22T00:00:00Z" },
      { clientId: "client-a", automationId: "private", model: "gpt-6-sol", status: "failed", finishedAt: "2026-10-22T00:00:00Z" },
    ],
    rateLimit: () => state.rate,
    record: async (metric) => { state.metrics.push(metric); }, idempotencyTtlMs: 86400000, modelWaitMs: 300000,
  });
  for (const kind of ["models", "capabilities"]) app.get(`/api/automations/:id/v1/${kind}`, (req, res) => handler(req, res, kind));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = (route, headers = { authorization: "Bearer allowed" }) => fetch(`${origin}/api/automations/${route}`, { headers });
  try { await task({ state, origin, get }); }
  finally { await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }); }
}

test("OpenAI pinned SDK discovers models without leaking other clients or claiming access", () => fixture(async ({ origin, state, get }) => {
  const sdk = new OpenAI({ baseURL: `${origin}/api/automations/demo/v1`, apiKey: "allowed", maxRetries: 0 });
  const result = await sdk.models.list();
  assert.equal(result.data[0].id, "gpt-6-sol");
  assert.equal(result.data[0].created, 0);
  assert.deepEqual(result.data[0].codex_cloud.inference, { status: "succeeded", observed_at: "2026-10-21T00:00:00.000Z" });
  assert.equal((await (await get("demo/v1/models")).json()).codex_cloud.inference_verified, false);
  assert.equal(JSON.stringify(result.data).includes("PRIVATE"), false);
  assert.equal(state.metrics[0].trigger, "discovery");
}));

test("Anthropic pinned SDK headers can read capabilities, without pretending models.list compatibility", () => fixture(async ({ origin, state, get }) => {
  const sdk = new Anthropic({ baseURL: `${origin}/api/automations/demo`, apiKey: "allowed", maxRetries: 0 });
  const data = await sdk.get("/v1/capabilities");
  assert.equal(data.features.structured_output, true);
  assert.equal(data.features.artifact_download, false);
  assert.equal(data.features.request_output_token_limit, false);
  assert.equal(data.runtime.cli_version, "0.157.1");
  assert.equal(data.defaults.reasoning, "medium");
  assert.equal(data.features.file_input.pdf.supported, true);
  assert.equal(data.limits.pdf_input.pagesEach, 6);
  state.pdfInput = { ok: false };
  const unavailable = (await (await get("demo/v1/capabilities")).json()).features.file_input;
  assert.equal(unavailable.pdf.supported, false);
  assert.equal(unavailable.chat_file_parts, false);
}));

test("missing, invalid, wrong-scope and conflicting tokens reject before reading runtime", () => fixture(async ({ get, state }) => {
  for (const headers of [{}, { authorization: "Bearer invalid" }, { authorization: "Basic allowed" }, { authorization: "Bearer allowed", "x-api-key": "other" }]) {
    assert.equal((await get("demo/v1/models", headers)).status, 401);
  }
  assert.equal((await get("private/v1/models")).status, 401);
  assert.equal(state.lookups, 0);
  assert.equal(state.metrics.length, 0);
}));

test("unknown fields, limited polling, stale catalogs and unavailable catalogs are explicit", () => fixture(async ({ get, state }) => {
  assert.equal((await get("demo/v1/models?refresh=1")).status, 400);
  assert.equal(state.lookups, 0);
  state.rate = 30;
  const limited = await get("demo/v1/models");
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "30");
  state.rate = 0;
  state.catalog.refreshError = "private upstream details";
  const stale = await (await get("demo/v1/models")).json();
  assert.equal(stale.codex_cloud.catalog_status, "stale");
  assert.equal(JSON.stringify(stale).includes("private upstream"), false);
  state.catalog = { ok: false, models: [] };
  assert.equal((await get("demo/v1/models")).status, 503);
  const caps = await get("demo/v1/capabilities");
  assert.equal(caps.status, 200);
  assert.equal((await caps.json()).catalog.status, "unavailable");
  assert.equal(caps.headers.get("cache-control"), "no-store");
}));

test("published OpenAPI references resolve and discovery required fields match HTTP responses", () => fixture(async ({ get }) => {
  const document = JSON.parse(await fs.readFile(new URL("../docs/openapi.json", import.meta.url), "utf8"));
  assert.equal(document.openapi, "3.1.0");
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (value.$ref) assert.ok(value.$ref.slice(2).split("/").reduce((entry, key) => entry?.[key], document), value.$ref);
    Object.values(value).forEach(visit);
  };
  visit(document);
  for (const [route, schema] of [["models", "Models"], ["capabilities", "Capabilities"]]) {
    assert.ok(document.paths[`/api/automations/{automationId}/v1/${route}`].get.security.length);
    const data = await (await get(`demo/v1/${route}`)).json();
    for (const field of document.components.schemas[schema].required) assert.ok(Object.hasOwn(data, field), field);
  }
}));
