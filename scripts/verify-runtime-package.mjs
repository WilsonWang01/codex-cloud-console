import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pdfAttachment } from "./fixtures/inline-pdf.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "codex-runtime-package-")));
async function diskBytes(directory) {
  let total = 0;
  for (const name of await fs.readdir(directory)) {
    const entry = path.join(directory, name);
    const stat = await fs.lstat(entry);
    total += stat.isDirectory() ? await diskBytes(entry) : stat.size;
  }
  return total;
}

try {
  for (const name of ["package.json", "package-lock.json"]) {
    await fs.copyFile(path.join(projectRoot, name), path.join(root, name));
  }
  await fs.mkdir(path.join(root, "server"));
  for (const name of ["pdf-inputs.mjs", "pdf-input-worker.mjs", "inline-inputs.mjs", "run-admission.mjs"]) await fs.copyFile(path.join(projectRoot, "server", name), path.join(root, "server", name));
  execFileSync("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: root, stdio: "pipe", timeout: 120_000,
  });
  const lock = JSON.parse(await fs.readFile(path.join(root, "package-lock.json"), "utf8"));
  let lockedPackages = 0;
  for (const [name, expected] of Object.entries(lock.packages)) {
    if (!name) continue;
    let installed;
    try {
      installed = JSON.parse(await fs.readFile(path.join(root, name, "package.json"), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT" && (expected.dev || expected.optional || expected.devOptional)) continue;
      throw error;
    }
    assert.equal(installed.version, expected.version, `${name} differs from package-lock.json`);
    lockedPackages += 1;
  }
  execFileSync("npm", ["ls", "--omit=dev", "--all"], { cwd: root, stdio: "pipe", timeout: 30_000 });
  const dependencies = ["ajv", "cron-parser", "express", "ws", "web-push", "playwright", "@napi-rs/canvas", "pdfjs-dist/legacy/build/pdf.mjs"];
  execFileSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    for (const name of ${JSON.stringify(dependencies)}) {
      assert(import.meta.resolve(name).startsWith(${JSON.stringify(pathToFileURL(path.join(root, "node_modules") + path.sep).href)}));
      const module = await import(name);
      if (name === "playwright") assert.equal(typeof module.chromium.launch, "function");
    }
    const {normalizeInlineAttachments} = await import("./server/inline-inputs.mjs");
    const {prepareInlineAttachmentInputs} = await import("./server/pdf-inputs.mjs");
    const parsed = await prepareInlineAttachmentInputs(normalizeInlineAttachments([${JSON.stringify(pdfAttachment())}]));
    assert.equal(parsed.processing.status, "ready");
    assert.equal(parsed.inputs.filter(input=>input.type==="image").length, 1);
  `], { cwd: root, stdio: "pipe", timeout: 30_000 });
  for (const name of ["vite", "typescript", "lucide-react", "react-dom", "@vitejs/plugin-react"]) {
    await assert.rejects(fs.access(path.join(root, "node_modules", name)), { code: "ENOENT" });
  }
  console.log(JSON.stringify({
    ok: true, checks: ["纯运行时依赖可独立安装和加载", "已安装依赖版本与锁文件一致", "浏览器检查依赖保留", "构建依赖不进入运行包"],
    lockedPackages,
    dependencyBytes: await diskBytes(path.join(root, "node_modules")),
  }, null, 2));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
