#!/usr/bin/env node

import { normalizeAppServerThreadMessages } from "../server/app-server-normalizers.mjs";

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

console.log(JSON.stringify({ ok: true, checks: ["unknown-item-fallback", "stable-null-time", "known-item-time", "upload-path-attachment"] }, null, 2));
