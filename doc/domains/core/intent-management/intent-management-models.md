# intent-management — 数据模型

以领域术语给出的实体定义;物理接线(SQLite 驱动、schema 迁移)见
[intent-management-design.md](intent-management-design.md)。intent、proposed-intent、priority 与 status 的线上形状统一定义在
[共享协议](../../../shared/api-conventions/websocket-protocol.md)中;领域文档引用它们,
而不是重新定义消息形状。

## Intent

一个限定在单个项目范围内的台账条目。

| 属性                | 类型                        | 说明                                                                                                                            |
| ------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `id`                | text (UUID)                 | 稳定标识符;被依赖关系与开发反向链接引用                                                                                         |
| `workspacePath`     | text (path)                 | 解析后的绝对工作区路径;项目键(RM-R1, RM-R10)                                                                                    |
| `title`             | text                        | 简短的意图标题                                                                                                                  |
| `shortEnTitle`      | text \| null                | 简短英文 ASCII 短标题 — 派生 Git 分支名 / worktree 目录名的稳定来源；落库前截断到 128 字符；历史行为 `null`，仅在 refine 时补齐 |
| `content`           | text                        | 完整的意图描述                                                                                                                  |
| `priority`          | enum `P0`\|`P1`\|`P2`\|`P3` | 需求级别;P0 最高                                                                                                                |
| `module`            | text                        | 模块名称 — 意图所属模块,由沟通智能体根据标题/内容推断;未识别或历史行数据为 `''`(RM-R14)                                         |
| `status`            | enum                        | `draft`\|`todo`\|`in_progress`\|`done`\|`cancelled` (RM-R6, RM-R8, RM-R9)                                                       |
| `dependsOn`         | `id[]`                      | 该条目所依赖的项目内其他意图 id(聚合;RM-R1)                                                                                     |
| `lastWorkSessionId` | text \| null                | 最近一次由意图发起的开发运行所产生的会话 id;反向链接目标(RM-R8/13)                                                              |
| `automate`          | boolean                     | 自动化编排器是否可以拾取该条目;由用户切换,默认 `false`(RM-A1)                                                                   |
| `createdAt`         | timestamp                   | 创建时间                                                                                                                        |
| `updatedAt`         | timestamp                   | 最近一次变更时间                                                                                                                |
| `completedAt`       | timestamp \| null           | 意图进入 `done` 状态的时间;在转为 `done` 时打上时间戳,状态离开 `done` 时清空(置为 null)(RM-R6/RM-R9)                            |

关系:属于一个项目(以 `workspacePath` 标识);拥有零个或多个 Intent
Dependencies;可能引用一个开发 Session(一个普通会话,归 session-registry 所有)。

## Proposed Intent

`save_intents` 调用内的单个条目;也是确认对话框所渲染的内容。没有
`id` 时它尚未持久化 —— 只有在确认保存后才会成为一个 Intent(状态为 `todo`)
(RM-R5/RM-R6)。带 `id` 时,它是对该既有意图的**更新**(upsert,RM-R20)。

| 属性               | 类型                        | 说明                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------ | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`               | `id` (可选)                 | 设置时,原地更新这个**已存在**的同项目意图,而不是插入新的(upsert,RM-R20);`refine_intent` 流程会填充它,使 refine 后的意图更新其原始条目。省略则插入新意图。                                                                                                                                                                                                                                    |
| `title`            | text                        | 提议的标题                                                                                                                                                                                                                                                                                                                                                                                   |
| `shortEnTitle`     | text (必填)                 | 必填的简短英文 ASCII 短标题 — 派生分支/worktree 名的稳定来源；agent 应产出 ≤64 ASCII 字符，落库前截断到 128。新建与更新均要求传入                                                                                                                                                                                                                                                            |
| `content`          | text                        | 提议的描述                                                                                                                                                                                                                                                                                                                                                                                   |
| `priority`         | enum `P0`\|`P1`\|`P2`\|`P3` | 提议的需求级别                                                                                                                                                                                                                                                                                                                                                                               |
| `module`           | text (可选)                 | 推断出的模块名称;省略时 —— 插入场景下落库为 `''`(RM-R14);更新场景下保留原值(RM-R20)                                                                                                                                                                                                                                                                                                          |
| `dependsOn`        | `id[]` (可选)               | 对**已存在**的项目内意图的提议依赖(按 id);更新场景下,提供它(或 `dependsOnIndexes`)会替换依赖集合,两者都省略则保持不变(RM-R20)                                                                                                                                                                                                                                                                |
| `dependsOnIndexes` | `number[]` (可选)           | 对同一批次内**兄弟**条目的提议依赖,按从 0 开始的数组下标;在保存时解析为该兄弟条目的 id(RM-R17)。被下标引用的兄弟条目自身也可能是一个更新目标(RM-R20)。                                                                                                                                                                                                                                       |
| `intentSessionId`  | text (可选)                 | 反向链接到产生此意图的沟通会话,持久化到 `intent_session_id`。**仅当该批次恰好保存一个意图时才生效** —— 多条目批次会忽略它(存储层只在 `length === 1` 时才写入)。智能体用注入到其提示词中的会话 id 来填充它;保存处理器会把它归一化为已绑定的沟通会话 id,以便通过 `open_intent_chat` 解析。这弥补了 refine 的 `run:bound` 回填所无法覆盖的新建意图缺口。`save_intent_directly` 中不存在此字段。 |

## Intent Dependency

一个项目内的一条有向边。

| 属性          | 类型        | 说明         |
| ------------- | ----------- | ------------ |
| `intentId`    | text (UUID) | 依赖方意图   |
| `dependsOnId` | text (UUID) | 被依赖的意图 |

仅用于展示 + 警示:任一依赖尚未 `done` 的条目会显示提示,对其发起开发会给出警告但不会被阻止(RM-R11)。
**对已持久化的图**,v1 中没有拓扑/环检测 —— 但单次 `save_intents` 批次内的批内引用
(`dependsOnIndexes`)会在插入时被校验(下标越界 / 自引用 / 成环会拒绝整个批次,RM-R17),
因为它们在任何行写入之前就已被解析为真实 id。

## Communication Session

用于细化(refine)意图的、按项目划分的隐藏智能体会话。每个项目持有这些会话的一个
**集合**(多行记录),它们都从常规的 `list_sessions` 响应中隐藏。当不带明确会话 id
进入意图视图时,每个项目中会有一个会话被标记为 `isCurrent`,作为默认打开的指针。
会话可以被列出、重命名和删除。

| 属性            | 类型         | 说明                                                                       |
| --------------- | ------------ | -------------------------------------------------------------------------- |
| `sessionId`     | text         | SDK 会话 id(在首次运行绑定之前,可能是一个 `pending:` id)                   |
| `workspacePath` | text (path)  | 解析后的绝对工作区路径(RM-R10)                                             |
| `title`         | text \| null | 用户指定的标题;null 时 ⇒ 客户端回退到 "New Intent" 或首个提示词/时间戳派生 |
| `isCurrent`     | boolean      | 默认打开指针 —— 每个项目最多一个当前会话(RM-R4)                            |
| `updatedAt`     | timestamp    | 最近一次绑定/重命名/运行时间                                               |

关系:一个项目的每一行共同构成该项目的**隐藏集合**(从 `list_sessions` 中排除,RM-R4);
`isCurrent` 那一行是在不带具体 `sessionId` 进入意图视图时被重新加载的会话。首次运行时,
`pending:` id 会被重新绑定为真实的厂商原生 id,同时保留 `isCurrent` 与隐藏集合的成员资格。
会话可以被重命名或物理删除(行删除 + 运行时移除,`isCurrent` 回退到最近剩余的会话)。
该会话还会以 `session_kind='intent'` 镜像到 `session_metadata` 中;refine/反向链接的会话
携带 `owner_kind='intent'` 与该意图的 id,使统一的 Sessions 页面与 WorkCenter 能够跳回,
而无需增加线上级别的 `jumpTarget`。

撰写 spec 的会话通过 `intents.spec_session_id` 关联,而不是通过单独的 spec 表。
当 `write_spec` 或 `reset_spec_session` 的 pending 运行时绑定到真实厂商会话 id 后,
同一个会话会以 `session_kind='spec'`、`owner_kind='intent'`、`owner_id=<intent.id>`
投影到 `session_metadata` 中。替换当前 spec 会话会清除旧的投影 owner,使一个意图
只暴露当前的 spec 条目作为其跳回目标。意图台账仍然是当前 spec 会话与审批状态的
唯一真实来源(SoT);该投影是可重建的 Sessions 页面缓存。

## Automation Status

一个项目的自动化编排器的实时状态(RM-A1–RM-A9)。仅存于内存中(每个项目一份;不持久化 ——
服务器重启会将其重置为 `idle`)。作为 `automation_status` 线上事件推送给每个连接。

| 属性                 | 类型              | 说明                                                                        |
| -------------------- | ----------------- | --------------------------------------------------------------------------- |
| `workspacePath`      | text (path)       | 解析后的绝对工作区路径(RM-R10)                                              |
| `state`              | enum              | `idle`\|`running`\|`done`\|`error` (RM-A2/A6/A7)                            |
| `currentIntentId`    | id \| null        | 当前正在开发的意图(未运行时为 null)                                         |
| `currentSessionId`   | text \| null      | 当前意图的开发会话,用于反向链接                                             |
| `awaitingPermission` | boolean           | 当当前开发轮次因权限提示而暂停、等待人工回答时为 true(RM-A9);轮次结束时清除 |
| `error`              | text \| null      | 异常停止的原因;除非 `state = error` 否则为 null(RM-A6/A7)                   |
| `completedIds`       | `id[]`            | 本次运行中已完成(已提交 + 已推送)的意图 id 列表                             |
| `startedAt`          | timestamp \| null | 编排器启动的时间;从未启动时为 null                                          |

## 持久化存储(c3.db)

位于 `~/.c3/c3.db` 的 SQLite 台账(区别于 registry 的 `state.json`)。Schema 版本通过
`PRAGMA user_version` 管理(目前为 `12` —— v2 新增 `intents.module` 列,v3 新增可空的
`intents.completed_at` 列,v4 新增 `intents.automate` INTEGER NOT NULL DEFAULT 0,v6 把
遗留的 requirement- 前缀表重命名为 intent- 前缀,v7 新增可空的 `intent_chats.title` 列,
v8 新增 git 追踪字段,v9 新增 `intent_deps.dep_type` + `created_at`,v10 新增
`intent_sessions` 审计表,v11 把工作区键列 `project_path` → `workspace_path` 原地重命名到
`intents` + `intent_chats` 上,并把复合索引重建为 `idx_intent_workspace_status`,v12 新增
可空的 `intents.short_en_title` 列(派生分支/worktree 名称的稳定 ASCII 来源;历史行保持
null,写入侧截断到 128)。这次重命名有意与向后兼容的 `projectConfigs` settings.json 键
产生分歧,该键保留其历史名称 —— 见 2026-06-14 的 workspace-path 迁移记录)。表:`intents`、
`intent_deps`、`intent_chats`(会话集合 + 隐藏集合在同一张表中),以及 `tool_sessions`
(`session_id` PRIMARY KEY + `created_at`)—— 工具创建会话(完成判定器、共识顾问)的
持久化集合,使 session-registry 的“显示工具会话”过滤器能在重启后存续。`tool_sessions`
只是一张标记表;工具会话的来源链接存放在 `session_kind='tool'` 行的
`session_metadata.owner_kind` / `owner_id` 中,无 owner 的工具行仅用于展示。会话被删除时,
其行也会被删除。跨运行时驱动适配器与迁移处理见
[intent-management-design.md](intent-management-design.md)。

跨领域的 `session_metadata` 投影存在于意图台账的唯一真实来源表之外。intent 的写入操作
会为列表/计数读取 upsert/delete 投影行,但意图内容、当前会话选择、以及隐藏集合成员资格
仍归 `intent_chats` 所有。
</content>
