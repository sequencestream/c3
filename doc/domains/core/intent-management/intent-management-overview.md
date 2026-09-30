# Domain: intent-management

- **Group:** core
- **One-line:** 项目范围的意图账本:只读沟通智能体把想法拆成可验证条目,驱动规格、开发、PR 与可选的自动化队列。
- **Owner:** maintainer
- **Status:** active
- **Depends on:** [agent-session](../agent-session/agent-session-spec.md)(沟通 / 规格 / 工作运行);[permission-gateway](../permission-gateway/permission-gateway-spec.md)(意图网关与规格写界);[session-registry](../session-registry/session-registry-spec.md)(工作区身份、隐藏沟通与规格会话)。
- **Depended on by:** [web-console](../web-console/web-console-spec.md)(意图视图与队列页);[delivery](../delivery/delivery-spec.md)(关联与 PR 落点);[automations](../automations/automations-spec.md)(评审 / 修复执行面);[discussion](../discussion/discussion-overview.md)(结论转意图)。
- **exposes-api:** true — WebSocket `/ws`。消息形状在[共享协议](../../../shared/api-conventions/websocket-protocol.md)中定义。
- **ADRs:** [0007](../../../architecture/adr/0007-read-only-intent-agent.md) 只读沟通智能体、[0034](../../../architecture/adr/0034-intent-pr-fact-base-and-readpoints.md) PR 账本为事实源

## Index

- [intent-management-spec.md](intent-management-spec.md) — 账本生命周期、规格闸门、开发挂接、PR 事实、依赖、评审修复、自动化队列
- [intent-management-design.md](intent-management-design.md) — 与运行时、网关、注册表、交付、自动化、控制台的协作与取舍
- [intent-management-models.md](intent-management-models.md) — Intent / Dependency / PR 行 / WorkNote / 沟通会话
