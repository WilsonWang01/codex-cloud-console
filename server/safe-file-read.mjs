import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

const error = (message, statusCode, code) => Object.assign(new Error(message), { statusCode, code });
const changed = () => error("文件在读取期间发生变化，请刷新后重试", 409, "file_changed");
const unsafe = () => error("文件路径或链接不在允许范围内", 403, "unsafe_file");
const sameInode = (a, b) => a.dev === b.dev && a.ino === b.ino;
const sameFile = (a, b) => sameInode(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.nlink === b.nlink;

function partsFor(value) {
  if (typeof value !== "string" || !value || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) throw error("文件路径无效", 400, "invalid_file_path");
  const parts = value.replaceAll("\\", "/").split("/");
  if (parts.length > 64 || /^[a-z]:/i.test(parts[0]) || parts.some(part => !part || part === "." || part === "..")) throw error("文件路径无效", 400, "invalid_file_path");
  return parts;
}

// Linux uses descriptor-anchored traversal; macOS repeats path/inode checks, not a sandbox.
// Buffer before sending: changed files must fail before any unverified bytes reach a client.
export async function readRootedFile(root, relativePath, maxBytes) {
  const parts = partsFor(relativePath);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError("maxBytes must be a non-negative safe integer");
  const handles = [];
  try {
    const realRoot = await fs.realpath(root);
    const directories = [];
    const rootBefore = await fs.lstat(realRoot, { bigint: true });
    const rootHandle = await fs.open(realRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    handles.push(rootHandle);
    const rootStat = await rootHandle.stat({ bigint: true });
    if (!rootStat.isDirectory() || !sameInode(rootBefore, rootStat)) throw changed();
    directories.push({ target: realRoot, stat: rootStat });

    let directory = rootHandle;
    let target = realRoot;
    const anchored = process.platform === "linux";
    // Linux opens every child through the held parent descriptor, not a mutable path prefix.
    for (const part of parts.slice(0, -1)) {
      target = path.join(target, part);
      const before = await fs.lstat(target, { bigint: true });
      if (!before.isDirectory() || before.isSymbolicLink()) throw unsafe();
      const handle = await fs.open(anchored ? `/proc/self/fd/${directory.fd}/${part}` : target,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      handles.push(handle);
      const stat = await handle.stat({ bigint: true });
      if (!stat.isDirectory() || !sameInode(before, stat)) throw changed();
      directories.push({ target, stat });
      directory = handle;
    }

    target = path.join(target, parts.at(-1));
    const beforeOpen = await fs.lstat(target, { bigint: true });
    if (!beforeOpen.isFile() || beforeOpen.isSymbolicLink() || beforeOpen.nlink !== 1n) throw unsafe();
    const file = await fs.open(anchored ? `/proc/self/fd/${directory.fd}/${parts.at(-1)}` : target,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    handles.push(file);
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || !sameFile(beforeOpen, before)) throw changed();
    if (before.size > BigInt(maxBytes)) throw error("文件超过允许读取的大小", 413, "file_too_large");

    const validatePath = async () => {
      if (await fs.realpath(root) !== realRoot || await fs.realpath(target) !== target) throw changed();
      for (const entry of directories) {
        const stat = await fs.lstat(entry.target, { bigint: true });
        if (!stat.isDirectory() || !sameInode(stat, entry.stat)) throw changed();
      }
      if (anchored && await fs.readlink(`/proc/self/fd/${file.fd}`) !== target) throw changed();
      const named = await fs.lstat(target, { bigint: true });
      if (!named.isFile() || !sameFile(named, before)) throw changed();
    };
    await validatePath();
    const buffer = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) throw changed();
      offset += bytesRead;
    }
    if (!sameFile(before, await file.stat({ bigint: true }))) throw changed();
    await validatePath();
    return { buffer, relativePath: parts.join("/"), stat: { size: buffer.length, mtime: before.mtime } };
  } catch (cause) {
    if (cause.statusCode || cause instanceof RangeError) throw cause;
    if (["ENOENT", "ENOTDIR"].includes(cause.code)) throw error("文件不存在或路径已改变", 404, "file_not_found");
    if (["ELOOP", "EACCES", "EPERM"].includes(cause.code)) throw unsafe();
    throw error("文件暂时无法安全读取", 503, "file_read_unavailable");
  } finally {
    await Promise.all(handles.reverse().map(handle => handle.close()));
  }
}
