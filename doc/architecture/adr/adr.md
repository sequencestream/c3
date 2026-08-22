# ADR 约定

c3 的架构决策记录。

## 编号

- 文件命名模式：`NNNN-title-with-dashes.md`，补零且顺序递增（`0001`、`0002`……）。
- 编号从不复用。

## 生命周期

- 状态取值之一：`proposed`、`accepted`、`deprecated`、`superseded`。
- ADR **永不删除**。被取代的 ADR 保留其文件，加上一条指向替代者的头部说明，并移动到
  `deprecated/`。
- `proposed` 状态的 ADR 应在一个 sprint 内解决。

## 必需章节

Status · Date · Context · Options considered · Decision · Consequences · Compliance ·
References。模板见 `../../.claude/skills/project-spec/references/adr.md`。

## 索引

- [0001](deprecated/0001-c3-sole-permission-authority.md) · superseded — c3 是唯一的权限权威
- [0002](0002-websocket-as-permission-transport.md) · accepted — WebSocket 作为权限传输方式
- [0003](0003-single-binary-via-bun-compile.md) · accepted — 通过 `bun build --compile` 构建单一二进制
- [0004](0004-persist-workspace-session-registry.md) · accepted — c3 持久化一份工作区与会话注册表
- [0005](0005-inherit-user-project-settings.md) · accepted — 继承用户与项目设置；c3 是 gateway
- [0006](0006-decouple-runs-from-connections.md) · accepted — 把 agent 运行与 WebSocket 连接解耦
- [0007](0007-read-only-intent-agent.md) · accepted — 只读 intent agent；经对话确认后保存；跨运行时 SQLite
- [0008](0008-streaming-input-for-agent-teams.md) · accepted — 面向持久化 agent 团队的流式输入 prompt
- [0009](0009-unidirectional-boundaries.md) · accepted — 单向边界：kernel → transport/features，无回边
- [0010](0010-release-and-distribution-trust.md) · accepted — 发布与分发信任（编排骨架）
- [0011](0011-vendor-neutral-agent-abstraction.md) · accepted — Vendor 中性的 Agent 抽象：三件套接口 + 能力（含结构化的会话生命周期状态）
- [0012](0012-host-binary-probe-first-capability-gate.md) · accepted — 宿主二进制探测是第一道能力关卡
- [0013](0013-canonical-envelope-on-wire-c3-session-namespace.md) · accepted — wire 上的规范信封 + c3 会话命名空间内化
- [0014](deprecated/0014-codex-in-process-responses-chat-relay.md) · superseded — 面向 codex Chat-Completions provider 的进程内 Responses→Chat relay(已被 ADR-0029 取代)
- [0015](0015-session-agent-binding-vendor-ownership.md) · accepted — 双键 session→agent 绑定 + 冻结的 vendor 归属
- [0016](0016-external-skill-git-mount.md) · proposed — 外部 skill 经 git 仓库挂载(扁平目录布局;显式安装 + 两公共目录)
- [0017](0017-external-skill-mount-mechanism.md) · proposed — 外部 skill 加载机制:软链 + 写操作管控;显式安装(`install_skill`)+ 状态查询(`get_skill_link_status`)
- [0018](0018-event-bus-kernel-layer.md) · accepted — kernel 层的进程内事件总线（类型化发布/订阅、错误隔离）
- [0020](0020-sandbox-driver-independent-kernel-module.md) · accepted — SandboxDriver 作为独立 kernel 模块
- [0021](0021-system-project-two-tier-sandbox-config.md) · accepted — 系统定义 + 项目选择双层配置
- [0022](0022-canonical-not-extended.md) · accepted — CanonicalMessage 不扩展（沙箱/Checkpoint 通过事件总线）
- [0023](0023-auth-abstraction-network-exposure.md) · proposed — 认证抽象边界：网络暴露的强制前提（none/basic 两种 provider，basic 运行时已上线）
- [0024](deprecated/0024-sandbox-worktree-only-random-agent-hard-isolation.md) · superseded — Sandbox 仅 worktree intent-dev + custom agent 随机选取 + 启用即硬隔离（容器机制已被 ADR-0028 取代）
- [0025](deprecated/0025-sandbox-network-readonly-workspace-policy.md) · superseded — Sandbox `networkDisabled`/`readonlyRootfs` 下沉为工作区级安全策略（已被 ADR-0028 取代）
- [0026](0026-generic-event-normalizer-registry.md) · accepted — 通用事件契约 + 按 type 注册的归一化器（type 判别 + 封闭归一化器注册，取代「每种事件新增窄工具」）
- [0027](0027-event-naming-and-multi-row-subscription.md) · proposed — `<category>:<action>` 事件命名 + 多行订阅 + 级联表单
- [0028](0028-process-level-lightweight-sandbox-arapuca.md) · accepted — 进程级 arapuca 沙箱取代容器方案（当前只控目录 ro/rw、网络全开、凭证默认不可见）
- [0029](0029-vendor-neutral-relay-and-agent-group-failover.md) · accepted — Vendor 中立 relay 核心 + agent group failover（取代 ADR-0014）
- [0030](0030-session-store-scope-vendor-neutral-data-root.md) · accepted — 冻结的会话 store scope（host/sandbox）+ vendor 中立 sandbox 数据根（transcript 定位/续接随冻结解耦开关）
- [0031](0031-deterministic-queue-reconcile-kernel.md) · accepted — 自动化队列的确定性调度内核：tick 全量对账 + 事件降级为提示 + 状态重推导（单意图失败隔离、决策可观测）
- [0032](0032-machine-spec-approval-opt-in.md) · accepted — 队列自治的规格阶段:只读 `spec_review` 会话 + 指纹绑定的结论 + opt-in 机器批准(默认关闭、带机器身份、可撤销)
- [0033](0033-tauri-desktop-shell-sidecar.md) · accepted — Tauri 2 桌面壳:c3 单二进制作为 sidecar + WebView 加载其自带 SPA(共享 c3 home、托盘常驻、最小 capability、只杀自己创建的子进程)
- [0034](0034-intent-pr-fact-base-and-readpoints.md) · accepted — intents PR 拆表的事实基础:时间戳编码 / `pr_id` 语义 / 存量 base / 多 base 行为
- [0035](0035-intent-pr-table-split-and-migration-markers.md) · accepted — PR 拆表为 `intent_prs`(硬切无双写、单一写入口、聚合态共用)+ `schema_migrations` 迁移标记表
- [0036](0036-delivery-as-integration-unit.md) · proposed — 交付作为 Git 集成单元而非业务里程碑:本地账本 + 受控状态机 + `base_branch` 快照 + `pr:merge` 知情告知
- [0037](0037-group-launch-segment-and-session-cursor.md) · accepted — Group 启动段 + 会话游标:一次 run 只服务一段候选且段首必被使用,跨 system/custom 边界的 failover 发生在 resume
- [0038](0038-dependency-gate-base-reachability.md) · accepted — 依赖闸门判据改为 base 可达:唯一共享纯函数 + 会话交付上下文 + `origin/<交付分支>` 基线(从不自动重建/暗中 merge)+ 一次性强制放行
- [0039](0039-delivery-merge-via-delivery-pr.md) · accepted — 合并回主线走交付 PR:先查 forge 事实的幂等 + 三类失败分层 + `delivered` 原子写 + 跨交付闸门重算(c3 从不代合)
- [0040](0040-cursor-as-host-cli-vendor.md) · accepted — Cursor 改为每轮一个 `cursor-agent` 子进程,并作为**非托管**宿主 CLI 进入解析链(凭据二选一、会话读厂商磁盘库、发布链去旁挂)
- [0041](0041-worktree-baseline-drift-as-notice.md) · accepted — worktree 基线不符是提示,不是闸门
- [0042](0042-configuration-in-database.md) · accepted — 配置只有一处事实源 c3.db:一字段一行的细粒度 KV + `--db` 单一覆盖 + 旧 JSON 一次性导入后弃用
- [0043](0043-console-self-update-and-relaunch.md) · accepted — 控制台自更新:服务端唯一状态机 + `ready` 前不碰已装二进制 + 按运行形态移交重启(systemd `--no-block` / launchd KeepAlive / 助手进程 / 前台就地派生)
- [0044](0044-external-mcp-owner-scope-and-unified-endpoint.md) · accepted — 外部 MCP 归属账号求交的权限内核(user_workspace_scopes 默认拒绝 + 全局 policy epoch)+ 无凭据统一端点 `POST /mcp`(Bearer 唯一凭据、`X-C3-Workspace` 选工作区、四元组会话钉定)
- [0045](0045-workspace-memory-as-allowed-local-persistence.md) · accepted — 工作区记忆是被允许的本地持久化类别(结构化字段 + 工作区绑定 + 输入上限 + 凭据/产物拒绝 + 软删与 30 天延迟清理),work session 的两个记忆工具免确认,工具面由 `sessionKind === 'work'` 正向选中
- [0046](0046-im-robot-outbound-authorization.md) · accepted — IM 聊天机器人:进程内出站长连接 + 外发授权四重表达(默认关闭、启用前确认、仅管理员、逐次审计)+ 只发最终文本 + 无人值守会话不得挂起
- [0047](0047-robot-local-reads-scoped-to-run-root.md) · accepted — 聊天机器人本地文件读取限定运行根:每回合冻结运行根 + 真实路径裁决 + 描述表无默认开放 + 门/执行前钩子双重强制 + 无条件进程隔离
- [0048](0048-robot-im-context-as-bounded-local-persistence.md) · accepted — 发送者隔离且有界的机器人 IM 可见上下文是允许的本地持久化例外(四维归属 + 成对结构 + 凭据拒绝 + 码点/回合上限 + 30 天硬删);有限取代 ADR-0045 对转录禁存的禁止;旧群级共享会话安全切断
- [0049](0049-im-identity-binding-and-call-level-scope.md) · accepted — IM 身份绑定与调用级工作区作用域(Web→私聊一次性绑定 + 每次工具调用求交 + scope_hash 切断旧上下文);与 ADR-0044 外部 MCP 连接钉定并列、不共用语义
