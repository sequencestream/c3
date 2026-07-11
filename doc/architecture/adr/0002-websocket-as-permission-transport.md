# 0002 — WebSocket 作为权限传输通道

- **Status:** accepted
- **Date:** 2026-05-29

## Context

权限决策本质上是双向且阻塞的：服务端必须在任意时刻(运行中途，只要智能体触及敏感工具)向浏览器推送一个请求，然后等待浏览器的回答后 SDK 才能继续。智能体同时也在持续流式输出助手文本与工具活动。传输通道必须能承载服务端发起的推送，而不仅是请求/响应。

## Options considered

- **HTTP 轮询 / 长轮询。** 优点：简单、无状态。缺点：服务端无法干净地推送一个阻塞式提示；流式传输的延迟与复杂度高；难以适配“阻塞直到应答”的模式。
- **Server-Sent Events + HTTP POST 提交应答。** 优点：原生支持下行的服务端推送。缺点：需要维护两条通道的同步；没有单一有序流；活动部件更多。
- **`/ws` 上的单一 WebSocket。** 优点：为提示、流式活动、权限请求、决策与模式变更提供一条有序的双向通道；通过请求 id 关联自然地建模“阻塞并恢复”流程。缺点：需要处理连接生命周期与重连。

## Decision

使用 `/ws` 上的单一 WebSocket。所有流量都是 JSON 信封，其类型由一次性定义的客户端到服务端与服务端到客户端消息联合类型作为线路契约来约束。权限请求携带一个关联 id；浏览器的 `permission_response` 回传该 id 以完成关联。

## Consequences

- **Easier:** 单一有序流；网关可以按关联 id 挂起一个待解析的结果，并在匹配的响应到达时完成它。
- **Harder:** 连接即会话状态。客户端通过心跳 + 指数退避自动重连来缓解断连，重连后重新选中当前活动会话(AVAIL-6)；无论如何后台运行都能挺过断连(AVAIL-3)。
- 开发服务器将 `/ws` 代理到后端，使浏览器可透明地建立连接。

## Compliance

- 协议只定义一次，作为共享的线路契约，由两端 import。
- 线路数据在边界处校验；无法解析的消息被忽略，绝不会被视为已批准。

## References

- `doc/shared/api-conventions/websocket-protocol.md`
- `doc/domains/core/permission-gateway/permission-gateway-spec.md`
