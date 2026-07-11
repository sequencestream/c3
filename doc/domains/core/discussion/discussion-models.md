# discussion — 数据模型

实体定义。业务语义类型；物理接线（schema、迁移）见
[discussion-design.md](discussion-design.md)。Discussion、Discussion Message、status 与 speaker-kind
的形状是单一共享 wire/持久化契约的一部分——与 intent 实体类型同源——
在此处引用而非重新定义。

## Discussion

一个限定在单个项目范围内的目标导向对话。

| 属性                  | 类型              | 说明                                                                                                                                                                     |
| --------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                  | text (UUID)       | 稳定标识符；被消息引用                                                                                                                                                   |
| `workspacePath`       | text (path)       | 解析后的绝对工作区路径；工作区键（始终解析为绝对路径）                                                                                                                   |
| `title`               | text              | 简短的讨论标题                                                                                                                                                           |
| `type`                | text              | 自由形式的讨论类型/分类（例如 design、arch）；持久化层不做枚举约束                                                                                                       |
| `goal`                | text              | 该讨论要达成的目标；未设置时为 `''`                                                                                                                                      |
| `context`             | text              | 为讨论提供背景的材料——用户的原始输入；未设置时为 `''`；**永不被调研覆盖**                                                                                                |
| `researchResult`      | text              | 只读调研智能体已完成的输出，与 `context` 分开存储；在调研得出非空结果之前（或调研被跳过/失败时）为 `''`                                                                  |
| `status`              | enum              | `draft`\|`in_progress`\|`completed`\|`cancelled`                                                                                                                         |
| `agenda`              | string[]          | 组织者从 `goal` 分解出的有序子话题；未设置议程时为 `[]`                                                                                                                  |
| `agendaIndex`         | integer           | 当前子话题的从 0 开始的索引（`0..agenda.length`）；`=== agenda.length` ⇒ 所有子话题已完成                                                                                |
| `participantAgentIds` | string[]          | 创建时选定要参与的智能体；编排器仅从该集合中提名（∪ 始终包含的组织者）。`[]` = 未设置/旧数据 ⇒ 回退到整个已启用智能体名单。持久化为 JSON 数组（`participant_agent_ids`） |
| `conclusion`          | text \| null      | 已得出的结论；引擎写入之前为 `null`                                                                                                                                      |
| `createdAt`           | timestamp         | 创建时间                                                                                                                                                                 |
| `updatedAt`           | timestamp         | 最后一次变更时间（由状态/结论变化以及追加消息触发更新）                                                                                                                  |
| `completedAt`         | timestamp \| null | 状态进入 `completed` 的时间；转为 `completed` 时打上时间戳，离开该状态时清空（null）                                                                                     |

状态生命周期：`draft`（已创建，未启动）→ `in_progress`（进行中）→
`completed`（已得出结论；打上 `completedAt` 时间戳）/ `cancelled`（已放弃，终态，不打时间戳）。

关系：属于一个项目（通过 `workspacePath`）；拥有零条或多条 Discussion Message。
每个参与的智能体在 `discussion_agent_sessions` 中还可以有一条当前的厂商转录映射；
该映射被投影到 `session_metadata` 中，供统一的
Sessions 页以该讨论为所有者展示，但讨论消息仍是转录的唯一事实来源（SoT）。

## Discussion Message

讨论内的一条消息，按每讨论单调递增的序号排序。

| 属性             | 类型         | 说明                                                            |
| ---------------- | ------------ | --------------------------------------------------------------- |
| `id`             | text (UUID)  | 稳定标识符                                                      |
| `discussionId`   | text (UUID)  | 所属讨论                                                        |
| `seq`            | integer      | 每讨论单调递增的序号（从 1 开始，追加时赋值为 `MAX(seq)+1`）    |
| `speakerKind`    | enum         | `organizer`\|`agent`\|`human` —— 消息的发言者身份               |
| `speakerAgentId` | text \| null | 当 `speakerKind === 'agent'` 时为参与智能体的 id；否则为 `null` |
| `speakerName`    | text \| null | 发言者的显示名称；不适用时为 `null`                             |
| `content`        | text         | 消息正文                                                        |
| `createdAt`      | timestamp    | 创建时间                                                        |

关系：属于一个 Discussion（通过 `discussionId`）。`seq` 在同一讨论内唯一，
不同讨论之间相互独立。追加一条消息也会更新所属讨论的
`updatedAt`。
