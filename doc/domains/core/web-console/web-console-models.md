# web-console —— 数据模型

控制台的视图模型定义。这些是展示层实体,而非领域实体——它们只存在于浏览器中。行为方面的关联见 [web-console-design.md](web-console-design.md)。

## Chat Message

渲染流中的一项。以 `kind` 为判别字段的联合类型;每个变体都携带一个数字型 `id` 用于 key。

| kind          | 属性                                                                                  | 来源事件                                                 |
| ------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `user`        | `text`                                                                                | `user_text`(提示词回显)                                  |
| `assistant`   | `text`                                                                                | `assistant_text`                                         |
| `tool-use`    | `toolName`, `input`                                                                   | `tool_use`                                               |
| `tool-result` | `content`, `isError`                                                                  | `tool_result`                                            |
| `permission`  | `requestId`, `toolName`, `input`, `decision: 'allow' \| 'deny' \| null`, `consensus?` | `permission_request`                                     |
| `consensus`   | `toolName`, `input`, `outcome`                                                        | `consensus_auto`                                         |
| `system`      | `text`                                                                                | `turn_end{error}` / `error` / `notice`(仅思考轮次)的提示 |

关系:

- 一条 `permission` 消息通过 `requestId` 与服务端的一个 Permission Request 相关联;其
  `decision` 初始为 `null`,只会被设置一次(WC-R3)。
- 消息是只追加的,按到达顺序渲染(WC-R1)。选中某个会话会用回放历史替换整条流(WC-R9)。

## 侧边栏视图模型

镜像服务端的工作区/会话信息(共享协议);控制台渲染这些信息,并跟踪哪些工作区已展开、当前查看的是哪个会话,以及每个会话的实时状态。

| 视图模型       | 属性                                                                                                              | 来源事件                                         |
| -------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Workspace row  | path、name、last-accessed                                                                                         | `ready` / `workspaces`                           |
| Session row    | session id、title、last-modified、mode、`sessionKind`、可选的 `ownerKind`/`ownerId`、`bound`;状态徽标来自会话状态 | `sessions` / `session_status` / `session_counts` |
| Viewed session | 当前工作区、当前会话、当前标题、mode                                                                              | `session_selected` / `session_started`           |

Sessions 页面为每个 `(workspace, sessionKind)` 维护独立的分页缓存,以及一个六类运行计数映射。Owner 字段只是展示层输入:客户端用一条纯规则解析回跳目标,并不持久化或修改所有权本身。

## 任务列表(服务端派生,独立 wire 路径)

对开发会话的任务工具调用(`TaskCreate` / `TaskList` /
`TaskUpdate` / `TaskGet`)进行归一化后得到的“当前任务列表”。自 2026-06-07-009 起,它走**独立的 wire 路径**(`task_list` +
`task_created`/`task_updated`/`task_deleted`):由**服务端**派生该模型,客户端只需用这些带类型的消息填充任务模型——不再重新解析 tool-result 内容。纯归约函数(reducer)是共享任务模型中唯一的事实来源;客户端的 task-list 模块重新导出它,并自行新增两个无 DOM 依赖的纯辅助函数——展示选择器,以及应用单条 `task_*` 增量(快照替换 / 按 id upsert / 删除)的客户端 fold。服务端的派生与回放规则见[WebSocket 协议](../../../shared/api-conventions/websocket-protocol.md)(`task_*` 路径部分);客户端的消费方式见 [web-console-design.md](web-console-design.md) 的 _Task-list (wire-driven)_ 一节。

| 实体            | 属性                                                                   | 来源                                    |
| --------------- | ---------------------------------------------------------------------- | --------------------------------------- |
| Task item       | id、subject、description?、status、order、blocked-by?、blocks?、owner? | 由 `task_*` wire 消息携带(共享任务条目) |
| Task-list model | 有序的任务集合(按 order 排序;同一时刻只有一份当前列表)                 | 服务端侧的 fold,以快照形式推送          |
| Task-panel view | visible、in-progress、pending、completed(最近 N 条)、hidden-completed  | 由展示选择器派生得到                    |

Status 为 pending / in*progress / completed。Order 是原始顺序(快照索引,或增量插入时的追加顺序)。Blocked-by / blocks / owner 仅在 SDK 结果中包含时才保留。task-panel view 是任务面板消费的只读展示投影(分组 / 已完成截断 / 可见性——见 [web-console-design.md](web-console-design.md) 的 \_Task panel* 一节)。自
2026-06-07-010 起,该面板**额外受能力(capability)门控**:`settings` 消息携带按厂商划分的二进制能力台账,容器将当前生效厂商的 task-store 能力派生为一个 task-store-available 标志,当厂商不具备 task store 能力时面板即隐藏(未知能力 ⇒ 默认展开,对旧会话安全)。

## 说明

- 聊天视图模型是临时性的;刷新页面会清空它们并从服务端重新拉取(注册表本身持久化在服务端,见 ADR 0004)。
- 工具的输入与结果原样呈现给人类;控制台仅出于客户端本地的运行活动推断而解释结果内容,绝不作为权威状态。任务列表不再从 tool-result 文本推断——它通过 `task_*` wire 路径以服务端派生的形式到达。
