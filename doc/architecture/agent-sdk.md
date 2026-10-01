# 厂商 SDK 与宿主 CLI

c3 驱动三个厂商，都落在宿主 CLI 上。Claude 与 Codex 经官方 SDK 拉起由 c3 分发的 CLI；Cursor 由 c3 直接拉起厂商自己分发的 CLI。见 [Cursor 能力边界](../domains/core/agent-session.md#cursor-能力边界)。

差异首先是**谁分发那个二进制**，不是上层怎么编排。系统形状见 [architecture.md](architecture.md)；中性抽象见 [ADR-0011](adr/0011-vendor-neutral-agent-abstraction.md)。

- **Claude** — 宿主 `claude`，c3 分发。适配边界见 [claude-agent-sdk-guide.md](claude-agent-sdk-guide.md)。
- **Codex** — 宿主 `codex`，c3 分发。适配边界见 [codex-sdk-guide.md](codex-sdk-guide.md)。
- **Cursor** — 宿主 `cursor-agent`，厂商分发。能力边界见 [Cursor](../domains/core/agent-session.md#cursor-能力边界)。

找不到二进制则该厂商不可用，见 [ADR-0012](adr/0012-host-binary-probe-first-capability-gate.md)。

SDK 升级评估写在 GitHub Issue，不进本文：Claude 见 [#485](https://github.com/sequencestream/c3/issues/485)，Codex 见 [#486](https://github.com/sequencestream/c3/issues/486)。Cursor 无 SDK 可升，契约变化靠探针与能力台账。
