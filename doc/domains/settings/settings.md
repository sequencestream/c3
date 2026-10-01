# Group: settings

`settings` 承载用户管理的配置,与按会话簿记正交。四个域、三类作用域彼此独立:系统级(全局一份,含智能体档案)、工作区级、个人级。`personalized-setting` 是唯一不过管理员门的一类。

系统设置与个人化从系统菜单进入;工作区设置在工作区顶栏。三者不同时叠在同一区域。

## Domains

- [agent-config](agent-config.md) — active
  - 职责: 智能体档案、具名上游、默认与专用路由、按会话绑定
  - API: WebSocket `/ws`
- [system-setting](system-setting.md) — active
  - 职责: 管理员全局配置:显示与时区、CLI 版本、代理、鉴权、监听、诊断、会话清理
  - API: WebSocket `/ws`
- [workspace-setting](workspace-setting.md) — active
  - 职责: 按工作区的权限模式、开发与 Git、沙箱、共识与讨论、规格与自动化策略
  - API: WebSocket `/ws`
- [personalized-setting](personalized-setting.md) — active
  - 职责: 按人偏好(语言、样式、字号);已认证存服务端,无身份存本机
  - API: WebSocket `/ws`

## Shared context

- 线协议约定见 [`websocket-protocol.md`](../../shared/api-conventions/websocket-protocol.md)。
- 配置按作用域分存,一次写入只触及一个作用域。见 [persistence](../../shared/data-conventions/persistence.md)。
- 外部 MCP 钥匙独立存储,不走通用保存。见 [system-setting](system-setting.md) 与 [external-mcp](../core/external-mcp.md)。

## Dependency direction

```
web-console ──(/ws)──► agent-config ──启动覆盖──► agent-session
                              ├──► workspace-setting ──工作区旋钮──► 运行与编排
                              ├──► system-setting ──代理 / CLI / 鉴权──► 启动与出网
                              └──► personalized-setting ──界面与输出语言
```
