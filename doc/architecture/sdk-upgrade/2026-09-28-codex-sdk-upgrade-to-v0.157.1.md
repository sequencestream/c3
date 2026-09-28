# Codex SDK 升级记录：0.148.0 → 0.157.1（跨 19 个稳定版，类型面无破坏）

- **日期**：2026-09-28
- **SDK**：`@openai/codex-sdk`
- **版本**：`0.148.0` → `0.157.1`（维持精确 pin，不改为 caret）
- **范围**：仅 Codex SDK。Claude Agent SDK（今日已升到 `^0.3.283`）与其它依赖原封不动，
  `pnpm-lock.yaml` 同步（diff 仅含 `@openai/codex-sdk` + 其捆绑的 `@openai/codex` 及六个平台
  二进制的版本号/`integrity` 变化，**33 增 / 33 删**）。
- **调研文档**：[`2026-09-28-codex-sdk-survey.md`](2026-09-28-codex-sdk-survey.md)（版本表、tarball 比对、
  逐条 changelog 分类、五个耦合点的逐个结论、升级前运行时基线）
- **上游 release notes**：`rust-v0.149.0` … `rust-v0.157.1`（19 份，逐条阅读并分类）
- **关联指南**：[`../agent-sdk.md`](../agent-sdk.md)（SDK 升级纪律）、
  [`../codex-sdk-guide.md`](../codex-sdk-guide.md)（适用版本随本次升级更新为 `0.157.1`）、
  [上一份 Codex 记录](2026-08-21-codex-sdk-upgrade-to-v0.148.0.md)

## 结论速览

- **目标版本 `0.157.1` 由冷却期单独决定**：npm `latest` 的 `0.158.0` 发布于 `2026-09-28T05:12:43.883Z`，
  距执行时刻约 6.4 小时，**未满 24 小时**；`0.157.1` 发布于 `2026-09-26T01:07:00.600Z`，
  距执行时刻约 58.5 小时，冷却充分。**未**修改 `pnpm-workspace.yaml` 的任何冷却配置。
- **SDK TS 面无签名破坏。** `dist/index.d.ts` 全部差异仅三处，且**全部是可选字段新增或 union 扩展**：
  `CodexOptions.configOverrides?: string[]`、`ThreadOptions.threadSource?: string`、
  `ModelReasoningEffort` 追加 `max`/`ultra`/`persistent`。无字段被删、改名、收窄或改为必填。
- **c3 实际 import 的六个类型形态全部未变**（`ApprovalMode` / `SandboxMode` / `ThreadEvent` /
  `ThreadOptions`（仅新增可选字段）/ `ThreadItem` / `TodoListItem`），逐字节比对确认。
  `pnpm typecheck` 通过即为该结论的编译期证据。
- **一次跨过全部 19 个中间版本**，而非逐版升。逐版本 release notes 已全部阅读，
  未发现对六个被 import 类型或 `codexExecArgs()` 参数面构成破坏的变更；逐版升级在此
  只增加冷却期与回归成本，不增加安全性。
- **SDK pin 版本 ≠ 托管 CLI 版本 —— 这条偏斜本次首次被消解。** 升级开始时托管 CLI 已经是
  `0.157.1`（`selectNpmVersion()` 自动跟随 dist-tag），而 SDK pin 仍停在 `0.148.0`，
  **20 个版本的偏斜早已在线上生效**。落定 `0.157.1` 使二者首次落在同一版本上评估与实跑。
  这不是通过改 pin 去间接对齐托管通道，而是选点时顺带消除的既成错位；
  两个供应链的节奏**仍然独立**（详见「SDK pin 与托管 CLI 的关系」）。
- **rollout 落盘路径与结构未变**，`session_meta.payload.session_id` / `.cwd` 均在位；
  用 c3 真实的 `CodexSessionStore` 读取新产生的 rollout，会话列表与 transcript 回放**均正常**。
- **resume 的显式下发仍然生效**：实跑证实 `--cd` 覆盖持久化 cwd（`turn_context.cwd` 由
  `DIR_A` 变为 `DIR_B`），`session_meta.cwd` 保持会话身份锚点不变。
- **无任何上游条目需 c3 接入。** vendor 中立适配器面未被触及，**ADR-0011 capability ledger 不更新**。

## SDK pin 与托管 CLI 的关系

c3 实际 spawn 的 `codex` 二进制来自独立的 npm 托管 vendor 通道（`HOST_BINARIES.codex`），
与 `server/package.json` 的 SDK pin **完全解耦**：版本由 `selectNpmVersion()` 取 dist-tag 链上
最新的非预发布兼容版，运行时生效优先级为
`vendorCliVersions` 设置 → `latestCompatibleVersion` → manifest `selectedVersion` → 宿主 PATH 回退。
SDK 的 npm 包不内嵌 CLI 二进制。

**因此升 SDK pin 本身不会改变 c3 运行时执行的 codex 版本。** 本次两者恰好同为 `0.157.1`，
但这是**选点的结果**而非对齐机制：托管通道仍会在下次同步时再次独立前进。

**manifest 升级前后 diff：无。** `vendors.codex` 的 `selectedVersion: 0.157.1` /
`latestCompatibleVersion: 0.157.1` / `degradation`（不存在）在升级前后完全相同，
本次未写入 manifest，也未触发 `syncManagedVendorCli('codex')`，未设置 `vendorCliVersions.codex`。
本次实跑用的二进制是 **`codex-cli 0.157.1`**（`~/.c3/vendor/codex/0.157.1/bin/codex`）。

## 冷却期处置

- 执行时刻：**2026-09-28T11:38Z – 11:52Z**。
- `0.158.0`（npm `latest`）发布于 `2026-09-28T05:12:43.883Z`，距执行时刻约 **6.4 小时**，
  要到 `2026-09-29T05:12:43Z` 才满 24 小时门槛 → **未满冷却，排除**。
- `0.157.1` 发布于 `2026-09-26T01:07:00.600Z`，距执行时刻约 **58.5 小时**，**冷却期充分满足** → **落定**。
- 依据 2026-07-21 记录确立的决策（`minimumReleaseAgeExclude` 对锁文件校验阶段无效，
  不得放宽冷却策略）退档。**本次未修改 `pnpm-workspace.yaml`，未新增任何 `minimumReleaseAgeExclude` 条目。**
- **不采纳预发布**：`0.159.0-alpha.12` 为 alpha dist-tag，排除。

## 逐项评估

分类口径：**兼容且自动获益**／**不适用**／**需接入**（本轮**无**「需接入」）。
逐条完整分类与依据见[调研文档第 4 节](2026-09-28-codex-sdk-survey.md#4-逐条-changelog-分类)，
此处只列与 c3 耦合面直接相关的条目。

### 新特性

- **SDK 透传原始 `--config` 覆盖（0.149.0，#38817）** — 兼容且自动获益 · 无需 c3 改动
  - 依据: c3 已有自建且更强的等价通道——`codexExecArgs()` 自行拼装 `--config key=value`。
    该字段是 SDK JS wrapper 的**入参**，c3 不走该 wrapper。
- **`max` / `ultra` 推理档（0.149.0，#39662）** — 兼容且自动获益 · 已在 c3 覆盖
  - 依据: `model-catalog.ts` 的 `SUPPORTED_REASONING_LEVELS` 已含六档，
    与运行时 `codex debug models` 的并集**完全一致**（深评见下）。
- **`codex agents` / `codex queue` / `codex exec fork` / worktree（0.149.0 / 0.154.0）** — 不适用 · 不接入
  - 依据: 不把上游新能力提升为 c3 的 vendor 中立能力，不新增 capability flag 与 wire frame。
- **TUI / Vim / `/voice` / `/usage` / Touch ID / 后台 server（各版）** — 不适用 · 不接入
  - 依据: c3 以非交互 `codex exec --experimental-json` 驱动，从不启动 TUI。
- **内建模型目录扩充：GPT-6 Sol / Luna / Astra、Bedrock（0.153.x–0.157.0）** — 不适用 · 不接入
  - 依据: c3 经 relay 注入自定义 provider 并以 `model_catalog_json` 注册第三方模型 id（ADR-0029），
    不依赖内建目录条目；每 run 显式下发 `--model`。

### 缺陷修复

- **resume/fork 恢复权限档案而非回落默认（0.149.0 #39153）、恢复持久化 cwd（0.152.0 #41567）、
  远程 resume/fork 保留已存权限（0.154.0 #43330/#43177/#43355）** — 兼容且自动获益 · 即时接入
  - 依据: 与 c3 每 turn 显式重发 `--cd` / `--sandbox` / `approval_policy` **同向**，不构成冲突。
    深评见下。
- **rollout 压缩 + 按 cwd 选取 resume + symlink session root 的 fork（0.153.0 #42039/#42135/#42139）** —
  兼容且自动获益 · 即时接入
  - 依据: 本轮最需实跑项之一。压缩是**写侧**行为，不改变落盘布局与首行结构；
    c3 只读首行 `session_meta`。实跑确认（深评见下）。
- **MCP bearer-token 查找 / 必需 server 启动修复（0.150.0 #39926/#39952/#39979）、
  MCP 凭据 OAuth 刷新（0.152.0 / 0.154.0 / 0.155.0 / 0.157.0）** — 兼容且自动获益 · 即时接入
  - 依据: 修复方向与 c3 的回环 HTTP + bearer 注入正相关，**未改注入契约**
    （`codexExecEnv()` 与 `--config` 键名均未变）。
- **沙箱收紧（0.154.0 #42590 / 0.155.0 / 0.156.0 #44639/#45984/#46500）** — 兼容且自动获益 · 即时接入
  - 依据: c3 沙箱由 arapuca 承担（ADR-0028），codex `--sandbox` 是其内层；这些条目只收紧内层，
    与 c3 依赖的「未挂载路径被拒」同向，**sandbox 策略未回归**。
- **网络限制跨重定向与长连接生效（0.157.0 #47389/#47407）** — 兼容且自动获益 · 即时接入
  - 依据: 与 c3 的 `sandbox_workspace_write.network_access` 显式下发同向。
- **切模型/切账号失效旧 model catalog（0.155.0 #43906/#44341/#44489）** — 兼容且自动获益 · 即时接入
  - 依据: c3 的 catalog 是**每 run 临时文件**（`writeModelCatalogFile` + 驱动 `finally` 清理），
    不跨 run 复用，本就不受影响。
- **Bedrock 压缩兼容（0.150.0）、Guardian Node REPL 策略（0.152.1）** — 不适用 · 不接入
  - 依据: c3 不使用 Bedrock；codex 工具调用是**结构性全预审**，不经 Guardian 判定。
- **废弃 `codex mcp-server` 入口（0.154.0 #42993）** — 不适用 · 不接入
  - 依据: c3 用回环 HTTP，不调用该 stdio MCP server 入口。

### c3 侧挂载的升级期义务

- **model catalog VERSION GATE 复查** — 兼容且自动获益 · 即时接入
  - 依据: 以 `0.157.1` 将 c3 生成形态 catalog 交给
    `codex debug models --config model_catalog_json=<path>` → **解析成功并回显**，
    六档 reasoning 齐全、`truncation_policy.limit` 正确反映 `contextWindow`。
    必填脚手架字段集未变，生成逻辑零改动；仅更新注释版本标注 `0.148.0` → `0.157.1`。

## 深评一：reasoning 档位 union

SDK TS 面的 `ModelReasoningEffort` 新增了 `max` / `ultra` / `persistent`。但**运行时二进制的
`supported_reasoning_levels` union 才是权威**：

```
$ codex-cli 0.157.1 debug models   # 对全部 11 个内建模型取并集
union: {high, low, max, medium, ultra, xhigh}
```

- c3 的 `SUPPORTED_REASONING_LEVELS` 恰为**同样六档**，**已完全覆盖，无需改动**。
- `persistent` **不在** CLI 的档位 union 中：它是 `model_messages` 里的「persistent 模式」指令族
  （`debug models` 中可见 `persistent_instructions`），**不是**一个 `model_reasoning_effort` 取值。
  c3 不经 SDK 运行时，该字段对 c3 无意义，**不接入**。
- c3 的驱动在正常路径下不设置 effort（该 union 是 forward-safety），故无行为变化。

## 深评二：rollout 落盘与 `session-store.ts`

**路径未变。** 实跑（托管 `codex-cli 0.157.1`，隔离 `CODEX_HOME`）新会话：

```
$CODEX_HOME/sessions/2026/09/28/rollout-2026-09-28T19-41-29-01a0e7d1-<thread>.jsonl
```

首行 `session_meta.payload` 中 `session-store.ts` 依赖的字段均在位：
`session_id` / `id` = `01a0e7d1-ed2c-77f0-a64a-4eb2d6c8ebcc`、**`cwd` = `/tmp/cxrun/A`**。
`event_msg` / `turn_context` / `response_item` 三类行均在位。

**用 c3 真实的 `CodexSessionStore` 读取该文件**（临时探针，验证后已删除）：

- `list()` → 列出 1 条会话，`sessionId` 正确，`title` 正确派生为 `"Reply with exactly: SEED-OK"`；
- `read()` → 返回 1 条规范消息，`role: "user"`，文本块完整。

即**会话列表与 transcript 回放均正常**。0.153.0 的 rollout 压缩是写侧行为，
不改变落盘布局与首行结构（压缩后的 rollout 由 `codex exec resume` 自行处理，c3 只读首行）。
**无需在 `session-store.ts` 内兼容读新旧两种形态。**

## 深评三：resume 的 cwd 与审批策略

实跑（同一 `thread_id`，在 `DIR_B` 下发显式 `--cd DIR_B` / `--sandbox read-only` /
`approval_policy="never"` 后 resume）：

| 证据                           | 值                                      | 判读                                                        |
| ------------------------------ | --------------------------------------- | ----------------------------------------------------------- |
| 事件流首行 `thread_id`         | 与种子会话**相同**                      | resume 正确接续                                             |
| 新 `turn_context.cwd`          | `/tmp/cxrun/B`（种子为 `/tmp/cxrun/A`） | **显式 `--cd` 生效**，覆盖持久化值                          |
| `session_meta.cwd`             | 仍为 `/tmp/cxrun/A`                     | 会话身份锚点不变，与 `session-store.ts` 的 cwd 匹配语义一致 |
| `turn_context.approval_policy` | `never`                                 | 与 c3 本次显式下发一致                                      |

**结论**：c3 每次 resume 都经 `codexExecArgs()` 重发 `--cd` / `--sandbox` / `approval_policy`。
上游 0.149.0 / 0.152.0 / 0.154.0 的「恢复权限档案 / 持久化 cwd」改动与 c3 的显式重发**同向**，
worktree 不会跑到错误目录。c3 的模型是「单会话权限档位固定」，无产品路径支持 resume 中途改档，
**无需改驱动**。若未来产品要支持会话中途改权限档，需另开意图评估覆盖策略。

## 深评四：锁文件纯净性

`pnpm-lock.yaml` 的变更行**只落在三组 codex 包**上：`@openai/codex-sdk` 主包、传递依赖
`@openai/codex`、以及 6 个 `optionalDependencies` 平台子包
（`@openai/codex@0.157.1-<platform>-<arch>`）。三组同时变化是 SDK 依赖树的预期结果
（SDK 的 `dependencies` 指向 `@openai/codex@<X>`，后者再挂 6 个平台子包）。

- `git diff --numstat pnpm-lock.yaml` = **33 增 / 33 删**，与上一份记录（0.147.0 → 0.148.0）
  的 33/33 完全一致。
- **过程留痕**：直接跑 `pnpm install` 会让本机 pnpm 11.22.0 **顺带重解析无关依赖**
  （把 vite 6.4.2 的 `rollup` 从已提交的 `4.60.4` 改判为 `4.62.2`，进而整棵 `rollup` /
  `@rollup/rollup-*` / `postcss` / `nanoid` 子树被增删，diff 膨胀到 42 增 / 313 删）。
  这是**本机 pnpm 版本与生成该 lockfile 的版本不一致**造成的既有漂移，与 codex 无关。
  按既定口径「锁文件 diff 不得夹带其它依赖升级」，已回退 lockfile，改为**从 pnpm 生成的锁中
  只移植三组 codex 包块**，得到纯净的 33/33。**未**为此修改任何解析配置或 override。

## 受影响的特性与契约

行为面无变更。代码侧改动为：

- `model-catalog.ts` / `model-catalog.test.ts`：**纯注释版本标注**（VERSION GATE `0.148.0` → `0.157.1`），
  生成逻辑零改动（已实跑复验）。
- `driver.ts` / `translate.ts` / `task-store.ts`：**纯注释**——把误挂在 `ADR-0009`
  （kernel/transport/features 三层单向边界，与本约束无关）的 vendor 类型边界引用，
  改指 ADR-0011 并指向 `codex-sdk-guide.md` §11.1；`driver.ts` 中已废弃的 `ADR-0014`
  修正为 `ADR-0029`。
- `codex-sdk-guide.md`：顶部「适用版本」更新为 `0.157.1`；第 6 节标题的 `ADR-0014` 修正为
  `ADR-0029`；新增 **§11.1「SDK 类型边界（ADR-0011）」**，把此前只挂在三个文件头注释里
  的「vendor 类型只能在 `adapters/codex/` 内 import」这条**真实存在的架构约束**提升为正式文档，
  并列出被约束的六个类型。

以下层面均**不受影响**：适配器能力账本、`adapters/types.ts`、`gateToCodexPolicy`、
`codexExecArgs()` 参数面、MCP 注入、`session-store.ts` 读路径、`translate.ts` / `task-store.ts`、
`process/launcher.ts`、sandbox 认证、relay 合约。

### capability ledger 不更新

本升级记录明确：**`adr/0011-vendor-neutral-agent-abstraction.md` 的 capability ledger 不更新。**
理由：未触及 vendor 中立能力面——`codex agents` / `codex queue` / `codex exec fork` / worktree /
新模型目录等上游能力**均未接入**，不新增 capability flag，现有布尔判定不变，
`shared/src/protocol/` 无新增 wire frame。

（本次对 ADR-0011 的**引用**有修正：三个文件头注释里那条被误标为 ADR-0009 的 vendor 类型边界，
其归属是 ADR-0011 的 vendor 类型 containment 部分，现已指向 ADR-0011 并落到
`codex-sdk-guide.md` §11.1。这是**引用纠正与约束文档化**，不是能力面变更。）

## 验证

- **tarball 取证**：`npm pack` 解包 `0.148.0` / `0.157.1`，文件清单一致；`package.json` 差异仅
  `version` / `packageManager`（上游工具链字段）/ 捆绑依赖号；`dist/index.d.ts` 全部差异为
  三处**可选字段新增或 union 扩展**。**SDK TS 面无签名破坏。**
- **六个类型逐一比对**：`ApprovalMode` / `SandboxMode` / `ThreadEvent` / `ThreadItem` /
  `TodoListItem` **逐字节一致**；`ThreadOptions` 仅新增可选 `threadSource?: string`。
- **版本一致性**：`server/package.json` = `0.157.1`；`pnpm-lock.yaml` 解析值 = `0.157.1`；
  `codex-sdk-guide.md` 适用版本 = `0.157.1`；已安装 `server/node_modules/@openai/codex-sdk`
  实际 `0.157.1`。**三处一致。**
- **冷却期 / 版本选择**：见「冷却期处置」；`pnpm-workspace.yaml` **未放宽、未新增豁免**。
- **锁文件 diff 纯净**：`git diff --numstat pnpm-lock.yaml` = **33 增 / 33 删**，
  变更行只落在 `@openai/codex-sdk` / `@openai/codex` / 六个平台包。`pnpm install --frozen-lockfile`
  通过供应链策略校验（834 entries）。
- **运行时基线取证**：升级前后各记录一次 `manifest.json` 的 `vendors.codex` 条目，
  **两者相同**（`selectedVersion: 0.157.1` / `latestCompatibleVersion: 0.157.1` /
  `degradation` 不存在）。二进制 `codex --version` = **`codex-cli 0.157.1`**。
  **本次实跑用的是 `0.157.1`**，与 SDK 目标版本一致。
- **实跑（会话 + resume）**：托管 `0.157.1`、隔离 `CODEX_HOME`、c3 参数形态起会话并 resume：
  (a) `turn_context.cwd` 随显式 `--cd` 由 `DIR_A` 变为 `DIR_B`——**工作目录由 c3 显式下发决定**；
  (b) `sandbox_policy.type` = `read-only`，`approval_policy` = `never`，与显式下发一致——
  **审批策略由 c3 显式下发决定**；(c) `session_meta.payload.originator === "c3"`——
  **c3 的 env 注入在新二进制上仍被识别**。
  _说明：隔离 home 无凭据，turn 停在 401 重连，上述三项均在 turn 上下文建立阶段取证，
  覆盖 cwd / sandbox / approval / env 注入四个耦合点。_

### 本次实跑**未**覆盖的验收项（如实留痕）

以下三项为 spec「验证」章节要求。其中第 3 项已实跑关闭，第 1、2 项在本次执行环境下无法完成：

1. **sandbox 模式（arapuca）实跑未做，且在本次执行环境下无法完成。**
   本次实跑为**宿主机模式**（直接 spawn 托管 `codex 0.157.1`，隔离 `CODEX_HOME`），
   **未经 c3 的 arapuca 进程级沙箱包装**（ADR-0028）。因此「sandbox 策略未回归」只在
   **内层** `--sandbox` 参数语义上取证（`sandbox_policy.type = read-only`），
   **外层 arapuca 隔离未实跑验证**。

   已尝试关闭该缺口但失败：本机装有 `arapuca`，但在本执行环境内
   `arapuca run` 报 `sandbox-exec: sandbox_apply: Operation not permitted`
   ——沙箱**无法嵌套**进已受限的执行环境。提权请求亦因审批服务不可用而未能执行。
   即：**该缺口是执行环境所限，非跳过**，需在正常宿主环境补跑。

   依据（论证，非实跑）：本次 SDK 升级未触及沙箱代码路径
   （`process/launcher.ts`、sandbox 认证均未改），且 0.154.0 / 0.155.0 / 0.156.0
   的沙箱条目均为**收紧内层**，与 c3 依赖同向。
2. **回环 MCP 工具面「首个 turn 完整可见」未实跑。** 本次未起 c3 server，
   无 `127.0.0.1:<c3port>` 回环 MCP 端点，因而**未验证** MCP 工具在首个 turn 的可见性。
   已验证的只是**注入通道未被上游改名**：`originator === "c3"` 佐证 `codexExecEnv()`
   的 env 注入被新二进制识别，且 `--config` 键名未变（tarball 比对）。
   0.150.0 的 bearer-token 修复属上游查找逻辑，未改契约。
3. **回环 MCP 首个 turn 可见性 —— 环境所限未做。** 见上条第 2 点同类说明：
   本次未起 c3 server，无回环端点。已验证注入通道未被上游改名。

   **原第 3 项「升级前既有会话仍可列出」已实跑关闭**：以临时探针取宿主
   `~/.codex/sessions` 中**升级前**（`2026-09-2` 之前）的真实 rollout 25 条，
   逐条用 c3 真实 `CodexSessionStore` 走 `list()` + `read()`：
   **listed 25 / read 25，共 25 条全部通过**（探针验证后已删除）。
   既有会话兼容性由此从「论证」升级为**实跑取证**。
- **rollout 核对**：`sessions/2026/09/28/rollout-*.jsonl` 路径与 `session_meta` 结构未变；
  用 c3 真实 `CodexSessionStore` 读取——**会话列表正常列出该会话（标题正确派生）、
  transcript 回放正常**。
- **model catalog VERSION GATE**：c3 形态 catalog 经 `0.157.1` 的 `codex debug models`
  **解析成功**；reasoning union 六档 `{low, medium, high, xhigh, max, ultra}` 齐全，
  与 `SUPPORTED_REASONING_LEVELS` 一致。
- **Codex 适配器目录单测**：`codex.test.ts` / `translate.test.ts` / `model-catalog.test.ts` /
  `task-store.test.ts` / `session-store.test.ts` / `image-files.test.ts` / `gh-token.test.ts`
  —— **115 passed / 0 failed**（含 `session-store.test.ts` 18 例）。
- **静态检查**：`pnpm typecheck` 通过（server + web）；`pnpm lint` 0 error；`pnpm allcheck` 通过
  （`i18n:check` 0 error，756 条 warning 均为既有 SoT 未发射提示，与本次变更无关）。
- **全量 `pnpm vitest run`**：555 文件 / 9547 用例，**9528 passed / 2 failed / 17 skipped**，
  无新增 skip。两条失败**均与本次变更无关**，逐一取证如下：
  1. `server/src/kernel/agent/adapters/types.test.ts` —「Codex listTools correctly classifies
     read vs write」。该用例断言 codex 适配器 `listTools()` 存在 `TaskCreate` / `TaskList` /
     `TaskUpdate` / `TaskGet`，而 `adapters/codex/index.ts` 的 `SDK_READ_TOOLS` 只含 `web_search`
     （`SDK_WRITE_TOOLS` 只含 `shell` / `apply_patch`），这些 task 工具名早在
     `e037315d`（修正 Codex 自动化 Git 写入权限）即已移除，用例未同步。
     **A/B 取证**：把 SDK 回退到起点 `0.148.0` 并重装后单独跑该文件，**失败完全相同**
     （`1 failed | 9 passed`）。故为**既有失败**，非本次升级引入。
  2. `server/src/kernel/permission/robot-fs-scope.test.ts` —「denies an adjacent-prefix
     sibling」。该用例需在冻结根目录的相邻前缀下 `mkdirSync` 造目录，在本受限沙箱内
     因写权限被拒而失败。属**运行环境产物**，与 codex 升级无任何关联
     （本次未触碰 `server/src/kernel/permission/` 下任何文件）。
