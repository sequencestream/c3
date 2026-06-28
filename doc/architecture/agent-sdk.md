## SDK Dependencies

c3 驱动三种 agent vendor，通过各自不同的 SDK，每个 SDK 包装一个宿主 CLI 二进制：

| Vendor | SDK 包                           | 宿主 CLI | GitHub 仓库                                                                                         |
| ------ | -------------------------------- | -------- | --------------------------------------------------------------------------------------------------- |
| Claude | `@anthropic-ai/claude-agent-sdk` | `claude` | [anthropics/claude-agent-sdk-typescript](https://github.com/anthropics/claude-agent-sdk-typescript) |
| Codex  | `@openai/codex-sdk`              | `codex`  | [openai/codex](https://github.com/openai/codex)                                                     |

三个 SDK 的架构差异很大（子进程包装 vs 远程服务），见 [`architecture.md`](architecture.md) 与
[`adr/0011-vendor-neutral-agent-abstraction.md`](adr/0011-vendor-neutral-agent-abstraction.md)。

### SDK 升级纪律

- **定期检查**：每个 SDK **至少每两周**检查一次新版发布。
- **阅读 CHANGELOG**：升级前必须阅读对应 SDK 的 changelog/release notes，评估 breaking change、
  新能力（如新 capability flag、protocol 变更）和废弃特性。
- **串行升级**：一次升一个 SDK，`pnpm typecheck && pnpm lint && pnpm vitest run` 全绿后再升下一个。
- **提交说明**：commit message 中写明升级了什么、涵盖了哪些关键更新。
- **适配器同步**：如果 SDK 变更影响 vendor 中性适配器层，一并更新，
  并在 [`adr/0011-vendor-neutral-agent-abstraction.md`](adr/0011-vendor-neutral-agent-abstraction.md) 的 capability ledger 中反映。
- **升级留痕**：每次升级的逐项 changelog 评估（接入/不接入 + 依据 + 留痕去向）独立成档，
  索引见 [`sdk-upgrade/sdk-upgrade-records.md`](sdk-upgrade/sdk-upgrade-records.md)。

各 SDK changelog 地址：

- Claude Agent SDK — <https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md>
- Codex SDK — <https://github.com/openai/codex/releases>
