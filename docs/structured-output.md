# 结构化 JSON 结果

适用于实现 A03.1 的版本。部署可能落后于仓库，请先查询 `GET /api/automations/:id/v1/capabilities`，仅在 `features.structured_output=true` 时使用；文件下载仍是独立能力。这里是受限 JSON Schema（JSON 数据格式约束）适配，不是完整模型 API。

## 异步任务

在原 Webhook/Heartbeat 正文中增加 `outputSchema`，认证、事件键、排队、取消和结果路径不变：

```json
{
  "prompt": "将已审核内容提取为 answer 和 confidence；不要运行工具或修改外部数据。",
  "model": "gpt-6-sol",
  "outputSchema": {
    "type": "object",
    "properties": {
      "answer": { "type": "string" },
      "confidence": { "type": ["number", "null"] }
    },
    "required": ["answer", "confidence"],
    "additionalProperties": false
  }
}
```

提交仍返回 `queued`，不代表模型或校验完成。最终成功时 `run.structuredOutput` 包含 `status:"validated"`、`schemaSha256` 和完整 `data`。不要从可能截断的 `summary` 解析 JSON。输出来自精确原回合的最终消息，不拼接评论、工具日志或后续 Heartbeat。

实际 JSON 语法错误、字段不符或过大时，运行失败并保存 `structuredOutput.status:"invalid"` 与错误；不会去掉 Markdown 围栏、补字段、转换类型或自动重新消耗额度修复。原始结果暂不可读也不会冒充成功。调用方仍需做业务验收，结构正确不代表事实正确或外部动作已成功。

同键换格式返回 409；同键改成流式读取不重复执行。验证过的结果随运行记录保留，可跨进程重开，不再依赖后来回合的文本。仍是有界历史，不保证固定天数，调用方应及时保存；数据库及兼容 JSON 都可能包含这份业务数据。

## SDK 格式

以下字段加入原有请求即可，其他规则见[协议接入](model-api-adapters.md)：

```js
// OpenAI Chat Completions
response_format: {
  type: "json_schema",
  json_schema: { name: "extraction", strict: true, schema },
}

// OpenAI Responses
text: { format: { type: "json_schema", name: "extraction", strict: true, schema } }

// Anthropic Messages 协议；底层仍是 Codex，不调用 Claude
output_config: { format: { type: "json_schema", schema } }
```

OpenAI 要求有效 `name` 和 `strict:true`，不支持无保证的 `json_object` 模式。Anthropic 的 `max_tokens` 仍必须按原规则明确确认不应用该输出上限；结构化校验没有解决模型执行预算。

官方 SDK 的 Chat/Responses/Messages `parse()` 已在本项目固定 SDK 版本及隔离服务中验证。辅助库生成的格式仍须符合下述子集；含 `$ref/$defs` 等内容时会拒绝，不承诺所有 Zod/Pydantic 生成物直接兼容。

结构化 `stream:true` 仍建立 SSE 连接，但缓冲至完整结果通过验证后再发送 JSON，可能较晚收到首段正文；不会把尚未验证的部分 JSON 当成成功结果。失败只发错误、不发正常成功结束标记。暂不支持与 Responses 图片生成工具组合；图片输入仍可使用原有内嵌格式。

## 限制与错误

- 格式最多 16 KiB、8 层、128 个节点；根必须是对象。每个对象必须声明 `properties`、全部 `required` 和 `additionalProperties:false`；可用可空类型表达可选值。
- 支持 object、array、string、number、integer、boolean、null、类型数组、标量 enum/const、说明文字及有限的长度/数量/数字上下界。数组必须有单一 `items` 格式；enum 最多 128 个标量。
- 不支持引用、组合/条件、远程格式加载、pattern/format、正则、唯一性或任意扩展关键字；不静默忽略。使用 Ajv 严格校验，不修改结果值，编译缓存最多 32 项。
- 最终 JSON 最多 64 KiB。这是结果接收上限，**不是输出 token 或费用上限**；超出会报错，不会减少已经发生的模型消耗。
- 不支持/无效格式在启动模型前返回 400；结果语法错误为 `invalid_structured_json`、格式不符为 `invalid_structured_output`、过大为 `structured_output_too_large`、无法定位原始结果为 `structured_result_unavailable`。同步协议返回 502，异步接口保留失败运行和计量。

升级会把任务格式标记从 1 升到 2，保留原行、ID、归属和领取代次。旧格式 1 执行器不理解结构化任务，有任务数据时不能直接退回该版本。发布持锁且任务和幂等表均为空时，回退工具只将这个 JSON 字段格式标记恢复为 1；不清空数据，不对未来未知版本做通用降级。发布前仍必须一致性备份，回退保护不会覆盖新数据。

参考：[Codex 单回合 outputSchema](https://learn.chatgpt.com/docs/app-server)、[OpenAI 结构化输出](https://developers.openai.com/api/docs/guides/structured-outputs)、[Anthropic 输出格式](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)。根据 [Ajv 安全说明](https://ajv.js.org/security.html)，调用方格式需要限制大小和深度，不能把任意格式当可信代码编译。
