# Domain: personalized-setting

- **Group:** settings
- **One-line:** 按人偏好:显示语言、样式、字号;按身份存储与首次播种;外部钥匙自助;智能体输出语言。
- **Owner:** maintainer
- **Status:** active
- **Depends on:** [auth](../../core/auth/auth-overview.md)(已验证身份,不过管理员门);[system-setting](../system-setting/system-setting-spec.md#外部-mcp-api-key-存储-mcp_api_keys)(钥匙哈希);[external-mcp](../../core/external-mcp/external-mcp-spec.md)(钥匙用法);[im-robot](../../core/im-robot/im-robot-overview.md)(绑定语义)。
- **Depended on by:** [web-console](../../core/web-console/web-console-spec.md)(设置页)。
- **exposes-api:** true — WebSocket `/ws`。消息形状在[共享协议](../../../shared/api-conventions/websocket-protocol.md)中定义。

本域拥有按人偏好与本人自助面。管理员配置见 [system-setting](../system-setting/system-setting-overview.md);钥匙出示见 [external-mcp](../../core/external-mcp/external-mcp-overview.md);IM 绑定语义见 [im-robot](../../core/im-robot/im-robot-overview.md)。不渲染控制台。

## Index

- [personalized-setting-spec.md](personalized-setting-spec.md) — 存储、播种、显示、输出语言、钥匙与绑定自助
- [personalized-setting-design.md](personalized-setting-design.md) — 与 auth、钥匙面、IM 的协作与取舍
