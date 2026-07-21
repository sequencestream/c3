# Claude Agent SDK 升级记录：0.3.211 → 0.3.215

- **日期**：2026-07-21
- **SDK**：`@anthropic-ai/claude-agent-sdk`
- **版本**：`^0.3.207` → `^0.3.215`
- **锁文件解析**：`0.3.211` → `0.3.215`
- **原定目标 0.3.216 未采用**：见「0.3.216 未纳入的原因」一节。
- **范围**：仅 Claude SDK。`@openai/codex-sdk`（`0.144.1`）与其它依赖原封不动，`pnpm-lock.yaml`
  diff 仅含 `claude-agent-sdk` 主包 specifier 及其 8 个平台子包的版本号/integrity 行。
- **关联指南**：[`../claude-agent-sdk-guide.md`](../claude-agent-sdk-guide.md)
- **上一份**：[`2026-07-17-claude-agent-sdk-upgrade-to-v0.3.207.md`](2026-07-17-claude-agent-sdk-upgrade-to-v0.3.207.md)

## 结论速览

- **本次唯一需要主动验证的项是 0.3.214 对未知权限模式的显式拒绝。** 验证通过：0.3.215 的
  `PermissionMode` 类型联合与 SDK 内部运行时校验集合均为
  `acceptEdits | auto | bypassPermissions | default | dontAsk | plan`，**完整包含** c3 可产生的五种
  token。c3 无路径能产出集合外的值。已新增测试把该约束钉在 `pnpm typecheck` 上（见「权限模式深评」）。
- 其余变更要么升级即自动受益（CLI argv 编码修复）、要么兼容但忽略（全部加性字段与消息）、
  要么 c3 无消费点。**零生产代码改动。**
- vendor 中性适配器面（`adapters/types.ts` 与 ADR-0011 capability ledger）**未被任何接入触及**：
  8 个 boolean flags 与 neutral permission grid 均不变。
- 未接入 0.3.216（0.3.216 的三项加性字段本次本就属「兼容忽略」，不接入无功能损失）。

## 逐项 changelog 评估

- **`resumeSessionAt` / `sessionId` 破折号开头值的 argv 编码修复（0.3.212）** — 升级即自动受益：
  SDK 内部改用 `--flag=value` 等号形式传参，避免以 `-` 开头的值被 CLI 解析为独立 flag。c3 不自行
  拼装或重写 CLI argv（会话恢复只把 session id 交给 SDK 的 `resume` 选项），因此修复对 c3 完全透明、零代码改动。
- **Agent 工具输出暴露子代理解析后模型名（0.3.212）** — 不接入：c3 对 Agent tool 的 `tool_result`
  经 `stringifyToolResult` 不透明转字符串消费，不解析其结构化字段。中途切换模型后的实际模型名无消费点。
- **Claude Code v2.1.213 引擎同步（0.3.213）** — 兼容确认：纯 CLI 版本同步，无 SDK 功能或类型新增。
- **`set_permission_mode` 拒绝未识别的权限模式（0.3.214）** — **兼容确认（本次唯一深评项）**：
  从静默接受改为显式拒绝。c3 五种 token 全部在 SDK 接受集合内，行为不变。详见「权限模式深评」一节。
  （留痕：本表；「权限模式深评」节；`claude.test.ts` 新增用例）
- **`task-notification` 新增 `subkind: 'scheduled-trigger'`（0.3.214）** — 兼容但忽略：
  `SDKMessageOrigin` 上的可选加性判别字段，用于标记定时任务触发的投递。c3 不读取 origin 的 subkind。
- **`applyFlagSettings({effortLevel})` 类型接受 `'max'`（0.3.214）** — 不接入：c3 不调用
  `apply_flag_settings`。纯类型放宽，无运行时影响。
- **中断消息携带 `aborted: true`（0.3.214）** — 不接入：c3 的中止路径关闭输入流并 best-effort 调用
  `q.interrupt?.()`，消息循环在 abort signal 生效后即停止消费，因此不会走到读取该标记的时机。
  按 spec，不将其转换为用户可见状态；现有 `interrupt()` 调用与其同步异常 / 异步 rejection 的
  吞吐保护均**保留不动**。留待后续意图评估。
- **`tool_progress` 新增 `subagent_type` / `subagent_retry`（0.3.214）** — 兼容但忽略：可选加性字段，
  用于展示子代理因 API 限速重试而等待。本次不生成新的 `ServerToClient` frame、不提升到
  `CanonicalMessage`。UI 展示留待后续意图。
- **`system/init` 的 `plugins` 与 `reload_plugins` 响应含插件 manifest 版本（0.3.214）** — 兼容但忽略：
  加性字段，c3 无插件版本消费点，不新增持久化或公开协议字段。
- **`SessionStart` 钩子 fork 场景报告 `source: "fork"`（0.3.214）** — 不接入：c3 不注册 SDK 侧
  `SessionStart` 钩子（fork 语义由 c3 自有会话模型承担）。修复无害。
- **Claude Code v2.1.215 引擎同步（0.3.215）** — 兼容确认：纯 CLI 版本同步，无 SDK 功能或类型新增。

## 权限模式深评（0.3.214 唯一深入评估项）

**SDK 变化：** `set_permission_mode` 由静默接受未识别模式改为显式拒绝。若 c3 能产出集合外的
token，运行中的模式切换会从「静默降级」变为「控制请求失败」。

**c3 的产出面：** 全部权限模式经由 `claudeModeCatalog`（SoT）与 `permission-map` 的
`toPermissionMode` 收敛。启动参数与运行中的 `driver.ts` `setPermissionMode` 使用**同一映射**，
没有类型断言或任意字符串旁路。可产出集合为固定五项：

`default`、`auto`、`plan`、`acceptEdits`、`bypassPermissions`

**SDK 0.3.215 的接受集合：**

- 类型层（`sdk.d.ts`）：`'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'`
- 运行时校验数组（`sdk.mjs`）：`["acceptEdits","auto","bypassPermissions","default","dontAsk","plan"]`

两者一致，且**完整包含** c3 的五项（SDK 另有 `dontAsk`，c3 不产出）。

**结论：** 0.3.214 的拒绝行为对 c3 现有全部路径**无行为改变**。启动使用的 `default` 与运行时
`setPermissionMode` 生成的任何模式都不会收到 unknown-mode 拒绝。

**回归保障：** `claude.test.ts` 新增用例「only ever produces modes the SDK accepts, across the whole
neutral grid」——遍历 neutral grid 的 2×4 全笛卡尔积断言输出必属 catalog，并用 `satisfies
SdkPermissionMode[]` 把 catalog 的五个 token 钉在 SDK 自身的类型联合上。若未来某次 SDK 升级删除或
重命名其中任一 token，`pnpm typecheck` 立即变红，而不是等到运行时被拒。

**安全边界保持不变：** 权限网关的 allow/deny 决策、审批关联与 default-deny 边界均未触及。
按 spec，未放宽模式类型、未改变权限策略。

## 加性字段的兼容忽略路径确认

0.3.214 / 0.3.216 引入的全部加性字段与消息在 `runClaude` 消息循环中的处理一致：

- 新消息类型在 `for await (const m of q)` 的 type switch 中不匹配 `'assistant'` / `'user'` / `'result'`
  任一分支，无害 fall-through
- 既有消息上的新增**可选**字段（`subkind`、`subagent_type`、`subagent_retry`、`aborted`、
  `tool_result_meta`、`user_message_uuid` 等）不被读取，不影响既有字段的解析
- 不影响 `sawResult`、`sawVisibleOutput`、`isTeam` 等状态变量
- 不关闭 turn（仅 `result` 类型关闭），不产生 wire 内容帧，不生成 `CanonicalMessage` 转换
- 后续到达的消息仍按原顺序工作

## 0.3.216 未纳入的原因

本意图原定目标为 0.3.216，实际交付 0.3.215。原因是**供应链冷却期策略**，非兼容性问题：

- 仓库使用 pnpm 11，其 `minimumReleaseAge` 默认要求依赖发布满 24 小时方可安装。
- 0.3.216 发布于 `2026-07-20T20:19:35Z`；本次升级执行时刻为 `2026-07-21T03:12Z`，仅约 7 小时，
  在冷却期内。`pnpm install` 在 loose 模式下会装上并自动向 `pnpm-workspace.yaml` 追加
  `minimumReleaseAgeExclude` 条目，但该 exclude 对**锁文件校验阶段无效**——后续任何
  `pnpm <script>` 的 deps-status 检查仍会拒绝锁文件，导致他机与 CI 的 `pnpm install` 失败。
- 决策（人工确认）：不放宽 `minimumReleaseAge` 安全策略、不提交冷却期内的锁文件，
  改为落到 0.3.215（发布于 `2026-07-19T00:53:35Z`，已过冷却期）。
- **功能损失为零**：0.3.216 的三项变更（`rewindFiles` 的 `skippedLinks`、用户消息的
  `tool_result_meta`、成功结果的 `user_message_uuid` / `request_sent_wall_ms`）在本意图中本就一律
  属于「兼容忽略、不接入」，未纳入不改变 c3 的任何能力。
- 将 `^0.3.215` 交给 pnpm 后，冷却策略自然把 0.3.216 排除在解析之外，锁文件稳定落在 0.3.215，
  `pnpm-workspace.yaml` 零改动。0.3.216 及其加性字段的接入留待后续 SDK 升级意图。

## ADR-0011 判断

**不更新。** 全部变更为：

1. SDK 内部的 CLI argv 编码修复（`resumeSessionAt` / `sessionId`），c3 不参与 argv 拼装
2. 既有消息上的可选加性字段与新消息类型，c3 无消费点、不产生 vendor 中性能力或 flag
3. 权限模式校验收紧，c3 产出集合完全落在 SDK 接受集合内，语义不变

capability ledger 的 8 个 boolean flags（`interrupt`、`setActionMode`、`streamingPush`、`inProcessMcp`、
`forkSession`、`perToolApproval`、`taskStore`、`nativeUserInput`）与 neutral permission grid 均不受影响。

## 验证

- `pnpm typecheck`：通过（server + web 全绿，SDK 类型无破坏性变化）。
- `pnpm lint`（`eslint .`）：**0 error**。4 个 warning 位于 `server/src/kernel/events/event-match.test.ts`
  与 `shared/src/protocol.test.ts` 的未使用导入，均为本次升级**未触碰**文件上的既有问题，与 SDK 无关。
- `pnpm vitest run` 全量套件：**284 个测试文件（283 通过 / 1 跳过）、3974 个用例（3958 通过 /
  16 跳过）、0 失败**。含权限网关、消息循环、Claude 适配器与 relay e2e 全部回归。
- `server/package.json`：仅 `@anthropic-ai/claude-agent-sdk` `^0.3.207 → ^0.3.215`。
- `pnpm-lock.yaml`：diff 仅含 claude-agent-sdk 主包 specifier + 8 个平台子包的版本号/integrity 行
  （`0.3.211 → 0.3.215`），无关依赖零改动，无 `0.3.216` 残留。
- `pnpm-workspace.yaml`：零改动。
- 权限模式集合：对实际安装的 0.3.215 产物核对 `sdk.d.ts` 类型联合与 `sdk.mjs` 运行时校验数组，
  两者均完整包含 c3 五种 token。
