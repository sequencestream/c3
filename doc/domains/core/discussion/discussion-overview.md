# Domain: discussion

一个工作区范围的 **discussion**（讨论）存储：一个 discussion（由组织者、智能体与人类共同参与的目标导向对话）及其有序消息，持久化在共享的磁盘
discussion/intent 数据库中。

**状态：已上线 — 持久化 + 创建流程 + 组织者引擎 + human-in-the-loop（人机协同）。** 该领域
提供数据模型与持久化层（表 + store CRUD）、读取路径（list + open）、**创建流程**（数据驱动的类型目录，每种类型带各自的工作流、“+”表单，以及一个
只读的调研智能体，用于填充新讨论的调研结果）、**由组织者驱动的
多智能体编排循环**（`start_discussion` 在后台将 `draft` 推进到 `conclusion`，
组织者在已配置的智能体中提名发言者并驱动该类型的
工作流，每一轮是一次一次性、禁用工具的智能体回复，每条消息都以 `discussion_message` 实时流式推送），以及**human-in-the-loop 控制**：暂停/恢复正在运行的引擎，人类
在运行中插入一条 `human` 消息，以及在已结束的讨论上以一个
后续问题重新驱动一个*新一轮*（见 [design §organizer-engine](discussion-design.md#organizer-engine)）。

## 范围（现状）

- 共享数据库中的两张表（discussions 及其消息，见 [models](discussion-models.md)）。
- 一个提供 discussion CRUD + 消息追加/列表的 store（见 [design](discussion-design.md)）。
- **数据驱动的类型目录 + 工作流**：brainstorm（头脑风暴）/ decision（决策）/ review（评审）/ planning（规划）/ retro（复盘），每种
  类型都携带一个有序的 `discuss → summarize → confirm → conclude` 工作流，并带有面向组织者的阶段
  提示语。纯数据 + 纯函数，已做单元测试。
- **创建流程**：`create_discussion`（见 [protocol](../../../shared/api-conventions/websocket-protocol.md)）
  持久化一个 `draft`（标题由 `goal` 派生），**立即用 `discussion_detail`
  回复发起创建的连接**（因此右侧面板无需点击即可打开新讨论）并推送
  `discussions` 列表，随后一个**只读调研智能体** —— 一个复用 intent 读取权限集
  （read/grep/glob + web search/fetch）的调研权限闸，无 save 工具，write/exec/子智能体工具
  硬性禁用 —— 产出一份调研结果。调研输出**严格限定为仅陈述现状**：调研者收集
  相关事实 / 当前状态 / 约束 / 悬而未决的问题，且被**硬性禁止**给出任何选项、候选方案、
  建议或结论 —— 这样讨论的发散式头脑风暴就不会被预设答案预先锚定。服务端捕获
  智能体的最终文本并写入讨论的**调研结果（research-result）**字段（仅在非空时写入）；
  用户原始的**上下文（context）永不被覆盖**，因此两者共存。它在 draft 插入时推送一次 `discussions`，调研完成时再推送一次。组织者引擎在调研结果
  存在时读取它，否则读取用户的原始上下文，作为其提示语背景。调研运行是
  **可观测的**（与讨论运行镜像对应）：它会**将每一轮流式传输**为 `research_message`
  （助手文本，以及带 input 的 `tool_use` 与带 output 的 `tool_result`，与智能体流镜像对应，
  使右侧面板能以同样的标准转录形式渲染，带可折叠的工具区块），并将其**存活状态**广播为 `research_run_status`
  （智能体工作时为 `running`，完成/失败/进程死亡时为 `ended` —— 该运行会被 await，因此进程死亡也会
  最终归结为 `ended`）。调研消息**仅存在于运行时**（从不持久化到数据库），
  但服务端会保留一份有界的运行时转录，并在 `discussion_detail` 快照上重放；
  每次 `discussions` 推送也都携带一份调研状态快照（仅活跃调研）
  ，因此调研过程中的一次刷新/重连能够权威地重建调研阶段并恢复
  已展示的项目。**调研成功时服务端会自动启动编排**（等效于自动执行一次 `start_discussion`），
  通过一个纯粹的自动启动守卫、基于最新记录重新校验（状态仍为 `draft` 且没有存活的
  运行 —— 若人类在调研期间已手动 Start/取消则跳过）。调研例程返回其是否
  成功以及调研结果（输出为空则结果为空 —— 绝不返回用户的上下文）；一次
  **调研失败**会让讨论保持 `draft` 状态，回退到手动 **Start**，且不会自动启动。
- 前端：discussion-view 的“+”打开一个内联创建表单（类型下拉 / goal / context）；
  提交后右侧面板会**自动打开新讨论**（服务端 `discussion_detail` 回复）。
  右侧面板是**两阶段**的：当调研运行处于存活状态时（research-states / `research_run_status`
  → `running`）它展示**调研流**，由与工作/intent 会话相同的标准转录组件渲染
  （调研者助手气泡 + `tool_use`/`tool_result` 的可折叠工具区块，
  没有议程/派单/输入框）；当调研结束、编排
  自动启动后，它切换到**讨论流**（议程 + 转录 + 派单 + 输入框）。
  **Start** 按钮是一个手动兜底，**仅当调研已结束/中止且编排
  尚未启动**（状态为 `draft` 且调研与讨论运行均不存活）时才展示 —— 调研仍在运行时
  绝不展示 —— 取代了原来“任意 draft 都展示”的规则。阶段与按钮都会在
  刷新/重连时依据 research-states / run-states 快照重建。创建表单的 Goal / Context
  文本框会随内容**自动增高**至一个像素上限，超过上限后仅在内部滚动，
  表单关闭时重置。**左侧列表**包含：
  一个头部**折叠/展开**开关，收窄面板并隐藏次要行信息（类型 /
  时间戳）、每行一个**统一状态指示器**（`<icon> <agent>.<status>` —— 见下方的
  运行状态说明），以及一个**手风琴**（最多展开一项），在该行下方展开一个**标签栏 + 单个
  内容区**：每个非空字段一个标签（Goal / Context / **Research** /
  Conclusion，空字段丢弃），其正文以 **Markdown 渲染**（共享的经过净化的
  markdown 渲染管线），再加上一个始终存在的 **Details** 标签，携带结构化元信息（类型 /
  状态 / 创建时间 / 完成时间）。**Research** 标签展示由只读调研者写入的
  持久化调研结果（每个 draft 只运行一次，处于创建与自动启动之间）；它按
  `Goal → Context → Research → Conclusion → Details` 的顺序出现，使阅读顺序与右侧面板的
  两阶段时间线（调研流 → 讨论流）一致。当前标签在（重新）展开或切换行时
  重置为第一个有内容的标签，若一次实时更新清空了当前所选字段也会回退。**行点击是一个单一的组合动作**：
  它既发出一个 open 事件以在右侧面板加载转录 + 编排视图，_又_
  在同一手势中切换该行的内联详情手风琴（再次点击同一行会收起详情；open 保持幂等）。没有
  展开箭头，也没有逐行的“打开聊天”按钮。列表文案全部为英文。
- **定向参与者（2026-06-12，2026-06-16 更新）**：讨论的名单在**创建时选定** —— 创建
  弹窗列出已启用的智能体（默认全选；每个智能体都有一个单选按钮以指定组织者）。每个讨论持久化各自的组织者（覆盖
  工作区默认智能体）。当当前组织者智能体被取消选择时，单选会自动回退
  到下一个被选中的智能体。提交校验要求组织者已被选中且至少有一个
  非组织者智能体；不满足此约束时提交按钮禁用并显示内联错误。编排器**仅**从
  参与者集合（∪ 指定的组织者）中提名，因此
  无关的智能体不再产生噪声。空/未设置的集合（旧数据行）回退到整个
  已启用智能体池。见 discussion-design.md §Roles。
- **异构圆桌（多厂商，2026-06-06-004）**：讨论在构造上**与厂商无关** —— 组织者在
  **已选定**的参与者（已启用智能体的一个子集；见上文的“定向参与者”）中提名，其中
  可能混合多个厂商，全部归一化为同一个标准消息形状，因此
  发散的多厂商视角成为价值而非渲染分叉。每个 `agent` 气泡都携带一个**厂商标签**（每个厂商一种色相），使来源
  可辨识；厂商通过发言者的智能体 id **由智能体配置派生**，并**不持久化**
  到消息上 —— 第一阶段的厂商实际上对每个智能体是不可变的，无法解析的
  智能体不显示任何标签。`human`/`organizer` 轮次不携带厂商标签。**成本纪律：** 成本
  **绝不跨厂商合并** —— 不同厂商计量方式不同，因此任何未来的逐轮成本
  都按厂商标注，不做跨厂商求和。第一阶段**没有成本计量**（编排器的
  一次性轮次不追踪成本）；这是一条一以贯之的原则，而非已构建的界面。双色的
  批准溯源（preApproved 与 c3-gated）是 web-console 层面的关注点（WC-R20 / PG-R12），不属于
  discussion 领域。**第一阶段之外：讨论路径上没有共识、没有 agent-teams** —— 只有
  异构圆桌加基础的批准网关。
- **统一的会话页投影（2026-06-29）**：每个讨论参与者/组织者的厂商
  会话仍由 `discussion_agent_sessions`（`discussion_id` + `agent_id` → 原生会话
  id/厂商）拥有，但生命周期也会写入一条可重建的 `session_metadata` 行，带
  `session_kind='discussion'`、`owner_kind='discussion'`、`owner_id=<discussion.id>`。Sessions
  页的 Discussion 标签页与运行中徽标读取该投影；选中该行会跳回
  所属的讨论，而不是把厂商转录变成一个可编辑的工作会话。讨论
  消息与编排状态仍留在 discussion 领域中。
- **组织者引擎**：一个复用共识（consensus）一次性轮次范式的后台循环。
  组织者的轮次决策与参与者的发言解析是纯粹的、依赖注入的、
  已做单元测试的函数；该循环走过 `draft → in_progress → completed`，追加每一轮并
  将其流式推送（`discussion_message`），并写入 `conclusion`。终止性有保证
  （阶段只前进不回退，加上单阶段 + 总轮次上限）；单个已配置智能体会优雅退化
  （组织者 == 唯一参与者）。
- 复用共享的跨运行时数据库适配器（ADR 0007）以及 intent store 的软失败 +
  schema 版本号 + 幂等增量列迁移范式。
- **Human-in-the-loop 控制**（`pause_discussion` / `resume_discussion` / `discussion_speak` /
  `continue_discussion`）：引擎在每个轮次边界等待一个**暂停闸**（已暂停 ⇒ 不会产生新的
  组织者决策或智能体发言），因此可以暂停/恢复运行而不中止。人类
  可以**插话**（`discussion_speak` 暂停运行、追加一条 `human` 消息、恢复运行 —— 组织者
  会在下一轮拾取它），也可以在一个 `completed` 的讨论上**驱动新一轮**
  （`continue_discussion` 追加后续问题，将 `completed → in_progress`，并在完整转录上
  重新运行引擎以得到一个全新的 `conclusion`）。实时运行状态（`running` /
  `paused` / `ended`）以 `discussion_run_status` 广播，**与**持久化的
  讨论状态**解耦**（暂停仅存在于运行时，不持久化）。左侧列表为每一行渲染**一个统一的
  状态指示器** —— `<icon> <agent>.<status>`（一个共享的状态→图标映射 + 智能体状态拼接，
  与会话状态栏复用）：当存在存活运行时，展示运行状态（running 呈脉动，
  paused 呈静止），并以正在派发中的智能体作为 `<agent>` 段（无法解析时省略 —— 不会留下
  多余的分隔符）；否则回退到持久化的生命周期状态
  （draft / in_progress / completed / cancelled，无智能体）。这取代了原先的双重运行徽标 +
  状态胶囊，因此多个后台运行各自可见于同一个指示器中。因为
  `discussion_run_status` 只在状态转换时触发，每次 `discussions` 列表推送也都携带一份
  运行状态快照（仅活跃运行）——刷新或重连能够权威地从中协调每个
  已列出讨论的运行状态，因此一个已在后台运行的运行，即使在新（重）连接的视图上
  也能正确显示。
- **派发（进行中）状态**：在每次派发的轮次之前，引擎会通过 `discussion_dispatch_status`
  发出被提名的智能体（`speak` 一个、`broadcast` 整批），
  在该轮解决时发出 `cleared`，在抛出异常时发出 `failed`（带简要错误信息）——因此一次
  失败的回复会呈现在聊天尾部，而不是被静默吞掉，同时该轮仍会继续
  推进。聊天尾部为每个待处理智能体展示 `"<name> is replying…"`，为每个错误展示一行失败信息。仅存在于运行时（从不持久化，从不作为一条存储的消息行）并且——与运行状态不同——
  在列表上**不做**快照：它通过 `cleared`/`failed`/回复消息/运行
  `ended`/切换讨论来自愈，因此刷新/重连不会留下卡住的待处理项。

- **结论 → intent 桥接**（`discussion_to_intent`）：一个已完成讨论的
  标题栏 **Convert to Intent** 按钮会为 intent 领域播种。服务端从讨论解析出
  工作区，将 intent 领域的沟通会话作为全新会话重启（一个
  `refine_intent` 变体），其首条提示语携带讨论标题 + `conclusion`，
  并回复 `session_selected` + `intents`；随后智能体通过**未变**的
  `save_intents` 流程将其拆分为可验证的条目（见
  [intent-management RM-R7](../intent-management/intent-management-spec.md)）。若讨论
  不是 `completed` 且带非空 `conclusion`，则会被拒绝。

## 非范围（现状）

- 服务端重启后，没有**前端**对孤立的 `in_progress` 讨论（没有存活运行）的自动恢复 ——
  暂停状态仅存在于运行时且不会恢复，也没有任何 WebSocket 处理器去恢复它。
  Automation 的 LLM 执行**现在可以**通过 `continue_discussion` 这个 c3 MCP 工具显式恢复恰好这种组合
  （`in_progress` + 没有存活运行），该工具会在持久化的转录/议程上重新调用
  编排器而不追加消息
  （见 [automations-spec §c3 MCP tools](../automations/automations-spec.md)）。仍然没有
  会自动扫描并重启所有孤立讨论的机制。
- 暂停仅在轮次边界生效：一个已在进行中的一次性 `askAgentOnce` 会执行完毕
  （因此暂停请求发出后仍可能落地一条消息）。

## 索引

- [discussion-models.md](discussion-models.md) —— 实体定义（Discussion、Discussion Message）。
- [discussion-design.md](discussion-design.md) —— 持久化层（schema、迁移、store API）**以及
  组织者引擎状态机**（[§organizer-engine](discussion-design.md#organizer-engine)）。

## 依赖

- **共享数据库适配器** —— 跨运行时数据库驱动，保持在打包产物之外（ADR 0007）。
