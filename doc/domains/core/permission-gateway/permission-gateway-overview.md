# Domain: permission-gateway

- **Group:** core
- **One-line:** 将敏感工具调用挡在决策之前，并把尚未被策略决定的请求路由到浏览器。
- **Owner:** maintainer
- **Status:** active
- **Depends on:** [agent-session](../agent-session/agent-session-spec.md)（运行、推送通道、取消信号）；[workspace-setting](../../settings/workspace-setting/workspace-setting-spec.md)（共识旋钮）。
- **Depended on by:** agent-session（按厂商能力把敏感调用交给网关）；[web-console](../web-console/web-console-spec.md)（渲染并回答）。
- **exposes-api:** false
- **notes:** 内部域。对外只经共享协议上的 `permission_request` / `permission_response` / `consensus_auto`。
- **ADRs:** [0005](../../../architecture/adr/0005-inherit-user-project-settings.md)（网关而非唯一权威）、[0002](../../../architecture/adr/0002-websocket-as-permission-transport.md)（WebSocket 作为权限传输）

## Index

- [permission-gateway-spec.md](permission-gateway-spec.md) — 拦截、默认拒绝、中止即拒绝、继承规则
- [permission-gateway-design.md](permission-gateway-design.md) — 与运行时、控制台的协作；待决跟 run 走
- [permission-gateway-models.md](permission-gateway-models.md) — Request / Decision
- [features/permission-gateway-consensus.md](features/permission-gateway-consensus.md) — 多智能体投票作为产品能力
