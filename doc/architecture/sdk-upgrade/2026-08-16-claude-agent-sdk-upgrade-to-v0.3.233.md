# Claude Agent SDK 升级记录：0.3.220 → 0.3.233

- **日期**：2026-08-16
- **SDK**：`@anthropic-ai/claude-agent-sdk`
- **版本**：`^0.3.220` → `^0.3.233`
- **锁文件解析**：`0.3.220` → `0.3.233`（跨 `0.3.221` 至 `0.3.229`、`0.3.231` 至 `0.3.233`，共 12 个已发布版本。
  `0.3.230` 在 changelog 有条目但 npm 无该 tag——`npm view @anthropic-ai/claude-agent-sdk versions`
  的 `0.3.229` 与 `0.3.231` 之间确实缺失，非遗漏）
- **范围**：仅 Claude SDK。`@openai/codex-sdk`（`0.146.0`）与其它依赖原封不动，`pnpm-lock.yaml`
  diff 仅含 `claude-agent-sdk` 主包 specifier 及其 8 个平台子包的版本号/integrity 行
  （37 增 / 37 删），无 `0.3.220` 残留。
- **关联指南**：[`../claude-agent-sdk-guide.md`](../claude-agent-sdk-guide.md)
- **上一份**：[`2026-08-02-claude-agent-sdk-upgrade-to-v0.3.220.md`](2026-08-02-claude-agent-sdk-upgrade-to-v0.3.220.md)

## 结论速览

- **本轮有一项必须处理的默认行为变更**，是自 0.3.195 以来第一次：0.3.233 把
  `TaskCreate` / `TaskList` / `TaskUpdate` / `TaskGet`（及 `TodoWrite`）从 Opus 4.8、Sonnet 5、
  Fable 5、Mythos 5 及更新模型的**默认工具面**中移除。c3 的任务面板完全由这四个工具的
  `tool_use` / `tool_result` 帧派生（Claude 没有原生 task 推送事件，工具流**就是**数据源），
  若不处理，面板会在 c3 主打的那批模型上**静默为空**，且 `ClaudeTaskStore` 会失去它驱动的工具。
  结论：**显式保留工具面，不接受能力退化**——`capabilities.taskStore` 维持 `true`，ADR-0011
  capability ledger 不变（见「task 工具面深评」）。
- **保留方式选择 `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`（子进程 env），而非 `tools` 或 `allowedTools`。**
  三条逃生通道里只有它**单独**改工具面：`tools` 会**替换**整个内建工具集合（c3 从此要永久枚举
  自己想要的每个内建工具），`allowedTools` 的语义是「auto-allowed without prompting」——会把这
  四个工具**预判在 `canUseTool` 之前**，而 `canUseTool` 必须保持唯一权限收口（C-SEC）。
- **其余 20 条上游变化一律未提升为 c3 公共能力**：不新增 wire frame、不扩展 `CanonicalMessage`、
  不新增持久化字段、UI 状态或配置项。
- vendor 中性适配器面（`adapters/types.ts` 与 ADR-0011 capability ledger）**未被触及**：8 个 boolean
  flags、neutral permission grid、`canFormTeam` 声明均不变。**ADR-0011 不更新。**
- 供应链冷却期：0.3.233 发布于 `2026-08-14T18:52:44Z`，本次执行于 `2026-08-16`，超过 pnpm 11 的
  `minimumReleaseAge` 24 小时门槛。锁文件干净落在 0.3.233，`pnpm-workspace.yaml` 零改动。

## 逐项 changelog 评估

### 0.3.221 — skills 校验 + MCP 首轮连接修复

1. **`skills` 选项校验增强（畸形名/通配符报错，全开须用 `skills: 'all'`）** — 不适用、无需改动：
   c3 的 Claude 启动配置**不传 `skills` 选项**。外部 skill 经 `settingSources: ['user', 'project']`
   由磁盘上的 `.claude/skills` 被 SDK 自行发现（`adapters/claude/skill.ts` 写的是
   `skills/_c3_<id>/SKILL.md` 目录名，不经该选项），因此没有 c3 产出的名称会触发新校验。
   （留痕：本表；`claude-sdk-0233-compat.test.ts`「option surfaces c3 does not construct」断言
   options 不含 `skills`）
2. **修复：`mcpServers` 传入的外部 MCP server 首轮前未连接，模型把工具调用输出成字面文本** —
   自动接入：SDK 内部修复。c3 经 `mcpServers` 传自己的 loopback HTTP MCP 描述符
   （`remoteMcpToClaudeConfig`），此修复直接改善 c3 工具在首轮的可用性，无需改动。它与 c3 自己
   已修复的「宿主代理吞掉回环 MCP 致工具静默缺席」是不同根因（那条由 `withLoopbackNoProxy` 补齐
   `NO_PROXY` 解决），两者叠加后首轮工具可用性更稳。

### 0.3.222 — resume 携带 settings 修复

3. **修复：`query({ sessionStore, resume })` 未把用户 `settings.json`（`apiKeyHelper`、`env`、
   `hooks`、`permissions`）带入被 resume 的子进程** — 不适用、不改变 c3 行为：该修复的触发条件是
   **同时**传 `sessionStore` 与 `resume`。c3 走的是**裸 `resume` 路径，从不传 `sessionStore`**
   （`kernel/agent/index.ts` 的 options 里没有该字段），且无论首轮还是 resume 都**显式**下发
   `env: buildChildEnv(...)`，子进程环境由 c3 完全决定。详见「resume 携带 settings 深评」。
   （留痕：本表 + 深评节；回归断言见 `claude-sdk-0233-compat.test.ts` 同一用例：resume 路径上
   `resume` 存在、`sessionStore` 缺席、`env` 显式存在、`settingSources` 仍为 `['user','project']`）

### 0.3.223 — resumeDropsTurn + 529 结构化 + permission_denied 事件 + usage 文档澄清

4. **新增 `resumeDropsTurn`（配合 `resumeSessionAt` 声明截断式 resume 丢弃的 turn）** — 不接入：
   c3 只做**整会话** resume（`resume: <sessionId>`），从不截断，因此 `resumeSessionAt` 与
   `resumeDropsTurn` 都不设。（留痕：本表；同第 1 项的回归断言，额外断言二者均不在 options 中）
5. **result 消息对重复 529 过载新增 `api_error_status: 529`** — 兼容但忽略：c3 的错误分类走
   `isDegradableError` / `isSocketDisconnect` 的**文本匹配**（`kernel/agent-config/errors.ts`），
   且这两个分类器只在 `for await` **抛出**的 error message 上运行，不读 `result` 消息字段。改用
   结构化字段是一次独立的错误分类重构，本轮不夹带。（留痕：本表；
   `claude-sdk-0233-compat.test.ts`「additive result fields」断言带该字段的 result 仍正常关闭
   turn 且字段不泄漏到 wire）
6. **纯 headless（未传 `canUseTool`）工具被自动拒绝时新增 `system/permission_denied` 流事件** —
   兼容但忽略 / 不接入：**c3 的每个 `query()` 调用点都传 `canUseTool`**（`runClaude` 传
   `createCanUseTool(...)`，`askOneShot` / `runTaskTool` / automation dispatcher 各传自己的闭包），
   所以该事件在 c3 路径上根本不会产生。即便防御性地以该形状穿过消息循环，也不匹配
   `'assistant'` / `'user'` / `'result'` 任一分支，无害 fall-through。c3 的拒绝提示已由权限网关
   自己的 `permission_request` / WaitUserInvolveEvent 覆盖，无需第二条来源。
   （留痕：本表；`claude-sdk-0233-compat.test.ts`「system/permission_denied」用例断言不产生 wire
   帧、不关闭 turn）
7. **文档澄清：`usage` 仅覆盖主循环且按 turn 计；`modelUsage` 累计、覆盖全部 query pipeline，是
   成本核算应取的字段** — 仅留痕，不改代码：c3 **今天两个字段都不读**（全仓 grep `modelUsage` /
   `model_usage` 在 `server/src`、`web/src`、`shared/src` 下零命中；`transport/relay/translate.ts`
   里的 `output_tokens_details` 是 c3 自己的 OpenAI→Anthropic 转译，与本 SDK 无关），也没有成本
   核算产品面，因此**不存在「取错字段」的现状可修**。为防未来接线时取错，`runClaude` 的 `result`
   分支注释已写明「若接线，成本必须取 `modelUsage` 而非 `usage`」。
   （留痕：本表 + `kernel/agent/index.ts` 的 `result` 分支注释）

### 0.3.224 — 跨会话设置 + 通知 subkind + archive 插件源 + 沙箱凭证掩码 + 长路径修复

8. **新增 `crossSessionInbound` 与 `dialogExpiry` 设置（bypass 权限会话收到的跨会话消息扣留待批）** —
   沿用默认、不注入：二者位于 SDK `settings`，c3 **不构造任何 `settings` 对象**。c3 也不使用 SDK 的
   跨会话 `SendMessage` 投递面（团队会话由 `runClaude` 的 `InputStream` + `isTeamTool` 自行管理）。
   （留痕：本表；`claude-sdk-0233-compat.test.ts` 断言 options 无 `settings`，序列化中不含
   `crossSessionInbound` / `dialogExpiry`）
9. **`SDKMessageOrigin` 的 `task-notification` 新增 `subkind: 'peer-send-message'`** — 兼容但忽略：
   c3 的消息循环不读 `SDKMessageOrigin`（只按 `m.type` 分派），该判别值加成员不影响窄化。
   （留痕：本表）
10. **`Settings` 新增 `source: 'archive'` 插件配置变体（`url` + 可选 `sha256`，经 HTTPS 从 zip 装插件）** —
    不接入、不注入：同第 8 项，c3 不构造 `settings`。**并且这是一条要主动不碰的供应链面**——c3 的
    插件/skill 装载走本地目录，引入 HTTPS zip 源会绕开 c3 自己的分发与冷却纪律。（留痕：本表）
11. **`Settings` 新增沙箱凭证掩码字段（`decode: 'jwt'` + `maskClaims`、`envVars` 的
    `extract`/`onExtractNoMatch`、AWS SigV4 的 `awsPairs`/`sigv4`）** — 不接入、不注入：同第 8 项。
    c3 的沙箱边界由 arapuca wrapper 负责（`createSandboxWrapper`），凭证隔离由 system/custom 两种
    auth 模式各自的配置目录决定，与 SDK settings 的掩码层无交集。
    （留痕：本表；回归断言序列化中不含 `maskClaims` / `awsPairs`）
12. **修复：>200 字符项目路径在共享 sanitized 前缀下解析到另一个项目的会话目录** — 自动接入：SDK
    内部修复，c3 直接受益（session list/get/rename/tag/fork/delete 与 `/resume` 不再跨项目）。
    **c3 自身无同类问题——因为 c3 根本不做这层映射**：全仓没有任何「cwd → `~/.claude/projects/<目录名>`」
    的 sanitize/截断代码，`sessions.ts` 把**未经处理的绝对路径** `dir` 交给 SDK 自己的
    `listSessions({ dir })` 等 API，`ClaudeSessionStore` 再包一层中性接口；会话本身以 SDK 返回的
    `session_id` 为键。因此前缀碰撞面完全在 SDK 内部，此修复直接消除。（留痕：本表）

### 0.3.225 — 后台 subagent 恢复修复

13. **修复：headless/SDK 会话中的后台 subagent 在其遗留的后台 shell 命令或 Monitor 完成后从不恢复** —
    自动接入：SDK 内部修复。c3 的团队会话（`isTeamTool` 检测到 `Agent { run_in_background: true }`
    后让 lead 进程存活跨 turn）正是该缺陷的受害场景，修复随升级生效，无需 c3 改动。（留痕：本表）

### 0.3.226 / 0.3.227 / 0.3.231 — 引擎同步

14. **分别与 Claude Code v2.1.226 / v2.1.227 / v2.1.231 对齐** — 兼容确认：无 SDK 功能或类型新增。
    验证现有适配器行为未被引擎同步破坏（权限模式集合、消息循环、`claude.test.ts` 编译期守卫均
    继续通过）。

### 0.3.228 — Agent 工具结果透传 output_tokens_details

15. **`AgentOutput` 透传 `usage.output_tokens_details`** — 兼容但忽略：c3 不读 `AgentOutput` 的
    `usage`（`Agent` 的 `tool_result` 经 `stringifyToolResult` 原样转成文本帧），也无 token 明细
    产品面。（留痕：本表；同第 5 项的回归断言，`output_tokens_details` 不泄漏到 wire）

### 0.3.229 — terminal_slash_commands + 32MB 超限终止原因语义变更

16. **system init 消息新增 `terminal_slash_commands`（供 Remote Control 客户端隐藏终端命令）** —
    兼容但忽略：c3 不是 Remote Control 客户端，不渲染 slash 命令目录；`runClaude` 对 `init` 只读
    `session_id`。（留痕：本表；回归断言 `terminal_slash_commands` 不泄漏到 wire）
17. **消息体积超 32 MB 的会话，终止原因由 `terminal_reason: "image_error"` 改为 `"api_error"`；
    `StopFailure.error_details` 为 `"request_body_over_limit: …"`** — 兼容但忽略、不影响错误分类：
    c3 **不消费 `terminal_reason`，也不消费 `StopFailure`**（全仓 grep 零命中）。错误分类只看抛出的
    error message 文本（第 5 项），取值集合变化因此不改变 c3 的分类结果或展示。
    （留痕：本表；同第 5 项的回归断言，覆盖 `terminal_reason: 'api_error'` +
    `error_details: 'request_body_over_limit: …'`）

### 0.3.232 — subagent tool_use_result 形状 + context_usage + vcs push branch

18. **subagent MCP `tool_result` 帧中结果携带 `_meta` 时，`tool_use_result` 改为发出
    `{ content, _meta }` 而非裸值** — **确认不受影响**（本轮第二个深评项，因为它是**帧形状的破坏性
    变化**）：变的是 SDK user 消息上的**同级 `tool_use_result` 字段**，而 c3 解析的是
    `message.content[]` 里的 **`tool_result` 内容块**（`b.content` → `stringifyToolResult`）。全仓
    grep `tool_use_result` 在 `server/src`、`web/src`、`shared/src` 下**零命中**，task-tracker 对
    `TaskList` 结果的解析同样只吃 wire 上的 `tool_result.content`（`shared/src/task-model.ts`）。
    因此无需兼容分支。（留痕：本表；`claude-sdk-0233-compat.test.ts`「subagent tool_use_result
    reshape」用例喂入带 `tool_use_result: { content, _meta }` 的 user 消息，断言 wire `tool_result`
    的 `content` 仍为原文本、`_meta` 不泄漏）
19. **`/context` result 消息新增结构化 `context_usage` 负载（新类型 `SDKContextUsage`）** —
    兼容但忽略、不接入：c3 不发起 `/context`（`SlashCommand` 在多个 gate 里本就位于
    `disallowedTools`），也没有上下文用量卡片。（留痕：本表；同第 5 项的回归断言）
20. **`vcs_state_changed` 事件的 push 操作现填充 `branch` 字段** — 兼容但忽略：c3 不消费 SDK 的
    `vcs_state_changed`；分支与 PR 状态由 c3 自己的 forge 同步链路派生，不依赖 SDK 的 VCS 事件。
    （留痕：本表）

### 0.3.233 — Notification hooks + task/todo 工具默认面收敛

21. **Notification hooks 现会在 SDK 路径上为待决权限提示触发** — 兼容但忽略：c3 的 `query()`
    **不注册任何 hooks**，因此不会触发；用户自己 `~/.claude/settings.json` 里的 Notification hook
    会因此在 c3 托管的会话里也响起——这是与交互式 REPL **对齐**的行为，属期望内，不需要 c3 抑制。
    （留痕：本表）
22. **（重点）task/todo 工具在 Opus 4.8、Sonnet 5、Fable 5、Mythos 5 及更新模型上不再属于默认
    工具面** — **接入：显式保留工具面**。见下方深评。

## task 工具面深评（0.3.233 第 22 项，本轮唯一必须处理项）

**SDK 变化：** `TaskCreate` / `TaskGet` / `TaskUpdate` / `TaskList` 与 `TodoWrite` 在 Opus 4.8、
Sonnet 5、Fable 5、Mythos 5 及更新模型上退出**默认工具面**。要保留，须（a）在 `tools` 选项中点名，
或（b）在 `allowedTools` 中引用，或（c）设 `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`。

**c3 的依赖面（三处，全部会断）：**

- `kernel/agent/task-tracker.ts` 从 `emit()` 汇聚点观察 task 工具的 `tool_use`/`tool_result` 帧，
  折叠成 `task_list` 快照下发。**Claude 没有原生 task 推送事件——工具流就是唯一数据源**，工具消失
  ⇒ 任务面板静默为空，且没有任何错误可见；
- `adapters/claude/task-store.ts`（`ClaudeTaskStore`）经 `runTaskTool` 驱动**单个** task 工具，工具
  消失 ⇒ 整个 task store 失效，不只是展示层；
- `features/automations/mcp-freeze.ts` 把四个工具列入 `SDK_READ_TOOLS` 读写分类；automation 执行经
  `dispatcher.ts` 的 `query()`，同样落在默认工具面上。

而升级前 c3 调用 `query()` **只传 `disallowedTools`，不传 `tools` / `allowedTools`，也未设该环境
变量**——即完全依赖默认工具面。

**方案选择：**

| 通道                              | 结论     | 依据                                                                                                                                                                                                                                                                                                             |
| --------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tools: [...]`                    | **否决** | 该选项**替换**整个内建工具集合（`sdk.d.ts`：“Specify the base set of available built-in tools”）。采纳后 c3 必须永久枚举自己想要的每一个内建工具，每次 SDK 加工具都要跟着改，blast radius 与维护成本都不成比例。                                                                                                 |
| `allowedTools: [...]`             | **否决** | 该选项语义是「auto-allowed **without prompting**」（`sdk.d.ts` 原文）。它会把这四个工具**预判在 `canUseTool` 之前**，而 `canUseTool` 是 c3 的**唯一权限收口**（C-SEC）。为了恢复一个工具面而在权限层开一个旁路，方向是错的。                                                                                     |
| `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` | **采纳** | 三者中唯一**只改工具面、不碰权限语义**的通道：工具回到默认面后仍照常流经 `canUseTool`，也仍受各 gate 的 `disallowedTools` 硬切（`disallowedTools` 优先级更高，`sdk.d.ts`：“cannot be used, even if they would otherwise be allowed”），因此 intent / spec 等只读 gate 的封锁不受影响。行为与升级前**逐字一致**。 |

**落地：**

- `kernel/infra/child-env.ts` 新增 `TASK_TOOL_ENV_DEFAULTS = { CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' }`，
  在 `buildChildEnv()` 中与 `KEEPALIVE_ENV_DEFAULTS` **同一最低优先级层**合并——用户 shell
  （`process.env`）或 active agent（`envOverrides`）显式设的同名值仍然胜出，与 c3 既有的「用户优先」
  env 约定一致。这一处即覆盖 `runClaude`（工作会话）与 automation `dispatcher.ts`（两者都用
  `buildChildEnv`）；
- `kernel/agent/index.ts` 的 `runTaskTool` 原先**仅在有 `envOverrides` 时**才下发 `env`，改为**总是**
  下发 `{ ...TASK_TOOL_ENV_DEFAULTS, ...process.env, ...opts.envOverrides }`。它驱动的那一个工具**就是**
  task 工具，没有兜底余地；`env` 会整体替换子进程环境，故 `process.env` 显式回填（`PATH` / `HOME`
  等由回归用例钉住）；
- `askOneShot` 与 automation `naming.ts` **不动**：前者的 `ONESHOT_DISALLOWED_TOOLS` 本就把四个 task
  工具全部禁用（它是纯文本判官），后者是 tool-free 命名查询，都不依赖该工具面。

**能力台账结论：** `capabilities.taskStore` **维持 `true`**，不记为能力退化。该 flag 描述的是
**vendor 是否具备 task store 能力**，而 Claude SDK 依然具备——只是默认工具面收敛，需要宿主显式声明。
c3 已显式声明，行为与升级前一致，因此 ledger 无需变更。

**ADR-0011 影响：** 无。8 个 boolean flags（`interrupt`、`setActionMode`、`streamingPush`、
`inProcessMcp`、`forkSession`、`perToolApproval`、`taskStore`、`nativeUserInput`）不变，
`sessions` 子台账不变，`adapters/types.ts` 零改动。

## resume 携带 settings 深评（0.3.222 第 3 项）

**SDK 变化：** 修复 `query({ sessionStore, resume })` 未把用户 `settings.json` 的 `apiKeyHelper`、
`env`、`hooks`、`permissions` 带入**被 resume 的子进程**。

**为什么需要评估：** c3 的 resume 路径用得很重（每个非团队 turn 都是一次 `resume:<sessionId>` 新
进程，AS-R18 自动重连也走它）。若该修复把宿主用户的 `settings.json` 意外带入 c3 托管的子进程，
可能改变权限或 hook 行为——在 sandbox 模式下尤其敏感（system vendor 用宿主真实配置/凭证目录，
custom 保持隔离）。

**核对结果——c3 不落在该修复的触发条件上：**

1. **触发条件是 `sessionStore` + `resume` 同时出现。** c3 走的是**裸 `resume`**：
   `kernel/agent/index.ts` 的 options 里没有 `sessionStore` 字段（回归用例断言其缺席）。会话 JSONL
   由 c3 自己按 SDK 的磁盘布局读写（`sessions.ts`），不经 SDK 的 session store 抽象。
2. **c3 本就显式声明 `settingSources: ['user', 'project']`**（ADR-0005 的既定选择：继承宿主的
   hooks / allow 规则 / Skills / CLAUDE.md）。也就是说 c3 **首轮与 resume 轮一直采用同一套 setting
   来源**——这个修复方向上要补齐的正是 c3 已经显式要的东西，不会引入 c3 没要过的行为。
3. **`env` 由 c3 完全决定，与 settings 无关。** 每次 `query()` 都显式下发
   `env: buildChildEnv(envOverrides)`（SDK 语义：`env` 一旦设置就**整体替换**子进程环境）。因此
   settings.json 的 `env` 段不会覆盖 c3 的 relay / keepalive / NO_PROXY 注入。
4. **sandbox 模式不受影响。** 沙箱边界由 arapuca wrapper（`createSandboxWrapper`）在**进程外**画出，
   与 SDK 读哪份 settings 无关；system/custom 两种模式各自的配置目录选择也不经 SDK settings 传递。

**结论：** 行为无变化，无需改动，无需补兼容分支。回归断言（resume 路径上 `resume` 存在、
`sessionStore` 缺席、`env` 显式存在、`settingSources` 仍为 `['user','project']`）已把这四条前提钉在
`pnpm vitest run` 上——将来若有人给 c3 接上 `sessionStore`，这条用例会先红。

## 权限模式集合复核

对实际安装的 0.3.233 产物核对：

- 类型层（`sdk.d.ts:2171`）：`'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'`
- 运行时校验数组（`sdk.mjs`）：`["acceptEdits","auto","bypassPermissions","default","dontAsk","plan"]`

两者与 0.3.220 **逐字一致**，完整包含 c3 产出的五种 token（`default`、`auto`、`plan`、`acceptEdits`、
`bypassPermissions`）。`adapters/claude/claude.test.ts` 既有 `satisfies SdkPermissionMode[]` 守卫继续把
该约束钉在 `pnpm typecheck` 上，无需改动。

## 加性字段的兼容忽略路径确认

本轮引入的全部加性字段与事件在 `runClaude` 消息循环中的处理一致：

- `system/permission_denied` 不匹配 `'assistant'` / `'user'` / `'result'` 任一分支，无害
  fall-through（且 c3 每个调用点都传 `canUseTool`，它根本不会产生）；
- `init`（`system`）上的 `terminal_slash_commands` 不被读取，不影响 `session_id` 提取；
- `result` 上的 `api_error_status`、`terminal_reason`、`error_details`、`modelUsage`、
  `usage.output_tokens_details`、`context_usage` 均不被读取，不影响 turn 关闭；
- user 消息上的 `tool_use_result`（无论裸值还是 `{ content, _meta }`）不被读取——c3 只解析
  `message.content[]` 中的 `tool_result` 内容块；
- 不影响 `sawResult`、`sawVisibleOutput`、`isTeam`、`openSideEffects` 等状态变量；
- 不产生 wire 内容帧，不生成 `CanonicalMessage` 转换。

回归测试 `server/src/claude-sdk-0233-compat.test.ts`（驱动真实 `runClaude` / `runTaskTool` + mock SDK
`query`，沿用 `claude-sdk-0220-compat.test.ts` 模式，8 个用例）把上述各条钉死，并额外覆盖第 22 项的
正向断言：`env.CLAUDE_CODE_ENABLE_TODO_TOOLS === '1'`、options 不含 `tools` / `allowedTools`、
`canUseTool` 仍在位，以及一次完整的 `TaskList` `tool_use`→`tool_result` 帧经共享模型
（`applyTaskTool`，任务面板的单一 SoT）折叠出非空快照。`kernel/infra/child-env.test.ts` 另加 3 个用例
覆盖 env 常量本身与其优先级。

## ADR-0011 判断

**不更新。** 全部变更为：

1. SDK 内部修复（MCP 首轮连接、长路径会话目录串项目、后台 subagent 恢复），c3 不参与、自动受益；
2. 既有消息上的可选加性字段（`api_error_status`、`terminal_reason`、`modelUsage`、
   `output_tokens_details`、`context_usage`、`terminal_slash_commands`）与新流事件
   （`system/permission_denied`），c3 无消费点，不产生 vendor 中性能力或 flag；
3. `tool_use_result` 帧形状变化：c3 的解析点不在该字段上，无兼容分支，无中性面变化；
4. SDK settings 新增各项（`crossSessionInbound`、`dialogExpiry`、archive 插件源、沙箱凭证掩码）与
   `skills` 校验、`resumeDropsTurn`：c3 不构造 `settings`、不传 `skills` / `resumeDropsTurn`，
   与 vendor 中性适配器面无交集；
5. **task 工具面收敛：c3 显式保留了工具面，`capabilities.taskStore` 维持 `true`，行为与升级前一致
   ⇒ 无能力退化可记。** 保留手段是 Claude 侧的子进程 env，属 vendor **实现细节**，不上升为中性
   capability（其它 vendor 的 task store 有各自的可用性前提，`adapters/codex/task-store.ts` 亦然）。

capability ledger 的 8 个 boolean flags、`sessions` 子台账、neutral permission grid 与 `canFormTeam`
声明均不受影响；`adapters/types.ts` 零改动。

## 验证

- `pnpm typecheck`：通过（server + web 全绿，SDK 类型升级未破坏权限模式约束、消息窄化及 adapter
  编译契约）。
- `pnpm lint`（`eslint .`）：**0 error**，17 个 warning。全部是「未使用的导入/变量」，分布在 9 个
  文件：`server/src/features/deliveries/index.test.ts`、`server/src/features/intents/session-worktree.test.ts`、
  `server/src/kernel/config/index.ts`、`server/src/kernel/events/event-match.test.ts`、
  `shared/src/protocol.test.ts`、`web/src/App.vue`、`web/src/controls/message-handler.ts`、
  `web/src/controls/state.ts`、`web/src/pages/workspacesetting/WorkspaceSetting.vue`。**没有一个是本次
  改动的文件**（本轮改动仅 `kernel/infra/child-env.ts(.test.ts)`、`kernel/agent/index.ts`、
  `claude-sdk-0233-compat.test.ts`），全部为预存项、与 SDK 无关。
  与上一份记录的 4 个相比数量上升，来自 2026-08-02 之后合入主线的其它改动（`deliveries`、
  `session-worktree`、`kernel/config`、web 交付面），**不是本次升级引入**。
- `pnpm vitest run` 全量套件（项目默认 pool）：**445 个测试文件通过 / 1 跳过、7332 个用例通过 /
  16 跳过、0 失败**，**无新增 skip**（1 文件 / 16 用例跳过与升级前基线一致）。新增
  `claude-sdk-0233-compat.test.ts`（8 用例）与 `child-env.test.ts` 的 3 个新用例，共 11 条新断言，
  覆盖 task 工具面保留、`system/permission_denied` fall-through、加性 result 字段、
  `tool_use_result` 形状变化、以及 c3 不构造的四类 option 面。
- `server/package.json`：仅 `@anthropic-ai/claude-agent-sdk` `^0.3.220 → ^0.3.233`。
- `pnpm-lock.yaml`：diff 仅含 claude-agent-sdk 主包 specifier + 8 个平台子包的版本号/integrity 行
  （`0.3.220 → 0.3.233`，37 增 / 37 删），无关依赖零改动，无 `0.3.220` 残留。
- `pnpm-workspace.yaml`：零改动，未放宽 `minimumReleaseAge` 冷却策略。
- 权限模式集合：对实际安装的 0.3.233 产物核对 `sdk.d.ts` 类型联合与 `sdk.mjs` 运行时校验数组，
  两者逐字一致且均完整包含 c3 五种 token。
- 生产代码改动仅两处，都服务于第 22 项：`kernel/infra/child-env.ts`（新增 `TASK_TOOL_ENV_DEFAULTS`
  并并入 `buildChildEnv`）与 `kernel/agent/index.ts`（`runTaskTool` 总是下发 env；`result` 分支注释
  补 `modelUsage` 取值指引）。
- 文档留痕：本记录逐项覆盖 22 条上游变化；索引 `sdk-upgrade-records.md` 与指南
  `claude-agent-sdk-guide.md` 适用版本同步为 `^0.3.233`；明确「ADR-0011 不更新」及理由。
