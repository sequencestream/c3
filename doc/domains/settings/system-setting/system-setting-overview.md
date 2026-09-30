# Domain: system-setting

- **Group:** settings
- **One-line:** 管理员全局配置:显示与本地化、公开地址、导航、CLI 版本、代理、会话清理、鉴权与访问、外部钥匙存储、监听与续跑、环境诊断。
- **Owner:** maintainer
- **Status:** active
- **Depends on:** [auth](../../core/auth/auth-overview.md)(管理员门与 AUTH-R*)。
- **Depended on by:** [agent-config](../agent-config/agent-config-spec.md)(CLI 版本与宿主是否可跑);[sandbox](../../core/sandbox/sandbox-spec.md)(系统代理);[self-update](../../core/self-update/self-update-spec.md)(出网);[session-cleanup](../../core/session-cleanup/session-cleanup-spec.md)(开关与保留期);[external-mcp](../../core/external-mcp/external-mcp-spec.md)(钥匙存储与监听);[personalized-setting](../personalized-setting/personalized-setting-spec.md)(钥匙哈希);[workspace-setting](../workspace-setting/workspace-setting-spec.md)(账号范围);[web-console](../../core/web-console/web-console-spec.md)(设置页);[automations](../../core/automations/automations-spec.md)(时区)。
- **exposes-api:** true — WebSocket `/ws`。消息形状在[共享协议](../../../shared/api-conventions/websocket-protocol.md)中定义。

本域拥有部署级一份的管理员配置。智能体档案见 [agent-config](../agent-config/agent-config-overview.md);按人偏好见 [personalized-setting](../personalized-setting/personalized-setting-spec.md);工作区旋钮见 [workspace-setting](../workspace-setting/workspace-setting-overview.md)。不执行隔离、不校验钥匙出示、不跑保留期删除。

## Index

- [system-setting-spec.md](system-setting-spec.md) — 显示、地址、导航、CLI、代理、清理、鉴权、钥匙存储、监听、诊断
- [system-setting-design.md](system-setting-design.md) — 与 auth、出网、清理、钥匙面的协作与取舍
