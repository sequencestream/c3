# Codex SDK 升级记录：0.142.3 → 0.142.5（WebSocket trace 安全修复）

- **日期**：2026-07-06
- **SDK**：`@openai/codex-sdk`
- **版本**：`0.142.3` → `0.142.5`（`0.143.x` 仍为 alpha，不纳入）
- **范围**：仅 Codex SDK。`@anthropic-ai/claude-agent-sdk`（`^0.3.201`）与其它依赖号原封不动，
  `pnpm-lock.yaml` 同步（diff 仅含 `@openai/codex-sdk` + 其捆绑的 `@openai/codex` 及六个平台二进制的
  版本号/`integrity` 变化）。
- **上游 release notes**：
  [`rust-v0.142.4`](https://github.com/openai/codex/releases/tags/rust-v0.142.4)（无用户可见变化）、
  [`rust-v0.142.5`](https://github.com/openai/codex/releases/tags/rust-v0.142.5)
  （Bug Fixes：Prevented full Responses WebSocket request payloads from being written to trace logs，
  PR [#30771](https://github.com/openai/codex/pull/30771)，backport 到 `release/0.142`）
- **关联指南**：[`../agent-sdk.md`](../agent-sdk.md)（SDK 升级纪律）、
  [上一份 Codex 记录](2026-06-29-codex-sdk-upgrade-to-v0.142.3.md)（架构事实沿用）

## 结论速览

- **SDK 的编译产物与类型定义两版完全一致（字节级）**：`npm pack` 解包 `0.142.3` 与 `0.142.5` 后
  `diff -rq dist`（`index.d.ts` / `index.js` / `index.js.map`）→ **`DIST IDENTICAL`**；`package.json`
  仅 `version` 与捆绑的 `@openai/codex` 依赖号不同。c3 用到的全部导出（`ApprovalMode` / `SandboxMode` /
  `ThreadEvent` / `ThreadOptions` / `ThreadItem` / `TodoListItem`，均为 `import type`）无任何变化，
  **没有任何 c3 代码因 SDK 接口而需改动**。本次仍为一次**纯类型层（且类型字节一致）的版本号对齐**。
- **`0.142.5` 的实质变化是 CLI/Rust 二进制侧的 trace 安全修复，不落在 npm SDK 的 `dist/` 里。** 该修复
  防止 Responses WebSocket 的完整请求 payload 被写入 trace 日志。它随 codex Rust 二进制发布，`@openai/codex-sdk`
  的 JS `dist/` 未变，因此 **npm 依赖升级本身不会给 c3 运行时带来这项防护**——要真正获得 CLI 侧防护，
  必须升级操作系统 PATH 上的 codex（见「残余风险与操作提示」）。
- **c3 的 relay 路径本就不使用 WebSocket，且不记录请求体/凭证**：经审查，c3 relay 与日志路径不存在这条
  修复所针对的泄漏面（详见「relay/日志安全核查」）。因此本升级对 c3 相当于「稳定线补丁对齐 + 记录 CLI
  侧残余风险」，无代码改动。
- vendor 中性适配器面（`adapters/types.ts` 与 capability ledger）未被触及，capability grid 不变。

## 关联架构事实（沿用上一份记录）

c3 运行时不使用 SDK 捆绑的 `@openai/codex` 二进制。Codex 驱动（`adapters/codex/driver.ts`）通过
`spawn('codex')` 调起 `$CODEX_PATH` → PATH 上探测到的 codex 二进制；`@openai/codex-sdk` 在 `server/src`
中**只被 `import type` 引用**（无运行时 import）。因此 SDK 的 npm 版本决定的是**编译期类型**，PATH 上的
codex 版本决定的才是**运行时 CLI 行为**——这次安全修复正落在后者。

## relay/日志安全核查（本次重点）

intent 的核心关切是「c3 的 codex-relay 或日志路径是否可能把 WebSocket/Responses 完整请求 payload、
`Authorization`、真实 upstream `apiKey` 或 relay token 写进日志」。逐点静态审查结论：

- **relay 不使用 WebSocket。** `server/src/transport/codex-relay/index.ts` 的 handler 只接收
  `POST <PATH>/responses`（HTTP + SSE）；relay provider 由 driver 显式注册
  `model_providers.c3relay.supports_websockets=false`，强制 Codex 走 HTTP POST + SSE。上游修复针对的
  WebSocket trace 路径在 c3 relay 里根本不存在。
- **relay handler 无任何请求体/凭证日志输出。** `codex-relay/index.ts` 与 `translate.ts` 全文无
  `console.*` / logger 调用；`reqBody`（完整 Responses 请求体）、转换后的 Chat body、`upstream.apiKey`、
  `Authorization` header、relay token 均**只被解析/转换/转发，不被打印**。token 通过 `bindings` Map 按值
  查绑定，真实 key 只用于向上游 `fetch` 时构造 `Authorization: Bearer <apiKey>`，run 结束即 evict。
- **进程 logger 只是 stdout/stderr tee。** `kernel/infra/logger.ts` 把 `process.stdout/stderr.write`
  包一层 tee 到 `~/.c3/log/c3.log`，不主动构造任何请求体/凭证内容；它只忠实转写现有 `console.*`。因此
  风险取决于「是否有调用点打印完整请求体/凭证」，而非 tee 本身——上一条已确认 relay 无此类调用点。
- **codex adapter 无请求体日志。** `adapters/codex/` 内唯一的 `console.warn`（`driver.ts:719`）只输出
  「sandbox 内不支持 prompt 图片，本回合丢弃」的静态提示，不含任何 payload/凭证。`CODEX_API_KEY` 只作为
  子进程 env 传递（relay 模式下其值是 relay token 而非真实 key），不进日志。
- **`session-store.ts` 读取的是 Codex 自己落盘的 JSONL 会话记录**，非 relay trace 日志，本任务未触碰其
  会话投影语义。

**结论：c3 侧无泄漏点，无需代码修复。** 本次交付为依赖 + 文档变更。

## 残余风险与操作提示（必须执行）

- **PATH codex 需单独升级才能获得 CLI 侧 trace 防护。** 本机 PATH codex 当前为
  **`0.142.4`（`/opt/homebrew/bin/codex`），低于 `0.142.5`**，尚未包含 #30771 的 WebSocket trace 修复。
- 若用户/部署以 `wireApi='responses'` 的 **DIRECT** 路径（不经 c3 relay，codex 原生直连支持 WebSocket 的
  upstream）运行 codex，其 WebSocket 请求 payload 的 trace 安全性由 **PATH codex 版本**决定，**不会**随本次
  npm SDK 升级自动修复。
- **操作动作**：把 PATH 上的 codex 升级到至少 `0.142.5`（如 `brew upgrade codex`）。本任务不通过代码或
  安装脚本强制该升级，仅在此标注为可执行操作风险。
- c3 自身的 relay 路径（`supports_websockets=false`，HTTP POST + SSE，且不记录请求体）不受该 WebSocket
  trace 泄漏面影响，本升级不改变该约束。

## 受影响的特性与契约

无。SDK 接口字节一致 + c3 仅 `import type` 引用 + 运行时走 PATH codex + relay 不使用 WebSocket 且不记录
请求体，多重保证以下层面均不受影响：

- 适配器能力账本（`adapters/codex/capabilities.ts`）—— 所有布尔值不变。
- vendor 中性接口（`adapters/types.ts`）—— 不变。
- MCP 注入机制（`driver.ts`: `mcpServersToCodexConfig`）—— 输出形状不变。
- 会话存储（`session-store.ts`）—— 只读磁盘 JSONL，不依赖 SDK 导出 API。
- 翻译层（`translate.ts`、`task-store.ts`）—— `ThreadItem` / `TodoListItem` 类型形状不变。
- 中继合约（`codex-relay/`、`relay-contract.ts`）—— 无变化（`codex-relay` 本就不 import 任何 SDK 类型，
  且继续显式关闭 WebSocket）。

## 验证

- **SDK dist 字节对比**：`npm pack @openai/codex-sdk@0.142.3 @openai/codex-sdk@0.142.5` 解包后
  `diff -rq dist`（`index.d.ts` / `index.js` / `index.js.map`）→ **`DIST IDENTICAL`**；`package.json`
  仅 `version` + `@openai/codex` 依赖号不同。这是 SDK 类型/产物无变化的最直接证据，安全修复不在 JS dist 内。
- **锁文件 diff 纯净**：`git diff pnpm-lock.yaml` 仅含 `@openai/codex-sdk` 与 `@openai/codex`
  （含六平台二进制）的版本行与 `integrity`，无 Claude SDK 或其它依赖夹带。
- **relay/日志静态审查**：`transport/codex-relay`（`index.ts` / `translate.ts`）、`adapters/codex`、
  `kernel/infra/logger.ts` 均无完整 Responses/Chat 请求体、`Authorization`、真实 `apiKey`、relay token 的
  日志输出（见「relay/日志安全核查」）。未发现泄漏点，故无新增/修改测试。
- **`pnpm typecheck`**：通过（绿）。SDK 类型无变化的第二直接证据。
- **`pnpm lint`**：`eslint .` 0 error / 0 warning。
- **`pnpm vitest run`**：**3481 passed / 3 skipped / 0 failed**（本 worktree 无预存红）。其中 codex 相关
  用例单独复核：`adapters/codex/*` + `transport/codex-relay/*` + `transport/intent-mcp/*` 合计
  **113 passed / 1 skipped**（skip = 需登录 codex 的 intent-mcp e2e）。`codex-relay/e2e.codex.test.ts` 用
  真实 codex 二进制端到端跑通 relay 路径。
- **PATH codex 版本核查**：`codex --version` → `codex-cli 0.142.4`（`/opt/homebrew/bin/codex`），低于
  `0.142.5`，据此写入上文「残余风险与操作提示」。
