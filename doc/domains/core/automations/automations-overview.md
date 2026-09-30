# Domain: automations

- **Group:** core
- **One-line:** 工作区范围的任务执行:按计划或事件跑命令与 LLM 工作,留下执行记录与专用会话。
- **Owner:** maintainer
- **Status:** active
- **Depends on:** [session-registry](../session-registry/session-registry-spec.md)(工作区身份、自动化会话投影);[agent-session](../agent-session/agent-session-spec.md)(LLM 运行与命令进程);[workspace-setting](../../settings/workspace-setting/workspace-setting-spec.md)(总闸);[agent-config](../../settings/agent-config/agent-config-spec.md)(默认与专用智能体)。
- **Depended on by:** [web-console](../web-console/web-console-spec.md)(列表、表单、记录、回放与工作台总闸);[intent-management](../intent-management/intent-management-spec.md)(评审 / 修复执行面);[im-robot](../im-robot/im-robot-spec.md)(共用工具网格);[discussion](../discussion/discussion-overview.md)(可被订阅,亦可被工具驱动)。
- **exposes-api:** true — WebSocket `/ws`。消息形状在[共享协议](../../../shared/api-conventions/websocket-protocol.md)中定义。
- **ADRs:** [0018](../../../architecture/adr/0018-event-bus-kernel-layer.md) 进程内事件总线

本域拥有**工作区自动化**(cron / 事件的命令与 LLM 任务、执行记录、工作区总闸)。意图**开发队列**(挂起、规格阶段、PR 接力)由 [intent-management](../intent-management/intent-management-spec.md) 拥有,此处只提供执行面,不复制该域的 RM-A 规则。

## Index

- [automations-spec.md](automations-spec.md) — 登记、触发、执行记录、专用会话、身份与工具、总闸
- [automations-design.md](automations-design.md) — 与运行时、注册表、网关、意图队列、事件总线的协作与取舍
- [automations-models.md](automations-models.md) — Automation / Trigger / Execution
