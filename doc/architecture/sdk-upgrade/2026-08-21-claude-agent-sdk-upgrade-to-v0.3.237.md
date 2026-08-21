# Claude Agent SDK 升级记录：0.3.233 → 0.3.237

- **日期**：2026-08-21
- **SDK**：`@anthropic-ai/claude-agent-sdk`
- **版本**：`^0.3.233` → `^0.3.237`
- **锁文件解析**：`0.3.233` → `0.3.237`（跨 `0.3.234` 至 `0.3.237`，共 4 个已发布版本；npm 上
  0.3.233 与 0.3.234 之间无缺口）
- **范围**：仅 Claude SDK。`@openai/codex-sdk`（`0.147.0`）与其它依赖原封不动，`pnpm-lock.yaml`
  diff 仅含 `claude-agent-sdk` 主包 specifier 及其 8 个平台子包的版本号/integrity 行
  （41 增 / 41 删），无 `0.3.233` 残留。
- **关联指南**：[`../claude-agent-sdk-guide.md`](../claude-agent-sdk-guide.md)
- **上一份**：[`2026-08-16-claude-agent-sdk-upgrade-to-v0.3.233.md`](2026-08-16-claude-agent-sdk-upgrade-to-v0.3.233.md)

## 结论速览

- **零生产代码行为改动。** `server/src/` 无任何非测试改动；新增一份回归测试
  `claude-sdk-0237-compat.test.ts`（6 用例）把本轮「兼容但不接入」的边界钉在 `pnpm vitest run` 上。
- **落定 `^0.3.237` 而非目标 `^0.3.238`，原因是供应链冷却期。** 详见「冷却期处置」。
- **本轮唯一编译期破坏项是 0.3.234 从 `ExitReason` / `EXIT_REASONS` 移除
  `bypass_permissions_disabled`**（该值从未被运行时 emit）。**c3 全仓零消费**（`server/`、`web/`、
  `shared/`、测试夹具、现行文档均无 `ExitReason` / `EXIT_REASONS` / `bypass_permissions_disabled`
  命中），因此破坏项对 c3 无影响。结论为「编译期破坏、运行时零影响」。
- **两个 parity 版本（0.3.235 / 0.3.237，对齐 Claude Code v2.1.235 / v2.1.237）逐条实跑核对**：
  新会话 + resume 在宿主 CLI 与 SDK 内置 CLI 两条路径均 `result/success`，工具面完整、权限模式
  `default`、`canUseTool` 咽喉就位。**无默认工具面收敛、无权限行为变更、无 model 别名变更。**
  实跑证据见「实跑验证」。
- **实跑发现宿主 CLI 为 2.1.227**，低于两个 parity 版本；且 c3 经 `resolveHostBinary` 优先走宿主
  CLI，SDK 内置 CLI 仅作兜底。因此 parity 版本内嵌的 CLI 行为变更仅在「宿主 CLI 缺失」的部署下
  才生效，而 c3 的主路径在本次升级后仍跑 2.1.227。
- **`SDKSystemMessage.effort`（0.3.234）不接入**：c3 不读取、不回显、不新增 wire/持久化字段。
  模型目录已有自己的推理档位表达，单次 init 遥测不是产品能力。
- **`SDKAssistantMessageError.account_on_hold`（0.3.236）**：账号级终态错误，沿既有 unknown 路径
  呈现。c3 的降级入口 `isDegradableError` 只分类抛错文本；`assistant.error` 结构化字段不经过该
  分类器，不把 Claude vendor 标为整体不可用。已用回归断言钉住「沿 unknown 路径、不关 turn、不落
  wire」。
- **`PostToolUseHookOutput.classifierContext`（0.3.236）、`origin.fromMode`（0.3.234）、
  `command_lifecycle` `refused`（0.3.238）等 hooks / peer 通道变更一律不接入**：c3 不向 SDK 传
  `hooks`，不使用跨会话 peer 通道。
- **其余加性变更（`ApiKeySource` 扩宽、`task_started` 新字段、`vcs_state_changed` 目录/逐分支、
  `UserPromptExpansion.suppressOriginalPrompt`、`hooks_applied` 修复、`prompt_suggestion` 修复、
  SDK 内建 Artifact/PR/代码执行工具面扩张）全部兼容忽略**：c3 无对应产品面或白名单，不加接。
- **ADR-0011 不更新**，capability ledger 不变（理由见「ADR-0011 判断」）。

## 冷却期处置

- 目标版本为 `^0.3.238`（npm latest，`2026-08-20T18:02:54Z` 发布）。
- pnpm 11 `minimumReleaseAge` 24 小时门槛：0.3.238 主包要到 `2026-08-21T18:02Z` 才满冷却；
  且其 8 个平台子包中最晚的 `linux-x64-musl@0.3.238`（`2026-08-20T18:21:46Z`）要到
  `2026-08-21T18:21Z` 才完全冷却。
- **执行时刻（`2026-08-21T00:21Z`）距 0.3.238 完全冷却约 18 小时。** 依据本仓库
  `2026-07-21` 升级记录确立的决策（该 exclude 对锁文件校验阶段无效，提交冷却期内的锁文件会让
  他机与 CI 的 `pnpm install` 失败），不放宽/不豁免冷却策略。
- 退档至 `^0.3.237`（主包 `2026-08-19T23:58:53Z`，8 个子包最晚 `linux-x64-musl@0.3.237`
  `2026-08-20T02:22:31Z`，完全冷却于 `2026-08-21T02:22Z`）。
- 选择依据：**功能损失为零**。0.3.238 的全部 6 项变更（`task_started` 新字段、`suppressOriginalPrompt`、
  `command_lifecycle` `refused`、`hooks_applied` 修复、`prompt_suggestion` 修复、`vcs_state_changed`
  逐分支 push）在本意图中一律「不接入」——c3 不传 hooks、不用 peer 通道、不消费这些事件。因此
  0.3.237 与 0.3.238 对 c3 的功能价值完全相同。排在本意图之后的 Codex SDK 升级意图可立刻解锁。
- 下一轮双周升级自然吸收 0.3.238。

## 逐项 changelog 评估

### 0.3.234 — ExitReason 破坏 + ApiKeySource 对齐 + vcs 目录 + peer origin + effort

1. **`ExitReason` / `EXIT_REASONS` 移除 `bypass_permissions_disabled`**（破坏性，编译期）。
   **不接入（自动）。** c3 全仓零引用该符号（含 `shared/` 协议层、测试夹具、文档），无显式
   `case` 分支或穷举。编译期破坏对 c3 无影响。留痕：新增回归测试断言消息循环不出现
   `bypass_permissions_disabled` 分支、turn 照常以 `complete` 关闭。
2. **`ApiKeySource` 扩为 `'ANTHROPIC_API_KEY' | 'apiKeyHelper' | '/login managed key' | 'none'` +
   4 个 legacy 成员**。**不接入（兼容忽略）。** c3 从不按 `apiKeySource` 分支。回归测试断言 init
   携带 `/login managed key` 不产生 wire 帧。
3. **`vcs_state_changed` 事件上报 shell 结束时所在目录**。**不接入。** c3 不消费该事件（transcript
   解析只转文本与工具块）。
4. **宿主注入的 peer `origin` 可声明 `fromMode`**。**不接入。** c3 不使用跨会话 peer 通道。
5. **`SDKSystemMessage`（`system`/`init`）新增可选 `effort`**。**不接入。** c3 不新增读取、回显、
   wire 或持久化字段；模型目录的推理档位表达是独立能力，需由产品需求决定。回归测试断言
   `effort` 不落 wire。

### 0.3.235 — 对齐 Claude Code v2.1.235

6. **parity 版本。** 独立核实：Claude Code `CHANGELOG.md` 2.1.235 为一次 UI/终端渲染/交互修复批次
   （spellcheck 输入下划线、markdown 渲染、权限对话框文案、「don't ask again」、vim mode、跨会话
   SendMessage 大小校验等），**不含默认工具面收敛、不含权限行为变更、不含 model 别名变更**。
   SDK 类型面无变化。实跑确认（见「实跑验证」）。**结论：兼容，无接入。**

### 0.3.236 — PostToolUse classifierContext + account_on_hold

7. **`PostToolUseHookOutput.classifierContext`**。**不接入。** c3 不传 `hooks`，auto 模式分类器读
   不到 c3 的任何 hook 返回。回归测试断言 query options 无 `hooks` 键。
8. **`SDKAssistantMessageError` 新增 `account_on_hold`**。**不接入（兼容忽略）。**
   c3 的降级入口 `isDegradableError`（`server/src/kernel/agent-config/errors.ts`）只分类**抛错文本**；
   `assistant.error` 结构化字段不经过该分类器、不关闭 turn、不落 wire，因此「账号被暂停」沿既有
   unknown 路径呈现，**不得把整个 Claude vendor 标为不可用**。回归测试断言携带
   `error: 'account_on_hold'` 的 assistant 消息照常流式、turn 以 `complete` 关闭、字段不落 wire。

### 0.3.237 — 对齐 Claude Code v2.1.237

9. **parity 版本。** 独立核实：2.1.237 的变更**触及 SDK 模式与权限面**，需逐条评估：
   - **prompt caching / LLM gateway / 自定义 base URL 修复**：c3 走本地 loopback MCP + 宿主 CLI，
     不经 LLM gateway；该修复不影响 c3。
   - **内置「Concise」输出风格**：c3 不设 `output_style`（探针确认 init 为 `default`），沿用宿主
     默认；不接入。
   - **auto 模式收紧**（`Monitor` allow rules 在 auto 下让位、Bedrock/Vertex/Foundry/telemetry
     disabled 时分类器用与 Claude API 一致的默认与 severity 分级、git status 检查防
     `showUntrackedFiles=no` 绕过）：这些是**对 auto 分类器的加固**。c3 的权限模式集合（
     `server/src/kernel/agent/adapters/claude/permission-map.ts` 经 `claudeModeCatalog` 映射）含
     `auto` 但**不会作为运行起始模式**（`default` 起始 + `canUseTool` 人工审批），auto 仅在用户
     显式选择自动化模式时出现；且 `PermissionMode` 联合在 0.3.233 → 0.3.237 间零变更。收紧方向
     均使 auto 更保守，不构成回归。**结论：兼容，无接入。**
   - SDK 类型面无变化。实跑确认（见「实跑验证」）。**结论：兼容，无接入。**

## 深评

### 破坏项 `ExitReason` 移除 `bypass_permissions_disabled`

- 变更源：0.3.234 changelog 明写「TypeScript consumers with an explicit `case` branch get a compile
  error on upgrade（runtime 不受影响）」。
- 核查范围：`server/`、`web/`、`shared/`（全部 `.ts`/`.vue`，排除 node_modules）、测试夹具、现行
  文档（`doc/`、`database/`、`scripts/`、根级 `*.md`）。对 `ExitReason`、`EXIT_REASONS`、
  `bypass_permissions_disabled` 三个符号全部 **0 命中**。
- 结论：c3 不消费 `ExitReason`，无显式分支/穷举/映射。编译期破坏性变更对 c3 无影响。回归测试
  提供行为断言。

### `account_on_hold` 与 c3 降级路径

- c3 的降级入口 `isDegradableError` 按**错误文本**分类（rate/session limit、401/auth、network、
  5xx、quota、usage limit），不读 `SDKAssistantMessage.error` 结构化字段。
- `assistant.error` 是挂在 assistant 消息上的独立字段；c3 的 `runClaude` 消息循环只映射
  `assistant` 的 `content` 块（`text` / `tool_use`），`error` 字段完全不可见、不关闭 turn、不落
  wire。它不会把 Claude vendor 判为整体不可用。
- 结论：本轮记录该盲区（c3 不展示「账号被暂停」专用文案），但不误接成全局 vendor unavailable。
  建立跨 vendor 结构化失败分类、agent 禁用状态或 UI 原因码属独立能力，不夹带进依赖升级。

### auto 权限模式与 2.1.237 收紧

- c3 的权限模式全集：`default | auto | plan | acceptEdits | bypassPermissions`
  （`shared/src/protocol/vendor.ts`）。`auto` 通过 `claudeModeCatalog` 映射为 Claude 的 `auto`
  （模型分类器代答权限提示）。
- 2.1.237 对 auto 的三处改动均为**收紧或对齐**方向（分类器在更多平台用一致默认、Monitor 规则
  在 auto 下让位给与 Bash 相同的审查、git 状态检查防绕过），且 `PermissionMode` 联合零变更。
  即使某用户选择了 auto，收紧方向也不构成行为回归。**结论：不影响 c3，无需接入。**

### 工具面与 parity

- 实跑（见下）确认：宿主 CLI 2.1.227 与 SDK 内置 CLI 2.1.237 两条路径的默认工具面均完整，
  **均含** `TaskCreate`/`TaskGet`/`TaskList`/`TaskUpdate`（宿主多这 4 个，因 2.1.227 早于
  0.3.233 的 task 工具面收敛生效版本；SDK 内置 2.1.237 虽在收敛列表上但模型为
  `claude-opus-5[1m]`，收敛仅对 Opus 4.8/Sonnet 5/Fable 5/Mythos 5 及更新模型生效，`claude-opus-5`
  别名解析到 Opus 5 不在其列）。无论哪条路径，c3 都沿用 SDK 默认、不注入 `tools`/`allowedTools`
  覆写——本轮的既有原则不变。

## ADR-0011 判断

**不更新。** 全部变更为：

1. SDK 类型面加性扩张（`ApiKeySource`、`SDKSystemMessage.effort`、`SDKAssistantMessageError`
   `account_on_hold`、`PostToolUseHookOutput.classifierContext`、`Settings` 新增项、`origin.fromMode`、
   `task_started` 新字段、`vcs_state_changed` 逐分支、`UserPromptExpansion.suppressOriginalPrompt`、
   `hooks_applied`、`prompt_suggestion`、SDK 内建 Artifact/PR/代码执行工具面）——c3 无消费点，不产生
   新的 vendor 中性能力或 flag；
2. 唯一编译期破坏项（`ExitReason` 移除）——c3 零引用，无中性契约变化；
3. 两个 parity 版本（2.1.235 / 2.1.237）——权限行为、默认工具面、model 别名均经实跑核实不变；
4. hooks / peer 通道变更——c3 不传 `hooks`、不用 peer 通道，与 vendor 中性适配器面无交集。

capability ledger 的 8 个 boolean flags、`sessions` 子台账、neutral permission grid 与 `canFormTeam`
声明均不受影响；`server/src/kernel/agent/adapters/types.ts` 零改动。

## 验证

- **引用审计（全仓）**：`ExitReason` / `EXIT_REASONS` / `bypass_permissions_disabled` 在
  `server/`、`web/`、`shared/`、`doc/`、`database/`、`scripts/`、根级 `*.md`（排除 node_modules）
  **全部 0 命中**。升级记录为解释破坏项而出现的符号名称属审计留痕，不算行为残留。
- **SDK 类型 diff（实际安装产物比对）**：对 npm 上 0.3.233 与 0.3.237 两个 tarball 做内容比对。
  `agentSdkTypes.d.ts` / `bridge.d.ts` / `browser-sdk.d.ts` / `extractFromBunfs.d.ts` **零变更**。
  `sdk.d.ts` 实质变更：`ExitReason`/`EXIT_REASONS` 移除 `bypass_permissions_disabled`（破坏项）、
  `ApiKeySource` 扩宽、`SDKAssistantMessageError` 加 `account_on_hold`、`SDKSystemMessage.effort`、
  `PostToolUseHookOutput.classifierContext`、`Settings` 加 `syncClaudeAiSkills` / `spellcheck` /
  `autoContinueAtUsageLimit`、`SDKMessageOrigin.fromMode`、`UserPromptSubmitHookInput.source` 加
  `poll_event`、SDK 内部移除 `SDKControlGetPlanRequest` / `SDKControlGetWorkspaceDiffRequest`。
  `sdk-tools.d.ts` 为内建 Artifact/PR/代码执行工具面的加性扩张。**全部符号 c3 零命中。**
- **changelog 独立核实**：SDK changelog 0.3.234–0.3.238 与意图列举一致；Claude Code changelog
  2.1.234–2.1.238 逐条读取，两个 parity 版本（2.1.235 / 2.1.237）无默认工具面/权限/model 别名
  变更。
- `pnpm typecheck`：通过（server + web 全绿）。
- `pnpm lint`（`eslint .`）：**0 error**，20 个 warning。全部是「未使用的导入/变量」，分布在
  `web/src/App.vue`、`web/src/controls/message-handler.ts`、`web/src/controls/state.ts`、
  `web/src/pages/workspacesetting/WorkspaceSetting.vue` 等文件，**全部为本轮未触碰的预存项**，与
  SDK 无关（数量较上一份记录的 17 个上升，来自后续合入主线的其它改动）。
- `pnpm vitest run` 全量套件：**480 个测试文件通过 / 1 跳过、7880 个用例通过 / 16 跳过、0 失败**，
  **无新增 skip**（与升级前基线一致）。新增 `claude-sdk-0237-compat.test.ts`（6 用例），覆盖：
  破坏项 `ExitReason` 无分支、init 加性字段（`effort`/`apiKeySource`/`syncClaudeAiSkills`/
  `spellcheck`/`autoContinueAtUsageLimit`）不落 wire、query options 无 `hooks`/`fromMode`/
  `classifierContext`、`account_on_hold` 沿 unknown 路径不关 turn、parity 后 `permissionMode`
  `default` 与 options 面不变、`runTaskTool` 维持零注入边界。
- `server/package.json`：仅 `@anthropic-ai/claude-agent-sdk` `^0.3.233 → ^0.3.237`。
- `pnpm-lock.yaml`：diff 仅含 claude-agent-sdk 主包 specifier + 8 个平台子包的版本号/integrity 行
  （41 增 / 41 删），无关依赖零改动，无 `0.3.233` 残留。
- `pnpm-workspace.yaml`：零改动，未放宽 `minimumReleaseAge` 冷却策略。
- **实跑验证**（本机 `@anthropic-ai/claude-agent-sdk@0.3.237` + 两条 CLI 路径，各一次新会话 +
  一次 resume，prompt 含 `Bash` 工具调用，`canUseTool` 一律拒绝）：
  | 路径         | CLI     | 新会话           | resume           | init model          | permissionMode | apiKeySource        | tools | 含 task 工具 |
  | ------------ | ------- | ---------------- | ---------------- | ------------------- | -------------- | ------------------- | ----- | ------------ |
  | 宿主 CLI     | 2.1.227 | `result/success` | `result/success` | `claude-opus-5[1m]` | `default`      | `ANTHROPIC_API_KEY` | 32    | 是           |
  | SDK 内置 CLI | 2.1.237 | `result/success` | `result/success` | `claude-opus-5[1m]` | `default`      | `ANTHROPIC_API_KEY` | 28    | 是           |
  - 两条路径、两个阶段均 `result/success`，无未知消息类型关闭 turn，`canUseTool` 咽喉就位。
  - 工具面完整；宿主多 4 个 task 工具（2.1.227 早于 task 工具面收敛生效），SDK 内置 2.1.237 在
    `claude-opus-5` 上仍含 task 工具。
  - c3 实际经 `resolveHostBinary` 走宿主 CLI（2.1.227），SDK 内置 CLI 仅兜底。因此本次升级对
    c3 主路径的运行时影响为**宿主 CLI 不变、SDK 类型面 +1 版本**。
- 生产代码**零行为改动**：`server/src/` 下唯一改动是本轮新增的回归测试文件
  `claude-sdk-0237-compat.test.ts`；`adapters/types.ts` 未改。
- 文档留痕：本记录逐项覆盖 0.3.234–0.3.238 的评估（含未纳入的 0.3.238 冷处理由与留痕）；
  索引 `sdk-upgrade-records.md` 与指南 `claude-agent-sdk-guide.md` 适用版本同步为 `^0.3.237`；
  明确「ADR-0011 不更新」及理由。

## 附录：0.3.238 未纳入的原因（冷却期留痕）

- 0.3.238 发布于 `2026-08-20T18:02:54Z`（主包），最晚平台子包 `linux-x64-musl@0.3.238`
  `2026-08-20T18:21:46Z`；执行时刻（`2026-08-21T00:21Z`）距完全冷却约 18 小时。
- 按本仓库 `2026-07-21` 记录确立的决策（`minimumReleaseAgeExclude` 对锁文件校验阶段无效），
  不放宽/不豁免冷却策略。
- 0.3.238 的全部 6 项变更（见背景）对 c3 均「不接入」，故退档 0.3.237 功能损失为零。
- 下一轮双周升级自然吸收 0.3.238。
