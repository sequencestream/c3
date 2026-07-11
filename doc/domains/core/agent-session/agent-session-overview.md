# Domain: agent-session

- **Group:** core
- **One-line:** 驱动 Claude Agent SDK 的 `query()` 循环处理单个连接,并将其消息映射到线协议。
- **Owner:** maintainer
- **Status:** active
- **Depends on:** `@anthropic-ai/claude-agent-sdk`; 宿主 `claude` CLI;
  `permission-gateway`(用于工具门控)。
- **Depended on by:** `web-console`(消费其线事件)。
- **exposes-api:** true — WebSocket `/ws` 端点。消息形状在共享协议中定义,而非本文档。
- **ADRs:** [0002](../../../architecture/adr/0002-websocket-as-permission-transport.md),
  [0003](../../../architecture/adr/0003-single-binary-via-bun-compile.md)

## Index

- [agent-session-spec.md](agent-session-spec.md) — 运行生命周期、权限模式、消息映射规则
- [agent-session-design.md](agent-session-design.md) — `query()` 接线、中止/中断、claude PATH 查找
- [agent-session-models.md](agent-session-models.md) — Session、Agent Run、Run Handle 实体
