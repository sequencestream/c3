# 跨领域流程(Cross-domain Flows)— 索引

**flow(流程)**是一个有序的、跨领域的业务场景:它把多个领域各自拥有的规则串接起来,描述贯穿 c3
的一条端到端路径。流程**不会**重述领域规则——每一步都引用其所属领域的规则 ID(`AS-R*`、
`SR-R*`、`PG-R*`、`RM-R*`、`RM-A*`、`SCH-R*`、`AC-R*`、`AUTH-R*`、`PL-R*`)。要了解*某条规则的含义*,
请阅读对应的领域规格;要了解*事情发生的顺序以及分支在哪里*,请阅读流程文档。

线路消息的结构统一定义在
[WebSocket 协议契约](../shared/api-conventions/websocket-protocol.md)中。
流程文档只会点出消息名称,不会重新定义其结构。

## 流程一览

| 流程                                                            | 场景                                                                        | 涉及的领域                                                                               |
| --------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| [prompt → gated run(受门控的运行)](flow-prompt-to-gated-run.md) | 一条 prompt 变成一次运行；敏感工具会被门控(先共识后人工)；文本流式回传      | web-console · session-registry · agent-config · agent-session · permission-gateway       |
| [工作区与会话生命周期](flow-workspace-session-lifecycle.md)     | 注册工作区,创建/选择/绑定/重命名/删除会话,冻结其厂商                        | web-console · session-registry · agent-session · agent-config                            |
| [运行的韧性](flow-run-resilience.md)                            | 一次运行在断开 socket、智能体故障或厂商不可达时依然不丢失上下文             | agent-session · agent-config · permission-gateway                                        |
| [意图 → 开发](flow-intent-to-development.md)                    | 一个想法被细化为可验证的意图,再挑一个启动为后台工作会话                     | intent-management · agent-session · permission-gateway · session-registry · agent-config |
| [自动化编排器](flow-automation-orchestrator.md)                 | 一批标记为 `automate` 的意图逐一被构建:开发、评判、提交/推送、推进          | intent-management · agent-session · permission-gateway · git                             |
| [讨论 → 意图](flow-discussion-to-intent.md)                     | 对一个目标进行调研,由组织者主持的圆桌讨论得出结论,再转化为多个意图          | discussion · agent-config · intent-management                                            |
| [自动化执行](flow-automation-execution.md)                      | cron/事件触发器触发一个命令或 LLM-prompt 任务,以某个执行身份运行;结果被记录 | automations · session-registry · agent-session                                           |
| [auth 登录门](flow-auth-login.md)                               | 一个连接在驱动智能体之前先完成身份认证(这是对外暴露到网络的前置条件)        | auth · web-console · system-config                                                       |
| [激活与授权](flow-activation-and-entitlement.md)                | 用户购买并激活；心跳保持安装持续获得授权；失效只会门控新会话的创建          | product-license · web-console · session-registry · license-server                        |

## 阅读约定

每个流程文件遵循相同的结构:顶部是**流程图**(整条路径的 Mermaid 图),接着是**步骤描述**
(按顺序编排的小节),最后是**分支与异常**。

- **actor(参与者)**是各个领域(或 SDK / 浏览器 / 操作系统),而非类。一个步骤读作
  `actor → action`。
- **分支与异常**列出各种备选路径以及反面场景(哪些事情*绝不能*发生),并各自关联禁止该行为的
  规则。
- 流程反映的是**当前状态**。若某一步描述的是计划中/尚未完成的行为,会在行内标注,并引用该领域的
  状态说明。
