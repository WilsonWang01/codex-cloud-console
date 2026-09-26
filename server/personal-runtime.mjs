import path from "node:path";

const defaultPersonalHome = "/var/lib/codex-personal";
const defaultSocket = "/run/codex-personal/worker.sock";

export function personalRuntimeConfig(env = process.env, platform = process.platform) {
  const mode = env.CODEX_PERSONAL_MODE || (env.NODE_ENV === "production" && env.CODEX_PERSONAL_WORKER === "1" ? "dedicated" : "shared");
  if (!["shared", "dedicated", "disabled"].includes(mode)) throw new Error("Invalid CODEX_PERSONAL_MODE");
  const enabled = mode === "dedicated";
  const home = path.resolve(env.CODEX_PERSONAL_HOME || defaultPersonalHome);
  const root = path.resolve(env.CODEX_PERSONAL_ROOT || (enabled ? path.join(home, "workspace") : ""));
  const socketPath = path.resolve(env.CODEX_PERSONAL_SOCKET || defaultSocket);
  if (enabled && platform !== "linux") throw new Error("Personal worker requires Linux systemd isolation");
  if (enabled && (home === "/" || root === home || !root.startsWith(`${home}${path.sep}`))) {
    throw new Error("Personal workspace must be below the dedicated personal home");
  }
  if (enabled && (!socketPath.startsWith("/run/codex-personal/") || socketPath === "/run/codex-personal/")) {
    throw new Error("Personal worker socket must be under /run/codex-personal");
  }
  return { mode, enabled, home, root, socketPath };
}

export function appServerRequestScope(params = {}, personalRoot = "") {
  const cwd = params.cwd;
  const paths = Array.isArray(cwd) ? cwd : cwd ? [cwd] : [];
  if (personalRoot && paths.some((entry) => entry === personalRoot)) return "personal";
  return "work";
}
