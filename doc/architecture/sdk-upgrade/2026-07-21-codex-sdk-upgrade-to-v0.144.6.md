# Codex SDK 升级记录：0.144.1 → 0.144.6（patch 版本号对齐，dist 字节一致）

- **日期**：2026-07-21
- **SDK**：`@openai/codex-sdk`
- **版本**：`0.144.1` → `0.144.6`（`0.145.0-alpha.*` 仍为预发布线，不纳入）
- **范围**：仅 Codex SDK。`@anthropic-ai/claude-agent-sdk`（`^0.3.215`）与其它依赖号原封不动，
  `pnpm-lock.yaml` 同步（diff 仅含 `@openai/codex-sdk` + 其捆绑的 `@openai/codex` 及六个平台二进制的
  版本号/`integrity` 变化，33 增 / 33 删）。
- **上游 release notes**：区间内共五个稳定版——
  [`rust-v0.144.2`](https://github.com/openai/codex/releases/tag/rust-v0.144.2)、
  [`rust-v0.144.3`](https://github.com/openai/codex/releases/tag/rust-v0.144.3)、
  [`rust-v0.144.4`](https://github.com/openai/codex/releases/tag/rust-v0.144.4)、
  [`rust-v0.144.5`](https://github.com/openai/codex/releases/tag/rust-v0.144.5)、
  [`rust-v0.144.6`](https://github.com/openai/codex/releases/tag/rust-v0.144.6)
- **关联指南**：[`../agent-sdk.md`](../agent-sdk.md)（SDK 升级纪律）、
  [`../codex-sdk-guide.md`](../codex-sdk-guide.md)（适用版本随本次升级更新为 `0.144.6`）、
  [上一份 Codex 记录](2026-07-17-codex-sdk-upgrade-to-v0.144.1.md)

## 结论速览

- **SDK 的编译产物与类型定义两版完全一致（字节级）**：`npm pack` 解包 `0.144.1` 与 `0.144.6` 后
  `diff -rq dist`（`index.d.ts` / `index.js` / `index.js.map`）→ **`DIST IDENTICAL`**；`package.json`
  仅 `version` 与捆绑的 `@openai/codex` 依赖号不同。c3 用到的全部导出（`ApprovalMode` / `SandboxMode` /
  `ThreadEvent` / `ThreadOptions` / `ThreadItem` / `TodoListItem`，均为 `import type`）无任何变化，
  **没有任何 c3 代码因 SDK 接口而需改动**。本次是一次**纯类型层（且类型字节一致）的 patch 版本号对齐**。
- **本区间的全部实质变化都落在 Rust CLI 的 Guardian 审查、危险命令检测与内置指令面，不落在 npm SDK 的
  `dist/` 里。** 与上一份记录同理：npm 依赖升级本身不会给 c3 运行时带来这些改进——运行时行为由 c3
  实际解析的 codex 二进制版本决定（解析优先级为 `$CODEX_PATH` → c3 托管安装 → 宿主 PATH 回退，
  详见上一份记录的「运行时 CLI 来源」，本次未变）。
- **上游的危险命令检测增强与内置指令刷新不构成 c3 的接入面**：前者是 CLI 内部的 shell 命令判定，
  位于 c3 权限网格（`gateToCodexPolicy` 产出的 `sandbox_mode` × `approval_policy`）之下游，
  c3 不重复实现也不据此放宽/收紧映射；后者是模型侧 system prompt，c3 不注入亦不解析。
  上下文窗口修正（272,000 tokens）同属 CLI/模型元数据，c3 无对应配置项。
- vendor 中性适配器面（`adapters/types.ts` 与 capability ledger）未被触及，capability grid 不变。

## 逐项 changelog 评估

分类口径：**兼容且自动获益**（随 CLI 升级生效、无需 c3 改动）／**不适用**（落在 c3 未使用的
app-server / TUI / 安装 / 平台面）。本区间无「后续能力」条目——五个 patch 均未引入新的可选能力面。

| 版本      | 上游条目                                                               | 分类           | 依据                                                                                                                                                                                                |
| --------- | ---------------------------------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0.144.2` | 回滚 Guardian 自动审查的提示词回归，恢复原审查策略、请求格式与工具行为 | 兼容且自动获益 | Guardian 是 CLI 内部的自动审查通道，c3 既不配置也不消费其输出；回滚只是把上游行为恢复到 c3 一直以来所依赖的基线。无 SDK 类型面，无 c3 改动。                                                        |
| `0.144.3` | 仅发布版本，无用户可见变更                                             | 兼容且自动获益 | 纯 release 流水线版本号推进。                                                                                                                                                                       |
| `0.144.4` | 仅 patch 发布，无用户可见变更                                          | 兼容且自动获益 | 同上。                                                                                                                                                                                              |
| `0.144.5` | 改进危险命令检测（覆盖更多强制 `rm` 形式，拒绝原因更清晰）             | 兼容且自动获益 | CLI 侧的 shell 命令安全判定，位于 c3 下发的 `sandbox_mode` / `approval_policy` 之下游。c3 权限网格不变、`perToolApproval: false` 不变；更清晰的拒绝原因经既有 stderr/事件通道透出，翻译层无需适配。 |
| `0.144.6` | 刷新 GPT-5.6 Sol/Terra/Luna 的内置指令                                 | 不适用         | 模型侧 system prompt，随二进制内置。c3 不注入、不解析、不缓存内置指令。                                                                                                                             |
| `0.144.6` | 修正上下文窗口到 272,000 tokens                                        | 不适用         | CLI/模型元数据修正。c3 无上下文窗口配置项，也不据此做分片或截断决策。                                                                                                                               |

## 受影响的特性与契约

无。SDK 接口字节一致 + c3 仅 `import type` 引用 + 运行时走 c3 解析的 codex 二进制 + 全部实质变化落在
CLI 内部的审查/命令判定/内置指令面，以下层面均不受影响：

- 适配器能力账本（`adapters/codex/capabilities.ts`）—— 所有布尔值不变，`perToolApproval: false` 不变。
- vendor 中性接口（`adapters/types.ts`）—— 不变。
- 权限映射（`driver.ts`: `gateToCodexPolicy`）—— 仍只产生 `read-only`/`workspace-write` ×
  `never`/`on-request`/`on-failure`。
- MCP 注入机制（`driver.ts`: `mcpServersToCodexConfig`）—— 输出形状不变。
- 会话存储（`session-store.ts`）—— 只读磁盘 JSONL，不依赖 SDK 导出 API。
- 翻译层（`translate.ts`、`task-store.ts`）—— `ThreadItem` / `TodoListItem` 类型形状不变。
- 中继合约（`transport/relay/`、`kernel/relay/contract.ts`）—— 无变化，继续显式
  `supports_websockets=false`。

不涉及持久化数据、迁移或公共 API。

## 验证

- **SDK dist 字节对比**：`npm pack @openai/codex-sdk@0.144.1 @openai/codex-sdk@0.144.6` 解包后
  `diff -rq dist`（`index.d.ts` / `index.js` / `index.js.map`）→ **`DIST IDENTICAL`**；`package.json`
  仅 `version` + `@openai/codex` 依赖号不同（`0.144.1` → `0.144.6`）。c3 消费的六个类型导出全部覆盖：
  `ApprovalMode` / `SandboxMode`（`driver.ts`）、`ThreadEvent` / `ThreadOptions`（`driver.ts`、
  `codex.test.ts`）、`ThreadItem`（`translate.ts`、`translate.test.ts`）、`TodoListItem`
  （`task-store.ts`、`task-store.test.ts`）——均无变化。
- **锁文件 diff 纯净**：`git diff pnpm-lock.yaml` 触及的包名仅 `@openai/codex-sdk`、`@openai/codex`
  及六个平台包（`darwin-arm64` / `darwin-x64` / `linux-arm64` / `linux-x64` / `win32-arm64` /
  `win32-x64`），33 增 / 33 删，无 Claude SDK 或其它依赖夹带。安装后
  `server/node_modules/@openai/codex-sdk/package.json` 的 `version` 为 **`0.144.6`**，
  锁文件 `specifier: 0.144.6` / `'@openai/codex-sdk@0.144.6'`，三处一致。
- **运行时 CLI 版本核查（两条路径分别取证）**：
  - c3 实际解析：`~/.c3/vendor/manifest.json` → `source: managed`、`selectedVersion: 0.144.6`、
    `latestCompatibleVersion: 0.144.6`、`path: ~/.c3/vendor/codex/0.144.6/bin/codex`。
    **托管 CLI 与本次 SDK 版本精确对齐 ✔**（`$CODEX_PATH` 未设置，故托管生效）。
  - 宿主 PATH：`codex --version` → **`codex-cli 0.144.5`**（`/opt/homebrew/bin/codex`）。
    落后托管一个 patch，但**托管优先于宿主 PATH**，不影响 c3 运行时；且两版在 SDK 类型层零差异。
- **`pnpm typecheck`**：通过（绿），server + web 均 Done。SDK 类型无变化的第二直接证据。
- **`pnpm lint`**：`eslint .` exit 0，**0 error / 4 warning**。4 个 warning 全部为测试文件中未使用的
  导入（`server/src/kernel/events/event-match.test.ts` ×1、`shared/src/protocol.test.ts` ×3），
  属本次改动之外的预存项——本次 diff 仅 `server/package.json` + `pnpm-lock.yaml`，未触及这些文件。
- **`pnpm vitest run`**：**3958 passed / 16 skipped / 0 failed**，无新增跳过项。
- **Codex 定向复核**：`adapters/codex/*` + `transport/relay/*` + `transport/intent-mcp/*` 合计
  **144 passed / 1 skipped**（skip = 需登录 codex 的 intent-mcp e2e）。覆盖 CLI 参数构造、策略映射、
  MCP 配置、流式事件翻译与 todo 快照投影；`relay/e2e.codex.test.ts` 用真实 codex 二进制
  （即托管 `0.144.6`）端到端跑通 relay 路径，确认上游变更未隐式改变现有行为。
