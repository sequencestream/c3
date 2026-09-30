# Domain: web-console

- **Group:** core
- **One-line:** 浏览器窗口：人观察活动流、提交或排队 prompt、回答权限、切换模式与智能体。
- **Owner:** maintainer
- **Status:** active
- **Depends on:** [agent-session](../agent-session/agent-session-spec.md)（运行与活动流）；[session-registry](../session-registry/session-registry-spec.md)（工作区与会话目录）；[permission-gateway](../permission-gateway/permission-gateway-spec.md)（待决权限）；settings 各域（配置面）。
- **Depended on by:** 无（位于技术栈顶层）。
- **exposes-api:** false — 客户端，消费 `/ws`，不对外提供 API。
- **notes:** 内部域。消息形状在[共享协议](../../../shared/api-conventions/websocket-protocol.md)中定义一次。
- **ADRs:** [0002](../../../architecture/adr/0002-websocket-as-permission-transport.md)（WebSocket 传输）、[0006](../../../architecture/adr/0006-decouple-runs-from-connections.md)（连接是视图）

## Index

- [web-console-spec.md](web-console-spec.md) — 人可见的交互契约
- [web-console-design.md](web-console-design.md) — 与注册表、运行时、网关、设置的协作与取舍
- [web-console-models.md](web-console-models.md) — View / Connection / Queue
