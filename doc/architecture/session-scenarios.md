# 跨厂商 prompt 缓存

一次模型调用拆成两段：**system**（稳定、可缓存的指令）与 **user turn**（本轮输入）。必须分离，稳定前缀才能命中厂商 API 的 prompt cache。

系统形状见 [architecture.md](architecture.md)。运行生命周期见 [agent-session](../domains/core/agent-session/agent-session-overview.md)。厂商边界见 [Claude](claude-agent-sdk-guide.md)、[Codex](codex-sdk-guide.md)、[Cursor](../domains/core/agent-session/features/agent-session-cursor.md)。

## 通道

同一份 system 指令按厂商能力落到不同通道：

- **Claude** 有原生 system 追加通道。
- **Codex** 与 **Cursor** 没有 system 角色：同一段指令作为字节稳定前缀——Codex 落在输入的首个文本项，Cursor 落在本轮提示的首段。

## 不变量

多轮工作、意图沟通与规格撰写在三个厂商上都按上述通道拆分。场景生命周期见 [agent-session](../domains/core/agent-session/agent-session-spec.md) 与 [intent-management](../domains/core/intent-management/intent-management-overview.md)。

讨论的研究会话组织者仅 Claude，见 [discussion](../domains/core/discussion/discussion-overview.md)。

team lead 在启动时设置一次 system，之后只推 user turn，前缀保持稳定。流式输入见 [agent-session](../domains/core/agent-session/agent-session-spec.md) 与 [ADR-0008](adr/0008-streaming-input-for-agent-teams.md)。

共识、检查点与意图完成度判定的一次性顾问回合拆成 `{system, user}`，并行投票者共享同一份可缓存前缀。规则见 [共识](../domains/core/permission-gateway/features/permission-gateway-consensus.md) 与 [intent-management](../domains/core/intent-management/intent-management-spec.md)。

## 例外

一次性任务回合按设计保持单字符串：切出的 system 极小，缓存收益可忽略，且整段必须被端到端读取才能消歧强制的工具派发。
