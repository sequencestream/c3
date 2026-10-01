# Domain: agent-config

- **Group:** settings
- **One-line:** 智能体档案、具名上游、默认与专用路由、按会话绑定。
- **Owner:** maintainer
- **Status:** active
- **Depends on:** [system-setting](../system-setting/system-setting-spec.md)(CLI 版本与宿主是否可跑);[workspace-setting](../workspace-setting/workspace-setting-spec.md)(工作区覆盖);[auth](../../core/auth/auth-overview.md)(改全局配置过管理员门)。
- **Depended on by:** [agent-session](../../core/agent-session/agent-session-spec.md)(启动解析与同厂商候选);[session-registry](../../core/session-registry/session-registry-spec.md)(绑定与厂商冻结);[web-console](../../core/web-console/web-console-spec.md)(设置页、新建与冷启动门);[sandbox](../../core/sandbox/sandbox-spec.md)(连接是否为空决定钥匙串);[automations](../../core/automations/automations-spec.md)(默认与专用智能体);[discussion](../../core/discussion/discussion-spec.md)(启用池与组织者缺省);[im-robot](../../core/im-robot/im-robot-overview.md)(厂商与智能体)。
- **exposes-api:** true — WebSocket `/ws`。消息形状在[共享协议](../../../shared/api-conventions/websocket-protocol.md)中定义。
- **ADRs:** [0015](../../../architecture/adr/0015-session-agent-binding-vendor-ownership.md) 双键绑定与冻结厂商、[0029](../../../architecture/adr/0029-vendor-neutral-relay-and-agent-group-failover.md) 中立 relay 与组回退、[0012](../../../architecture/adr/0012-host-binary-probe-first-capability-gate.md) 宿主 CLI 门控

本域拥有智能体注册表、具名上游、系统默认与角色路由、按会话绑定。运行循环见 [agent-session](../../core/agent-session/agent-session-spec.md);CLI 版本见 [system-setting](../system-setting/system-setting-spec.md)。不渲染设置页。

## Index

- [agent-config-spec.md](agent-config-spec.md) — 档案、上游、连接、分组、门控、自动配置、路由、绑定
- [agent-config-design.md](agent-config-design.md) — 与运行时、工作区、沙箱、relay 的协作与取舍
- [agent-config-models.md](agent-config-models.md) — Agent / ModelProvider / 会话绑定 / 测速运行
