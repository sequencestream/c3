# Specs Knowledge Base — Overview

本目录是 **c3 做什么以及为什么这样做** 的权威来源(source of truth)。源代码是
**它今天是如何做到的** 的权威来源;文档描述代码必须满足的预期行为。当两者不一致时,
说明其中一方存在缺陷——需要调和,而不是忽略。

## 如何导航

| 如果你想知道…                | 请阅读                                                                                         |
| ---------------------------- | ---------------------------------------------------------------------------------------------- |
| 项目的目的、范围、干系人     | [`project.md`](project.md)                                                                     |
| 任何人都不得违反的硬性规则   | [`constitution.md`](constitution.md)                                                           |
| 某个术语的含义               | [`glossary.md`](glossary.md)                                                                   |
| 系统的形态以及各部分如何连接 | [`architecture/architecture.md`](architecture/architecture.md)                                 |
| 为什么做出某个关键决策       | [`architecture/adr/`](architecture/adr/)                                                       |
| 某个场景的端到端路径         | [`flows/flows.md`](flows/flows.md)                                                             |
| WebSocket 通信契约           | [`shared/api-conventions/websocket-protocol.md`](shared/api-conventions/websocket-protocol.md) |
| 前端视觉风格指南             | [`style/style-spec.md`](style/style-spec.md)                                                   |
| 性能 / 安全 / 可用性目标     | [`non-functional/`](non-functional/)                                                           |
| 某个具体能力的行为           | [`domains/core/`](domains/core/)                                                               |

## 领域(Domains)

c3 有两个业务组:`core`(智能体循环)、`settings`(用户配置)。

### 组 `core`

| 领域                                                     | 职责                                                                                                    |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| [`permission-gateway`](domains/core/permission-gateway/) | 拦截 SDK 权限请求,将其路由到浏览器,阻塞直到用户做出决定(运行中止则视为拒绝)                             |
| [`agent-session`](domains/core/agent-session/)           | 驱动 SDK 的 `query()` 循环,把 SDK 消息映射为通信协议,管理权限模式与运行生命周期                         |
| [`session-registry`](domains/core/session-registry/)     | 管理工作区与会话;负责每个会话的模式、最近访问顺序、历史回放                                             |
| [`web-console`](domains/core/web-console/)               | 浏览器 UI:prompt 输入、活动流、权限对话框、模式切换                                                     |
| [`intent-management`](domains/core/intent-management/)   | 一个项目范围的意图台账,以及一个只读的意图沟通智能体,负责把想法拆解为可验证的条目,并启动可配置的开发技能 |

### 组 `settings`

| 领域                                                                                | 职责                                                                                    |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| [`agent-config`](domains/settings/agent-config/)                                    | 管理智能体配置(url/key/model + 名称)、默认智能体、专用 agent 路由、按会话绑定           |
| [`system-setting`](domains/settings/system-setting/system-setting-spec.md)          | 管理员全局配置(显示/时区/baseUrl、vendor CLI 版本、系统沙箱定义、代理、鉴权、诊断)      |
| [`workspace-setting`](domains/settings/workspace-setting/workspace-setting-spec.md) | 按工作区配置(默认模式、dev 技能、Git 分支策略、沙箱引用、共识、讨论上限、SDD、技能仓库) |

## 使用规则

1. **先写规格,后写代码。** 新行为先在这里描述,然后再实现。
2. **WHAT 与 HOW。** `<domain>-spec.md` 文件陈述业务行为;`<domain>-design.md` 文件陈述
   技术实现。两者要分开。
3. **通信格式的唯一真源。** WebSocket 协议只在
   [`shared/api-conventions/websocket-protocol.md`](shared/api-conventions/websocket-protocol.md)
   中记录一次。领域文档引用该文档;不重新定义消息形状。
4. **引用,不要复制。** 共享规则只存在一处,并通过编号引用。
5. **日期一律使用 `YYYY-MM-DD`。** 业务语义类型优先于技术类型。
6. **保持设计高度,而非代码堆砌。** 规格清晰地解释变更——方式、流程、逻辑、状态与规则——
   并对照真实代码库进行校验,而不穷举式地列出低层级代码细节(完整源码树列表,或
   逐文件/逐符号检查清单),因为那会与源码重复并随之漂移失步。在边界高度描述受影响的
   能力与契约;共享契约只记录一次,并通过编号引用。见
   [`constitution.md`](constitution.md) 文档撰写规范一节。

## 维护

- 初始化于 2026-05-29。
- 每个领域都有 `<domain>-overview.md`、`<domain>-spec.md`、`<domain>-design.md`、`<domain>-models.md`。
- 废弃内容移动到 `archived/`;ADR 从不删除,只会被取代(superseded)。
