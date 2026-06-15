# Codex SDK 架构指南

> 面向开发者与 AI：解释 c3 所依赖的 `@openai/codex-sdk`（TypeScript）
> 是什么、其架构与 Claude Agent SDK 的关键差异、数据存在哪里、如何读取 Skill，
> 以及 c3 如何在 Adapter 层封装它。
>
> - **适用版本**：`@openai/codex-sdk@0.137.0`（见 `server/package.json`，精确锁定）。
> - **官方文档**：<https://developers.openai.com/codex/sdk>
> - **源码仓库**：<https://github.com/openai/codex/tree/main/sdk/typescript>
> - **Python 对应**：`pip install openai-codex`，控制 app-server 二进制；本文档仅覆盖 TypeScript SDK。
> - 与 c3 的关系见 [`architecture.md`](architecture.md)（`adapters/codex/` 封装 `runStreamed()`）。

> **关于本指南的定位**：c3 使用 `@openai/codex-sdk`（OpenAI Codex）、`@anthropic-ai/claude-agent-sdk`（Claude）
> 和 `@opencode-ai/sdk`（OpenCode）。三者分别封装在各 adapters 目录中。本指南描述 Codex SDK 的架构、
> 与 Claude SDK 的关键差异，以及 c3 如何通过这些差异构建中性驱动层。
> 对应指南见 [`claude-agent-sdk-guide.md`](claude-agent-sdk-guide.md)。

## 1. 它是什么架构

**子进程包装架构（subprocess wrapper），与 Claude 同族但更受限。** SDK 把 `codex` CLI
二进制作为子进程拉起，通过 stdin/stdout 上的 **JSON-lines 事件协议**单向通信。
与 Claude SDK 的根本区别在于：**stdin 在 prompt 发送后立即关闭**，因此不存在"写回半通道"
（no write-back half-channel）——事件流是**只读的**，仅有的运行时控制是全局 `AbortSignal`。

```
┌─────────────────────────────────┐
│  你的 Node 进程                  │
│                                 │
│  new Codex(options)             │
│    .startThread(opts)           │  ── 返回 Thread 句柄
│    .runStreamed(prompt)         │
│        │                       │
│        │  spawn + JSON over stdio
│        │  (stdin dispatch → end)
│        ▼                       │
│  ┌─────────────────────────┐    │
│  │ codex CLI 子进程          │───┼──► OpenAI API / 自定义 provider
│  │ - `codex exec --json`    │   │    (Responses API, 非 Chat Completions)
│  │ - 一次 turn 运行         │   │
│  │ - 工具执行               │   │
│  │ - stdin 用完即关         │   │
│  └─────────────────────────┘    │
│        │                       │
│        ▼ 只读事件流            │
│  AsyncGenerator<ThreadEvent>   │
└─────────────────────────────────┘
```

### SDK 三层类结构

| 层级            | 类/角色                                                     |
| --------------- | ----------------------------------------------------------- |
| **`Codex`**     | 入口点；创建或恢复 `Thread` 实例，持有全局配置              |
| **`Thread`**    | 管理会话状态、turn 执行、threadId 追踪                      |
| **`CodexExec`** | 底层引擎：spawn CLI 进程、序列化配置、处理 stdin/stdout I/O |

### `runStreamed()` 入口

```ts
const codex = new Codex(options)
const thread = codex.startThread(threadOptions)
const { events } = await thread.runStreamed('your prompt', { signal })
```

- `events` 是 `AsyncGenerator<ThreadEvent>`（`for await` 消费）。
- 另有 `thread.run(prompt)` 原子模式（返回 `Turn`，缓冲所有事件直到 turn 结束）。
- **无查询级别的 `interrupt()` 方法**（与 Claude 不同）。全局 `AbortSignal` 是唯一的运行时中断。

### c3 的封装

c3 在 `server/src/kernel/agent/adapters/codex/driver.ts` 中：

1. 将 `Codex` 构造注入（`CodexFactory` 类型，测试注入 fake，生产用真实 SDK）。
2. 将 `startThread` / `resumeThread` 的配置映射到 c3 中性的 `ActionMode × ToolGate` 网格。
3. 通过 `CanonicalQueue`（push/close/fail 桥）将 `AsyncGenerator<ThreadEvent>` 转为 c3 的
   `AsyncIterable<CanonicalMessage>`，供上层消费。
4. 在 turn 结束时自动清理 per-run 资源（如 relay token 绑定）。

### 事件类型（ThreadEvent 判别联合）

| `type`           | 含义                                  |
| ---------------- | ------------------------------------- |
| `thread.started` | 新线程初始化；内含 `thread_id`        |
| `item.started`   | 某 ThreadItem 开始产生                |
| `item.updated`   | 该 item 的状态/内容更新               |
| `item.completed` | item 完成（携带最终结果）             |
| `turn.completed` | turn 结束；携带 `Usage`（token 统计） |
| `turn.failed`    | turn 终端错误                         |
| `error`          | 流层面的非终端错误                    |

**ThreadItem 类型**（经 `itemToCanonical` 翻译）：

| ThreadItem `type`   | 规范名           | 映射为 CanonicalBlock                    |
| ------------------- | ---------------- | ---------------------------------------- |
| `agent_message`     | 文本回复         | `text` 块                                |
| `reasoning`         | 推理内容         | `thinking` 块                            |
| `command_execution` | shell 命令       | `tool_use` name=`"shell"`                |
| `file_change`       | 文件修改         | `tool_use` name=`"apply_patch"`          |
| `mcp_tool_call`     | MCP 工具调用     | `tool_use` name=`"<server>/<tool>"`      |
| `web_search`        | 网络搜索         | `tool_use` name=`"web_search"`           |
| `todo_list`         | 任务列表快照     | **null**（无规范对应，分流到 TaskStore） |
| `error`             | 非致命 item 错误 | `text` 块 + vendorExtra                  |

> 与 Claude 不同，Codex 的 item 本身**不携带 `role`**——c3 翻译器合成 `role: 'assistant'`。
> 每一帧携带同一个 `item.id`，上层 `CanonicalAccumulator` 按 id 原地 upsert（增量式更新）。

## 2. 是否需要本机安装 Codex CLI

**是的，必需。** TypeScript SDK 的 npm 包**不内嵌（vendored）** Codex CLI 二进制。
需要通过独立渠道安装：

```bash
npm install -g @openai/codex      # 官网推荐
# 或 brew install codex
```

SDK 在 `node_modules` 搜索 `codex` 可执行文件的逻辑类似 Claude，但最终回退到 `PATH` 查找。
c3 完全绕过这套逻辑：通过 `process/launcher.ts` 的 `resolve('codex')` 从 PATH 解析绝对路径，
通过 `CodexOptions.codexPathOverride` 注入到 SDK。

### c3 的实际处理

- **启动时探测**：`resolveHostBinary('codex')` 使用 `command -v codex` 检查存在性
  （ADR-0012：宿主二进制探测是第一能力关卡）。
- **不可用**：适配器不构造，vendor 在 UI 中置灰并显示安装提示（`installHint`）。
- **覆盖**：`CODEX_PATH` 环境变量可指定自定义路径。
- **c3 打包后的约束**：与 Claude 类似，c3 用 `bun build --compile` 打包后无 `node_modules`，
  SDK 自带的查找会失效，必须回退到 `codexPathOverride` → PATH 解析。

## 3. 它如何与 Codex CLI 交互

SDK 对子进程的控制比 Claude 更有限，总结如下：

| 层级     | 机制                                                                                              |
| -------- | ------------------------------------------------------------------------------------------------- |
| 进程管理 | Node `child_process.spawn()` 拉起 `codex exec`；turn 进程常驻期间，唯一控制是 AbortSignal         |
| 报文协议 | stdio 上的 JSON-lines 事件流，**单向输出**——stdin 发完 prompt 即关闭，无反向通道                  |
| 权限控制 | **无 per-tool 运行时审批**——`sandboxMode` + `approvalPolicy` 是启动时固定的全量开关               |
| 沙箱模式 | `read-only` / `workspace-write` / `danger-full-access`（claude 不存在的概念）                     |
| 审批策略 | `never` / `on-failure` / `on-request`（在非交互式 exec 中实际无用户通道）                         |
| MCP      | 通过 CLI 配置的 `mcpServers` 下发给子进程；SDK 无 `PreToolUse` hook 等效物                        |
| Hooks    | Codex CLI 有 hooks 系统，但**SDK 进程内无 hook 注入点**（Claude SDK 的 `Pre/PostToolUse` 不存在） |

### 过渡模式映射（gateToCodexPolicy）

c3 将中性的 `ActionMode × ToolGate` 网格映射为 Codex 原生的 `sandboxMode + approvalPolicy`：

| 网格 `(actionMode, toolGate)` | sandboxMode       | approvalPolicy | 说明                                                   |
| ----------------------------- | ----------------- | -------------- | ------------------------------------------------------ |
| `plan` × `never-ask`          | `read-only`       | `never`        | 只读 MCP 流程使用；文件系统只读，MCP handler 自行 gate |
| `plan` × 其他                 | `read-only`       | `on-request`   | plan 模式永远只读                                      |
| `build` × `never-ask`         | `workspace-write` | `never`        | 完全放行                                               |
| `build` × `trusted-prefix`    | `workspace-write` | `on-failure`   | 仅在失败时干预                                         |
| `build` × `on-sensitive`      | `workspace-write` | `on-request`   | 默认/自动模式                                          |
| `build` × `always-ask`        | `read-only`       | `on-request`   | **降级**——Codex 无法 per-tool 询问，退为只读           |

反向映射 `codexPolicyToGrid` 用于 session 启动时从存储的 `CodexPolicy` 回算网格值，使中性驱动路径
（`run-via-driver.ts`）统一消费。

### 零运行时审批（c3 的关键差异）

与 Claude 不同，c3 **不使用** Codex 的批准回调——因为 Codex **没有**等价物。

- Claude SDK：使用 `canUseTool` 拦截每次敏感工具调用，经 WebSocket 发给浏览器审批。
- **Codex SDK**：无 `canUseTool` 参数。所有工具在 launch-time 被沙箱/审批策略自动裁决。
  c3 的 `CodexApprovalBridge` 是一个**结构性空操作**——`onRequest` 注册的 handler 永远不会被触发。
- 审计重建：翻译器给所有工具 item 打 `preApproved: true` 印章，因为这相当于"在启动时被一次性预审"。

详见 [`permission-gateway` 域](../domains/core/permission-gateway/spec.md)与
[ADR 0005](adr/0005-inherit-user-project-settings.md)。

## 4. 上下文与 Session 数据存储

### 默认存储（与 CLI 一致）

SDK 会话默认存储在本地文件系统，与命令行 Codex **一致**：

```
~/.codex/sessions/<thread-id>
```

- 每个线程一个会话文件。
- `codex.resumeThread(threadId)` 可续接已知线程（按 threadId）。
- 存储格式是 Codex CLI 内部的，c3 Phase 0 仅运行了 L1-static（无认证，无真实线程写入），
  **从未探查过磁盘格式**。

### 会话续接

| `Codex` 方法            | 行为                                         |
| ----------------------- | -------------------------------------------- |
| `resumeThread(id)`      | 按 threadId 继续指定历史线程，上下文完整保留 |
| `startThread()` → 新 id | 开启全新线程                                 |

SDK 无等价于 Claude SDK 的 `listSessions` / `getSessionMessages` / `renameSession` / `tagSession`。

### c3 的 SessionStore（空实现）

`CodexSessionStore` 忠实地反映 SDK 的能力上限：

- `list()` → 返回 `[]`（SDK 无枚举 API，不伪造）
- `read()` → 返回 `[]`（SDK 无回溯读取 API，不伪造）
- 线程仍然通过 `DriverStartOptions.resume` 走 `resumeThread` 端到端可用——**只有枚举/回溯是缺口**。

### 配置加载（claude 无等价物）

Codex CLI 的配置是独立的文件系统层次（与 Claude 的 `~/.claude/` 不同）。

Codex 的主要配置位于全局 CLI 配置（`~/.codex/` 或 XDG 兼容路径），包含：

- API key（`codex sign in` 或 `CODEX_API_KEY` env）
- `mcpServers`
- 模型 provider 映射
- hooks 与 rules

SDK 中通过 `CodexOptions.config`、`codexPathOverride`、`baseUrl`、`apiKey`、`env` 等覆盖这些设置。
c3 通过 `CodexFactoryOptions` 的子集将其中性选项注入，并且当有自定义 provider URL 时，
通过 relay 层完全替换 API 端点和凭证。

## 5. 它如何读取 Skill

Codex CLI 内置了一个与 Claude **兼容**的 Skill 发现系统（ADR-0016 spike B 确认）。

### 发现路径

| 位置                                    | 何时加载     | 共享范围       |
| --------------------------------------- | ------------ | -------------- |
| `~/.codex/skills/*/SKILL.md`            | 用户级 Skill | 用户级，跨项目 |
| `<projectDir>/.codex/skills/*/SKILL.md` | 项目级 Skill | 项目级，随 git |

发现布局与 Claude 相同：**单层** `skills/<name>/SKILL.md` glob，嵌套目录不会被注册。
Codex 的 SKILL.md 也支持 YAML frontmatter 且与 Claude 兼容。

### c3 的 SkillLoader

`CodexSkillLoader` 使用通用的 `createSkillLoader` 基类，发现目录为 `<projectDir>/.codex/skills/`。
与 Claude 相同，在 `settingSources: ['user', 'project']` 时发现。

### 外部 skill 限制

Codex 是 ADR-0016/0017 中列为 `detectSkillSupport=full` 的 vendor（与 Claude 同级），
外部 git 仓库的 skill 也会挂载到 `.codex/skills/_c3_<id>/SKILL.md`。
但 Codex 缺少 per-tool 运行时审批，这会影响**写操作审批守卫**的效果——`canUseTool` 不会在 Codex 侧触发。

## 6. Responses-to-Chat 中继（ADR-0014）

> Codex SDK 特有，Claude 无对应物。

### 为什么需要它

Codex CLI 在 0.137+ 版本**只讲 OpenAI Responses API**（`POST /v1/responses`）。
但主流的第三方 provider（DeepSeek、Kimi、MiMo、MiniMax、硅基流动等）**只实现 Chat Completions**
（`POST /v1/chat/completions`）。这形成了一个协议不兼容 gap。

中继（relay）的职责是在 c3 进程内透明地双向转换这两个协议，使用户无需运行外部代理。

### 架构

```
┌─────────────────────────────────────────────────────┐
│  c3 进程                                             │
│                                                      │
│  Codex Driver                                        │
│    └─ codex CLI ──POST /internal/codex-relay/v1/     │
│                     responses                         │
│                       │                               │
│                       ▼                               │
│               ┌──────────────┐                        │
│               │  codex-relay │                        │
│               │  Handler     │                        │
│               │              │                        │
│               │ ① 查 token   │ (Authorization → 绑定) │
│               │ ② 请求转换   │ (Responses → Chat)     │
│               │ ③ fetch 上游 │ (Chat Completions)     │
│               │ ④ 响应转换   │ (Chat SSE → Responses  │
│               │              │   SSE)                 │
│               └──────┬───────┘                        │
│                      │                                │
│                 fetch│                                │
│                      ▼                                │
│           Chat-Completions Provider                   │
│           (DeepSeek / Kimi / ...)                     │
└─────────────────────────────────────────────────────┘
```

### Token 安全机制

- 每次运行时，c3 用 `register({baseUrl, apiKey})` 注册真实的 upstream，获得不透明 UUID token。
- token 作为 `CODEX_API_KEY` 传给 codex 子进程。
- codex CLI 发送 `Authorization: Bearer <token>` 到 relay，relay 通过 token 查找真实绑定。
- **真实 API key 永远不会到达 codex 子进程**。
- 运行结束时 `unregister(token)` 清除绑定。
- 未知 token 返回 401。

### 协议转换（纯函数，无 SDK、无 HTTP）

- **请求方向**（`responsesRequestToChat`）：system/developer → system，function_call 工具的扁平化，
  `stream` 强制 true 且附加 `stream_options.include_usage`。
- **响应方向**（`ChatToResponsesConverter`）：`delta.content` → `response.output_text.delta`，
  `delta.reasoning_content` → `response.reasoning_text.delta`，`delta.tool_calls` → 累积后
  在结束前 emit `response.output_item.done`，始终以 `response.completed` 关闭。

### 路由挂载

在 `server.ts` 中：Hono 的 `POST /internal/codex-relay/v1/responses`，
**必须在静态 catch-all 之前**注册，否则被 SPA 回退路由吞掉。

### Codex CLI 侧配置

当中继启用，Codex CLI 被配置为：

- `model_provider = "c3relay"`（自定义 provider 名）
- `model_providers.c3relay` 定义 `base_url`、`wire_api: "responses"`、`supports_websockets: false`
- `NO_PROXY` 扩充 loopback 地址（防止 `HTTP_PROXY` 代理中继）

## 7. 权限模式（Mode 目录）

Codex 没有 Claude 的五档模式，而是通过三元语义词义：

| Token         | ActionMode | ToolGate       | SDK 等价                                |
| ------------- | ---------- | -------------- | --------------------------------------- |
| `read-only`   | `plan`     | `on-sensitive` | read-only sandbox + on-request approval |
| `auto`        | `build`    | `on-sensitive` | workspace-write + on-request（默认值）  |
| `full-access` | `build`    | `never-ask`    | workspace-write + never approval        |

`always-ask` 明确不提供——Codex 无法 per-tool 询问，提供它是在撒谎（`gateToCodexPolicy` 会把它降级为只读）。

注册在 `MODE_CATALOGS` 中：

```ts
export const MODE_CATALOGS: Record<VendorId, VendorModeCatalog> = {
  claude: claudeModeCatalog,
  codex: codexModeCatalog, // — 指向以上三档
  opencode: opencodeModeCatalog,
}
```

### 默认模式持久化

`WorkspaceSetting.defaultMode` 的类型是 `Record<VendorId, ModeToken | CodexPolicy>`。
对于 Codex vendor，既可以存旧版字符串 token（`'auto'`），也可以存新版对象格式：

```ts
{ sandboxMode: 'workspace-write', approvalPolicy: 'on-request' }
```

`DEFAULT_MODE_MAP` 中 Codex 默认 token 为 `'auto'`。

## 8. 任务系统（Observe-Only）

Codex 的任务系统完全不同于 Claude 的命令式工具表面（`TaskCreate`/`TaskList`/`TaskUpdate`/`TaskGet`）。
它是 agent 正在运行的 **`todo_list` 线程 item**——每一帧是当前计划的全局快照，不是增量 delta。

### CodexTaskStore（观察者模式）

| 方法           | 行为                              |
| -------------- | --------------------------------- |
| `list()`       | 返回缓存中的最新快照              |
| `get(id)`      | 按合成 id 查单项                  |
| `onUpdate()`   | 对变更的任务推送更新              |
| `ingest(item)` | 由 driver 调用的注入点，吸收一帧  |
| `create()`     | **reject**（Codex todo 不可外写） |
| `update()`     | **reject**（同上）                |

**Id 合成**：Codex 的 `TodoItem` 没有自己的 id，c3 合成 `<listItemId>#<arrayIndex>`
作为稳定标识——在计划排序不变的前提下保持稳定。

**推送变化**（非推送全量）：`ingest` 用新帧替换整个缓存，但 `onUpdate` 只触发状态/内容
发生变化的任务。

## 9. 能力矩阵（AdapterCapabilities）

c3 的 `codexCapabilities` 是 AdapterCapabilities 中最极端的示例——**每个布尔值都是 `false`**，
除了 `taskStore: true`：

```ts
export const codexCapabilities: AdapterCapabilities = {
  interrupt: false, // 只有全局 AbortSignal，无查询级别中断
  setActionMode: false, // sandbox/approvalPolicy 启动时固定，无法运行时切换
  streamingPush: false, // stdin 关闭后无法推送
  inProcessMcp: false, // 无进程内 MCP 服务器
  forkSession: false, // 不支持分叉
  perToolApproval: false, // 关键差异：无 per-tool 审批点
  taskStore: true, // todo_list 快照可观察
  sessions: {
    list: 'none', // 无枚举 API
    read: 'none', // 无回溯读取 API
    resume: 'full', // resumeThread(id) 端到端可用
    rename: 'none', // 不支持重命名
    delete: 'none', // 不支持删除
  },
}
```

**关键的架构断言**（Phase 0 probe 008 NO-GO）：

- `perToolApproval: false` 导致整个 approval bridge 结构性地空转。
- 这迫使 c3 对所有 Codex 工具调用使用**启动时预审替代运行时审批**。
- 所有布尔 false 都源自同一结构原因：stdin 关闭后没有回写通道。

## 10. 数据流路径对比

| 维度          | Claude SDK                             | Codex SDK                               |
| ------------- | -------------------------------------- | --------------------------------------- |
| 通信模式      | 双向 JSON-lines（读写双向）            | 单向事件流（stdin 发完即关）            |
| 运行时控制    | `interrupt()`、`setModel()`、`close()` | 仅全局 `AbortSignal`                    |
| Per-tool 审批 | 是（`canUseTool` 回调）                | **否**（启动时一次性策略）              |
| 会话 API      | `listSessions` / `getSessionMessages`  | 无（仅 `resumeThread(id)`）             |
| 内部二进制    | npm 包自带 vendored                    | 需要额外安装 `@openai/codex`            |
| 协议          | Anthropic Message API                  | OpenAI Responses API（需中继适配 Chat） |
| Hook 系统     | SDK 进程内执行（`PreToolUse` 等）      | CLI 进程内支持，SDK 层无 hook 注入点    |
| 流式输入      | `AsyncIterable` 支持多轮输入           | 一次性 prompt（stdin 关闭后不可追加）   |
| 成本信息      | `result.total_cost_usd`, `usage`       | `turn.completed` 的 `Usage` 对象        |

## 11. c3 中的集成拓扑

以下文件共同构成 Codex SDK 的 c3 集成：

```
server/src/kernel/agent/adapters/codex/
├── index.ts            # Barrel：createCodexAdapter() — 组装 VendorAdapter
├── driver.ts           # CodexDriver — 核心生命周期（startThread/runStreamed/翻译/abort）
├── translate.ts        # ThreadItem → CanonicalBlock 翻译（ADR-0013）
├── capabilities.ts     # 能力矩阵（所有 false 的权威清单）
├── modes.ts            # 三档 Mode 目录
├── approval.ts         # CodexApprovalBridge — 结构性空操作（008 NO-GO）
├── session-store.ts    # CodexSessionStore — 空实现（忠实反映 SDK 上限）
├── task-store.ts       # CodexTaskStore — observe-only todo 快照观察器
├── relay-contract.ts   # CodexRelay 内核侧契约（仅 register/unregister/baseUrl）
├── skill.ts            # CodexSkillLoader — .codex/skills/ 发现
├── codex.test.ts       # Driver + approval + adapter 装配测试
├── translate.test.ts   # item→canonical 翻译测试
└── task-store.test.ts  # TaskStore ingest/observe 测试

server/src/transport/codex-relay/
├── index.ts            # 中继 HTTP handler + createCodexRelay 工厂
├── translate.ts        # 纯协议转换（Responses ↔ Chat），无 SDK 无 HTTP
├── translate.test.ts   # 单元测试（真实 captured fixture）
├── e2e.codex.test.ts   # 端到端测试（真实 codex 二进制）
└── __fixtures__/       # 真实 codex 0.137.0 请求 fixture
```

SDK 边界规则（ADR-0009）：`@openai/codex-sdk` 类型只出现在 `adapters/codex/` 中，
只有规范形状（`CanonicalMessage`、`CanonicalBlock`、`TaskData`）对外传出。

## 12. 最佳实践

### 何时使用 Codex（vs Claude / OpenCode）

- **最适合**：受信环境中的自动化工作流（CI、批量任务），无需 per-tool 人工审批介入。
- **最不适合**：需要细粒度工具安全控制的交互式会话——Codex 没有 per-tool 审批点，
  一次启动策略覆盖整个 turn。
- **第三方 provider**：通过中继（relay）支持 Chat-Completions 提供商，但需理解 Responses API
  与 Chat API 的协议差异可能带来的行为边界（如 `reasoning` 的暴露程度、结构化输出的方式不同）。

### 权限控制的实际限制

| 期望行为                    | Codex 能否实现                  |
| --------------------------- | ------------------------------- |
| "每次写文件前让我确认"      | ❌ 不支持 per-tool 审批         |
| "先只读分析，再写文件"      | ✅ 切换两轮不同 sandbox 模式    |
| "禁止 shell 但允许文件修改" | ❌ 沙箱是全局的，不能按工具类型 |
| "遇到敏感操作自动中止"      | ❌ 无敏感操作检测               |
| "abort 整个 turn"           | ✅ 通过 `AbortSignal`           |

### 错误与终止

- 消费 `turn.failed` 事件获取错误消息（`ev.error.message`）。
- `turn.completed` 携带 `Usage`（token 消耗统计）。
- `error` 事件是流层面的非终端错误，turn 可能继续。
- 与 Claude SDK 不同，没有 `subtype` 编码的终端结果（`error_max_turns` 等），
  只能从事件流是否正常结束来判断。
- `AbortSignal` 是唯一的中止方式。c3 将中性的 `opts.signal` 与内部 `AbortController`
  组合转发给 `runStreamed`。

### 结构化输出

SDK 支持 `outputSchema` 参数将 agent 的最终回答约束为 JSON：

```ts
const turn = await thread.run('分析仓库状态', {
  outputSchema: {
    type: 'object',
    properties: { summary: { type: 'string' }, status: { type: 'string' } },
    required: ['summary', 'status'],
    additionalProperties: false,
  } as const,
})
```

实现方式：Schema 写入临时文件，通过 `--output-schema` 传给 CLI。结果在 `AgentMessageItem.text`
中返回。c3 当前未使用这一能力（使用规范消息流而非最终结果提取）。

### 子代理与上下文

- Codex SDK 不提供 Claude SDK 那种 `agents` 子代理定义机制（独立 system prompt、受限 tools）。
  Codex CLI 自身可能在未来支持，但 SDK 层目前没有此抽象。
- 上下文管理完全由 Codex CLI 内部处理（自动压缩），SDK 不发出 `compact_boundary` 等效事件。
- 接近上下文上限时，Codex CLI 自行压缩；SDK 无 `system` / `compact_boundary` 消息。

## 附录：来源与可信度

| 主题                                                      | 来源                                                                | 可信度                             |
| --------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------- |
| `Codex`/`startThread`/`runStreamed`/事件/权限模式/Sandbox | 官方文档 `developers.openai.com/codex/sdk` + npm README             | 高                                 |
| SDK 三层类结构（Codex/Thread/CodexExec）                  | DeepWiki `openai/codex` + GitHub 源码                               | 中（实现细节可能跨版本变化）       |
| c3 的 PATH 探测、`codexPathOverride`、`CodexFactory` 注入 | 本仓库 `server/src/kernel/agent/adapters/codex/driver.ts`           | 高（已落地代码）                   |
| c3 的 approval bridge（结构性空操作）、`preApproved` 印章 | 本仓库 `server/src/kernel/agent/adapters/codex/approval.ts`         | 高（已落地代码 + Phase 0 结论）    |
| c3 的 SessionStore 空实现                                 | 本仓库 `server/src/kernel/agent/adapters/codex/session-store.ts`    | 高（已落地代码）                   |
| Responses-to-Chat 中继设计与协议转换                      | 本仓库 `server/src/transport/codex-relay/`                          | 高（已落地代码 + 单元测试）        |
| 能力矩阵与 Mode 目录                                      | 本仓库 `server/src/kernel/agent/adapters/codex/`                    | 高（已落地代码）                   |
| 外部 skill 挂载兼容性（单层 glob / 扁平布局）             | ADR-0016 spike B（本仓库 `specs/adr/`）                             | 高（已实测）                       |
| 默认配置与 Web UI 侧 Codex policy 双选下拉                | 本仓库 `server/src/kernel/config/` + `web/src/pages/projectconfig/` | 高（已落地代码）                   |
| SDK 结构化输出机制                                        | DeepWiki `openai/codex` + 官方文档                                  | 中（非 c3 使用路径，未在生产验证） |

> **维护提示**：本文件描述外部依赖，**会随 SDK 版本漂移**。升级 `@openai/codex-sdk` 时复核
> 「是否需要本机 codex」「事件类型与 ThreadItem 种类」「sandbox/approvalPolicy 枚举值」
> 「中继协议兼容性」四处，并更新顶部「适用版本」。`file_change` 中 `changes` 数组的字段
> 形态也可能变化，需同步更新 `translate.ts` 和本文件的 ThreadItem 映射表。
