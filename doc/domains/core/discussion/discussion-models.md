# discussion — 数据模型

实体与不变量。行为见[规格](discussion-spec.md),协作见[设计](discussion-design.md)。线上形状在[共享协议](../../../shared/api-conventions/websocket-protocol.md)中定义,此处不重复。

## Discussion

一场限定在单个工作区的目标导向圆桌:类型、目标、背景、参与者、议程与结论。身份是稳定 id;作用域是不可变的工作区名称。

不变量:

- 状态为 `draft` | `in_progress` | `completed` | `cancelled`。进入 `completed` 打完成时间; `cancelled` 不打。`cancelled` 与 `completed` 都是终态,只有后者可开新一轮。
- 类型来自目录 `brainstorm` / `decision` / `review` / `planning` / `retro`。
- 用户上下文与调研结果分存;调研只替换自己那一份。
- 议程是组织者从目标分解出的有序子话题,只在 `discuss` 有意义;无议程时行为与未分解相同。
- 业务标注是调用方扁平键值,仅工具启动编排时整体替换;缺省为空。随 `discussion:start` / `discussion:end` 发出,描述的是一次编排尝试,不是唯一状态跃迁。
- 零或多条 Message;至多一个指定组织者;零或多个 Participant。研究会话若已绑定,以讨论为所有者投影,不属于任何参与者。

## Message

圆桌内一条已落账的发言,按讨论内单调递增序号排列。发言者身份为 `organizer` | `agent` | `human`。

不变量:

- 序号在同一讨论内唯一,讨论之间相互独立。追加即更新讨论的最近变更时间。
- `agent` 才带智能体 id;组织者与人类轮次不带厂商标签。
- 派发中的「正在回复」与调研过程流不是消息行,不进账本。

## Participant

创建时勾选、编排时提名的智能体。组织者是其中的主持角色,始终在场。

不变量:

- 集合在创建时固定;空集合表示未设置,回退到已启用池。
- 组织者即使未勾选也并入。提名不得越出该集合。
- 每个参与者可有一条当前厂商会话,供后续轮次恢复;关闭讨论即丢掉映射。研究会话不占用参与者槽。
