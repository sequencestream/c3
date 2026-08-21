# Codex SDK 升级记录：0.147.0 → 0.148.0（SDK TS 产物零变更，实质为宿主 codex CLI 升级）

- **日期**：2026-08-21
- **SDK**：`@openai/codex-sdk`
- **版本**：`0.147.0` → `0.148.0`（维持精确 pin，不改为 caret）
- **范围**：仅 Codex SDK。Claude Agent SDK（前置升级已合入 `^0.3.237`）与其它依赖原封不动，
  `pnpm-lock.yaml` 同步（diff 仅含 `@openai/codex-sdk` + 其捆绑的 `@openai/codex` 及六个平台
  二进制的版本号/`integrity` 变化，33 增 / 33 删）。
- **上游 release notes**：[`rust-v0.148.0`](https://github.com/openai/codex/releases/tag/rust-v0.148.0)
  （2026-08-18）——TUI `/export`、`codex exec fork`、TUI 预写 prompt、thread credits、Bedrock
  provider、hooks 异步+MCP、resume 恢复 cwd/审批策略、sandbox fail-closed、rollout 迁移等。
- **关联指南**：[`../agent-sdk.md`](../agent-sdk.md)（SDK 升级纪律）、
  [`../codex-sdk-guide.md`](../codex-sdk-guide.md)（适用版本随本次升级更新为 `0.148.0`）、
  [上一份 Codex 记录](2026-08-16-codex-sdk-upgrade-to-v0.147.0.md)

## 结论速览

- **SDK 的 TypeScript 产物零变更，本轮实质是宿主 codex CLI `0.147.0 → 0.148.0`。** `npm pack`
  解包两版后 `diff -rq package` 仅 `package.json` differ；`dist/index.d.ts` / `dist/index.js` /
  `dist/index.js.map` 三文件 `cmp` 逐字节完全相同。`package.json` 差异仅 `version` 与捆绑依赖
  `@openai/codex: 0.147.0 → 0.148.0`。故**无 SDK API/类型面的 breaking change**，评估重心落在
  CLI 行为面。c3 仍只 `import type` 消费六个类型，不走 SDK 运行时。
- **落定 `0.148.0` 而非意图目标 `0.149.0`，原因是供应链冷却期**（见「冷却期处置」）。
- **resume 深评**：显式 `--cd` / `--sandbox` 在 resume 时覆盖持久化值；`approval_policy` 经
  `--config` 下发时，resume 仍保留会话持久化的审批策略。c3 单会话权限档位固定，无产品路径会在
  resume 中途改档，**无需落地改动**。
- **rollout 落盘路径仍为 `sessions/YYYY/MM/DD/rollout-*.jsonl`**，`session_meta.cwd` /
  `thread_id` 形态不变，`session-store.ts` 可读。
- **sandbox fail-closed / hooks / Bedrock / fork** 均不要求 c3 接入或改动（依据见逐项评估）。
- **无任何上游条目需 c3 接入。** vendor 中性适配器面未被触及，**ADR-0011 capability ledger 不更新**。

## 冷却期处置

- 意图目标为 `0.149.0`（npm 稳定版，`2026-08-20T21:10:09Z` 发布）。
- pnpm 11 `minimumReleaseAge` 24 小时门槛：`0.149.0` 要到 `2026-08-21T21:11Z` 才满冷却。
- **执行时刻距 `0.149.0` 完全冷却约 20 小时。** 依据本仓库 `2026-07-21` 记录确立的决策
  （`minimumReleaseAgeExclude` 对锁文件校验阶段无效，不得放宽冷却策略），退档至已满冷却的
  `0.148.0`（发布于 `2026-08-18T22:26:03Z`，已逾 50 小时）。
- **不采纳 `0.150.0` 系列**：截至执行时仅为 `0.150.0-alpha.1` 预发布。
- `0.149.0` 的 SDK 面增量（`configOverrides`、`ModelReasoningEffort` 追加 `max`/`ultra`）留给下一轮
  双周升级；c3 已在 `model-catalog.ts` / `driver.ts` 以自建 `--config` 路径支持 `max`/`ultra`，
  且不使用 SDK 运行时，退档不损失产品能力。

## 逐项 changelog 评估

分类口径：**兼容且自动获益**／**不适用**／**需接入**（本轮无）。

### 新特性

- **TUI `/export` 导出完整会话为 Markdown** — 不适用 · 不接入
  - 依据: TUI 面；c3 不渲染 TUI，会话回放走 `session-store.ts` 只读 JSONL。
- **`codex exec fork`；resume picker 归档/恢复** — 不适用 · 不接入
  - 依据: vendor 侧会话编排；c3 不把 fork/归档提升为 vendor 中性 capability，不新增 wire frame。
    `codexExecArgs()` 不产出 `fork`。
- **TUI 初始化期间预写 prompt；resume/fork 进度展示** — 不适用 · 不接入
  - 依据: TUI 启动面；c3 以非交互 `exec --experimental-json` 驱动。
- **`/status` / 状态行 / 终端标题展示 thread credits** — 不适用 · 不接入
  - 依据: TUI 展示面；c3 不消费 credits UI。
- **内建 Amazon Bedrock Runtime provider** — 不适用 · 不接入
  - 依据: c3 经 relay 注入自定义 provider（`options.config`），不走内建 Bedrock；无配置冲突接入点。
- **Hooks 可异步执行命令并可调用 MCP 工具** — 不适用 · 不接入
  - 依据: c3 不配置 codex hooks；确认不改变 c3 托管进程生命周期（c3 不注册 hook）。

### 缺陷修复

- **切换模型与更新设置不再残留过期指令 / 不中途改 turn** — 兼容且自动获益 · 即时接入
  - 依据: CLI 可靠性修复，位于 c3 之下游；c3 每 turn 显式下发 model/sandbox/approval。
- **resume 恢复持久化的工作目录与审批策略** — 兼容且自动获益 · 即时接入（深评见下）
  - 依据: 本轮最需实跑项。显式 `--cd` / `--sandbox` 覆盖持久化；`approval_policy` 持久化优先于
    resume 时的 `--config` 覆盖。c3 会话权限档固定，无中途改档产品路径。
- **turn 穿越临时 provider 故障重连；MCP OAuth 重认证后无需重启** — 兼容且自动获益 · 即时接入
  - 依据: 默认不启用新 MCP 协议能力时既有回环通路语义不变；可靠性修复自动获益。
- **TUI 启动缓冲输入 / 缺认证 onboarding** — 不适用 · 不接入
  - 依据: TUI 面。
- **composer/transcript CRLF / 折行 / 长 URL** — 不适用 · 不接入
  - 依据: TUI 渲染面。
- **sandbox 对被拒/不可读路径 fail closed（Linux/Windows）** — 兼容且自动获益 · 即时接入
  - 依据: 与 arapuca 包装交集在「拒绝未挂载路径」一侧；c3 本就依赖 allow set 外路径被拒。
    macOS 宿主机探针起会话+resume 正常。无额外挂载需求。

### 其它值得注意的提交

- **#37607 阻止 launch context 传入子进程** — 兼容且自动获益 · 即时接入
  - 依据: 安全加固，不剥 c3 显式注入的 `CODEX_API_KEY` / MCP bearer env（本轮为 0.148；env 清洗
    相关条目在 0.149，留给下轮）。
- **#37349 full-filesystem Bubblewrap 挂载最小 `/dev`** — 不适用 · 不接入
  - 依据: Linux sandbox 内部；c3 主路径为 macOS + arapuca。
- **#37366 / #37527 MCP / hook 进程树清理** — 不适用 · 不接入
  - 依据: c3 不配置 hooks；MCP 为回环 HTTP，非本地 stdio MCP server 树。
- **#37494 / #37477 MCP 事件发现订阅与 call ID** — 不适用 · 不接入
  - 依据: 默认不启用；既有回环工具面不依赖新事件发现 API。
- **#37348 / #37191 rollout 迁移工具与后台迁移、迁移期保留旧语义** — 兼容且自动获益 · 即时接入
  - 依据: 本轮第二必查项。新建会话仍落 `sessions/YYYY/MM/DD/rollout-*.jsonl`，
    `session_meta` 含 `cwd` / `cli_version=0.148.0`；迁移保留旧语义，不破坏
    `session-store.ts` 只读扫描。
- **内建 skill-creator 指南收敛；拒绝未完成 TODO 占位符** — 不适用 · 不接入
  - 依据: 上游 skill 工具链；c3 skill 发现走自有基础设施。

### c3 侧挂载的升级期义务

- **model catalog VERSION GATE 复查** — 兼容且自动获益 · 即时接入
  - 依据: 以 `0.148.0` 将 c3 生成形态 catalog 交给 `codex debug models --config model_catalog_json=…`
    → 解析成功并回显（新增字段带默认值）；内置 catalog 的 `supported_reasoning_levels` union 仍为
    `low/medium/high/xhigh/max/ultra`。生成逻辑无需改动；仅更新注释版本标注。

## 深评：resume cwd / 审批策略

探针（托管 `codex-cli 0.148.0`，隔离 `CODEX_HOME`，c3 参数形态）：

1. 在 `DIR_A` 以 `--sandbox workspace-write --config approval_policy="never"` 起会话 →
   `thread_id=01a021e7-…`，回复 `SEED-OK`。
2. 以同一 `thread_id` resume，显式改传 `--cd DIR_B --sandbox read-only --config approval_policy="on-request"` →
   同一 `thread_id`，答出 `SEED-OK`。
3. rollout 证据：
   - `thread_settings_applied.cwd` = `DIR_B`（**显式 `--cd` 生效**）
   - resume 后 `turn_context.sandbox_policy.type` = `read-only`（**显式 `--sandbox` 生效**）
   - resume 后 `turn_context.approval_policy` 仍为 `never`（**持久化审批策略优先于本次 `--config`**）

**结论**：c3 每次 resume 都经 `codexExecArgs()` 重发 `--cd` / `--sandbox` /
`approval_policy`。cwd 与 sandbox 由显式参数决定，worktree 不会跑到错误目录。审批策略在
resume 时以会话持久化为准——与 c3「单会话固定权限档」模型一致，无需改驱动。若未来产品要支持
会话中途改权限档，需另开意图评估覆盖策略。

## 受影响的特性与契约

无行为变更。唯一的代码侧改动是 `model-catalog.ts` / `model-catalog.test.ts` 的**纯注释版本标注**
（VERSION GATE `0.147.0` → `0.148.0`）。以下层面均不受影响：

- 适配器能力账本、`adapters/types.ts`、`gateToCodexPolicy`、`codexExecArgs`、MCP 注入、
  `session-store.ts`、`translate.ts` / `task-store.ts`、`process/launcher.ts`、sandbox 认证、
  中继合约。

### capability ledger 不更新

本升级记录明确：**`adr/0011-vendor-neutral-agent-abstraction.md` 的 capability ledger 不更新。**
理由：未触及 vendor 中性能力面；fork / agents / queue / Bedrock / hooks 等均未接入，不新增
capability flag，现有布尔判定不变。

## 验证

- **SDK dist 逐字节取证**：`npm pack` 0.147.0 / 0.148.0 后 `dist/*` 三文件 `cmp` **IDENTICAL**；
  `package.json` 仅 version + `@openai/codex` 依赖号。shasum：
  `0.148.0` = `b3bb6b8a56809161765466c97b6f34d4e1b4e071`。
- **冷却期 / 版本选择**：见上节；`pnpm-workspace.yaml` **未放宽、未新增豁免**。
- **锁文件 diff 纯净**：`git diff --numstat pnpm-lock.yaml` = **33 增 / 33 删**，仅
  `@openai/codex-sdk` / `@openai/codex` / 六个平台包。
- **运行时 CLI**：`~/.c3/vendor/codex/0.148.0/bin/codex --version` → **`codex-cli 0.148.0`**。
- **resume 探针**：见深评（宿主机隔离 home；显式 `--cd`/`--sandbox` 生效）。
- **rollout 结构**：`sessions/2026/08/21/rollout-…jsonl`，含 `session_meta` /
  `turn_context` / `event_msg`，路径约定未变。
- **model catalog VERSION GATE**：c3 形态 catalog 经 `codex debug models` 解析成功；reasoning
  union 六档齐全。
- **Codex 定向单测**：`codex.test.ts` / `translate.test.ts` / `model-catalog.test.ts` /
  `task-store.test.ts` —— **81 passed / 0 failed**。
