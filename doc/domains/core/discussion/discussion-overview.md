# Domain: discussion

- **Group:** core
- **One-line:** 工作区范围的圆桌:组织者编排多智能体与人讨论,结论可转为意图。
- **Owner:** maintainer
- **Status:** active
- **Depends on:** [agent-session](../agent-session/agent-session-spec.md)(编排与研究会话运行);[session-registry](../session-registry/session-registry-spec.md)(工作区身份、讨论会话投影);[permission-gateway](../permission-gateway/permission-gateway-spec.md)(研究会话只读闸);[intent-management](../intent-management/intent-management-spec.md)(转意图共用创建原语);[agent-config](../../settings/agent-config/agent-config-spec.md)(组织者缺省);[workspace-setting](../../settings/workspace-setting/workspace-setting-spec.md)(每阶段轮次上限)。
- **Depended on by:** [web-console](../web-console/web-console-spec.md)(列表、圆桌与控制);[automations](../automations/automations-spec.md)(可订阅生命周期,亦可经工具查找、查看、开始与继续);[im-robot](../im-robot/im-robot-spec.md)(共用开始/继续工具);[external-mcp](../external-mcp/external-mcp-spec.md)(可授权同一组工具)。
- **exposes-api:** true — WebSocket `/ws`。消息形状在[共享协议](../../../shared/api-conventions/websocket-protocol.md)中定义。
- **ADRs:** [0007](../../../architecture/adr/0007-read-only-intent-agent.md) 与意图共用本地账本、[0018](../../../architecture/adr/0018-event-bus-kernel-layer.md) 进程内事件总线

本域拥有讨论账本、组织者编排与人在回路控制。意图条目由 [intent-management](../intent-management/intent-management-spec.md) 拥有;转意图只触发 [RM-R45](../intent-management/intent-management-spec.md),不复制创建规则。

## Index

- [discussion-spec.md](discussion-spec.md) — 账本、轮流、人在回路、研究会话、转意图、工具与生命周期事件
- [discussion-design.md](discussion-design.md) — 与会话运行时、注册表、意图、自动化、控制台的协作与取舍
- [discussion-models.md](discussion-models.md) — Discussion / Message / Participant
