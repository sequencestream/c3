# Specs Knowledge Base — Overview

本目录是 **c3 做什么以及为什么这样做** 的权威来源,停在比代码高一层的意图、边界与取舍。
源代码是 **细节设计如何落地** 的权威来源;要探索细节,读代码,不从文档里翻。两边各自自洽、
互不引用文件。行为变更时同步的是上层契约,不是实现;内部重构而契约不变,文档不动。
对照两份文本验证是否描述同一份行为。当两者不一致时,说明其中一方存在缺陷——需要调和,而不是忽略。

## 如何导航

- 项目的目的、范围、干系人 — [`project.md`](project.md)
- 任何人都不得违反的硬性规则 — [`constitution.md`](constitution.md)
- 某个术语的含义 — [`glossary.md`](glossary.md)
- 系统的形态以及各部分如何连接 — [`architecture/architecture.md`](architecture/architecture.md)
- 为什么做出某个关键决策 — [`architecture/adr/`](architecture/adr/)
- 某个场景的端到端路径 — [`flows/flows.md`](flows/flows.md)
- WebSocket 通信契约 — 形状在共享协议模块;约定见 [`shared/api-conventions/websocket-protocol.md`](shared/api-conventions/websocket-protocol.md)
- 前端视觉风格指南 — [`style/color-style-spec.md`](style/color-style-spec.md)
- 性能 / 安全 / 可用性目标 — [`non-functional/`](non-functional/)
- 某个具体能力的行为 — [`features.md`](features.md) 中的领域索引

## 领域(Domains)

c3 有两个业务组:`core`(工作台业务能力)、`settings`(用户配置)。完整领域树以
[`features.md`](features.md) 为准;这里列出主要入口。

### 组 `core`

- [`permission-gateway`](domains/core/permission-gateway.md): 按 vendor 能力执行敏感工具门控,将需要人工决策的请求路由到浏览器
- [`agent-session`](domains/core/agent-session.md): 通过统一适配层驱动不同 vendor,规范化消息并管理运行生命周期
- [`session-registry`](domains/core/session-registry.md): 管理工作区与会话;负责每个会话的模式、最近访问顺序、历史回放
- [`files`](domains/core/files.md): 只读浏览已登记工作区的仓库
- [`sandbox`](domains/core/sandbox.md): 入选会话的 run 进进程级隔离;驱动不可用则失败不裸跑
- [`web-console`](domains/core/web-console.md): 人观察活动流、提交 prompt、回答权限、切换模式与智能体
- [`intent-management`](domains/core/intent-management.md): 一个项目范围的意图台账,以及一个只读的意图沟通智能体,负责把想法拆解为可验证的条目,并启动可配置的开发技能
- [`discussion`](domains/core/discussion.md): 组织多智能体讨论,把结论沉淀为可执行意图
- [`automations`](domains/core/automations.md): 按计划或事件触发智能体工作与业务动作
- [`delivery`](domains/core/delivery.md): 聚合意图 PR,验证并推进批次交付
- [`auth`](domains/core/auth.md): 连接过身份门;工作区默认拒绝,管理员配置范围
- [`memory`](domains/core/memory.md): 工作区记事本;仅工作会话可写
- [`external-mcp`](domains/core/external-mcp.md): 向外部智能体和自动化暴露受工作区授权约束的 MCP 能力
- [`im-robot`](domains/core/im-robot.md): 聊天机器人:把 agent 能力延伸到办公 IM,群里 @机器人 提问、无人值守跑一轮、把最终回答发回群里;部署级出入口(全局管理 ≠ 无边界访问),外发只经唯一出站守卫

### 组 `settings`

- [`agent-config`](domains/settings/agent-config.md): 管理智能体配置(url/key/model + 名称)、默认智能体、专用 agent 路由、按会话绑定
- [`system-setting`](domains/settings/system-setting.md): 管理员全局配置(显示与时区、CLI 版本、代理、鉴权、诊断)
- [`workspace-setting`](domains/settings/workspace-setting.md): 按工作区配置(权限模式、开发与 Git、沙箱、共识与讨论、规格与自动化)
- [`personalized-setting`](domains/settings/personalized-setting.md): 按人偏好(语言、样式、字号);已认证存服务端

## 使用规则

1. **先写上层规格,后写代码。** 新行为先在这里写清意图、边界与不变量,然后再实现。规格不是实现蓝图;写不下去的细节留给代码。
2. **上层与细节。** 每个域一份 `{domain}.md`,陈述范围、必须遵守的行为、协作与关键取舍;`features.md` 每行一句能力索引。都停在上层,不写细节代码设计,不出现源文件名。细节从代码探索。过细判定与同步范围见 [`constitution.md`](constitution.md) 文档撰写规范与 [`AGENTS.md`](AGENTS.md)。
3. **通信格式的唯一真源。** WebSocket 消息联合与载荷形状只在共享协议模块中定义一次。
   [`websocket-protocol.md`](shared/api-conventions/websocket-protocol.md) 是人类可读的约定;
   领域文档引用消息 `type` 名,不重新定义消息形状,也不链到源文件。
4. **引用,不要复制。** 共享规则只存在一处,并通过编号引用。文档之间可以互相引用;文档不得引用代码文件,代码也不得引用文档。
5. **日期一律使用 `YYYY-MM-DD`。** 业务语义类型优先于技术类型。规格正文不写变更日期;过程账本(升级记录等)放 GitHub Issue。

## 维护

- 每个业务域一份 `{domain}.md`;组索引为 [`core.md`](domains/core/core.md) 与 [`settings.md`](domains/settings/settings.md)。不拆成 overview / spec / design / models。
- ADR 从不删除;被后续决策替代时标记为 superseded。
