import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

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
  execFileSync("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: root, stdio: "pipe", timeout: 120_000,
  });
  const dependencies = ["express", "ws", "web-push", "playwright"];
  execFileSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    for (const name of ${JSON.stringify(dependencies)}) {
      assert(import.meta.resolve(name).startsWith(${JSON.stringify(pathToFileURL(path.join(root, "node_modules") + path.sep).href)}));
      const module = await import(name);
      if (name === "playwright") assert.equal(typeof module.chromium.launch, "function");
    }
  `], { cwd: root, stdio: "pipe", timeout: 30_000 });
  for (const name of ["vite", "typescript", "lucide-react", "react-dom", "@vitejs/plugin-react"]) {
    await assert.rejects(fs.access(path.join(root, "node_modules", name)), { code: "ENOENT" });
  }
  console.log(JSON.stringify({
    ok: true, checks: ["纯运行时依赖可独立安装和加载", "浏览器检查依赖保留", "构建依赖不进入运行包"],
    dependencyBytes: await diskBytes(path.join(root, "node_modules")),
  }, null, 2));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
