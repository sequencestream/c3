# Codex Agent SDK 版本调研：0.148.0 → 0.157.1

- **日期**：2026-09-28
- **调研对象**：`@openai/codex-sdk`（TypeScript SDK）
- **起点 pin**：`0.148.0`（2026-08-18T22:30:14.987Z）
- **目标版本**：**`0.157.1`**（2026-09-26T01:07:00.600Z）
- **正式记录**：[`2026-09-28-codex-sdk-upgrade-to-v0.157.1.md`](2026-09-28-codex-sdk-upgrade-to-v0.157.1.md)
- **相关文档**：[`../codex-sdk-guide.md`](../codex-sdk-guide.md)、[`../agent-sdk.md`](../agent-sdk.md)

本文档是升级前后的取证记录：先固定运行时基线，再比对 tarball 产物、逐条分类上游变更、
最后对五个耦合点落结论。**结论先行：SDK TS 面无签名破坏，六个被 import 的类型形态全部未变，
唯一增量是 `ThreadOptions.configOverrides` / `ThreadOptions.threadSource` 两个可选字段
与 `ModelReasoningEffort` 的 union 扩展；CLI 行为面无 c3 需接入的破坏性变更。**

## 0. 一个必须先讲清的边界：SDK pin 不决定运行时二进制

c3 实际 spawn 的 `codex` 二进制来自**独立的 npm 托管 vendor 通道**，与 `server/package.json`
的 SDK pin **完全解耦**：

- codex 是 npm 托管 vendor（`HOST_BINARIES.codex`，`packageName: '@openai/codex'`），
  版本由 `selectNpmVersion()`（`server/src/kernel/agent/process/launcher.ts`）取 dist-tag 链上
  **最新的非预发布兼容版**（`compatibleRange: >=0.0.0 <999.0.0`）。
- 运行时生效版本的解析优先级：用户设置 `vendorCliVersions` → 上次同步的
  `latestCompatibleVersion` → manifest `selectedVersion` → 宿主 PATH 回退。
- SDK 的 npm 包不内嵌 CLI 二进制；`codex-sdk-guide.md` 第 2 节已明确 c3 完全绕过 SDK 的查找逻辑。

**因此：升 SDK pin 本身不会改变 c3 运行时执行的 codex 版本。** 这一点在本次调研中被直接证实——
升级开始时托管 CLI 已经是 `0.157.1`，而 SDK pin 仍停在 `0.148.0`，**20 个版本的偏斜早已在线上生效**。
本次调研的价值在于**把类型面与新 CLI 行为面拉齐评估**，而不是「升级即换二进制」。

## 1. 升级前运行时基线

没有这条基线就无法区分「新行为」与「本来就有的旧行为」。

`~/.c3/vendor/manifest.json` 的 `vendors.codex` 条目（升级前，读取于 2026-09-28T11:38Z）：

| 字段                      | 值                                     |
| ------------------------- | -------------------------------------- |
| `source`                  | `managed`                              |
| `compatibleRange`         | `>=0.0.0 <999.0.0`                     |
| `selectedVersion`         | `0.157.1`                              |
| `latestCompatibleVersion` | `0.157.1`                              |
| `path`                    | `~/.c3/vendor/codex/0.157.1/bin/codex` |
| `installedAt`             | `2026-09-27T15:32:21.555Z`             |
| `degradation`             | 字段不存在（即无降级）                 |

托管二进制实际版本输出：

```
$ ~/.c3/vendor/codex/0.157.1/bin/codex --version
codex-cli 0.157.1
```

历史 `versionHistory` 显示托管通道已逐版跟随：`0.148.0`（08-21）→ `0.149.0`（08-24）→
`0.149.1`（08-27）→ `0.150.0`（08-29）→ `0.151.0`（09-01）→ `0.152.0`（09-07）→
`0.153.4`（09-11）→ `0.154.0`（09-21）→ `0.155.1`（09-27）→ `0.157.1`（09-28）。

宿主 PATH 上的 `codex` 亦为 `0.157.1`（`/opt/homebrew/bin/codex`），与托管通道一致。

> **基线结论**：本次实跑验证针对的二进制是 **`codex-cli 0.157.1`**，
> 与落定的 SDK 目标版本 `0.157.1` 一致。这意味着「SDK 类型面」与「CLI 行为面」
> 在本次交付中首次评估于**同一个版本**，是本次调研相对历次记录的有利条件。

## 2. 版本结论表

npm `latest` = `0.158.0`（2026-09-28T05:12:43.883Z）；`alpha` dist-tag = `0.159.0-alpha.12`。
从 `0.148.0` 到 `0.158.0` 共 **20 个稳定版**（含起点外的 19 个跨版本 + 目标自身）：

| 版本      | npm 发布时间（UTC）      |
| --------- | ------------------------ |
| `0.149.0` | 2026-08-20T21:10:09.845Z |
| `0.149.1` | 2026-08-24T00:33:46.418Z |
| `0.150.0` | 2026-08-26T19:42:35.114Z |
| `0.150.1` | 2026-08-27T02:01:52.283Z |
| `0.151.0` | 2026-08-29T09:59:31.133Z |
| `0.152.0` | 2026-09-01T02:02:29.946Z |
| `0.152.1` | 2026-09-01T22:36:53.261Z |
| `0.153.0` | 2026-09-03T01:41:47.405Z |
| `0.153.1` | 2026-09-03T21:09:50.231Z |
| `0.153.2` | 2026-09-03T23:58:37.007Z |
| `0.153.3` | 2026-09-04T19:07:19.109Z |
| `0.153.4` | 2026-09-04T23:31:14.057Z |
| `0.154.0` | 2026-09-09T22:40:08.394Z |
| `0.155.0` | 2026-09-17T23:21:19.674Z |
| `0.155.1` | 2026-09-18T20:07:45.357Z |
| `0.156.0` | 2026-09-22T19:55:40.060Z |
| `0.156.1` | 2026-09-23T02:45:50.362Z |
| `0.157.0` | 2026-09-25T02:35:23.817Z |
| `0.157.1` | 2026-09-26T01:07:00.600Z |
| `0.158.0` | 2026-09-28T05:12:43.883Z |

### 目标版本落定：`0.157.1`，而非 `latest` 的 `0.158.0`

**冷却期是硬约束，且本次由它单独决定目标版本。**

- 调研与安装的执行时刻：**2026-09-28T11:38Z – 11:52Z**。
- `0.158.0` 发布于 `2026-09-28T05:12:43.883Z`，距执行时刻约 **6.4 小时**，**未满 24 小时冷却门槛**
  （要到 `2026-09-29T05:12:43Z` 才满足）。
- 次新稳定版 `0.157.1` 发布于 `2026-09-26T01:07:00.600Z`，距执行时刻约 **58.5 小时**，**已逾 2 日**，
  冷却期充分满足。
- 依据本仓库 `2026-07-21` 升级记录确立的决策（`minimumReleaseAgeExclude` 对锁文件校验阶段无效，
  不得放宽冷却策略），**退档至 `0.157.1`**。本次**未**修改 `pnpm-workspace.yaml` 的任何冷却配置，
  **未**新增 `minimumReleaseAgeExclude` 条目。

**附带收益**：`0.157.1` 恰是托管 CLI 当前 `selectedVersion`。选择它使「SDK 类型面」与
「运行时 CLI 行为面」落在同一版本上评估，消除了历次记录中「按 X 评估 SDK、却在 Y 上实跑」的错位。

- **不采纳预发布**：`0.159.0-alpha.12` 为 alpha dist-tag，非稳定版，按既定口径排除。
- **不逐版升**：本次**跨过全部 19 个中间版本**直接升到 `0.157.1`。跨过理由见下节——
  逐版本 release notes 已全部阅读（`rust-v0.149.0` … `rust-v0.157.1`），未发现对 c3 六个被 import 类型
  或 `codexExecArgs()` 参数面构成破坏的变更；唯一的 TS 面增量（见下节）是**纯增量可选字段**，
  不存在需要逐版迁移的中间状态。逐版升级在此只增加冷却期与回归成本，不增加安全性。

## 3. tarball 比对

`npm pack` 解包 `0.148.0` 与 `0.157.1` 两版后逐文件比对。两版文件清单完全一致
（`LICENSE` / `README.md` / `dist/index.d.ts` / `dist/index.js` / `dist/index.js.map` / `package.json`）。

`package.json` 差异仅三处：`version`、`packageManager`（`pnpm@10.33.0` → `pnpm@10.34.5`，上游仓库自身
的工具链字段，与 c3 无关）、以及捆绑依赖 `@openai/codex: 0.148.0 → 0.157.1`。**无依赖增删、无 exports
变更、无 `engines` 变更。**

`dist/index.d.ts` 10017 → 10369 字节（+352），`dist/index.js` 16641 → 17089 字节（+448）。
`index.d.ts` 的**全部**差异为三处：

```diff
@@ CodexOptions @@
+    /**
+     * Raw `--config key=value` overrides to pass unchanged to the Codex CLI after
+     * structured configuration and before SDK-managed or thread-specific overrides.
+     */
+    configOverrides?: string[];

@@ type ModelReasoningEffort @@
-type ModelReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
+type ModelReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra" | "persistent";

@@ type ThreadOptions @@
+    /** Source classification applied when this thread is first created. */
+    threadSource?: string;
```

`dist/index.js` 的全部差异为：`threadSource` 透传、`rawConfigOverrides` 追加为独立
`--config` 追加通道、以及新建线程时下发 `--thread-source <SOURCE>`（仅在无 `threadId` 时）。

### 3.1 结论：SDK TS 面**无签名破坏**

三处差异**全部是可选字段新增或 union 扩展**，无任何既有字段被删除、改名、收窄或改为必填。
对 c3 而言全部为**向后兼容的增量**。

### 3.2 c3 实际消费的六个类型逐一确认

c3 在 `server/src/kernel/agent/adapters/codex/` 内 `import type` 消费六个类型
（约束见 `codex-sdk-guide.md` §11.1）。逐个比对 `0.148.0` 与 `0.157.1` 的 `dist/index.d.ts`：

| 类型            | 消费位置                     | 形态是否变化       | 结论                                                                     |
| --------------- | ---------------------------- | ------------------ | ------------------------------------------------------------------------ |
| `ApprovalMode`  | `driver.ts`                  | **未变**           | union 四档 `never`/`on-request`/`on-failure`/`untrusted` 逐字节一致      |
| `SandboxMode`   | `driver.ts`                  | **未变**           | union 三档 `read-only`/`workspace-write`/`danger-full-access` 逐字节一致 |
| `ThreadEvent`   | `driver.ts` / `translate.ts` | **未变**           | 判别联合逐字节一致；实跑 JSON 事件流解析正常（见第 5 节）                |
| `ThreadOptions` | `driver.ts`                  | **仅新增可选字段** | 新增 `threadSource?: string`；c3 现有全部字段形态不变                    |
| `ThreadItem`    | `translate.ts`               | **未变**           | 判别联合逐字节一致                                                       |
| `TodoListItem`  | `task-store.ts`              | **未变**           | 逐字节一致                                                               |

**c3 不 import `ModelReasoningEffort` / `WebSearchMode` / `CodexOptions`**（前者经
`ThreadOptions.modelReasoningEffort` 的自有中立类型转译，后者是 c3 传给 SDK 的入参而 c3 不走 SDK 运行时），
故 `ModelReasoningEffort` 的 union 扩展不直接冲击编译；其影响经第 4.4 节评估。

## 4. 逐条 changelog 分类

分类口径沿用既有记录三档：**兼容且自动获益**／**不适用**／**需接入**。
逐版本 release notes 已全部阅读（`rust-v0.149.0` … `rust-v0.157.1`，共 19 份 GitHub Release）。
**本轮无「需接入」条目。**

### 4.1 新特性

- **`codex agents` 交互式面板 / `codex queue` 向既有会话发消息（0.149.0）** — 不适用 · 不接入
  - 依据: vendor 侧任务编排 UI/CLI；c3 不把 `agents` / `queue` 提升为 vendor 中立 capability，
    不新增 wire frame。`codexExecArgs()` 不产出这些子命令。
- **SDK 透传原始 `--config` 覆盖 + `max`/`ultra` 推理档（0.149.0，#38817/#39662）** — 兼容且自动获益 · 无需 c3 改动
  - 依据: 这是本次 SDK TS 面的**唯一实质增量**。c3 已有自建的等价且更强的通道——
    `codexExecArgs()` 自行拼装 `--config key=value`（`serializeConfigOverrides()` / `flattenConfig()`），
    并能下发 `model_reasoning_effort`。SDK 的 `configOverrides` 是其 JS wrapper 的入参，
    **c3 不走该 wrapper**，故不需要；`max`/`ultra` 已在 `model-catalog.ts` 的
    `SUPPORTED_REASONING_LEVELS` 中（见 4.4）。
- **TUI `/cd` `/pwd` `/cwd`（0.149.0）、Vim 增强（0.149.0/0.151.0/0.152.0/0.153.0/0.154.0）** — 不适用 · 不接入
  - 依据: TUI 面；c3 以非交互 `codex exec --experimental-json` 驱动，从不启动 TUI。
- **`codex doctor` 增强（0.149.0）** — 不适用 · 不接入
  - 依据: 诊断 CLI；c3 不调用 `codex doctor`。
- **`@` 提及任务 / `/copy` 选择器 / 自动命名 / Markdown 链接可点击（0.150.0）** — 不适用 · 不接入
  - 依据: TUI 交互面。**注意**「未命名终端任务自动获描述性标题」是 CLI 侧行为，
    而 c3 的会话标题由 `session-store.ts` 从 transcript 首个用户 `input_text` 自行派生，两者无交集。
- **MCP 工具发现宽限期、扩展可改写 MCP 工具结果（0.151.0）** — 不适用 · 不接入
  - 依据: c3 不注册 codex extension；回环 MCP 工具面不经此路径。
- **MCP server 名允许 `:@/.`（0.152.0）、MCP 工具 `output_token_limit`（0.152.0）** — 不适用 · 不接入
  - 依据: c3 的回环 MCP server 名为固定生成，不含这些字符；不逐工具配置 token 上限。
- **`codex exec` 显示凭据刷新进度（0.152.0）** — 不适用 · 不接入
  - 依据: 展示面；c3 不渲染 codex 的进度 UI。
- **`tui.auto_recap`（0.153.0）、plugin CLI（0.153.0）、配额预警（0.153.0）** — 不适用 · 不接入
  - 依据: TUI / plugin 体系；c3 走自有 skill 基础设施（`.codex/skills/`）。
- **实验性 worktree 支持 `--worktree`（0.154.0）** — 不适用 · 不接入
  - 依据: c3 自身在 **worktree 层面**管理隔离（每个 intent 一个 worktree，见 ADR-0034/0036），
    codex 侧再叠一层 worktree 会与 c3 的 cwd 模型冲突，且 c3 显式下发 `--cd`。
- **行内回答、后台 server 共享（Windows）、TUI 渲染（0.154.0）** — 不适用 · 不接入
  - 依据: 交互/Windows 专属面。
- **`/voice`、`/usage` 面板、Touch ID 校验 MCP（0.155.0/0.156.0）** — 不适用 · 不接入
  - 依据: TUI 与本机生物识别面；c3 的回环 MCP 走 HTTP + bearer token，不经 Touch ID 路径。
- **GPT-6 Sol / Luna / Astra 新模型与 Bedrock 目录扩充（0.153.1–0.153.4、0.154.0、0.156.1、0.157.0）** — 不适用 · 不接入
  - 依据: 内建模型目录。c3 经 relay 注入自定义 provider 并以 `model_catalog_json` 注册
    第三方模型 id（ADR-0029），不依赖内建目录条目。
- **全屏 transcript 默认开启、`f` 快捷键 fork、`/import`、`/daemon`（0.157.0）** — 不适用 · 不接入
  - 依据: TUI / 后台 server 面。c3 的 transcript 回放走 `session-store.ts` 只读 JSONL。

### 4.2 缺陷修复

- **resume/fork 恢复权限档案而非回落到默认（0.149.0，#39153）、恢复持久化 cwd（0.152.0，#41567）、
  远程 resume/fork 保留已存权限（0.154.0，#43330/#43177/#43355）、恢复 Plan mode（0.157.0，#45519）** —
  兼容且自动获益 · 即时接入
  - 依据: 与 c3 的显式下发**同向**（上游改为尊重持久化/显式设置，c3 每 turn 都重发）。
    深评见第 5.2 节，实跑证实显式 `--cd` 依然覆盖。
- **MCP bearer-token 查找与必需 server 启动修复（0.150.0，#39926/#39952/#39979）、
  MCP 凭据 OAuth 刷新（0.152.0/0.154.0/0.155.0/0.157.0）** — 兼容且自动获益 · 即时接入
  - 依据: 修复方向与 c3 的回环 HTTP + bearer 注入正相关，未改变注入契约。见 4.3。
- **不残留过期指令 / 切换模型保持工具与推理档正确（0.149.0、0.151.0）** — 兼容且自动获益 · 即时接入
  - 依据: 位于 c3 之下游的 CLI 可靠性修复。
- **rollout 压缩、共享历史、按 cwd 选取 resume、symlink session root 的 fork（0.153.0，#42039/#42135/#42139）** —
  兼容且自动获益 · 即时接入
  - 依据: **本轮最需实跑项之一**。压缩是**写侧**行为（默认不改变落盘布局），
    且 `codex exec resume` 自身能处理压缩 rollout；c3 读的是首行 `session_meta`，
    压缩不影响首行。实跑确认落盘路径与首行结构未变（第 5.3 节）。
- **沙箱收紧：Windows 连接入站、Linux/macOS 特权 socket、macOS 只读句柄写入（0.156.0，
  #44639/#45984/#46500）、macOS sandbox 阻断终端输入注入（0.154.0，#42590）、
  WSL 进程逃逸阻断（0.155.0）** — 兼容且自动获益 · 即时接入
  - 依据: c3 的沙箱由 **arapuca 进程级轻量沙箱**（ADR-0028）承担，codex 侧 `--sandbox` 是其内层。
    这些条目只收紧内层，不放宽外层，与 c3 依赖的「未挂载路径被拒」预期同向。
- **网络限制跨重定向与长连接生效、策略变更即取消（0.157.0，#47389/#47407）** — 兼容且自动获益 · 即时接入
  - 依据: 与 c3 的 `sandbox_workspace_write.network_access` 显式下发同向。
- **代理路由修复（0.156.0/0.157.0，#47101/#47142）** — 兼容且自动获益 · 即时接入
  - 依据: 与 `relayEnv()` 的 `NO_PROXY` 回环绕过互补。
- **切模型/切账号失效旧 model catalog（0.155.0，#43906/#44341/#44489）** — 兼容且自动获益 · 即时接入
  - 依据: c3 的 catalog 是**每 run 临时文件**（`writeModelCatalogFile` + 驱动 `finally` 清理，
    非目标：不持久化），不跨 run 复用，本就不受此影响。
- **本地 TUI 默认关闭推理摘要（0.155.1，#46467）** — 兼容且自动获益 · 即时接入
  - 依据: 修复「provider 不支持 reasoning summary 导致请求被拒」。c3 经 relay 走 Chat 协议，
    摘要暴露面本就有限；该默认值只对 TUI 生效。
- **Guardian 审批评审遵循模型元数据的 Node REPL 策略（0.152.1）** — 不适用 · 不接入
  - 依据: Guardian 自动审批评审是 codex 内建能力；c3 的 codex 工具调用是**结构性全预审**
    （`translate.ts` 注释所述），不经过 Guardian 判定路径。
- **Bedrock 压缩/多 agent 兼容（0.150.0）、凭据脱敏增强（0.150.0）** — 不适用 · 不接入
  - 依据: c3 不使用 Bedrock。
- **Turn 失败/被打断时保留已流式答案与计划（0.156.0，#45549/#46867）** — 兼容且自动获益 · 即时接入
  - 依据: 提升 c3 侧事件流的完整性，不改事件**形态**（`ThreadEvent` 未变，见 3.2）。
- **Astra 可见性与默认模型修正（0.153.4）、Fast tier 文案（0.153.2）、Astra 异步提问指引（0.153.3）** —
  不适用 · 不接入
  - 依据: 内建模型目录与文案；c3 不依赖内建默认模型（每 run 显式下发 `--model`）。
- **中断钩子 `Interrupt`（0.150.0，#40511）** — 不适用 · 不接入
  - 依据: c3 不注册 codex hooks（hook 由用户配置驱动，c3 不注入）。

### 4.3 回环 MCP / relay / provider 面

- **回环 MCP HTTP + bearer token env（4.2 中相关条目）**：注入方式未变——`codexExecEnv()` 仍以
  `env` 整体替换 `process.env` 并追加 `CODEX_INTERNAL_ORIGINATOR_OVERRIDE=c3`；
  `--config` 键名未改名。**0.150.0 的 bearer-token 修复只改上游查找逻辑，不改契约。**
  实跑证据：rollout 首行 `session_meta.payload.originator === "c3"`，
  证明 c3 的 env 注入在新二进制上仍被识别。
- **内建 provider 与 relay 冲突（ADR-0029）**：本轮上游新增/扩充的是 **Bedrock** provider 与
  **内建模型目录条目**，**未新增与 c3 自定义 provider 竞争的 provider 选择机制**；
  `model_provider` 仍由 c3 经 `--config` / relay base URL 指定。无冲突。
- **废弃 `codex mcp-server` 入口（0.154.0，#42993）**：c3 从不调用该入口（用的是回环 HTTP 而非 stdio MCP server）。

### 4.4 `--config` 透传与新推理档位

- **`model_reasoning_effort` union 扩展**：SDK TS 面新增 `max` / `ultra` / `persistent`。
  但**运行时二进制的 `supported_reasoning_levels` union 才是权威**——`codex debug models` 在
  `0.157.1` 上对全部 11 个内建模型取并集，结果为
  **`{low, medium, high, xhigh, max, ultra}`，六档，无 `persistent`**。
  - c3 的 `SUPPORTED_REASONING_LEVELS`（`model-catalog.ts`）恰为**同样六档**，**已完全覆盖，无需改动**。
  - `persistent` 在 SDK TS 面出现但不在 CLI 的档位 union 中：它是 `model_messages` 里的
    「persistent 模式」指令族（`debug models` 可见 `persistent_instructions`），**不是**一个
    `model_reasoning_effort` 取值。c3 不经 SDK 运行时，该字段对 c3 无意义，**不接入**。
- **`model_catalog_json` 必填字段集（VERSION GATE）**：`0.157.1` 上以 c3 生成的 catalog 形态
  （`deepseek-v4-flash` + `contextWindow=163840` + `maxOutputTokens=32768`）交给
  `codex debug models --config model_catalog_json=<path>` → **解析成功并回显**，
  六档 reasoning 齐全、`truncation_policy` 正确反映 `contextWindow`。
  必填脚手架字段集未变，**仅更新注释版本标注**。

## 5. 显式风险评估（五个耦合点）

### 5.1 rollout 落盘路径与格式（最高优先级）

**结论：未变动，`session-store.ts` 无需改动。**

实跑（托管 `codex-cli 0.157.1`，隔离 `CODEX_HOME`）新会话产生的 rollout：

```
$CODEX_HOME/sessions/2026/09/28/rollout-2026-09-28T19-41-29-01a0e7d1-ed2c-77f0-a64a-4eb2d6c8ebcc.jsonl
```

首行 `session_meta.payload` 字段（`session-store.ts` 依赖的加粗）：

| 字段                       | 值                                     | `session-store.ts` 是否依赖          |
| -------------------------- | -------------------------------------- | ------------------------------------ |
| `session_id` / `id`        | `01a0e7d1-ed2c-77f0-a64a-4eb2d6c8ebcc` | **是**（取 `session_id`，回退 `id`） |
| **`cwd`**                  | `/tmp/cxrun/A`                         | **是**（与 workspace 精确比对过滤）  |
| `cli_version`              | `0.157.1`                              | 否（仅供人读）                       |
| `originator`               | `c3`                                   | 否（本次用于验证 env 注入）          |
| `source` / `thread_source` | `exec` / `user`                        | 否                                   |
| `runtime_workspace_roots`  | `["/tmp/cxrun/A"]`                     | 否                                   |
| `model_provider`           | `openai`                               | 否                                   |

`event_msg` / `turn_context` / `response_item` 三类行均在位，标题派生源（首个用户
`input_text`）可读。**用 c3 真实的 `CodexSessionStore` 读取该文件（临时探针，已删除）**：

- `list()` → 列出 1 条会话，`sessionId` 正确，`title` 正确派生为 `"Reply with exactly: SEED-OK"`，
  `vendorExtra.cwd` 正确；
- `read()` → 返回 1 条规范消息，`role: "user"`，文本块完整。

即**会话列表与 transcript 回放均正常**。0.153.0 的「rollout 压缩」是写侧行为，
不改变落盘布局与首行结构（压缩后的 rollout 仍由 `codex exec resume` 自行处理，
而 c3 只读首行）。

### 5.2 resume 的工作目录与审批策略

**结论：与 c3 的显式下发不冲突，无需改驱动。**

实跑（同一 `thread_id`，在 `DIR_B` 下发显式 `--cd DIR_B` / `--sandbox read-only` /
`approval_policy="never"` 后 resume）：

| 证据                           | 值                                                 | 判读                                                        |
| ------------------------------ | -------------------------------------------------- | ----------------------------------------------------------- |
| 事件流首行                     | `thread.started` 的 `thread_id` 与种子会话**相同** | resume 正确接续                                             |
| 新 `turn_context.cwd`          | `/tmp/cxrun/B`（种子会话为 `/tmp/cxrun/A`）        | **显式 `--cd` 生效**，覆盖持久化值                          |
| `session_meta.cwd`             | 仍为 `/tmp/cxrun/A`                                | 会话身份锚点不变，与 `session-store.ts` 的 cwd 匹配语义一致 |
| `turn_context.approval_policy` | `never`                                            | 与 c3 本次显式下发一致                                      |

c3 的模型是「单会话权限档位固定」，无产品路径支持 resume 中途改档；
上游 0.149.0/0.152.0/0.154.0 的「恢复权限档案」改动与 c3 的显式重发**同向**，
不构成冲突。**无需落地改动。**

### 5.3 回环 MCP HTTP 与 bearer token env

**结论：不受影响。** 见 4.3。`codexExecEnv()` 的注入方式（整体替换 env +
`CODEX_INTERNAL_ORIGINATOR_OVERRIDE`）与 `--config` 键名均未变；
实跑以 `session_meta.payload.originator === "c3"` 佐证注入仍被识别。

### 5.4 `--config` 透传与新推理档位

**结论：已被 `model-catalog.ts` 覆盖，无需改动。** 见 4.4。
`codexExecArgs()` 自建的 `--config` 通道与 SDK 新增的 `configOverrides` 等价且 c3 不走 SDK 运行时；
reasoning 六档 union 与运行时二进制完全一致。

### 5.5 内建 provider 与 c3 注入的 relay provider 冲突

**结论：无冲突。** 见 4.3。本轮上游未新增 provider 选择机制。

## 6. 范围决策：是否顺带推进托管 CLI 到 `0.157.1`

**结论：无需推进——托管 CLI 已经就在 `0.157.1`。**

升级开始时 `manifest.json` 的 `selectedVersion` / `latestCompatibleVersion` 均为 `0.157.1`
（第 1 节基线），即托管通道**已随 dist-tag 自动跟进到本次落定的目标版本**。
因此「是否推进」这一决策在本次交付中**自动消解**：

- 无需触发 `syncManagedVendorCli('codex')`，无需设置 `vendorCliVersions.codex`；
- 升级前后 `manifest.json` 的 `vendors.codex` 条目**无变化**（`selectedVersion: 0.157.1`、
  `latestCompatibleVersion: 0.157.1`、`degradation` 不存在），本次未写入 manifest；
- 所有 CLI 行为面评估与实跑验证**均在 `0.157.1` 上完成**，与 SDK 目标版本一致。

> **留痕的供应链缺口（本次不修）**：`selectNpmVersion()` 自动跟随平台 dist-tag 的最新非预发布版，
> **不受 SDK 冷却期约束**——托管通道可以在 SDK 侧退档等待冷却的同时，先行跑到更新版本。
> 本次 `0.158.0` 发布 6 小时后，托管 CLI 仍停在 `0.157.1`，只是因为 c3 尚未再次同步，
> 而非通道施加了约束。这条缺口按既定口径**仅留痕，不修改 `selectNpmVersion()` 的行为**。

## 7. 落地清单

| #   | 事项                                           | 结论                                                                                             |
| --- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 1   | `server/package.json` pin                      | `0.148.0` → **`0.157.1`**（维持精确 pin，不改 caret）                                            |
| 2   | `pnpm-lock.yaml`                               | 定向同步，diff 仅含三组 codex 包（33 增 / 33 删）                                                |
| 3   | `model-catalog.ts` / `.test.ts`                | VERSION GATE 注释版本标注 `0.148.0` → `0.157.1`（逻辑零变更，已实跑复验）                        |
| 4   | `driver.ts` / `translate.ts` / `task-store.ts` | 修正误挂的 `ADR-0009` 引用 → ADR-0011 + 指向 `codex-sdk-guide.md` §11.1；`ADR-0014` → `ADR-0029` |
| 5   | `codex-sdk-guide.md`                           | 「适用版本」→ `0.157.1`；第 6 节 ADR 引用修正；新增 §11.1 承载 vendor 类型边界约束               |
| 6   | `sdk-upgrade-records.md`                       | 索引表按日期倒序插入新记录                                                                       |
| 7   | ADR-0011 capability ledger                     | **不更新**（未触及 vendor 中立能力面，见正式记录）                                               |
| 8   | `pnpm-workspace.yaml`                          | **不动**（未放宽冷却、未新增豁免）                                                               |

## 8. 调研期实跑的覆盖边界（如实留痕）

本调研的实跑取证全部在**宿主机模式**下完成：直接 spawn 托管 `codex 0.157.1`，
使用隔离 `CODEX_HOME`，**未起 c3 server**。因此下列三项**未被实跑覆盖**，
本文档相应结论的性质是「取证」还是「论证」，如实区分如下：

| 耦合点 | 证据性质 | 说明 |
| --- | --- | --- |
| rollout 路径与 `session_meta` 结构未变 | **实跑取证** | 新产生 rollout + c3 真实 `CodexSessionStore` 读取成功 |
| resume 显式 `--cd` 覆盖持久化 cwd | **实跑取证** | `turn_context.cwd` 由 `DIR_A` → `DIR_B` |
| `approval_policy` 显式下发 | **实跑取证** | `turn_context.approval_policy = never` |
| env 注入被新二进制识别 | **实跑取证** | `session_meta.payload.originator === "c3"` |
| model catalog 解析 | **实跑取证** | `codex debug models` 解析成功并回显 |
| **外层 arapuca sandbox 未回归** | **论证，非实跑（环境所限）** | 本次未走 arapuca 包装（ADR-0028）；已尝试补跑但 `arapuca run` 报 `sandbox_apply: Operation not permitted`（沙箱无法嵌套），提权亦不可用；未改沙箱代码路径，上游相关条目均为收紧内层 |
| **回环 MCP 工具面首个 turn 可见** | **论证，非实跑** | 未起 c3 server，无 `127.0.0.1:<c3port>` 端点；仅验证注入通道未改名 |
| **升级前既有会话仍可列出** | **实跑取证** | 取升级前真实 rollout 25 条，`CodexSessionStore` `list()`+`read()` 全部通过（25/25） |

上表两项「论证」项的共同前提是：**本次 SDK 升级未触及 c3 的沙箱、MCP 注入与
session-store 代码路径**（改动仅为版本号与注释）。该前提成立时，论证与实跑的
差距仅在于「运行时确认」，而非「行为可能已变」。
