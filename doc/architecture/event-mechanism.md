# 事件机制（Event Mechanism）

> 本文是**活文档（current state）**：描述 c3 事件机制现在整体长什么样、各部件如何协作、以及如何扩展与优化。
> 设计**决策的出处与权衡**见 [ADR-0018](adr/0018-event-bus-kernel-layer.md)（为什么选 topic-based 同步总线）；本文在其之上补齐后续新增的
> `pr:operation`、`intent:lifecycle` 两类 topic、面向模型的 `publish_pr_event` 发布表面，以及 Schedule 的事件触发过滤器。
> 二者的分工：ADR 回答「为什么这么选」，本文回答「现在整体怎么运转、怎么往上加」。

## 0. 一句话心智模型

c3 内部所有「跨特性的事情发生了」都走**同一条进程内总线** `EventBus`：

- **生产者**把发生的事 `publish('<topic>', payload)` 到总线，**不关心谁在听**；
- **消费者**在启动时 `subscribe('<topic>', handler)`，**只听自己关心的 topic**；
- 总线**同步、按注册序、错误隔离**地分发，发布者从不等待消费者。

模型（Claude/Codex）**不能直接碰总线**。它只能调用一个收敛的 MCP 工具 `publish_pr_event`，由服务端 handler 校验+脱敏+补信封后，**代它**发到 `pr:operation` topic。这是「事件机制」唯一对模型开放的入口。

```
                         ┌──────────────── EventBus（kernel 层，同步/错误隔离/类型化 topic→payload） ───────────────┐
  内部生产者 ─publish──►  │  run:bound  run:started  run:settled                                                   │
  （run launcher /        │  agent:error  agent:fallback  agent:all_failed                                          │ ──► 内部消费者（常驻订阅）
    intents / scheduler）  │  intent:status_changed  intent:lifecycle                                                │      · 各 domain 列表广播
                          │  pr:operation                                                                          │      · automation 编排 FSM
  模型 ─MCP工具─► handler ─┘                                                                                         │      · Schedule 事件触发分发
   publish_pr_event   （校验+脱敏+补 workspace/session 信封）                                                        └──────────────────────────────┘
```

## 1. 三层结构（扩展点都在前两层）

| 层                             | 是否已支持多事件                              | 说明                                    |
| ------------------------------ | --------------------------------------------- | --------------------------------------- |
| **总线核 `EventBus`**          | ✅ 类型化 topic map，任意扩 topic             | `server/src/kernel/events/event-bus.ts` |
| **订阅侧（含 Schedule 订阅）** | ✅ 多 topic + 每 topic 独立类型化过滤器       | 常驻订阅 + `ScheduleEventTopic`         |
| **模型对外发布工具**           | ❌ 当前仅 `publish_pr_event` 一种（有意收敛） | `server/src/features/pr-events/`        |

**关键认知**：你要的「扩展性」绝大部分已在**总线核 + 订阅侧**就位——加新事件类型是「一行 topic + 一处 publish」，已有订阅者零改动（ADR-0018 已验证：降级链三个 agent topic 就是这么加进来的）。真正「单一用途」的只有最后一层——模型对外发布工具，而它的收敛是**有意取舍**（见 [§7 扩展指南](#7-扩展指南)）。

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

| Topic                   | Payload（要点）                                                                          | 发布者                                        | 主要消费者                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------- |
| `run:bound`             | `prevId, realId, workspacePath`                                                          | run launcher / discussion starter / scheduler | 常驻 run-bound 订阅（pending→real 绑定、intent 重绑、session-started 广播） |
| `run:started`           | `sessionId, workspacePath, sessionKind: SessionKind, runKind: RunKind`                   | 同上                                          | Schedule 事件触发分发                                                       |
| `run:settled`           | `sessionId, workspacePath, reason: RunEndReason, sessionKind, runKind`                   | 同上                                          | 各 domain 列表广播 + automation 编排 FSM + Schedule 触发                    |
| `agent:error`           | `sessionId, workspacePath, agentId, agentName, error, degradable`                        | run launcher（降级链）                        | 审计 / 可挂动作（bypass，不改降级控制流）                                   |
| `agent:fallback`        | `from*/to* agentId+Name`                                                                 | 同上                                          | 同上                                                                        |
| `agent:all_failed`      | `agents[], crossVendorSkipped?`                                                          | 同上                                          | 同上                                                                        |
| `intent:status_changed` | `intentId, workspacePath, fromStatus, toStatus`                                          | `update_intent_status` handler                | automation 编排 / 审计                                                      |
| `intent:lifecycle`      | `{ workspacePath } & IntentLifecycleEvent`（`phase, intentId, title, module, toStatus`） | intents 生命周期                              | Schedule 事件触发分发（按 `phase` 过滤）                                    |
| `pr:operation`          | `{ workspacePath, sessionId } & PrOperationEvent`                                        | **模型经 `publish_pr_event` 工具**            | Schedule 事件触发分发（按 `operation`+`result` 过滤）                       |

枚举常量（`shared/src/protocol.ts`，均为 `as const` 数组派生联合）：

- `SessionKind = work | intent | discussion | schedule | consensus | tool | spec`
  ——run 的**业务场景**分类（业务来源判断走它）。**注意 `schedule` 是「触发源」不是「run 类型」**：被 schedule 触发的目标用户 run 仍是 `work` kind，`schedule` 只标记 scheduler 自己那个无 socket 的 run。事件触发的 Schedule 因此只在 `sessionKind === 'work'` 上 fire。原 `RunKind` 的 7 个业务值于 2026-06-26 整体迁入此处（`'session' → 'work'`）。
- `RunKind = interactive | background | headless | internal`
  ——run 的**执行形态**分类（执行机制判断走它），与 `SessionKind` 正交。同一 `sessionKind` 的两个 run 执行形态可不同——例如 `work` 用户控制台是 `interactive`，而 `work` 的 automation dev-turn 是 `background`。目前仅作记录/审计字段，暂无消费分支。
- `RunEndReason = complete | error | aborted`
- `PR_OPERATIONS = create | review | merge | close | comment`，`PR_OPERATION_RESULTS = success | failure`
- `INTENT_LIFECYCLE_PHASES = created | dev_started | done | failed | cancelled`

> 目前 `consensus`、`tool` 两种 SessionKind 仍以「类型化标注 + 日志 tag」存在，**尚未经过总线**（执行形态均为 `runKind: internal`）。

## 4. 发布者地图（谁在 `publish`）

| 来源                 | 文件                                                               | 发布的 topic                                               |
| -------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------- |
| run 启动/收尾        | `server/src/kernel/run/run-lifecycle.ts`、`run-via-driver.ts`      | `run:bound`/`run:started`/`run:settled` + 降级链 `agent:*` |
| discussion run       | `server/src/wiring/discussion-runs.ts`                             | `run:*`（kind=`discussion`）                               |
| scheduler 自身执行   | `server/src/features/schedules/scheduler.ts`（`dispatchAndTrack`） | `run:*`（kind=`schedule`）                                 |
| intent 状态/生命周期 | `server/src/features/intents/lifecycle-events.ts`                  | `intent:status_changed`、`intent:lifecycle`                |
| **模型 PR 操作**     | `server/src/features/pr-events/`（详见 §6）                        | `pr:operation`                                             |

## 5. 订阅者地图（常驻订阅，应用生命周期）

ADR-0018 的核心修正：run 生命周期订阅从「per-launch 订阅/释放」改为**在组合根注册一次、永不释放的常驻订阅**（消除了「一个 run 收尾时误删其他 pending run 订阅」的并发 bug）。匹配靠**事件里的 session id / workspace 去查 domain 状态**，不匹配则 no-op（幂等）。

注册点：`server/src/wiring/run-domain-subscriptions.ts`（domain 侧常驻订阅）与 `server/src/wiring/scheduler-startup.ts`（Schedule 事件桥）。

| 订阅                               | topic + 过滤                                                  | 动作                                                                                                        |
| ---------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| run-bound（intent/session domain） | `run:bound`                                                   | pending→real 绑定；intent kind 重绑聊天会话；否则持久化 mode + 消费 pending dev-link + 广播 session-started |
| run-settled（intents-automation）  | `run:settled`，kind=`session`                                 | 刷新 session 列表；匹配 intent 的 dev-session → 刷新 intent 列表 + 通知 automation 控制器 turn 结束         |
| run-settled（discussion）          | `run:settled`，kind=`discussion`                              | 刷新 discussion 列表                                                                                        |
| run-settled（schedule）            | `run:settled`，kind=`schedule`                                | 刷新 schedule 列表                                                                                          |
| **Schedule 事件触发分发**          | `run:started`/`run:settled`/`pr:operation`/`intent:lifecycle` | 见 §6/§7：匹配订阅该 topic 的 schedule 并触发执行                                                           |

**automation 编排**已从「内部 await 循环」改为「事件驱动 FSM」：turn-settled 通知触发 judge→commit→next/continue/fail 链；并发门、续跑上限(10)、lint-heal 重试均保留，只是驱动机制换成事件。

## 6. 模型对外发布表面：`publish_pr_event`

这是「事件机制」唯一对模型开放的入口，也是当前唯一的模型发布工具。设计原则：**窄而清晰、字段级强类型、字段级安全归一化、per-run 信封不可伪造**。

### 6.1 工具语义

c3 **从不替模型执行 PR 操作**。模型先用自己的工具（`gh` CLI / GitHub MCP 等）完成 PR 的创建/评审/合并/关闭/评论，**操作完成或失败后**再调用 `publish_pr_event` 发布一条供应商中立的「PR 操作事件」，供订阅了 `pr:operation` 的 Schedule 匹配并触发后续动作。

### 6.2 入参 Schema（Zod，单一来源 `tool-defs.ts`）

`operation`（枚举）、`result`（枚举）必填；`pr` / `repo` / `ref` / `association` / `errorSummary` 可选。形状与 `PrOperationEvent` 一一对应。

### 6.3 字段级安全归一化（核心安全资产）

`server/src/features/pr-events/tool-defs.ts` 在发布前对每个字段分别归一化：

1. **secret 脱敏**：`ghp_*` / `github_pat_*` / `glpat-*` / `sk-*` / `key=value` / `bearer <token>` / JWT / 40+ 位 hex blob → `[redacted]`；
2. **绝对路径剥离**：`/Users/`、`/home/`、`/root/`、`/var/folders/`、`C:\...` → `[redacted]`；
3. **结构字段** `normalizeField`：脱敏 + `trim` + 截断到 256；
4. **`errorSummary`** `normalizeErrorSummary`：脱敏 + 剥路径 + **折叠空白**（化解直接粘贴的原始 stdout）+ 截断到 500；
5. 空对象在归一化后被丢弃，保持 payload 紧凑。

### 6.4 per-run 绑定闭包（信封不可伪造）

`workspacePath` 与 `sessionId` **不由模型提供**，而是经 per-run binding 闭包隐式注入：

```
publish_pr_event(args) ─► handler: 枚举再校验 → normalizePrEvent(args)
                                  → publish({ workspacePath, sessionId: getRunId(), ...event })
```

- `workspacePath` 锁在闭包里——模型无法把事件重定向到别的 workspace；
- `getRunId()` 动态读 live session id——正确处理 pending→real 重绑后用真实 id 打标；
- 信封 `{ workspacePath, sessionId } & PrOperationEvent` 由闭包补齐。

### 6.5 双 MCP 表面，共享一套核

两条接入路径共享同一份 `tool-defs.ts`（envelope、association、归一化、per-run 绑定都已抽成 framing-free 的共享核）：

| 表面                          | 文件                                            | 路径                                    |
| ----------------------------- | ----------------------------------------------- | --------------------------------------- |
| 进程内 MCP（Claude）          | `server/src/features/pr-events/publish-tool.ts` | `createPrEventMcpServer(binding, deps)` |
| 本机 HTTP MCP（Codex/Driver） | `server/src/transport/pr-event-mcp/index.ts`    | token mint + loopback guard，纵深防御   |

组合根 `server/src/server.ts` 构建 `publishPrEvent` sink（`eventBus.publish('pr:operation', ...)`）并注入两条表面。

## 7. Schedule 事件触发：每 topic 独立类型化过滤器

Schedule 既能 cron 定时，也能**订阅事件 topic 被动触发**。可订阅的 topic 由 `ScheduleEventTopic = RunLifecycleTopic | 'pr:operation' | 'intent:lifecycle'` 约束，每个 topic 配一个**专属过滤器字段**（`shared/src/protocol.ts` 的 `Schedule`）：

| topic              | 过滤字段                                                       | 匹配语义                                                                       |
| ------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `run:settled`      | `eventReasonFilter: RunEndReason[]`                            | reason 命中才 fire                                                             |
| `pr:operation`     | `eventPrFilter: PrOperationFilter`（`operations?`+`results?`） | operation ∈ operations **且** result ∈ results；某维度空/缺省 = 该维度任意匹配 |
| `intent:lifecycle` | `eventIntentFilter: IntentLifecycleFilter`（`phases?`）        | phase 命中才 fire；缺省/空 = 任意 phase                                        |

分发核心 `dispatchEventSchedules(topic, payload)`（`scheduler.ts`）的匹配顺序：

1. **SessionKind 白名单**（仅 run:started/settled，业务来源判断）：只有 `work` 源触发用户 schedule；
2. **workspace 匹配**：`schedule.workspaceId == event.workspacePath`；
3. **topic 专属过滤器**（上表）；
4. **串行门**：该 schedule 已有 in-flight 执行则跳过（防 event storm 堆叠）；
5. 命中 → `dispatchAndTrack(schedule)` → 执行并发 `run:*`（sessionKind=`schedule`、runKind=`headless`）回总线。

## 8. 全链路时序（以 `pr:operation` 为例）

```
模型(完成 PR 操作后) ─调用─► publish_pr_event(operation, result, pr, ...)
  │
  ▼  Zod 校验 + 枚举再校验
handler ─ normalizePrEvent(args)  // 脱敏/剥路径/折叠空白/截断；校验失败则不发布
  │
  ▼  per-run 闭包补信封 { workspacePath, sessionId:getRunId() }
eventBus.publish('pr:operation', envelope)
  │  同步遍历订阅者，错误隔离
  ▼
Schedule 事件桥(scheduler-startup) ─► dispatchEventSchedules('pr:operation', e)
  │  workspace 匹配 → prFilterMatches(eventPrFilter, op, result) → 串行门
  ▼
dispatchAndTrack(schedule) ─► 发 run:started(kind=schedule) → 执行任务 → 发 run:settled(kind=schedule)
  │
  ▼
常驻订阅 run:settled(kind=schedule) ─► broadcastSchedules(workspace)  // 刷新前端列表
```

## 9. 扩展指南

### 9.1 加一个新的内部事件类型（最常见，最便宜）

「一行 topic + 一处 publish + 按需订阅」，已有订阅者零改动：

1. 在 `EventBusEvents`（`event-bus.ts`）加一行 `'<group>:<verb>': { ...payload }`；payload 里的领域类型放 `shared/src/protocol.ts`；
2. 在生产侧某处 `eventBus.publish('<group>:<verb>', payload)`；
3. 需要反应的消费者在组合根 `subscribe`（常驻订阅，匹配靠事件内 id 查 domain 状态、不匹配 no-op）。

### 9.2 让 Schedule 能订阅这个新 topic

1. 把 topic 并入 `ScheduleEventTopic` 联合；
2. 若需过滤，加一个**专属类型化过滤器字段** `eventXxxFilter`（不要塞进现有过滤器）；
3. 在 `dispatchEventSchedules` 加该 topic 的匹配分支 + `xxxFilterMatches`；
4. 在 `scheduler-startup.ts` 把该 topic `subscribe` 到分发函数；
5. ScheduleForm 前端补对应过滤 UI。

### 9.3 加一个新的「模型对外发布工具」——为什么不改成 `publish_event`

当出现第 2 种**模型对外发布**事件时，正确做法是**新增一个同样聚焦的工具** `publish_<x>_event` 复用 `tool-defs.ts` 的共享核（envelope/association/归一化/per-run 闭包都已 framing-free 抽离），而**不是**把 `publish_pr_event` 改名成一个带 `type` 的多态 `publish_event`。原因：

- **多态会丢字段级强类型**：`publish_event` 要么 `payload: unknown`（放弃校验），要么一个大判别联合（描述变模糊，模型调用正确率下降）。MCP 惯例是「窄而清晰 → 模型调用准」。
- **多态会削弱字段级安全归一化**：当前脱敏是分字段的（`errorSummary` 还额外折叠空白、剥路径）。通用 payload 袋子很难再做针对性归一化，而这正是该工具的核心安全资产。
- **YAGNI**：当前只有 1 种模型发布事件。为「将来可能有」的第 2、3 种提前做多态抽象，要先牺牲类型与安全，收益还不存在。

**判据**：只有当两种事件 payload 几乎一致时，判别联合才划算——目前不是。结论是「**多个聚焦工具共享内部机制**」，而非「**一个多态工具**」。

> 注意区分两个「event」层级：**总线内部 topic**（§9.1）天然就该多类型、可自由扩；**模型对外发布工具**（本节）才是有意收敛的那层。「未来会有很多 event」指的是前者，它早已具备。

## 10. 已知约束与优化方向

- **同步分发**：订阅者重活会拖慢发布栈；当订阅者数量/耗时增长，可考虑给特定 topic 引入显式异步队列（需自带顺序/背压保证，而非裸 microtask——ADR-0018 已否决裸 microtask）。
- **全局广播 + id 自查**：run 生命周期 topic 是全局广播，订阅者靠 id 自查 domain 状态。订阅者多了之后，热点 topic 的「每事件遍历全部订阅者」是潜在成本点。
- **`consensus`/`tool` 未上总线**：如需对内部一次性调用做审计/触发，再按 §9.1 eventize。
- **Schedule 串行门**（每 schedule 至多 1 个 in-flight）是防 event storm 的有意取舍；高频事件下被跳过的触发**不补偿**，需要时应在过滤器层收窄而非放开串行门。

## 11. 关键文件索引

| 关注点                         | 文件                                                                                   |
| ------------------------------ | -------------------------------------------------------------------------------------- |
| 总线核 + topic map             | `server/src/kernel/events/event-bus.ts`（`event-bus.test.ts`）                         |
| 总线挂上下文                   | `server/src/kernel/types.ts`（`KernelContext.eventBus`）                               |
| run/agent 事件发布             | `server/src/kernel/run/run-lifecycle.ts`、`run-via-driver.ts`、`agent-events.ts`       |
| intent 事件发布                | `server/src/features/intents/lifecycle-events.ts`                                      |
| PR 事件工具（单一来源）        | `server/src/features/pr-events/tool-defs.ts`                                           |
| PR 工具进程内 MCP（Claude）    | `server/src/features/pr-events/publish-tool.ts`                                        |
| PR 工具 HTTP MCP（Codex）      | `server/src/transport/pr-event-mcp/index.ts`                                           |
| 常驻 domain 订阅               | `server/src/wiring/run-domain-subscriptions.ts`                                        |
| Schedule 事件桥 + 分发/过滤    | `server/src/wiring/scheduler-startup.ts`、`server/src/features/schedules/scheduler.ts` |
| 组合根（构建总线 + 注入 sink） | `server/src/server.ts`                                                                 |
| 协议类型唯一定义源             | `shared/src/protocol.ts`（topic/枚举/payload/filter/`Schedule`）                       |

## 12. 关联文档

- [ADR-0018 — In-Process Event Bus in the Kernel Layer](adr/0018-event-bus-kernel-layer.md)：总线选型决策、SessionKind / RunKind 分类、per-launch→常驻订阅的重构。
- [ADR-0009 — Unidirectional boundaries](adr/0009-unidirectional-boundaries.md)：总线为何必须在 kernel 层、不得 import features/transport。
- [架构总览](architecture.md)：系统形态与模块表（事件总线在模块表中有一行）。
- [schedule 执行流](../flows/flow-schedule-execution.md)：cron/event 触发到执行落日志的端到端路径。
