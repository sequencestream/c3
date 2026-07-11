# Domain: permission-gateway

- **Group:** core
- **One-line:** 将每一次敏感工具调用挡在人工决策之前，并把决策路由到浏览器。
- **Owner:** maintainer
- **Status:** active
- **Depends on:** SDK 的敏感工具回调契约；由 agent-session 提供的 WebSocket 传输。
- **Depended on by:** agent-session(从 SDK 运行选项中调用网关)。
- **exposes-api:** false
- **notes:** 内部域。其唯一对外接口是共享 WebSocket 协议上的 `permission_request` / `permission_response` 一对消息。
- **ADRs:** [0005](../../../architecture/adr/0005-inherit-user-project-settings.md)
  (取代 [0001](../../../architecture/adr/deprecated/0001-c3-sole-permission-authority.md)),
  [0002](../../../architecture/adr/0002-websocket-as-permission-transport.md)

## Index

- [permission-gateway-spec.md](permission-gateway-spec.md) — 业务规则与状态
- [permission-gateway-design.md](permission-gateway-design.md) — 注册表、abort 接线、回调接线
- [permission-gateway-models.md](permission-gateway-models.md) — Permission Request / Decision 实体
