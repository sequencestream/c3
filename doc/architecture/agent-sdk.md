## SDK Dependencies

c3 驱动三种 agent vendor,每一种都落在一个宿主 CLI 二进制上。Claude 与 Codex 经各自
的官方 SDK 到达那个二进制 —— 两个 SDK 都只是 spawn 它的包装层;Cursor 则由 c3 直接
spawn(见
[Cursor 特性文档](../domains/core/agent-session/features/agent-session-cursor.md))。

- **Claude**
  - 驱动方式: `@anthropic-ai/claude-agent-sdk`
  - 宿主 CLI: `claude`,由 c3 分发
  - 来源: [anthropics/claude-agent-sdk-typescript](https://github.com/anthropics/claude-agent-sdk-typescript)
- **Codex**
  - 驱动方式: `@openai/codex-sdk`
  - 宿主 CLI: `codex`,由 c3 分发
  - 来源: [openai/codex](https://github.com/openai/codex)
- **Cursor**
  - 驱动方式: 直接 spawn
  - 宿主 CLI: `cursor-agent`,由厂商分发
  - 来源: [Cursor CLI 文档](https://cursor.com/docs/cli)(官方安装器分发,按发布日期版本化)

差异集中在**谁分发那个二进制**,而非它怎么被驱动,见 [`architecture.md`](architecture.md) 与
[`adr/0011-vendor-neutral-agent-abstraction.md`](adr/0011-vendor-neutral-agent-abstraction.md)。

### SDK 升级纪律

适用于两个带 SDK 的 vendor:

- **定期检查**：每个 SDK **至少每两周**检查一次新版发布。
- **阅读 CHANGELOG**：升级前必须阅读对应 SDK 的 changelog/release notes，评估 breaking change、
  新能力（如新 capability flag、protocol 变更）和废弃特性。
- **串行升级**：一次升一个 SDK，`pnpm typecheck && pnpm lint && pnpm vitest run` 全绿后再升下一个。
- **提交说明**：commit message 中写明升级了什么、涵盖了哪些关键更新。
- **适配器同步**：如果 SDK 变更影响 vendor 中性适配器层，一并更新，
  并在 [`adr/0011-vendor-neutral-agent-abstraction.md`](adr/0011-vendor-neutral-agent-abstraction.md) 的 capability ledger 中反映。
- **升级留痕**：每次升级的逐项 changelog 评估（接入/不接入 + 依据 + 留痕去向）独立成档，
  索引见 [`sdk-upgrade/sdk-upgrade-records.md`](sdk-upgrade/sdk-upgrade-records.md)。

Cursor 没有 SDK 依赖可升:它的 CLI 由厂商自己的安装器分发,c3 只解析与启动
(见 [`adr/0012-host-binary-probe-first-capability-gate.md`](adr/0012-host-binary-probe-first-capability-gate.md)
的非托管分支)。取而代之的纪律是**契约复验**:当它的帧形状、`--resume` 语义或权限
开关出现变化时,重跑
[`scripts/e2e/cursor-cli-probe.mjs`](../../scripts/e2e/cursor-cli-probe.mjs) 更新探针
结论,再据此调整能力台账。

各 SDK changelog 地址：

- Claude Agent SDK — <https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md>
- Codex SDK — <https://github.com/openai/codex/releases>
- Cursor CLI — <https://cursor.com/docs/cli>(无公开 changelog;以探针结论为准)
