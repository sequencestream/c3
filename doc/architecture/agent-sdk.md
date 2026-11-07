# 厂商 SDK 与宿主 CLI

c3 驱动三个厂商，都落在宿主 CLI 上。Claude 与 Codex 经官方 SDK 拉起由 c3 分发的 CLI；Cursor 由 c3 直接拉起厂商自己分发的 CLI。见 [Cursor 能力边界](../domains/core/agent-session.md#cursor-能力边界)。

差异首先是**谁分发那个二进制**，不是上层怎么编排。系统形状见 [architecture.md](architecture.md)；中性抽象见 [ADR-0011](adr/0011-vendor-neutral-agent-abstraction.md)。

- **Claude** — 宿主 `claude`，c3 分发。适配边界见 [claude-agent-sdk-guide.md](claude-agent-sdk-guide.md)。
- **Codex** — 宿主 `codex`，c3 分发。适配边界见 [codex-sdk-guide.md](codex-sdk-guide.md)。
- **Cursor** — 宿主 `cursor-agent`，厂商分发。能力边界见 [Cursor](../domains/core/agent-session.md#cursor-能力边界)。
- **DSH（实验性）** — 宿主 `dsh --profile sdk`，stdio JSON-RPC 子进程；c3 可分发 `@deepseek-ai/dsh@0.2.2-rc.1`，要求 Node ≥ 24.9。无线级 cancel，停止即收敛子进程。能力边界与版本记录见 [deepseek-harness-c3-feasibility.md](deepseek-harness-c3-feasibility.md) 与 [#506](https://github.com/sequencestream/c3/issues/506)。

找不到二进制或 Node 不满足则该厂商不可用，见 [ADR-0012](adr/0012-host-binary-probe-first-capability-gate.md)。

SDK 升级评估写在 GitHub Issue，不进本文：Claude 见 [#485](https://github.com/sequencestream/c3/issues/485)，Codex 见 [#486](https://github.com/sequencestream/c3/issues/486)。Cursor 无 SDK 可升，契约变化靠探针与能力台账。
