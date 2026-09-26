import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";

const triggerBlock = "\t@automation_trigger path_regexp automation_trigger ^/api/automations/[^/]+/(webhook|heartbeat)$\n\thandle @automation_trigger {\n\t\treverse_proxy 127.0.0.1:8787\n\t}\n";
const newRoutes = `\t@automation_result {
\t\tmethod GET
\t\tpath_regexp automation_result ^/api/automations/[^/]+/runs/[^/]+$
\t}
\thandle @automation_result {
\t\treverse_proxy 127.0.0.1:8787
\t}
\t@automation_cancel {
\t\tmethod POST
\t\tpath_regexp automation_cancel ^/api/automations/[^/]+/runs/[^/]+/cancel$
\t}
\thandle @automation_cancel {
\t\treverse_proxy 127.0.0.1:8787
\t}
`;

export function extendAutomationRoutes(source) {
  if (source.includes("@automation_result") || source.includes("@automation_cancel")) {
    if (source.includes("@automation_result") && source.includes("@automation_cancel")) return source;
    throw new Error("Only one external automation route is present; refusing partial update");
  }
  const first = source.indexOf(triggerBlock);
  if (first < 0 || source.indexOf(triggerBlock, first + triggerBlock.length) >= 0) {
    throw new Error("Expected exactly one existing automation trigger block");
  }
  return source.slice(0, first + triggerBlock.length) + newRoutes + source.slice(first + triggerBlock.length);
}

function adapt(configPath) {
  return JSON.parse(execFileSync("caddy", ["adapt", "--config", configPath, "--adapter", "caddyfile"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
}

function withoutAddedRoutes(config) {
  const copy = structuredClone(config);
  for (const server of Object.values(copy.apps?.http?.servers || {})) {
    for (const route of server.routes || []) {
      for (const handler of route.handle || []) {
        if (!Array.isArray(handler.routes)) continue;
        handler.routes = handler.routes.filter((child) => {
          const matcher = child.match?.[0] || {};
          return !["automation_result", "automation_cancel"].some((name) => matcher.path_regexp?.name === name);
        });
      }
    }
  }
  return copy;
}

function canonicalGroupIds(value) {
  const groups = new Map();
  const visit = (item) => {
    if (Array.isArray(item)) return item.map(visit);
    if (!item || typeof item !== "object") return item;
    return Object.fromEntries(Object.entries(item).map(([key, entry]) => {
      if (key !== "group" || typeof entry !== "string") return [key, visit(entry)];
      if (!groups.has(entry)) groups.set(entry, `group-${groups.size + 1}`);
      return [key, groups.get(entry)];
    }));
  };
  return visit(value);
}

export function assertCaddyRouteExtension(before, after) {
  if (JSON.stringify(canonicalGroupIds(withoutAddedRoutes(after))) !== JSON.stringify(canonicalGroupIds(before))) {
    throw new Error("Caddy routes outside the two new API matchers changed");
  }
  const serialized = JSON.stringify(after);
  for (const name of ["automation_result", "automation_cancel"]) {
    assert.equal(serialized.split(`"name":"${name}"`).length - 1, 1, `Missing or duplicated ${name} matcher`);
  }
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) {
  const [sourcePath, candidatePath] = process.argv.slice(2);
  if (!sourcePath || !candidatePath) throw new Error("Usage: node extend-caddy-automation-routes.mjs SOURCE CANDIDATE");
  const source = await fs.readFile(sourcePath, "utf8");
  const candidate = extendAutomationRoutes(source);
  await fs.writeFile(candidatePath, candidate, { mode: 0o600, flag: "wx" });
  assertCaddyRouteExtension(adapt(sourcePath), adapt(candidatePath));
  execFileSync("caddy", ["validate", "--config", candidatePath, "--adapter", "caddyfile"], { stdio: "ignore" });
  process.stdout.write("Caddy candidate validated; all pre-existing routes remain unchanged.\n");
}
