# Domain: agent-session

- **Group:** core
- **One-line:** 通过 vendor 中立适配层驱动智能体运行,把不同运行时的消息与控制映射到统一协议。
- **Owner:** maintainer
- **Status:** active
- **Depends on:** vendor adapter 与宿主 CLI;[permission-gateway](permission-gateway.md)(工具门控);[session-registry](session-registry.md)(工作目录、每会话模式、resume)。
- **Depended on by:** [web-console](web-console.md)(消费线事件);intent-management、automations、im-robot(复用同一套运行时)。
- **exposes-api:** true — WebSocket `/ws`。消息形状在[共享协议](../../shared/api-conventions/websocket-protocol.md)中定义。
- **ADRs:** [0006](../../architecture/adr/0006-decouple-runs-from-connections.md) 运行与连接解耦、[0008](../../architecture/adr/0008-streaming-input-for-agent-teams.md) 流式输入、[0011](../../architecture/adr/0011-vendor-neutral-agent-abstraction.md) 厂商中立抽象、[0012](../../architecture/adr/0012-host-binary-probe-first-capability-gate.md) 宿主二进制门控、[0015](../../architecture/adr/0015-session-agent-binding-vendor-ownership.md) 会话归属、[0040](../../architecture/adr/0040-cursor-as-host-cli-vendor.md) Cursor 非托管宿主 CLI

## Overview

一个 agent session 把用户 prompt 变成一次由 vendor adapter 驱动的智能体运行:流式给出活动,按该 vendor 的能力把敏感工具交给 [permission-gateway](permission-gateway.md),并用权限模式与运行控制引导这次运行。

运行不绑定启动它的浏览器连接。每个会话有一个进程范围的 **Session Runtime**;连接只是当前观察哪个会话的**视图**。切换视图或关闭 socket 不会停止运行,返回的视图回放已发生的一切([ADR 0006](../../architecture/adr/0006-decouple-runs-from-connections.md))。不同会话并发、无固定上限;单个会话串行(一次一个 turn)——持久化的 **agent team** 除外,其 lead 在 turn 之间保持存活,用户可继续推入 turn。

运行的工作目录、起始权限模式与 resume id 由 runtime 持有,由 [session-registry](session-registry.md) 播种。

**范围:** 运行生命周期、后台执行与回放、权限模式契约、会话连续性、agent-team、实时状态、把厂商消息译为线事件的规则。**边界:** 不决定个别权限(gateway)、不管理工作区/会话目录(session-registry)、不渲染 UI(web-console)。

## Business rules

- **AS-R1**: `user_prompt` 针对所观察会话的 runtime 启动一次 Agent Run,带上该会话的工作目录、权限模式,以及对既有会话的 resume id。prompt 作为 `user_text` 回显,供所有 viewer 与回放看见。回显只含可见 turn 内容(用户输入与交给模型的业务上下文);内部系统指令走系统上下文,不进回显。slash-command 开发技能是唯一必须随模型用户 turn 展开的内部载体,同样排除在回显之外。
- **AS-R2**: 会话串行:每个会话最多一个进行中的 Agent Run。turn 进行中时,针对该会话的 `user_prompt` 以 `error` 拒绝且不启动任何东西。不同会话并发,无固定上限。
- **AS-R3**: 权限模式按会话(runtime 拥有,镜像到 session-registry)。运行以该会话的模式启动;`set_mode` 只改变所观察会话的模式。
- **AS-R4**: `set_mode` 更新该会话记住的模式,并以 `mode_changed` 确认。若厂商支持运行中途改模式且有在途运行,立即应用到该 run;否则下次运行才生效。
- **AS-R5**: 模式(经目录落到网格)决定哪些工具调用敏感从而抵达 gateway。全自动执行授权所有工具;自动接受编辑只覆盖 edit 类;其余按该厂商分类器把敏感调用交给 gateway。不具备逐工具审批的厂商把门控落在启动策略上,回合内不再询问。
- **AS-R6**: 运行只能被 `stop_run`(所观察会话)、`delete_session` 或 `remove_workspace` 停止,从不因切换视图或关闭 socket 而停止。已结束或尚未开始流式传输的运行,中止是无害的。
- **AS-R7**: 一次运行以恰好一个终止性 `turn_end` 结束:`reason: 'complete'`(厂商给出结果,或运行被停止)或 `reason: 'error'`。`turn_end` 不结束会话。
- **AS-R8**: 关闭连接只取消该视图的订阅;运行在 runtime 中于后台继续。重连并选择该会话则回放完整记录并恢复实时投递。以稳定 `c3SessionId` 选择时,必须解析到厂商原生 runtime 再回放并挂接 viewer,`session_selected` 仍携带原 `c3SessionId`;不得用公开 id 另建一个与在跑 runtime 分离的冷会话。
- **AS-R9**: 只有模型文本、tool-use 与 tool-result 映射到线协议;其余厂商消息种类忽略。整 turn 只有思考、没有任何可见文本或工具时,在 `turn_end` 之前发一条 `notice`,以免看起来像卡住。
- **AS-R10**: 运行报告厂商 session id,使 pending 会话绑定到真实 id,后续 prompt 经 resume 继续。绑定重新键入 runtime(buffer、viewers、run 随之移动);恢复的运行保持同一 id。绑定同时冻结 session→agent 的 **vendor**(agent-config AC-R16,[ADR 0015](../../architecture/adr/0015-session-agent-binding-vendor-ownership.md)):转录只存在于该厂商原生存储,vendor 之后不能改。
- **AS-R11**: 每个实时事件追加到 runtime 的 buffer,并分发给当前 viewers。加入的视图先回放 baseline(创建时的磁盘快照)再回放 buffer,完整且不重复。
- **AS-R12**: runtime 状态为 `idle`、`running`、`awaiting_permission`、`team` 或 `reconnecting`。任何变更向所有连接广播 `session_status`。
- **AS-R13**: 需要运行中途控制(改模式、中止)或让进程比单次结果活得更久的运行,以**流式输入**驱动,而不是一次性字符串([ADR 0008](../../architecture/adr/0008-streaming-input-for-agent-teams.md))。
- **AS-R14**: 当第一个 **team 工具**被使用时,runtime 标记为 `team` 一次,并发出 `team_upgraded`。team 工具是 `TeamCreate`、`SendMessage`,或后台 `Agent`;前台 `Agent` 不是。检测发生在该 turn 的结果之前。
- **AS-R15**: 结果到达时发出 `turn_end { reason: 'complete' }`。非 team 运行随后结束其输入,底层进程退出,下一 prompt 恢复全新进程。team 运行保持输入打开,lead 在 turn 之间存活,状态保持 `team` 而非 `idle`。
- **AS-R16**: team 会话只在用户明确停止(`stop_run` / `delete_session` / `remove_workspace`)时结束。没有自动拆除;「lead 已完成」等同于用户停止。
- **AS-R17**: 会话处于 `team` 时,`user_prompt` 不被拒绝也不启动第二个运行:回显为 `user_text`,并作为下一用户 turn 推入存活的 lead(不 resume、不新建进程)。非 team 会话仍遵守 AS-R2。
- **AS-R18**: 普通用户会话的 turn 若因传输层断开失败,且与降级链分类分离(一次断线从不进入降级候选),则在有界退避后对**同一个**运行自动 resume **一次**,以保留上下文。退避期间状态为 `reconnecting`。成功则该 `turn_end` 携带 `reconnect_attempted`。被拒绝(AS-R19)、被设置关闭、没有真实 session id、会话是 team/intent、或该 turn 已用过一次时,以 `turn_end { reason: 'error' }` 结束并回到 `idle`,由用户手动继续。从不静默挂起。
- **AS-R19**: 自动 resume 的守卫是工具副作用:断线时若仍有未闭合的 side-effect 类 `tool_use`,则 `side_effect_pending` 为真,自动 resume 拒绝。分类保守——明确的只读/检索/问答视为无副作用;写入、执行、未知与 MCP 一律视为有副作用。宁可错过自动 resume,也不在可能的写入之后自动续跑。
- **AS-R20**: Claude 子进程获得一组最低优先级的传输 keepalive 默认值,以降低断线发生率;用户或 agent 显式环境覆盖优先。这与自动 resume 解耦,不改变 resume/门控逻辑。
- **AS-R21**: 只有具备流式推入能力的厂商才能成为 agent-team lead;目前只有 Claude。非 Claude 会话不会被标为 `team`。
- **AS-R22**: 降级链只保留与当前 agent **相同厂商**的条目;跨厂商条目跳过、从不启动。同厂商降级每次尝试都是全新会话,从不 resume。被跳过的条目在链耗尽时经 `all_agents_failed` 呈现。
- **AS-R23**: 用户可以把会话改绑到另一个**同厂商** agent(`set_session_agent`),不丢上下文。候选与降级链、共识投票者共用同一条同厂商规则;跨厂商拒绝,事实不变。切换只改绑定,不立即重跑——下一 `user_prompt` 用新 agent resume 同一次运行。
- **AS-R25**: 降级链在内核事件总线上发布 `agent-error` / `agent-fallback` / `agent-all-failed`,供其他域订阅,不取代线上的 `agent_failed` / `all_agents_failed` 与运行循环([ADR 0018](../../architecture/adr/0018-event-bus-kernel-layer.md))。

## States

### Session Runtime(进程范围,按会话)

```mermaid
stateDiagram-v2
    [*] --> Idle: runtime created
    Idle --> Running: user_prompt
    Running --> AwaitingPermission: permission_request
    AwaitingPermission --> Running: decision resolved
    Running --> Idle: turn_end or stop_run
    AwaitingPermission --> Idle: stop_run
    Running --> Reconnecting: socket disconnect, gate clear
    Reconnecting --> Running: single auto-resume
    Reconnecting --> Idle: stop_run during backoff
    Running --> Idle: auto-resume refused or exhausted
    Running --> Team: team tool used
    Team --> Team: turn_end / user_prompt push
    Team --> Running: user_prompt resumes a lead turn
    Team --> AwaitingPermission: permission_request
    Team --> Idle: stop_run only
    Idle --> [*]: delete_session / remove_workspace
```

切换视图和关闭连接不改变 runtime 状态。

### Connection View

```mermaid
stateDiagram-v2
    [*] --> None: connection open
    None --> Viewing: create_session / select_session
    Viewing --> Viewing: select other
    Viewing --> [*]: connection close
```

### Agent Run

```mermaid
stateDiagram-v2
    [*] --> Streaming: run started
    Streaming --> Streaming: assistant_text / tool_use / tool_result / permission_request
    Streaming --> Streaming: result while team
    Streaming --> Complete: vendor result (non-team)
    Streaming --> Errored: exception
    Streaming --> Stopped: stop_run / delete / workspace removal
    Complete --> [*]
    Errored --> [*]
    Stopped --> [*]
```

## Permission modes

线/UI 携带厂商原生模式 token,经该厂商的模式目录解释为中立网格 `ActionMode(plan | build) × ToolGate`([ADR 0011](../../architecture/adr/0011-vendor-neutral-agent-abstraction.md))。Claude 的 `default` / `auto` / `plan` / `acceptEdits` / `bypassPermissions` 是该厂商自己的目录,不是所有厂商的公共枚举。

- 升级到更宽松的门控(含全自动执行)只能通过一次明确、可观察的 UI 操作。
- Codex 与 Cursor 没有逐工具审批;门控是启动时的沙箱与审批策略。Codex 的无沙箱必须有用户显式授权,缺标记则降为工作区可写;`build × never-ask` 不等于无沙箱。
- Codex 规格运行必须把可写根限制在集中化 specs 目录;边界建不成则启动失败,不回落到项目可写目录。
- Codex 沙箱读不到宿主密钥链:启动时若环境尚未提供 GitHub 令牌,则注入宿主 `gh` 令牌,已有则不覆盖。

具体哪些工具算敏感,由该厂商运行时拥有;c3 选择模式并呈现门控。

## 厂商中立映射规则

- 适配器把厂商消息译为规范信封;线协议只增加 `vendor` 维度,不增加按厂商的 schema([ADR 0013](../../architecture/adr/0013-canonical-envelope-on-wire-c3-session-namespace.md))。
- 块以(会话, 块 id)为键原地修订,而不是堆叠;工具返回折入对应 tool-use。
- 审批请求不进入信封,走 permission-gateway。厂商规则引擎自动允许的调用只打 pre-approved 审计标记,不构成第二条决策通道。
- 会话对外以不透明 `c3SessionId` 寻址;原生存储仍是转录事实来源,c3 不双写。

## 宿主 CLI

厂商宿主 CLI 必须可解析,否则该 agent 类型不可用,以明确错误呈现,不默默挂起([ADR 0012](../../architecture/adr/0012-host-binary-probe-first-capability-gate.md))。Cursor 由厂商安装器分发,不由 c3 托管([ADR 0040](../../architecture/adr/0040-cursor-as-host-cli-vendor.md));其相对 Claude/Codex 的能力边界见 [Cursor](#cursor-能力边界)。Codex 一轮结束后回收本轮子进程树;续跑遇残留写锁时,仅在能证明占用者是本轮残留才自动回收并重试一次。见 [Codex 适配边界](../../architecture/codex-sdk-guide.md)。

## Domain events

发出 `mode_changed`、`user_text`、`assistant_text`、`tool_use`、`tool_result`、`turn_end`、`team_upgraded`、`session_status`;消费 `user_prompt`、`set_mode`、`stop_run`、`set_session_agent`、`ping`。代表 gateway 转发 `permission_request`。向 session-registry 报告运行的厂商 session id。工作区/会话目录事件属于 session-registry。形状见[共享协议](../../shared/api-conventions/websocket-protocol.md)。

## 数据模型

### Session Runtime

进程范围内某个会话执行的所有者,按会话键跨连接共享([ADR 0006](../../architecture/adr/0006-decouple-runs-from-connections.md))。

不变量:

- 每个 runtime 至多一个进行中的 Agent Run。
- 连接关闭后仍存活;只在 `delete_session` / `remove_workspace` 时销毁。
- pending 绑定到真实 id 时,回放缓冲、viewers 与在途 run 一起迁移。
- 工作目录与权限模式由它持有;session-registry 播种并镜像模式。
- 状态为 `idle` | `running` | `awaiting_permission` | `team` | `reconnecting`。
- 会话种类(work / intent / spec / discussion / automation / tool 等)只作路由标记;runtime 仍是实时执行的事实来源。
- 非空闲状态、pending 绑定与销毁同步写入进程内活动状态注册表。注册表保存当前活动，不改写本域或其它域的持久业务状态（[ADR 0050](../../architecture/adr/0050-activity-registry-as-current-state.md)）。

回放由创建时的磁盘 baseline 加上此后每一条线事件的 buffer 组成。Viewers 是当前观察该会话的连接。

### Connection View

一个 WebSocket 连接对其当前观察会话的订阅,不是运行的所有者。

切换时退订旧的、订阅新的;关闭时只退订。所有存活连接还接收 `session_status` 广播。

### Agent Run

由一个用户 prompt 驱动的一次厂商运行。

状态: Streaming → Complete | Errored | Stopped。team 运行上,一次结果结束该 **turn** 而不结束该 **run**。敏感工具经 permission-gateway 门控。

### Run Handle

运行进行中才存在的实时控制:在厂商支持时把新权限模式应用到在途 run;把下一用户 turn 推入存活的 team 会话。运行结束则消失。

### Permission mode

厂商原生 token,经该厂商模式目录解释为中立网格。语义见[规格 § Permission modes](#permission-modes);线形状见[共享协议](../../shared/api-conventions/websocket-protocol.md)。

## 协作

**session-registry** 播种工作目录、每会话模式与 resume id。本域拥有进程级 Session Runtime:运行句柄、回放用的 baseline + buffer、当前 viewers 与状态([ADR 0006](../../architecture/adr/0006-decouple-runs-from-connections.md))。pending→真实 id 绑定时,buffer、viewers 与在途 run 一起搬到新键上，活动注册表上的同一条事实也原子迁移。公开 `c3SessionId` 必须解析到同一原生 runtime,不能另开冷会话。

**活动状态注册表** 镜像本域的实时活动:开始、权限等待、team parked、落定与删除。它不是第二份 Runtime，也不能替代事件总线；当前活动从这里查询，并必须能从 Runtime 与在途自动化执行重建。**角标投影**从这些活动事实维护 Workspace、种类与 owner 集合，并从权限登记表、待办台账与交付判定维护三类 attention 集合。WebSocket 在握手后下发可见工作区的活动快照，投影变化时推送带 revision 的增量；服务端低频对账在摘要未变时不推送。会话计数入口仍可读投影并映射到 `session_counts`（[ADR 0051](../../architecture/adr/0051-badge-projection-from-activity-sets.md)、[ADR 0052](../../architecture/adr/0052-attention-sets-in-badge-projection.md)、[ADR 0053](../../architecture/adr/0053-activity-snapshot-delta-protocol.md)、[ADR 0054](../../architecture/adr/0054-converge-activity-badge-polling.md)）。

**permission-gateway** 是敏感工具的阻塞点。具备逐工具审批的厂商(Claude)在回合内把调用交给网关;不具备的厂商(Codex、Cursor)把门控落在启动策略上,审批桥不触发。待决请求跟 run 走,不跟连接走。

**vendor adapter** 是三件套:driver(启动、消息流、中止)、审批桥、会话存储([ADR 0011](../../architecture/adr/0011-vendor-neutral-agent-abstraction.md))。上层先看能力台账再碰有分歧的控制,不按厂商名分支。Claude 独有流式推入与 team;Cursor 的独有边界见 [Cursor](#cursor-能力边界)。

**agent-config** 提供启动覆盖与同厂商候选。降级链与手动切换共用那条同厂商规则;失败在内核事件总线上旁路发布,供 automations 等订阅,不插入运行循环。

**web-console** 是视图。服务端对非 team 会话严格执行单 turn;控制台用客户端排队向用户隐藏这次拒绝。图片附件可进入各厂商路径;非图片媒体整 turn 拒绝。Cursor 不接受图片,见 [Cursor 能力边界](#cursor-能力边界)。

## 关键取舍

**运行活在进程里,不活在连接上。** 切走或刷新必须能回到同一条流。代价是 runtime 占用进程内存、暂无淘汰;当前规模可接受。

**流式输入,而不是一次性字符串。** 字符串 prompt 在结果到达时结束进程,team lead 会在队友回来之前死去,运行中途的改模式与中止也会被吞掉。统一用流式输入:非 team 在结果处关掉输入,复现一次性退出;team 保持打开,只在明确停止时关闭([ADR 0008](../../architecture/adr/0008-streaming-input-for-agent-teams.md))。

**c3 自己的工具走回环 MCP,不走进程内通道。** 每次运行绑定一条回环 HTTP 路由,按厂商译成各自的远程 MCP 配置,结束时释放。厂商子进程必须能直达该回环;若被 HTTP 代理拐走,工具会从模型工具集里静默消失。需要长期本地 MCP 进程的厂商另有监督者(独立进程组、健康检查、有界重启);宕机是临时不可用并自我修复,不是把该厂商标死。

**宿主 CLI 是第一道能力门。** 解析不到二进制,该 agent 类型不可用,而不是运行到一半再失败([ADR 0012](../../architecture/adr/0012-host-binary-probe-first-capability-gate.md))。c3 不分发 Cursor 的 CLI([ADR 0040](../../architecture/adr/0040-cursor-as-host-cli-vendor.md))。

## 中止

停止关闭流式输入(这是结束 team 的唯一方式),并中断在途 turn。对已经结束或尚未开始流的运行,中断失败被吞掉,进程不崩溃。切换视图与关闭 socket 不走这条路径。

## 非功能

每会话至多一个在途 run;跨会话无上限。错误必须终结为可见的 `turn_end`,不得挂起。运行与权限状态驻内存,不持久化;会话连续性来自厂商转录上的 resume,工作区/会话目录由 session-registry 持久化。

## Cursor 能力边界

Cursor 与 Claude、Codex 落在同一套 driver / 审批桥 / 会话存储上([ADR 0011](../../architecture/adr/0011-vendor-neutral-agent-abstraction.md))。

### 相对 Claude / Codex

- **非托管宿主 CLI。** c3 不分发、不钉选 `cursor-agent`;只从部署覆盖与宿主 PATH 解析。找不到则该 agent 类型不可用。二进制名与 vendor 名不同,从厂商描述符读取([ADR 0012](../../architecture/adr/0012-host-binary-probe-first-capability-gate.md)、[ADR 0040](../../architecture/adr/0040-cursor-as-host-cli-vendor.md))。
- **每轮一个子进程。** 不是常驻进程。中止是整轮终止,没有回合中途 interrupt,也不能把下一 turn 推进同一个存活进程。新会话的原生 id 在运行开始前已经铸出,绑定不必等第一帧。
- **无逐工具审批。** 权限在启动时一次定死;审批桥可注册但永不触发。
- **不能做 team lead。** 没有流式推入,AS-R21 直接排除。
- **无进程内 MCP。** c3 工具只经统一的回环 HTTP MCP,不为 Cursor 另开通道。
- **会话生命周期。** resume / list / read 为完整能力:读的是 CLI 与 Cursor IDE 共写的磁盘库,该工作区里发生过的会话都在,不限于 c3 创建的。rename / delete 为无:那是用户自己的 IDE 数据,c3 不改。
- **不接受图片。** 附图丢弃并告警,不让整轮失败。
- **线上仍是整段文本。** 适配器把增量收成一块再发出,下游按「一条文本 = 一条消息」读取。
- **凭据可选。** 填了 API key 就用,留空则用 CLI 写入操作系统钥匙串的登录态。不能指向其他 provider。

可用性走覆盖全部 vendor 的中立 `vendorRuntime` 信号,控制台不按「这是 Cursor」特判。已配好的 Cursor agent 在 CLI 暂时缺失时仍保持可选,避免 UI 悄悄改掉既有配置。

### 人机问答

Cursor 原生 `AskQuestion` 是 headless 下唯一的人机决策点。c3 把它接到与 Claude `AskUserQuestion` 同一条通道:`permission_request` 加逐题作答。允许后以同一原生会话续跑把答案交还模型;拒绝或停止不续跑。这是跨子进程模拟,不是 Cursor 的原生回合内输入,能力台账上的原生用户输入仍为假。

输入必须能变成可作答的问题列表;归一化失败以可见运行错误收束,不创建不可作答的请求,也不自动续跑。未回答的问题挡住意图 resume 与自动化继续,与 Claude 侧同一条「待回答问题」事实。

### 回环 MCP

CLI 只读工作区 MCP 配置,配置根与工作根不能分开。因此一轮期间把 c3 回环 MCP 叠加进该工作区配置,结束时还原;工作区自有条目保留。同一工作区第二个 Cursor 运行拒绝启动,以免两轮互相覆盖还原。叠加内容携带本轮绑定令牌,不得进入版本库。

### 模式

三档,启动时固定,经模式目录落到中立网格:计划(plan × 敏感时询问)、默认代理(build × 敏感时由 Cursor 自己分类)、全自动(build × 不再询问)。c3 已认定该目录就是本轮工作区,不再向 CLI 确认工作区信任。

### 消费面

Cursor agent 与其他真实 agent 走同一套选择、绑定与冻结规则:同厂商可换 agent,跨厂商拒绝。讨论参与者可以是 Cursor,研究会话的组织者仍只允许 Claude。自动化同样把 Cursor 当普通 vendor,不另开通道;CLI 缺失时在分派期结清,不改 automation 的 vendor,也不跨厂商回退。

会话数据根在沙箱内外同解,否则刚跑完的会话在列表里会消失。
