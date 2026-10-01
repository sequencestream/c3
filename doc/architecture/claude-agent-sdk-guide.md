# Claude 适配边界

本页只写 Claude 适配器相对其它厂商的产品边界：c3 如何面对 Claude 宿主 CLI 与其 SDK。系统形状见 [architecture.md](architecture.md)；驱动与分发见 [agent-sdk.md](agent-sdk.md)；运行生命周期见 [agent-session](../domains/core/agent-session.md)；中性抽象见 [ADR-0011](adr/0011-vendor-neutral-agent-abstraction.md)。本文不适用于 Codex、Cursor。

SDK 升级评估见 [#485](https://github.com/sequencestream/c3/issues/485)。

## 常驻子进程

Claude SDK 在 c3 进程内编排与回调；模型调用与工具执行跑在常驻的 `claude` 子进程里。不是从本进程直连模型 API。Cursor 为每轮一个子进程，对照 architecture.md。

## 宿主 CLI 必达

适配器只驱动探测到的宿主 `claude`，不用 SDK 包内自带的可执行文件。找不到则 Claude 不可用，见 [ADR-0012](adr/0012-host-binary-probe-first-capability-gate.md)。

## 逐工具审批

Claude 具备逐工具审批。回合内尚未被策略决定的敏感工具，经审批桥交给 [permission-gateway](../domains/core/permission-gateway.md)，阻塞直到人作答。Codex 与 Cursor 无此回路，门控落在启动策略上。

## 流式输入与 team lead

Claude 具备流式推入，因此可以成为 agent-team 的 lead：进程比单次结果活得更久，运行中途可改模式与中止。目前只有 Claude 有此能力。见 agent-session 与 [ADR-0008](adr/0008-streaming-input-for-agent-teams.md)。

## 设置继承

适配器继承用户 `~/.claude` 与项目 `.claude` 的 hook、允许/拒绝规则、Skill 与 `CLAUDE.md`。Skill 只认单层 `skills/<name>/SKILL.md`，嵌套一层不会被发现（[ADR-0016](adr/0016-external-skill-git-mount.md)）。继承的允许规则可能自动放行浏览器从未见过的工具；未被预先决定的才到网关。c3 是权限网关，不是唯一权威，见 [ADR-0005](adr/0005-inherit-user-project-settings.md)。
