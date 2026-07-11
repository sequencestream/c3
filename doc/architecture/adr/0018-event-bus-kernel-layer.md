# 0018 — 内核层的进程内事件总线

- **Status:** accepted
- **Date:** 2026-06-07

## Context

c3 之前没有通用的发布/订阅事件机制。特性之间的通信依赖于:

- **专用的点对点钩子**:每个事件(状态变化、会话 id、团队、可降级错误等)一个单一用途的回调,各自在组合根处接线。
- **单一广播出口**:传输/接线层中的一组具名广播闭包,每个都硬编码绑定到特定的 WebSocket 帧。
- **通过单次启动回调实现的 run 域事件**:唯一的“域事件”雏形——一个密封联合类型(bound/settled),通过 run 启动器上的单个逐次调用回调传递。这是迈向通用事件流的第一步,但本质上仍是回调,而非总线。

这意味着两个想对同一个内核事件(例如会话绑定)做出反应的特性,无法通过中立通道来实现——每个都必须在启动器的调用点注入自己的回调,导致启动器与其消费者的作用域紧密耦合。

run 生命周期事件(bound/settled)在 intents 特性、works 特性和 dev-turn 接线之间恰好有 **5** 个消费者,每个都通过同一回调传递带有连接状态的闭包。新增一个生命周期事件意味着要么扩展密封联合类型并更新每个消费者的穷尽式 switch,要么再加一个专用回调。

## Options considered

### 1. 保留点对点回调

_维持现状。_ 每个新的跨特性事件都新增一个专用钩子。组合根每加一个钩子就多一行接线代码。

_缺点:_ 组合根接线随钩子数量线性增长;除了钩子自身的签名外,生产者与消费者之间没有类型层面的契约;一个需要两个事件的消费者要注册两个钩子。

### 2. 不引入中间件,直接扩展 run 域的密封联合总线

_保留现有回调,但将其从逐次启动回调升级为内核级事件流。_ 启动器向共享总线发布,消费者订阅。

_优点:_ 相对当前形态改动最小——密封联合类型已经是有类型的。传输机制只需一次变更(回调 → 总线)。

_缺点:_ 密封联合的 switch(消费者模式)会把事件处理逻辑集中在单个函数内;一个只关心 `bound` 的订阅者仍必须在默认分支中匹配 `settled`。新增事件仍会触及每个消费者。

### 3. 基于主题、带类型映射的事件总线(已选)

_每个主题都有自己的负载类型。_ 消费者只订阅自己需要的主题。发布操作会针对该主题的负载类型进行静态检查。新增主题只需扩展事件映射,不影响现有订阅者。

_优点:_ 消费者代码更聚焦(每个主题一个处理器);事件映射是单一的可扩展契约;订阅返回一个零样板的类型化处理器;通过 dispose 函数取消订阅,显式且可测试。

### 4. 微任务异步分发

_在微任务上投递事件。_ 生产者永远不会阻塞在消费者上。

_缺点:_ 从生产者视角看,微任务之间的顺序是不确定的;一个需要在返回前完成已结算副作用(例如会话列表广播)的启动器,若没有显式屏障就无法依赖微任务的执行顺序。错误堆栈跟踪会被拆散在多个微任务之间。

## Decision

采用**选项 3**:在内核层实现一个同步、按序、错误隔离的基于主题的事件总线。

### Key characteristics

| Aspect         | Decision                                                                                            |
| -------------- | --------------------------------------------------------------------------------------------------- |
| **分发**       | 同步,按订阅注册顺序执行。发布操作不返回任何内容。                                                   |
| **错误隔离**   | 每个处理器都被 try/catch 包裹。抛出的异常会被捕获并记录;它既不会阻断后续处理器,也不会传播给发布者。 |
| **异步处理器** | 触发即忘。如果处理器返回一个 promise,总线会捕获未处理的 rejection,但不会 await 它。                 |
| **清理**       | 订阅会返回一个 dispose 函数。逐次启动的订阅必须在 settled 事件之后被 dispose,以防止泄漏。           |
| **类型安全**   | 事件映射把每个主题映射到其负载类型。发布和订阅都会据此进行静态检查。                                |
| **位置**       | 一个自包含的内核模块——不引入 features 或 transport 层(ADR-0009 R1)。                                |

### Event bus surface area

该总线暴露一个类型化的事件映射和三个操作:

- 一组 run 生命周期主题(2026-06-08):每个负载都携带足够的 run 身份信息,使域监听器无需额外查找即可匹配。run-started 和 run-settled 主题携带会话 id + 工作区;run-bound 主题携带旧 id、真实 id 和工作区。run-settled 还携带 run 的结束原因。每个都携带该 run 的 `sessionKind`(业务场景)和 `runKind`(执行形式)——详见下文。
- 一组降级链主题(2026-06-08,见 agent-session AS-R25):一个 agent-error 主题(会话 id、工作区、失败 agent 的 id + 名称、错误、以及一个可降级标志)、一个 agent-fallback 主题(会话 id、工作区、from/to agent 的 id + 名称)、以及一个 agent-all-failed 主题(会话 id、工作区、已尝试的 agent 列表及其错误、以及一个可选的被跳过的跨厂商 agent 列表及其厂商)。

这三个操作分别是:向某个主题发布负载(静态检查);向某个主题订阅一个处理器,返回一个 dispose 函数;以及清除所有订阅。

### SessionKind / RunKind taxonomy (2026-06-08; split 2026-06-26)

run-started/run-settled 携带(并贯穿会话运行时)的 kind,被拆分为两个正交维度,二者均定义在共享协议定义中。**SessionKind** 是业务场景(run 从何而来);**RunKind** 是执行形式(如何执行)。监听器按 `sessionKind` 路由业务决策,按 `runKind` 路由机制决策。

`SessionKind`——业务场景枚举(此前是单一的 7 值 `RunKind`;这些值在 2026-06-26 原样迁移到此处,并将 `'session' → 'work'`;而 `RunKind` 更早之前是两值的 normal/intent 会话种类,`'normal' → 'session'`):

| SessionKind  | 业务场景                                                                         |
| ------------ | -------------------------------------------------------------------------------- |
| `work`       | 通用开发会话(用户控制台、intent→dev 交接、自动化 dev-turn)。此前为 `'session'`。 |
| `intent`     | 只读的意图沟通会话。                                                             |
| `discussion` | 讨论编排器 + 其研究阶段。                                                        |
| `automation` | 由调度器发起、**无 socket** 的 run(例如一个 `llm` 任务)。                        |
| `consensus`  | 一次共识投票。                                                                   |
| `tool`       | 一次内部工具调用:完成度判定(judge)+ 标题推导。                                   |
| `spec`       | 一次规格撰写会话(写入被限定在该 intent 的规格目录内)。                           |

`RunKind`——细化的执行形式枚举(与 SessionKind 正交;目前仅用于审计/可扩展性记录,尚无消费者分支):

| RunKind       | 执行形式                                                                     |
| ------------- | ---------------------------------------------------------------------------- |
| `interactive` | 有 socket 支撑、由人类观察的 run(用户控制台、intent→dev、intent/spec 沟通)。 |
| `background`  | 无 socket 但仍在 run 总线上的 run(自动化 dev-turn)。                         |
| `headless`    | 调度器自身的无 socket run。                                                  |
| `internal`    | 一次内部编排/工具调用(discussion、consensus、judge/naming)。                 |

同一个 `sessionKind` 的两个 run 可以有不同的 `runKind`——例如一个 `work` 控制台是 `interactive`,而一个 `work` 自动化 dev-turn 是 `background`。

**`automation` 是一个触发来源,而不是某个会话会“变形”成的 run 类型。** 一个由事件触发的自动化会发出一个 `sessionKind` 为 `work`(一次用户/开发 run)的 run-started/run-settled——调度器对此作出反应。`automation` 只标记调度器*自身*的无 socket run。因此,事件触发的自动化按 `sessionKind === 'work'` 过滤(从旧的 `session`-kind 判断原样迁移而来;语义不变)。

如今 `work`、`intent`、`discussion` 和 `automation` 这几种 sessionKind 都流经 run 总线。

- `work`/`intent` 通过会话运行时(run 启动器路径;`intent` 是第一个非 `work` 的种类,2026-06-08)。
- `discussion` 通过讨论 run 启动器,它在研究和编排器调用前后发布带有 `discussion` sessionKind 的 run-started/run-bound/run-settled,而不创建会话运行时(2026-06-08-010)。
- `automation` 通过调度器的派发-跟踪步骤,在每次调度执行前后发布带有 `automation` sessionKind 的 run-started/run-bound/run-settled(2026-06-08-010)。

剩下两个(`consensus`、`tool`)仍以其 sessionKind 作为类型化标注 + 日志标签来标记无 socket 的内部调用,但尚未接入总线。

### Retrofit: run-domain callback → bus topics

| 旧的 run 域事件种类 | 新的总线主题 | 负载                            |
| ------------------- | ------------ | ------------------------------- |
| bound               | run-bound    | 旧 id、真实 id、工作区          |
| settled             | run-settled  | 会话 id、工作区、原因、run kind |

旧的逐次启动回调已被移除。全部 5 个消费者现在都通过事件总线订阅(该总线已被添加到内核上下文和启动器的依赖项中)。

### Consumer subscription lifecycle (original pattern, deprecated 2026-06-08)

每个消费者在调用 run 启动器**之前**订阅。由于发布的事件是同步的,并在启动过程中触发(对 bound 事件是在 bind 回调内,对 settled 事件是在 finalize 步骤中),因此在事件触发时,订阅保证已处于激活状态。

**清理模式**(bound 和 settled 均适用):在 settled 处理器中释放两个订阅,并在启动返回后附加一个兜底清理。

**仅 bound 模式**:在 bound 处理器内自动释放,并在启动返回后附加一个兜底清理。

**⚠️ 2026-06-08:逐次启动订阅在 run 生命周期上已被弃用。** 见下文的[常驻域订阅](#resident-domain-subscriptions-2026-06-08)。

### Resident domain subscriptions (2026-06-08)

上文所述的逐次订阅/释放模式已被一组**应用生命周期内、单一职责的常驻订阅**所**取代**,这些订阅在组合根处一次性注册,且**永不释放**。此变更修复了一个并发缺陷:一个已结算的 run 会同时释放自己的订阅**以及**所有其他挂起 run 的订阅(因为 run 主题是按注册顺序遍历的全局广播),从而导致后续的 run-bound 事件丢失。

这些常驻订阅在事件总线和广播闭包构建完成后,于组合根处一次性注册。

**设计原则:**

| Aspect         | Decision                                                                                                                                |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **注册**       | 在组合根处一次性完成;永不释放。                                                                                                         |
| **匹配**       | 每个订阅使用事件的会话 id / 旧 id 来查找域状态(运行时种类、intent 最后一次开发会话 id、待处理的开发链接)——而**不是**订阅 id。           |
| **幂等性**     | 对不匹配所属域状态的事件为空操作(例如未知会话的 run-bound,或会话 id 不匹配任何 intent 最后一次开发会话 id 的 run-settled)。             |
| **按连接**     | 被查看会话的重新指向由客户端驱动(在收到广播的 session-started 且其活动会话与客户端 id 匹配时,回显 view-rebind 消息)。没有逐次启动订阅。 |
| **自动化触发** | 已有的自动化派发订阅一直都是常驻的(作为参考模板)。其 run-kind 过滤条件从“非 session”改为对 `session` 种类的显式白名单,以便于测试。      |

**四个常驻订阅(2026-06-08-010 增加了 discussion + automation):**

1. **Run-bound(intent-session + session/dev 域):**
   - 通过真实 id 获取会话运行时,若找不到则回退到旧 id。
   - 如果种类是 `intent` 且运行时在真实 id 下存在(真正的 pending→real 路径,而非 resume 边):重新绑定聊天会话并广播意图会话列表。
   - 否则(session/dev):持久化操作模式,检查待处理的开发链接是否存在手动“开始开发”关联,并向所有连接扇出 session-started 广播。

2. **Run-settled(intents-automation 域):**
   - 立即广播会话列表刷新。
   - 对于 `session` 种类:扫描该工作区的所有 intent,查找其最后一次开发会话 id 与已结算会话匹配的那个。若找到,广播 intent 列表,并通知该工作区的自动化控制器该轮次已结算(若自动化处于空闲状态则为空操作)。

3. **Run-settled(discussion 域)**——2026-06-08-010 新增:
   - 过滤条件:`discussion` 种类。
   - 广播讨论列表刷新。
   - 讨论启动器围绕 `discussion` 种类发布 run-started/run-bound/run-settled;此订阅取代了它们原先的逐次 run finalize 广播。

4. **Run-settled(automation 域)**——2026-06-08-010 新增:
   - 过滤条件:`automation` 种类。
   - 广播自动化列表刷新。
   - 调度器引擎围绕 `automation` 种类发布 run-started/run-bound/run-settled;此订阅取代了旧的 store 层级广播。

**自动化编排器(事件驱动的有限状态机):**

自动化控制器不再使用内部的 await 循环。取而代之的是一个事件驱动的状态机,它在收到常驻订阅发出的轮次结算通知时进行状态转移。旧的顺序化 develop 循环(带延续上限)和旧的 await-project-running 并发闸门已被移除;其逻辑被吸收进:

- 一个轮次结果处理器——异步:判定(judge)→ 提交(commit)→ 下一个 / 继续 / 失败,由匹配当前正在开发中 intent 的 run-settled 触发。
- 一个 fix-turn-settled 处理器——在 lint-fix agent 轮次结算后重试提交。
- 一个开发启动器——为每个 intent 决定 fresh/resume/attach 策略。
- 一个下一 intent 选择器——挑选下一个符合条件的 intent(若并发闸门处于激活状态则延后)。
- 一个阻塞 intent 查找器——即 RM-A12 闸门:检查是否有任何非自动化 intent 的开发会话真正在运行;若是,则延后新 intent,直到阻塞会话结算(是旧 await-project-running 闸门的事件驱动版本)。

并发闸门、延续上限(10)、lint 修复重试和提交排序均被保留——只是驱动机制变了(事件 → 异步链,而非循环 → await)。

**移除的五处逐次启动订阅站点:**

| 站点          | 移除的订阅                     | 替代方案                                            |
| ------------- | ------------------------------ | --------------------------------------------------- |
| Works 特性    | run-bound + run-settled        | 常驻订阅(intent-session/dev 域)+ view-rebind 处理器 |
| Intents 特性  | run-bound(refine intent)       | 常驻 run-bound(intent-kind 分支)                    |
| Intents 特性  | run-bound(discussion → intent) | 同上                                                |
| Intents 特性  | run-bound + run-settled        | 待处理开发链接 + 常驻 run-bound + run-settled       |
| Dev-turn 接线 | run-bound + run-settled        | 常驻订阅 + 待处理开发链接注册                       |

**新的协议消息:** 一个 view-rebind 消息(客户端→服务端)。当客户端的活动会话与其客户端 id 匹配时,客户端会在 session-started 处理器中发送该消息。服务端处理器重新指向该连接所查看的会话,保留了唯一真正属于逐连接的状态。

**待处理开发链接:** 一个最小化的内存中映射(旧 id → intent id),它是常驻模型所需的唯一一份注册状态。它由手动“开始开发”处理器注册,并被常驻的 run-bound 订阅消费(且删除)。一个针对 run-settled 的兜底清扫会清理任何 run 结算但未绑定的条目。(自动化编排器对新启动也使用同一机制,由外部生成待处理 id。)

### The bus on the kernel context

事件总线实例在启动时(组合根处)构建一次,并被添加到:

1. 内核上下文——供特性处理器订阅。
2. 启动器依赖项——供 run 启动器发布。

两者引用的是**同一个**总线实例,因此从内核上下文注册的订阅者能够收到从启动器发布的事件。

**2026-06-08-010 扩展:** discussion 和 automation 的 run 也发布到此总线。讨论启动器围绕每次研究/编排器 run 发布;调度器围绕每次调度执行发布。两者都引用同一个总线实例(通过各自在组合根处的依赖项注入),因此所有订阅者也都能收到 discussion + automation 生命周期事件。

## Consequences

- **更容易:** 新增一个生命周期事件(例如一个 agent-failed 或 team-upgraded 主题)只需在事件映射中加一行 + 在启动器中加一次发布调用。现有订阅者不受影响。**已实现(2026-06-08):** 降级链事件化(agent-error / agent-fallback / agent-all-failed 主题,agent-session AS-R25)正是遵循这条路径——三行主题定义 + 启动器中三处薄薄的旁路发布调用,对该链条的控制流、FSM 或线上帧零改动;所有既有契约测试保持绿色。
- **更容易:** 一个需要对 run-bound 做出反应的特性(例如在会话绑定时更新侧边栏)只需在注册时订阅——无需改动组合根接线。
- **更安全:** 常驻订阅模型消除了一整类并发缺陷,即一个已结算的 run 释放了另一个挂起 run 的订阅(这正是最初的动机)。订阅永不释放,因此不存在“错误连接的清理”这一攻击面。待处理开发链接映射是唯一有意为之的注册状态;它在第一次 run-bound 时被消费,并在结算时被清扫。
- **更轻量:** 自动化编排器内部的观察器(在开始时添加、在轮次结束时移除)与总线订阅原本是两个关注点,却都对同一生命周期做出反应。将总线订阅从 dev-turn 接线中移除后,该观察器只跟踪权限请求和用于“等待权限”回调的助手文本——一个纯粹的运行时观察角色。
- **可测试性:** 该总线是一个没有 I/O 的普通类——publish/subscribe/dispose 都可在没有 mock 的情况下进行单元测试。专门的事件总线测试覆盖了错误隔离、顺序、类型安全(编译期)和生命周期。新的常驻订阅测试(2026-06-08)覆盖了并发 run 场景、开发链接匹配以及自动化 run-kind 白名单过滤。**2026-06-08-010:** 新测试覆盖了 discussion + automation 订阅分发、跨种类隔离,以及 run-started 守卫。

## Compliance

- Typecheck 通过。
- Lint 通过。
- 完整测试套件通过(2026-06-08-010)。
- 事件总线单元测试覆盖:
  - publish/subscribe/unsubscribe
  - 错误隔离
  - clear
  - 类型安全(编译期断言)
  - run 域一致性
- 契约测试保持绿色——启动器的生命周期行为未变。
- 内核层没有新增对 features 或 transport 层的引用(ADR-0009 R1)。

## References

- [ADR 0009](0009-unidirectional-boundaries.md) — 内核/传输/特性边界。此总线位于内核中,不得引入 features 或 transport 层。
- [Architecture overview](../architecture.md) — 系统形态与模块图。
- [ADR conventions](adr.md) — 命名、编号、索引。
