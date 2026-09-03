#!/usr/bin/env node

import { normalizeAppServerThreadMessages } from "../server/app-server-normalizers.mjs";
import { pluginCatalogPage } from "../server/plugin-catalog.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const unknownMessages = normalizeAppServerThreadMessages({
  id: "thread-normalizer-smoke",
  createdAt: "not-a-date",
  updatedAt: "also-not-a-date",
  turns: [
    {
      id: "turn-unknown",
      startedAt: "invalid",
      completedAt: null,
      items: [
        {
          id: "item-new-schema",
          type: "newFutureAppServerItem",
          status: "inProgress",
          payload: { value: 42 },
          nested: ["a", "b"],
        },
      ],
    },
  ],
});

assert(unknownMessages.length === 1, `expected one fallback message, got ${unknownMessages.length}`);
assert(unknownMessages[0].messageType === "newFutureAppServerItem", "fallback message did not preserve item type");
assert(unknownMessages[0].status === "unknown inProgress", "fallback message did not preserve item status");
assert(unknownMessages[0].details?.kind === "unknownItem", "fallback details missing unknownItem kind");
assert(unknownMessages[0].details?.rawPreview?.includes("payload"), "fallback details did not retain raw preview");
assert(unknownMessages[0].time == null, "invalid timestamps should remain null instead of being replaced with current time");

const knownMessages = normalizeAppServerThreadMessages({
  createdAt: "2026-07-02T00:00:00Z",
  turns: [
    {
      id: "turn-known",
      items: [{ id: "agent-1", type: "agentMessage", text: "hello" }],
    },
  ],
});

assert(knownMessages.length === 1, "known item normalization regressed");
assert(knownMessages[0].time === "2026-07-02T00:00:00.000Z", "known item did not inherit stable thread timestamp");

const uploadMessages = normalizeAppServerThreadMessages(
  {
    createdAt: "2026-07-02T00:00:00Z",
    turns: [
      {
        id: "turn-upload",
        items: [
          {
            id: "user-upload",
            type: "userMessage",
            content: [
              {
                type: "text",
                text: "请看上传文件路径:\n\n.codex-cloud/uploads/2026-07-02/123-report.png",
              },
            ],
          },
        ],
      },
    ],
  },
  { repoPath: "/home/ubuntu/codex-cloud/workspace/sample-app" },
);

assert(uploadMessages.length === 1, "upload path user message did not normalize");
assert(uploadMessages[0].attachments?.length === 1, "upload path did not hydrate attachment metadata");
assert(uploadMessages[0].attachments[0].kind === "image", "upload image path did not hydrate as image attachment");
assert(
  uploadMessages[0].attachments[0].absolutePath === "/home/ubuntu/codex-cloud/workspace/sample-app/.codex-cloud/uploads/2026-07-02/123-report.png",
  "upload attachment absolutePath was not reconstructed from repoPath",
);

const currentProtocolMessages = normalizeAppServerThreadMessages({
  createdAt: "2026-09-03T00:00:00Z",
  turns: [
    {
      id: "turn-current",
      items: [
        {
          id: "agent-questions",
          type: "agentMessage",
          text: "请选择发布方式。",
          delivery: "async",
          questions: [{ title: "发布到哪里？", options: ["预览", "生产"] }],
        },
        {
          id: "search-1",
          type: "webSearch",
          query: "Codex app server",
          action: { type: "search", query: "Codex app server", queries: null },
          results: [{ title: "Codex", url: "https://developers.openai.com/codex" }],
        },
        {
          id: "image-1",
          type: "imageGeneration",
          status: "failed",
          revisedPrompt: null,
          result: "",
          failure: { type: "usageLimitExceeded", limitId: "image", resetsAt: 1_800_000_000 },
        },
        {
          id: "subagent-1",
          type: "subAgentActivity",
          kind: "completed",
          agentThreadId: "thread-agent",
          agentPath: "reviewer",
        },
        { id: "sleep-1", type: "sleep", durationMs: 1500 },
        { id: "function-1", type: "functionCallOutput", name: "lookup", namespace: "demo", output: "ok" },
      ],
    },
  ],
});

assert(currentProtocolMessages.length === 6, "current app-server protocol items did not normalize");
assert(currentProtocolMessages[0].details?.questions?.length === 1, "async agent questions were not preserved");
assert(currentProtocolMessages[1].details?.resultCount === 1, "web search results were not preserved");
assert(currentProtocolMessages[2].details?.failure?.type === "usageLimitExceeded", "image failure was not preserved");
assert(currentProtocolMessages[3].details?.kind === "subAgentActivity", "sub-agent activity was not normalized");
assert(currentProtocolMessages[4].details?.durationMs === 1500, "sleep duration was not normalized");
assert(currentProtocolMessages[5].details?.kind === "functionCallOutput", "function output was not normalized");

const catalogPage = pluginCatalogPage(
  {
    plugins: Array.from({ length: 240 }, (_, index) => ({
      id: `plugin-${index}`,
      name: `plugin-${index}`,
      displayName: index === 239 ? "AWS Control" : `Plugin ${String(index).padStart(3, "0")}`,
      description: index === 238 ? "EC2 operations" : "General tool",
      developerName: "OpenAI",
      category: "tool",
      marketplaceName: "official",
      capabilities: index === 237 ? ["AWS", "IAM"] : [],
      installed: index === 200,
      featured: index === 199,
    })),
    marketplaceLoadErrors: [{ message: "one marketplace warning" }],
  },
  {},
);
assert(catalogPage.total === 240 && catalogPage.returned === 80, "plugin catalog default page size regressed");
assert(catalogPage.truncated === true, "plugin catalog should report truncation");
assert(catalogPage.plugins[0].id === "plugin-200", "installed plugins should sort first");
assert(catalogPage.plugins[1].id === "plugin-199", "featured plugins should sort after installed plugins");
assert(catalogPage.installedCount === 1, "plugin catalog installed count regressed");

const catalogSearch = pluginCatalogPage(
  {
    plugins: Array.from({ length: 3 }, (_, index) => ({
      id: `search-${index}`,
      name: `search-${index}`,
      displayName: index === 0 ? "AWS Core" : `Tool ${index}`,
      description: index === 1 ? "Manage EC2 safely" : "General tool",
      developerName: null,
      category: null,
      marketplaceName: "official",
      capabilities: index === 2 ? ["IAM"] : [],
      installed: false,
      featured: false,
    })),
  },
  { query: "ec2", limit: 20 },
);
assert(catalogSearch.matched === 1 && catalogSearch.plugins[0]?.id === "search-1", "plugin server-side search regressed");

console.log(JSON.stringify({ ok: true, checks: ["unknown-item-fallback", "stable-null-time", "known-item-time", "upload-path-attachment", "current-protocol-items", "plugin-catalog-page", "plugin-catalog-search"] }, null, 2));
