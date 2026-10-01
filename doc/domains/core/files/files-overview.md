# Domain: files

- **Group:** core
- **One-line:** 只读浏览已登记工作区的仓库，并可就代码提问。
- **Owner:** maintainer
- **Status:** active
- **Depends on:** [session-registry](../session-registry/session-registry-spec.md)（工作区根）；[agent-session](../agent-session/agent-session-spec.md)（内嵌工作会话）。
- **Depended on by:** [web-console](../web-console/web-console-spec.md)（文件页）。
- **exposes-api:** true — WebSocket `/ws`。消息形状在[共享协议](../../../shared/api-conventions/websocket-protocol.md)中定义。

本域拥有已登记工作区内的只读检视。不拥有运行循环，不写仓库，不把客户端路径当作信任根。

## Index

- [files-spec.md](files-spec.md) — 只读树、工作树状态、内嵌会话
- [files-design.md](files-design.md) — 与 session-registry、agent-session 的协作与取舍
- [files-models.md](files-models.md) — 已登记工作区 / 相对路径 / 工作树状态 / 内嵌会话
