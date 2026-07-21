# 架构概览

## 系统形态

c3 是一个单一的本地进程，由一条 WebSocket 连接两部分组成：

```
┌────────────┐      /ws        ┌──────────────────────────────────────────────────┐
│  Browser   │ ──────────────► │  本地服务器（本进程）                             │
│  (web SPA) │ ◄─── ws ──────  │                                                  │
│            │                 │  web-console ↔ agent-session                     │
│ prompt     │                 │              ↕                                   │
│ activity   │                 │       permission-gateway                         │
│ Allow/Deny │                 │              ↕                                   │
│ mode       │                 │  vendor 中性适配器层（ADR-0011）                 │
│            │                 │  ┌──────────┬──────────┬──────────────┐          │
│            │                 │  │  adapter │  adapter │  adapter     │          │
│            │                 │  └────┬─────┴────┬─────┴──────┬───────┘          │
│            │                 │       │          │            │                  │
│            │                 │     Claude     Codex         其他                │
│            │                 │     vendor     vendor       vendor               │
│            │                 │       │          │            │                  │
│            │                 │       │    ┌─────┘            │  Responses→Chat  │
│            │                 │       │    │  relay proxy     │  relay (ADR-14)  │
│            │                 │       │    │  (ADR-0014)      │                  │
└────────────┘                 └───────┼────┼──────────────────┼──────────────────┘
                                       │    │                  │
                                       ▼    ▼                  ▼
                                    CLI      CLI        remote server
```

> 三个 vendor 的接入模式完全不同，详情见 [`claude-agent-sdk-guide.md`](claude-agent-sdk-guide.md)（Claude）、
> ADR-0011（vendor-neutral 抽象层设计）和 ADR-0014（Codex Responses→Chat relay）。
>
> | Vendor | 接入架构                 | 进程模型       | 工具级审批 |
> | ------ | ------------------------ | -------------- | ---------- |
> | Claude | 子进程包装（JSON stdio） | 本地常驻子进程 | ✔ 逐工具   |
> | Codex  | 子进程包装（HTTP/SSE）   | 本地子进程     | ✗ 仅整轮   |
>
> 三者的能力差异（中断、模式切换、流式输入、fork、session 操作等）由一份逐能力声明的检查表
> 管理，上层统一通过中性接口驱动（ADR-0011）。

- **Browser（web-console）** — 一个单页 web 应用。通过 `/ws` 连接，渲染工作区/会话侧边栏
  与活动流，是每一次权限决策和模式切换的界面。
- **本地服务器** — 升级 `/ws` 并在生产环境中提供内嵌前端。一个连接就是一个**视图**：它只保存
  当前正在观看哪个会话，并在切换时(取消)订阅。运行状态存在于进程级的 session-runtime 注册表中，
  而非连接上。
- **session-runtime 注册表** — 一个进程级注册表，拥有每个会话的运行：其中断句柄、用于回放的
  内存基线 + wire 事件缓冲区、当前观看者及实时状态。跨连接共享，因此运行能在切换、刷新和断线后
  存活（ADR 0006）。
- **session-registry** — 管理工作区注册表与会话，拥有每会话模式和最近访问顺序，并通过可重建的
  `session_metadata` 投影读取列表/计数界面。原生 vendor 存储仍是转录内容的事实来源。
- **agent-session** — 驱动 vendor 中性适配器层走完其生命周期，把规范消息映射到 wire 协议上，
  并暴露运行中的控制（模式切换、中断）。每个 vendor 的 SDK/CLI 细节被封在其适配器之后 —— 运行
  循环从不直接接触 SDK 类型。
  - **Claude** 通过子进程 JSON stdio 运行 Claude Agent SDK 的 query loop
    （见 [`claude-agent-sdk-guide.md`](claude-agent-sdk-guide.md)）。
  - **Codex** 以 experimental-JSON 模式运行 `codex` CLI，并为第三方 provider 提供一个进程内的
    Responses→Chat relay（ADR-0014）。
- **permission-gateway** — 一个审批桥回调加上一个 request→resolver 注册表，把敏感工具路由到
  浏览器并阻塞直到用户作答；对 Codex 而言会降级为启动时策略（逐工具审批在结构上就不存在，
  ADR-0011）。
- **Agent 宿主 CLI** — 每个 vendor 的 CLI 都是硬性运行时依赖：
  - `claude` CLI —— 由 Claude Agent SDK 作为子进程拉起。
  - `codex` CLI —— 由 c3 作为子进程拉起。

## 模块地图

| 模块                   | 职责                                                                                                                                                                                         |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI 入口               | 命令行入口；`start` 是默认命令（`--port` 默认为 3000；工作区通过 Web UI 管理）                                                                                                               |
| HTTP/WS 服务器         | 升级 `/ws`、提供静态资源、追踪每个连接观看的会话、分发消息并广播状态                                                                                                                         |
| Session-runtime 注册表 | 进程级注册表，记录每个会话的运行句柄、回放基线 + 缓冲区、观看者及状态（ADR 0006）                                                                                                            |
| Host-CLI launcher      | vendor 无关的宿主 CLI 探测：把 vendor 解析为绝对二进制路径或 none，为每个 vendor 携带安装提示，并运行健康检查；第一道能力关卡（ADR-0012）                                                    |
| Kernel 事件总线        | 进程内的类型化发布/订阅总线：同步、错误隔离、静态类型化的 topic→payload map；承载 run/agent/intent/pr 事件。整体运转与扩展见 [`event-mechanism.md`](event-mechanism.md)，选型决策见 ADR-0018 |
| Session 注册表         | 持久化的工作区注册表、每会话模式、最近活跃会话                                                                                                                                               |
| Session IO             | 列出 / 读取 / 重命名 / 删除会话，以及转录内容映射                                                                                                                                            |
| 权限注册表             | 待审批 map，带等待/解析决策与超时处理                                                                                                                                                        |
| 结果格式化             | 把工具结果内容摊平为展示字符串                                                                                                                                                               |
| Intent ledger          | SQLite ledger、只读通信 agent、intent-save 工具（ADR 0007）                                                                                                                                  |
| 静态内嵌               | 生成并内联的 web bundle                                                                                                                                                                      |
| Wire 协议              | client→server / server→client 消息联合类型，以及工作区/会话类型；只有类型/联合类型/常量，无运行时实现                                                                                        |
| 共享领域 helper        | `shared/src/` 下按领域拆分的双端纯函数模块（agent 引用与默认回退、图片媒体守卫、automation 清洗、事件过滤器归一化/升级、事件模型与事件目录），经 `@ccc/shared` barrel 导出                   |
| WS client              | 浏览器 WebSocket 包装器                                                                                                                                                                      |
| UI shell               | 拥有 WS client、入站消息处理器与所有共享状态；按 tab 分发给各 page container                                                                                                                 |
| Pages                  | 逐页面 container（works / intents / discussions / automations / systemsettings）加上私有组件                                                                                                 |
| 共享组件               | 跨页面组件，每个都配有同址单元测试                                                                                                                                                           |

## 横切约定

- **单一契约。** wire 格式只有一份定义，两端共用。
  见 [`../shared/api-conventions/websocket-protocol.md`](../shared/api-conventions/websocket-protocol.md)。
- **权限单向流动。** 只有 gateway 能解析出一个决策；SDK 在没有决策之前绝不会在敏感工具上继续
  往下走。
- **权限状态是全局的、内存态的。** 权限决策从不持久化；待处理请求以 `requestId` 为键，因此
  被切到后台的会话，在切回来后其 prompt 依然可以回答。
- **运行与连接解耦（ADR 0006）。** 运行状态存在于 session-runtime 注册表中，而非 socket 上。
  切换观看的会话与关闭 socket 只会改变订阅关系 —— 运行在后台继续，直到它结束或被显式停止
  （`stop_run`）。不同会话可以并发运行，没有固定上限；单个会话是串行的（在其回合进行中会拒绝
  新的 prompt）。
- **工作区/会话注册表是持久化的。** c3 保存一份小的 JSON 注册表
  （`${CLAUDE_CONFIG_DIR:-~/.claude}/c3/state.json`）：工作区 + 最近访问顺序、每会话模式，
  以及当前活跃会话。会话本身存在于 SDK 的转录存储中。见 [ADR 0004](adr/0004-persist-workspace-session-registry.md)。
- **Intent ledger 是一个独立的 SQLite 存储（ADR 0007）。** 项目范围的 intent 存在
  `~/.c3/c3.db` 中（不同于注册表的 `~/.claude/c3/state.json`），背后是一个跨运行时的驱动
  适配器（`node:sqlite` / `bun:sqlite`）。它是软失败的：如果 db 不可用，intent 功能会降级，
  但 c3 仍能启动并服务正常会话。intent-communication agent 复用运行时注册表与权限 gateway，
  以只读的 `intent` 类型运行。
- **Session metadata 投影是一个统一的读缓存。** c3.db 中的 `session_metadata` 是
  `work_session_metadata` 改名/泛化后的继任者。它为六种会话类型（work / intent / spec /
  discussion / automation / tool）携带寻址与生命周期元数据，包括用于跳回的可选逻辑归属字段。
  它是可重建的，且刻意做到无内容：转录、prompt、工具调用或工具结果都不属于这里。目前写入
  覆盖的是 work + intent；其他类型在各自领域的写入方接入之前，先用同一份契约作为占位。
- **DB 迁移必须幂等、绝不删表、只能向前修正（硬性规则）。** 每一次 c3.db 的 schema 变更都要
  经过某个领域存储的一次性 schema-ensure，并遵守这条项目级的迁移纪律：
  - **幂等 + 可从部分状态重入。** 每一步都要靠*探测实际 schema 状态*
    （`sqlite_master` / `PRAGMA table_info`）来守护，而不是只信 `user_version` 历史。
    一个在迁移中途被打断的 db，必须在任何一次重跑后收敛到终态，且不能抛出重复应用的错误。
  - **绝不 `DROP TABLE`。** 原地重塑 —— `ALTER TABLE … ADD COLUMN` / `RENAME TO` /
    `RENAME COLUMN`。（为了改名而删除一个*索引*是可以的；SQLite 没有 `RENAME INDEX`。）
    涉及数据搬迁的变更要复制进一个新表，并保留旧表，直到后续一次独立的迁移将其淘汰 ——
    绝不做破坏性的原地替换。
  - **通过向前修正来回滚。** 一次错误的迁移要靠追加一个*新的*反向迁移来修正
    （例如一次反向改名），而不是编辑或删除历史中的原迁移。
  - **迁移模板。** 顺序 = 表/列重塑要在 `CREATE TABLE IF NOT EXISTS` 之前执行
    （一个全新的 schema 不能预先创建新名字，从而搁置旧表的数据）；提升 schema 版本号；
    用一个测试覆盖全新 db、旧版 db 和部分迁移 db 这几个起点，并同时断言重跑的幂等性。
  - **审查清单**（每一次迁移变更）：☐ 幂等重跑是空操作 ☐ 部分迁移重入能收敛
    ☐ 零 `DROP TABLE` ☐ 无数据丢失（行/边都存活） ☐ schema 版本已提升
    ☐ 重塑先于 `CREATE TABLE IF NOT EXISTS` ☐ 全新/旧版/部分起点都已测试。
- **Vendor 中性性活在适配器层（ADR-0011）。** 一个中性的三件套接口
  （一个负责运行生命周期 + 规范消息流的 driver、一个拦截/挂起/写回决策的审批桥、
  以及一个把历史藏在同一个面孔后面的 session store）加上一份能力台账，让 c3 可以通过同一个
  界面驱动 Claude、Codex 及未来的 vendor；可选能力（中断、模式切换、流式输入、进程内 MCP、
  session fork、逐工具审批、task store）在使用前会被探测。**修订（2026-06-07）：**
  会话生命周期操作（list / read / resume / rename / delete）被诚实地评为一份结构化的
  逐操作子台账 —— 每个操作是 _none_ / _partial_ / _full_ / _temporarily-unavailable_
  四者之一 —— 因为一个布尔值无法区分结构性的 NO（根本没有路由）和一次瞬时故障。
  wire 上携带这份逐 vendor 矩阵，console 按能力*状态*渲染会话行的操作，绝不通过判断
  vendor 的身份来切换。权限是一个中性的 工具名 + 输入 + 上下文 → allow / ask / deny 策略，
  作用在一个正交的 action-mode（plan、build）× tool-gate（always-ask / on-sensitive /
  trusted-prefix / never-ask）网格之上（Claude 原本的五档权限模式不再是一一对应）。
  **没有任何 vendor SDK 类型跨越适配器边界** —— SDK 的值以无类型的形式进入适配器，并在
  那里被收窄（ADR-0009）。今天 Claude 参考适配器委托给现有的运行路径、gateway 和 session
  IO；让 driver 成为唯一路径的运行循环重写是后续阶段的工作。
- **宿主二进制探测是第一道能力关卡（ADR-0012）。** 每个 agent vendor 都以宿主 CLI 子进程的
  形式运行，无法被打包进 c3 的单一二进制中 —— 这个二进制只发布 c3 本身，因此每种 agent 类型
  都需要在宿主 PATH 上安装其 vendor CLI。host-CLI launcher 把一个 vendor 解析为其绝对二进制
  路径或 none；只有当其二进制能解析出来时，才会为该 vendor 构造一个适配器，因此 CLI 缺失
  意味着该 agent 类型不可用（这是一个产品约定，不是 bug），并附带安装指引，其能力台账也就
  永远不会派上用场。启动时的健康报告会响亮但非致命地列出存在/缺失的二进制。
- **构建顺序：** 先 `web` 后 `server` —— server 内嵌了 web bundle。
- **Web 模块结构。** 前端按三层组织：
  - 共享（跨页面）组件，每个都配有同址单元测试。mobile drill-down shell 是
    list/detail 与三栏页面共用的、仅移动端使用的容器：桌面端按顺序渲染每个面板槽位，
    移动端则显示单一面板栈并配以显式的返回事件；page container 始终拥有自己的
    选中项/数据状态。
  - 页面私有组件，每个都配有同址测试。
  - Page container —— 每个页面一个（works / intents / discussions / automations /
    systemsettings）。
  - shell 拥有 WS client、入站消息处理器与所有共享/tab 状态，并按当前活跃 tab 分发给
    page container。Page container 是**纯粹的**（props 传入 / emit 向上）—— 自身没有
    领域状态（队列编辑的预填内容会被转发回 composer）。纯逻辑、经过单元测试的视图辅助函数
    与 composable 与这两层并列存放，并被两层共同引入。
  - Sessions（历史上的 `works/` 目录）页面与 intents 页面共用 `ChatColumn`，其五个区块
    可以通过 props 显示或隐藏。会话跳回是一条基于 `(sessionKind, ownerKind, ownerId)`
    的纯前端规则，被 sessions 页面与 WorkCenter 共用。
  - Page container 是路由级的视图，可以使用单词名；其私有组件仍遵守多词命名规则。
  - 组件挂载测试运行在类浏览器 DOM 中；其他测试运行在 node 中。

## 关键决策

| ADR                                                         | 决策                                                                                                          |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| [0001](adr/deprecated/0001-c3-sole-permission-authority.md) | _（已被 0005 取代）_ c3 是唯一的权限权威                                                                      |
| [0002](adr/0002-websocket-as-permission-transport.md)       | WebSocket 是权限传输方式                                                                                      |
| [0003](adr/0003-single-binary-via-bun-compile.md)           | 通过 `bun build --compile` 发布为单一二进制                                                                   |
| [0004](adr/0004-persist-workspace-session-registry.md)      | 持久化一份 c3 所有的工作区与会话注册表                                                                        |
| [0005](adr/0005-inherit-user-project-settings.md)           | 继承用户与项目设置；c3 是权限 gateway（`settingSources: ['user', 'project']`）                                |
| [0006](adr/0006-decouple-runs-from-connections.md)          | 把 agent 运行与 WebSocket 连接解耦；运行存在于模块级注册表中                                                  |
| [0007](adr/0007-read-only-intent-agent.md)                  | 只读的 intent-communication agent；`save_intents` 经由权限 gateway；跨运行时 SQLite ledger                    |
| [0009](adr/0009-unidirectional-boundaries.md)               | 单向边界：kernel → transport/features；SDK 类型永不离开 kernel                                                |
| [0011](adr/0011-vendor-neutral-agent-abstraction.md)        | Vendor 中性的 Agent 抽象：要求三件套接口 + 探测式能力台账；五档权限模式改为 action-mode × tool-gate 网格      |
| [0012](adr/0012-host-binary-probe-first-capability-gate.md) | 宿主二进制探测是第一道能力关卡；vendor CLI 缺失 ⇒ agent 类型不可用（按 agent 类型安装，单一二进制并非自包含） |
| [0018](adr/0018-event-bus-kernel-layer.md)                  | kernel 层的进程内类型化事件总线（发布/订阅、错误隔离、同步分发，符合 ADR-0009 边界安全）                      |
