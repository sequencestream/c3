# session-registry — 域概览

| 字段 | 值                                                            |
| ---- | ------------------------------------------------------------- |
| 职责 | 管理工作区与统一的厂商会话列表投影;拥有每会话的模式与访问顺序 |
| API  | WebSocket `/ws`(见共享协议)                                   |
| 状态 | active                                                        |

session-registry 是侧边栏背后的记账层。它把项目目录注册为**工作区(workspace)**,
从可重建的 `session_metadata` 投影(以厂商存储作为校验/重建来源)中列出每个工作区的**会话(session)**,
跟踪哪个会话处于**活跃(active)**状态,并记忆每个会话的权限**模式(mode)**以及每个工作区跨重启的最近访问顺序。

它不运行智能体(那是 [agent-session](../agent-session/agent-session-overview.md) 的职责),
也不渲染侧边栏(那是 [web-console](../web-console/web-console-overview.md) 的职责)。

见 [session-registry-spec.md](session-registry-spec.md)、[session-registry-models.md](session-registry-models.md)、[session-registry-design.md](session-registry-design.md)。
