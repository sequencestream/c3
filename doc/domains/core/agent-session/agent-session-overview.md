# Domain: agent-session

- **Group:** core
- **One-line:** 通过 vendor 中立适配层驱动智能体运行,把不同运行时的消息与控制映射到统一协议。
- **Owner:** maintainer
- **Status:** active
- **Depends on:** vendor adapter 与宿主 CLI;[permission-gateway](../permission-gateway/permission-gateway-spec.md)(工具门控);[session-registry](../session-registry/session-registry-spec.md)(工作目录、每会话模式、resume)。
- **Depended on by:** [web-console](../web-console/web-console-spec.md)(消费线事件);intent-management、automations、im-robot(复用同一套运行时)。
- **exposes-api:** true — WebSocket `/ws`。消息形状在[共享协议](../../../shared/api-conventions/websocket-protocol.md)中定义。
- **ADRs:** [0006](../../../architecture/adr/0006-decouple-runs-from-connections.md) 运行与连接解耦、[0008](../../../architecture/adr/0008-streaming-input-for-agent-teams.md) 流式输入、[0011](../../../architecture/adr/0011-vendor-neutral-agent-abstraction.md) 厂商中立抽象、[0012](../../../architecture/adr/0012-host-binary-probe-first-capability-gate.md) 宿主二进制门控、[0015](../../../architecture/adr/0015-session-agent-binding-vendor-ownership.md) 会话归属、[0040](../../../architecture/adr/0040-cursor-as-host-cli-vendor.md) Cursor 非托管宿主 CLI

## Index

- [agent-session-spec.md](agent-session-spec.md) — 运行生命周期、权限模式、取消/续传、厂商中立映射规则
- [agent-session-design.md](agent-session-design.md) — 与网关、注册表、适配器的协作与关键取舍
- [agent-session-models.md](agent-session-models.md) — Session Runtime、Run、Handle
- [features/agent-session-cursor.md](features/agent-session-cursor.md) — Cursor 相对 Claude/Codex 的能力边界
