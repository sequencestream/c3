# Codex SDK 升级记录：0.142.5 → 0.144.1（版本号对齐 + 运行时 CLI 来源澄清）

- **日期**：2026-07-17
- **SDK**：`@openai/codex-sdk`
- **版本**：`0.142.5` → `0.144.1`（`0.145.x` 仍为 alpha，不纳入）
- **范围**：仅 Codex SDK。`@anthropic-ai/claude-agent-sdk`（`^0.3.207`）与其它依赖号原封不动，
  `pnpm-lock.yaml` 同步（diff 仅含 `@openai/codex-sdk` + 其捆绑的 `@openai/codex` 及六个平台二进制的
  版本号/`integrity` 变化，33 增 / 33 删）。
- **上游 release notes**：区间内共三个稳定版（其余 43 个为 `0.143.0-alpha.*` / `0.144.0-alpha.*`，不纳入）——
  [`rust-v0.143.0`](https://github.com/openai/codex/releases/tag/rust-v0.143.0)、
  [`rust-v0.144.0`](https://github.com/openai/codex/releases/tag/rust-v0.144.0)、
  [`rust-v0.144.1`](https://github.com/openai/codex/releases/tag/rust-v0.144.1)
- **关联指南**：[`../agent-sdk.md`](../agent-sdk.md)（SDK 升级纪律）、
  [`../codex-sdk-guide.md`](../codex-sdk-guide.md)（适用版本随本次升级更新为 `0.144.1`）、
  [上一份 Codex 记录](2026-07-06-codex-sdk-upgrade-to-v0.142.5.md)

## 结论速览

- **SDK 的编译产物与类型定义两版完全一致（字节级）**：`npm pack` 解包 `0.142.5` 与 `0.144.1` 后
  `diff -rq dist`（`index.d.ts` / `index.js` / `index.js.map`）→ **`DIST IDENTICAL`**；`package.json`
  仅 `version` 与捆绑的 `@openai/codex` 依赖号不同。c3 用到的全部导出（`ApprovalMode` / `SandboxMode` /
  `ThreadEvent` / `ThreadOptions` / `ThreadItem` / `TodoListItem`，均为 `import type`）无任何变化，
  **没有任何 c3 代码因 SDK 接口而需改动**。跨越两个 minor 仍是一次**纯类型层（且类型字节一致）的版本号对齐**。
- **本区间的全部实质变化都落在 Rust CLI / app-server / TUI / 安装面，不落在 npm SDK 的 `dist/` 里。**
  与上一份记录同理：npm 依赖升级本身不会给 c3 运行时带来这些改进——运行时行为由 c3 实际解析的 codex
  二进制版本决定（见「运行时 CLI 来源」）。
- **`writes` app-approval 模式不进入 SDK 类型层，因此不存在误接入面。** `0.144.1` 的
  `dist/index.d.ts` 中 `ApprovalMode = "never" | "on-request" | "on-failure" | "untrusted"`——
  **不含 `writes`**。它是 app-server/TUI 的审批模式，`codex exec` 路径无从消费。`gateToCodexPolicy`
  维持原有映射，`perToolApproval: false` 不变。
- **上一份记录的一条架构事实已过时，本次更正**：Codex CLI 的解析不再是「`$CODEX_PATH` → PATH 探测」，
  而是 **`$CODEX_PATH` → c3 托管安装 → 宿主 PATH 回退**，托管优先于宿主 PATH（见「运行时 CLI 来源」）。
- vendor 中性适配器面（`adapters/types.ts` 与 capability ledger）未被触及，capability grid 不变。

## 运行时 CLI 来源（本次重点，更正上一份记录）

`server/src/kernel/agent/process/launcher.ts` 的 `HOST_BINARIES.codex` + 解析函数确立的**优先级事实**：

1. **`$CODEX_PATH` 覆盖**（`source: 'env-override'`）——可执行则直接选中；不可执行则落
   `override-invalid`，**不再回退**。
2. **c3 托管安装**（`source: 'managed'`，`~/.c3/vendor/codex/<version>/bin/codex`）——按
   「用户在设置里选定的版本（`vendorCliVersions`）→ 上次同步记录的 `latestCompatibleVersion` →
   manifest 记录的 `selectedVersion`」依次降级，每个不可用候选记 `lastError` 但不改写用户选择。
3. **宿主 PATH 回退**（`source: 'host-path-fallback'`）——仅当上述全部落空。

**因此「shell 里 `codex --version` 是多少」并不等于「c3 运行时执行哪个二进制」**：只要托管安装可用，
宿主 PATH 上的 codex 根本不会被调起。本次据此分别取证（见「验证」），两条路径均满足 `>= 0.144.1`。

`compatibleRange` 为 `>=0.0.0 <999.0.0`，即 launcher 不对 codex 版本设下界，**CLI 版本门槛靠本记录
的人工核查保证，而非代码强制**。

## 逐项 changelog 评估

分类口径：**兼容且自动获益**（随 CLI 升级生效、无需 c3 改动）／**不适用**（落在 c3 未使用的
app-server / TUI / 安装 / 平台面）／**后续能力**（有价值但需独立 intent 决策，不绑定本次版本对齐）。

### `rust-v0.143.0`

| 上游条目                                                                               | 分类           | 依据                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP 工具默认走 tool search；ChatGPT-hosted MCP 可用会话认证 (#29486, #29733)           | 兼容且自动获益 | c3 以 `enabled_tools` **显式 allowlist** 注入 intent MCP，并置 `default_tools_approval_mode: 'approve'`；tool search 是模型侧发现机制，不改变 allowlist 语义。ChatGPT-hosted 认证不适用（c3 注入的是自建 HTTP MCP + `bearer_token_env_var`）。 |
| 认证与 Responses 流量可走 macOS/Windows 系统代理，含 PAC/WPAD (#26708, #26709, #31335) | 兼容且自动获益 | 仅影响 codex 自身的出站网络。c3 relay 是 `127.0.0.1` 本地回环，不经系统代理；DIRECT 路径随 CLI 获益。relay 合约不变。                                                                                                                          |
| 关闭时保留尾部 realtime transcript 与 terminal rollout 事件 (#29918, #30144)           | 兼容且自动获益 | c3 `session-store.ts` 读取 codex 落盘的 rollout JSONL；该修复使中断/关闭时的 JSONL 更完整，对会话投影只增不减，无需适配。                                                                                                                      |
| Code Mode 缺少模型元数据时告警 (#29490)                                                | 兼容且自动获益 | 与 c3 已知的「relay 自定义模型下 code-mode 元数据 fallback」问题同源；c3 已通过钉 codex-facing 模型别名规避，此告警仅提升可诊断性。                                                                                                            |
| 增量 WebSocket 请求成功率（忽略响应元数据比较）(#30770)                                | 不适用         | c3 relay 强制 `supports_websockets=false`（HTTP POST + SSE），无 WebSocket 面。                                                                                                                                                                |
| 远程插件默认启用 + 目录/npm marketplace (#30297 等)                                    | 不适用         | TUI/插件面；c3 走 `codex exec --experimental-json` 一次性非交互执行。                                                                                                                                                                          |
| `codex remote-control pair` 配对码 (#29913)                                            | 不适用         | c3 不使用 remote-control daemon。                                                                                                                                                                                                              |
| Bedrock GPT-5.6 Sol/Terra/Luna + `max` reasoning effort (#30285, #30467)               | 后续能力       | c3 经 relay 接自有 upstream；新增 Bedrock 模型族需独立的模型清单/能力决策。                                                                                                                                                                    |
| app-server 可查环境、列子线程、按轮次 fork (#30291, #29591, #30277)                    | 不适用         | app-server 协议面，`codex exec` 路径不消费。                                                                                                                                                                                                   |
| Windows ConPTY、TUI 安全提示、exec server 离线恢复等修复                               | 不适用         | TUI / Windows / remote-executor 面。                                                                                                                                                                                                           |
| OpenSSL 3.6.3、Hono、fast-uri 等安全公告升级 (#29487 等)                               | 兼容且自动获益 | 随 codex Rust 二进制发布，托管 CLI 已含。                                                                                                                                                                                                      |

### `rust-v0.144.0`

| 上游条目                                                                     | 分类           | 依据                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新增 `writes` app-approval 模式（放行只读、写入时提示）(#30482)              | 不适用（边界） | app-approval 属 app-server/TUI 面，**未进入 SDK `ApprovalMode` 类型**（见「结论速览」取证）。c3 `codex exec` 无交互审批接收方（`perToolApproval: false`），接入将产生无人应答的提示。不映射到 c3 权限网格。 |
| MCP 工具可交互式请求认证，无需实验性开关 (#28772)                            | 不适用         | c3 注入的 MCP 用 `bearer_token_env_var` 预置认证，非交互路径无 elicitation 接收方；c3 不新增认证 UI/状态/协议处理。                                                                                         |
| Responses WebSocket 保持低延迟传输并尊重系统代理与自定义 CA (#31441, #31622) | 不适用         | 同上，c3 relay 关闭 WebSocket。DIRECT 路径可随 CLI 获益，但不扩展 relay 合约。                                                                                                                              |
| Intel macOS 发行二进制的 Code Mode 崩溃修复 (#30953)                         | 兼容且自动获益 | 平台可靠性修复，随二进制生效。c3 intent run 本就关闭 code mode（见 `0.144.1` 条目）。                                                                                                                       |
| 恢复的 ChatGPT 线程在 compaction 引用退役模型时用当前模型重试 (#30319)       | 不适用         | 针对 ChatGPT 认证线程的 compaction 路径；c3 经 relay 走 API key + 显式钉定模型。                                                                                                                            |
| 用量额度重置显示类型/过期并可选择兑换 (#30488)                               | 不适用         | TUI 用量选择器面。                                                                                                                                                                                          |
| app-server 运行时提供认证 + 托管登录重定向 (#28745, #31274)                  | 不适用         | app-server/登录面。                                                                                                                                                                                         |
| 检测全局 pnpm 安装以修正诊断与更新 (#31503)                                  | 不适用         | c3 托管安装直接解包 npm tarball 到 `~/.c3/vendor/codex`，不依赖 codex 自更新。                                                                                                                              |
| Ultra reasoning 高并发用量告警 (#31621)                                      | 不适用         | TUI 面。                                                                                                                                                                                                    |
| Windows sandbox 写入/主运行时访问修复 (#31138, #31574)                       | 不适用         | Windows 面；c3 sandbox 走 arapuca（macOS/Linux）。                                                                                                                                                          |
| 粘贴终端控制序列破坏 TUI 渲染/恢复历史 (#31494)                              | 不适用         | TUI 渲染面。                                                                                                                                                                                                |
| `codex_apps` 连接器过期认证刷新 (#31486)                                     | 不适用         | Codex Apps 连接器面。                                                                                                                                                                                       |
| `/review` 分支选择器、插件 skill 加载性能等 (#31348, #31464, #31480)         | 不适用         | TUI/远程执行器面。                                                                                                                                                                                          |

### `rust-v0.144.1`

| 上游条目                                                               | 分类           | 依据                                                                                                                                                                   |
| ---------------------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| standalone 安装器在 GitHub 返回紧凑/乱序 release 元数据时失败 (#31913) | 不适用         | c3 托管安装自行从 npm registry 取 tarball + `integrity` 校验，不使用 codex standalone installer 脚本。                                                                 |
| macOS 包安装同时暴露 code-mode host (#31913)                           | 兼容且自动获益 | 安装完整性修复，随二进制生效。                                                                                                                                         |
| companion host 二进制不可用时 code mode 回退到内嵌运行时 (#31913)      | 兼容且自动获益 | 可靠性兜底。c3 的 **intent run 显式设 `features.js_repl=false`**（`driver.ts`），本就关闭 code-execution 沙箱，该回退对 intent run 不触发；对其它 codex run 为纯增益。 |

## 受影响的特性与契约

无。SDK 接口字节一致 + c3 仅 `import type` 引用 + 运行时走 c3 解析的 codex 二进制 + 全部实质变化落在
app-server/TUI/安装面，以下层面均不受影响：

- 适配器能力账本（`adapters/codex/capabilities.ts`）—— 所有布尔值不变，`perToolApproval: false` 不变。
- vendor 中性接口（`adapters/types.ts`）—— 不变。
- 权限映射（`driver.ts`: `gateToCodexPolicy`）—— 仍只产生 `read-only`/`workspace-write` ×
  `never`/`on-request`/`on-failure`，不引入 `writes`。
- MCP 注入机制（`driver.ts`: `mcpServersToCodexConfig`）—— 输出形状不变（`enabled_tools` 显式
  allowlist + `default_tools_approval_mode: 'approve'`）。
- 会话存储（`session-store.ts`）—— 只读磁盘 JSONL，不依赖 SDK 导出 API。
- 翻译层（`translate.ts`、`task-store.ts`）—— `ThreadItem` / `TodoListItem` 类型形状不变。
- 中继合约（`transport/relay/`、`kernel/relay/contract.ts`）—— 无变化，继续显式
  `supports_websockets=false`。

不涉及持久化数据、迁移或公共 API。

## 验证

- **SDK dist 字节对比**：`npm pack @openai/codex-sdk@0.142.5 @openai/codex-sdk@0.144.1` 解包后
  `diff -rq dist`（`index.d.ts` / `index.js` / `index.js.map`）→ **`DIST IDENTICAL`**；`package.json`
  仅 `version` + `@openai/codex` 依赖号不同。c3 消费的六个类型导出全部覆盖：`ApprovalMode` /
  `SandboxMode`（`driver.ts`）、`ThreadEvent` / `ThreadOptions`（`driver.ts`、`codex.test.ts`）、
  `ThreadItem`（`translate.ts`、`translate.test.ts`）、`TodoListItem`（`task-store.ts`、
  `task-store.test.ts`）——均无变化。
- **`0.144.1` 与 `latest`（`0.144.5`）的 dist 亦字节一致**（`DIST IDENTICAL`）。故按 spec 固定
  `0.144.1`、而托管 CLI 实际为 `0.144.5`，在**类型层零差异**，不构成 SDK 与运行时的类型偏斜。
- **锁文件 diff 纯净**：`git diff pnpm-lock.yaml` 触及的包名仅 `@openai/codex-sdk`、`@openai/codex`
  及六个平台包（`darwin-arm64` / `darwin-x64` / `linux-arm64` / `linux-x64` / `win32-arm64` /
  `win32-x64`），无 Claude SDK 或其它依赖夹带。
- **运行时 CLI 版本核查（两条路径分别取证）**：
  - c3 实际解析：`~/.c3/vendor/manifest.json` → `source: managed`、`selectedVersion: 0.144.5`、
    `latestCompatibleVersion: 0.144.5`、`path: ~/.c3/vendor/codex/0.144.5/bin/codex`、`lastError: null`。
    **`0.144.5 >= 0.144.1` ✔**（`$CODEX_PATH` 未设置，故托管生效）。
  - 宿主 PATH：`codex --version` → **`codex-cli 0.144.5`**（`/opt/homebrew/bin/codex`）。**✔**
  - 两者一致且均达标，上一份记录遗留的「PATH codex 落后」操作风险**已消除**。
- **`pnpm typecheck`**：通过（绿）。SDK 类型无变化的第二直接证据。
- **`pnpm lint`**：`eslint .` exit 0，0 error / 0 warning。
- **`pnpm vitest run`**：**3926 passed / 16 skipped / 0 failed**（本 worktree 无预存红）。
- **Codex 定向复核**：`adapters/codex/*` + `transport/relay/*` + `transport/intent-mcp/*` 合计
  **144 passed / 1 skipped**（skip = 需登录 codex 的 intent-mcp e2e）。覆盖策略映射、MCP 配置、
  事件翻译与 relay `supports_websockets=false`；`relay/e2e.codex.test.ts` 用真实 codex 二进制
  （即托管 `0.144.5`）端到端跑通 relay 路径，确认上游新能力未隐式改变现有行为。
