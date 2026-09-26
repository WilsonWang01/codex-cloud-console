import assert from "node:assert/strict";
import test from "node:test";
import { extendAutomationRoutes } from "../ops/extend-caddy-automation-routes.mjs";

const source = `example.com {
\t@automation_trigger path_regexp automation_trigger ^/api/automations/[^/]+/(webhook|heartbeat)$
\thandle @automation_trigger {
\t\treverse_proxy 127.0.0.1:8787
\t}
\thandle {
\t\tbasicauth {
\t\t\tadmin sample-hash
\t\t}
\t\treverse_proxy 127.0.0.1:8787
\t}
}

other.example.com {
\treverse_proxy 127.0.0.1:3000
}
`;

test("new automation routes are inserted before authentication without touching other sites", () => {
  const updated = extendAutomationRoutes(source);
  assert.match(updated, /@automation_result/);
  assert.match(updated, /@automation_cancel/);
  assert.ok(updated.indexOf("@automation_cancel") < updated.indexOf("\thandle {\n\t\tbasicauth"));
  assert.equal(updated.slice(updated.indexOf("other.example.com")), source.slice(source.indexOf("other.example.com")));
  assert.equal(extendAutomationRoutes(updated), updated);
  assert.throws(() => extendAutomationRoutes(source.replace("\t@automation_trigger", "\t@other_trigger")), /exactly one/);
});
