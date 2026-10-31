import fs from "node:fs/promises";
import { constants } from "node:fs";
import { createHash, createHmac } from "node:crypto";
import { BlockList, isIP } from "node:net";
import { Resolver } from "node:dns/promises";
import https from "node:https";
import path from "node:path";
import { callbackLimits } from "./external-callback-store.mjs";

// Exclude special-purpose/transition networks, including some globally reachable exceptions.
const blocked = new BlockList(), globalV6 = new BlockList();
for (const cidr of ["0.0.0.0/8","10.0.0.0/8","100.64.0.0/10","127.0.0.0/8","169.254.0.0/16","172.16.0.0/12","192.0.0.0/24","192.0.2.0/24","192.88.99.0/24","192.168.0.0/16","198.18.0.0/15","198.51.100.0/24","203.0.113.0/24","224.0.0.0/4","240.0.0.0/4"]) {
  const [address, prefix] = cidr.split("/"); blocked.addSubnet(address, Number(prefix), "ipv4");
}
globalV6.addSubnet("2000::", 3, "ipv6");
for (const [address, prefix] of [["2001::",23],["2001:db8::",32],["2002::",16],["3fff::",20]]) blocked.addSubnet(address,prefix,"ipv6");
export const publicCallbackAddress = address => typeof address !== "string" ? false : isIP(address) === 4 ? !blocked.check(address,"ipv4")
  : isIP(address) === 6 && globalV6.check(address,"ipv6") && !blocked.check(address,"ipv6");
const failure = (code, retryable = false) => Object.assign(new Error("回调未交付；请轮询原任务"), { code, retryable });

function targetUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw failure("target_invalid"); }
  if (typeof value !== "string" || value.length > 2048 || url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      url.port && url.port !== "443" || isIP(url.hostname.replace(/^\[|\]$/g,"")) || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(url.hostname) || /(?:^|\.)(?:localhost|local|internal)$/i.test(url.hostname)) throw failure("target_invalid");
  return url;
}

export async function readCallbackTargets(file, env = process.env) {
  if (!file) return callbackTargets([], env);
  if (typeof file !== "string" || !path.isAbsolute(file)) throw failure("target_config_invalid");
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > 64 * 1024 || before.mode & 0o077) throw failure("target_config_invalid");
    const bytes = Buffer.alloc(before.size + 1), read = await handle.read(bytes,0,bytes.length,0), after = await handle.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || read.bytesRead !== before.size) throw failure("target_config_changed");
    let config;
    try { config = JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes.subarray(0,read.bytesRead))); }
    catch { throw failure("target_config_invalid"); }
    return callbackTargets(config, env);
  } finally { await handle.close(); }
}

export function callbackTargets(config, env = process.env) {
  if (!Array.isArray(config) || config.length > 32) throw failure("target_config_invalid");
  const entries = new Map(), bindings = new Map();
  for (const item of config) {
    if (!item || ["id","clientId","automationId","url","secretEnv"].some(key => typeof item[key] !== "string") || Object.keys(item).some(key => !["id","clientId","automationId","url","secretEnv"].includes(key)) ||
        !/^[a-zA-Z0-9_-]{1,80}$/.test(item.id || "") || !/^[a-zA-Z0-9_-]{1,160}$/.test(item.clientId || "") ||
        ["legacy-shared","local-development"].includes(item.clientId) || !/^[a-zA-Z0-9_-]{1,160}$/.test(item.automationId || "") ||
        !/^CODEX_CLOUD_CALLBACK_SECRET_[A-Z0-9_]{1,64}$/.test(item.secretEnv || "")) throw failure("target_config_invalid");
    const url = targetUrl(item.url).href, secret = env[item.secretEnv];
    if (typeof secret !== "string" || Buffer.byteLength(secret) < 32 || Buffer.byteLength(secret) > 256 || /[\x00-\x1f\x7f]/.test(secret)) throw failure("target_secret_invalid");
    const key = JSON.stringify([item.clientId,item.automationId]);
    if (entries.has(item.id) || bindings.has(key)) throw failure("target_config_duplicate");
    const fingerprint = createHash("sha256").update(JSON.stringify([item.id,item.clientId,item.automationId,url,secret])).digest("hex");
    entries.set(item.id, { ...item, url, secret, fingerprint }); bindings.set(key,item.id);
  }
  return {
    count: entries.size,
    binding(clientId, automationId) { const entry = entries.get(bindings.get(JSON.stringify([clientId,automationId]))); return entry ? { id: entry.id, fingerprint: entry.fingerprint } : null; },
    resolve(claim) { const entry = entries.get(claim.target_id); return entry && entry.fingerprint === claim.fingerprint && entry.clientId === claim.client_id && entry.automationId === claim.automation_id ? entry : null; },
  };
}

async function callbackAddresses(hostname, signal) {
  const resolver = new Resolver({ timeout: 2000, tries: 1 });
  const cancel = () => resolver.cancel(); signal.addEventListener("abort", cancel, { once: true });
  try {
    const addresses = [];
    for (const method of ["resolve4","resolve6"]) {
      signal.throwIfAborted();
      try { addresses.push(...await resolver[method](hostname)); }
      catch (error) { if (error.code !== "ENODATA") throw failure("dns_unavailable", true); }
    }
    return addresses;
  } finally { signal.removeEventListener("abort", cancel); resolver.cancel(); }
}

export const callbackSignature = (body, secret, timestamp) => "v1=" + createHmac("sha256",secret).update(`${timestamp}.${body}`).digest("hex");

export async function deliverCallback(claim, target, { authorize, resolve = callbackAddresses, request = https.request, now = () => Date.now() } = {}) {
  const signal = AbortSignal.timeout(callbackLimits.timeoutMs);
  try {
    const url = targetUrl(target.url), addresses = await resolve(url.hostname,signal);
    signal.throwIfAborted();
    if (!Array.isArray(addresses) || !addresses.length || addresses.length > 32 || addresses.some(address => !publicCallbackAddress(address))) throw failure("target_address_rejected");
    await authorize(); signal.throwIfAborted();
    const address = addresses[0], family = isIP(address), timestamp = String(Math.floor(now()/1000));
    const code = await new Promise((resolveStatus,reject) => {
      const req = request(url, { method: "POST", agent: false, family, autoSelectFamily: false, signal,
        lookup(_host, options, done) { done(null, options.all ? [{ address,family }] : address, family); },
        headers: { "content-type":"application/json", "content-length":Buffer.byteLength(claim.body),
          "x-codex-event-id":claim.event_id, "x-codex-timestamp":timestamp, "x-codex-signature":callbackSignature(claim.body,target.secret,timestamp) },
      }, response => { resolveStatus(response.statusCode || 0); response.destroy(); });
      req.once("error",reject); req.end(claim.body);
    });
    return { ok: code >= 200 && code < 300, code: `http_${code}`, retryable: code === 408 || code === 429 || code >= 500 };
  } catch (error) {
    return signal.aborted ? { ok:false, code:"delivery_timeout", retryable:true }
      : { ok:false, code: error.retryable !== undefined ? error.code : "network_unavailable", retryable: error.retryable ?? true };
  }
}

export function createCallbackDispatcher({ store, targets, authorize, send = deliverCallback }) {
  let busy = false;
  return async () => {
    if (busy) return;
    busy = true;
    try {
      const claim = store.claim();
      if (!claim) return;
      const target = targets.resolve(claim);
      const check = async () => {
        try { await authorize(claim.client_id,claim.automation_id); }
        catch (error) { throw failure(error.statusCode === 403 ? "client_inactive" : "authentication_unavailable", error.statusCode !== 403); }
      };
      let outcome;
      try {
        if (!target) throw failure("target_changed");
        await check();
        outcome = await send(claim,target,{ authorize: check });
      } catch (error) { outcome = { ok:false, code:error.code || "delivery_unavailable", retryable:error.retryable ?? true }; }
      store.finish(claim,outcome);
    } finally { busy = false; }
  };
}
