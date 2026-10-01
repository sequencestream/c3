# Domain: im-robot

- **Group:** core
- **One-line:** 把智能体能力延伸到办公 IM:群里提问、无人值守跑一轮、最终回答发回群;部署级出入口,外发只经唯一出站守卫。
- **Owner:** maintainer
- **Status:** active
- **Depends on:** [auth](../auth/auth-overview.md)(主体与工作区范围、policy epoch);[agent-session](../agent-session/agent-session-spec.md)(无人值守回合);[permission-gateway](../permission-gateway/permission-gateway-spec.md)(机器人闸);[automations](../automations/automations-spec.md)(共用工具网格);[agent-config](../../settings/agent-config/agent-config-spec.md)(厂商与智能体);[session-registry](../session-registry/session-registry-spec.md)(工作区身份;机器人会话不进会话页)。
- **Depended on by:** [web-console](../web-console/web-console-spec.md)(名册、表单、审计与开通);[personalized-setting](../../settings/personalized-setting/personalized-setting-spec.md)(本人身份绑定)。
- **exposes-api:** true — WebSocket `/ws`。消息形状在[共享协议](../../../shared/api-conventions/websocket-protocol.md)中定义。IM 长连接由平台适配持有,不另开 HTTP,不进外部 MCP 目录。
- **ADRs:** [0046](../../../architecture/adr/0046-im-robot-outbound-authorization.md) 外发授权、[0047](../../../architecture/adr/0047-robot-local-reads-scoped-to-run-root.md) 运行根只读、[0048](../../../architecture/adr/0048-robot-im-context-as-bounded-local-persistence.md) 有界 IM 上下文、[0049](../../../architecture/adr/0049-im-identity-binding-and-call-level-scope.md) 身份绑定与调用级作用域

本域拥有部署级 IM 出入口、身份绑定与外发守卫。身份绑定由本人在 Web 发起、私聊完成。工作区范围由 [auth](../auth/auth-overview.md) 拥有,每次调用求交,不复制 AUTH-R*。工具网格与 [automations](../automations/automations-spec.md) 共用,不复制 SCH-R*。正式术语见[术语表·机器人](../../../glossary.md#机器人)。

## Index

- [im-robot-spec.md](im-robot-spec.md) — 出入口、身份绑定、能力上限、外发、无人值守、工具、响应与诊断、飞书开通
- [im-robot-design.md](im-robot-design.md) — 与 auth、automations、agent-session、session-registry、web-console 的协作与取舍
- [im-robot-models.md](im-robot-models.md) — Binding / Robot / Outbound message
