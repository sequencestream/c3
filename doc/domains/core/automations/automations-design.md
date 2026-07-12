# automations — 设计

实现 [spec](automations-spec.md)。一个自包含的领域模块,拥有自己的存储、调度器循环与执行分发器。

## 职责划分

| 关注点              | 职责                                                               |
| ------------------- | ------------------------------------------------------------------ |
| 存储(CRUD + SQLite) | 对自动化 + 执行日志进行工作区校验的 CRUD                           |
| 调度引擎            | 固定间隔的 tick 循环;按下次运行时刻查询到期的自动化                |
| 执行分发器          | 派生命令进程或 LLM 智能体会话;写入执行日志                         |
| 写入队列            | _(已规划)_ 按连接维护的待确认变更队列;确认/丢弃生命周期 — 尚未实现 |
| WS 处理             | 将自动化相关的 WebSocket 事件路由到存储/调度器                     |
| 工作区归档          | 监听工作区移除;暂停该工作区下的所有自动化                          |

## 数据模型(SQLite)

项目级 SQLite 数据库中的两张表(与
[intent-management](../intent-management/intent-management-design.md) 和
[session-registry](../../core/session-registry/session-registry-design.md) 共用同一数据库):

### `automations`(已实现的模式)

```sql
CREATE TABLE automations (
    id              TEXT PRIMARY KEY,
    type            TEXT NOT NULL,                           -- 'command' | 'llm'
    config          TEXT NOT NULL DEFAULT '{}',              -- JSON 字符串
    workspace_path  TEXT NOT NULL,                           -- 解析后的绝对路径
    trigger_type        TEXT NOT NULL DEFAULT 'cron',         -- 'cron' | 'event' (v5, 2026-06-08)
    cron_expression     TEXT NOT NULL,                        -- event 触发时为 ''
    next_run_at         INTEGER,                              -- Unix ms;event 触发时为 null
    event_topic         TEXT,                                 -- 'run:started' | 'run:settled' | 'pr:operation' | null
    event_reason_filter TEXT,                                 -- JSON RunEndReason[] | null (run:settled)
    event_pr_filter     TEXT,                                 -- JSON {operations?,results?} | null (pr:operation, v8 2026-06-20)
    status          TEXT NOT NULL,                           -- 'active' | 'paused' | 'error'
    mcp_mode        TEXT NOT NULL,                           -- 'read-only' | 'sandboxed' | 'full-access'
    tool_allowlist  TEXT NOT NULL DEFAULT '[]',
    tool_denylist   TEXT NOT NULL DEFAULT '[]',
    created_at      INTEGER NOT NULL,                        -- Unix ms
    updated_at      INTEGER NOT NULL                         -- Unix ms
);
CREATE INDEX idx_sch_workspace ON automations(workspace_path);
```

设计说明:

- `workspace_path` 是解析后的绝对路径(而非 UUID),与工作区注册表的键一致。
- 计时是**由 cron 驱动**的:一个 cron 表达式加上一个计算出的下次运行时刻(Unix ms)。
  调度器轮询下次运行时刻早于或等于当前时间的活跃行。每次执行后,下次运行时刻会根据 cron 表达式重新计算。
- **时区:** cron 字段按**系统级 IANA 时区**(配置的系统时区,见 [settings](../../settings/))解释,
  而非 UTC。下次运行时刻的计算会取该时区,把墙钟意义上的 cron 映射为一个绝对时刻,并处理夏令时切换
  (春季跳过的间隙时刻被跳过;秋季回退的重叠时刻取较早的偏移)。服务端两个调用点(创建/更新以及运行后的
  重新计算)都传入配置的时区;前端预览也传入相同的时区,使其下次/即将运行的展示与实际调度时刻一致。
  默认时区是**服务端所在的本地时区** — 无效/未设置的值会回退到它。省略时区(或指定 UTC)会保持
  历史上的 UTC 计算方式不变。**行为变化:** 这替换了此前仅按 UTC 解释的方式。升级后,现有自动化的实际
  触发时刻会从 UTC 变为服务端本地(或配置)时区 — 例如 `0 11 * * *` 会从 UTC 11:00 变为本地时间 11:00。
  这是有意为之的(使 cron 与用户看到的时间对齐),且不需要迁移:下次运行时刻会在下一次创建/更新/运行时
  重新计算。
- **触发类型(v5,2026-06-08):** 触发类型选择 `cron`(通过 cron 表达式与下次运行时刻计时)或 `event`
  (内核运行生命周期事件)。事件行保留空的 cron 表达式、null 的下次运行时刻,并设置事件主题(以及可选的
  事件原因过滤器,一个终态原因的 JSON 列表)。到期自动化查询只返回 cron 行(事件行的下次运行时刻为 null)。
  v5 迁移通过检查现有列集合,幂等地新增这三列(与 v2–v4 迁移一样,共享的全局模式版本计数器不可信),
  将遗留行默认设为 `cron`(SCH-R17)。
- **内部一次性智能体恢复(2026-06-15-002):** 不需要模式迁移。恢复流程存储一条普通的 `command` 行,
  其配置标记为智能体配额恢复动作,记录被禁用智能体的名称与绝对的重置时刻;下次运行时刻被设为该重置时刻。
  分发器识别这类配置后会重新启用该智能体而非派生 shell;随后调度器将状态设为 `paused` 并清空下次运行时刻,
  使该行成为一次性的。
- 存储的 `type` 对应规格中的任务类型,但为简洁起见用 `'llm'` 而非 `'llm_prompt'`。
- config 列是在应用层校验的 JSON 数据块。没有 check 约束 — 校验依赖类型,在创建/更新时进行。
- workspace_path 没有外键约束 — 工作区是否存在在应用层于创建自动化时检查。当工作区被移除时,
  根据 SCH-R1,其自动化会被工作区归档步骤**暂停**(而非级联删除)。

### `automation_execution_logs`(已实现的模式)

```sql
CREATE TABLE automation_execution_logs (
    id              TEXT PRIMARY KEY,
    automation_id     TEXT NOT NULL,
    started_at      INTEGER NOT NULL,                       -- Unix ms
    finished_at     INTEGER,                                -- Unix ms;可为空
    exit_code       INTEGER,                                -- 可为空(仅 command 类型)
    output          TEXT NOT NULL DEFAULT '',                -- 捕获的 stdout 或 LLM 响应
    error_message   TEXT,                                   -- 可为空
    status          TEXT NOT NULL DEFAULT 'running'          -- 'running' | 'success' | 'failed' | 'cancelled'
);
CREATE INDEX idx_sch_exec_automation ON automation_execution_logs(automation_id);
```

设计说明:

- 级联删除 — 当自动化被删除时,其日志会级联移除(在应用层的一个事务内执行,而非通过数据库外键,
  因为该模式使用的是简单的文本列)。
- output 列存储完整的命令 stdout+stderr,或聚合后的 LLM 文本。超过 1 MB 的 LLM 提示输出会被截断。
- 状态遵循单向链:`running → success | failed | cancelled`。日志永不回退(在应用层强制约束 —
  v1 中日志以 `running` 开始,最终定型为终态)。
- 没有 trigger 列 — v1 中一切都由 cron 触发。手动触发("立即运行")通过同一执行路径分发。

## 存储设计

存储为自动化与执行日志提供工作区范围的 CRUD,使用 c3 主目录下共享的 SQLite 数据库。
调度器与分发器使用的关键能力:

| 能力                 | 用途                                                            |
| -------------------- | --------------------------------------------------------------- |
| 获取到期自动化       | 返回下次运行时刻已设置且早于或等于给定时刻的活跃行              |
| 获取事件自动化       | 返回订阅了某个运行生命周期主题的活跃 `event` 自动化(2026-06-08) |
| 更新下次运行时刻     | 执行后持久化重新计算出的下次运行时刻                            |
| 暂停某工作区下的全部 | 将某工作区下的每个自动化设为 `paused`                           |
| 追加执行日志         | 以 `running` 状态创建一条执行日志条目                           |
| 更新执行日志         | 执行后更新一条执行日志的状态/输出/错误                          |
| 列出执行日志         | 某自动化的全部执行日志,按开始时间从新到旧排列                   |

## 调度引擎

调度器运行一个固定间隔的 tick 循环来查询并分发到期的自动化。其职责:

- **启动** tick 循环(10 秒间隔)。
- 优雅**停止**,等待在途执行完成(最多 30 秒)。
- **立即运行** — 手动触发:绕过 tick 立即分发。
- **分发事件自动化** — 在运行生命周期总线事件发生时,分发订阅了该主题的自动化(2026-06-08)。
- **取消**一次在途执行,或取消某工作区的全部在途执行。

它用一个以自动化 id 为键的内存映射(每个自动化一个 promise)追踪在途执行,这既保证了单个自动化的
串行执行,也为优雅关闭提供了边界。

### Tick 循环

每 10 秒:查询到期自动化 → 为每个创建一条日志 → 分发 → 追踪在途状态。

1. 查询到期自动化 — 下次运行时刻早于或等于当前时间的活跃行。
2. 过滤掉已经在途的自动化(每个自动化串行执行)。
3. 对每个到期自动化:追加一条日志条目,然后分发。分发被追踪在在途映射中,结束时移除。
4. 内部智能体恢复行在执行后会被暂停,并清空其下次运行时刻,而不是根据 cron 表达式重新武装。
5. tick 中的所有错误都会被捕获并记录 — tick 循环永不静默停止。

### 陈旧触发的宽限窗口

当服务端重启时,某些自动化的下次运行时刻可能已经在过去:

- 距现在 5 分钟以内 → 正常执行。
- 超过 5 分钟 → 保持 `active` 状态,记录一条 `failed` 执行日志说明错过了触发窗口,并从现在起
  重新计算 `next_run_at`。错过的这次不会被回放,循环自动化会继续在其下一个 cron 发生时刻触发。
- 内部智能体恢复行不受错过触发错误路径的约束;即使服务端延迟重启,也应重新启用该智能体而不是让它
  一直停留在禁用状态。

### 手动触发(立即运行)

- `automation_run_now` WebSocket 事件为目标自动化调用调度器的立即运行路径。
- 校验:自动化必须存在,状态为 `active` 或 `paused`(非 `archived`),且尚未在途。这次一次性的
  手动执行不改变 `status`;暂停的自动化仍保持暂停,其 `next_run_at` 不会被重新计算。
- 创建一条执行日志并立即分发(在 tick 循环之外)。
- 执行结果会被广播以刷新 UI。

### 事件触发分发(2026-06-08,2026-06-20 扩展)

事件分发路径在组合根中接入内核事件总线,订阅 `run:started` / `run:settled`(运行生命周期)与
`pr:operation`(模型发布或服务端发布)。每次事件发生时:

1. **仅限运行生命周期主题:** 若事件的运行种类不是用户 `session` 运行 → 直接返回
   (内部通信运行永不触发用户自动化,SCH-R18)。`pr:operation` 不携带运行种类,跳过此道门(SCH-R22)。
2. 获取订阅了该主题的活跃 `event` 自动化。
3. 保留工作区匹配的那些(双方都已解析),然后应用主题过滤器:对 `run:settled`,应用事件原因过滤器
   (null/空 = 任意);对 `pr:operation`,应用 PR 过滤器 — 事件的 `operation` ∈ `eventPrFilter.operations`
   且 `result` ∈ `eventPrFilter.results`,每个空/null 维度 = 任意(SCH-R22)。
4. 跳过任何已在途的自动化(SCH-R7 串行执行 = 事件风暴限流)。
5. 幸存者走与 cron 运行**相同**的分发-追踪 → 执行路径(因此三层 MCP 安全 + 写入审批队列不变地适用)。
   运行后的重新武装会跳过 `event` 自动化的下次运行重新计算(它们没有 cron)。

运行生命周期的发布点位于运行路径中。`pr:operation` 的发布点有两个来源:`publish_pr_event` MCP 工具
(c3 将其提供给每个工作会话,以便模型在用自己的工具执行 PR 操作后发布一个厂商中立的事件),以及
服务端的 PR 创建路径(dev-cleanup / automation / 手动 create_pr),它们会在代表模型成功创建 PR 后
发布一个 `create`/`success` 事件。见 automations-spec.md § Triggers → PR operation events
(SCH-R22 / SCH-R23)。

`pr:operation` 总线事件在 `run-domain-subscriptions.ts` 中还有**第二个、独立的**常驻消费者
(不在本分发路径中):当 `operation=update` + `result=success` 且携带 `association.intentId` 时,
intent 领域会把一个被拒绝/失败/关闭的 intent 的 `prStatus` 重置回 `reviewing`。它有意位于
`dispatchEventTriggers` 之外 — 即便没有配置任何自动化、Automation 存储不可用、或该自动化被在途门
跳过,账本状态机也必须能够恢复。两者是同一事件的独立副作用;互不阻塞。

## 执行分发器

分发器提供两条执行路径,由自动化类型决定选用哪条。每条都接受自动化本身、执行日志 id、以及一个
用于更新日志的回调,并运行至终态。

### 命令执行

1. 从自动化的 JSON 配置中读取命令字符串。
2. 在自动化的工作区目录中派生一个无头 shell 进程。
3. 将 stdout + stderr 累积进输出缓冲区。
4. 通过自动化级别的 `maxWallClockMs` 字段(默认 30 秒)配置硬超时:
   - 超时 → 杀死进程 → 记录 `failed` 并说明超时。
5. 进程退出时:退出码 0 → `success`;非零 → `failed` 并说明非零退出码。
6. 进程创建失败 → `failed` 并附带错误信息。
7. 支持配置最大重试次数字段(默认 0):非零退出或超时时,最多重试 N 次。所有重试共用同一条日志
   条目与同一个 `maxWallClockMs` 截止时间 — 只记录最后一次尝试的结果。

### 内部智能体恢复执行

在常规命令分发之前,分发器会检查配置是否将该行标记为智能体配额恢复动作。这类行是系统所有的:
它从不派生 shell,并忽略用户的命令配置。分发器通过智能体配置模块重新启用指定的智能体,写入一条
成功/失败的执行日志,然后返回。调度器的运行后分支检测到同样的配置,将自动化标记为 `paused` 并
清空下次运行时刻,使该行被保留以供审计,但不会重复。

### LLM 提示执行

1. 从自动化的 JSON 配置中读取提示文本。
2. 按自动化的厂商解析智能体 — 该厂商第一个已启用的智能体,回退到默认智能体。执行通过共享的
   SDK query 路径进行;专用的适配器驱动路径是未来的条目。
3. 通过 SDK query 路径启动一个轻量智能体会话:
   - 工作目录 = 自动化的工作区(继承该工作区的项目指令、环境变量、设置)。
   - 权限模式 = default(以便逐工具的权限回调触发,实现权限控制)。
   - 可用工具取决于自动化的执行身份:
     - `full-access`:所有工具自动允许(绕过权限)。
     - `sandboxed`:只允许只读工具集(read/grep/glob/list/web-fetch/web-search);写入工具被拒绝。
     - `read-only`:所有工具被拒绝。
   - 通过自动化级别的 `maxWallClockMs` 字段(默认 60 秒)配置墙钟超时。
4. 将助手文本块累积进输出。
5. 若配置携带输出模式(JSON Schema),校验输出:
   - 校验通过 → `success`。
   - 校验失败 → `failed` 并说明模式校验失败及详情。
6. 无自动重试(LLM 执行可能有副作用)。重试需要手动重新运行。
7. 智能体会话是临时的 — 没有 WebSocket 查看器,不在会话侧栏中列出。会话 id 不会被持久化
   (v1 中无需可追溯性)。

**Codex 厂商路径(`driver.start`)。** codex 自动化通过 codex 驱动而非共享 SDK query 路径运行。
启动前,分发器解析宿主机 `gh` 密钥环凭据,当 `GH_TOKEN` 与 `GITHUB_TOKEN` 都未设置时,将 `GH_TOKEN`
注入驱动的 `envOverrides`,使 PR review/comment/merge 相关的 shell 命令能在 seatbelt 沙箱内完成认证
(见 [codex-sdk-guide § GitHub CLI 凭据桥接](../../../architecture/codex-sdk-guide.md))。这与网络是
正交的:codex 路径不传递 `networkAccess`,因此沙箱网络仍由自动化的 `mode`/`toolAllowlist` 管控。
解析出令牌但网络关闭**不是**认证失败 — 诊断会区分"宿主机令牌缺失"与"沙箱网络隔离",绝不简单归结为
"重新运行 `gh auth login`"。探测失败是非致命的,永不阻塞执行。

## 写入队列

_(已规划 — v1 中未实现)_

设计见 [automations-spec.md](automations-spec.md) § Write confirmation queue。v1 中所有自动化变更都是
即时生效的(直接的存储操作 + 广播)。

## 工作区归档

监听工作区移除事件,暂停属于该工作区的所有自动化。当工作区从注册表中移除时,归档步骤会:

1. 取消该工作区下的任何在途执行。
2. 暂停该工作区中的所有自动化。
3. 将移除后的自动化广播留给处理工作区移除的调用方来做。

## 与服务端的集成

### 初始化

存储就绪后(数据库初始化之后),启动调度器,并为事件触发的自动化订阅内核事件总线(2026-06-08)。
当自动化存储可用时,调度器被启动,事件分发路径同时订阅 `run:started` 与 `run:settled`,贯穿整个
服务端运行期(进程生命周期的订阅,不释放)。

### 工作区移除

工作区移除处理器被扩展为:拆除其运行时、执行归档步骤(取消在途执行并暂停该工作区的自动化)、
移除工作区,然后向 UI 广播现已暂停的自动化及刷新后的状态。

### 立即运行

立即运行处理器校验存储可用,为目标自动化调用调度器的立即运行路径,然后广播该工作区的自动化,
以带着新的执行日志刷新 UI。

### 服务端关闭

服务端关闭时,以 30 秒超时优雅地停止调度器,等待在途任务完成。

## 技术选型

- **SQLite** 用于持久化 — 共用已有的项目级数据库。无需额外运行时依赖。
- **无头 shell 进程** 用于命令执行。简单、易懂,无需外部执行器依赖。
- **固定间隔 tick**(10 秒)而非为每个自动化设置事件驱动的定时器。避免管理 N 个定时器,推理更简单。
- **进程内分发器** — 没有任务队列。所有执行都在服务端进程内运行。
- **SDK query 路径** 用于 LLM 提示执行 — 复用既有的 Agent SDK 集成模式。
- **配置以 JSON 存储** 避免了两种任务类型之间模式演化的复杂度。

## 非功能性考量

- **延迟:** 调度器的 tick 是低延迟的(数据库查询 + 内存过滤)。执行延迟依任务而定,没有上界。
- **可靠性:** 调度器循环是单个固定间隔的定时器。若某次 tick 的处理器抛出异常,该错误会被捕获并记录;
  间隔循环继续运行。
- **内存:** 在途追踪使用以自动化 id 为键的内存映射。在典型用量下(数十个自动化),内存开销可忽略。
- **存储:** 执行日志会无限增长。日志保留策略被推迟到未来的迭代。
- **安全性:** 命令自动化以服务端进程的用户身份运行。LLM 提示自动化使用自动化的执行身份做工具访问控制。

## 依赖

| 依赖                     | 用途                              |
| ------------------------ | --------------------------------- |
| 一个 cron 解析库         | 解析 cron 表达式,计算下次运行时间 |
| 宿主机的进程派生设施     | 执行 command 类型的自动化         |
| Claude Agent SDK         | 通过 query 路径执行 LLM 提示      |
| 一个加密安全的 id 生成器 | 生成日志 id                       |

## 配置形状(JSON)

### command 类型

```json
{
  "command": "echo hello",
  "maxRetries": 0
}
```

### llm 类型

```json
{
  "prompt": "分析当前目录结构并生成报告",
  "outputSchema": {
    "type": "object",
    "properties": {
      "files": { "type": "array", "items": { "type": "string" } }
    }
  }
}
```

两者都以 config 列的 JSON 数据块存储,并在应用层校验。
