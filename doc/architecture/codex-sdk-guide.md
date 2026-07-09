# Codex SDK 架构指南

> 面向开发者与 AI：解释 c3 所依赖的 `@openai/codex-sdk`（TypeScript）
> 是什么、其架构与 Claude Agent SDK 的关键差异、数据存在哪里、如何读取 Skill，
> 以及 c3 如何在 Adapter 层封装它。
>
> - **适用版本**：`@openai/codex-sdk@0.141.0`（在 c3 依赖清单中精确锁定）。
> - **官方文档**：<https://developers.openai.com/codex/sdk>
> - **源码仓库**：<https://github.com/openai/codex/tree/main/sdk/typescript>
> - **Python 对应**：`pip install openai-codex`，控制 app-server 二进制；本文档仅覆盖 TypeScript SDK。
> - **2026-06-15 runtime note**：c3 的 Codex 适配能力现在直接 spawn
>   `codex exec --experimental-json`，不再运行 `@openai/codex-sdk` 的 JS wrapper；本文件仍作为
>   Codex JSONL event/type 与历史集成决策的参考。
> - 与 c3 的关系见 [`architecture.md`](architecture.md)（c3 的 Codex 适配能力封装 Codex CLI JSONL）。

> **关于本指南的定位**：c3 使用 `@openai/codex-sdk`（OpenAI Codex）与 `@anthropic-ai/claude-agent-sdk`（Claude）；
> 本指南讲解 Codex SDK 与 Claude SDK 的关键差异，以及 c3 如何据此构建中性驱动层。
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

### 图片输入（local_image，2026-06-16）

`runStreamed` 的入参不止是字符串：`Input = string | UserInput[]`，其中 `UserInput` 是
`{ type: 'text'; text } | { type: 'local_image'; path }` 的判别联合。CLI 侧 `codex exec`
通过 `-i/--image <FILE>` 接收**磁盘路径**（非内联字节）。

c3 的处理：

1. 接口层 `user_prompt` 携带图片（base64 + mediaType），服务端边界拒绝非图片类型（`prompt.unsupportedFile`）。
2. Codex 驱动把每张图片解码落到操作系统临时目录下的 per-turn 临时目录，构造
   `[{type:'text'}, {type:'local_image', path}…]` 作为 `runStreamed` 入参；text 走 stdin、
   每个 path 追加为 `--image <path>` exec 参数。
3. turn 结束（成功/失败/abort）清理该 per-turn 临时目录，**无残留**。
4. **沙箱例外**：沙箱运行只 bind-mount worktree 到 `/workspace`，host 临时路径在容器内不可达——
   此时**丢弃图片**（避免 `--image` 指向不存在路径而整轮失败），跨容器传图是后续工作。

> 对照 Claude 路径：Claude 不落盘，而是把图片转成 base64 `image` 内容块内联进 streaming-input
> 的首条 user 消息。同一中性的图片传入字段，两 vendor 各自编码。

### c3 的封装

c3 的 Codex 适配能力：

1. 将 `Codex` 构造注入（测试注入 fake，生产用真实 SDK）。
2. 将 `startThread` / `resumeThread` 的配置映射到 c3 中性的「行动模式 × 工具闸门」网格。
3. 通过一个队列桥（push/close/fail）将 `AsyncGenerator<ThreadEvent>` 转为 c3 中性的
   规范消息异步流，供上层消费。
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

**ThreadItem 类型**（翻译为规范块）：

| ThreadItem `type`   | 规范名           | 映射为规范块                           |
| ------------------- | ---------------- | -------------------------------------- |
| `agent_message`     | 文本回复         | `text` 块                              |
| `reasoning`         | 推理内容         | `thinking` 块                          |
| `command_execution` | shell 命令       | `tool_use` name=`"shell"`              |
| `file_change`       | 文件修改         | `tool_use` name=`"apply_patch"`        |
| `mcp_tool_call`     | MCP 工具调用     | `tool_use` name=`"<server>/<tool>"`    |
| `web_search`        | 网络搜索         | `tool_use` name=`"web_search"`         |
| `todo_list`         | 任务列表快照     | **null**（无规范对应，分流到任务存储） |
| `error`             | 非致命 item 错误 | `text` 块 + vendor 透传字段            |

> 与 Claude 不同，Codex 的 item 本身**不携带 `role`**——c3 翻译器合成 `role: 'assistant'`。
> 每一帧携带同一个 `item.id`，上层按 id 原地 upsert（增量式更新）。

## 2. 是否需要本机安装 Codex CLI

**是的，必需。** TypeScript SDK 的 npm 包**不内嵌（vendored）** Codex CLI 二进制。
需要通过独立渠道安装：

```bash
npm install -g @openai/codex      # 官网推荐
# 或 brew install codex
```

SDK 在 `node_modules` 搜索 `codex` 可执行文件的逻辑类似 Claude，但最终回退到 `PATH` 查找。
c3 完全绕过这套逻辑：从 PATH 解析出绝对路径，通过 SDK 的 `codexPathOverride` 选项注入。

### c3 的实际处理

- **启动时探测**：用 `command -v codex` 检查宿主二进制存在性
  （ADR-0012：宿主二进制探测是第一能力关卡）。
- **不可用**：适配能力不构造，vendor 在 UI 中置灰并显示安装提示。
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

### 集中式 Spec 根与 `--add-dir`

Codex 的 `workspace-write` 可写集合是 allowlist：`cwd` 一定可写，`--add-dir` 追加更多可写根；它没有
“cwd 只读”或“给某目录只读挂载”的原语。c3 因此按会话类型使用两种启动形态：

- 普通 Codex work/dev 会话：cwd 仍是项目或 worktree。启动层以**归属 workspace 路径**解析
  `getSpecsBase(workspacePath)`，并把这唯一目录作为 `ThreadOptions.additionalDirectories` 交给
  Codex adapter；CLI 序列化为 `--add-dir <specs-root>`，允许开发会话 reverse-sync spec。
- Codex spec-authoring 会话：cwd 改为 centralized specs root 本身，同时强制
  `sandboxMode=workspace-write` 与 `approvalPolicy=never`，并继续传 `--add-dir <specs-root>`。由于项目
  根不再是 cwd，也不在 `additionalDirectories` 内，项目源码、`~/.c3/c3.db` ledger 以及其它非 specs-root
  路径不在可写根集合内；Codex 仍可用绝对路径读取项目上下文，spec prompt 会显式给出 project root。

不得从 worktree 或 sandbox 内的 `/workspace` 反推 specs root。sandbox wrapper 原样透传参数，且
sandbox 运行依赖同一路径的 spec 根 bind mount，故容器内外使用同一绝对路径；除这一 spec 根外，不新增
cwd 之外的可写目录。若 spec 会话无法解析或创建 specs root，必须 fail-closed，不能退回到项目可写 cwd。
只读/plan 会话仍由 `read-only` sandbox 限制，不因此获得写权限。

### 过渡模式映射

c3 将中性的「行动模式 × 工具闸门」网格映射为 Codex 原生的 `sandboxMode + approvalPolicy`：

| 网格 `(actionMode, toolGate)` | sandboxMode       | approvalPolicy | 说明                                                   |
| ----------------------------- | ----------------- | -------------- | ------------------------------------------------------ |
| `plan` × `never-ask`          | `read-only`       | `never`        | 只读 MCP 流程使用；文件系统只读，MCP handler 自行 gate |
| `plan` × 其他                 | `read-only`       | `on-request`   | plan 模式永远只读                                      |
| `build` × `never-ask`         | `workspace-write` | `never`        | 完全放行                                               |
| `build` × `trusted-prefix`    | `workspace-write` | `on-failure`   | 仅在失败时干预                                         |
| `build` × `on-sensitive`      | `workspace-write` | `on-request`   | 默认/自动模式                                          |
| `build` × `always-ask`        | `read-only`       | `on-request`   | **降级**——Codex 无法 per-tool 询问，退为只读           |

反向映射用于 session 启动时从存储的 Codex 策略回算网格值，使中性驱动路径统一消费。

### 网络访问（与 sandboxMode 正交）

Codex 的 sandbox **默认禁止网络访问**，且内置 `web_search` 工具默认 `disabled`——这与
`sandboxMode`（文件系统读写）相互独立。若不显式开启，任何 work/intent/discussion 的 codex
session 一联网即被拒。c3 通过两个中性驱动选项字段控制，由 codex 驱动映射到 SDK 的 `ThreadOptions`：

| 中性驱动选项字段 | Codex `ThreadOptions`                              | 含义                                |
| ---------------- | -------------------------------------------------- | ----------------------------------- |
| `networkAccess`  | `networkAccessEnabled`                             | sandbox 内 shell 命令的原始网络访问 |
| `webSearch`      | `webSearchEnabled: true` + `webSearchMode: 'live'` | codex 第一方 `web_search` 工具      |

各 session 类型的取值（2026-06-15）：

| Session       | 启动点                        | networkAccess / webSearch | 说明                                               |
| ------------- | ----------------------------- | ------------------------- | -------------------------------------------------- |
| work / intent | 交互式运行启动路径            | 固定 `true` / `true`      | 交互式、用户驱动的运行，恒开网络                   |
| discussion    | 讨论 agent 会话管理           | 固定 `true` / `true`      | 讨论 agent 边研究边推演                            |
| automation    | 调度分派（不经 codex driver） | 不传                      | 仍由 `toolAllowlist`（WebSearch/WebFetch）配置驱动 |

### GitHub CLI 凭据桥接（GH_TOKEN 注入）

`gh` CLI 把令牌存在操作系统钥匙串（macOS keychain）。Codex 运行在自身的 seatbelt 沙箱
（以及可选的 docker 容器）内，其子进程读不到宿主钥匙串——即使宿主 `gh auth status` 完全正常、
即使沙箱已开网，会话内的 `gh` 也会报「请运行 gh auth login」。`gh` 读取环境变量的优先级高于
钥匙串，故把令牌以 `GH_TOKEN` 注入子进程环境即可在沙箱内恢复认证。

- **注入点**：Codex 会话启动时（`run-via-driver` 的手动 work/intent，以及 automation 分派的
  codex 路径），宿主侧在 seatbelt 外执行 `gh auth token`，成功且非空输出经 trim 后作为 `GH_TOKEN`
  追加到传给 codex driver 的 `envOverrides`——沿用现有唯一注入通道，不新增 API/配置/持久化字段。
- **优先级（承 `buildChildEnv`）**：先按既有优先级计算有效环境，只要 `GH_TOKEN` 或 `GITHUB_TOKEN`
  任一（来自用户 shell 或 agent override）已为非空值，就原样沿用、不探测、不覆盖。
- **失败即降级**：命令缺失、非零退出、超时（有界）、空输出都视为「无可注入凭据」——会话照常启动，
  绝不因此阻塞；令牌不进参数、日志、错误文本、遥测或测试快照。
- **仅 codex**：Claude 路径无 seatbelt 边界，不执行探测；该逻辑不并入所有 vendor 共用的
  `buildChildEnv`。
- **DIRECT 分支 env 语义**：`CodexOptions.env` 会**替换** `process.env`（见 `codexExecEnv`）。故
  DIRECT 分支把 `envOverrides` 叠加到继承的宿主环境之上再传入，否则注入 `GH_TOKEN`（或代理变量）会
  连带抹掉 `PATH` 等——与 RELAY 分支及容器 wrapper 的 `buildChildEnv` 语义一致。
- **与网络正交**：凭据桥接只解决「认证可见性」。沙箱内 `gh` 能否触网仍由 `networkAccess`
  独立控制。有令牌但无网络 **不是** 认证失败——诊断须区分「宿主未取得可注入令牌」与「沙箱网络未开/
  不可达」，不得仅建议重复 `gh auth login`。

### 零运行时审批（c3 的关键差异）

与 Claude 不同，c3 **不使用** Codex 的批准回调——因为 Codex **没有**等价物。

- Claude SDK：使用 `canUseTool` 拦截每次敏感工具调用，经 WebSocket 发给浏览器审批。
- **Codex SDK**：无 `canUseTool` 参数。所有工具在 launch-time 被沙箱/审批策略自动裁决。
  c3 的 Codex 审批桥是一个**结构性空操作**——其注册的请求 handler 永远不会被触发。
- 审计重建：翻译器给所有工具 item 打"已预审"印章，因为这相当于"在启动时被一次性预审"。

详见 [`permission-gateway` 域](../domains/core/permission-gateway/permission-gateway-spec.md)与
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

### c3 的会话存储（空实现）

c3 的 Codex 会话存储忠实地反映 SDK 的能力上限：

- 枚举 → 返回空（SDK 无枚举 API，不伪造）
- 回溯读取 → 返回空（SDK 无回溯读取 API，不伪造）
- 线程仍然通过中性驱动的 resume 选项走 `resumeThread` 端到端可用——**只有枚举/回溯是缺口**。

### 配置加载（claude 无等价物）

Codex CLI 的配置是独立的文件系统层次（与 Claude 的 `~/.claude/` 不同）。

Codex 的主要配置位于全局 CLI 配置（`~/.codex/` 或 XDG 兼容路径），包含：

- API key（`codex sign in` 或 `CODEX_API_KEY` env）
- `mcpServers`
- 模型 provider 映射
- hooks 与 rules

SDK 中通过 `config`、`codexPathOverride`、`baseUrl`、`apiKey`、`env` 等选项覆盖这些设置。
c3 将其中一个子集作为中性选项注入，并且当有自定义 provider URL 时，
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

### c3 的 Skill 加载

c3 的 Codex skill 加载复用通用的 skill 加载基础设施，发现目录为 `<projectDir>/.codex/skills/`。
与 Claude 相同，在 `settingSources: ['user', 'project']` 时发现。

### 外部 skill 限制

Codex 是 ADR-0016/0017 中 skill 支持判定为 full 的 vendor（与 Claude 同级），
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

- **请求方向**：system/developer → system，function_call 工具的扁平化，
  `stream` 强制 true 且附加 `stream_options.include_usage`。
- **响应方向**：`delta.content` → `response.output_text.delta`，
  `delta.reasoning_content` → `response.reasoning_text.delta`，`delta.tool_calls` → 累积后
  在结束前 emit `response.output_item.done`，始终以 `response.completed` 关闭。

### 路由挂载

relay 的 `POST /internal/codex-relay/v1/responses` 路由
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

`always-ask` 明确不提供——Codex 无法 per-tool 询问，提供它是在撒谎（映射时会把它降级为只读）。

这三档注册在 c3 按 vendor 维护的模式目录中（claude 一份、codex 指向以上三档）。

### 默认模式持久化

c3 的 workspace 默认模式按 vendor 存储。对于 Codex vendor，既可以存旧版字符串 token（`'auto'`），
也可以存新版对象格式：

```text
{ sandboxMode: 'workspace-write', approvalPolicy: 'on-request' }
```

Codex 的默认模式 token 为 `'auto'`。

## 8. 任务系统（Observe-Only）

Codex 的任务系统完全不同于 Claude 的命令式工具表面（`TaskCreate`/`TaskList`/`TaskUpdate`/`TaskGet`）。
它是 agent 正在运行的 **`todo_list` 线程 item**——每一帧是当前计划的全局快照，不是增量 delta。

### Codex 任务存储（观察者模式）

| 能力     | 行为                              |
| -------- | --------------------------------- |
| 列出     | 返回缓存中的最新快照              |
| 取单项   | 按合成 id 查单项                  |
| 订阅更新 | 对变更的任务推送更新              |
| 注入     | 由驱动调用的注入点，吸收一帧      |
| 创建     | **reject**（Codex todo 不可外写） |
| 更新     | **reject**（同上）                |

**Id 合成**：Codex 的 `TodoItem` 没有自己的 id，c3 合成 `<listItemId>#<arrayIndex>`
作为稳定标识——在计划排序不变的前提下保持稳定。

**推送变化**（非推送全量）：注入时用新帧替换整个缓存，但只对状态/内容发生变化的任务推送更新。

## 9. 能力矩阵

c3 描述 Codex vendor 能力的矩阵是最极端的示例——**几乎每个能力都是不支持**，唯一支持的是任务存储观察：

| 能力               | 取值   | 原因                                        |
| ------------------ | ------ | ------------------------------------------- |
| 运行时中断         | 否     | 只有全局 AbortSignal，无查询级别中断        |
| 运行时切换行动模式 | 否     | sandbox/approvalPolicy 启动时固定，无法切换 |
| 流式追加输入       | 否     | stdin 关闭后无法推送                        |
| 进程内 MCP         | 否     | 无进程内 MCP 服务器                         |
| 会话分叉           | 否     | 不支持分叉                                  |
| per-tool 审批      | 否     | 关键差异：无 per-tool 审批点                |
| 任务存储           | **是** | todo_list 快照可观察                        |
| 会话枚举           | full   | 通过 `~/.codex/sessions/` JSONL 扫描        |
| 会话回溯读取       | full   | 通过 `~/.codex/sessions/` JSONL 回放        |
| 会话续接           | full   | `resumeThread(id)` 端到端可用               |
| 会话重命名         | none   | 不支持                                      |
| 会话删除           | none   | 不支持                                      |

**关键的架构断言**（Phase 0 probe 008 NO-GO）：

- 没有 per-tool 审批，导致整个审批桥结构性地空转。
- 这迫使 c3 对所有 Codex 工具调用使用**启动时预审替代运行时审批**。
- 所有"不支持"都源自同一结构原因：stdin 关闭后没有回写通道。

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

Codex SDK 的 c3 集成由以下职责单元构成（按能力，而非文件组织）：

- **适配装配**：组装 Codex vendor 适配能力的入口。
- **驱动**：核心生命周期（startThread/runStreamed/翻译/abort）。
- **翻译**：ThreadItem → 规范块（ADR-0013）。
- **能力矩阵**：Codex 能力的权威清单（几乎全为不支持）。
- **模式目录**：三档 Mode。
- **审批桥**：结构性空操作（008 NO-GO）。
- **会话存储**：空实现（忠实反映 SDK 上限）。
- **任务存储**：observe-only todo 快照观察。
- **relay 契约**：relay 的内核侧契约（仅 register/unregister/baseUrl）。
- **skill 加载**：`.codex/skills/` 发现。
- **以及对应的单元测试与端到端测试**（端到端用真实 codex 二进制 + 真实捕获的请求 fixture）。

relay 侧另有一组职责单元：中继 HTTP handler + 工厂、纯协议转换（Responses ↔ Chat，无 SDK 无 HTTP）、
及其单元测试与端到端测试。

SDK 边界规则（ADR-0009）：`@openai/codex-sdk` 类型只出现在 Codex 适配层内，
只有规范形状（规范消息、规范块、任务数据）对外传出。

## 12. 最佳实践

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
- `AbortSignal` 是唯一的中止方式。c3 将中性的中止信号与内部 `AbortController`
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

| 主题                                                      | 来源                                                    | 可信度                             |
| --------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------- |
| `Codex`/`startThread`/`runStreamed`/事件/权限模式/Sandbox | 官方文档 `developers.openai.com/codex/sdk` + npm README | 高                                 |
| SDK 三层类结构（Codex/Thread/CodexExec）                  | DeepWiki `openai/codex` + GitHub 源码                   | 中（实现细节可能跨版本变化）       |
| c3 的 PATH 探测、`codexPathOverride` 注入                 | 本仓库已落地代码                                        | 高（已落地代码）                   |
| c3 的审批桥（结构性空操作）、已预审印章                   | 本仓库已落地代码                                        | 高（已落地代码 + Phase 0 结论）    |
| c3 的会话存储空实现                                       | 本仓库已落地代码                                        | 高（已落地代码）                   |
| Responses-to-Chat 中继设计与协议转换                      | 本仓库已落地代码                                        | 高（已落地代码 + 单元测试）        |
| 能力矩阵与 Mode 目录                                      | 本仓库已落地代码                                        | 高（已落地代码）                   |
| 外部 skill 挂载兼容性（单层 glob / 扁平布局）             | ADR-0016 spike B                                        | 高（已实测）                       |
| 默认配置与 Web UI 侧 Codex policy 双选下拉                | 本仓库已落地代码                                        | 高（已落地代码）                   |
| SDK 结构化输出机制                                        | DeepWiki `openai/codex` + 官方文档                      | 中（非 c3 使用路径，未在生产验证） |

> **维护提示**：本文件描述外部依赖，**会随 SDK 版本漂移**。升级 `@openai/codex-sdk` 时复核
> 「是否需要本机 codex」「事件类型与 ThreadItem 种类」「sandbox/approvalPolicy 枚举值」
> 「中继协议兼容性」四处，并更新顶部「适用版本」。`file_change` 中 `changes` 数组的字段
> 形态也可能变化，需同步更新 Codex 翻译逻辑和本文件的 ThreadItem 映射表。
