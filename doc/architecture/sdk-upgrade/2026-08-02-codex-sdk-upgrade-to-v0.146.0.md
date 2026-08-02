# Codex SDK 升级记录：0.145.0 → 0.146.0（minor 版本，dist 逐字节零变化）

- **日期**：2026-08-02
- **SDK**：`@openai/codex-sdk`
- **版本**：`0.145.0` → `0.146.0`（`0.147.0-alpha.*` 仍为预发布线，不纳入）
- **范围**：仅 Codex SDK。`@anthropic-ai/claude-agent-sdk`（`^0.3.220`，前置升级已合入）与其它依赖号
  原封不动，`pnpm-lock.yaml` 同步（diff 仅含 `@openai/codex-sdk` + 其捆绑的 `@openai/codex` 及六个平台
  二进制的版本号/`integrity` 变化，33 增 / 33 删）。
- **上游 release notes**：[`rust-v0.146.0`](https://github.com/openai/codex/releases/tag/rust-v0.146.0)
  （2026-07-29）——会话命名/置顶/侧边切换、Agent Plugins manifest 与插件市场、分页 fork 历史、远程
  Code Mode WebSocket、自定义 provider 独立 web search、executor skills 发现，以及一批代理/MCP 生命周期/
  状态保留/终端渲染修复。
- **关联指南**：[`../agent-sdk.md`](../agent-sdk.md)（SDK 升级纪律）、
  [`../codex-sdk-guide.md`](../codex-sdk-guide.md)（适用版本随本次升级更新为 `0.146.0`）、
  [上一份 Codex 记录](2026-07-24-codex-sdk-upgrade-to-v0.145.0.md)

## 结论速览

- **两版 npm 包 `dist/` 逐字节一致，整个包唯一差异是 `package.json` 的两行。** `npm pack` 解包
  `0.145.0` 与 `0.146.0` 后 `diff -rq package` 仅 `package.json` differ；`dist/index.d.ts` /
  `dist/index.js` / `dist/index.js.map` 三个文件 `cmp` 逐字节完全相同。`package.json` 差异逐行只有：
  `version: 0.145.0 → 0.146.0` 与捆绑依赖 `@openai/codex: 0.145.0 → 0.146.0`。
- **TS 类型契约零变化 ⇒ c3 无任何代码需改动。** c3 实际 `import type` 的六个导出形状全部不变
  （`index.d.ts` 既逐字节一致，形状必然不变）：`ApprovalMode` / `SandboxMode`（`driver.ts`）、
  `ThreadEvent` / `ThreadOptions`（`driver.ts`、`codex.test.ts`）、`ThreadItem`（`translate.ts`、
  `translate.test.ts`）、`TodoListItem`（`task-store.ts`、`task-store.test.ts`）。
- **全部实质变更落在 Rust CLI / app-server / TUI 二进制侧**，由 c3 实际解析的 codex 二进制版本决定
  （解析优先级 `$CODEX_PATH` → c3 托管安装 → 宿主 PATH 回退，本次未变）。本轮 c3 托管二进制已对齐
  `0.146.0`，真实 relay 端到端与回环 MCP 验证均在该二进制上跑通。
- **本轮重点是代理面。** 0.146.0 扩大了代理对认证、插件下载、**MCP 授权**、远程执行、WebSocket、
  **重定向**、LM Studio 的覆盖面。c3 以真实 `0.146.0` 二进制完成两项专项验证：①宿主设置 `HTTP_PROXY`
  且未预置回环绕过的场景下，intent MCP 工具经 c3 的 `withLoopbackNoProxy` 绕过后仍可见、可调用、无 502；
  ②A/B 对照证明该绕过对 `127.0.0.1` / `localhost` / `::1` 仍然**必要且充分**（无绕过 → 回环 MCP 被送往
  代理、0 次触达；有绕过 → 直接触达）。既有绕过**不删除、不放宽**。
- **无任何上游条目需 c3 接入。** 逐条评估结论为「兼容且自动获益」或「不适用」，无「需接入」项。
- vendor 中性适配器面（`adapters/types.ts` 与 capability ledger）未被触及，capability grid 不变，
  **capability ledger 不更新**（理由见末节）。

## 逐项 changelog 评估

分类口径：**兼容且自动获益**（随 CLI 升级生效、无需 c3 改动）／**不适用**（落在 c3 未使用的
TUI / 插件市场 / app-server / 安装 / 平台面，或 c3 不生产也不消费）／**需接入**（本轮无）。

| 上游条目                                                                                                   | 分类               | 是否接入 | 依据                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------- | ------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/new`/`/clear` 命名新会话、置顶线程、不关闭切换侧边会话                                                   | 不适用             | 不接入   | TUI 会话管理面；c3 经中性驱动管理会话，不渲染 TUI，会话恢复走只读磁盘 JSONL（`session-store.ts`）。                                                                                       |
| Agent Plugins manifest、工作区插件发布、新增插件市场来源（Bedrock/Claude）                                 | 不适用             | 不接入   | 插件市场面；c3 不发布/消费工作区插件，不接入插件市场来源。                                                                                                                                |
| 线程 fork 分页历史（含不出现在列表的临时 fork）                                                            | 不适用             | 不接入   | 与上一轮一致：c3 不采纳分页历史/临时 fork API，会话恢复继续走只读磁盘 JSONL，不依赖该 API。                                                                                               |
| app-server 经 WebSocket 连接远程 Code Mode 主机                                                            | 不适用             | 不接入   | app-server 远程表面；c3 不接入远程 Code Mode WebSocket，relay 继续使用自定义 provider 的 HTTP/SSE 路径并显式 `supports_websockets=false`。                                                |
| 兼容的自定义 model provider 启用独立 web search                                                            | 不适用             | 不接入   | provider 侧能力；c3 的 web search 仍由既有中性选项 `webSearch`→`webSearchEnabled/webSearchMode` 控制，relay 为 Chat Completions 转换路径，不产生新的 c3 接入点。                          |
| 发现 executor 提供的 skills 并安全读取其资源（含显式选中的 skill）                                         | 不适用             | 不接入   | c3 不生产也不消费 executor skills 项；skill 发现仍走 `<projectDir>/.codex/skills/` 通用基础设施。                                                                                         |
| **代理全面生效**（认证/插件下载/MCP 授权/远程执行/WebSocket/重定向/LM Studio）                             | **兼容且自动获益** | 即时     | CLI 侧扩大代理生效面，位于 c3 之下游。c3 注入的回环 MCP endpoint 经 `withLoopbackNoProxy`（`127.0.0.1`/`localhost`/`::1`）绕过宿主代理；已完成专项验证（见验证节），绕过仍必要且充分。    |
| 认证/配置变更时 MCP 连接与 Apps 工具保持最新（重连已关闭、不重启健康连接）                                 | 兼容且自动获益     | 即时     | CLI 侧 MCP 生命周期修复；`mcpServersToCodexConfig` 输出形状不变，c3 不依赖旧的重连语义，作为兼容收益使用。                                                                                |
| 跨中断/replay/导入/fork 保留已提交消息、最终响应、失败 turn 错误、时间戳与审批设置                         | 兼容且自动获益     | 即时     | 位于 c3 事件翻译之下游，不改变 `ThreadEvent` / `ThreadItem` 输出形状与 JSONL 生命周期；`session-store.ts` 只读磁盘 JSONL 恢复路径不受影响（定向套件覆盖失败 turn/JSONL 生命周期，全绿）。 |
| 终端响应性与渲染改进（非阻塞中断、键盘、窄布局、超链接、刷新 mention）                                     | 不适用             | 不接入   | TUI 渲染面，不落 SDK dist，不影响 JSONL；c3 经 relay 传输、不渲染 TUI。                                                                                                                   |
| Windows 导航键、可靠终止沙箱进程树、安全审查期间保留代理设置                                               | 兼容且自动获益     | 即时     | CLI 内部可靠性修复（进程树终止、安全审查代理保留）位于 c3 之下游，自动获益；c3 主平台 macOS/Linux，Windows 导航键不形成接入点。                                                           |
| 上下文预算紧张时保留更多 skills、skill 目录截断时告警                                                      | 不适用             | 不接入   | CLI 内部上下文预算；c3 不生产也不消费 executor skills，无接入点。                                                                                                                         |
| 文档：共享 HTTP client 用法、代理感知连接池、安全外发、`PathUri` Windows 规范化                            | 不适用             | 不接入   | 文档面，不形成 c3 接入点。                                                                                                                                                                |
| 杂项：OpenAI 托管发布（GitHub 回退）、macOS helper 签名公证、app-server 序列化降本、企业计划识别与更新控制 | 不适用             | 不接入   | 发布/平台/服务内部事项；macOS helper 公证为平台侧收益，不形成 c3 接入点。                                                                                                                 |

## 受影响的特性与契约

无。npm `dist/` 逐字节零变化 + c3 仅 `import type` 引用消费面六个类型（零形状变化）+ 运行时走 c3 解析的
codex 二进制 + 全部实质新能力落在 CLI/app-server/TUI/认证面，以下层面均不受影响：

- 适配器能力账本（`adapters/codex/capabilities.ts`）—— 所有布尔值不变，唯一 `true` 仍为 `taskStore`，
  `perToolApproval: false` 不变。
- vendor 中性接口（`adapters/types.ts`）—— 不变。
- 权限映射（`driver.ts`: `gateToCodexPolicy`）—— 仍只产生 `read-only`/`workspace-write` ×
  `never`/`on-request`/`on-failure`；不调整 `preApproved` 语义。
- MCP 注入机制（`driver.ts`: `mcpServersToCodexConfig`）—— 输出形状不变；回环绕过
  （`withLoopbackNoProxy`）继续必要且充分，不删除、不放宽。
- 会话存储（`session-store.ts`）—— 只读磁盘 JSONL，不依赖 SDK 导出 API；不采纳分页历史/临时 fork API。
- 翻译层（`translate.ts`、`task-store.ts`）—— `ThreadItem` / `TodoListItem` 类型形状不变，
  `todo_list` 仍只进入 observe-only 任务快照。
- 中继合约（`transport/relay/`、`kernel/relay/contract.ts`）—— 无变化，继续显式
  `supports_websockets=false`；不接入远程 Code Mode WebSocket。

不涉及数据库迁移、WebSocket/relay 协议变更、前端功能、其他 agent SDK，也不新增持久化格式或 capability 声明。

### capability ledger 不更新（结论 + 理由）

本升级记录明确：**`adr/0011-vendor-neutral-agent-abstraction.md` 的 capability ledger 不更新。** 理由：
本次升级未触及 vendor 中性能力面——

- `perToolApproval: false` 等 capability ledger 布尔值全部不变（唯一 `true` 仍是 `taskStore`，来自
  Codex todo-list 可观察，与本次无关）；
- `gateToCodexPolicy` 的 sandbox/approval 权限映射不变（仍 `read-only`/`workspace-write` ×
  `never`/`on-request`/`on-failure`）；
- relay 合约继续 `supports_websockets=false`，未因远程 Code Mode WebSocket 而改变。

0.146.0 的新能力与修复全部位于 CLI/app-server/TUI/认证/代理面，既不新增 c3 可声明的 vendor 能力，
也不改变现有能力的布尔判定，故 capability grid 保持原样。

## 验证

- **SDK dist 逐字节取证**：`npm pack @openai/codex-sdk@0.145.0 @openai/codex-sdk@0.146.0` 解包后
  `diff -rq package` 仅 `package.json` differ；`dist/index.d.ts` / `dist/index.js` / `dist/index.js.map`
  三文件 `cmp` 逐字节 **IDENTICAL**。`package.json` 逐行差异仅两处：`version` 与捆绑 `@openai/codex`
  版本号。tarball shasum：`0.145.0` = `83ba20aa9959e308554117f73b3bc243380ceaa9`，
  `0.146.0` = `3526aa49f46e69f0e6dff1ddc6425258addbb539`。c3 消费的六个类型导出逐一覆盖且零形状变化：
  `ApprovalMode` / `SandboxMode`（`driver.ts`）、`ThreadEvent` / `ThreadOptions`（`driver.ts`、
  `codex.test.ts`）、`ThreadItem`（`translate.ts`、`translate.test.ts`）、`TodoListItem`（`task-store.ts`、
  `task-store.test.ts`）。
- **锁文件 diff 纯净**：`git diff --numstat pnpm-lock.yaml` = **33 增 / 33 删**，触及的包名仅
  `@openai/codex-sdk`、`@openai/codex` 及六个平台包（`darwin-arm64` / `darwin-x64` / `linux-arm64` /
  `linux-x64` / `win32-arm64` / `win32-x64`）——八类允许包，无 Claude SDK 或其它传递依赖夹带
  （`git diff` 中非 `@openai` 作用域包名为 0）。安装后 `server/node_modules/@openai/codex-sdk`
  符号链接指向 `@openai+codex-sdk@0.146.0`，`pnpm why @openai/codex-sdk` 唯一解析
  `@openai/codex-sdk@0.146.0`；锁文件 `specifier: 0.146.0`、`version: 0.146.0`，
  integrity `sha512-lhlcfmufd4Evj[…]UJIJOg==`，三处一致。
- **运行时 CLI 版本核查（两条路径均取证）**：
  - c3 实际解析：`$CODEX_PATH` 未设置 → 托管生效。`~/.c3/vendor/manifest.json` → codex
    `source: managed`、`selectedVersion: 0.146.0`、`latestCompatibleVersion: 0.146.0`、
    `path: ~/.c3/vendor/codex/0.146.0/bin/codex`；该二进制 `--version` → **`codex-cli 0.146.0`**。
    **托管 CLI 与本次 SDK 版本精确对齐 ✔**
  - 宿主 PATH：`which codex` → `/opt/homebrew/bin/codex`，`codex --version` → **`codex-cli 0.145.0`**
    （宿主 Homebrew 二进制本轮未升级，仍为上一版）。按解析优先级 `$CODEX_PATH` → c3 托管安装 → 宿主
    PATH 回退，c3 实际解析到托管 `0.146.0`；宿主 `0.145.0` 仅为回退路径，如实取证。
- **真实 relay 端到端**：`transport/relay/e2e.codex.test.ts` 用真实 `0.146.0` 二进制
  （测试进程 `which codex` → 托管 `0.146.0`）跑通完整 relay 路径——上游文本（`PONG-42`）经 relay 翻译后
  到达 codex 的 `agent_message` 并被渲染，会话可取得、turn 正常结束（测试 PASS）。**证明 npm 类型契约
  与实际 `0.146.0` JSONL 行为对齐 ✔**
- **回环 MCP 专项验证（本轮重点，两项）**：
  1. **真实 e2e（充分性，贴近生产）**：宿主设置 `HTTP_PROXY=http://127.0.0.1:7890`（工作代理）且
     **未预置回环绕过**（`env -u NO_PROXY -u no_proxy`）的场景下，以 `C3_INTENT_MCP_E2E=1` + 托管
     `0.146.0` 跑 `transport/intent-mcp/e2e.codex.test.ts`。c3 绕过由测试注入的
     `NO_PROXY=127.0.0.1,localhost,::1`（等价驱动 `withLoopbackNoProxy`）提供——结果 codex 发现并调用
     `find_intents`，`findCalled > 0`、退出码 0、无 502，工具可见可调用。
  2. **A/B 对照（必要性 + 充分性）**：以本地 502「敌对代理」+ 计数型回环 MCP endpoint 对 `0.146.0`
     做对照——无回环绕过时 MCP 触达 **0 次**（被送往代理、502，证明绕过**必要**）；有回环绕过时触达
     **1 次**（直达，证明绕过**充分**）。结论：`withLoopbackNoProxy` 对 `127.0.0.1`/`localhost`/`::1`
     的绕过在 0.146.0 代理覆盖面扩大后仍然必要且充分，既有绕过不删除、不放宽。
- **`pnpm typecheck`**：通过（绿），server + web 均 Done。SDK 类型零变化的直接证据。
- **`pnpm lint`**：`eslint .` **0 error / 4 warning**。4 个 warning 全部为测试文件中未使用的导入
  （`server/src/kernel/events/event-match.test.ts` ×1、`shared/src/protocol.test.ts` ×3），属本次改动
  之外的预存项——本次 diff 仅 `server/package.json` + `pnpm-lock.yaml` + 升级文档，未触及这些文件，
  warning 数与上一轮基线一致。
- **`pnpm vitest run`（全量）**：**4989 passed / 16 skipped / 0 failed**，skipped 数与基线（16）一致，
  无新增跳过项。
- **Codex 定向复核**：`adapters/codex/*` + `transport/relay/*` + `transport/intent-mcp/*` 合计
  **144 passed / 1 skipped**（skip = 需登录 codex 的 intent-mcp e2e，与基线一致）。覆盖新建/恢复线程、
  CLI 参数构造、策略映射、MCP/relay 配置、JSONL 生命周期与失败事件、各类 `ThreadItem` 翻译与 todo 快照
  投影；`relay/e2e.codex.test.ts` 用真实 `0.146.0` 二进制端到端跑通 relay，确认上游变更未隐式改变现有行为。
