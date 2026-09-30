# intent-management — 数据模型

实体与不变量。行为见[规格](intent-management-spec.md),协作见[设计](intent-management-design.md)。线上形状在[共享协议](../../../shared/api-conventions/websocket-protocol.md)中定义,此处不重复。

## Intent

一条限定在单个工作区的台账条目:标题、正文、优先级 `P0`–`P3`、影响范围 `L1`–`L5`(可空)、状态、依赖、规格与开发回链。身份是稳定 id;作用域是不可变的工作区名称。

不变量:

- 优先级回答何时做,影响范围回答做错了波及多远,互不替代。
- 状态为 `draft` | `todo` | `in_progress` | `reviewing` | `done` | `cancelled`。`reviewing` 表示代码已提交、PR 未了结;进入 `done` 打完成时间,离开则清空。
- `specMode` 为 `sdd` | `fast` | 空(继承工作区);有效模式再受影响范围联动。规范或开发起步后不可改。
- 基准分支是落库快照,创建与关联边沿写入后不追随后续推进。
- PR 评审 / 修复结论是意图级最新快照,与规格审核、托管平台状态、生命周期各自独立。`fixed` 不等于评审通过。

零或多条依赖、PR 行、WorkNote;至多一条当前沟通会话与一条当前规格会话;可关联零或多个交付。

## Intent Dependency

同一工作区内的有向边。闸门看前序产出是否已在本意图基线上,不是看前序 PR 是否合并。批内新建可声明对同批条目的先后;已持久化的图不做环检测。

## Intent PR

一条 PR/MR,是一等事实而非意图上的几个字段。身份为托管平台 + 仓库 + 编号,全库唯一;一条已归属的 PR 不能写到另一意图上。

状态:`reviewing` | `rejected` | `failed` | `merged` | `closed`。托管状态同步进账本,不从 URL 猜测。写入只有一条路径。需要「这个意图的 PR 怎么样了」时用聚合态:未了结优先于终态,有合并优先于纯关闭。

完成不由托管平台页面推导:评审了结(免评审或结论为 `approved`,合并本身视为了结)且聚合为 `merged` 时,进行中或评审中的意图标 `done`。决策见 [ADR 0034](../../../architecture/adr/0034-intent-pr-fact-base-and-readpoints.md)、[ADR 0035](../../../architecture/adr/0035-intent-pr-table-split-and-migration-markers.md)。

## WorkNote

只增不改的工作笔记,供后续智能体阅读前序上下文。种类为 `work` | `review` | `fix`。不决定意图、PR 或评审的当前状态。物理删除意图时一并清除;取消意图保留历史。

## Communication Session

用于细化意图的隐藏智能体会话。每个工作区一组,全部不进普通会话列表;其中一个标记为默认打开。规格撰写 / 审核会话同样隐藏,只能从意图视图进入。

尚未归属任何意图的沟通会话留在项目目录;一旦归属,沟通、规格撰写、规格审核与开发共用该意图的同一工作目录,读写根仍按种类分离。

## Automation Queue

按工作区可选启用的调度。候选资格是每条意图上的 `automate` 标志。控制状态(`running` / `paused` / `idle`)持久化;单意图只持久化失败、退避与挂起,其余每轮从账本与存活运行重推。

## 派生投影

发送时从已有事实派生、不落库:`actionDescriptor`(被挡住时的下一步,只导航)、失败指引(已失败的 Git / 托管动作 + 显式重试)、评审 / 修复是否仍在途。派生不改状态或闸门。
