# Codex SDK 升级记录：0.146.0 → 0.147.0（SDK TS 产物零变更，实质为宿主 codex CLI 升级）

- **日期**：2026-08-16
- **SDK**：`@openai/codex-sdk`
- **版本**：`0.146.0` → `0.147.0`（维持精确 pin，不改为 caret）
- **范围**：仅 Codex SDK。`@anthropic-ai/claude-agent-sdk`（`^0.3.233`，前置升级已合入）与其它依赖号
  原封不动，`pnpm-lock.yaml` 同步（diff 仅含 `@openai/codex-sdk` + 其捆绑的 `@openai/codex` 及六个平台
  二进制的版本号/`integrity` 变化，33 增 / 33 删）。
- **上游 release notes**：[`rust-v0.147.0`](https://github.com/openai/codex/releases/tag/rust-v0.147.0)
  （2026-08-07）——可移植 Agent Plugins、会话 section、`--approve-for-me`、Cursor skills 导入、
  可选启用的 MCP 2026-07-28 协议、Bedrock 缓存式 web search，以及 secret/bearer 脱敏、终端输入与渲染
  修复、Windows 进程与路径处理、**不熟悉本地项目的显式 trust**、插件隔离加固与**策略更新失败时拒绝网络**；
  杂项含**移除已废弃的 `codex exec --full-auto` flag**与**停止发布冗余的 Linux bundle 归档**。
- **关联指南**：[`../agent-sdk.md`](../agent-sdk.md)（SDK 升级纪律）、
  [`../codex-sdk-guide.md`](../codex-sdk-guide.md)（适用版本随本次升级更新为 `0.147.0`）、
  [上一份 Codex 记录](2026-08-02-codex-sdk-upgrade-to-v0.146.0.md)

## 结论速览

- **SDK 的 TypeScript 产物零变更，本轮实质是宿主 codex CLI `0.146.0 → 0.147.0`。** `npm pack` 解包
  两版后 `diff -rq package` 仅 `package.json` differ；`dist/index.d.ts` / `dist/index.js` /
  `dist/index.js.map` 三个文件 `cmp` 逐字节完全相同。`package.json` 逐行差异只有三处：`version`、
  捆绑依赖 `@openai/codex: 0.146.0 → 0.147.0`、新增 **devDependency**
  `@modelcontextprotocol/conformance`（github pin，devDependency 不进运行时、不入锁文件）。
  故**无 SDK API/类型面的 breaking change**，评估重心落在 CLI 行为面。
- **`--full-auto` 移除对 c3 无影响：c3 从不产出该 flag。** 全仓 `git grep` 对 `--full-auto` /
  `full_auto` / `fullAuto` 三种写法命中数均为 **0**（覆盖 `server/` `web/` `shared/` `scripts/`
  `doc/` `database/` 全部已跟踪文件，含脚本、探针、文档与测试夹具；工作区无未跟踪文件）。c3 的 codex
  参数构造在 `adapters/codex/driver.ts` 的 `codexExecArgs()` 单点收敛，产出的是
  `exec --experimental-json` + `--sandbox <mode>` + `--config approval_policy=...`，权限面走
  `--sandbox` 而非已废弃的 `--full-auto`，与上游推荐的替代形态本就一致。**无改动需要落地。**
- **Linux bundle 归档停发对 c3 无影响：c3 的 codex 二进制分发走 npm registry，不取 GitHub release 归档。**
  `process/launcher.ts` 的托管安装链路是 `registry.npmjs.org/@openai/codex` packument →
  `dist.tarball` → SRI 校验 → `npm install --omit=dev` 拉平台 optionalDependency。取证：本机托管安装
  `~/.c3/vendor/codex/0.147.0/package/node_modules/@openai/` 下落地的是 `codex-darwin-arm64`
  （npm alias `npm:@openai/codex@0.147.0-darwin-arm64`）；`@openai/codex@0.147.0` 的
  optionalDependencies 六个平台包（含 `codex-linux-x64` / `codex-linux-arm64`）**在 npm 上齐备**，
  Linux 分发不断。**无改动需要落地。**
- **新增的「不熟悉本地项目要求显式 trust」不阻塞 c3：`codex exec` 非交互路径自动置信并继续。**
  三组实跑（宿主机陌生目录、空 trust 表的隔离 `CODEX_HOME`、真实 arapuca sandbox 的全新工作目录）
  全部起会话成功、退出码 0，并各自向对应 `config.toml` 自动写入 `trust_level = "trusted"`，**无提示、
  无阻塞、无授权失败**（详见验证节）。trust 门只作用于交互式 TUI。
- **宿主机与 sandbox 双模式各起一次会话并 resume 一次，均通过**；回环 MCP 在 `0.147.0` 下工具可见可调用
  （`find_intents` 端到端 PASS）。
- **无任何上游条目需 c3 接入。** 逐条评估结论为「兼容且自动获益」或「不适用」，无「需接入」项。
- vendor 中性适配器面（`adapters/types.ts` 与 capability ledger）未被触及，capability grid 不变，
  **ADR-0011 capability ledger 不更新**（理由见末节）。
- **不采纳 0.148.0 系列**：截至 2026-08-16，`@openai/codex-sdk` 的 0.148.0 全部为 alpha 预发布
  （alpha.1 ~ alpha.20），npm `dist-tags` 为 `latest = 0.147.0` / `alpha = 0.148.0-alpha.20`。
  c3 的 `selectNpmVersion()` 亦通过 `isPreRelease()` 显式排除预发布线，本轮只升到稳定版 `0.147.0`。

## 逐项 changelog 评估

分类口径：**兼容且自动获益**（随 CLI 升级生效、无需 c3 改动）／**不适用**（落在 c3 未使用的
TUI / 插件 / app-server / 安装 / 平台面，或 c3 不生产也不消费）／**需接入**（本轮无）。

### 新特性

- **可移植 Agent Plugins：跨 local / personal / workspace / remote 插件目录安装与检索** — 不适用 · 不接入
  - 依据: 插件分发面；c3 既不发布也不消费 codex 插件，未在任何路径写入或引用插件目录，无接入点。
- **会话组织：持久化、可手动排序的 section，长 transcript 增量浏览** — 不适用 · 不接入
  - 依据: TUI 会话组织面。c3 不渲染 TUI；会话恢复走 `adapters/codex/session-store.ts` 的只读磁盘
    JSONL（rollout 文件），按 `thread_id` 定位，不消费 section 概念。已实跑确认 resume 在宿主机与
    sandbox 双模式下均取回同一 `thread_id` 且保留上轮内容（见验证节），**section 与 c3 的 rollout
    读取/resume 路径无冲突**。
- **新增 `--approve-for-me` CLI flag（自动化审阅后的批准）** — 不适用 · 不接入
  - 依据: c3 的审批面由中性 `toolGate` 经 `gateToCodexPolicy` 映射到
    `--sandbox <read-only|workspace-write>` × `approval_policy=<never|on-request|on-failure>`，
    语义闭合且已覆盖 c3 需要的全部档位；`codexExecArgs()` 不产出该 flag，不引入新的审批通道。
- **导入 Cursor 托管的 skills；同步已导入的 Claude / Cursor 会话变更且不重复** — 不适用 · 不接入
  - 依据: c3 的 skill 发现走自有的 vendor 中性基础设施（`kernel/skill-loader/` + codex 侧
    `<projectDir>/.codex/skills/`），不经 codex 的 Cursor skills 导入；c3 的 cursor 适配是独立
    vendor，会话不经 codex 导入通道，无重复风险。
- **可选启用的 MCP 2026-07-28 协议（分页发现、多轮请求、非阻塞式 server 启动）** — 兼容且自动获益 · 即时接入
  - 依据: 上游明示 opt-in，c3 未在任何 `--config` 中开启，默认走既有 MCP 协议版本，既有回环通路语义不变。
    针对「非阻塞式 server 启动可能改变工具在首个 turn 前的可用性」这一顾虑，已用真实 `0.147.0` 跑
    `transport/intent-mcp/e2e.codex.test.ts`：codex 在**首个 turn 内**即发现并调用 `find_intents`，
    未出现工具静默缺席（见验证节）。
- **Amazon Bedrock 缓存式 web search 与远端会话压缩** — 不适用 · 不接入
  - 依据: Bedrock provider 面；c3 的 relay 走自定义 provider 的 Chat Completions 转换路径，
    web search 仍由中性选项 `webSearch` → `webSearchEnabled/webSearchMode` 控制，无接入点。

### 缺陷修复

- **从展示的命令与回放的会话历史中脱敏 secret 与完整 bearer token** — 兼容且自动获益 · 即时接入
  - 依据: 脱敏作用于 CLI 的**展示层与回放历史**，不改变 `--experimental-json` 的事件帧结构。已实跑
    确认 c3 的帧解析不受影响：宿主机/隔离 home/sandbox 三组探针的 JSONL 均正常产出
    `thread.started` / `turn.started` / `item.completed` / `turn.completed` 四类帧并被解析；
    `translate.ts` 定向套件与 relay/intent-mcp e2e 全绿。安全收益直接落到 c3 托管的 transcript。
- **修复终端输入在焦点回归、MCP server 初始化、Ghostty 快捷键处理时丢失或卡住** — 兼容且自动获益 · 即时接入
  - 依据: 终端输入面对 c3 不适用（c3 以 `stdio` 管道非交互驱动），但其中 **MCP server 初始化期间的
    卡住**属通用可靠性修复，位于 c3 的回环 MCP 通路之下游，自动获益。
- **修复日文字符、emoji、超链接及视口边界附近文本的渲染与光标定位** — 不适用 · 不接入
  - 依据: TUI 渲染面，不落 SDK dist，不影响 JSONL；c3 不渲染 TUI。
- **正确中断 Windows 后台进程，统一处理 Windows 文件系统路径** — 不适用 · 不接入
  - 依据: Windows 平台面；c3 主平台为 macOS/Linux，不形成接入点。
- **对不熟悉的本地项目要求显式 trust；使用凭证前强制执行受管认证限制** — 兼容且自动获益 · 即时接入
  - 依据: **本轮最需实跑的一项**，已完成三组验证（见「深评」与验证节）：`codex exec` 非交互路径在
    陌生目录下自动置信 `trust_level = "trusted"` 并继续执行，不阻塞 c3 的 worktree 启动路径与
    sandbox 路径。受管认证限制对 c3 的两条认证形态（system = 宿主 `~/.codex/auth.json`；
    custom = relay token）均无影响，sandbox 订阅 e2e 与回环 MCP e2e 均 PASS。
- **加固插件隔离；策略更新失败时拒绝网络访问** — 兼容且自动获益 · 即时接入
  - 依据: 插件隔离对 c3 不适用（c3 不使用 codex 插件）。「策略更新失败拒绝网络」是 codex 自身策略
    引擎的 fail-closed 行为，位于 c3 之下游，与 c3 的 arapuca 网络策略**不共用下发通道**：c3 的网络
    面由 arapuca wrapper 的挂载/网络许可 + codex 侧 `sandbox_workspace_write.network_access` 两处
    独立控制，均由 c3 在启动参数中静态给定，不依赖 codex 的运行时策略下发。已实跑排除静默无网：
    sandbox 内 codex 正常触达 OpenAI API 并完成两轮对话，回环 MCP 触达正常（见验证节）。

### c3 侧挂载的升级期义务（非 release notes 条目）

- **model catalog 的 serde 字段集复查** — 兼容且自动获益 · 即时接入
  - 依据: `adapters/codex/model-catalog.ts` 的 VERSION GATE 要求每次 codex 升级重跑实测。已按 0.147.0
    重跑：字段集仍充分、reasoning-effort union 未变，生成逻辑无需改动（详见「深评」第 4 节）。

### 杂项

- **移除已废弃的 `codex exec --full-auto` flag（改用 `--sandbox workspace-write`）** — 不适用 · 不接入
  - 依据: **本轮唯一潜在破坏项，核查结论为 c3 不产出该 flag、无影响。** 全仓 `git grep` 三种写法命中
    均为 0（范围与取证见结论速览与验证节）。c3 的权限面本就走 `--sandbox`：`gateToCodexPolicy` 产出
    `read-only` / `workspace-write`，由 `codexExecArgs()` 拼为 `--sandbox <mode>`，与上游推荐的替代
    形态一致，无需替换、无需补回归断言（既有 `codex.test.ts` 的 CLI argv 断言已覆盖 `--sandbox` 产出）。
- **依赖升级：MCP SDK → 3.0.0、Ratatui → 0.30.2、V8 → 150.4.0** — 兼容且自动获益 · 即时接入
  - 依据: CLI 内部依赖，位于 c3 之下游。MCP SDK 3.0.0 是本轮唯一与 c3 有接触面的一项（回环 MCP），
    已用真实 `0.147.0` 端到端验证工具可见可调用；Ratatui（TUI）与 V8 不形成接入点。
- **停止发布冗余的 Linux bundle 归档，改用标准 `codex-package-<target>` 发布归档** — 不适用 · 不接入
  - 依据: **本轮第二个必须核查的破坏项，核查结论为 c3 分发链路不取用 GitHub release 归档、无影响。**
    c3 走 npm registry + 平台 optionalDependency（取证见结论速览与验证节），归档形态变更不触达
    c3 的拉取/打包链路；六个平台 npm 包在 `0.147.0` 上齐备，Linux 分发不断。
- **macOS 发布公证改用 Azure Key Vault** — 不适用 · 不接入
  - 依据: 上游发布流程内部事项，不形成 c3 接入点。

## 深评：本轮四个必查项的核查结论

### 1. `--full-auto` 移除（潜在破坏项 → 无影响）

核查范围为全部已跟踪文件（`git grep`，覆盖 `server/` `web/` `shared/` `scripts/` `doc/` `database/`，
含脚本、探针、文档与测试夹具），另经 `git status --porcelain -uall` 确认工作区无未跟踪文件遗漏。
`--full-auto` / `full_auto` / `fullAuto` 三种写法命中数均为 **0**。

c3 的 codex CLI 参数在 `server/src/kernel/agent/adapters/codex/driver.ts` 的 `codexExecArgs()`
单点构造，产出形如：

```
codex exec --experimental-json [--config …] [--model …] --sandbox <mode> --cd <cwd> \
           --skip-git-repo-check --config approval_policy=<policy> [resume <threadId>]
```

权限面本就由 `--sandbox` 承载（`gateToCodexPolicy` → `read-only` / `workspace-write`），即上游
指定的替代形态。**结论：c3 不产出该 flag，无需改动，无需新增回归断言。**

### 2. 项目 trust 门（最需实跑项 → 不阻塞）

上游新增「对不熟悉的本地项目要求显式 trust」。c3 每条 intent 都在**全新 worktree 目录**下驱动 codex，
这些路径从不在 codex 的 trust 表中（核查宿主 `~/.codex/config.toml`：22 条 `trust_level` 条目里
`worktrees` 相关命中为 0），故风险面真实存在。三组实跑覆盖 c3 的两条启动路径与最坏的空配置场景：

| #   | 场景                             | 工作目录                       | `CODEX_HOME`                                 | 结果                      |
| --- | -------------------------------- | ------------------------------ | -------------------------------------------- | ------------------------- |
| 1   | 宿主机模式                       | 全新 git 目录（不在 trust 表） | 宿主 `~/.codex`（trust 表已有 22 条）        | 起会话 + resume 均 exit 0 |
| 2   | 隔离 home（等价 sandbox custom） | 全新 git 目录                  | 全新目录，**只含 `auth.json`、trust 表全空** | 起会话 exit 0             |
| 3   | sandbox 模式（真实 arapuca）     | 真实 wrapper 的全新工作目录    | 宿主 `~/.codex`（system 认证策略）           | 起会话 + resume 均 exit 0 |

三组均**无 trust 提示、无阻塞、无授权失败**，且各自向对应 `config.toml` 自动写入
`trust_level = "trusted"` 后继续执行（场景 2 从空配置生成了完整条目，证明该行为不依赖既有 trust 表）。

**结论：trust 门只作用于交互式 TUI，`codex exec` 非交互路径自动置信；c3 的 worktree 启动路径与
sandbox 路径均不受影响，无需在 c3 侧预置 trust 条目或新增配置。**

### 3. 二进制分发归档形态（潜在破坏项 → 无影响）

上游停发冗余的 Linux bundle 归档。c3 是 codex 二进制的分发方，故必须核对取用形态。
`server/src/kernel/agent/process/launcher.ts` 的托管安装链路为：

```
GET registry.npmjs.org/@openai/codex  (packument)
  → selectNpmVersion()  // 排除预发布，取最新兼容版
  → dist.tarball 下载 + verifySRI() 校验 sha512
  → tar 解包 + npm install --omit=dev  // 拉平台 optionalDependency，物化原生二进制
```

**全程不触达 GitHub release 归档**。本机托管安装的落地取证：
`~/.c3/vendor/codex/0.147.0/package/node_modules/@openai/` 下为 `codex-darwin-arm64`
（npm alias `npm:@openai/codex@0.147.0-darwin-arm64`），`bin/codex` 可执行且
`--version` → `codex-cli 0.147.0`。`@openai/codex@0.147.0` 的 optionalDependencies 六个平台包
（`linux-x64` / `linux-arm64` / `darwin-x64` / `darwin-arm64` / `win32-x64` / `win32-arm64`）
在 npm 上齐备。

**结论：c3 取用的归档形态（npm tarball + 平台 optionalDependency）仍在上游发布集合内，
Linux 分发不断，无需改动。**

### 4. model catalog 的 VERSION GATE 复查（代码内挂的升级期义务 → 通过）

`adapters/codex/model-catalog.ts` 挂着一条显式的版本闸门：其 catalog entry 的 serde-required 字段集
是对锁定二进制的实测快照，注释要求「codex 升级时按 `doc/architecture/sdk-upgrade/` 既有流程复查」。
本轮按该要求以 `0.147.0` 重跑两项实测：

- **字段集仍充分**：把 c3 生成形态的 catalog（`writeModelCatalogFile()` 的完整 entry）交给
  `codex debug models --config model_catalog_json=<path>` → **解析成功、完整回显，无 `missing field`**。
  0.147.0 确实补入了一批新字段（`additional_speed_tiers` / `service_tiers` / `model_messages` /
  `include_skills_usage_instructions` / `web_search_tool_type` / `input_modalities` 等），但**全部带
  默认值**，未构成新的必填项，c3 的最小合法 entry 无需扩充。
- **reasoning-effort union 未变**：`codex debug models`（0.147.0 内置 catalog，7 个模型）的
  `supported_reasoning_levels` union = `low / medium / high / xhigh / max / ultra`，与
  `SUPPORTED_REASONING_LEVELS` 声明的六档**完全一致，无缺失**。

**结论：VERSION GATE 复查通过，catalog 生成逻辑无需改动。** 仅把三处注释/文档里的版本标注从
`0.146.0` 更新为 `0.147.0`（`model-catalog.ts`、`model-catalog.test.ts`、`relay-architecture.md`），
留痕本轮已复查——这是本次仅有的代码侧改动，且是纯注释。

## 受影响的特性与契约

无行为变更。唯一的代码侧改动是 `adapters/codex/model-catalog.ts` / `model-catalog.test.ts` 的
**纯注释版本标注**（VERSION GATE 由 `0.146.0` 更新为 `0.147.0`，留痕本轮已复查），生成的 catalog
entry 逐字段不变。SDK `dist/` 逐字节零变化 + c3 仅 `import type` 引用消费面六个类型（零形状变化）+ 运行时走 c3 解析的
codex 二进制 + 全部实质新能力落在 CLI/插件/TUI/认证/策略面，以下层面均不受影响：

- 适配器能力账本（`adapters/codex/capabilities.ts`）—— 所有布尔值不变，唯一 `true` 仍为 `taskStore`，
  `perToolApproval: false` 不变。
- vendor 中性接口（`adapters/types.ts`）—— 不变。
- 权限映射（`driver.ts`: `gateToCodexPolicy`）—— 仍只产生 `read-only`/`workspace-write` ×
  `never`/`on-request`/`on-failure`；不采纳 `--approve-for-me`，不调整 `preApproved` 语义。
- CLI 参数构造（`driver.ts`: `codexExecArgs`）—— 不变；不产出 `--full-auto`（本就不产出）。
- MCP 注入机制（`driver.ts`: `mcpServersToCodexConfig`）—— 输出形状不变；不开启 MCP 2026-07-28 协议；
  回环绕过（`withLoopbackNoProxy`）继续必要，不删除、不放宽。
- 会话存储（`session-store.ts`）—— 只读磁盘 JSONL（rollout），按 `thread_id` 定位，不消费会话 section。
- 翻译层（`translate.ts`、`task-store.ts`）—— `ThreadItem` / `TodoListItem` 类型形状不变。
- 二进制分发（`process/launcher.ts`）—— npm registry 链路不变，不取 GitHub release 归档。
- sandbox 网络与认证（`kernel/sandbox/SandboxLauncher.ts`、`vendor-auth.ts`）—— 不变；system codex
  仍用宿主 `~/.codex`，custom 仍用隔离 home + relay token。
- 中继合约（`transport/relay/`、`kernel/relay/contract.ts`）—— 无变化。

不涉及数据库迁移、WebSocket/relay 协议变更、前端功能、其他 agent SDK，也不新增持久化格式或 capability 声明。

### capability ledger 不更新（结论 + 理由）

本升级记录明确：**`adr/0011-vendor-neutral-agent-abstraction.md` 的 capability ledger 不更新。** 理由：
本次升级未触及 vendor 中性能力面——

- `perToolApproval: false` 等 capability ledger 布尔值全部不变（唯一 `true` 仍是 `taskStore`，来自
  Codex todo-list 可观察，与本次无关）；
- `gateToCodexPolicy` 的 sandbox/approval 权限映射不变（`--approve-for-me` 未采纳，不新增审批档位）；
- 新增能力（Agent Plugins、会话 section、Cursor skills 导入、MCP 2026-07-28、Bedrock）**均未被 c3
  接入**，既不新增 c3 可声明的 vendor 能力，也不改变现有能力的布尔判定。

0.147.0 的新能力与修复全部位于 CLI/插件/TUI/认证/策略/发布面，capability grid 保持原样。

## 验证

- **SDK dist 逐字节取证**：`npm pack @openai/codex-sdk@0.146.0 @openai/codex-sdk@0.147.0` 解包后
  `diff -rq package` 仅 `package.json` differ；`dist/index.d.ts` / `dist/index.js` / `dist/index.js.map`
  三文件 `cmp` 逐字节 **IDENTICAL**。`package.json` 逐行差异仅三处：`version`、捆绑
  `@openai/codex: 0.146.0 → 0.147.0`、新增 devDependency `@modelcontextprotocol/conformance`
  （github pin，devDependency 不进运行时、锁文件中无痕）。tarball shasum：
  `0.146.0` = `3526aa49f46e69f0e6dff1ddc6425258addbb539`，
  `0.147.0` = `89814f6b51f0057e759f94c743c57e52aeef98d7`。
  c3 消费的六个类型导出逐一覆盖且零形状变化：`ApprovalMode` / `SandboxMode`（`driver.ts`）、
  `ThreadEvent` / `ThreadOptions`（`driver.ts`、`codex.test.ts`）、`ThreadItem`（`translate.ts`、
  `translate.test.ts`）、`TodoListItem`（`task-store.ts`、`task-store.test.ts`）。
- **版本选择取证（为何不采纳 0.148.0）**：npm `dist-tags` = `{ latest: 0.147.0,
alpha: 0.148.0-alpha.20 }`；`0.148.0` 线在 npm 上仅有 alpha.1 ~ alpha.20 共 20 个预发布，无稳定版
  （另有 `0.147.0-alpha.6.6` 等 0.147 线预发布）。c3 的 `selectNpmVersion()` 经 `isPreRelease()`
  显式排除带 `-` 后缀的版本，托管安装亦不会选到 0.148.0-alpha。**本轮只升稳定版 0.147.0。**
- **锁文件 diff 纯净**：`git diff --numstat pnpm-lock.yaml` = **33 增 / 33 删**，触及的包名仅
  `@openai/codex-sdk`、`@openai/codex` 及六个平台包（`darwin-arm64` / `darwin-x64` / `linux-arm64` /
  `linux-x64` / `win32-arm64` / `win32-x64`）——八类允许包，无 Claude SDK 或其它传递依赖夹带
  （`git diff` 中非 `@openai` 作用域包名为 0；新增的 `@modelcontextprotocol/conformance` 为上游
  devDependency，未进入锁文件）。`pnpm-workspace.yaml` 的 `minimumReleaseAge*` 冷却策略**未放宽、
  未新增豁免条目**（0.147.0 发布于 2026-08-07，至本次升级已满 9 天）。安装后
  `server/node_modules/@openai/codex-sdk` 符号链接指向 `@openai+codex-sdk@0.147.0`，
  `pnpm why @openai/codex-sdk` 唯一解析 `@openai/codex-sdk@0.147.0`；锁文件 `specifier: 0.147.0`、
  `version: 0.147.0` 一致。
- **`--full-auto` 全仓核查**：`git grep -n -- "full-auto"` 与 `git grep -nE "full_auto|fullAuto"`
  命中数均为 **0**（退出码 1 = 无匹配），范围覆盖全部已跟踪文件；`git status --porcelain -uall` 确认
  工作区无未跟踪文件。**c3 不产出该 flag，无残留。**
- **二进制分发链路核查**：托管安装 `~/.c3/vendor/codex/0.147.0/package/node_modules/@openai/` 下为
  `codex-darwin-arm64`；`@openai/codex@0.147.0` 的 optionalDependencies 六个平台包在 npm 上齐备。
  链路为 npm packument → `dist.tarball` → SRI 校验 → `npm install --omit=dev`，**不取 GitHub release
  归档**，归档形态变更不触达 c3。
- **运行时 CLI 版本核查**：`~/.c3/vendor/manifest.json` → codex `source: managed`、
  `selectedVersion: 0.147.0`、`latestCompatibleVersion: 0.147.0`、
  `path: ~/.c3/vendor/codex/0.147.0/bin/codex`；该二进制 `--version` → **`codex-cli 0.147.0`**。
  宿主 PATH 回退 `/opt/homebrew/bin/codex --version` → **`codex-cli 0.147.0`**。
  **托管 CLI 与本次 SDK 版本精确对齐，两条解析路径同版本 ✔**
- **trust 门实跑（本轮重点，三组）**：全部以托管 `0.147.0` 二进制、c3 的参数形态
  （`exec --experimental-json --cd <dir> --skip-git-repo-check --sandbox workspace-write
--config approval_policy="never"`）、`stdin` 关闭执行：
  1. **宿主机 + 陌生目录**：全新 git 目录（`grep` 确认不在宿主 trust 表中）→ exit 0，
     `agent_message` = `TRUST-PROBE-OK`；运行后 `~/.codex/config.toml` 自动新增该目录的
     `trust_level = "trusted"`（22 → 23 条，**验证后已清理复原为 22 条**）。**无阻塞、无提示。**
  2. **空 trust 表的隔离 `CODEX_HOME`**：`CODEX_HOME` 指向只含 `auth.json` 的全新目录（无
     `config.toml`，trust 表全空）+ 全新工作目录 → exit 0，`agent_message` = `ISOLATED-HOME-OK`；
     运行后该隔离 home 内**从零生成** `config.toml` 并写入 `trust_level = "trusted"`。
     **证明自动置信不依赖既有 trust 表，覆盖 sandbox custom 的隔离 home 场景。**
  3. **真实 arapuca sandbox**：经真实 `createSandboxWrapper()` 生成 system 模式 wrapper，在全新
     临时工作目录（探针已断言不在 trust 表）内 → 起会话 exit 0（`SBX-RESUME-SEED`）。
- **双模式起会话 + resume 实跑（验收项）**：
  - **宿主机模式**：起会话 `thread_id = 01a008ff-…1e87de` → `resume <tid>` 追问上轮内容，
    返回同一 `thread_id` 且答出 `TRUST-PROBE-OK`，exit 0。**resume 通过 ✔**
  - **sandbox 模式**：真实 arapuca wrapper 内起会话 `thread_id = 01a00904-…38cdc` →
    `resume <tid>`，返回同一 `thread_id` 且答出 `SBX-RESUME-SEED`，exit 0。**resume 通过 ✔**
    （sandbox stderr 中 `failed to walk skills root ~/.agents/skills: Operation not permitted`
    为 arapuca 按设计拒绝未挂载路径的既有噪声，是隔离生效的证据，非本轮回归。）
- **sandbox 订阅认证 e2e**：`node scripts/e2e/e2e-sandbox-codex-subscription-test.mjs` —— 三项断言
  全 PASS：`CODEX_HOME` 指向宿主 `~/.codex` 且已挂载 / 未使用隔离 relay codex home /
  **codex（`OpenAI Codex v0.147.0`）在 sandbox 内成功登录并回复 PONG**（无 401 Missing bearer）。
  同时证明第 12 项的策略 fail-closed 未把 c3 托管会话变成静默无网。
- **回环 MCP 端到端（第 5 项专项）**：`C3_INTENT_MCP_E2E=1` + 托管 `0.147.0` 跑
  `transport/intent-mcp/e2e.codex.test.ts` —— **1 passed**：codex 在首个 turn 内发现并调用
  `find_intents`。**MCP SDK 3.0.0 升级与非阻塞式 server 启动未造成工具静默缺席 ✔**
- **真实 relay 端到端**：`transport/relay/e2e.codex.test.ts` 用真实 `0.147.0` 二进制跑通完整 relay
  路径——上游文本经 relay 翻译后到达 codex 的 `agent_message` 并被渲染，turn 正常结束（PASS）。
- **model catalog VERSION GATE 复查（0.147.0 实测）**：
  - `codex debug models --config model_catalog_json=<c3 生成形态的 catalog>` → **解析成功、完整回显**，
    无 `missing field`。0.147.0 新增的字段（`additional_speed_tiers` / `service_tiers` /
    `model_messages` / `include_skills_usage_instructions` / `include_plugin_usage_instructions` /
    `include_apps_usage_instructions` / `default_reasoning_summary` / `apply_patch_tool_type` /
    `web_search_tool_type` / `supports_image_detail_original` / `effective_context_window_percent` /
    `input_modalities` / `supports_search_tool` / `use_responses_lite` 等）**全部带默认值**，
    未成为新的必填项。
  - `codex debug models`（内置 catalog，7 个模型）的 `supported_reasoning_levels` union =
    `low / medium / high / xhigh / max / ultra`，与 `SUPPORTED_REASONING_LEVELS` 声明**逐档一致**。
  - **生成逻辑无需改动**；仅更新三处版本标注注释留痕。
- **`pnpm typecheck`**：通过（绿），server + web 均 Done。SDK 类型零变化的直接证据。
- **`pnpm lint`**：`eslint .` **0 error / 17 warning**。17 个 warning 全部为未使用的导入/变量
  （`server/src/upgrade-core.ts`、`server/src/kernel/events/event-match.test.ts`、
  `shared/src/protocol.test.ts`、`web/src/App.vue`、`web/src/controls/*`、
  `web/src/pages/workspacesetting/WorkspaceSetting.vue` 等），属本次改动之外的预存项——本次 diff 为
  `server/package.json` + `pnpm-lock.yaml` + 文档 + `model-catalog.ts` / `model-catalog.test.ts`
  的**纯注释版本标注更新**，与这些 warning 所在文件无交集，warning 数与上一轮基线口径一致。
- **`pnpm vitest run`（全量）**：**446 test files / 7366 passed / 16 skipped / 0 failed**，
  skipped 数与基线（16）一致，**无新增跳过项**。
- **Codex 定向复核**：`adapters/codex/*` + `transport/relay/*` + `transport/intent-mcp/*` 合计
  **157 passed / 1 skipped**（skip = 默认门控的 intent-mcp e2e，已单独以 `C3_INTENT_MCP_E2E=1`
  跑通，见上）。覆盖新建/恢复线程、CLI 参数构造（含 `--sandbox` argv 断言）、策略映射、MCP/relay
  配置、JSONL 生命周期与失败事件、各类 `ThreadItem` 翻译与 todo 快照投影。
