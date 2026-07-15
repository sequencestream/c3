# 事件机制（Event Mechanism）

> 本文是**活文档（current state）**：描述 c3 事件机制现在整体长什么样、各部件如何协作、以及如何扩展与优化。
> 设计**决策的出处与权衡**见 [ADR-0018](adr/0018-event-bus-kernel-layer.md)（为什么选 topic-based 同步总线）与
> [ADR-0026](adr/0026-generic-event-normalizer-registry.md)（模型可发布事件为何改用「通用契约 + 按 type 注册归一化器」）；
> 本文在其之上补齐后续新增的 `intent:lifecycle` topic、面向模型的**单一** `publish_event` 发布表面
> （通用事件经归一化后以 `GenericEventEnvelope` 落到单一 `'event'` topic，消费者按 `event.type` 判别，§6/§9.3），
> 以及 Automation 的事件触发过滤器。2026-07-14 引入 `<category>:<action>` 事件命名规范（§事件类型目录）、多行订阅 `eventFilters[]`、大类通配 `:*` 支持、以及 sessionKind/runKind 同构化进入 event.metadata。
> 二者的分工：ADR 回答「为什么这么选」，本文回答「现在整体怎么运转、怎么往上加」。

## 0. 一句话心智模型

c3 内部所有「跨特性的事情发生了」都走**同一条进程内总线** `EventBus`：

- **生产者**把发生的事 `publish('<topic>', payload)` 到总线，**不关心谁在听**；
- **消费者**在启动时 `subscribe('<topic>', handler)`，**只听自己关心的 topic**；
- 总线**同步、按注册序、错误隔离**地分发，发布者从不等待消费者。

模型（Claude/Codex）**不能直接碰总线**。它只能调用一个收敛的 MCP 工具 `publish_event`（入参就是通用事件 `GenericEvent`），由服务端 handler 按 `type` 归一化（脱敏/截断）+补信封后，**代它**以 `GenericEventEnvelope` 发到单一 `'event'` topic。这是「事件机制」唯一对模型开放的入口。此外，c3 三条服务端自建 PR 的路径（dev-cleanup / automation / 手动 create_pr）在成功建 PR 后也会构造 `type='pr:operation'` 的 `create` 通用事件走同一条链——PR 操作事件有两个发布者，都落到 `'event'` topic。

```
                         ┌──────────────── EventBus（kernel 层，同步/错误隔离/类型化 topic→payload） ───────────────┐
  内部生产者 ─publish──►  │  run:bound  run:started  run:settled                                                   │
  （run launcher /        │  agent:error  agent:fallback  agent:all_failed                                          │ ──► 内部消费者（常驻订阅）
    intents / scheduler）  │  intent:status_changed  intent:lifecycle                                                │      · 各 domain 列表广播
                          │  event（GenericEventEnvelope，消费者按 event.type 判别）                                 │      · automation 编排 FSM
  模型 ─MCP工具─► handler ─┘                                                                                         │      · Automation 事件触发分发
   publish_event   （按 type 归一化+脱敏+补 workspace/session 信封）                                                  │      · intent PR 状态复位
                                                                                         └──────────────────────────────┘
  c3 自建 PR ─服务端路径─► publishEvent sink（'event' topic）
  （dev-cleanup /
    automation /
    手动 create_pr）
```

## 1. 三层结构（扩展点都在前两层）

| 层                               | 是否已支持多事件                                                                                     | 说明                                        |
| -------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| **总线核 `EventBus`**            | ✅ 类型化 topic map，任意扩 topic                                                                    | `server/src/kernel/events/event-bus.ts`     |
| **订阅侧（含 Automation 订阅）** | ✅ 通用 `eventFilters[]` 多行 OR + `:*` 大类通配                                                     | 常驻订阅 + `dispatchEventTriggers(view)`    |
| **模型可发布事件（归一化层）**   | ✅ 按 type 注册归一化器 + 默认归一化器兜底自定义 type；当前注册 6 个 `pr:<op>` + `pr:operation` 别名 | `server/src/kernel/events/generic-event.ts` |
| **模型对外 MCP 工具**            | ✅ 单一通用 `publish_event`（入参即 `GenericEvent`）                                                 | `server/src/features/events/tool-defs.ts`   |

**关键认知**：你要的「扩展性」绝大部分已在**总线核 + 订阅侧**就位——加新事件类型是「一行 topic + 一处 publish」，已有订阅者零改动（ADR-0018 已验证：降级链三个 agent topic 就是这么加进来的）。**模型可发布事件**这层经 kernel 归一化器注册表按 `type` 分派（[ADR-0026](adr/0026-generic-event-normalizer-registry.md)，§9.3）：已知 type 走其专用归一化器,其余自定义 type 落到**默认归一化器**兜底（仍做字段级脱敏/截断,只是不绑定固定字段形状）——`type` 是开放的 `<category>:<action>` 字符串,`custom:*` 也能发布,不再「未注册即拒」。**模型对外 MCP 工具**现在收敛为单一 `publish_event`：入参就是通用事件，`type` 选中注册的归一化器，加新可发布事件时**工具面零改动**，只需注册一个归一化器（见 [§7 扩展指南](#7-扩展指南)）。

## 2. 总线核：`EventBus` 语义

定义于 `server/src/kernel/events/event-bus.ts`，是一个无 I/O 的纯类，三个操作：`publish` / `subscribe`（返回 dispose 函数）/ `clear`。

| 维度             | 决策                                | 含义                                                                  |
| ---------------- | ----------------------------------- | --------------------------------------------------------------------- |
| **分发**         | 同步、按订阅注册序                  | `publish` 返回 `void`；发布者调用栈内完成所有 handler                 |
| **错误隔离**     | 每个 handler `try/catch`            | 一个 handler 抛错被捕获并日志，**不中止后续 handler、不传播给发布者** |
| **异步 handler** | fire-and-forget                     | handler 返回 Promise 时总线捕获 unhandled rejection 但**不 await**    |
| **类型安全**     | `EventBusEvents` 映射 topic→payload | `publish`/`subscribe` 编译期按 topic 校验 payload 形状                |
| **位置**         | kernel 自包含模块                   | 不 import features/transport 层（ADR-0009 R1 边界）                   |

> ⚠️ **同步语义的副作用**：发布者在自己的调用栈里跑完所有订阅者。订阅者里做重活会拖慢发布路径，且异步副作用的完成顺序对发布者不可见（ADR-0018 否决了 microtask 异步分发正是为此）。订阅者应「快进快出」，重活自己起异步链。

## 3. Topic 目录（当前全集）

唯一定义源：`EventBusEvents`（`event-bus.ts`）。payload 中的领域类型定义在 `shared/src/protocol.ts`。

| Topic                   | Payload（要点）                                                                          | 发布者                                        | 主要消费者                                                                                                                                                                                                                                                                         |
| ----------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run:bound`             | `prevId, realId, workspacePath`                                                          | run launcher / discussion starter / scheduler | 常驻 run-bound 订阅（pending→real 绑定、intent 重绑、session-started 广播）                                                                                                                                                                                                        |
| `run:started`           | `sessionId, workspacePath, sessionKind: SessionKind, runKind: RunKind`                   | 同上                                          | Automation 事件触发分发                                                                                                                                                                                                                                                            |
| `run:settled`           | `sessionId, workspacePath, reason: RunEndReason, sessionKind, runKind`                   | 同上                                          | 各 domain 列表广播 + automation 编排 FSM + Automation 触发                                                                                                                                                                                                                         |
| `agent:error`           | `sessionId, workspacePath, agentId, agentName, error, degradable`                        | run launcher（降级链）                        | 审计 / 可挂动作（bypass，不改降级控制流）                                                                                                                                                                                                                                          |
| `agent:fallback`        | `from*/to* agentId+Name`                                                                 | 同上                                          | 同上                                                                                                                                                                                                                                                                               |
| `agent:all_failed`      | `agents[], crossVendorSkipped?`                                                          | 同上                                          | 同上                                                                                                                                                                                                                                                                               |
| `intent:status_changed` | `intentId, workspacePath, fromStatus, toStatus`                                          | `update_intent_status` handler                | automation 编排 / 审计                                                                                                                                                                                                                                                             |
| `intent:lifecycle`      | `{ workspacePath } & IntentLifecycleEvent`（`phase, intentId, title, module, toStatus`） | intents 生命周期                              | Automation 事件触发分发（相位已迁入 `intent:<phase>` type）                                                                                                                                                                                                                        |
| `event`                 | `GenericEventEnvelope = { workspacePath, sessionId, event: GenericEvent }`               | **模型经 `publish_event` 工具** + c3 自建 PR  | 消费者按 `event.type` 判别。当前 `type='pr:operation'` 有两个独立消费者:①Automation 事件触发分发(判别 PR type 后从 `metadata.operation`+`status` 投影,按 `operation`+`result` 过滤);②intent-domain PR 状态复位(`pr:update`/success 把 rejected/failed/closed 意图复位为 reviewing) |

枚举常量（`shared/src/protocol.ts`，均为 `as const` 数组派生联合）：

- `SessionKind = work | intent | discussion | automation | consensus | tool | spec`
  ——run 的**业务场景**分类（业务来源判断走它）。**注意 `automation` 是「触发源」不是「run 类型」**：被 automation 触发的目标用户 run 仍是 `work` kind，`automation` 只标记 scheduler 自己那个无 socket 的 run。事件触发的 Automation 因此只在 `sessionKind === 'work'` 上 fire。原 `RunKind` 的 7 个业务值于 2026-06-26 整体迁入此处（`'session' → 'work'`）。
- `RunKind = interactive | background | headless | internal`
  ——run 的**执行形态**分类（执行机制判断走它），与 `SessionKind` 正交。同一 `sessionKind` 的两个 run 执行形态可不同——例如 `work` 用户控制台是 `interactive`，而 `work` 的 automation dev-turn 是 `background`。目前仅作记录/审计字段，暂无消费分支。
- `RunEndReason = complete | error | aborted`
- `PR_OPERATIONS = create | review | merge | close | comment | update`（`update` = 已有 PR 被模型修改后重新提交/重新打开，非新建），`PR_OPERATION_RESULTS = success | failure | error`
- `INTENT_LIFECYCLE_PHASES = created | dev_started | done | failed | cancelled`

> 目前 `consensus`、`tool` 两种 SessionKind 仍以「类型化标注 + 日志 tag」存在，**尚未经过总线**（执行形态均为 `runKind: internal`）。

## 3.5 事件类型目录与命名规范（2026-07-14）

事件类型统一为 `<category>:<action>`（大类:动作）结构，由代码事实源 `EVENT_CATALOG` 常量
（`shared/src/protocol.ts`）维护已知目录。该目录是**建议清单，非封闭枚举**——未收录的
自定义 `<custom>:<thing>` 类型发布/订阅皆可以，不受目录约束。

**语义分工**：`type` = 已发生的事实（动作），`status` = 该事实的结果/状态（可多值订阅），
`metadata` = 其余扁平上下文（sessionKind / runKind 等已同构化纳入）。

### 已知事件类型

| 大类 `category` | 动作 `action`                                       | 完整 type             | status 建议集                | metadata 建议键                           | 发布者                            |
| --------------- | --------------------------------------------------- | --------------------- | ---------------------------- | ----------------------------------------- | --------------------------------- |
| `run`           | `started`                                           | `run:started`         | —                            | `sessionKind`, `runKind`                  | run 生命周期桥                    |
| `run`           | `settled`                                           | `run:settled`         | `complete`/`error`/`aborted` | 同上                                      | 同上                              |
| `pr`            | `create`                                            | `pr:create`           | `success`/`failure`/`error`  | `operation`(冗余), `provider`, `repo`…    | 模型 `publish_event` + c3 自建 PR |
| `pr`            | `review`/`merge`/`close`/`comment`/`update`         | `pr:*`                | 同上                         | 同上                                      | 模型 `publish_event`              |
| `intent`        | `created`/`dev_started`/`done`/`failed`/`cancelled` | `intent:*`            | —                            | `intentId`, `title`, `module`, `toStatus` | intent 生命周期桥                 |
| `intent`        | `spec_approve`                                      | `intent:spec_approve` | —                            | `intentId`, `title`                       | 服务端 `approveSpecHandler`       |

`pr:operation` 是 v12 及之前的旧类型名，v13 已拆为 `pr:<op>` 按操作命名。归一化器保留
`pr:operation` 作为过渡别名——收到该 type 的旧格式时自动改写为新 type 输出。

### 大类通配 `:*`

一条自动化订阅的类型可使用 `<category>:*`（如 `pr:*`、`intent:*`）匹配该大类**所有动作**。
仅大类级通配，不支持 `*:action` 或正则。

### 不变的部分

- `run:started` / `run:settled` 保留原名（时态不统一系历史，已说明），status 仍承载 reason。
- 开放字符串契约不变——`EVENT_CATALOG` 之外的自定义类型发布/订阅都不需改协议。
- 表单使用 `EVENT_CATALOG` 做级联的已知建议，每层保留「其他」自由输入入口。

## 4. 发布者地图（谁在 `publish`）

| 来源                 | 文件                                                                      | 发布的 topic                                               |
| -------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------- |
| run 启动/收尾        | `server/src/kernel/run/run-lifecycle.ts`、`run-via-driver.ts`             | `run:bound`/`run:started`/`run:settled` + 降级链 `agent:*` |
| discussion run       | `server/src/wiring/discussion-runs.ts`                                    | `run:*`（kind=`discussion`）                               |
| scheduler 自身执行   | `server/src/features/automations/scheduler.ts`（`dispatchAndTrack`）      | `run:*`（kind=`automation`）                               |
| intent 状态/生命周期 | `server/src/features/intents/lifecycle-events.ts`                         | `intent:status_changed`、`intent:lifecycle`                |
| **模型可发布事件**   | `server/src/features/events/`（工具）+ `pr-events/`（PR 归一化，详见 §6） | `event`（当前 `type='pr:create'`…`pr:update`）             |
| **c3 服务端自建 PR** | `dev-cleanup.ts`、`automation.ts`、`intents/index.ts`（create_pr）        | `event`（`type='pr:create'`，仅 `create`/`success`）       |

## 5. 订阅者地图（常驻订阅，应用生命周期）

ADR-0018 的核心修正：run 生命周期订阅从「per-launch 订阅/释放」改为**在组合根注册一次、永不释放的常驻订阅**（消除了「一个 run 收尾时误删其他 pending run 订阅」的并发 bug）。匹配靠**事件里的 session id / workspace 去查 domain 状态**，不匹配则 no-op（幂等）。

注册点：`server/src/wiring/run-domain-subscriptions.ts`（domain 侧常驻订阅）与 `server/src/wiring/scheduler-startup.ts`（Automation 事件桥）。

| 订阅                                    | topic + 过滤                                                                 | 动作                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| run-bound（intent/session domain）      | `run:bound`                                                                  | pending→real 绑定；intent kind 重绑聊天会话；否则持久化 mode + 消费 pending dev-link + 广播 session-started                                                                                                                                                                                                                                                                    |
| run-settled（intents-automation）       | `run:settled`，kind=`session`                                                | 刷新 session 列表；匹配 intent 的 dev-session → 刷新 intent 列表 + 通知 automation 控制器 turn 结束                                                                                                                                                                                                                                                                            |
| run-settled（discussion）               | `run:settled`，kind=`discussion`                                             | 刷新 discussion 列表                                                                                                                                                                                                                                                                                                                                                           |
| run-settled（automation）               | `run:settled`，kind=`automation`                                             | 刷新 automation 列表                                                                                                                                                                                                                                                                                                                                                           |
| **Automation 事件触发分发**             | `run:started`/`run:settled`/`event`/`intent:lifecycle`                       | 见 §6/§7：各订阅桥把总线事件归一化为 `view={workspacePath, event, sessionKind?}`（envelope 直接透传，不再按 `event.type` 投影出 operation/result），统一交给 `dispatchEventTriggers(view)`；通用匹配器 `genericEventFiltersMatch` 按多行 OR + 每行 workspace→type→status→metadata 匹配（type 支持 `:*` 通配），`getEventAutomations(type)` 按 `eventTypeMatches` 筛选          |
| **intent PR 状态复位（intent domain）** | `event`（判别 `type='pr:operation'`，`operation=update` + `result=success`） | 判别 PR type 后从 `metadata.operation`/`status`/`data.association.intentId` 投影;携 `intentId` 且意图 `prStatus∈{rejected,failed,closed}` 时复位为 `reviewing` + 写 `pr_updated` 日志 + 广播;非 PR type/缺 intentId/意图不存在/跨 workspace/`merged` 等静默忽略。与 Automation 分发是同一总线事件的两个独立副作用,注册于 `run-domain-subscriptions.ts`,不依赖 Automation store |

**automation 编排**已从「内部 await 循环」改为「事件驱动 FSM」：turn-settled 通知触发 judge→commit→next/continue/fail 链；并发门、续跑上限(10)、lint-heal 重试均保留，只是驱动机制换成事件。

## 6. 模型对外发布表面：`publish_event`（单一通用工具）

这是「事件机制」唯一对模型开放的入口，也是唯一的模型发布工具。设计原则：**单一通用工具（入参即 `GenericEvent`）、开放类型集合（已知 type 走专用归一化器,自定义 type 走默认归一化器兜底）、按 type 字段级安全归一化、per-run 信封不可伪造**。工具面对新增可发布事件零改动——扩展点在归一化器注册表（§9.3），不再是「每类事件一个窄工具」。

### 6.1 工具语义

`event` topic 有两个发布者：模型经 `publish_event` 工具发布，以及 c3 自建 PR 的服务端路径（dev-cleanup / automation / 手动 create_pr）在成功建 PR 后构造 `create` 事件。PR 事件按 `pr:<operation>` 命名（每个操作一种 type），同时保留旧 `pr:operation` 作为过渡别名。模型先用自己的工具（`gh` CLI / GitHub MCP 等）完成 PR 的创建/评审/合并/关闭/评论，或修改重提（`update`：已有 PR 被打回后 push 修复、重新提交/重新打开，**非新建 PR**），**操作完成或失败后**再调用 `publish_event`（`type='pr:<operation>'`）发布一条供应商中立的通用事件，供订阅了对应 `pr:<op>` 或 `pr:*` 的 Automation 匹配并触发后续动作。`update`/`success` 事件还会被 intent domain 消费，把 rejected/failed/closed 的意图 `prStatus` 复位为 `reviewing`（见 §5 订阅者地图）。服务端路径绕过模型直接创建 PR，因此也需要将结果通知总线。

### 6.2 入参 Schema（Zod，单一来源 `features/events/tool-defs.ts`）

入参直接对应 `GenericEvent`：`type`（必填非空，开放的 `<category>:<action>` 字符串，可自定义，如 `custom:create`；已知 type 走专用归一化器，其余走默认归一化器）；`status` / `description` / `metadata`（扁平 `string→string`）/ `data`（JSON 兼容对象）可选。工具描述在 system prompt 中说明各 type 的字段约定——PR 事件 type 填 `pr:<operation>`（create/review/merge/close/comment/update 之一）、`status` 填 result（`success`/`failure`/`error`）、`metadata.operation` 填 operation、`description` 填 errorSummary、`data` 承载 `{ pr, repo, ref, association }`（`association` 含 `intentId` + `intentTitle`，经安全归一后发布，让事件自解释）。

### 6.3 字段级安全归一化（核心安全资产，`pr:operation` 归一化器）

`server/src/features/pr-events/tool-defs.ts` 的 PR 归一化器在发布前对每个字段分别归一化：

1. **secret 脱敏**：`ghp_*` / `github_pat_*` / `glpat-*` / `sk-*` / `key=value` / `bearer <token>` / JWT / 40+ 位 hex blob → `[redacted]`；
2. **绝对路径剥离**：`/Users/`、`/home/`、`/root/`、`/var/folders/`、`C:\...` → `[redacted]`；
3. **结构字段** `normalizeField`：脱敏 + `trim` + 截断到 256；
4. **`errorSummary`**（承载于 `description`）`normalizeErrorSummary`：脱敏 + 剥路径 + **折叠空白**（化解直接粘贴的原始 stdout）+ 截断到 500；在 `result=failure` 或 `result=error` 时有意义，`success` 也可携带但通常无用；
5. 空对象在归一化后被丢弃，保持 payload 紧凑。

**默认归一化器**（`server/src/features/events/default-normalizer.ts`，兜底自定义 type）复用同一套 secret 脱敏 + 绝对路径剥离规则，但**不绑定固定字段形状**：保留输入的 `type` 与所有出现的可选字段，递归清洗 `status` / `description` / `metadata` 值 / `data` 内每个 string 叶子（脱敏 + 剥路径 + 截断到 1000），非 string 叶子原样透传，`type` 不改写。这样 `custom:*` 等未预注册事件也能安全发布。

### 6.4 per-run 绑定闭包（信封不可伪造）

`workspacePath` 与 `sessionId` **不由模型提供**，而是经 per-run binding 闭包在归一化成功后隐式注入到信封外层：

```
publish_event(core) ─► handler: normalizeEvent(core)   // 查表(命中专用/否则默认归一化)→§6.3 归一化→再校验；非法则不发布
                              → publish({ workspacePath, sessionId: getRunId(), event })
```

- `workspacePath` 锁在闭包里——模型无法把事件重定向到别的 workspace；
- `getRunId()` 动态读 live session id——正确处理 pending→real 重绑后用真实 id 打标；
- 信封 `GenericEventEnvelope = { workspacePath, sessionId, event }` 由闭包补齐；`event` 内部的 `metadata`/`data` 同名键**在信封外层之外**，天然无法覆盖 `workspacePath`/`sessionId`，且归一化器的字段读取器也只读已知字段、忽略伪造的 `data.workspacePath` 等。

### 6.5 双 MCP 表面，共享一套 framing-free 核

两条接入路径共享同一份通用工具核 `features/events/tool-defs.ts`（schema、描述、`runPublishEvent` 核心 handler、结果形状），各自只负责工具注册与 framing + per-run 绑定：

| 表面                          | 文件                                         | 路径                                         |
| ----------------------------- | -------------------------------------------- | -------------------------------------------- |
| 进程内 MCP（Claude）          | `server/src/features/events/publish-tool.ts` | `createPublishEventMcpServer(binding, deps)` |
| 本机 HTTP MCP（Codex/Driver） | `server/src/transport/event-mcp/index.ts`    | token mint + loopback guard，纵深防御        |

第三条表面是 Automation 无人执行的 c3 MCP 工具集（`features/automations/c3-tools.ts`）里的 `publish_event`，同样复用通用工具核。组合根 `server/src/server.ts` 构建 `publishEvent` sink（`eventBus.publish('event', envelope)`）并注入三条表面。

### 6.6 归一化经通用链路：`pr:operation` 是首个注册 type（[ADR-0026](adr/0026-generic-event-normalizer-registry.md)）

§6.3 的字段级归一化是 kernel 归一化器注册表（§9.3）里 6 个 `pr:<op>` type 的**共享注册项**——**模型发布**与**三条服务端建 PR 路径**共用这**唯一一份**归一化实现。链路：

```
模型入参 GenericEvent 核心(type='pr:operation', status=result,
  │        metadata.operation=operation, description=errorSummary, data={pr,repo,ref,association})
  ▼  normalizeEvent = registry.normalize(core)   // 查表(专用/默认归一化)→§6.3 脱敏/剥路径/折叠/截断→再校验；非法则 { ok:false } 不发布
per-run 闭包补信封 { workspacePath, sessionId:getRunId(), event: 归一化后的 GenericEvent }
  ▼
eventBus.publish('event', GenericEventEnvelope)   // 单一 envelope，不再还原 typed PrOperationEvent
```

- **信封不可伪造**：`workspacePath`/`sessionId` 由 per-run 闭包注入到信封外层；模型即便在 `data` 里塞同名键，也被归一化器忽略、且不在信封层。
- **消费侧投影**：Automation 事件触发与意图 PR 状态复位消费者订阅 `'event'`，先判别 `event.type==='pr:operation'`，再用 `projectPrOperationEvent(event)`（`features/pr-events/tool-defs.ts` 的确定性投影，不再次清洗）从归一化事件里读出 operation/result/pr/association。发布侧**不再有兼容桥**，同一次业务发布只交付一个 envelope。
- **无旁路**：缺 PR 注册即发布失败，不回退到旧 `normalizePrEvent` 独立调用。`normalizePrGenericEvent` / `prArgsToGenericEvent` / `projectPrOperationEvent` 均在 `features/pr-events/tool-defs.ts`。

组合根用 6 次 `registry.register('pr:<operation>', normalizePrGenericEvent)` + 别名 `registry.register('pr:operation', normalizer)` 装配注册表，并把 `normalizeEvent` 注入到三条 MCP 表面、三条服务端建 PR 路径（dev-cleanup / automation / 手动 create_pr，后者经 `KernelContext.normalizeEvent`）。

## 7. Automation 事件触发：多行通用过滤器（eventFilters[]）

Automation 既能 cron 定时，也能**订阅事件被动触发**。触发条件收敛为一个面向通用事件的过滤契约 `GenericEventFilter`（`shared/src/protocol.ts`），不再由 topic 决定读取 reason/PR/intent 专属字段：

```ts
GenericEventFilter = {
  type: string                       // 订阅的事件类型（原 eventTopic 的值，开放字符串）
  statuses?: string[]                // event.status 多选；缺省/空 = 任意 status
  metadata?: EventMetadataFilter     // metadata 条件（AND/OR），复用既有结构；缺省 = 不过滤
}
```

`Automation` / `CreateAutomationInput` / `UpdateAutomationInput` 以 `eventFilters: GenericEventFilter[] | null` 取代 v12 的单一 `eventFilter`（它本身收敛自 `eventTopic` 等老字段）。每行的 type 为 `<category>:<action>` 或 `<category>:*` 通配，行间 OR 匹配。`eventSessionKindFilter` **保持独立字段**——它是 run 生命周期的强制安全边界，非业务过滤器（现通过 `hasRunLifecycleEventFilter` 自动判定）。

**纯匹配器** `genericEventFilterMatches(automationWorkspacePath, filter, view)`（`shared/src/protocol.ts`）只读取可信最小视图 `{ workspacePath, event: GenericEvent }`（`GenericEventEnvelope` 可直接满足），按固定顺序判断并给出 breakdown（维度名 `workspace`/`type`/`status`/`metadata`）：

1. **workspace**：`automation.workspaceId == event.workspacePath`；
2. **type**：`eventTypeMatches(filter.type, event.type)`——精确相等或 filter 的 `<category>:*` 通配；
3. **status**：`statuses` 缺省/空 = 任意；非空时事件必须携带**完全相等、区分大小写**的 status（事件无 status 则不命中）；
4. **metadata**：缺省 = 不过滤；否则键值精确、区分大小写，`AND` 全真 / `OR` 任一真。

**分发核心** `dispatchEventTriggers(view)`（`features/triggers/index.ts`，`view = { workspacePath, event, sessionKind? }`）：

1. **workspace 总闸**（`WorkspaceSetting.automationEnabled`）：关闭则整批丢弃、不排队；
2. `getEventAutomations(event.type)` 取该 type 的 active event 候选；
3. 对每个候选：**SessionKind 过滤**（仅当 `eventFilter.type` ∈ {run:started, run:settled} 且 `eventSessionKindFilter` **非空**时，在通用匹配前作为白名单：`event.sessionKind` 必须 ∈ 该集合，无会话来源事件不命中；空/缺失则跳过该维度）→ 通用匹配（`evaluateAutomationTriggerMatch`，breakdown 仅在应用了非空过滤器时含 `sessionKind` 列，其后 workspace/type/status/metadata）；单条候选评估抛错时 fail closed 并记录 automation id，不影响同事件其他候选；
4. **串行门**：该 automation 已有 in-flight 执行则跳过（防 event storm 堆叠）；
5. 命中 → `dispatchAndTrack(automation)` → 执行并发 `run:*`（sessionKind=`automation`、runKind=`headless`）回总线。

**消费侧兼容映射**（订阅桥 `wiring/scheduler-startup.ts` 把各来源 payload 投影为通用视图，不改发布侧）：

| 来源               | 投影为 `GenericEvent`                                                                               | sessionKind    |
| ------------------ | --------------------------------------------------------------------------------------------------- | -------------- |
| `run:started`      | `{ type:'run:started', metadata:{sessionKind,runKind} }`（无 status）                               | 有（安全边界） |
| `run:settled`      | `{ type:'run:settled', status:reason, metadata:{sessionKind,runKind} }`                             | 有（安全边界） |
| `pr:*`             | 归一化 envelope 直接透传：`type='pr:<op>'`、`status=result`、`metadata.operation=operation`（冗余） | 无             |
| `intent:lifecycle` | `{ type:'intent:<phase>', metadata:{intentId,title,module?,toStatus} }`                             | 无             |

其中 `'event'` 总线上的模型可发布事件（PR 及未来新 type）**无需按 type 投影**——归一化后的 envelope 的 `workspacePath` + `event` 本身即可信视图，直接交给 `dispatchEventTriggers`。旧的 PR 多选 operation 迁移为一组 `OR` 的 `metadata.conditions=[{key:'operation', value}]`。

## 8. 全链路时序（以 `pr:operation` 为例）

```
模型(完成 PR 操作后) ─调用─► publish_event({ type:'pr:<op>', status:result,
  │                                            metadata:{operation}, data:{pr,...} })
  ▼  normalizeEvent = registry.normalize(core)  // 查表→脱敏/剥路径/折叠空白/截断；失败则不发布
handler ─ per-run 闭包补信封 { workspacePath, sessionId:getRunId(), event }
  │
  ▼
eventBus.publish('event', GenericEventEnvelope)
  │  同步遍历订阅者，错误隔离；两个 PR 消费者各自判别 event.type==='pr:operation' 后投影
  ▼
Automation 事件桥(scheduler-startup) ─► dispatchEventTriggers({ workspacePath, event })  // envelope 直接透传，无需按 type 投影
  │  workspace → type==='pr:operation' → status(result) → metadata(operation) → 串行门
  ▼
dispatchAndTrack(automation) ─► 发 run:started(kind=automation) → 执行任务 → 发 run:settled(kind=automation)
  │
  ▼
常驻订阅 run:settled(kind=automation) ─► broadcastAutomations(workspace)  // 刷新前端列表
```

## 9. 扩展指南

### 9.1 加一个新的内部事件类型（最常见，最便宜）

「一行 topic + 一处 publish + 按需订阅」，已有订阅者零改动：

1. 在 `EventBusEvents`（`event-bus.ts`）加一行 `'<group>:<verb>': { ...payload }`；payload 里的领域类型放 `shared/src/protocol.ts`；
2. 在生产侧某处 `eventBus.publish('<group>:<verb>', payload)`；
3. 需要反应的消费者在组合根 `subscribe`（常驻订阅，匹配靠事件内 id 查 domain 状态、不匹配 no-op）。

### 9.2 让 Automation 能订阅这个新事件类型

通用过滤器收敛后，**新增事件类型无需改 Automation 协议、分发分支或专属表单**：

- 若新类型走 `'event'` 总线（模型可发布事件，§9.3）：**零改动**——归一化后的 envelope 被 `wiring/scheduler-startup.ts` 的 `'event'` 订阅直接投影为通用视图交给 `dispatchEventTriggers`。用户在 `AutomationForm` 事件类型输入框填入该 `type` 字符串、按需配 `statuses` / `metadata` 条件即可订阅；
- 若新类型是内部总线 topic（§9.1，带专属 payload）：只需在 `scheduler-startup.ts` 加一行 `subscribe`，把该 payload 投影为 `{ workspacePath, event: { type, status?, metadata? }, sessionKind? }` 后调 `dispatchEventTriggers`（参照 run/intent 桥）。

不再需要：并入封闭联合、新增 `eventXxxFilter` 字段、加 `xxxFilterMatches` 分支、按 type 加表单面板。类型/状态是开放字符串，扩展成本转移到发布侧归一化器注册（§9.3）与 UI 提示。

### 9.3 加一个新的「模型可发布事件」——通用契约 + 按 type 注册归一化器（[ADR-0026](adr/0026-generic-event-normalizer-registry.md)）

模型可发布事件的安全原则是「**type 判别 + 归一化器注册（+ 默认归一化器兜底）**」，而**不是**「每种事件复制一个窄工具 + 一套字段级归一化」。单一 `publish_event` 工具入参就是 `GenericEvent`，且它**不是** `payload: unknown` 的任意透传：已知 `type` 走其专用归一化器，其余自定义 `type` 走**默认归一化器**（结构化脱敏/截断，不绑定固定字段形状），二者都保证发布前字段级安全。这是对旧结论「每种事件新增 `publish_<x>_event` 窄工具」的**有意修订**（[ADR-0026](adr/0026-generic-event-normalizer-registry.md)）：用中间路线同时拿到**通用性**（一个工具 + 一条发布链路 + 开放 type）与**字段级安全**（逐 type 归一化器 + 默认兜底归一化）。

**通用事件契约**（`shared/src/protocol.ts`）：`GenericEvent = { type, status?, description?, metadata?, data? }`——`type` 是必填非空的稳定判别值，`metadata` 是扁平 `Record<string,string>`，`data` 是 JSON 兼容的递归对象；`validateGenericEvent` 拒绝空 type、嵌套 metadata、非 JSON `data`。`GenericEventEnvelope = { workspacePath, sessionId, event }` 的信封字段由 per-run 绑定闭包在归一化成功后注入，原始事件里的同名键不得覆盖。

**归一化器注册表**（`server/src/kernel/events/generic-event.ts`，kernel 边界，不 import features/transport）：维护 `type → normalizer`，并接受一个可选的**默认归一化器**（构造参数）。归一化器接收未经信任的通用事件核心，校验该 type 语义、逐字段脱敏/截断、返回可发布的 `GenericEvent`（`type` 不可改写）。**已知 type 走其专用归一化器，其余 type 落到默认归一化器**（`server/src/features/events/default-normalizer.ts`：保留输入形状，递归清洗每个 string 叶子——脱敏/剥绝对路径/截断——`type` 不变）——因此自定义 `custom:*` 事件能安全发布，通用性不会退化为「任意对象透传」，字段级安全被保住。**仅当未配置默认归一化器时，未注册 type 才被拒绝**。核心非法、归一化器抛错、或结果非法均同步返回 `{ ok: false }` 且**不调用 `EventBus.publish`**（发布前失败不属于订阅者错误隔离范围）；错误文本不回显原始敏感值。重复注册是启动期配置错误。

**加一种模型可发布事件**：

- **自定义/临时 type**（如 `custom:create`）：**零改动**——模型直接用 `publish_event` 带上该 `type` 即可，默认归一化器兜底做安全清洗后发布；
- **需要专属字段级语义/校验的 type**：(1) 在 feature 侧写一个归一化器（该 type 的字段级脱敏/截断规则，纯函数）；(2) 在**组合根**用 `registry.register('<type>', normalizer)` 注册。

无论哪种，**工具面零改动**：成功归一化后由 per-run 闭包补 `GenericEventEnvelope` 落到单一 `'event'` topic。需要反应的消费者订阅 `'event'`、判别 `event.type` 后投影自己关心的字段（PR 见 §6.6）。

`pr:<operation>` 6 个 type 是首批注册（见 §6.6），同时保留 `pr:operation` 过渡别名。旧的「每种事件新增窄工具」判据（payload 几乎一致才用判别联合）已不再适用——注册表 + 单一通用工具让多类型与字段级安全兼得。旧的「每种事件新增窄工具」判据（payload 几乎一致才用判别联合）已不再适用——注册表 + 单一通用工具让多类型与字段级安全兼得。

> 仍需区分两个「event」层级：**总线内部 topic**（§9.1）天然多类型、可自由扩；**模型可发布事件**（本节）经归一化器注册表这道安全门（已知 type 专用归一化 + 自定义 type 默认兜底归一化）。二者现在都支持多类型扩展，区别在后者多一层 per-type / 默认归一化。

## 10. 已知约束与优化方向

- **同步分发**：订阅者重活会拖慢发布栈；当订阅者数量/耗时增长，可考虑给特定 topic 引入显式异步队列（需自带顺序/背压保证，而非裸 microtask——ADR-0018 已否决裸 microtask）。
- **全局广播 + id 自查**：run 生命周期 topic 是全局广播，订阅者靠 id 自查 domain 状态。订阅者多了之后，热点 topic 的「每事件遍历全部订阅者」是潜在成本点。
- **`consensus`/`tool` 未上总线**：如需对内部一次性调用做审计/触发，再按 §9.1 eventize。
- **Automation 串行门**（每 automation 至多 1 个 in-flight）是防 event storm 的有意取舍；高频事件下被跳过的触发**不补偿**，需要时应在过滤器层收窄而非放开串行门。

## 11. 关键文件索引

| 关注点                                  | 文件                                                                                                                                                                |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 总线核 + topic map                      | `server/src/kernel/events/event-bus.ts`（`event-bus.test.ts`）                                                                                                      |
| 通用事件契约 + 校验                     | `shared/src/protocol.ts`（`GenericEvent`/`GenericEventEnvelope`/`validateGenericEvent`）                                                                            |
| 归一化器注册表(通用发布层)              | `server/src/kernel/events/generic-event.ts`（`generic-event.test.ts`）                                                                                              |
| 总线挂上下文                            | `server/src/kernel/types.ts`（`KernelContext.eventBus`）                                                                                                            |
| run/agent 事件发布                      | `server/src/kernel/run/run-lifecycle.ts`、`run-via-driver.ts`、`agent-events.ts`                                                                                    |
| intent 事件发布                         | `server/src/features/intents/lifecycle-events.ts`                                                                                                                   |
| `publish_event` 通用工具核              | `server/src/features/events/tool-defs.ts`（schema/描述/`runPublishEvent`）                                                                                          |
| PR 归一化器(6 type + 别名) + 消费侧投影 | `server/src/features/pr-events/tool-defs.ts`（`normalizePrGenericEvent`/`projectPrOperationEvent`/`runServerSidePrCreate`/`PR_EVENT_TYPES`/`PR_LEGACY_EVENT_TYPE`） |
| `publish_event` 进程内 MCP（Claude）    | `server/src/features/events/publish-tool.ts`                                                                                                                        |
| `publish_event` HTTP MCP（Codex）       | `server/src/transport/event-mcp/index.ts`                                                                                                                           |
| 常驻 domain 订阅（含 PR 复位）          | `server/src/wiring/run-domain-subscriptions.ts`、`features/intents/pr-update-consumer.ts`                                                                           |
| Automation 事件桥 + 分发/过滤           | `server/src/wiring/scheduler-startup.ts`、`server/src/features/automations/scheduler.ts`                                                                            |
| 组合根（构建总线 + 注入 sink）          | `server/src/server.ts`                                                                                                                                              |
| 协议类型唯一定义源                      | `shared/src/protocol.ts`（topic/枚举/payload/filter/`Automation`/`EVENT_CATALOG`/`eventTypeMatches`）                                                               |

## 12. 关联文档

- [ADR-0018 — In-Process Event Bus in the Kernel Layer](adr/0018-event-bus-kernel-layer.md)：总线选型决策、SessionKind / RunKind 分类、per-launch→常驻订阅的重构。
- [ADR-0026 — 通用事件契约 + 按 type 注册的归一化器](adr/0026-generic-event-normalizer-registry.md)：
- [ADR-0027 — `<category>:<action>` 事件命名 + 多行订阅 + 级联表单](adr/0027-event-naming-and-multi-row-subscription.md)：统一事件命名规范为 `<category>:<action>`（大类:动作），引入多行订阅 `eventFilters[]`、大类通配 `:*`、以及级联表单 UI。模型可发布事件从「每种事件新增窄工具」修订为「type 判别 + 归一化器注册（自定义 type 默认归一化兜底）」，及保留类型化 topic 适配层的边界。
- [ADR-0009 — Unidirectional boundaries](adr/0009-unidirectional-boundaries.md)：总线为何必须在 kernel 层、不得 import features/transport。
- [架构总览](architecture.md)：系统形态与模块表（事件总线在模块表中有一行）。
- [automation 执行流](../flows/flow-automation-execution.md)：cron/event 触发到执行落日志的端到端路径。
