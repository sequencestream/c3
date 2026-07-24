# Claude Agent SDK 升级记录：0.3.215 → 0.3.218

- **日期**：2026-07-24
- **SDK**：`@anthropic-ai/claude-agent-sdk`
- **版本**：`^0.3.215` → `^0.3.218`
- **锁文件解析**：`0.3.215` → `0.3.218`
- **本轮首次纳入 0.3.216**：上一份记录因供应链冷却期落到 0.3.215，0.3.216 的三项加性字段本轮首次评估。
- **范围**：仅 Claude SDK。`@openai/codex-sdk`（`0.144.6`）与其它依赖原封不动，`pnpm-lock.yaml`
  diff 仅含 `claude-agent-sdk` 主包 specifier 及其 8 个平台子包的版本号/integrity 行。
- **关联指南**：[`../claude-agent-sdk-guide.md`](../claude-agent-sdk-guide.md)
- **上一份**：[`2026-07-21-claude-agent-sdk-upgrade-to-v0.3.215.md`](2026-07-21-claude-agent-sdk-upgrade-to-v0.3.215.md)

## 结论速览

- **零生产代码行为改动。** 唯一的生产文件触碰是把团队存活谓词 `isTeamTool` 从私有函数改为
  `export`，纯粹为回归测试提供切入点，行为不变。
- 0.3.216–0.3.218 的全部新增字段一律「兼容忽略」，**未提升为 c3 公共能力**：不新增 wire frame、
  不扩展 `CanonicalMessage`、不新增持久化字段或 UI 状态。
- 0.3.217 的子代理并发上限（默认 20）与嵌套深度收紧（5 → 1）：c3 **不注入**
  `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` / `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`，沿用 SDK 默认。
  c3 的团队存活判定仅由顶层会话工具触发，不依赖孙级代理，深度收紧无影响（见「子代理深度深评」）。
- SDK 内部修复（权限提示重发、429/529 `api_error_status`）随升级自动生效，无需 c3 改动。
- vendor 中性适配器面（`adapters/types.ts` 与 ADR-0011 capability ledger）**未被任何接入触及**：
  8 个 boolean flags、neutral permission grid、`canFormTeam` 能力声明均不变。
- 供应链冷却期：0.3.218 发布于 `2026-07-22T19:55:30Z`，本次执行于 `2026-07-24`，已过 pnpm 11 的
  `minimumReleaseAge` 24 小时门槛。锁文件干净落在 0.3.218，`pnpm-workspace.yaml` 零改动。

## 逐项 changelog 评估

### 0.3.216 — 工具结果元数据 + 回滚跳过计数 + 延迟关联

- **`rewindFiles` 响应新增 `skippedLinks` 计数** — 兼容但忽略：记录回滚安全守卫拒绝恢复/删除的路径数。
  c3 不消费 `rewindFiles` 的结构化响应字段，无展示或持久化点。
- **用户消息新增 `tool_result_meta`（`non_execution_kind` / `user_feedback`）** — 兼容但忽略：本可用于
  免字符串匹配区分被拒绝/中断/取消的 tool 调用，但按 spec 本轮不据此重写规范消息映射；`runClaude`
  继续只从 assistant/user/result 提取当前已用字段，新字段无害 fall-through。留待后续意图评估。
- **成功结果新增 `user_message_uuid` / `request_sent_wall_ms`** — 兼容但忽略：跨主机请求延迟关联的
  可选字段。c3 结果处理不读取，不新增监控接入。

### 0.3.217 — 子代理并发限制 + 嵌套深度收紧 + 远程控制修复

- **子代理并发上限（默认 20，`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` 可覆盖）** — 不接入：默认 20 足够，
  c3 不注入该环境变量。（留痕：`infra/child-env.test.ts` 新增断言 `buildChildEnv` 不合成该键）
- **子代理默认不再生成嵌套子代理（深度 5 → 1，`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` 可放宽）** —
  **需验证项（本轮唯一深评）**：c3 不注入该环境变量，接受默认深度 1。团队存活判定不受影响，见
  「子代理深度深评」。（留痕：本表；「子代理深度深评」节；`agent/team-tool.test.ts`、
  `infra/child-env.test.ts` 新增用例）
- **远程控制会话在提示出现后才连接的客户端未重发待处理权限提示（修复）** — 自动接入：SDK 内部行为
  修复，c3 权限网关与提示投递路径无需改动。
- **Claude Code 引擎同步** — 兼容确认：纯 CLI 版本同步，无 SDK 功能或类型新增。

### 0.3.218 — 技能后台标记 + 模型计费信息 + 限流错误修复

- **`SkillToolOutput` 在分叉技能被调度为分离后台代理时报告 `background: true`** — 兼容但忽略：可用于
  优化技能调度展示，但按 spec 本轮不改变技能调度展示或事件协议。作为未来展示接入点。
- **`modelUsage` 条目新增 `canonicalModel` / `provider`** — 兼容但忽略：为下游计费系统查费率表奠定
  基础。c3 本轮不改变成本计算，作为未来计费/监控接入点。
- **流中传递的限流/过载错误导致 `api_error_status` 报告为 null（修复为正确报告 429/529）** —
  自动接入：SDK 内部修复。c3 现有降级与重试分类基于抛出的错误，不依赖该字段，本轮不重构错误处理路径。
- **Claude Code 引擎同步** — 兼容确认：纯 CLI 版本同步。

## 子代理深度深评（0.3.217 唯一深入评估项）

**SDK 变化：** 子代理默认嵌套深度从 5 降为 1，即子代理默认不再生成孙级代理，除非显式设置
`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`。

**c3 的依赖面：** c3 的团队存活判定（lead 进程是否需要跨 turn 存活以接收队友通知）由
`isTeamTool`（`kernel/agent/index.ts`）决定，其输入是**顶层会话**的工具调用：

- `TeamCreate` / `SendMessage`：仅存在于团队模式，命中即团队；
- 后台 `Agent`（`run_in_background: true`）：分离的异步队友，命中即团队；
- 前台 `Agent`：turn 内完成，不使会话存活。

这三条全部作用于顶层会话直接发起的一级工具调用，**与孙级代理无关**。现有架构已明确不构建深度大于 1
的代理树，因此深度从 5 收紧到 1 不移除任何 c3 依赖的行为，也不需补偿性放宽 `canFormTeam` 能力声明。

**结论：** 深度收紧对 c3 现有全部路径**无行为改变**。一级后台 `Agent` 仍把会话标记为团队，前台
`Agent` 仍不标记。

**回归保障：**

- `agent/team-tool.test.ts` 新增用例：断言后台 `Agent` → 团队、前台 `Agent`（含缺省 /
  `false` / 非 boolean 真值）→ 非团队、`TeamCreate` / `SendMessage` → 团队、普通工具 → 非团队。
- `infra/child-env.test.ts` 新增用例：断言 `KEEPALIVE_ENV_DEFAULTS` 与 `buildChildEnv()` 均不合成
  `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` / `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`（仅当宿主 shell 已
  设置时才透传），把「c3 不覆盖 SDK 默认子代理策略」钉在 `pnpm vitest run` 上。

## 权限模式集合复核（沿用 0.3.214 深评结论）

对实际安装的 0.3.218 产物核对：

- 类型层（`sdk.d.ts`）：`'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'`
- 运行时校验数组（`sdk.mjs`）：`["acceptEdits","auto","bypassPermissions","default","dontAsk","plan"]`

两者与 0.3.215 一致，**完整包含** c3 产出的五种 token（`default`、`auto`、`plan`、`acceptEdits`、
`bypassPermissions`）。`claude.test.ts` 既有 `satisfies SdkPermissionMode[]` 守卫继续把该约束钉在
`pnpm typecheck` 上，无需改动。

## 加性字段的兼容忽略路径确认

0.3.216–0.3.218 引入的全部加性字段与消息在 `runClaude` 消息循环中的处理一致：

- 新消息类型在 `for await (const m of q)` 的 type switch 中不匹配 `'assistant'` / `'user'` / `'result'`
  任一分支，无害 fall-through；
- 既有消息上的新增**可选**字段（`tool_result_meta`、`skippedLinks`、`user_message_uuid`、
  `request_sent_wall_ms`、技能 `background`、`modelUsage.canonicalModel/provider`、`api_error_status`）
  不被读取，不影响既有字段解析；
- 不影响 `sawResult`、`sawVisibleOutput`、`isTeam` 等状态变量；
- 不关闭 turn（仅 `result` 类型关闭），不产生 wire 内容帧，不生成 `CanonicalMessage` 转换。

## ADR-0011 判断

**不更新。** 全部变更为：

1. SDK 内部修复（远程控制权限提示重发、429/529 `api_error_status`），c3 不参与、自动受益；
2. 既有消息上的可选加性字段与新消息类型，c3 无消费点、不产生 vendor 中性能力或 flag；
3. 子代理并发/深度默认收紧，c3 不覆盖默认，团队存活判定不依赖孙级代理，语义不变。

capability ledger 的 8 个 boolean flags（`interrupt`、`setActionMode`、`streamingPush`、`inProcessMcp`、
`forkSession`、`perToolApproval`、`taskStore`、`nativeUserInput`）、neutral permission grid 与
`canFormTeam` 声明均不受影响。

## 验证

- `pnpm typecheck`：通过（server + web 全绿，SDK 类型升级未破坏权限模式约束、消息窄化及 adapter 编译契约）。
- `pnpm lint`（`eslint .`）：**0 error**。4 个 warning 位于 `server/src/kernel/events/event-match.test.ts`
  与 `shared/src/protocol.test.ts` 的未使用导入，均为本次升级**未触碰**文件上的既有问题，与 SDK 无关。
- `pnpm vitest run` 全量套件：**291 个测试文件（290 通过 / 1 跳过）、4168 个用例（4152 通过 /
  16 跳过）、0 失败**。含权限网关、消息循环、Claude 适配器、团队工具识别与新增子代理默认环境回归。
- `server/package.json`：仅 `@anthropic-ai/claude-agent-sdk` `^0.3.215 → ^0.3.218`。
- `pnpm-lock.yaml`：diff 仅含 claude-agent-sdk 主包 specifier + 8 个平台子包的版本号/integrity 行
  （`0.3.215 → 0.3.218`），无关依赖零改动，无 `0.3.215`/`0.3.216`/`0.3.217` 残留。
- `pnpm-workspace.yaml`：零改动，未放宽 `minimumReleaseAge` 冷却策略。
- 权限模式集合：对实际安装的 0.3.218 产物核对 `sdk.d.ts` 类型联合与 `sdk.mjs` 运行时校验数组，
  两者均完整包含 c3 五种 token。
