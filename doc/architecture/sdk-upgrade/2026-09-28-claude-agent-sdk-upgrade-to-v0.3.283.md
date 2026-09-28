# Claude Agent SDK 升级记录：0.3.237 → 0.3.283

- **日期**：2026-09-28
- **SDK**：`@anthropic-ai/claude-agent-sdk`
- **版本**：`^0.3.237` → `^0.3.283`
- **锁文件解析**：`0.3.237` → `0.3.283`（changelog 覆盖 `0.3.238` 至 `0.3.283`；parity Claude Code
  v2.1.238–v2.1.283）
- **范围**：仅 Claude SDK。`@openai/codex-sdk`（`0.148.0`）与其它依赖原封不动，`pnpm-lock.yaml`
  diff 仅含 `claude-agent-sdk` 主包 specifier 及其 8 个平台子包的版本号/integrity 行
  （37 增 / 37 删），无 `0.3.237` 残留。间接 `@anthropic-ai/sdk` 仍为 `0.99.0`，c3 零直接引用，
  本轮不单独升。
- **关联指南**：[`../claude-agent-sdk-guide.md`](../claude-agent-sdk-guide.md)
- **上一份**：[`2026-08-21-claude-agent-sdk-upgrade-to-v0.3.237.md`](2026-08-21-claude-agent-sdk-upgrade-to-v0.3.237.md)

## 结论速览

- **零生产代码行为改动。** `server/src/` 无任何非测试改动；新增一份回归测试
  `claude-sdk-0283-compat.test.ts`（7 用例）把本轮「兼容但不接入」的边界钉在 `pnpm vitest run` 上。
- **落定 `^0.3.283`（npm latest）。** 主包发布 `2026-09-25T18:49:24Z`，8 个平台子包均更早；执行时刻
  `2026-09-28T10:09Z` 距完全冷却约 39 小时。未放宽 `minimumReleaseAge`。
- **类型面：0 个导出删除，18 个加性导出**（`prewarm` / `SpareProcess` / `SDKUsageReport` /
  `SDKStartupFailureReason` 等）。`PermissionMode` 联合零变更。`CanUseTool` 第三参加
  `mcpServer` 等可选字段，c3 仍忽略第三参。
- **编译期破坏项对 c3 无影响。** `Settings.attribution` 变为 `boolean | {…}`（读 `.commit` 需收窄）；
  `MonitorInput.persistent` 删除。全仓零消费。
- **产品能力一律不接入。** 只吸收运行时 bugfix（`getSessionMessages` / `listSessions`、robot
  `PreToolUse` 不被 `disableAllHooks` 关掉、`close()` 后不再调过期 permission 回调）。
- **ADR-0011 不更新**，capability ledger 不变。

## 冷却期处置

- 目标即 npm latest `0.3.283`。主包 `2026-09-25T18:49:24Z`；平台子包最早
  `darwin-arm64@0.3.283` `2026-09-25T18:43:14Z`。pnpm 11 `minimumReleaseAge` 24 小时门槛在
  `2026-09-26T18:49Z` 已满。
- `pnpm-workspace.yaml` 零改动，未放宽冷却策略。`pnpm install --frozen-lockfile` 通过。

## changelog 评估（按主题）

窗口内大量版本仅为「Updated to parity with Claude Code v2.1.x」。下面只列碰得到 c3 的条目。

### 行为变化 — 验证、不改产品代码

1. **0.3.265 cwd 跨 turn 保持。** 同一 `query()` 进程里，agent `cd` 后不再在下一条用户消息时重置到
   `options.cwd`。c3 非 team 每轮新 `query({ cwd, resume })`，影响小；team / `pushInput` 长会话与
   交互式 CLI 对齐。权限闸仍用启动时冻结的 `cwd` / `robotRoot`。**不接入、不拆进程。**
2. **0.3.268 task/todo 默认工具面再收缩。** 默认只留给 Claude 3.x / Opus 4.0–4.7 / Sonnet 4.0–4.6 /
   Haiku 4.5。延续 0.3.233：**不注入 `tools` / `allowedTools` / `CLAUDE_CODE_ENABLE_TODO_TOOLS`**。
   指南模型名单已更新。
3. **0.3.269 plan 模式写操作走 `canUseTool`。** 即使已设 `allowDangerouslySkipPermissions`。c3 本来
   就常开该 flag。实跑（宿主 2.1.273 与 SDK 内置 2.1.283）中模型发出了 `Write`，文件未落地；
   `canUseTool` 只收到 `ExitPlanMode`（被拒绝）。Write 未进网关——本机探测用的是第三方模型
   `deepseek-flash`，不能当作 Claude 官方模型上的回归。c3 不为此改代码；`ExitPlanMode` 咽喉就位。
4. **0.3.267 `systemPrompt` append 默认 recording。** c3 在 intent/spec/robot 等路径传 `append`。
   不传 `snapshot: false`。`hide-session-instructions.test.ts` 保持绿。
5. **0.3.243 Read PDF 进 `tool_result`。** `stringifyToolResult` 对非 `text` 块 `JSON.stringify`，
   不崩。不接 PDF 渲染。
6. **0.3.283 `system/informational`。** 以前 stream-json 丢掉的 warning/notice 现在会发。c3 与
   `permission_denied` 一样忽略，不接成 `notice`。SDK 内置 CLI 的 plan 探测实际观察到 1 条
   informational 帧，消息循环未关 turn。
7. **0.3.247 init 上的 `permissionMode` 改为实时值。** c3 不读该字段。

### 自动受益的 bugfix

- `getSessionMessages` / `listSessions` / `forkSession` 多处修复（0.3.274/275/283）。c3 侧栏走
  `sessions.ts` 的 list/get；`forkSession` 仍未调用。
- 0.3.243：`disableAllHooks` 不再关掉 SDK `hooks` 选项里的回调（robot `PreToolUse`）。
- 0.3.261：`query()` 在无 `Symbol.dispose` 的 vm 里不再抛错。
- 0.3.274：`options.mcpServers` 仍会等到连接；settings/plugin 里延后的 MCP 不再空等 2s。
- 0.3.281：`close()` 后不再调用过期 permission 回调；`sdk.mjs` 1.47MB → 0.97MB。
- 新增 `@anthropic-ai/claude-agent-sdk/core` 入口本轮不切（bun compile 仍走主包 + 宿主 CLI）。

### 明确不接入

`verbatimPrompts`、`prewarm` / `SpareProcess`、`readMcpResource`、`permissionPrompts: 'none'`、
`plugin_errors` 展示、`canUseTool` 第三参（`mcpServer` / `defaultToNo` /
`suppressAlwaysAllowRule`）、`Settings.attribution` 类型收窄、`set_max_thinking_tokens` 语义。

**更正旧记录：** 0.3.237 兼容测试写「c3 不传 `hooks`」只对 standard gate 成立；robot gate **会**传
`PreToolUse`。本轮测试拆两条路径。指南「权限回调」段已改成与代码一致。

## 类型 diff（0.3.237 vs 0.3.283 tarball）

- 新增 `core.d.ts` / `core.mjs`（`/core` 入口）。`agentSdkTypes.d.ts` / `bridge.d.ts` /
  `browser-sdk.d.ts` / `extractFromBunfs.d.ts` 仍在。
- `sdk.d.ts` 380209 → 507798 字节；`sdk.mjs` 1367897 → 1148213 字节。
- `PermissionMode` 仍为 `'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'`。
- 新增导出 18 个，删除导出 0 个。c3 全仓不引用新符号。

## ADR-0011 判断

**不更新。** 无新的 vendor 中性能力：hooks 仍仅 robot 使用且不是中性面；task 工具面继续沿用 SDK
默认；`sessions` 子台账与 8 个 boolean flags 不变。`adapters/types.ts` 零改动。

## 验证

- **引用审计：** `MonitorInput.persistent`、`attribution.commit`、`verbatimPrompts`、`prewarm`、
  `permissionPrompts`、`readMcpResource`、`set_max_thinking_tokens` 在 `server/` / `web/` /
  `shared/` 生产代码 **0 命中**（升级记录与兼容测试中的符号名称不算行为残留）。
- `pnpm typecheck`：通过。
- `pnpm lint`（`eslint .`）：0 error。warning 为预存未使用导入，与 SDK 无关。
- `pnpm allcheck`：通过。
- `pnpm vitest run`：**553 测试文件通过 / 1 失败 / 1 跳过；9532 用例通过 / 1 失败 / 14 跳过。**
  失败项为预存的 `server/src/kernel/agent/adapters/types.test.ts`「Codex listTools correctly
  classifies read vs write」——断言 Codex 清单含 Claude 的 `TaskCreate` 等名，而 Codex
  `listTools` 自 2026-06 起就不包含这些名字。与本轮 Claude SDK 升级无关，不夹带修复。
  新增 `claude-sdk-0283-compat.test.ts` 7 用例全绿。
- `server/package.json`：仅 `@anthropic-ai/claude-agent-sdk` `^0.3.237 → ^0.3.283`。
- `pnpm-lock.yaml`：37 增 / 37 删，仅主包 + 8 个平台子包。
- `pnpm-workspace.yaml`：零改动。
- **实跑验证**（`@anthropic-ai/claude-agent-sdk@0.3.283`，本机 `ANTHROPIC_API_KEY` 指向第三方网关，
  init model 为 `deepseek-flash`；`settingSources: []`，`canUseTool` 一律拒绝）：

  | 路径         | CLI     | 新会话           | resume           | permissionMode | tools | 含 task 工具 |
  | ------------ | ------- | ---------------- | ---------------- | -------------- | ----- | ------------ |
  | 宿主 CLI     | 2.1.273 | `result/success` | `result/success` | `default`      | 27    | 是           |
  | SDK 内置 CLI | 2.1.283 | `result/success` | `result/success` | `default`      | 26    | 是           |
  - 两条路径、两个阶段均 `result/success`，无未知消息类型关闭 turn。
  - `pwd` 的 Bash 在本探测中未进入 `canUseTool`（第三方模型 + 空 `settingSources` 下可能被 CLI
    内部放行只读命令）；plan 模式下 `Write` 未落盘，`ExitPlanMode` 进入 `canUseTool` 并被拒绝。
  - SDK 内置 CLI 的 plan 探测观察到 1 条 `system/informational`，c3 消息循环忽略此类帧。
  - c3 主路径经 `findClaudeExecutable` 走宿主 CLI（2.1.273），SDK 内置 CLI 仅兜底。

- 生产代码零行为改动：`server/src/` 下本轮唯一新增是 `claude-sdk-0283-compat.test.ts`。
- 文档：本记录；索引 `sdk-upgrade-records.md`；指南适用版本与 task 工具默认模型名单、robot
  `PreToolUse` 说明同步为 `^0.3.283`。
