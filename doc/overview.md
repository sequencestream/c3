# Specs Knowledge Base — Overview

本目录是 **c3 做什么以及为什么这样做** 的权威来源,停在比代码高一层的意图、边界与取舍。
源代码是 **细节设计如何落地** 的权威来源;要探索细节,读代码,不从文档里翻。两边各自自洽、
互不引用文件;行为变更时同时更新,对照两份文本验证一致性。当两者不一致时,说明其中一方
存在缺陷——需要调和,而不是忽略。

## 如何导航

- 项目的目的、范围、干系人 — [`project.md`](project.md)
- 任何人都不得违反的硬性规则 — [`constitution.md`](constitution.md)
- 某个术语的含义 — [`glossary.md`](glossary.md)
- 系统的形态以及各部分如何连接 — [`architecture/architecture.md`](architecture/architecture.md)
- 为什么做出某个关键决策 — [`architecture/adr/`](architecture/adr/)
- 某个场景的端到端路径 — [`flows/flows.md`](flows/flows.md)
- WebSocket 通信契约 — 编译期真源在共享协议模块;人类目录与约定见 [`shared/api-conventions/websocket-protocol.md`](shared/api-conventions/websocket-protocol.md)
- 前端视觉风格指南 — [`style/color-style-spec.md`](style/color-style-spec.md)
- 性能 / 安全 / 可用性目标 — [`non-functional/`](non-functional/)
- 某个具体能力的行为 — [`features.md`](features.md) 中的领域索引

## 领域(Domains)

c3 有两个业务组:`core`(工作台业务能力)、`settings`(用户配置)。完整领域树以
[`features.md`](features.md) 为准;这里列出主要入口。

### 组 `core`

- [`permission-gateway`](domains/core/permission-gateway/): 按 vendor 能力执行敏感工具门控,将需要人工决策的请求路由到浏览器
- [`agent-session`](domains/core/agent-session/): 通过统一适配层驱动不同 vendor,规范化消息并管理运行生命周期
- [`session-registry`](domains/core/session-registry/): 管理工作区与会话;负责每个会话的模式、最近访问顺序、历史回放
- [`web-console`](domains/core/web-console/): 浏览器 UI:prompt 输入、活动流、权限对话框、模式切换
- [`intent-management`](domains/core/intent-management/): 一个项目范围的意图台账,以及一个只读的意图沟通智能体,负责把想法拆解为可验证的条目,并启动可配置的开发技能
- [`discussion`](domains/core/discussion/): 组织多智能体讨论,把结论沉淀为可执行意图
- [`automations`](domains/core/automations/): 按计划或事件触发智能体工作与业务动作
- [`delivery`](domains/core/delivery/): 聚合意图 PR,验证并推进批次交付
- [`external-mcp`](domains/core/external-mcp/): 向外部智能体和自动化暴露受工作区授权约束的 MCP 能力
- [`im-robot`](domains/core/im-robot/): 聊天机器人:把 agent 能力延伸到办公 IM,群里 @机器人 提问、无人值守跑一轮、把最终回答发回群里;部署级出入口(全局管理 ≠ 无边界访问),外发只经唯一出站守卫

### 组 `settings`

- [`agent-config`](domains/settings/agent-config/): 管理智能体配置(url/key/model + 名称)、默认智能体、专用 agent 路由、按会话绑定
- [`system-setting`](domains/settings/system-setting/system-setting-spec.md): 管理员全局配置(显示/时区/baseUrl、vendor CLI 版本、系统沙箱定义、代理、鉴权、诊断)
- [`workspace-setting`](domains/settings/workspace-setting/workspace-setting-spec.md): 按工作区配置(默认模式、dev 技能、Git 分支策略、沙箱引用、共识、讨论上限、SDD、技能仓库)
- [`personalized-setting`](domains/settings/personalized-setting/personalized-setting-spec.md): 管理账号自己的显示、工作区范围与外部接入配置

## 使用规则

1. **先写规格,后写代码。** 新行为先在这里描述,然后再实现。
2. **上层与细节。** `<domain>-spec.md` 陈述必须遵守的行为与约束;`<domain>-design.md` 陈述模块如何协作与关键取舍。两者都停在上层,不写细节代码设计,不出现源文件名。细节从代码探索。
3. **通信格式的唯一真源。** WebSocket 消息联合与载荷形状只在共享协议模块中定义一次。
   [`websocket-protocol.md`](shared/api-conventions/websocket-protocol.md) 是人类可读的约定与目录;
   领域文档引用消息 `type` 名,不重新定义消息形状,也不链到源文件。
4. **引用,不要复制。** 共享规则只存在一处,并通过编号引用。文档之间可以互相引用;文档不得引用代码文件,代码也不得引用文档。
5. **日期一律使用 `YYYY-MM-DD`。** 业务语义类型优先于技术类型。规格正文不写变更日期;过程账本(升级记录等)放 GitHub Issue。
6. **文档停在上层,细节在代码。** 规格解释意图、边界、不变量与取舍,对照代码校验是否一致;
   不写细节代码设计、不出现源文件名。见 [`constitution.md`](constitution.md) 文档撰写规范与
   [`AGENTS.md`](AGENTS.md)。

## 维护

- 领域按实际需要提供 overview、spec、design、models 或 feature 文档,不创建空壳文件。
- ADR 从不删除;被后续决策替代时标记为 superseded。
