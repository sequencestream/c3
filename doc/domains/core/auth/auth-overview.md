# Domain: auth

- **Group:** core
- **One-line:** 连接过身份门，改全局配置过管理员门。
- **Owner:** maintainer
- **Status:** active
- **Depends on:** [session-registry](../session-registry/session-registry-spec.md)（工作区身份，供范围求解）。
- **Depended on by:** [web-console](../web-console/web-console-spec.md)（登录门）；[system-setting](../../settings/system-setting/system-setting-spec.md)（管理员门与认证配置）；[personalized-setting](../../settings/personalized-setting/personalized-setting-spec.md)（按人偏好，不过管理员门）；[external-mcp](../external-mcp/external-mcp-spec.md)（主体范围与 policy epoch）；[im-robot](../im-robot/im-robot-spec.md)（调用级范围求解）。
- **exposes-api:** true — WebSocket `/ws`。消息形状在[共享协议](../../../shared/api-conventions/websocket-protocol.md)中定义。
- **ADRs:** [0023](../../../architecture/adr/0023-auth-abstraction-network-exposure.md) 认证抽象与暴露、[0044](../../../architecture/adr/0044-external-mcp-owner-scope-and-unified-endpoint.md) 范围默认拒绝、policy epoch 与求交边界

本域拥有连接身份与账号级工作区范围。认证可选：是否启用、是否暴露到网络，由使用者决定；暴露时建议先启用认证。不拥有外部 MCP 入口、IM 出入口或设置面板本身。正式术语见[术语表](../../../glossary.md)。

## 工作区范围 `user_workspace_scopes`

管理员配置的账号级授权：缺省拒绝，管理员与本地主体恒全部。不变量见 [auth-spec.md](auth-spec.md)。

## Index

- [auth-spec.md](auth-spec.md) — 登录与令牌、连接与管理员门、多账号、主体与范围、调用卡口
- [auth-design.md](auth-design.md) — 与 system-setting、external-mcp、im-robot 的协作与取舍
- [auth-models.md](auth-models.md) — 提供方 / 主体 / 工作区范围 / 会话令牌
