# MCP 规范合规:基准、差距与升级路径

c3 的 MCP 服务面由 7 条回环内部路由与 1 条公开路由组成,全部走 Streamable HTTP。本文以 MCP 规范
`2026-07-28` 为基准,给出这 8 条路由的合规现状、差距分级与 SDK 升级路径。

工具面语义、授权模型与安全边界由 [external-mcp](../external-mcp/external-mcp-spec.md) 与
[ADR-0044](../../../architecture/adr/0044-external-mcp-owner-scope-and-unified-endpoint.md) 定义,
本文只谈**协议层合规**,不复述那些结论。

## 基准与快照

审计基准锚定在一组外部版本上,它们决定结论的有效期:

- **规范基准**: MCP `2026-07-28`。该版本把协议核心改为无会话的请求-响应模型,并从 Streamable HTTP
  传输中移除 `Mcp-Session-Id`;`tools/list` 等列表端点不再随连接变化,故可缓存;Tasks 移入
  `io.modelcontextprotocol/tasks` 扩展;Roots / Sampling / Logging 与 Dynamic Client Registration
  转为弃用但至少保留十二个月;HTTP+SSE 旧传输进入一年下线期。
- **服务端 SDK**: `@modelcontextprotocol/sdk` 声明 `^1.29.0`,lockfile 解析 `1.29.0`。
- **SDK 可协商版本**: `LATEST_PROTOCOL_VERSION = 2025-11-25`,
  `SUPPORTED_PROTOCOL_VERSIONS = [2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07]`,
  **不含 `2026-07-28`**。
- **官方 TypeScript 线路**: v2 拆包为 `@modelcontextprotocol/server` / `client` / `node` 及框架集成,
  HTTP 入口为 `createMcpHandler`。迁移指南明确 **v1.x 无法服务或讲 `2026-07-28`**。
- **快照记录日期**: 2026-09-01。基准版本号是审计的构成要件而非变更叙述;文档的维护触发条件见末章。

### 服务端协商实测

对 `WebStandardStreamableHTTPServerTransport` 按 c3 的构造参数复现,观测到的 wire 行为:

| 客户端 `initialize` 请求版本 | HTTP | 服务端应答版本 |
| ---------------------------- | ---- | -------------- |
| `2026-07-28`                 | 200  | `2025-11-25`   |
| `2025-11-25`                 | 200  | `2025-11-25`   |
| `2025-06-18`                 | 200  | `2025-06-18`   |
| `2025-03-26`                 | 200  | `2025-03-26`   |

握手后 `MCP-Protocol-Version` 请求头的处理:

| 头值         | HTTP | 结果                                  |
| ------------ | ---- | ------------------------------------- |
| `2026-07-28` | 400  | `-32000 Unsupported protocol version` |
| `2025-11-25` | 200  | 正常                                  |
| `2025-06-18` | 200  | 正常                                  |
| 缺省         | 200  | 正常                                  |

三条要点:

- `initialize` 请求**豁免**该头校验,故握手不会因协议版本头被拒;未知版本回退到 `2025-11-25` 而非报错。
- 握手后该头走白名单校验。遵守协商结果的客户端发 `2025-11-25` 通过;无视协商结果坚持发 `2026-07-28`
  的客户端,其**全部后续请求** 400。
- 不带 `Mcp-Session-Id` 的非 `initialize` 请求(`2026-07-28` 无会话客户端的形态)得到
  `400 Server not initialized`。

`GET` SSE 流返回 `200 text/event-stream`,`DELETE` 会话终止返回 `200`。

### 客户端支持快照

| 客户端      | `2026-07-28` 支持       | 验证状态                  |
| ----------- | ----------------------- | ------------------------- |
| Codex       | 支持,opt-in,默认 legacy | 已核实,c3 未开启          |
| Claude Code | 支持,含协商降级         | 间接证据,无对 c3 握手实测 |
| Cursor      | 无公开证据              | **验证缺口**              |

- **Codex**: `mcp_2026_07_28` 为可选模式,stdio server 须以 `CODEX_MCP_PROTOCOL_VERSION=2026-07-28`
  显式开启。本地 SDK 升级评估记录确认 c3 不开启该协议,注入形状不变,走既有协议版本。
  `transport/intent-mcp/e2e.codex.test.ts` 覆盖的是默认 legacy 路径。
- **Claude Code**: 现场记录显示其支持 `2026-07-28` / `2025-11-25` / `2025-06-18` / `2025-03-26`,
  并对回显其未识别版本的 server 直接拒绝连接。c3 回显的 `2025-11-25` 落在该列表内,故协商成立;
  但这是推论,不是对 c3 `/mcp` 的握手实测。
- **Cursor**: 截至快照日期未见其支持 `2026-07-28` 的官方声明,实际协商版本与对 `2025-11-25` 回显的
  反应均未实测。该缺口在差距矩阵中按 Should 记录,不作为兼容性证据使用。

## 路由对照

8 条路由统一使用 `WebStandardStreamableHTTPServerTransport`(均设 `sessionIdGenerator` 与
`enableJsonResponse: true`),挂载于 SPA catch-all 之前。工具注册分两条构造面。

**声明式构造面** —— 7 条内部路由取 `McpServer` + `registerTool`,回环 guard 加 per-run token,
未知或过期 token 一律 404。协议行为完全由 SDK 决定,故协商版本与上表一致。

| 路由                           | 调用方与令牌粒度      | 工具面                                            |
| ------------------------------ | --------------------- | ------------------------------------------------- |
| `/internal/intent-mcp/v1`      | 会话 run              | `find_intents` `view_intent` `save_intents`       |
| `/internal/event-mcp/v1`       | 会话 run              | `publish_event` `memory_search` `memory_write`    |
| `/internal/automation-mcp/v1`  | 自动化 execution      | 按 binding 动态构建                               |
| `/internal/robot-mcp/v1`       | IM 机器人 turn        | 按勾选子集动态构建                                |
| `/internal/advisor-mcp/v1`     | 队列顾问 consultation | 顾问工具组                                        |
| `/internal/spec-query-mcp/v1`  | spec 撰写 run         | `find_intents` `view_intent`                      |
| `/internal/spec-review-mcp/v1` | spec 审核 run         | `find_intents` `view_intent` `submit_spec_review` |

**手写构造面** —— `/mcp` 取低层 `Server` + `setRequestHandler(ListToolsRequestSchema | CallToolRequestSchema)`,
并挂 `onsessioninitialized` / `onsessionclosed` 维护会话台账。逐调用 `authorizeCall`、写审计先行与稳定
`forbidden` 语义直接编在请求处理里。协议版本行为同样由 SDK 决定,与内部路由无差异。

与 `2026-07-28` 的差异对全部 8 条路由是同一条:SDK 不认识该版本,协商落在 `2025-11-25`。差异不按路由
分化,按构造面分化的是**迁移成本**,见升级路径评估。

## 差距矩阵

判定口径:Must-fix = 违反规范 MUST 且真实客户端可观察失败,或构成安全 / support 窗口风险;
Should = 规范 SHOULD、体验级、文档-实现漂移、升级成本积累;Deliberate-won't = 产品选择。

### 协议版本协商 — Should

服务端以 `2025-11-25` 应答请求 `2026-07-28` 的客户端,HTTP 200,握手成立。规范要求客户端在协商后携带
协商结果,合规客户端因此发 `2025-11-25` 并正常工作。**未观察到失败**,故不构成 Must-fix。

但 v1.x 在能力上无法讲 `2026-07-28`,这是确定的能力缺口而非当前故障。且缺少对 `2026-07-28` 客户端的
握手实测——Cursor 的行为完全未验证。按证据规则,该验证缺口本身按 Should 记录,不用于免除任何判定。

### Streamable HTTP 传输 API — Should

`WebStandardStreamableHTTPServerTransport` 的 POST / GET SSE / DELETE 三种语义均正常。v2 的
`createMcpHandler` 是未来形态,其 `legacy: 'stateless'` 默认同时服务 2025 与 2026 两个纪元。当前无
功能缺失,差距是升级成本的积累。

### tools/list + call 语义 — Should

- **分页**: 内部 7 条路由的分页由 SDK 处理;`/mcp` 的手写 handler 既不读 `cursor` 入参也不返回
  `nextCursor`,一次性返回全部已授权工具。工具总数十余个,不构成实际问题。
- **工具注解**: 目录里的 `access: 'read' | 'write'` 是 c3 内部分级,未映射为协议的
  `readOnlyHint` / `destructiveHint`。SDK 已支持这些字段,映射是纯增量的体验改进。
- **`listChanged`**: 服务端声明 `capabilities: { tools: {} }`,不声明该通知能力。这与
  external-mcp 规格「`listChanged` 只是体验优化,不构成授权或新鲜度边界」一致。
- **发现面 = 执行面**: `tools/list` 与调用闸门读同一次求解结果,未授权工具不出现在列表且直调得稳定
  `forbidden`。该保证由 c3 自己的 handler 提供,不依赖 SDK,在任何 SDK 版本下都须原样保持。

### structured output — Deliberate-won't

全部工具返回 `content: [{ type: 'text' }]`,正文多为 JSON 字符串。SDK 1.29.0 已支持 `outputSchema`
与 `structuredContent`,c3 未采用。这是产品选择:工具契约以文本 JSON 表达,调用方无需 schema 协商即可
消费。规范不要求服务端提供结构化输出,客户端也不能强制要求,故不构成 gap。

### session 钉定 — Should(v2 迁移的结构性阻塞项)

现状合规:`Mcp-Session-Id` 由 SDK 颁发与校验,`/mcp` 在其之上叠加 `(keyId, secretVersion,
workspaceName, policyEpoch)` 四元组,未知、异主、版本或 epoch 失配一律 404,并支持按 key / 按归属的
强制清场。

`2026-07-28` 移除会话与 `Mcp-Session-Id`。这不影响当前客户端(协商停在 2025 纪元,客户端仍用会话),
故不是 Must-fix;但它是路径 B 中**唯一的非机械改造**,须单列:

- **授权语义反而契合**。`/mcp` 已经每请求重新认证、重新求交、重新比对 epoch,不复用上一次决策。无会话
  模型下这套逻辑原样成立。
- **真正丢失的是清场契约**。`closeSessionsForKey` / `closeSessionsForOwner` 依赖「有连接可关」。无会话
  时没有连接可关,但新鲜度由每请求的 epoch 比对保证,安全性等价——差别在于失效的表达方式从「断开连接」
  变为「下一次请求即拒绝」,这需要在规格中重新表述,而不是在代码中重建会话。
- **`X-C3-Workspace` 的钉定时机要重新定义**。现在它在 `initialize` 时选定并钉死会话;无 `initialize`
  时它退化为每请求头,「带不同值是 re-scope 尝试」这条规则失去锚点,须改写为逐请求求交。

### 工具结果 content 类型 — Deliberate-won't

`text` content 与 `isError` 在 `2026-07-28` 仍然有效,未被移除或弃用。`forbidden` 的稳定措辞是 c3 的
产品语义——它刻意让「工具未授权」与「目标越权」逐字相同以防探测,不受协议演进影响。

### 结论:无 Must-fix

八条路由中没有一项达到 Must-fix。判据是:握手在全部实测版本下成立,现有客户端无可观察失败,且不存在
凭据或授权语义随协议版本漂移的路径。

兼容性证据:

- `server/src/transport/external-mcp/index.test.ts` 与 `e2e.test.ts` 以 `2025-06-18` 完成 initialize
  并走完鉴权链与工具调用;`server/src/transport/intent-mcp/e2e.codex.test.ts` 用真实 codex 二进制完成
  发现与调用。`transport/external-mcp`、`transport/intent-mcp` 与 `features/external-mcp` 全部单测通过
  (6 文件 159 用例)。
- 服务端协商实测(见前)覆盖 `2026-07-28` 请求的降级路径。

证据的边界必须一并声明:**上述全部证据来自 2025 纪元客户端**。没有任何一条证明 `2026-07-28` 客户端能
与 c3 互操作。"无 Must-fix" 的准确含义是"当前客户端群体下无可观察失败",不是"已对新规范兼容"。

## SDK 升级路径

### 路径 A — 留在 v1.x

升级到最新 1.x 不能带来 `2026-07-28`:该协议版本在 v1 线路上不存在。A 的实际收益是安全补丁与
`2025-11-25` 的既有支持,成本接近零。

适用条件:主流客户端仍以 2025 纪元协商,且 v1 support 窗口未关闭。

### 路径 B — 迁移到 v2

替换为 `@modelcontextprotocol/server` 并以 `createMcpHandler(factory)` 提供 HTTP 入口。默认
`legacy: 'stateless'` 同时服务两个纪元,故迁移不必以放弃现有客户端为代价。

两处硬性 API 变化决定工作量分布:

- `WebStandardStreamableHTTPServerTransport` 直接映射为 `createMcpHandler(factory, { legacy: 'stateless' })`,
  不再需要 `sessionIdGenerator`,handler 按请求构建服务端实例。
- **`setRequestHandler(Schema, ...)` 的 schema 键形式被移除**。只有 `/mcp` 用这种形式,它必须改写为
  `registerTool` 或显式方法名形式。7 条内部路由用的 `registerTool` 在 v2 中保留。

### 受影响模块

| 模块                                                  | 触点                                        | 量级 |
| ----------------------------------------------------- | ------------------------------------------- | ---- |
| 7 条内部 `transport/*-mcp/`(各 `index.ts` + 测试)     | import 面与构造参数映射,`registerTool` 保留 | S    |
| `transport/external-mcp/index.ts`                     | 手写 handler 改写 + 会话模型重新表述        | L    |
| `transport/external-mcp/index.test.ts`、`e2e.test.ts` | 随 wire 契约与会话语义变化                  | M    |
| `features/external-mcp/` 及其测试                     | 仅在 wire 契约变化时受影响                  | M    |
| agent 适配层三个驱动 + 测试                           | 仅当配置形状或 opt-in flag 变化             | S    |
| `server/src/server.ts`                                | 挂载点 import 面                            | S    |

`transport/external-mcp` 定为 L 而非 M:它不只是 API 形状替换,还要在无会话模型下重新表达四元组钉定与
强制清场契约(见 session 维度),这是设计工作而非机械替换。逐调用 `authorizeCall`、写审计先行与
`forbidden` 语义必须逐条保持,是该项的验收核心。

`@ccc/shared` 不受影响:MCP SDK 不进共享协议面。中性描述符 `RemoteMcpServer` 不 import MCP SDK,
是三个驱动与 SDK 版本之间的天然隔离面;它输出的是 URL 与工具名子集,与协议版本解耦。

## 路线图

**Phase 0 — 声明协议版本**。无触发条件,即时可做。在本文与 external-mcp 规格中声明服务端实际协商的
版本与已知缺口,使外部接入方不必靠试错发现。验收:两处文档的协议版本声明一致且与实测相符。

**Phase 1 — v1 兼容补丁**。触发条件:发现 v1 内可低成本修复的 Must-fix,或 1.x 发布安全补丁。当前
无 Must-fix,故本阶段暂无工作项。验收:补丁后既有单测与 e2e 全绿。

**Phase 2 — v2 迁移**。触发条件满足其一即启动:主流客户端开始默认以 `2026-07-28` 协商;v1 support
窗口公布关闭;出现 v1 无法修复的安全问题。分两步——先迁 7 条内部路由(S,验证 `registerTool` 等价性),
再迁 `/mcp`(L,先完成会话语义的规格重写再动代码)。验收:两个纪元的客户端均可完成发现与调用,
且授权、审计与拒绝语义逐条不变。

## 文档漂移

审计中发现的规格-实现不一致,均为 Should 级,本文不实施修正:

- **「内部六条路由」应为七条**。`spec-review-mcp` 未计入。出现位置:
  `doc/domains/core/external-mcp/external-mcp-spec.md`、`doc/architecture/architecture.md`、
  `doc/non-functional/security.md`、ADR-0044(三处)、以及 `transport/external-mcp/index.ts` 的文件头
  注释。ADR 作为决策记录保留原文,其余按现状订正为七条。
- **协议版本未声明**。external-mcp 规格描述了 `Mcp-Session-Id` 与会话钉定,但未声明服务端协商到哪个
  协议版本。Phase 0 补齐。

其余核对项与实现一致,包括:`/mcp/<任何东西>` 一律 404;503 → 404 → 401 → 400 → 403 的拒绝分层;
工作区头的空 / 重复 / 超长判定;四元组钉定与未知、异主会话的同一 404;`listChanged` 仅为体验优化;
拒绝响应不回显凭据。

## 维护

本文在以下任一情形发生时重新核对:MCP 规范发布新版本;`@modelcontextprotocol/sdk` 的
`SUPPORTED_PROTOCOL_VERSIONS` 变化;v2 线路正式 GA 或 v1 support 窗口公布关闭;主流客户端弃用
`2025-06-18` 或默认以 `2026-07-28` 协商。核对时须重跑协商实测并更新客户端支持快照。
