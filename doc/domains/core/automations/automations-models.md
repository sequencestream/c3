# automations — 数据模型

实体定义。业务语义类型;物理接线见 [automations-design.md](automations-design.md)。
线上数据形状统一定义在 [共享协议](../../../shared/api-conventions/websocket-protocol.md) 中。

## Automation

一个限时任务:在配置时间触发的 shell 命令或 LLM 提示。

| 属性                     | 类型                                                        | 说明                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                     | text (UUID)                                                 | 自动化的唯一标识符                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `workspaceId`            | text (UUID)                                                 | FK → session-registry 工作区;创建后不可变(SCH-R1)                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `name`                   | text                                                        | 人类可读的显示名称。创建时**由服务端根据任务内容自动生成**(客户端提供的名称会被剥离)。**更新**时客户端可提供手动标题:非空值会被固化存储(`nameSource='user'`,自动命名永不覆盖它);空值则回退为自动派生的名称(SCH-R19)。                                                                                                                                                                                                                                                                       |
| `taskType`               | 枚举 `command \| llm_prompt`                                | 要执行的任务类型;创建后不可变(SCH-R2)                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `taskConfig`             | JSON(按 taskType 定型)                                      | 任务配置:`command` ⇒ `{ command: string }`;`llm_prompt` ⇒ `{ prompt: string, mode?: PermissionMode }`                                                                                                                                                                                                                                                                                                                                                                                       |
| `vendor`                 | 厂商 id                                                     | 持久化的厂商范围,决定任务的工具清单、执行策略与适配器路由。                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `agentId`                | text \| null                                                | 为 LLM 任务选择的显式已启用 Agent。其厂商必须等于 Automation 的厂商;仅命令任务与等待修复的遗留任务为 null。                                                                                                                                                                                                                                                                                                                                                                                 |
| `maxWallClockMs`         | integer \| null                                             | 单次执行的最大墙钟时长(毫秒)。Null 使用任务类型默认值:command 为 30 秒,LLM 为 60 秒。显式值为 1 秒到 24 小时之间的整毫秒数。                                                                                                                                                                                                                                                                                                                                                                |
| `triggerType`            | 枚举 `cron \| event`                                        | 自动化的触发方式(SCH-R17)。在此字段引入之前迁移的行默认为 `cron`(2026-06-08)。                                                                                                                                                                                                                                                                                                                                                                                                              |
| `triggerAt`              | timestamp \| null                                           | 一次性触发时间(计时字段中只会设置其中一个,SCH-R3)                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `cronExpression`         | text \| null                                                | `cron` 触发使用的 cron 表达式;按系统 IANA 时区解释(`SystemSettings.timezone`,SCH-R3a),而非 UTC。`event` 触发时为空字符串。                                                                                                                                                                                                                                                                                                                                                                  |
| `eventFilter`            | `GenericEventFilter { type, statuses?, metadata? }` \| null | 用于 `event` 触发的单一通用过滤器(2026-07-13,取代 `eventTopic`/`eventReasonFilter`/`eventPrFilter`/`eventIntentFilter`/`eventMetadataFilter`)。`type` = 订阅的事件类型(开放字符串,原 topic);`statuses` = `event.status` 多选(原 reason / PR result / intent phase),缺省/空 = 任意,非空时精确区分大小写;`metadata` = 复用 `{conditions,combinator}`,缺省 = 不过滤(PR 多选 operation 表达为 `OR` 的 `{key:'operation',value}` 条件)。`cron` 时为 null。匹配语义见 SCH-R18/R22 与事件机制 §7。 |
| `eventSessionKindFilter` | `SessionKind[]` \| null                                     | 用于运行生命周期事件触发(`eventFilter.type` = `run:started` / `run:settled`):显式的、**非空**的可触发它的 SessionKind 来源集合(SCH-R18,2026-07-04,取代了硬编码的 `['work']` 白名单)。必填 — 创建/更新时缺失或为空会被拒绝(`automation.missingSessionKindFilter`)。保持独立字段(强制安全边界,非业务过滤器)。cron / pr / intent 时为 null。遗留的运行生命周期行迁移为 `['work']`。                                                                                                            |
| `metadata`               | `Record<string,string>`                                     | 自由格式的键值注解(SCH-R25,2026-07-04)。无预设键 / 模式;经过净化(去除首尾空白、丢弃空值、至多 32 条、键 ≤64 / 值 ≤256 字符)。只有该自动化自身调度器产生的运行事件会把它带入事件负载。默认为 `{}`。                                                                                                                                                                                                                                                                                          |
| `state`                  | 枚举 `active \| paused \| archived`                         | 当前生命周期状态(SCH-R5)                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `executionIdentity`      | 枚举 `read-only \| sandboxed \| full-access`                | 执行时的身份画像(SCH-R4)                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `lastExecutedAt`         | timestamp \| null                                           | 上一次执行开始的时间;从未执行过则为 null                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `createdBy`              | text                                                        | 创建者标识符(用户会话 id)                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `createdAt`              | timestamp                                                   | 创建时间                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `updatedAt`              | timestamp                                                   | 最近修改时间                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

关系:恰好属于一个 Workspace(通过 `workspaceId`)。拥有零个或多个 ExecutionLog。
工作区删除会级联到**归档**该自动化(而非删除它 — SCH-R1)。

### taskConfig 形状

**`command` 类型:**

```json
{
  "command": "pnpm build && pnpm test"
}
```

**`llm_prompt` 类型:**

```json
{
  "prompt": "Run a security audit on the codebase",
  "mode": "default"
}
```

`llm_prompt` 中的 `mode` 会覆盖本次执行的工作区会话默认模式。省略时使用工作区会话的模式
(仍受 `executionIdentity` 约束)。

## ExecutionLog

一次自动化执行的记录。

| 属性           | 类型                                                        | 说明                                                       |
| -------------- | ----------------------------------------------------------- | ---------------------------------------------------------- |
| `id`           | text (UUID)                                                 | 本次执行的唯一标识符                                       |
| `automationId` | text (UUID)                                                 | FK → Automation;标识是哪个自动化产生了本次执行             |
| `status`       | 枚举 `pending \| running \| success \| failed \| cancelled` | 当前执行状态(只能向前推进,SCH-R10)                         |
| `trigger`      | 枚举 `scheduled \| manual`                                  | 本次执行的触发方式:由调度器触发还是用户操作触发            |
| `scheduledAt`  | timestamp                                                   | 自动化预定触发的时间                                       |
| `startedAt`    | timestamp \| null                                           | 执行实际开始的时间;`pending` 时为 null                     |
| `completedAt`  | timestamp \| null                                           | 执行到达终态的时间;活动中为 null                           |
| `output`       | text \| JSON \| null                                        | 执行输出:command 为 stdout,llm_prompt 为消息流             |
| `errorMessage` | text \| null                                                | 状态为 `failed` 时的错误详情                               |
| `exitCode`     | integer \| null                                             | shell 退出码(仅 command 类型);pending/running 时为 null    |
| `durationMs`   | integer \| null                                             | 从 startedAt 到 completedAt 的墙钟时长;到达终态之前为 null |
| `sessionId`    | text \| null                                                | Agent 会话 id(仅 llm_prompt 类型);执行从未开始则为 null    |

关系:恰好属于一个 Automation(通过 `automationId`)。父自动化删除时级联删除。
`startedAt` 一旦设置即只追加(append-only)。

## Pending Change

写入队列中等待用户确认的一次变更(SCH-R6、SCH-R15)。

| 属性           | 类型                                             | 说明                                                             |
| -------------- | ------------------------------------------------ | ---------------------------------------------------------------- |
| `id`           | text (UUID)                                      | 本次待确认变更的唯一标识符                                       |
| `type`         | 枚举 `create \| update_field \| pause \| resume` | 变更的种类(archive/delete 是即时生效的,不进入队列)               |
| `automationId` | text (UUID) \| null                              | 目标自动化 id;`create` 类型时为 null                             |
| `payload`      | JSON                                             | 拟议的变更内容(create 为完整 AutomationFields;update 为部分字段) |
| `createdAt`    | timestamp                                        | 变更被提出的时间                                                 |

关系:归属于单个 WebSocket 连接;不持久化。确认前由所有者替换或丢弃。

## 领域类型取值

各枚举属性的允许取值:

- **state** — `active` | `paused` | `archived`
- **taskType** — `command` | `llm_prompt`
- **triggerType**(事件触发,2026-06-08)— `cron` | `event`
  - 事件主题 — `run:started` | `run:settled`(运行生命周期)| `pr:operation`(模型发布或服务端发布,2026-06-20)
  - 运行结束原因 — `complete` | `error` | `aborted`
  - `run:started` / `run:settled` 上携带的种类是 **SessionKind**(业务场景 —
    `work` | `intent` | `discussion` | `automation` | `consensus` | `tool` | `spec`;只有 `work` 会触发
    用户自动化)与 **RunKind**(执行形式 — `interactive` | `background` | `headless` |
    `internal`)
  - PR 操作(`pr:operation`)— `create` | `review` | `merge` | `close` | `comment`
  - PR 操作结果 — `success` | `failure` | `error`
- **executionIdentity** — `read-only` | `sandboxed` | `full-access`
- **executionStatus** — `pending` | `running` | `success` | `failed` | `cancelled`
- **pendingChangeType** — `create` | `update_field` | `pause` | `resume`
- **trigger** — `scheduled` | `manual`
