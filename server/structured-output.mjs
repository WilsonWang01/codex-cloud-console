import Ajv from "ajv";
import { createHash } from "node:crypto";

export const structuredOutputLimits = Object.freeze({ schemaBytes: 16384, schemaDepth: 8, schemaNodes: 128, outputBytes: 65536 });
const keywords = new Set(["type", "title", "description", "properties", "required", "additionalProperties", "items", "enum", "const", "minLength", "maxLength", "minItems", "maxItems", "minimum", "maximum"]);
const types = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const object = value => value && typeof value === "object" && !Array.isArray(value);
const error = (message, code = "unsupported_output_schema", statusCode = 400) => Object.assign(new Error(message), { code, statusCode, param: "outputSchema" });
const ajv = new Ajv({ strict: true, allErrors: false, allowUnionTypes: true, ownProperties: true });
const validators = new Map();

export function normalizeOutputSchema(value) {
  if (value === undefined || value === null) return null;
  let json;
  try { json = JSON.stringify(value); } catch { throw error("输出格式必须是有限 JSON 对象"); }
  if (!json || Buffer.byteLength(json) > structuredOutputLimits.schemaBytes) throw error("输出格式超过 16 KiB");
  const schema = JSON.parse(json);
  let nodes = 0;
  function visit(node, depth) {
    if (!object(node) || depth > structuredOutputLimits.schemaDepth || ++nodes > structuredOutputLimits.schemaNodes) throw error("输出格式最多 8 层、128 个节点");
    if (Object.keys(node).some(key => !keywords.has(key))) throw error("输出格式含不支持的关键字；引用、组合、正则和 format 暂不支持");
    const declared = Array.isArray(node.type) ? node.type : [node.type];
    if (!declared.length || declared.some(type => !types.has(type))) throw error("输出格式需要明确的 JSON 类型");
    if (declared.includes("object")) {
      if (!object(node.properties) || node.additionalProperties !== false || !Array.isArray(node.required) ||
          Object.keys(node.properties).length !== node.required.length || Object.keys(node.properties).some(key => !node.required.includes(key))) {
        throw error("每个对象必须声明 properties、全部 required 和 additionalProperties:false；可用 null 表示可选值");
      }
      for (const child of Object.values(node.properties)) visit(child, depth + 1);
    }
    if (declared.includes("array")) visit(node.items, depth + 1);
    if (node.enum !== undefined && (!Array.isArray(node.enum) || node.enum.length > 128 || node.enum.some(item => item !== null && typeof item === "object"))) throw error("enum 只支持最多 128 个标量值");
    if (node.const !== null && typeof node.const === "object") throw error("const 只支持标量值");
  }
  if (!object(schema) || schema.type !== "object") throw error("输出格式根节点必须是 object");
  visit(schema, 1);
  compile(schema, json);
  return schema;
}

function compile(schema, json = JSON.stringify(schema)) {
  let validate = validators.get(json);
  if (validate) return validate;
  try { validate = ajv.compile(schema); }
  catch { throw error("输出格式无效或包含不能执行的约束"); }
  // Retain only a bounded application cache, not every caller schema in Ajv's cache.
  ajv.removeSchema(schema);
  if (validators.size >= 32) validators.delete(validators.keys().next().value);
  validators.set(json, validate);
  return validate;
}

export function validateStructuredOutput(schema, text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > structuredOutputLimits.outputBytes) throw error("结构化结果超过 64 KiB 或不是文本", "structured_output_too_large", 502);
  let data;
  try { data = JSON.parse(text); } catch { throw error("模型结果不是有效 JSON，未返回结构化成功", "invalid_structured_json", 502); }
  const validate = compile(schema);
  if (!validate(data)) throw error("模型 JSON 不符合请求格式，未返回结构化成功", "invalid_structured_output", 502);
  return { status: "validated", schemaSha256: createHash("sha256").update(JSON.stringify(schema)).digest("hex"), data };
}

export function structuredTurnText(thread, turnId) {
  const turn = thread?.turns?.find(item => item.id === turnId);
  if (!turn || !Array.isArray(turn.items)) throw error("原始回合结果不可读，未验证结构化结果", "structured_result_unavailable", 502);
  const messages = turn.items.filter(item => item.type === "agentMessage");
  const final = messages.filter(item => item.phase === "final_answer");
  const selected = final.length ? final : messages.filter(item => !item.phase);
  if (selected.length !== 1 || typeof selected[0].text !== "string") throw error("无法唯一定位原回合的最终 JSON", "structured_result_unavailable", 502);
  return selected[0].text;
}
