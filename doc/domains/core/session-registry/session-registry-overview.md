# Domain: session-registry

- **Group:** core
- **One-line:** 工作区与会话目录：不可变身份、最近访问、每会话模式，以及从厂商原生存储回放历史。
- **Owner:** maintainer
- **Status:** active
- **Depends on:** 厂商原生存储（转录事实来源）；[agent-session](../agent-session/agent-session-spec.md)（runtime、回放缓冲）；[agent-config](../../settings/agent-config/agent-config-spec.md)（绑定与厂商冻结）。
- **Depended on by:** [web-console](../web-console/web-console-spec.md)（侧边栏）；[files](../files/files-spec.md)（工作区根）；agent-session（工作目录 / 模式 / resume）；intent-management、automations、memory、delivery（工作区身份）。
- **exposes-api:** true — WebSocket `/ws`。消息形状在[共享协议](../../../shared/api-conventions/websocket-protocol.md)中定义。
- **ADRs:** [0004](../../../architecture/adr/0004-persist-workspace-session-registry.md) 持久化目录、[0006](../../../architecture/adr/0006-decouple-runs-from-connections.md) 查看不是所有权、[0013](../../../architecture/adr/0013-canonical-envelope-on-wire-c3-session-namespace.md) 原生存储为转录真源、[0015](../../../architecture/adr/0015-session-agent-binding-vendor-ownership.md) 绑定冻结厂商、[0042](../../../architecture/adr/0042-configuration-in-database.md) 实例库为配置真源

## Index

- [session-registry-spec.md](session-registry-spec.md) — 工作区身份、会话目录、最近访问、模式记忆、回放归属、种类与分页
- [session-registry-design.md](session-registry-design.md) — 与运行时、控制台、文件域的协作；投影相对原生存储的取舍
- [session-registry-models.md](session-registry-models.md) — Workspace / Session
