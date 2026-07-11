# agent-config — 领域概览

| 字段 | 值                                                                        |
| ---- | ------------------------------------------------------------------------- |
| 职责 | 管理智能体档案(厂商判别式配置 + 展示名称)、默认智能体、按会话的智能体绑定 |
| API  | WebSocket `/ws`(见共享协议)                                               |
| 状态 | active                                                                    |

**agent(智能体)**是一个厂商无关的公共外壳(`id`、`vendor`、`displayName`、`enabled?`、`icon?`)
加上一个按 `vendor` 判别的 `config` 子对象。目前唯一有适配器——因而也有配置形态——的厂商是
**claude**(`config = { baseUrl, apiKey, model }`,即 Claude Code 启动
一个全空配置的 claude 智能体(它的启动方式与裸 SDK 完全一致,使用用户
已有的 `claude` 登录态)且不可被移除。用户可以添加更多智能体,并选择其中一个作为
**默认**智能体。每个会话都以其绑定的智能体启动,若未绑定则使用默认智能体——其
`config` 会按其 `vendor` 标签映射为启动时的覆盖项。

它不负责运行智能体(那是 [agent-session](../../core/agent-session/agent-session-overview.md) 的职责),
也不渲染设置视图(那是 [web-console](../../core/web-console/web-console-overview.md) 的职责)。

见 [agent-config-spec.md](agent-config-spec.md)、[agent-config-models.md](agent-config-models.md)、[agent-config-design.md](agent-config-design.md)。
