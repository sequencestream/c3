# Codex SDK 升级记录：0.144.6 → 0.145.0（minor 版本，dist 仅一处加性类型变化）

- **日期**：2026-07-24
- **SDK**：`@openai/codex-sdk`
- **版本**：`0.144.6` → `0.145.0`（`0.146.0-alpha.*` 仍为预发布线，不纳入）
- **范围**：仅 Codex SDK。`@anthropic-ai/claude-agent-sdk`（`^0.3.215`）与其它依赖号原封不动，
  `pnpm-lock.yaml` 同步（diff 仅含 `@openai/codex-sdk` + 其捆绑的 `@openai/codex` 及六个平台二进制的
  版本号/`integrity` 变化，33 增 / 33 删）。
- **上游 release notes**：[`rust-v0.145.0`](https://github.com/openai/codex/releases/tag/rust-v0.145.0)
  （2026-07-21）——实验性分页线程历史、多代理 V2 稳定、音频输入/工具输出、`/import` 扩展、
  实验性 Amazon Bedrock 登录、TUI 内联可视化链接，以及一批性能/安全/沙箱修复。
- **关联指南**：[`../agent-sdk.md`](../agent-sdk.md)（SDK 升级纪律）、
  [`../codex-sdk-guide.md`](../codex-sdk-guide.md)（适用版本随本次升级更新为 `0.145.0`）、
  [上一份 Codex 记录](2026-07-21-codex-sdk-upgrade-to-v0.144.6.md)

## 结论速览

- **两版 dist 只有一处加性类型变化，c3 不消费该字段，因此没有任何 c3 代码需改动。**
  `npm pack` 解包 `0.144.6` 与 `0.145.0` 后 `diff -rq dist` 全部三个文件（`index.d.ts` / `index.js` /
  `index.js.map`）均报 differ，但逐行 diff 只有一处：`Usage` 类型新增可选字段
  `cache_write_input_tokens: number`（«写入 prompt cache 的输入 token 数»），且 `index.js` 的
  `turn.completed` 解析分支相应加了一行 `parsed.usage.cache_write_input_tokens ??= 0` 的防御默认。
  除此之外 `package.json` 仅 `version` 与捆绑的 `@openai/codex` 依赖号不同。
- **`Usage` 不在 c3 消费面内。** c3 的 Codex 适配器把 `turn.started` / `turn.completed` 显式丢弃
  （`driver.ts` 的事件循环注释：turn.completed 无规范对应物，generator 结束即为 turn-end 信号），
  从不读取 `usage`。新增字段既不进入任何规范消息，也不落任何持久化，纯属信息面加性扩展。
- **c3 实际 `import type` 的六个导出零形状变化**：`ApprovalMode` / `SandboxMode`
  （`driver.ts`）、`ThreadEvent` / `ThreadOptions`（`driver.ts`、`codex.test.ts`）、
  `ThreadItem`（`translate.ts`、`translate.test.ts`）、`TodoListItem`（`task-store.ts`、
  `task-store.test.ts`）——逐一核对 d.ts 均无变化。
- **0.145.0 的实质新能力全部落在 Rust CLI / app-server / TUI / 模型侧，不落在 npm SDK 的 `dist/` 里，
  也不构成 c3 的接入面。** 分页历史、多代理 V2、音频 I/O、上下文分支、`/import`、Bedrock 登录、
  内联可视化链接均未在 SDK 类型层新增可选 c3 能力；运行时行为由 c3 实际解析的 codex 二进制版本决定
  （解析优先级 `$CODEX_PATH` → c3 托管安装 → 宿主 PATH 回退，本次未变）。
- vendor 中性适配器面（`adapters/types.ts` 与 capability ledger）未被触及，capability grid 不变。

## 逐项 changelog 评估

分类口径：**兼容且自动获益**（随 CLI 升级生效、无需 c3 改动）／**不适用**（落在 c3 未使用的
app-server / TUI / 安装 / 认证 / 平台面）。

| 上游条目                                                                                   | 分类                    | 是否接入      | 依据                                                                                                                                                 |
| ------------------------------------------------------------------------------------------ | ----------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 实验性分页线程历史（恢复/搜索/持久化名/子代理/记忆）                                       | 兼容且自动获益          | 即时          | SDK 内部改进，不改变现有 `ThreadEvent` / `ThreadItem` 输出形状；c3 会话恢复走只读磁盘 JSONL（`session-store.ts`），不依赖该 API。                    |
| `/import` 扩展（迁移 Cursor/Claude Code 配置、MCP、插件）                                  | 不适用                  | 不接入        | 模型/CLI 侧指令变更，c3 不注入配置迁移，也不解析。                                                                                                   |
| 实验性 Amazon Bedrock 登录、自定义端点认证                                                 | 不适用                  | 不接入        | c3 不管理 provider 认证；relay 走既有 `CODEX_RELAY_PROVIDER` 注入路径，不受影响。                                                                    |
| 音频输入与工具输出、流式实时 V3 对话                                                       | 兼容且自动获益          | 即时          | 加性能力，不改变现有消息类型；c3 不产生也不消费音频项。                                                                                              |
| 多代理 V2 稳定（可配置子代理模型/推理级别/并发）                                           | 兼容且自动获益          | 即时          | 子代理配置在 SDK/CLI 层透明传递，不新增 c3 公共接口。                                                                                                |
| TUI 内联可视化链接                                                                         | 不适用                  | 不接入        | TUI 侧变更，c3 经 relay 传输、不渲染 TUI。                                                                                                           |
| 上下文分支修复（编辑早期提示/重试保留原对话）                                              | 兼容且自动获益          | 即时          | CLI 内部对话保存行为修复，位于 c3 事件翻译之下游，无类型面。                                                                                         |
| 长对话终端响应优化（增量 Markdown/减少重绘/缓存）                                          | 兼容且自动获益          | 即时          | TUI 渲染优化，不落 SDK dist，不影响 JSONL。                                                                                                          |
| MCP 启动/认证修复（超时、序列化刷新、复用工具目录）                                        | 兼容且自动获益          | 即时          | CLI 侧 MCP 生命周期修复；c3 的 `mcpServersToCodexConfig` 输出形状不变，减少了超时/冲突风险。                                                         |
| Windows 执行与沙箱可靠性改进                                                               | 不适用                  | 不接入        | c3 主运行平台为 macOS/Linux。                                                                                                                        |
| macOS code-mode 安装修复 + in-process fallback                                             | 兼容且自动获益          | 即时          | CLI 内部 code-mode host 可用性修复，位于 c3 之下游。                                                                                                 |
| 安全/审批强化（强制 `rm` 检测、完整访问确认、保留拒绝原因）                                | 兼容且自动获益          | 即时          | CLI 侧 shell 命令判定，位于 c3 权限网格（`gateToCodexPolicy` 产出的 `sandbox_mode` × `approval_policy`）之下游，c3 不重复实现也不据此放宽/收紧映射。 |
| `Usage.cache_write_input_tokens` 新增字段（SDK dist 唯一变化）                             | 兼容且自动获益          | 即时          | 纯加性信息字段；c3 丢弃 `turn.completed`/`usage`，不读取、不投影、不持久化。                                                                         |
| GPT-5.4 选型迁移至 GPT-5.6 Terra/Luna、内置指令刷新、ripgrep 15.2.0、启动/长上下文开销优化 | 不适用 / 兼容且自动获益 | 不接入 / 即时 | 模型侧 system prompt 与 CLI 内置工具/元数据，随二进制内置；c3 不注入、不解析、无对应配置项。                                                         |

## 受影响的特性与契约

无。SDK dist 仅一处 c3 不消费的加性字段 + c3 仅 `import type` 引用消费面六个类型（零形状变化）+
运行时走 c3 解析的 codex 二进制 + 全部实质新能力落在 CLI/app-server/TUI/认证面，以下层面均不受影响：

- 适配器能力账本（`adapters/codex/capabilities.ts`）—— 所有布尔值不变，`perToolApproval: false` 不变。
- vendor 中性接口（`adapters/types.ts`）—— 不变。
- 权限映射（`driver.ts`: `gateToCodexPolicy`）—— 仍只产生 `read-only`/`workspace-write` ×
  `never`/`on-request`/`on-failure`；不调整 `preApproved` 语义。
- MCP 注入机制（`driver.ts`: `mcpServersToCodexConfig`）—— 输出形状不变。
- 会话存储（`session-store.ts`）—— 只读磁盘 JSONL，不依赖 SDK 导出 API；不采纳分页历史 API。
- 翻译层（`translate.ts`、`task-store.ts`）—— `ThreadItem` / `TodoListItem` 类型形状不变，
  `todo_list` 仍只进入 observe-only 任务快照。
- 中继合约（`transport/relay/`、`kernel/relay/contract.ts`）—— 无变化，继续显式
  `supports_websockets=false`。

不涉及数据库迁移、WebSocket/relay 协议变更、前端功能、其他 agent SDK，也不新增持久化格式或 capability 声明。

## 验证

- **SDK dist 逐行对比**：`npm pack @openai/codex-sdk@0.144.6 @openai/codex-sdk@0.145.0` 解包后
  `diff -rq dist` 三个文件均 differ，但逐行 diff 只有：
  - `index.d.ts`：`Usage` 类型新增 `cache_write_input_tokens: number`（第 125–126 行）；
  - `index.js`：`turn.completed` 解析分支新增 `parsed.usage.cache_write_input_tokens ??= 0`；
  - `index.js.map`：随上述两处变化。
    c3 消费的六个类型导出全部覆盖且无变化：`ApprovalMode` / `SandboxMode`（`driver.ts`）、
    `ThreadEvent` / `ThreadOptions`（`driver.ts`、`codex.test.ts`）、`ThreadItem`（`translate.ts`、
    `translate.test.ts`）、`TodoListItem`（`task-store.ts`、`task-store.test.ts`）。`Usage` 不在消费面内
    （`driver.ts` 显式丢弃 `turn.completed`/`usage`），新增字段无影响。
- **锁文件 diff 纯净**：`git diff pnpm-lock.yaml` 触及的包名仅 `@openai/codex-sdk`、`@openai/codex`
  及六个平台包（`darwin-arm64` / `darwin-x64` / `linux-arm64` / `linux-x64` / `win32-arm64` /
  `win32-x64`），33 增 / 33 删，无 Claude SDK 或其它依赖夹带。安装后
  `server/node_modules/@openai/codex-sdk/package.json` 的 `version` 为 **`0.145.0`**，
  锁文件 `specifier: 0.145.0` / `'@openai/codex-sdk@0.145.0'`，三处一致。
- **运行时 CLI 版本核查（两条路径均取证，本次均对齐）**：
  - c3 实际解析：`~/.c3/vendor/manifest.json` → codex `source: managed`、
    `selectedVersion: 0.145.0`、`latestCompatibleVersion: 0.145.0`、
    `path: ~/.c3/vendor/codex/0.145.0/bin/codex`；该二进制 `--version` → **`codex-cli 0.145.0`**
    （`$CODEX_PATH` 未设置，故托管生效）。**托管 CLI 与本次 SDK 版本精确对齐 ✔**
  - 宿主 PATH：`codex --version` → **`codex-cli 0.145.0`**（`/opt/homebrew/bin/codex`），本次亦对齐。
- **真实 relay 端到端**：`relay/e2e.codex.test.ts` 用真实 codex 二进制（`which codex` → 宿主
  `0.145.0`）跑通完整 relay 路径——上游文本经 relay 翻译后到达 codex 的 `agent_message` 并被渲染，
  会话可取得、turn 正常结束。**证明 npm 类型契约与实际 `0.145.0` JSONL 行为精确对齐 ✔**
- **`pnpm typecheck`**：通过（绿），server + web 均 Done。SDK 类型无实质变化的第二直接证据。
- **`pnpm lint`**：`eslint .` exit 0，**0 error / 4 warning**。4 个 warning 全部为测试文件中未使用的
  导入（`server/src/kernel/events/event-match.test.ts` ×1、`shared/src/protocol.test.ts` ×3），
  属本次改动之外的预存项——本次 diff 仅 `server/package.json` + `pnpm-lock.yaml` + 三份升级文档，
  未触及这些文件。
- **`pnpm vitest run`**：**4146 passed / 16 skipped / 0 failed**，无新增跳过项。
- **Codex 定向复核**：`adapters/codex/*` + `transport/relay/*` + `transport/intent-mcp/*` 合计
  **144 passed / 1 skipped**（skip = 需登录 codex 的 intent-mcp e2e）。覆盖新建/恢复线程、CLI 参数
  构造、策略映射、MCP/relay 配置、JSONL 生命周期与失败事件、各类 `ThreadItem` 翻译与 todo 快照
  投影；`relay/e2e.codex.test.ts` 用真实 `0.145.0` 二进制端到端跑通 relay，确认上游变更未隐式改变现有行为。
