import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-github-api-"));
const bin = path.join(root, "bin");
const repoPath = path.join(root, "workspace", "project");
const stateRoot = path.join(root, "state");
await fs.mkdir(bin, { recursive: true });
await fs.mkdir(repoPath, { recursive: true });
await fs.mkdir(stateRoot, { recursive: true });
const issue = { number: 42, title: "Repair navigation", body: "The mobile menu overlaps.", url: "https://github.com/acme/project/issues/42", state: "OPEN", updatedAt: "2026-09-27T00:00:00Z", author: { login: "reporter" }, labels: [], comments: [] };
const ghSource = `#!/usr/bin/env node
const args = process.argv.slice(2);
const key = args.slice(0, 2).join(" ");
if (args[0] === "--version") console.log("gh version 2");
else if (key === "auth status") process.exit(0);
else if (key === "api user") console.log("alice");
else if (key === "repo view") console.log(JSON.stringify({ nameWithOwner: "acme/project", url: "https://github.com/acme/project", viewerPermission: "WRITE", hasIssuesEnabled: true, defaultBranchRef: { name: "main" }, isArchived: false }));
else if (key === "issue list") console.log(JSON.stringify([${JSON.stringify({ ...issue, body: undefined, comments: undefined })}]));
else if (key === "issue view") console.log(JSON.stringify(${JSON.stringify(issue)}));
else process.exit(2);
`;
await fs.writeFile(path.join(bin, "gh"), ghSource, { mode: 0o755 });

async function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")}: ${stderr}`)));
  });
}

await run("git", ["-C", repoPath, "init", "-q"]);
await run("git", ["-C", repoPath, "remote", "add", "origin", "https://github.com/acme/project.git"]);

const port = await new Promise((resolve, reject) => {
  const listener = net.createServer();
  listener.once("error", reject);
  listener.listen(0, "127.0.0.1", () => {
    const address = listener.address();
    listener.close(() => resolve(address.port));
  });
});
const env = {
  ...process.env,
  NODE_ENV: "production", HOST: "127.0.0.1", PORT: String(port),
  CODEX_CLOUD_ROOT: root, CODEX_STATE_ROOT: stateRoot, CODEX_HOME: path.join(root, "codex-home"),
  CODEX_PERSONAL_MODE: "disabled", CODEX_PERSONAL_ROOT: path.join(root, "personal"),
  CODEX_CLOUD_REPOS_CONFIG_B64: Buffer.from(JSON.stringify([{ id: "project", name: "project", path: repoPath, remote: "acme/project" }])).toString("base64"),
  PATH: `${bin}${path.delimiter}${process.env.PATH}`,
};
const server = spawn(process.execPath, [path.join(projectRoot, "server/index.mjs")], { cwd: projectRoot, env, stdio: ["ignore", "pipe", "pipe"] });
let logs = "";
server.stdout.on("data", (chunk) => { logs += chunk; });
server.stderr.on("data", (chunk) => { logs += chunk; });

async function request(route, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, options);
  return { status: response.status, body: await response.json() };
}

try {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (logs.includes("listening on")) break;
    if (server.exitCode !== null) throw new Error(`Server exited: ${logs}`);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.match(logs, /listening on/u);
  const connected = await request("/api/github/connection?repoId=project");
  assert.equal(connected.status, 200);
  assert.equal(connected.body.connection.account, "alice");
  assert.equal(connected.body.connection.repo.slug, "acme/project");
  const listed = await request("/api/github/issues?repoId=project");
  assert.equal(listed.status, 200);
  assert.equal(listed.body.issues[0].number, 42);
  const read = await request("/api/github/issues/42?repoId=project");
  assert.equal(read.status, 200);
  assert.equal(read.body.issue.body, issue.body);
  const prepared = await request("/api/github/issues/42/prepare", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repoId: "project" }) });
  assert.equal(prepared.status, 200);
  const session = prepared.body.sessions.find((item) => item.id === prepared.body.activeSessionId);
  assert.equal(session.sandbox, "workspace-write");
  assert.equal(session.approval, "on-request");
  assert.match(session.draft.input, /Issue #42/u);
  const stored = JSON.parse(await fs.readFile(path.join(stateRoot, "chat-history.json"), "utf8"));
  assert.equal(stored.sessions[session.id].draft.input, session.draft.input);
  const preview = await request("/api/github/issues/42/publish-preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repoId: "project" }) });
  assert.equal(preview.status, 409);
  const invalidPublish = await request("/api/github/publish", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repoId: "project", previewId: "invalid" }) });
  assert.equal(invalidPublish.status, 400);
  assert.equal((await request("/api/github/issues/42?repoId=_personal")).status, 400);
  process.stdout.write("GitHub API integration passed; no model or remote mutation executed.\n");
} finally {
  if (server.exitCode === null) {
    const stopped = new Promise((resolve) => server.once("close", resolve));
    server.kill("SIGTERM");
    await Promise.race([stopped, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    if (server.exitCode === null) server.kill("SIGKILL");
  }
  await fs.rm(root, { recursive: true, force: true });
}
