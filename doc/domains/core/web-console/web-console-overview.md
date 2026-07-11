# Domain: web-console

- **Group:** core
- **One-line:** 浏览器 UI —— 发送提示词、观察智能体工作、回答 Allow/Deny,
  切换权限模式。
- **Owner:** maintainer
- **Status:** active
- **Depends on:** `agent-session` 的 WebSocket 契约(共享协议)。
- **Depended on by:** 无(它位于技术栈顶层)。
- **exposes-api:** false —— 它是客户端;消费 `/ws`,不对外提供任何 API。
- **notes:** 用 Vite 构建的 Vue 3 单页应用。生产环境下由 Hono
  服务端提供该构建产物(文件系统或内嵌方式);开发环境下运行在 Vite :5173,`/ws` 被代理到 :3000。
- **ADRs:** [0002](../../../architecture/adr/0002-websocket-as-permission-transport.md)

## Index

- [web-console-spec.md](web-console-spec.md) —— UI 行为与规则
- [web-console-design.md](web-console-design.md) —— Vue 组件、WS 客户端、状态
- [web-console-models.md](web-console-models.md) —— Chat Message 视图模型
