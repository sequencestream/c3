# Domain: workspace-setting

- **Group:** settings
- **One-line:** 按工作区持有的配置旋钮:智能体覆盖、默认权限模式、开发与 Git、沙箱启用、共识与讨论、规格与自动化策略。
- **Owner:** maintainer
- **Status:** active
- **Depends on:** [agent-config](../agent-config/agent-config-spec.md)(档案与覆盖解析);[session-registry](../../core/session-registry/session-registry-spec.md)(工作区名称);[external-mcp](../../core/external-mcp/external-mcp-spec.md)(访问求交);[system-setting](../system-setting/system-setting-spec.md)(账号范围)。
- **Depended on by:** [sandbox](../../core/sandbox/sandbox-spec.md)(启用、挂载、种类);[permission-gateway](../../core/permission-gateway/permission-gateway-overview.md)(共识旋钮);[discussion](../../core/discussion/discussion-spec.md)(轮次上限);[automations](../../core/automations/automations-spec.md)(总闸);[agent-config](../agent-config/agent-config-spec.md)(工作区覆盖);[intent-management](../../core/intent-management/intent-management-spec.md)(规格与并发);[web-console](../../core/web-console/web-console-spec.md)(设置页)。
- **exposes-api:** true — WebSocket `/ws`。消息形状在[共享协议](../../../shared/api-conventions/websocket-protocol.md)中定义。
- **ADRs:** [0032](../../../architecture/adr/0032-machine-spec-approval-opt-in.md) 机器批准显式 opt-in

本域拥有按工作区名称持久化的旋钮。隔离运行见 [sandbox](../../core/sandbox/sandbox-spec.md);角色解析见 [agent-config](../agent-config/agent-config-spec.md)。观测与访问一览只读、不进保存。

## Index

- [workspace-setting-spec.md](workspace-setting-spec.md) — 覆盖、权限模式、开发与 Git、沙箱、共识与讨论、规格与自动化、技能仓库、托管、只读观察
- [workspace-setting-design.md](workspace-setting-design.md) — 与运行时、网关、队列的协作与取舍
