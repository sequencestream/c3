# 领域: intent-management

- **分组:** core
- **一句话:** 一个项目范围内的意图台账,配合一个只读的意图沟通(intent-communication)
  智能体,把想法拆解为可验证的条目,能发起开发,还能端到端(judge → commit → push → next)
  自动开发被标记的待办积压。
- **负责人:** maintainer
- **状态:** 活跃
- **依赖:** `agent-session`(以 `intent` 种类的运行时来运行沟通智能体、发起开发运行、
  并运行一次性的完成判定器);`permission-gateway`(为保存确认复用 `permission_request`
  传输通道 —— 由保存处理器发起,而非 `canUseTool`,因此厂商的预批准无法绕过它);
  `session-registry`(把沟通会话从常规会话列表中隐藏);一个位于 `~/.c3/c3.db` 的本地
  SQLite 存储;本地 `git` CLI(自动化编排器在验证完成后提交并推送)。
- **被依赖方:** `web-console`(渲染意图视图:列表 + 沟通聊天 + 自动化控件)。
- **exposes-api:** true —— 在 WebSocket `/ws` 上有八个客户端到服务端消息、两个服务端到
  客户端消息(`intents`、`automation_status`)。聊天收发、历史回放、保存确认**复用**
  已有的协议事件;意图列表/发起/自动化相关消息是新增的。消息形状定义在共享协议中,
  不在本文档中重复定义。
- **ADRs:** [0007](../../../architecture/adr/0007-read-only-intent-agent.md)

## 索引

- [intent-management-spec.md](intent-management-spec.md) —— 实体、状态机、用户故事 US-1..US-9、
  业务规则(含自动化编排器 RM-A1–A9)
- [intent-management-design.md](intent-management-design.md) —— SQLite 驱动适配器、
  沟通运行时变体、保存工具、发起开发接线、自动化编排器(状态机 + 完成判定器 + git 辅助)
- [intent-management-models.md](intent-management-models.md) —— Intent / Intent Dependency /
  Communication Session / Automation Status 实体
- [intent-management-codex-save-issue.md](intent-management-codex-save-issue.md) —— 问题分析:
  codex 意图智能体 save_intents 确认框失效(code_mode 沙箱与 gatedSave 长阻塞确认冲突, 待修复)
