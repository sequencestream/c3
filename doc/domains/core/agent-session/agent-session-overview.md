# Domain: agent-session

- **Group:** core
- **One-line:** 通过 vendor 中立适配层驱动智能体运行,将不同运行时的消息和控制能力映射到统一协议。
- **Owner:** maintainer
- **Status:** active
- **Depends on:** vendor adapter 与宿主 CLI;`permission-gateway`(用于工具门控)。
- **Depended on by:** `web-console`(消费其线事件)。
- **exposes-api:** true — WebSocket `/ws` 端点。消息形状在共享协议中定义,而非本文档。
- **ADRs:** [0002](../../../architecture/adr/0002-websocket-as-permission-transport.md),
  [0003](../../../architecture/adr/0003-single-binary-via-bun-compile.md),
  [0011](../../../architecture/adr/0011-vendor-neutral-agent-abstraction.md),
  [0012](../../../architecture/adr/0012-host-binary-probe-first-capability-gate.md)

## Index

- [agent-session-spec.md](agent-session-spec.md) — 运行生命周期、权限模式、消息映射规则
- [agent-session-design.md](agent-session-design.md) — 运行接线、中止/中断、宿主 CLI 与厂商适配
- [agent-session-models.md](agent-session-models.md) — Session、Agent Run、Run Handle 实体
