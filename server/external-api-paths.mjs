import { modelApiProtocol } from "./model-api-protocol.mjs";

// The local relay must never replace an external caller's identity with its admin credentials.
export function isExternalApiPath(pathname) {
  return Boolean(modelApiProtocol(pathname)) || /^\/api\/automations\/[^/]+\/(webhook|heartbeat|v1\/(models|capabilities)|runs\/[^/]+(?:\/cancel|\/output(?:\/files\/[^/]+)?)?)$/.test(pathname);
}
