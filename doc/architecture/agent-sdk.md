## SDK Dependencies

c3 驱动三种 agent vendor,全部经各自的官方 SDK。Claude 与 Codex 的 SDK 包装一个
宿主 CLI 二进制;**Cursor 的 SDK 自带 local runtime,在 c3 服务进程内执行** ——
没有宿主 CLI,没有子进程(见
[Cursor 特性文档](../domains/core/agent-session/features/agent-session-cursor.md))。

| Vendor | SDK 包                           | 宿主 CLI           | 来源 / 仓库                                                                                         |
| ------ | -------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------- |
| Claude | `@anthropic-ai/claude-agent-sdk` | `claude`           | [anthropics/claude-agent-sdk-typescript](https://github.com/anthropics/claude-agent-sdk-typescript) |
| Codex  | `@openai/codex-sdk`              | `codex`            | [openai/codex](https://github.com/openai/codex)                                                     |
| Cursor | `@cursor/sdk`                    | 无(进程内 runtime) | [Cursor SDK 文档](https://cursor.com/docs/sdk/typescript)(闭源,平台原生包按 os/arch 解析)           |

三者的架构差异很大(SDK 子进程包装 vs 进程内 runtime vs 远程服务),见 [`architecture.md`](architecture.md) 与
[`adr/0011-vendor-neutral-agent-abstraction.md`](adr/0011-vendor-neutral-agent-abstraction.md)。

### SDK 升级纪律

适用于全部三个 vendor:

- **定期检查**：每个 SDK **至少每两周**检查一次新版发布。
- **阅读 CHANGELOG**：升级前必须阅读对应 SDK 的 changelog/release notes，评估 breaking change、
  新能力（如新 capability flag、protocol 变更）和废弃特性。
- **串行升级**：一次升一个 SDK，`pnpm typecheck && pnpm lint && pnpm vitest run` 全绿后再升下一个。
- **提交说明**：commit message 中写明升级了什么、涵盖了哪些关键更新。
- **适配器同步**：如果 SDK 变更影响 vendor 中性适配器层，一并更新，
  并在 [`adr/0011-vendor-neutral-agent-abstraction.md`](adr/0011-vendor-neutral-agent-abstraction.md) 的 capability ledger 中反映。
- **升级留痕**：每次升级的逐项 changelog 评估（接入/不接入 + 依据 + 留痕去向）独立成档，
  索引见 [`sdk-upgrade/sdk-upgrade-records.md`](sdk-upgrade/sdk-upgrade-records.md)。

Cursor 的特殊之处在于**没有宿主 CLI 可探测**:`@cursor/sdk` 随 c3 依赖发布,
可用性即"该包能否被解析",因此它不进入 `HOST_BINARIES`,也不参与
[`adr/0012-host-binary-probe-first-capability-gate.md`](adr/0012-host-binary-probe-first-capability-gate.md)
的二进制探测链。升级即普通依赖升级;当其消息流形状或 `Agent.resume` 语义出现需
重新验证的变更时,重跑
[`scripts/e2e/cursor-sdk-probe.mjs`](../../scripts/e2e/cursor-sdk-probe.mjs) 更新探针结论。
注意 SDK 会按 os/arch 解析平台原生包,故单文件二进制发布将其排除在 bundle 之外 ——
二进制中 Cursor 不可用。

各 SDK changelog 地址：

- Claude Agent SDK — <https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md>
- Codex SDK — <https://github.com/openai/codex/releases>
- Cursor SDK — <https://cursor.com/docs/sdk/typescript>(无公开 changelog;以 npm 版本与探针结论为准)
