# session-registry — 设计

实现 [spec](session-registry-spec.md)。它由一个持久化关注点(磁盘上的 registry)、
一个会话枚举/IO 关注点(厂商会话 API 加 transcript 映射),以及 WS
处理器(每连接的活跃会话加事件分发)构建而成。

## 职责

| 关注点            | 说明                                                           |
| ----------------- | -------------------------------------------------------------- |
| 持久化 registry   | 模块级缓存;原子写(临时文件 + rename);故障软化(fail-soft)       |
| 厂商会话枚举/IO   | 列表 / 加载历史 / 重命名 / 删除                                |
| 已查看会话 + 分发 | 每连接的已查看会话;每会话模式存于 runtime 上                   |
| Session runtimes  | 每会话的运行/缓冲/状态/team 标志(agent-session,ADR 0006/0008） |

## 持久化

- 位置:`${CLAUDE_CONFIG_DIR:-~/.claude}/c3/state.json`。
- 惰性加载到模块缓存中;每次变更都会同步持久化。
- **原子写:** 写入一个进程级临时文件,然后原子地 rename 覆盖目标文件。
- **故障软化:** 文件缺失/损坏(或写入出错)会回退到空状态并记录日志;
  c3 仍必须能启动(ADR 0004,AVAIL）。
- 添加工作区会校验路径是一个目录(SR-R1)且是幂等的;选择/创建
  会推高 `lastAccessed`(SR-R3);列出时返回按 `lastAccessed` 降序排序的副本。

## 会话 IO

厂商会话 API 支撑四种 registry 操作:

| 操作               | 对应到                                           |
| ------------------ | ------------------------------------------------ |
| 列出某工作区的会话 | 会话条目 + 每会话模式,最新优先                   |
| 加载某会话的历史   | Transcript 条目(见映射)                          |
| 移除一个会话       | 删除 transcript + 去掉该会话的 tool-session 标记 |
| 重命名一个会话     | ——                                               |

**统一投影列表(ADR-0013,2026-06-28 修订）。** 线上
`list_sessions` 路径读取 c3.db 中的 `session_metadata` 投影缓存,
而不是在每次读取时直接枚举厂商存储。该投影是一个可重建的缓存 ——
按厂商的枚举访问器是 work 会话的重建/惰性校验来源,而不是日常读取来源。读取
路径按工作区和 `session_kind` 查询,过滤到 `bound = 1`,把每一
行映射为一个会话条目(新增的 `state`、`sessionKind`、`ownerKind`、`ownerId`、
`bound` 字段),对 work 列表应用隐藏集与已记录 tool-session 的过滤,
并按最新优先排序。会话页面的六个标签页(work / intent / spec / discussion / automation /
tool)以及运行计数徽章都使用同一个投影。work、intent、spec、discussion、automation
都是活的读模型行;tool 在其域写入方接入之前仍是最后的占位符。spec 行由 intent-management 的
spec 生命周期在绑定时写入,使用

`session_kind='spec'` 与一个 intent 所有者,因此选中它们会跳回到所属 intent 的
spec-会话标签页,而不是把它们作为普通 work 会话打开。discussion 行由
discussion agent-session 生命周期在创建参与者/组织者厂商会话时写入,使用
`session_kind='discussion'`、`owner_kind='discussion'`,以及该 discussion 的 id 作为所有者;选中
它们会跳回所属 discussion,会话列表会对它们隐藏重命名/删除操作。
仅限 work 的绑定前行
用 `bound = 0` 表示;遗留的 `kind` 列被保留,但不再驱动读取
行为。

对于 work 列表,读取路径在映射前会过滤掉两类会话:项目的
**隐藏集**(由 intent-management 拥有的 intent/spec 通信会话)以及**工具创建的
会话**(completion judge / consensus advisor),除非启用了 show-tool-sessions 设置。
intent 和 spec 标签页对自身不应用该隐藏集过滤。tool 标签页本身也
受同一个 show-tool-sessions 设置的门控;关闭时,服务端不返回 tool 行/计数,
客户端保持该标签页禁用。

Tool 会话在某次工具查询上报其会话 id 时被打标,该操作会写透到
持久化的 `tool_sessions` 表,使该标记 —— 从而使默认关闭的过滤 —— 能在重启后存活。
同一次注册会尽力更新插入(best-effort upsert)`session_metadata(session_kind='tool')`,携带该
工具智能体、工作区、标题回退值和可选的所有者。所有者字段是唯一的
反向链接来源:`tool_sessions` 仍是一张标记表,不会新增 `origin_kind` / `origin_id`。一条
带有所有者元数据的 tool 行会获得一个使用与 work/spec 行相同的基于所有者的解析器的来源跳转动作;
无所有者的行仍会被列出,但没有跳转动作。历史遗留的仅标记行
可以从原生工作区扫描重建为无所有者的 tool 投影。

Transcript 映射镜像了 agent-session 中的实时映射,以便重放的历史渲染
一致:assistant text / tool-use 映射到 assistant / tool-use 条目;user
string/text / tool-result 映射到 user / tool-result 条目(tool-result 内容压平为文本)。

## 每连接状态

每个连接都跟踪它正在查看的会话(真实或 `pending:`）。
工作目录与每会话模式从已查看会话的 runtime 中读取,而不是
连接字段。`set_mode` 更新 runtime 的模式,为真实会话持久化它(pending
在绑定时持久化),把它推送给正在运行的进行中的运行(如果有的话),并以 `mode_changed` 确认(SR-R5）。
持久化的 `activeSessionId` 会在选择/绑定时更新,作为重启提示。

## Pending-session 绑定

```mermaid
sequenceDiagram
    participant UI
    participant WS as Server
    participant RUN as Agent run
    UI->>WS: create_session(ws)
    WS->>UI: session_selected (sessionId=pending:…, history=[])
    UI->>WS: user_prompt(text)
    WS->>RUN: start run (cwd, no resume id, mode from runtime)
    RUN-->>WS: reports real session id (from the run's init)
    WS->>WS: bind pending→realId; persist mode + activeSessionId; viewed=realId
    WS->>UI: session_started(clientId=pending:…, sessionId=realId)
    Note over WS,UI: on run end → sessions list refreshed (real title)
```

绑定会重新为 runtime 定键(缓冲区/查看者/运行随之移动)。对
已存在会话的 `select_session` 会把其 id 作为 resume id 传入;运行会上报同一个 id,因此不会发生
rebind(rebind 的守卫条件是上报的 id 与 runtime 的 id 不同)。

## 切换与并发

切换是一次**查看**变更,而不是运行变更。`create_session` 与 `select_session`
把连接的查看者从旧会话切换到新会话,并重放新会话的
记录;它们**绝不**会中止一次运行(ADR 0006,AS-R8）。许多会话可并发运行;单个
会话是串行的 —— 当一个 turn 已在进行时,对该会话的 `user_prompt` 会返回一个
`error`(AS-R2）。`user_prompt` 要求存在一个已查看会话;否则返回 `error`。

## Team 会话状态

一个 runtime 携带一个 team 标志(默认关闭),在一次运行使用 team 工具时被置位,在
该运行拆除时被重置(agent-session,ADR 0008）。它会改变状态语义:`turn_end` 通常
隐含 idle,但当 team 标志被置位时,隐含的 idle 会被覆盖为 team 状态。
所以一个 team lead 的 `turn_end` 上报的是 team,而不是 idle —— lead 进程在多个 turn 之间是存活的,
而不是空闲的。一个 team 会话的下一次 `user_prompt` 会被推入正在运行的运行,而不是启动
一次新的运行(AS-R17,agent-session design § Team sessions）。

## `turn_end` → idle 会被保留直到拆除完成

正常的完成路径从运行循环**内部**发出其 `turn_end`,因此该运行的拆除
(会清除运行指针)此时尚未发生。如果状态在那一刻就落定为 idle,
就会在运行仍存活时广播 idle。客户端纯粹从
广播状态推导"正在运行"(§ 客户端侧对账)。它会看到 running→idle 的转换,并冲刷
其**待发送队列**,把它作为一个新的 `user_prompt` 发出,而服务端随即会以"一个 turn 已经
在运行"(AS-R2)拒绝它 —— 悄无声息地丢弃了排队的提示。拆除的间隙是整个
智能体查询收尾过程(输入关闭 → 迭代器结束),历时数十到数百毫秒,因此该冲刷可靠地
赢得这场竞态。

因此状态层会在运行指针仍存活期间**保留** `turn_end` 隐含的 idle,
保持当前状态直到运行真正拆除完毕。终态兜底随后会在拆除步骤中
重新落定为 idle —— 这发生在**运行指针被清除之后** —— 从而使广播的
idle 与服务端接受新 `user_prompt` 的就绪状态保持一致,冲刷的提示
落在一个真正就绪的会话上。这对完整与出错两种 `turn_end` 都成立。idle 覆盖的
优先级:一个未应答的权限提示(→ awaiting-permission,共识窗口
守卫)优先于 team 保留(→ team),team 保留又优先于运行存活保留(→ 不变)。
`turn_end` **线上事件**仍会照常送达查看者 —— 只是不再提前把状态驱动为
idle。

## 终态保证

客户端的"正在运行"/"思考中"纯粹从广播状态推导,所以一个从未广播其结束的
turn 会让查看者卡住(以及其待发送队列不被冲刷)。正常的
结束信号是智能体的 result → `turn_end`(agent-session）。但运行循环也可能在
**没有** result 的情况下结束:智能体迭代器结束,或 Claude 进程在 turn 中途退出。此时既不是
result 分支也不是 error 处理器被触发,因此没有 `turn_end` 送达查看者。

一个**终态兜底**会从服务端的运行拆除中运行(在运行指针
被清除、team 标志被重置、待发送内容被清空之后)。它会:

- **当且仅当**本 turn 未广播过任何 `turn_end` 时,合成一个原因为 `complete` 的 `turn_end`,然后
- **无条件地**将会话落定为 idle(不再仅在运行被中止时才这样做)。

幂等性依靠每个 runtime 的"已见 turn-end"标志:该标志在任何 `turn_end` 上被置位,并在
turn 开始时被重新武装为 false。因此一次正常完成的运行只会得到 idle 落定(不会
重复的 `turn_end`),而一次未产生 result 就结束的循环则会得到一个合成的 turn_end。
运行循环层出于防御目的携带同样的保证:其拆除会在迭代器
在没有 result 的情况下结束时(非 team、非中止)发出一个终态 `turn_end`,从而使
两层保持一致,且 saw-turn-end / saw-result 标志防止了重复发出。

## Session 层心跳与存活对账

除了(上文的)边沿触发的状态广播之外,服务端还运行一个**周期性
心跳**(每 15 秒一次),它会:

1. 在广播之前先通过一次存活对账扫描来**清理陈旧/挂起的运行**,从而使
   快照始终权威,然后
2. **无条件地广播** `session_status` 给所有连接,使得一个错过了事件驱动
   广播的客户端(重连竞态、后台标签页、丢帧)在一个
   心跳周期内自我修正。

### 存活对账扫描

对每一个仍有存活运行指针的 runtime:

- **中止分支:** 该运行的中止信号已被置位 → 该运行被请求停止,但其
  拆除从未运行(僵尸)。**不论**状态如何都进行收敛 —— 这是唯一能收敛
  awaiting-permission 和 team 会话的路径。
- **陈旧分支:** 状态为 running,且已超过陈旧阈值的时长没有发出过任何事件
  → 智能体迭代器/循环被判定为挂起,或 Claude 进程在 turn 中途退出。
  收敛到 idle。
- **悬空指针分支:** 状态为 idle,而运行指针仍然存活 → 一次状态/运行
  不一致。其主要成因 —— 一次正常的 `turn_end` 在拆除清除运行指针之前
  就把状态落定为 idle —— 现已在源头被阻止(见 § `turn_end` → idle 会被保留直到拆除完成),因此这
  是针对任何残留路径(在运行指针仍存活时把状态落定为 idle)的一个**防御性兜底**。
  否则广播会一边宣称会话处于 idle,一边让 `user_prompt` 仍以
  "一个 turn 已在运行"被拒绝;陈旧分支(以 running 为门控)永远不会清理它。收敛以使
  客户端与服务端达成一致。
- **保留:** awaiting-permission 和 team 状态**不会**仅因陈旧而被收敛 —— 一个
  正在等待提示的用户是合法的,一个在多个 turn 之间等待的 team lead 也是合法的。

收敛过程模仿了运行启动器的拆除逻辑:

1. 中止该运行(即使已被中止也是安全的)
2. 清除运行指针
3. 重置 team 标志;清空待发送内容
4. 运行终态兜底 —— 合成一个 `turn_end`(如需要)、落定为 idle,并
   触发一次状态变更重新广播。

陈旧阈值默认是 5 分钟 —— 足够保守,以避免对不发出任何中间事件的
长时间运行工具(构建、部署)产生误判。

### 客户端侧对账

客户端在三种触发条件下拉取权威快照:

- **周期性** —— 一个 15 秒的间隔发送 `request_session_status`。
- **可见性恢复** —— 变为可见时发送 `request_session_status`。
- **重连** —— 一次 socket 重新打开时发送 `request_session_status`。

收到 `session_status` 后,客户端对本地
会话状态映射做一次**整表替换**,并触发一个电平触发的冲刷兜底。本地陈旧状态与
服务端快照之间的任何差异,都会在下一次到达时被纠正。

传输层的 ping/pong 保持不变 —— 它只探测 socket 是否半开。Session
层心跳是一个独立的关注点。

## 非功能性考量

- **只有元数据被持久化** —— 从不持久化权限状态(SR-R11,ADR 0001/0004）。
- **最近访问顺序**是工作区的排序方式;会话按 SDK 的 `lastModified` 排序。
- **`sessionModes` 中的陈旧 id** 是无害的,读取时会被忽略。

## 依赖

- **Claude Agent SDK** —— 会话枚举、历史、重命名、删除。
- **agent-session** —— 接收工作目录 / resume id / 模式;在一次运行上报其会话 id 时,回收绑定的 `sessionId`。
- **Node 文件系统 API** —— 配置目录下的原子 JSON 持久化。
