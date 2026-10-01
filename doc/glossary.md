# Glossary

c3 文档的术语索引。此处只给短定义并指向权威文档，不重复领域规格。

- **c3**：Code Creative Center。通过浏览器集中驱动多个 AI 编码智能体，并对其工具调用进行门控的工作台。
- **Agent run**：一次用户提示驱动的单次智能体运行，流式给出文本、工具活动与权限请求，直至完成或出错。见 [agent-session](domains/core/agent-session.md)。
- **Permission decision**：用户对权限请求的应答：允许或拒绝。见 [permission-gateway](domains/core/permission-gateway.md)。
- **Permission mode**：该会话上工具调用的策略，按会话持久化。厂商原生模式经目录解释为中立网格；网格见 [agent-session](domains/core/agent-session.md)。
- **Sensitive tool**：当前模式下须经审批才可执行的工具；只读工具自动放行。见 [permission-gateway](domains/core/permission-gateway.md)。
- **Wire protocol**：浏览器与服务端在 `/ws` 上交换的 JSON 消息契约。见 [WebSocket 协议](shared/api-conventions/websocket-protocol.md)。
- **Authentication（认证）**：允许连接驱动智能体之前，确认它是谁。是否启用由使用者决定。见 [认证域](domains/core/auth.md)。
- **Workspace / workspace name（工作区 / 工作区名称）**：已注册的工作区；名称是全局唯一且不可变的身份。协议与台账用名称关联，磁盘路径只表示位置。见 [session-registry](domains/core/session-registry.md)。
- **Session**：工作区内一次由厂商支撑的对话。执行由进程级 Session Runtime 拥有；连接一次只查看一个会话。运行不绑定连接（[ADR 0006](architecture/adr/0006-decouple-runs-from-connections.md)）。
- **Session Runtime**：进程级的会话运行所有者。跨连接共享；切换查看或断连后仍存活。见 [agent-session](domains/core/agent-session.md)。
- **Viewed session**：某连接当前查看的唯一会话。该连接的下一 prompt 针对它；切换查看不停止前一会话的运行。
- **SessionKind**：一次运行的**业务场景**（由哪种场景产生）。种类清单见 [session-registry](domains/core/session-registry.md) 与 [agent-session](domains/core/agent-session.md)。
- **活动角标**：会话分类数、业务条目数、工作区运行中总数是三个互不替代的数，由服务端角标投影提供；工作台通知角标是该工作区待办台账的权威 todo 数。口径见 [session-registry](domains/core/session-registry.md) 与 [web-console](domains/core/web-console.md)。
- **活动状态注册表**：进程内当前活动事实容器。与事件总线正交：总线记录已发生的事，注册表回答现在有哪些活动。见 [agent-session](domains/core/agent-session.md)、[ADR-0050](architecture/adr/0050-activity-registry-as-current-state.md)。
- **角标投影**：从活动成员集合与三类 attention 成员集合派生的 Workspace 摘要（运行中会话、种类分桶、活动 owner、待办 / 权限 / 交付）。见 [agent-session](domains/core/agent-session.md)、[ADR-0051](architecture/adr/0051-badge-projection-from-activity-sets.md)、[ADR-0052](architecture/adr/0052-attention-sets-in-badge-projection.md)、[ADR-0053](architecture/adr/0053-activity-snapshot-delta-protocol.md)。
- **RunKind**：一次运行的**执行形态**（如何执行），与 SessionKind 正交。种类清单同上。
- **turn_end**：一次 prompt→result 轮次的终止性服务端事件。不结束会话。见 [agent-session](domains/core/agent-session.md)。
- **Vendor CLI**：各厂商用来运行智能体的宿主可执行文件。解析不到则该厂商不可用。见 [agent-sdk](architecture/agent-sdk.md)、[ADR-0012](architecture/adr/0012-host-binary-probe-first-capability-gate.md)。
- **Streaming input**：把 prompt 作为持续输入推入存活会话，而非一次性字符串。见 [agent-session](domains/core/agent-session.md)、[ADR-0008](architecture/adr/0008-streaming-input-for-agent-teams.md)。
- **Agent team**：团队负责人将工作委派给队友的编排；识别后该会话在轮次之间保持存活。见同上。
- **Team lead**：智能体团队的主智能体。其进程在各轮次之间保持存活以协调队友，直至用户显式停止。
- **Pending intent**：尚未运行的会话想要使用的智能体，可改可清（[ADR-0015](architecture/adr/0015-session-agent-binding-vendor-ownership.md)）。
- **Session fact / vendor freeze**：已落定的会话所用智能体及其冻结厂商。厂商不可变：转录只存在于该厂商原生存储（[ADR-0015](architecture/adr/0015-session-agent-binding-vendor-ownership.md)）。
- **Intent（意图）**：项目范围内一条持久的工作单元。见 [意图管理](domains/core/intent-management.md)。
- **Workspace memory（工作区记忆）**：工作区级持久结论——仓库无法自证、也不适合写进仓库文档的偏好与约束。见 [记忆域](domains/core/memory.md)。
- **Spec document（规范文档）**：开发之前从某个 intent 撰写、供独立评审的规格。见 [意图管理](domains/core/intent-management.md)。
- **release**：多平台产物的编排与公开分发。二进制名为 `c3` / `c3.exe`。见 [发布规格](non-functional/release.md)。
- **self-update（自更新）**：把新版发行包校验到暂存，管理员确认后替换自身并重启。见 [self-update](domains/core/self-update.md)。

## 机器人

- **机器人**：c3 部署级的办公 IM 出入口。实例共用一套配置与名册，不按工作区分区；管理面跨工作区一致，不等于 IM 侧可无边界访问数据。见 [im-robot](domains/core/im-robot.md)。
