# agent-session — 设计

实现[规格文档](agent-session-spec.md)。运行循环驱动 SDK;一个进程范围的 session-runtime
注册表在各连接间拥有运行;WebSocket 处理器持有每连接的视图。
入站 SDK 消息被扁平化为线事件。

## Run construction

运行调用 SDK 的 `query()`,参数如下:

| Option                            | Value                                       | Why                                                                                                                                                     |
| --------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt`                          | 流式输入的 async-iterable                   | 流式输入模式(AS-R13, ADR 0008):用户的第一个 turn 被推入;保持 SDK 控制通道存活,让 team lead 能比一次 `result` 存活得更久。不是一次性字符串。             |
| `cwd`                             | 会话的工作区路径                            | Claude 读写的位置(AS-R1)                                                                                                                                |
| `resume`                          | session id \| omit                          | 继续一个已有会话;pending 会话的首次运行时省略(AS-R10)                                                                                                   |
| `settingSources`                  | `['user', 'project']`                       | 继承用户/项目设置、hook、allow 规则、Skills — ADR 0005 / C-SEC-1                                                                                        |
| `systemPrompt`                    | `{ type: 'preset', preset: 'claude_code' }` | 使用 Claude Code 的完整 system prompt,包括动态部分(工作目录、git 状态、CLAUDE.md/memory);没有它 SDK 0.3.x 的默认值会省略环境上下文,模型永远学不到 `cwd` |
| `permissionMode`                  | 会话的模式(来自其 runtime)                  | 起始策略(AS-R3)                                                                                                                                         |
| `allowDangerouslySkipPermissions` | `true`                                      | 允许随时切换到 `bypassPermissions`;c3 仍是 UI(C-SEC)                                                                                                    |
| `pathToClaudeCodeExecutable`      | 解析出的 `claude` 路径                      | 仅在找到时设置(ADR 0003)                                                                                                                                |
| `env`                             | `{ ...process.env, ...overrides }` \| omit  | 活跃 agent 的 `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`;系统 agent 时省略(agent-config AC-R4/R5)                                  |
| `model`                           | 活跃 agent 的模型 \| omit                   | 来自活跃 agent 的模型覆盖;省略 ⇒ SDK 默认(agent-config AC-R5)                                                                                           |
| `canUseTool`                      | gateway 回调                                | 门控敏感工具(AS-R5)                                                                                                                                     |

一个 start callback 会把 **Run Handle**(设置权限模式、推入输入)回传,以便运行中的
`set_mode` 能对实时 query 应用新模式(AS-R4),team 会话的下一个 turn 能推入
下一个用户 turn(AS-R17)。session-id callback 会报告 `init` 消息中的 SDK session id;
服务器把 runtime 从 pending 重新键入为真实值,并将模式持久化到该 id 下(AS-R10,见
[session-registry design](../session-registry/session-registry-design.md))。team callback 在看到第一个
team 工具时触发一次——服务器把 runtime 标记为 `team` 并发出 `team_upgraded`(见 § Team
sessions)。运行的 send callback 把每个事件都路由到 runtime 的 buffer + viewers,从不
直接发到 socket(AS-R11)。

### Driver-path 远程 MCP(2026-06-12-005)

Claude 路径通过进程内 SDK 服务器(`createSdkMcpServer`)接入 MCP。Driver-path 厂商
无法加载这些,因此中立的 driver-start 选项携带一个中立的远程 MCP map(以名称标识的
HTTP 服务器,带 URL 和可选的 bearer-token 环境变量),每个 driver 将其转换为
自身原生的配置——codex driver 写入 codex CLI 的
`codex mcp add --url` 形式所产生的 streamable-HTTP 服务器条目。c3 目前唯一的生产者是
intent comm-agent:driver 路径绑定一个每次运行的 localhost HTTP MCP 路由,携带
三个 intent 工具(见
[intent-management design § Intent tools over localhost HTTP MCP](../intent-management/intent-management-design.md))。
Codex 是由 c3 自身极简的 `codex exec --experimental-json` 包装器启动的,而非
`@openai/codex-sdk` 运行时包装器;该 SDK 包在 Codex adapter 内部仅作为
事件/类型参考保留。

### Codex GitHub CLI 凭据注入

一个 codex 会话运行在 codex 自身的 seatbelt 沙箱下(可选还有 docker 容器),其
子进程无法读取宿主 OS 密钥链——因此把令牌存在那里的 `gh` 即使在已鉴权、有网络的宿主上
也会在会话内鉴权失败。`run-via-driver` 会解析一次宿主的 `gh`
凭据(在 agent-launch 环境解析之后、构建沙箱 env-file 并调用
`driver.start` 之前),并在 `GH_TOKEN` 和 `GITHUB_TOKEN` 都尚未设置时(遵循
`buildChildEnv` 的优先级:agent 覆盖 > shell > 默认值),把 `GH_TOKEN` 注入到同一个
`envOverrides` 中——这样宿主 codex 进程和容器包装器的 env-file 就能得到相同的值。
仅限 Codex(claude 路径没有 seatbelt 边界);探测失败会静默降级,从不阻塞
启动;该令牌从不写入磁盘、记录日志或出现在遥测中。见
[codex-sdk-guide § GitHub CLI 凭据桥接](../../../architecture/codex-sdk-guide.md)。

### 流式输入 prompt

流式输入 prompt 是一个受控的 SDK 用户消息 async-iterable,支撑
`prompt` 选项(AS-R13)。与普通字符串 prompt 不同——后者在 `result` 到达的瞬间
就结束 query——它会让 query(以及底层 Claude Code 进程)保持存活,直到被关闭:

- 推入文本(可带可选图片)会把另一个用户 turn 加入到**同一个**实时会话中(不
  `resume`,不新建进程);一个挂起的迭代器会立即被解析,否则会排队。
- 关闭会结束该流,使迭代返回,query 正常终止。
- 构造流程先推入原始 prompt(及其图片,如果有),然后循环运行。

**Prompt 图片(2026-06-16)**:当第一个 turn 携带图片时,推送会把 SDK 用户
消息内容构建为一个 block 数组——一个前导文本 block 加上每个附件一个 base64 图片 block——
而不是一个普通字符串(这是 CLI 原样转发的 Anthropic Messages 内容形状)。仅有
文本的 turn 仍是字符串(不变)。team lead 推入的 turn 始终为纯文本。图片通过
中立的 driver-start / run-options images 字段到达,Codex 路径以不同方式编码
同一字段(临时文件的 `--image` 路径——见 [codex-sdk-guide](../../../architecture/codex-sdk-guide.md))。

除 team 之外还有两个好处:SDK 控制请求(`setPermissionMode` / `interrupt`)**仅**在
流式输入模式下生效——在字符串 prompt 下它们会被静默吞掉(ADR 0008)。

## Session-runtime registry

一个模块级的从 session id 到 session runtime 的 map(见[数据模型](agent-session-models.md)),跨
连接共享。关键操作:

| Operation                      | Role                                                            |
| ------------------------------ | --------------------------------------------------------------- |
| Ensure runtime                 | Get-or-create;仅播种一次 baseline(每个进程每个会话只读一次磁盘) |
| Emit event                     | 追加到 buffer,分发给 viewers,推进状态,变更时广播(AS-R11/R12)    |
| Add / remove viewer            | 连接在切换视图时订阅/取消订阅                                   |
| Bind pending → real            | 重新键入 runtime;buffer/viewers/run 随之移动(AS-R10)            |
| Stop run                       | 中止进行中的运行(AS-R6)                                         |
| Remove runtime / for-workspace | 在删除/工作区移除时中止 + 丢弃                                  |
| Set status-change hook         | 服务器 hook;广播使所有连接都能收到 `session_status`             |

## Per-connection state

连接是一个**视图**,不是运行的所有者:

| Field   | Lifetime                                          |
| ------- | ------------------------------------------------- |
| Viewing | 该连接当前观察的会话(一个 runtime 键)             |
| Socket  | 打开时设置,关闭时清空;支撑分发                    |
| Deliver | 向该 socket 发送线事件(viewer + status broadcast) |

一个模块级集合持有所有存活连接,用于 `session_status` 广播;runtime 的
status-change hook 接到此处。

在 `user_prompt` 上:解析所观察会话的 runtime(否则 `error`)。**附件守卫
(2026-06-16)**:消息可能携带图片(base64 + media type);处理器在遇到第一个
非图片 media type 时会以 `error { code: 'prompt.unsupportedFile' }` 拒绝整个
turn——c3 只转发图片,不转发通用文件。校验通过的图片会流入运行分叉去的任意 vendor 路径。若
runtime 处于 `team` 且有实时的 run handle,**不**启动第二个运行——发出 `user_text`
回显,设置状态为 running,并推入输入(AS-R17)。否则,若已有运行,以
`error` 拒绝(串行,AS-R2)。服务器在这里严格保持单 turn;web console 通过**客户端排队**
向用户隐藏这个拒绝——对一个普通运行中的会话,它会扣留
`user_prompt`,在本地排队文本,只有在会话
回到 idle 时才发送(合并为一个 prompt)(见 [web-console design](../web-console/web-console-design.md), WC-R17)。服务器在这里一次只看到一个
普通 turn,并不知道有队列存在。否则创建一个全新的中止控制器,设置
运行,发出 `user_text` 回显,设置状态为 running,推导 `resume`,并用一个 send
callback 将运行接入 runtime 及 team hook 后启动运行。运行 id 是可变的:绑定 pending→real 会更新它,以便
绑定后的事件指向真实的键。在 finally 块中:如果仍是当前运行则清空,若运行是被停止的
则发出一个合成的 `turn_end`(以便正在观察的输入解锁),设置状态为 idle,刷新
会话列表。**从不中止任何其他会话。**

在 `select_session` / `create_session` 上:移除旧的 viewer,然后要么重用
已有的 runtime,要么从磁盘播种一个冷的;发送 `session_selected`(history = baseline,running = 是否有
运行进行中),把 buffer 作为实时事件回放,然后加入 viewer。回放块中没有 await,因此
它对并发的 emit 是原子的。`stop_run` 会停止所观察会话的运行。

## Stop / interrupt

```mermaid
sequenceDiagram
    participant UI
    participant WS as connection handler
    participant REG as runtime registry
    participant RUN as run loop
    participant SDK as query()
    UI->>WS: stop_run (viewed session)
    WS->>REG: stop the viewed session's run
    REG->>RUN: abort
    RUN->>SDK: close input  (ends the streaming prompt → query loop terminates)
    RUN->>SDK: interrupt  (Promise; .catch swallows late rejection)
    Note over WS: finally emits turn_end(complete); status → idle
```

abort listener 做两件事:关闭输入结束流式输入 prompt——这是
team 会话停止的**唯一**方式,因为它的输入从不自动关闭(AS-R16)——然后 `interrupt()`
切断进行中的 turn。当 query 已经结束或尚未流式传输时,`interrupt()`
可能异步 reject("ProcessTransport is not ready for
writing");该 rejection 被吞掉,永远不会使进程崩溃(AS-R6, AVAIL-4)。切换视图或关闭 socket 永远不会
走到这条路径。

## Message mapping(SDK → 线协议)

对 `query()` 的迭代把每个 SDK 消息映射为(AS-R9):

| SDK message | Block                       | Wire event                                                                                                                                     |
| ----------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `system`    | `init`(带 session id)       | 报告一次 session id(AS-R10)                                                                                                                    |
| `assistant` | text                        | `assistant_text { text }`                                                                                                                      |
| `assistant` | tool-use(带 id + name)      | `tool_use { toolUseId, toolName, input }`;若为 team 工具 ⇒ 先触发一次 team hook(AS-R14)                                                        |
| `user`      | tool-result(带 tool-use id) | `tool_result { toolUseId, content, isError }`                                                                                                  |
| `result`    | —                           | 若该 turn 未产生任何可见 block ⇒ 先发 `notice { text }`,再发 `turn_end { reason: 'complete' }`,然后分叉:非 team 关闭输入;team 保持打开(AS-R15) |

- 用户 prompt 在运行开始前作为 `user_text { text }` 回显一次(AS-R1),因此
  切回时的回放能展示它(它不在之前捕获的磁盘 baseline 中)。
- 一个只产生 thinking block 的 turn(模型思考了,然后没有文本或 tool-use 就结束了)
  按 turn 跟踪;`result` 分支随后在 `turn_end` 之前发出 `notice { text }`,使该
  turn 渲染为一条静音提示行,而不是无声的空白(空 turn 否则与
  卡死无法区分)。该标记每个 turn 重置(team lead 跨 turn 复用同一进程)。磁盘回放
  按**turn**而非按消息镜像此行为:转录把一个 turn 拆分为若干单 block 消息
  (一条 thinking 消息、一条 text 消息、一条 tool-use 消息……),因此单独一条 thinking 消息通常只是
  一个仍会继续的 turn 的引子——只有当整个 turn(直到下一个真正的
  用户 prompt)只思考而没有产生 assistant 文本或工具调用时,才会加上 notice。
- Tool-result 内容被扁平化(字符串原样保留;数组 → 用换行连接的文本 block,非文本
  JSON 化;否则整体 JSON 化)。
- 循环中未被中止的异常,会发送 `turn_end { reason: 'error', error }`(AS-R7)。当
  被停止(中止)时,运行循环不发送任何终止事件;连接的 finally 会发出一个合成的
  `turn_end { reason: 'complete' }`,以便正在观察的输入解锁。
- 循环每次迭代都检查中止信号,并 break。

### 断线自动重连(AS-R18 / AS-R19, AVAIL-7)

catch 块以固定顺序对错误分类,使两条路径永不交叉:

1. **Socket disconnect**(一个针对 `socket connection was closed
unexpectedly` 的窄、单短语匹配器,故意与可降级错误匹配器分离)——若已接入
   socket-disconnect callback,运行会延迟(不发 `turn_end`)并上报错误加上一个
   side-effect-pending 结论。side-effect-pending 标记来自一个镜像 side-effect 计算的实时集合:一个
   **side-effect-class** 的 tool-use 打开一个条目,其 tool-result 关闭它;断线时该集合
   非空意味着一次写入可能已半途应用(AS-R19)。side-effect-**free** 工具的允许列表是
   保守的——任何不在其中的(包括 `Bash` 和未知/MCP 工具)都算作 side
   effect。
2. **Degradable error** — 沿用已有的降级链绕过逻辑。
3. 其他情况——一个终止性的 `turn_end { reason: 'error' }`。

服务器拥有有界的重试守卫。在一次 socket disconnect 上,一个纯函数决策仅当以下合取
成立时才返回自动 resume(自动 resume 开启、门控清晰、单次重试未用、有真实运行 id、非
team、未被中止)。在自动 resume 上:标记重试已用,设置状态为 `reconnecting`,等待一个 3–5 秒的
可中止退避,然后用 `resume` 重新运行到同一个 id + 一个 reconnect-attempt 标记(同一 SDK
session ⇒ 完整上下文)。恢复的运行会把原始 prompt 作为继续 turn 重新推入;这
是安全的,_因为_ 门控已经保证没有未关闭的**写**类 tool-use(AS-R19)——最坏情况下是重复了一次
读,而不会重复一次写。成功的 resume 会发出自己的 `turn_end { reason:
'complete', reconnect_attempted: true, retry_count: 1 }`。否则该决策会返回 manual-error,
服务器在其结算为 idle 之前会发出其 `turn_end { reason: 'error', side_effect_pending, original_error, … }`。
一次 socket disconnect **从不**可降级——它会离开降级循环而不是尝试
下一个 agent——并被限定为每个 turn 最多**一次** resume。因为 resume 复用
同一个运行 id(单一存活的 runtime 实例,运行在退避期间从不为 null),它不会与
liveness-reconcile 的僵尸清理产生竞争。

## Team sessions(持久化 agent team)

当 lead 委派的工作必须比当前 turn 存活得更久时,一次运行会变成持久化的 **agent
team**——若不让 lead 进程存活,lead 的 `result` 会关闭字符串 prompt 的 query,
在后台队友返回结果之前退出进程并使其孤儿化/被杀(这是
诱发该 bug 的动机;ADR 0008)。

**检测**在每个 tool-use block 上于该 turn 的 `result` 之前评估,恰好触发一次
team hook:

| Tool                                      | Team? | Why                            |
| ----------------------------------------- | ----- | ------------------------------ |
| `TeamCreate`                              | yes   | 仅存在于 team 模式             |
| `SendMessage`                             | yes   | 仅存在于 team 模式             |
| `Agent` with `run_in_background === true` | yes   | 一个异步回报的分离队友         |
| `Agent`(foreground)                       | no    | 一个在该 turn 内完成的子 agent |

**生命周期:**

1. team hook → 服务器把 runtime 标记为 team,发出 `team_upgraded`(记录在
   buffer 中,以便重连回放时能看到),并设置状态为 `team`。
2. 在 `result` 上,team 运行保持输入打开(相比非 team 运行会关闭它);lead 进程
   保持存活,SDK 会在下一个 turn(一次队友通知或一个推入的用户
   prompt)重新唤醒它。runtime 保持 `team` 状态,因为发出的 `turn_end` 本会暗示 idle,但
   team override 保持住了它(见 [session-registry design](../session-registry/session-registry-design.md))。
3. 下一个用户 turn:服务器把它推入实时会话——不启动第二个运行,不
   `resume`——在回显 `user_text` 并设置为 running 之后(AS-R17)。
4. 结束:仅在用户停止时。abort listener 关闭这个从不自动关闭的流(加上 `interrupt`);
   运行的 finally 重置 team 标记并回落到 idle(AS-R16)。没有自动的"team
   disbanded" 检测。

## claude 可执行文件查找

claude 查找(带记忆化):若设置了 `$CLAUDE_PATH` 则用它,否则 `command -v claude`。若未
找到则返回空,此时该选项被省略,SDK 回落到它自己的查找。理由及
单二进制上下文见 ADR 0003。

## Technology choices

- **Hono + 其 Node WebSocket adapter** 用于 HTTP 和 WebSocket upgrade。
- **一个中止控制器** 作为桥接到 `interrupt()` 的中止信号。
- **可辨识联合类型窄化** 对 SDK block 和线消息的类型标签进行处理;除了在
  无类型的 SDK 边界处所需的最小结构性类型转换之外,不做类型漂白(SDK block 的形状
  在被窄化之前是未知的)。

## Non-functional considerations

- **每个会话最多一个进行中的运行**(串行,AS-R2);**多会话并发**,无上限。
- **运行不受断线影响** ——它们存活于模块级注册表中,而非 socket 中(ADR 0006,
  AS-R8);重连通过 baseline + buffer 回放。
- **错误暴露** 从不静默(AVAIL-1, AS-R7)。
- **不持久化运行/权限状态** ——在注册表中内存态(SEC-2);buffer 不
  被淘汰(在当前使用规模下可接受)。会话连续性来自 SDK 转录
  存储(通过 `resume`);工作区/会话注册表由
  [session-registry](../session-registry/session-registry-design.md) 持久化(ADR 0004)。

## Dependencies

- **`@anthropic-ai/claude-agent-sdk`** — `query()`(流式输入 prompt)、`setPermissionMode`、
  `interrupt`;agent-team 工具(`TeamCreate` / `SendMessage` / background `Agent`)。
- **宿主 `claude` CLI** — 运行时必需;缺失会呈现为一个运行错误。
- **permission-gateway** — 决策的等待/解析。
- **agent-config** — 提供运行的 `env` 覆盖和 `model`(绑定的或默认 agent 的
  Claude 配置)。
