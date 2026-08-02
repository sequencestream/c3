## SDK Dependencies

c3 驱动三种 agent vendor。Claude 与 Codex 各经一个 SDK 包装其宿主 CLI 二进制;
**Cursor 不经 SDK**——c3 直接 spawn 其宿主 CLI(`cursor-agent`)并解析其
`--output-format stream-json` 流(MVP 决策:不引入 `@cursor/sdk`,见
[`adr/0011-vendor-neutral-agent-abstraction.md`](adr/0011-vendor-neutral-agent-abstraction.md)
与 [Cursor 特性文档](../domains/core/agent-session/features/agent-session-cursor.md))。

| Vendor | SDK 包                           | 宿主 CLI       | 来源 / 仓库                                                                                         |
| ------ | -------------------------------- | -------------- | --------------------------------------------------------------------------------------------------- |
| Claude | `@anthropic-ai/claude-agent-sdk` | `claude`       | [anthropics/claude-agent-sdk-typescript](https://github.com/anthropics/claude-agent-sdk-typescript) |
| Codex  | `@openai/codex-sdk`              | `codex`        | [openai/codex](https://github.com/openai/codex)                                                     |
| Cursor | 无(直接驱动 CLI)                 | `cursor-agent` | [Cursor CLI](https://cursor.com/cli)(闭源,运行包 `@anysphere/agent-cli-runtime`,无公开 SDK 仓库)    |

三者的架构差异很大(SDK 子进程包装 vs 直接 CLI 解析 vs 远程服务),见 [`architecture.md`](architecture.md) 与
[`adr/0011-vendor-neutral-agent-abstraction.md`](adr/0011-vendor-neutral-agent-abstraction.md)。

### SDK 升级纪律

适用于经 SDK 接入的 vendor(Claude、Codex):

- **定期检查**：每个 SDK **至少每两周**检查一次新版发布。
- **阅读 CHANGELOG**：升级前必须阅读对应 SDK 的 changelog/release notes，评估 breaking change、
  新能力（如新 capability flag、protocol 变更）和废弃特性。
- **串行升级**：一次升一个 SDK，`pnpm typecheck && pnpm lint && pnpm vitest run` 全绿后再升下一个。
- **提交说明**：commit message 中写明升级了什么、涵盖了哪些关键更新。
- **适配器同步**：如果 SDK 变更影响 vendor 中性适配器层，一并更新，
  并在 [`adr/0011-vendor-neutral-agent-abstraction.md`](adr/0011-vendor-neutral-agent-abstraction.md) 的 capability ledger 中反映。
- **升级留痕**：每次升级的逐项 changelog 评估（接入/不接入 + 依据 + 留痕去向）独立成档，
  索引见 [`sdk-upgrade/sdk-upgrade-records.md`](sdk-upgrade/sdk-upgrade-records.md)。

Cursor 无 SDK 可升级:其 CLI 由用户自行安装、由 Cursor 自动更新,c3 不托管其版本
(外部二进制,见 [`adr/0012-host-binary-probe-first-capability-gate.md`](adr/0012-host-binary-probe-first-capability-gate.md))。
c3 只在解析该外部二进制时按探针固定的 calver 下限(如 `>=2026.07.23`)校验兼容性,
版本不符即判 Cursor agent 类型不可用并向设置页给出"自行升级"提示。当 Cursor CLI 的
流协议或 `--resume` 语义出现需重新验证的变更时,重跑
[`scripts/e2e/cursor-cli-probe.mjs`](../../scripts/e2e/cursor-cli-probe.mjs) 更新探针结论与 calver 下限。

各 SDK changelog 地址：

- Claude Agent SDK — <https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md>
- Codex SDK — <https://github.com/openai/codex/releases>
- Cursor — 无独立 SDK changelog;CLI 版本与发布由 Cursor 管理,c3 以 calver 下限校验兼容。
