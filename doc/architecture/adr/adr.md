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

| #                                                                            | 标题                                                                                                                   | 状态       |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------- |
| [0001](deprecated/0001-c3-sole-permission-authority.md)                      | c3 是唯一的权限权威                                                                                                    | superseded |
| [0002](0002-websocket-as-permission-transport.md)                            | WebSocket 作为权限传输方式                                                                                             | accepted   |
| [0003](0003-single-binary-via-bun-compile.md)                                | 通过 `bun build --compile` 构建单一二进制                                                                              | accepted   |
| [0004](0004-persist-workspace-session-registry.md)                           | c3 持久化一份工作区与会话注册表                                                                                        | accepted   |
| [0005](0005-inherit-user-project-settings.md)                                | 继承用户与项目设置；c3 是 gateway                                                                                      | accepted   |
| [0006](0006-decouple-runs-from-connections.md)                               | 把 agent 运行与 WebSocket 连接解耦                                                                                     | accepted   |
| [0007](0007-read-only-intent-agent.md)                                       | 只读 intent agent；经确认后保存；跨运行时 SQLite                                                                       | accepted   |
| [0008](0008-streaming-input-for-agent-teams.md)                              | 面向持久化 agent 团队的流式输入 prompt                                                                                 | accepted   |
| [0009](0009-unidirectional-boundaries.md)                                    | 单向边界：kernel → transport/features，无回边                                                                          | accepted   |
| [0010](0010-release-and-distribution-trust.md)                               | 发布与分发信任（编排骨架）                                                                                             | accepted   |
| [0011](0011-vendor-neutral-agent-abstraction.md)                             | Vendor 中性的 Agent 抽象：三件套接口 + 能力（2026-06-07 修订，加入结构化的会话生命周期状态）                           | accepted   |
| [0012](0012-host-binary-probe-first-capability-gate.md)                      | 宿主二进制探测是第一道能力关卡                                                                                         | accepted   |
| [0013](0013-canonical-envelope-on-wire-c3-session-namespace.md)              | wire 上的规范信封 + c3 会话命名空间内化                                                                                | accepted   |
| [0014](deprecated/0014-codex-in-process-responses-chat-relay.md)             | 面向 codex Chat-Completions provider 的进程内 Responses→Chat relay(已被 ADR-0029 取代)                                 | superseded |
| [0015](0015-session-agent-binding-vendor-ownership.md)                       | 双键 session→agent 绑定 + 冻结的 vendor 归属                                                                           | accepted   |
| [0016](0016-external-skill-git-mount.md)                                     | 外部 skill 经 git 仓库挂载(扁平目录布局;2026-06-12 改显式安装 + 两公共目录)                                            | proposed   |
| [0017](0017-external-skill-mount-mechanism.md)                               | 外部 skill 加载机制:软链 + 写操作管控;2026-06-12 启动挂载→显式安装(`install_skill`)+ 状态查询(`get_skill_link_status`) | proposed   |
| [0018](0018-event-bus-kernel-layer.md)                                       | kernel 层的进程内事件总线（类型化发布/订阅、错误隔离）                                                                 | accepted   |
| [0020](0020-sandbox-driver-independent-kernel-module.md)                     | SandboxDriver 作为独立 kernel 模块                                                                                     | accepted   |
| [0021](0021-system-project-two-tier-sandbox-config.md)                       | 系统定义 + 项目选择双层配置                                                                                            | accepted   |
| [0022](0022-canonical-not-extended.md)                                       | CanonicalMessage 不扩展（沙箱/Checkpoint 通过事件总线）                                                                | accepted   |
| [0023](0023-auth-abstraction-network-exposure.md)                            | 认证抽象边界：网络暴露的强制前提（none/basic 两种 provider，basic 运行时已上线）                                       | proposed   |
| [0024](deprecated/0024-sandbox-worktree-only-random-agent-hard-isolation.md) | Sandbox 仅 worktree intent-dev + custom agent 随机选取 + 启用即硬隔离（容器机制已被 ADR-0028 取代）                    | superseded |
| [0025](deprecated/0025-sandbox-network-readonly-workspace-policy.md)         | Sandbox `networkDisabled`/`readonlyRootfs` 下沉为工作区级安全策略（已被 ADR-0028 取代）                                | superseded |
| [0026](0026-generic-event-normalizer-registry.md)                            | 通用事件契约 + 按 type 注册的归一化器（有意修订「每种事件新增窄工具」为「type 判别 + 封闭归一化器注册」）              | accepted   |
| [0027](0027-event-naming-and-multi-row-subscription.md)                      | `<category>:<action>` 事件命名 + 多行订阅 + 级联表单                                                                   | proposed   |
| [0028](0028-process-level-lightweight-sandbox-arapuca.md)                    | 进程级 arapuca 沙箱取代容器方案（当前只控目录 ro/rw、网络全开、凭证默认不可见）                                        | accepted   |
| [0029](0029-vendor-neutral-relay-and-agent-group-failover.md)                | Vendor 中立 relay 核心 + agent group failover（取代 ADR-0014）                                                         | accepted   |
