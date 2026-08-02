# Claude Agent SDK 升级记录：0.3.218 → 0.3.220

- **日期**：2026-08-02
- **SDK**：`@anthropic-ai/claude-agent-sdk`
- **版本**：`^0.3.218` → `^0.3.220`
- **锁文件解析**：`0.3.218` → `0.3.220`（跨 0.3.219 / 0.3.220 两个版本）
- **范围**：仅 Claude SDK。`@openai/codex-sdk`（`0.145.0`）与其它依赖原封不动，`pnpm-lock.yaml`
  diff 仅含 `claude-agent-sdk` 主包 specifier 及其 8 个平台子包的版本号/integrity 行
  （37 增 / 37 删），无 `0.3.218`/`0.3.219` 残留。
- **关联指南**：[`../claude-agent-sdk-guide.md`](../claude-agent-sdk-guide.md)
- **上一份**：[`2026-07-24-claude-agent-sdk-upgrade-to-v0.3.218.md`](2026-07-24-claude-agent-sdk-upgrade-to-v0.3.218.md)

## 结论速览

- **零生产代码行为改动。** 唯一新增的生产侧文件是回归测试
  `server/src/claude-sdk-0220-compat.test.ts`，把本轮「兼容但不接入」的边界钉在
  `pnpm vitest run` 上；`server/src/` 下的业务代码一行未动。
- 0.3.219 的全部六项变化 + 0.3.220 的引擎同步，一律**未提升为 c3 公共能力**：不新增 wire frame、
  不扩展 `CanonicalMessage`、不新增持久化字段、UI 状态或配置项。
- 本轮唯一深评项 `cancel_queued`（interrupt 子选项）结论为**兼容但不接入**：不传该选项、不改变当前
  abort 行为、不提前在 `AgentRun` 上暴露 `interrupt()`，也不改动 ADR-0011 capability ledger
  （见「`cancel_queued` 深评」）。
- SDK settings 新增的 `sandbox.network.strictAllowlist` 与 `workflowSizeGuideline`：c3 的 Claude
  启动配置**不构造任何 `settings` 对象**，沿用 SDK 默认、不注入；沙箱网络边界继续由 arapuca wrapper
  与 c3 网络策略单独负责（回归断言见 `claude-sdk-0220-compat.test.ts`）。
- SDK 内部修复（模型切换后 `fast_mode_state` 正确刷新）随升级自动生效，无需 c3 改动。
- vendor 中性适配器面（`adapters/types.ts` 与 ADR-0011 capability ledger）**未被任何接入触及**：
  8 个 boolean flags、neutral permission grid、`canFormTeam` 声明均不变。**ADR-0011 不更新。**
- 供应链冷却期：0.3.220 发布于 `2026-07-24T23:11:19Z`，本次执行于 `2026-08-02`，远超 pnpm 11 的
  `minimumReleaseAge` 24 小时门槛。锁文件干净落在 0.3.220，`pnpm-workspace.yaml` 零改动。

## 逐项 changelog 评估

### 0.3.219 — interrupt 子选项 + fast mode 字段 + 目录 hook + settings 两项

1. **interrupt 控制请求新增可选 `cancel_queued`（capability `interrupt_cancel_queued_v1`）** —
   **兼容但不接入（本轮唯一深评项）**：中断时一并取消排队中与待派发的消息。c3 不传该选项，也不改变
   当前 abort 行为；`ClaudeDriver` 仍不在 `AgentRun` 上暴露 `interrupt()`。详见「`cancel_queued` 深评」。
   （留痕：本表 + 深评节；`adapters/claude/capabilities.ts`、`adapters/claude/driver.ts`、
   `adapters/types.ts` 均不变）
2. **result 与 init 消息新增可选 `fast_mode_disabled_reason`** — 兼容但忽略：供 SDK 宿主解释 fast mode
   为何关闭。c3 不展示、持久化或转发 fast mode 状态，`runClaude` 对 `init`（`system`）/`result` 只读取
   `session_id` 与既有字段，新字段无害 fall-through。（留痕：本表；`claude-sdk-0220-compat.test.ts`
   「fast-mode fields」用例断言其不影响 init/result 既有处理、不泄漏到 wire）
3. **控制协议新增 `DirectoryAdded` 生命周期 hook 事件** — 兼容但忽略 / 不接入：会话中途注册新工作目录
   时触发。它属于 SDK 的 `HOOK_EVENTS` / `HookEvent` 集合（`DirectoryAddedHookInput`），经 hooks 回调
   投递；c3 的 `query()` 调用**不注册任何 hooks**，且该事件不在 `SDKMessage` 流联合中，因此根本不会进入
   `runClaude` 的消息循环。即便防御性地以该形状的消息穿过，`assistant`/`user`/`result` 的 type switch 也
   使其无害 fall-through。（留痕：本表；`claude-sdk-0220-compat.test.ts`「DirectoryAdded」用例断言不产生
   wire 帧、不生成规范消息、不关闭 turn）
4. **修复：模型切换后 initialize 响应仍报告 spawn 时模型的 `fast_mode_state`** — 自动接入：SDK 内部
   修复。c3 不消费 `fast_mode_state`，修复随升级自动生效，无需改动。
5. **SDK settings 类型新增 `sandbox.network.strictAllowlist`** — 沿用默认、不注入：沙箱命令中确定性
   拒绝非白名单主机。该字段位于 SDK `settings.sandbox.network`，且仅 user / managed / CLI（`--settings`）
   来源生效、project settings 被忽略。c3 的 Claude 启动配置不构造或透传任何 `settings` 对象，沙箱网络边界
   继续由 arapuca wrapper 与 c3 网络策略负责。（留痕：本表；`claude-sdk-0220-compat.test.ts`「settings
   fields」用例断言发给 `query()` 的 options 不含 `settings` / `sandbox` / `strictAllowlist`）
6. **SDK settings 类型新增 `workflowSizeGuideline`** — 不接入、不注入：设置 dynamic-workflow 规模的
   建议值（`small`/`medium`/`large`/`unrestricted`，纯建议非硬限）。c3 没有 dynamic-workflow 规模配置面，
   不构造 `settings`，故不新增公共配置、环境变量或默认值。（留痕：本表；同第 5 项的回归断言）

### 0.3.220 — 引擎同步

7. **仅与 Claude Code v2.1.220 引擎对齐** — 兼容确认：无 SDK 功能或类型新增。验证现有适配器行为未被
   引擎同步破坏（权限模式集合、消息循环、`claude.test.ts` 编译期守卫均继续通过）。

## `cancel_queued` 深评（0.3.219 唯一深入评估项）

**SDK 变化：** interrupt 控制请求新增可选布尔字段 `cancel_queued`。为 `true` 时，中断在 abort 当前 turn
之外，一并取消排队中与已出队待派发的 uuid 主线程命令（它们会以终态 `cancelled` 关闭并列入响应的
`cancelled` 字段，`still_queued` 恒为空）；缺省或 `false` 时排队命令存活、列入 `still_queued`——
即 `interrupt_receipt_v1` 契约不变。该能力由 `system/init` 上的 `interrupt_cancel_queued_v1` capability
通告，旧 CLI 忽略该字段、行为同 `false`。

**c3 的依赖面：** c3 的 Claude 适配器对 interrupt 维持「vendor 有能力、run 级未接线」的既有状态：

- `capabilities.ts` 继续声明 `interrupt: true`——这是 **vendor 原生能力**（Claude SDK 确有
  `q.interrupt()`），上层在探测 optional 控制前先读它；
- 但 `ClaudeDriver.start` 返回的 `AgentRun` **仍不暴露 `interrupt()` 方法**（`adapters/types.ts` 中
  `interrupt?()` 声明为 present iff capability）。头部注释明确：`interrupt` 与 `forkSession` 虽 vendor-true
  但尚未接线，留待 AgentDriver-rewrite 阶段；
- `runClaude` 的 abort 处理调用 `q.interrupt?.()` 时**不带任何参数**（`kernel/agent/index.ts`），因此
  `cancel_queued` 永不被置真，行为恒同 `false`——排队消息存活，与升级前完全一致。用户停止操作当前采用的
  「input close + SDK interrupt + abort」组合路径不受影响。

**结论：** 新增子选项**不构成提前完成 interrupt 接线的理由**。本轮维持「兼容但不接入」：不传
`cancel_queued`、不新增 `AgentRun.interrupt()` 实现、不修改排队消息语义。未来若接入 queued-message
cancellation，必须由**独立意图**同时定义 vendor 中性语义、方法参数、能力探测与 ledger 变化。

**ADR-0011 影响：** 无。capability ledger 的 8 个 boolean flags（`interrupt`、`setActionMode`、
`streamingPush`、`inProcessMcp`、`forkSession`、`perToolApproval`、`taskStore`、`nativeUserInput`）不变；
`interrupt` 仍是 vendor-true / run-级未接线，probe 契约（method present ⇒ flag true）方向不变。

## 权限模式集合复核

对实际安装的 0.3.220 产物核对：

- 类型层（`sdk.d.ts`）：`'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'`
- 运行时校验数组（`sdk.mjs`）：`["acceptEdits","auto","bypassPermissions","default","dontAsk","plan"]`

两者与 0.3.218 **逐字一致**，完整包含 c3 产出的五种 token（`default`、`auto`、`plan`、`acceptEdits`、
`bypassPermissions`）。`adapters/claude/claude.test.ts` 既有 `satisfies SdkPermissionMode[]` 守卫继续把
该约束钉在 `pnpm typecheck` 上，无需改动。

## 加性字段的兼容忽略路径确认

0.3.219 引入的全部加性字段与事件在 `runClaude` 消息循环中的处理一致：

- `DirectoryAdded` 是 hook 事件，c3 不注册 hooks，根本不进入流；防御性地即便以消息形状到达，也不匹配
  `'assistant'` / `'user'` / `'result'` 任一分支，无害 fall-through；
- `init`（`system`）与 `result` 上的新增**可选**字段（`fast_mode_disabled_reason`、`fast_mode_state`
  刷新）不被读取，不影响 `session_id` 提取与既有字段解析；
- 不影响 `sawResult`、`sawVisibleOutput`、`isTeam` 等状态变量；
- 不关闭 turn（仅 `result` 类型关闭），不产生 wire 内容帧，不生成 `CanonicalMessage` 转换。

回归测试 `server/src/claude-sdk-0220-compat.test.ts`（驱动真实 `runClaude` + mock SDK `query`，沿用
`socket-resume.test.ts` 模式）把上述三条钉死：DirectoryAdded 无 wire 帧 / 不关 turn；fast mode 字段不影响
init/result 既有处理、不泄漏到 wire；发给 `query()` 的 options 不含 `settings` / `sandbox` /
`strictAllowlist` / `workflowSizeGuideline`。

## ADR-0011 判断

**不更新。** 全部变更为：

1. SDK 内部修复（`fast_mode_state` 模型切换刷新），c3 不参与、自动受益；
2. 既有消息上的可选加性字段（`fast_mode_disabled_reason`）与新 hook 事件（`DirectoryAdded`），c3 无消费点、
   不产生 vendor 中性能力或 flag；
3. interrupt 的 `cancel_queued` 子选项：c3 维持 vendor-true / run-级未接线，不暴露 `interrupt()`，
   probe 契约方向不变；
4. SDK settings 两项（`sandbox.network.strictAllowlist`、`workflowSizeGuideline`）：c3 不构造 `settings`，
   与 vendor 中性适配器面无交集。

capability ledger 的 8 个 boolean flags、neutral permission grid 与 `canFormTeam` 声明均不受影响；
`adapters/types.ts` 零改动。

## 验证

- `pnpm typecheck`：通过（server + web 全绿，SDK 类型升级未破坏权限模式约束、消息窄化及 adapter 编译契约）。
- `pnpm lint`（`eslint .`）：**0 error**。4 个 warning 位于 `server/src/kernel/events/event-match.test.ts`
  与 `shared/src/protocol.test.ts` 的未使用导入，均为本次升级**未触碰**文件上的既有问题（与上一份记录
  完全一致，数量未增），与 SDK 无关。
- `pnpm vitest run` 全量套件（项目默认 pool）：**328 个测试文件通过 / 1 跳过、4969 个用例通过 /
  16 跳过、0 失败**，**无新增 skip**（1 文件 / 16 用例跳过与升级前基线一致）。新增
  `claude-sdk-0220-compat.test.ts`（3 用例）覆盖 DirectoryAdded fall-through、fast mode 字段兼容忽略、
  settings 字段不注入三条边界。
- `server/package.json`：仅 `@anthropic-ai/claude-agent-sdk` `^0.3.218 → ^0.3.220`。
- `pnpm-lock.yaml`：diff 仅含 claude-agent-sdk 主包 specifier + 8 个平台子包的版本号/integrity 行
  （`0.3.218 → 0.3.220`，37 增 / 37 删），无关依赖零改动，无 `0.3.218`/`0.3.219` 残留。
- `pnpm-workspace.yaml`：零改动，未放宽 `minimumReleaseAge` 冷却策略。
- 权限模式集合：对实际安装的 0.3.220 产物核对 `sdk.d.ts` 类型联合与 `sdk.mjs` 运行时校验数组，
  两者逐字一致且均完整包含 c3 五种 token。
- 文档留痕：本记录逐项覆盖七条上游变化；索引 `sdk-upgrade-records.md` 与指南
  `claude-agent-sdk-guide.md` 适用版本同步为 `^0.3.220`；明确「ADR-0011 不更新」及理由。
