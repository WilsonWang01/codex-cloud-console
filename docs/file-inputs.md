# 受限内联文件输入

先查询当前部署的 `capabilities`，确认 `features.file_input.supported` 为 true，并读取 `limits.inline_attachments`、`input_buffers` 和 `task_queue`。这是首批文本/Markdown/静态图片材料输入，不是通用 Files API、可复用文件 ID 或服务器文件访问接口。旧部署可能不支持。

## 最简单的用法

先审核材料、自动化和工具权限。下列提交会消耗模型额度，附件内容会传给所选 Codex 账号处理；不要上传不允许该服务处理的数据。

```bash
node scripts/external-client-example.mjs submit my-automation report-event-20261023-001 \
  --prompt '总结附件中的事实，区分未知项，不操作第三方服务。' \
  --attach ./notes.md --attach ./screenshot.png --wait

python3 scripts/external-client-example.py submit my-automation report-event-20261023-001 \
  --prompt '总结附件中的事实，区分未知项，不操作第三方服务。' \
  --attach ./notes.md --attach ./screenshot.png --wait --timeout 300
```

两种 CLI 均只读取明确给出的普通文件，读取有大小上限；`--attach` 可重复。文件名来自本机 basename，不上传目录路径。需要指定输出 JSON 格式或产物路径时，用 `--input ./request.json` 载入完整请求对象，再加 `--attach`；`--prompt` 会明确覆盖 JSON 中的 prompt。请求 JSON 需有效 UTF-8。下载仍使用[结果交付](artifact-delivery.md)的 `output`、`download`。

事件 ID 和输入必须在业务侧保存。重试时附件内容、名称、MIME、顺序也要保持不变；材料改变会产生 409，不得为了绕过错误自动换事件键。CLI 每次读取当前文件，因此本机文件变化后不能假定重试仍与原输入相同。

## 异步 HTTP 格式

向原有 `webhook` 或 `heartbeat` JSON 正文加入 `attachments`：

```json
{
  "prompt": "读取附件中的数字，返回结论。不要操作第三方服务。",
  "model": "gpt-6-sol",
  "reasoning": "medium",
  "attachments": [
    {"name": "notes.txt", "mimeType": "text/plain", "dataBase64": "MTIz"}
  ]
}
```

`dataBase64` 是文件字节的标准 Base64，不带 data URL 前缀。仅接受 `name`、`mimeType`、`dataBase64` 三个字段，不接受路径、URL、file_id 或额外参数。文件名不可含路径、控制字符或隐藏名称，UTF-8 最多 255 字节。后缀与 MIME 必须匹配：txt/text/plain，md/text/markdown 或 text/plain，png/image/png，jpg/jpeg/image/jpeg，webp/image/webp。

文本须有效 UTF-8，可保留换行、制表符和空内容，不可含二进制控制字符；不自动猜测 GBK、UTF-16 或截断。图片复用原有标准 Base64、大小和文件头校验，完整图片解码仍由 Codex 负责。

文本材料放入独立的原生文本数据块，图片走原生 image 输入；不把文件内容混入控制台自动解析文件/Skill 提及的主请求，不把客户端文件名当作服务器路径，也不写入主仓库或隔离工作树。模型可分析材料，但不能据此声称某个本机路径已上传到云端。若需要修改文件后交付，用 `artifactPaths` 明确指定新的输出文件。

分块和提示不是防提示注入的安全沙箱。服务器原有工具/连接器权限仍生效；只接受受信任服务的已审核材料，高风险外部操作仍需具体确认。上传不会新增连接器授权、改模型默认值或开放管理接口。

运行快照的 `inputFiles` 只含序号、名称、MIME、字节数和 SHA-256，不含正文或 Base64。内容摘要参与原事件键校验；队列领取后会再次核对材料与摘要，不一致时在启动模型前失败，不静默修复或重新生成。

## 模型协议

Responses 支持 user 消息中的受限 `input_file`，仅接受 `type`、`filename`、`file_data`。`file_data` 使用 `data:text/plain;base64,...` 或 `data:text/markdown;base64,...`，文件后缀仍须匹配。不支持 file_id、file_url、detail 或 PDF。该格式来自 [OpenAI 文件输入文档](https://developers.openai.com/api/docs/guides/file-inputs)，本项目只实现上述子集，不继承官方支持的所有文件类型。

Anthropic Messages 支持 user 消息中的 `document`，`source` 只接受 `{type:"text",media_type:"text/plain",data:"内容"}`；可选 `title` 最多 255 UTF-8 字节。没有提供 title 时仍有生成的材料序号。允许明确的 `citations:{enabled:false}`，拒绝启用引用、PDF、URL、file_id、context 和缓存控制，不伪造文档引用。原格式见 [Anthropic 纯文本文档](https://platform.claude.com/docs/en/build-with-claude/citations)。底层仍是 Codex，不会改为调用 Claude。

Chat Completions 的文件块不用于传 txt/md；官方 Chat 文件块只支持 PDF，而本项目尚未实现 PDF 输入。请将文本作为普通 text 消息，或改用 Responses/异步附件。图片仍使用各协议原有的内联 image 块。

协议适配把文件转换为编号的材料描述与独立数据块，不把全文复制进运行 prompt 索引；原请求顺序、文件名和内容摘要用于区分材料。它不提供官方 Files 上传/保存服务、PDF 解析、引用坐标或浏览任意远程文件。

## 限额和留存

- 一个请求的文件和图片材料合计最多 8 份；文本最多 4 份、每份 64 KiB、合计 128 KiB。图片单份最多 4 MiB、合计 8 MiB。主 prompt 仍不超过 64 KiB。超限直接拒绝，不截断后假装成功。
- 只接收未压缩的 application/json，正文最多 12 MiB；先鉴权再读取。接收/持久化缓冲全局最多 2 份、每调用方 1 份，忙时 429 / Retry-After:1。连接阶段超过 30 秒会关闭；接收结果不明时仍须保持原事件键查询，不等于后台绝未接收。
- HTTP 接收名额在实际接收结束后释放，并清除请求对象中的材料引用，不随同步模型等待长期持有；原生执行本身仍可能占用材料内存，不承诺进程内存硬上限。断开的调用方不能提前释放仍在读取或持久接收的材料；未结束的接收仍占名额，避免故障时无限堆积。
- 已鉴权但在 JSON/缓冲阶段被拒绝的请求，使用原请求类别计入现有调用指标，不计为已接受任务或模型用量；没有身份的认证失败不能归到某个调用方。完整指标展示仍以“调用与用量”页当前支持范围为准。
- 待执行与执行中的完整 JSON 材料另限每任务 12 MiB、全局 128 MiB、每调用方 32 MiB，按实际序列化 UTF-8 字节计算，包括 prompt、格式约束及图片等执行载荷。拒绝时没有接收新任务；排队、运行、取消中都计入，重放不重复占用。
- 队列材料与调用方、自动化、运行和事件键一起持久保存，未领取的任务重启后可继续使用；有明确终态后清除队列执行载荷。已领取进程丢失仍进入待核对，不自动重放。数据库空闲页会复用，不承诺立即缩小或物理擦除；Codex 原始会话、已存在备份及成功交付的结果另有留存，不自动删除。
- 这是输入和存储上限，不是 token 或费用硬上限。大材料仍可能产生较高模型消耗；`max_tokens` 不能作为 Codex 执行预算。

常见拒绝：401 认证问题；400 格式/编码错误；409 同键输入变化；413 大小超限；415 类型、MIME、压缩或 Content-Type 不支持；429 接收缓冲/队列/材料容量或频率受限；503 存储或摘要核对异常。无论超时还是失败，都先核对原任务，不自动重发外部动作。

升级使用任务格式 4，需按安全发布流程备份并验证 SQLite 和 state。旧格式 1/2/3 的记录与执行凭据保留；一旦新任务产生数据，不能直接退回不理解新材料的旧执行器，也不能用旧备份覆盖新任务。现有接口路径不变，无需另开公网文件上传路径。
