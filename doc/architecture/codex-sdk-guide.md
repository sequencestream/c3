# Codex 适配边界

本页只写 Codex 适配器相对其它厂商的产品边界：c3 如何面对 Codex 宿主 CLI。系统形状见 [architecture.md](architecture.md)；驱动与分发见 [agent-sdk.md](agent-sdk.md)；运行生命周期见 [agent-session 规格](../domains/core/agent-session/agent-session-spec.md) 与 [设计](../domains/core/agent-session/agent-session-design.md)；中性抽象见 [ADR-0011](adr/0011-vendor-neutral-agent-abstraction.md)。对比 Claude 见 [claude-agent-sdk-guide.md](claude-agent-sdk-guide.md)。本文不适用于 Claude、Cursor。自定义 provider 走中立 relay，见 [relay-architecture.md](relay-architecture.md) 与 [ADR-0029](adr/0029-vendor-neutral-relay-and-agent-group-failover.md)。

SDK 升级评估见 [#486](https://github.com/sequencestream/c3/issues/486)。

## 本地子进程

适配器拉起宿主 `codex` 子进程跑一轮；模型调用与工具执行在该子进程里，不是从本进程直连模型 API。c3 以宿主 CLI 的 JSONL（`codex exec`）形态驱动，不以 JS wrapper 为运行时。prompt 送出后 stdin 关闭，事件流只读，没有写回半通道。对照 architecture.md。

## 宿主 CLI 必达

适配器只驱动探测到的宿主 `codex`。找不到则 Codex 不可用。该二进制由 c3 分发，见 [ADR-0012](adr/0012-host-binary-probe-first-capability-gate.md)。

## 整轮审批

Codex 不具备逐工具审批。门控落在启动时的整轮策略上，回合内审批桥不触发。Claude 才有逐工具回路，见 [claude-agent-sdk-guide.md](claude-agent-sdk-guide.md) 与 [permission-gateway](../domains/core/permission-gateway/permission-gateway-overview.md)。

## 流式输入与 team lead

Codex 没有流式推入，不能成为 agent-team lead。见 agent-session。

## 设置继承

适配器继承用户 `~/.codex` 与项目 `.codex` 的 hook、允许/拒绝规则与 Skill。继承的允许规则可能自动放行浏览器从未见过的工具；未被预先决定的才到网关。c3 是权限网关，不是唯一权威，见 [ADR-0005](adr/0005-inherit-user-project-settings.md)。

## 它如何读取 Skill

Skill 只认单层 `skills/<name>/SKILL.md`，嵌套一层不会被发现（[ADR-0016](adr/0016-external-skill-git-mount.md)）。
