# Domain: memory

- **Group:** core
- **One-line:** 工作区级记事本:工作会话跨轮次记下偏好、约束与教训,设置页可查阅并软删。
- **Owner:** maintainer
- **Status:** active
- **Depends on:** [session-registry](../session-registry/session-registry-spec.md)(工作区身份);[agent-session](../agent-session/agent-session-spec.md)(工作会话与工具面)。
- **Depended on by:** [permission-gateway](../permission-gateway/permission-gateway-spec.md)(工作会话上预批准);[workspace-setting](../../settings/workspace-setting/workspace-setting-spec.md)(查阅与软删)。
- **exposes-api:** true — WebSocket `/ws`。消息形状在[共享协议](../../../shared/api-conventions/websocket-protocol.md)中定义。模型侧仅工作会话工具 `memory_search` / `memory_write`;不进外部 MCP 目录。
- **ADRs:** [0045](../../../architecture/adr/0045-workspace-memory-as-allowed-local-persistence.md) 工作区记忆为被允许的本地持久化

本域拥有工作区记事本。它存结论,不存转录。仓库能自证的事实属于仓库文档;会话里说出、不宜写进仓库的共识落在这里。正式术语见[术语表](../../../glossary.md)。

## Index

- [memory-spec.md](memory-spec.md) — 检索与写入、设置页查阅、同名与矛盾、写入边界、软删回收
- [memory-design.md](memory-design.md) — 与 agent-session、permission-gateway、workspace-setting、session-registry 的协作与取舍
- [memory-models.md](memory-models.md) — Memory
