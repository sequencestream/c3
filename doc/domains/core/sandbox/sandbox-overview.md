# Domain: sandbox

- **Group:** core
- **One-line:** 入选会话的 run 进进程级隔离:限制可见目录,无容器、无凭证注入;驱动不可用则失败不裸跑。
- **Owner:** maintainer
- **Status:** active
- **Depends on:** [workspace-setting](../../settings/workspace-setting/workspace-setting-spec.md)(启用、补充挂载、会话种类);[agent-session](../agent-session/agent-session-spec.md)(启动与执行根);[agent-config](../../settings/agent-config/agent-config-spec.md)(连接解析决定是否开钥匙串)。
- **Depended on by:** [agent-session](../agent-session/agent-session-spec.md)(入选 run 启动前接入);[im-robot](../im-robot/im-robot-spec.md)(回合强制隔离复用本能力)。
- **exposes-api:** false
- **notes:** 内部域。配置入口在工作区设置;本域只执行隔离。
- **ADRs:** [0028](../../../architecture/adr/0028-process-level-lightweight-sandbox-arapuca.md) 进程级隔离取代容器

本域拥有进程级隔离的放行边界与失败语义。哪些种类进箱由工作区设置裁定,本域不复制其勾选清单。

## Index

- [sandbox-spec.md](sandbox-spec.md) — 进程隔离、放行范围、代理与认证、会话种类、驱动失败关闭
- [sandbox-design.md](sandbox-design.md) — 与 agent-session、workspace-setting 的协作与取舍
