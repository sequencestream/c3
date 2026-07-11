# 领域:automations

| 字段 | 值                                                                         |
| ---- | -------------------------------------------------------------------------- |
| 职责 | 管理跨工作区的命令与 LLM 提示的 cron 触发与事件触发执行;记录并查看执行日志 |
| API  | WebSocket `/ws`(见共享协议);订阅内核运行生命周期事件(ADR-0018)             |
| 状态 | 已规划 — 首个规格迭代                                                      |

automations 领域为 c3 增加了**任务执行**能力。一个 **Automation**(自动化)是一个任务 — 一条 shell 命令或一段 LLM
提示 — 会在配置的时间点(cron)触发,或在订阅的**运行生命周期事件**
(`run:started` / `run:settled`,2026-06-08)触发。每次执行都会产生一条 **ExecutionLog**(执行日志)供查看。

自动化是**工作区范围**的:每个自动化都绑定到一个工作区(注册目录,通过
[session-registry](../session-registry/session-registry-spec.md)),同时是**厂商范围**的:自动化声明所属厂商,
执行时解析为该厂商第一个已启用的智能体。厂商的工具清单 — SDK 内置工具加上(对 Claude 而言)工作区 MCP 命名空间前缀 —
在自动化创建时通过 `get_automation_tool_manifest` 列出,供用户选择该自动化可使用的工具。

调度引擎运行在服务端进程内,通过 [agent-session](../agent-session/agent-session-spec.md) 所拥有的同一套运行时基础设施驱动执行。

它不会对自动化运行内的单个工具调用做门控(那是
[permission-gateway](../permission-gateway/permission-gateway-spec.md) 的职责),也不渲染自动化列表或日志查看器
(那是 [web-console](../web-console/web-console-overview.md) 的职责)。

## 索引

- [automations-spec.md](automations-spec.md) — 实体、状态机、任务类型、权限、执行身份、写入队列、v1 排除项
- [automations-design.md](automations-design.md) — 数据库表、CRUD 存储、调度引擎、执行流程
- [automations-models.md](automations-models.md) — Automation 与 ExecutionLog 实体字段定义
