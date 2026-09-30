# Domain: external-mcp

- **Group:** core
- **One-line:** 向外部智能体和自动化暴露受工作区授权约束的 MCP 能力。
- **Owner:** maintainer
- **Status:** active
- **Depends on:** [auth](../auth/auth-overview.md)（主体范围与 policy epoch）；[session-registry](../session-registry/session-registry-spec.md)（工作区身份）。工具行为由意图、讨论、交付各域拥有。
- **Depended on by:** [personalized-setting](../../settings/personalized-setting/personalized-setting-spec.md)（钥匙自助）；[system-setting](../../settings/system-setting/system-setting-spec.md)（钥匙存储）；[workspace-setting](../../settings/workspace-setting/workspace-setting-spec.md)（只读访问一览）。
- **exposes-api:** true — Streamable HTTP `POST /mcp`。协议对齐见 [mcp-spec-compliance](../mcp/mcp-spec-compliance.md)。
- **ADRs:** [0044](../../../architecture/adr/0044-external-mcp-owner-scope-and-unified-endpoint.md) 求交、统一端点与会话钉定

本域拥有 c3 对**未拉起的 agent** 的唯一公开 MCP 入口。不拥有主体范围、钥匙存储或工具业务语义。工作区范围见 [auth](../auth/auth-overview.md#工作区范围-user_workspace_scopes)，不复制 AUTH-R\*。

## Index

- [external-mcp-spec.md](external-mcp-spec.md) — 接入与凭据、工作区与求交、本机与暴露、工具目录、目标与自检、写审计、规范对齐
- [external-mcp-design.md](external-mcp-design.md) — 与 auth、内部面、设置面的协作与取舍
