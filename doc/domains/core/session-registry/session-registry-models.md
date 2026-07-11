# session-registry — 数据模型

以域术语给出的实体定义;物理接线见 [session-registry-design.md](session-registry-design.md)。
工作区、会话与 transcript-item 的线上形状在
[共享协议](../../../shared/api-conventions/websocket-protocol.md) 中统一定义;本域引用它们,而不是重新定义消息形状。

## Workspace(工作区)

一个已注册的项目目录。

| 属性           | 类型        | 说明                                                 |
| -------------- | ----------- | ---------------------------------------------------- |
| `path`         | text(路径） | 绝对目录;传给智能体的工作目录,也是会话枚举所依据的键 |
| `name`         | text        | 显示名称 —— 目录的 basename                          |
| `lastAccessed` | timestamp   | 此处会话最后一次被选中/创建的时间;排序键降序(SR-R2)  |

关系:一个 workspace 拥有零个或多个 Session。读侧列表来自
`session_metadata`;内容与 transcript 仍存放在原生厂商存储中。

## Session(会话)

工作区内一个由厂商托管的会话,为列表/计数读取投影到 `session_metadata` 中。

| 属性           | 类型            | 说明                                                  |
| -------------- | --------------- | ----------------------------------------------------- |
| `sessionId`    | text            | 线上不透明的 c3 会话 id;内部映射到厂商 + 原生 id      |
| `title`        | text            | 厂商自定义标题 / 摘要 / 首条提示                      |
| `lastModified` | timestamp       | 厂商最后修改时间;工作区内的排序键(SR-R4)              |
| `mode`         | permission mode | c3 跟踪的每会话权限模式;默认 `default`(SR-R5)         |
| `sessionKind`  | enum            | work / intent / spec / discussion / automation / tool |
| `ownerKind`    | enum \| null    | 用于跳回的逻辑所有者类别;无所有者会话为 null          |
| `ownerId`      | text \| null    | 逻辑所有者 id;null 表示该会话无法跳回某个所有者       |
| `bound`        | boolean         | 真实行为 true;仅当为 work 待处理占位符时为 false      |

关系:属于一个 Workspace;其 transcript 与 title 由智能体厂商拥有,其
`mode` 由 registry 拥有。所有者字段指回诸如 intent、discussion 或 automation 等域实体;
它们并不使该投影成为这些域的事实来源。一条 spec 会话行使用 `sessionKind=spec`、`ownerKind=intent`,
以及该 intent 的 id 作为 `ownerId`;intent 域仍通过 `intents.spec_session_id` 拥有当前 spec 会话链接。
一条 tool 会话行使用 `sessionKind=tool`;当触发的业务来源已知时,它复用 `ownerKind` / `ownerId` 实现跳回,
当来源未知或为历史数据时,两者都留空,使该行仅用于展示。

## Pending Session(待处理会话)

在 UI 中创建但尚未启动的会话。

| 属性       | 类型                    | 说明                                            |
| ---------- | ----------------------- | ----------------------------------------------- |
| `clientId` | text(`pending:<uuid>`） | 临时 id,直到首次运行上报真实 `sessionId`        |
| `mode`     | permission mode         | 起始为 `default`;绑定时按真实 id 持久化(SR-R7） |

关系:一旦首次运行绑定了真实会话 id,即被替换为真实的 Session。

## 持久化状态(state.json)

c3 拥有的 registry —— 唯一持久化的 c3 数据(ADR 0004）。

| 字段              | 类型                             | 说明                                |
| ----------------- | -------------------------------- | ----------------------------------- |
| `version`         | `1`                              | 模式版本                            |
| `workspaces`      | Workspace 列表                   | registry 本身(SR-R2)                |
| `sessionModes`    | 会话 id → permission mode 的映射 | 每会话模式(SR-R5）;过期 id 会被忽略 |
| `activeSessionId` | text \| null                     | 最后活跃的真实会话,用于启动时恢复   |

绝不包含权限决策或批准(SR-R11）。

## Session runtime(内存中)

每会话的运行状态由 agent-session 拥有 —— 其完整形状即
[agent-session models](../agent-session/agent-session-models.md) 中的 **Session Runtime**。registry 只负责为其
播种(工作目录 / 模式 / 基线)并读取其运行状态。注意其 team 标志
(当一次运行升级为持久化智能体团队时被设置,拆除时被重置;ADR 0008):它会把
`turn_end` 隐含的 idle 覆盖为 team 状态(见 [session-registry-design.md](session-registry-design.md) § Team 会话
状态)。绝不持久化。
