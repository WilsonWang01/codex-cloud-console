import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-runtime-probe-"));
const command = path.join(root, "codex-fixture");
const capture = path.join(root, "methods.log");

try {
  await fs.writeFile(command, `#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";
if (process.argv[2] === "--version") { process.stdout.write("codex-cli 0.fixture\\n"); process.exit(0); }
if (process.argv[2] === "app-server" && process.argv[3] === "generate-ts") process.exit(7);
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (!request.id) return;
  fs.appendFileSync(process.env.PROBE_CAPTURE, request.method + "\\n");
  let result = {};
  if (request.method === "account/read") result = { account: process.env.PROBE_NO_AUTH ? null : { type: "chatgpt" } };
  if (request.method === "model/list") result = { data: process.env.PROBE_NO_MODEL ? [] : [{ id: "gpt-5.6-terra", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }], nextCursor: null };
  if (request.method === "thread/list") result = { data: [], nextCursor: null };
  process.stdout.write(JSON.stringify({ id: request.id, result }) + "\\n");
});
`, { mode: 0o755 });

  const run = async (env = {}) => {
    try {
      const { stdout } = await execFileAsync(process.execPath, ["scripts/probe-codex-runtime.mjs", "--codex", command, "--cwd", root, "--require-auth"], {
        cwd: new URL("..", import.meta.url).pathname,
        env: { ...process.env, PROBE_CAPTURE: capture, ...env },
        timeout: 25_000,
      });
      return { code: 0, report: JSON.parse(stdout) };
    } catch (error) {
      return { code: error.code, report: JSON.parse(error.stdout) };
    }
  };

  const good = await run();
  assert.equal(good.code, 0);
  assert.equal(good.report.ok, true);
  assert.equal(good.report.expectedMedium, true);
  assert.equal(good.report.turnStart, "not-tested-no-model-call");
  const noAuth = await run({ PROBE_NO_AUTH: "1" });
  assert.equal(noAuth.code, 1);
  assert.equal(noAuth.report.authenticated, false);
  const noModel = await run({ PROBE_NO_MODEL: "1" });
  assert.equal(noModel.code, 1);
  assert.equal(noModel.report.expectedModelAvailable, false);
  const methods = await fs.readFile(capture, "utf8");
  assert.equal(methods.includes("turn/start"), false);
  assert.equal(methods.includes("thread/start"), false);
  await assert.rejects(
    execFileAsync(process.execPath, ["scripts/update-codex-app-server-schema.mjs", "--check"], {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, CODEX_SCHEMA_CLI_BINARY: command, CODEX_SCHEMA_ALLOW_GLOBAL: "1" },
      timeout: 10_000,
    }),
    (error) => error.code !== 0 && !String(error.stderr).includes("$ codex app-server"),
  );
  process.stdout.write("Readonly CLI compatibility gate: pass, missing auth/model fail closed, no model turn started.\n");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
