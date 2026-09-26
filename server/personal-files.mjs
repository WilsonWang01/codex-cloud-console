import fs from "node:fs/promises";
import path from "node:path";

const previewMime = new Map([
  [".avif", "image/avif"], [".gif", "image/gif"], [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"], [".png", "image/png"], [".webp", "image/webp"],
  [".pdf", "application/pdf"], [".txt", "text/plain; charset=utf-8"],
  [".md", "text/plain; charset=utf-8"], [".csv", "text/plain; charset=utf-8"],
  [".json", "text/plain; charset=utf-8"],
]);

function fileError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function allowedParts(relativePath) {
  const value = String(relativePath || "").replaceAll("\\", "/");
  if (!value || path.isAbsolute(value)) throw fileError("Invalid personal file path");
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw fileError("Invalid personal file path");
  const input = parts[0] === ".codex-cloud" && parts[1] === "uploads" && parts.length > 2;
  if (parts.some((part, index) => part.startsWith(".") && !(input && index === 0))) throw fileError("Personal system files are not available");
  if (parts.includes("node_modules") || parts.includes(".git")) throw fileError("Personal system files are not available");
  return { parts, input };
}

export async function resolvePersonalFile(root, relativePath, maxBytes = 20 * 1024 * 1024) {
  const { parts, input } = allowedParts(relativePath);
  const realRoot = await fs.realpath(root);
  const target = path.join(root, ...parts);
  let realTarget;
  try { realTarget = await fs.realpath(target); }
  catch (error) { if (error?.code === "ENOENT") throw fileError("Personal file does not exist", 404); throw error; }
  if (!realTarget.startsWith(`${realRoot}${path.sep}`)) throw fileError("Personal file escapes workspace", 403);
  if (path.relative(realRoot, realTarget) !== path.join(...parts)) throw fileError("Personal file symlinks are not available", 403);
  const stat = await fs.lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw fileError("Personal file is not a regular file", 400);
  if (stat.size > maxBytes) throw fileError("Personal file is too large to preview or download", 413);
  const mimeType = previewMime.get(path.extname(target).toLowerCase()) || "application/octet-stream";
  return { target, relativePath: parts.join("/"), input, stat, mimeType };
}

export async function listPersonalFiles(root, limit = 100) {
  const realRoot = await fs.realpath(root);
  const files = [];
  let visited = 0;
  const scan = async (directory, relativeDir, depth, input = false) => {
    if (depth > 4 || visited >= 1200) return;
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error?.code === "ENOENT") return; throw error; }
    for (const entry of entries) {
      if (visited++ >= 1200) break;
      if (entry.isSymbolicLink() || entry.name === "node_modules" || entry.name === ".git") continue;
      if (entry.name.startsWith(".")) continue;
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await scan(fullPath, relativePath, depth + 1, input);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = await fs.stat(fullPath).catch(() => null);
      if (!stat) continue;
      files.push({
        path: relativePath,
        name: input ? entry.name.replace(/^\d+-[0-9a-f]+-/i, "") : entry.name,
        kind: input ? "input" : "output",
        size: stat.size,
        updatedAt: stat.mtime.toISOString(),
        previewable: previewMime.has(path.extname(entry.name).toLowerCase()),
        mimeType: previewMime.get(path.extname(entry.name).toLowerCase()) || "application/octet-stream",
      });
    }
  };
  await scan(root, "", 0);
  const uploadsRoot = path.join(root, ".codex-cloud", "uploads");
  const uploadsReal = await fs.realpath(uploadsRoot).catch(() => null);
  if (uploadsReal === path.join(realRoot, ".codex-cloud", "uploads")) await scan(uploadsRoot, ".codex-cloud/uploads", 0, true);
  return files.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, Math.min(Math.max(limit, 1), 200));
}
