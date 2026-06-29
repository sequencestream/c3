# Codex SDK 升级记录：0.141.0 → 0.142.3

- **日期**：2026-06-29
- **SDK**：`@openai/codex-sdk`
- **版本**：`0.141.0` → `0.142.3`（`0.143.x` 仍为 alpha，不纳入）
- **范围**：仅 Codex SDK。`@anthropic-ai/claude-agent-sdk`（`^0.3.195`）与其它依赖号原封不动，
  `pnpm-lock.yaml` 同步（diff 仅含 `@openai/codex-sdk` + 其捆绑的 `@openai/codex` 及六个平台二进制）。
- **关联指南**：[`../agent-sdk.md`](../agent-sdk.md)（SDK 升级纪律）、
  [`../adr/0011-vendor-neutral-agent-abstraction.md`](../adr/0011-vendor-neutral-agent-abstraction.md)（capability ledger）

## 结论速览

- **SDK 的编译产物与类型定义两版完全一致（字节级）**：`npm pack` 解包 `0.141.0` 与 `0.142.3` 后
  `diff -rq` 比对 `dist/`（`index.d.ts` / `index.js` / `index.js.map`）—— `DIST IDENTICAL`；
  `package.json` 仅 `version` 与 `@openai/codex` 依赖号不同。c3 用到的全部导出
  （`ApprovalMode` / `SandboxMode` / `ThreadEvent` / `ThreadOptions` / `ThreadItem` / `TodoListItem`，
  均为 `import type`）无任何变化，**没有任何 c3 代码因 SDK 接口而需改动**。
- **关键架构事实：c3 运行时不使用 SDK 捆绑的 `@openai/codex` 二进制。** c3 的 codex 驱动
  （`adapters/codex/driver.ts`）有自己的 `CliCodexClient`，通过 `spawn('codex')` 调起
  **`resolve('codex')` 在 `$CODEX_PATH` → PATH 上探测到的** codex 二进制（`process/launcher.ts`），
  从不引用 `node_modules/@openai/codex`。`@openai/codex-sdk` 在 server/src 中**只被 `import type` 引用**
  （无任何运行时 import）。因此：
  - 对 c3 而言，本次 SDK 升级是一次**纯类型层（且类型字节一致）的版本号对齐**，对运行时行为零影响。
  - intent/spec 原文「本次升级本质是 Codex CLI 行为升级」对 c3 **不成立**：c3 实际运行的 Codex CLI 行为
    由**操作系统 PATH 上安装的 codex**决定（本机为 Homebrew `0.141.0`），要真正获得 0.142.x 的 CLI
    行为，需**另行升级 PATH 上的 codex**（如 `brew upgrade codex`），与本次 npm 依赖升级相互独立。
    （已据此反向同步 spec 的「变更摘要」。）
  - 即便如此，逐项 changelog 评估仍有价值：它（a）确认 SDK 类型升级安全，（b）为操作侧把 PATH codex
    升到 0.142.x 时提供一份「这些 CLI 变更对 c3 注入链路是否有影响」的预判。
- vendor 中性适配器面（`adapters/types.ts` 与 ADR-0011 capability ledger）**未被任何接入触及**，
  capability grid 不变。
- 唯一可能影响 c3 的评估项是 **MCP 工具默认改用 tool search（#29486，属 0.142.2）**：经判定为
  **兼容确认，无需改代码**（详见专节）。
- 本次为满足验收门，顺手修复了两处**与本升级无关、在 HEAD（commit `d05d016`）即已存在**的测试文件
  语法损坏（详见「验证」）。

## 受影响的特性与契约

无。SDK 接口字节一致 + c3 仅 `import type` 引用 + 运行时走 PATH codex，三重保证以下层面均不受影响：

- 适配器能力账本（`adapters/codex/capabilities.ts`）—— 所有布尔值不变。
- vendor 中性接口（`adapters/types.ts`）—— `RemoteMcpServer` / `AgentDriver` / `DriverStartOptions` 等不变。
- MCP 注入机制（`driver.ts`: `mcpServersToCodexConfig`）—— 输出形状不变。
- 会话存储（`session-store.ts`）—— 不依赖 SDK 导出 API，只读磁盘 JSONL。
- 翻译层（`translate.ts`、`task-store.ts`）—— `ThreadItem` / `TodoListItem` 类型形状不变。
- 中继合约（`codex-relay/`、`relay-contract.ts`）—— 无变化（`codex-relay` 本就不 import 任何 SDK 类型）。

## MCP 工具默认改用 tool search（#29486，0.142.2）—— 兼容确认

这是 changelog 中对 c3 影响面最大的一项，单独展开。

- **变更内容**：Codex 0.142.2 起，对「支持的」MCP 服务器**默认采用 tool search** 来向模型呈现工具
  （而非把全部工具定义一次性塞进模型上下文），以缓解大型 MCP 服务器的上下文膨胀，并对旧模型/旧
  provider 保持兼容。
- **c3 的注入方式**：`mcpServersToCodexConfig`（`driver.ts`）把意图 MCP 注入为
  `config.mcp_servers.c3 = { url, enabled: true, required: true, enabled_tools: ['find_intents','view_intent','save_intents'], default_tools_approval_mode: 'approve' }`
  （streamable-HTTP MCP）。
- **判定依据**：
  1. 官方配置参考（developers.openai.com/codex/config-reference）确认 `enabled_tools` 仍是
     「Allow list of tool names exposed by the MCP server」—— 它约束的是「哪些工具被启用」，与
     tool search 约束的「已启用工具如何呈现给模型（即时注入 vs 可搜索）」**正交**。tool search 不会
     把白名单内的工具排除在可调用集合之外。
  2. 配置参考中**不存在**关闭 tool search 的独立开关（只有与 MCP 工具发现无关的 `tool_suggest.*`）；
     官方明确 tool search「staying compatible with older models and providers」。说明它是发现层的传输
     方式而非语义门，无需也无法「显式保留旧行为」。
  3. c3 注入的是**仅 3 个、显式列名**的工具白名单，且意图流程的 prompt 是**按确切工具名指示模型调用**
     （如 e2e 用例的「现在调用 find_intents 这个 MCP 工具」）。即便走 tool search，命名工具于 3 件的
     小集合内必然可被发现并调用，不存在「语义检索漏掉白名单工具」的隐蔽性下降风险。
  4. `default_tools_approval_mode: 'approve'` 保证 Codex 自身的 MCP 审批层不拦截/不隐藏这三件工具
     （c3 已在 MCP handler 内部对 `save_intents` 做 gatedSave 确认门），与 tool search 无耦合。
- **结论**：**兼容确认，零代码改动。** 现有 `mcpServersToCodexConfig` 输出形状即可保证意图三工具在
  0.142.x 的 tool search 行为下仍可被发现与调用；意图保存确认门链路（gatedSave → WorkCenter
  permission_request）不受影响。
- **回归证据**：`intent-mcp/e2e.codex.test.ts`（默认 skip，需 `C3_INTENT_MCP_E2E=1` + 已登录 codex）
  正是用 c3 同款配置驱动真实 codex「发现并调用 find_intents」的端到端验证；其断言形状未变，待 PATH
  codex 升到 0.142.x 后可用它取得线上铁证。本次单元层用例（`mcpServersToCodexConfig` 输出形状）全过。

## 逐项 changelog 评估

每条给出「接入/不接入/兼容确认/不适用 + 依据 + 留痕去向」。版本归属以
`gh api repos/openai/codex/releases/tags/rust-v<ver>` 拉取的 release notes 为准（intent 原文把
若干 0.142.0/0.142.2 项笼统并称「0.142.x」，此处按真实版本归位）。

### 0.142.0

| changelog 项（PR）                                                                                                   | 决策             | 依据                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 可配置 rollout token 预算：跨 agent 线程追踪用量、余额提醒、耗尽中止（#28746/#28494/#28707/#29423）                  | 暂不接入         | 该能力依赖 Codex CLI 新暴露的 token 预算配置层。c3 当前无用量仪表盘 / token 预算 UI 的产品入口，也无对应 usage 数据模型。记录为后续候选；当前不接入不影响任何现状。                                                 |
| app-server 多 agent 委派配置 disabled / explicit-request-only / proactive（#28685/#28792/#29324）                    | 不适用           | 此为 **app-server** 客户端能力。c3 走 `codex exec` 一次性非交互子进程，不使用 app-server 协议路径；`AgentDriver` 一次只持一个 `AgentRun`，无多 agent 编排。`codex exec` 不会因此默认 spawn 子 agent，无需显式关闭。 |
| 索引式 web-search 模式（允许实时搜索但限制直连页面到服务端批准 URL）（#28489）                                       | 暂不接入         | c3 已通过 `threadOptions.webSearchMode='live'` / `webSearchEnabled` 接入 codex 第一方 web-search；新「indexed」模式是附加选项，缺省不启用即维持现状。需要时再在 `driver.ts` 的 `web_search` 配置分支扩一个枚举值。  |
| `/usage` 兑换用量重置额度（#28154/#28793）                                                                           | 不适用           | TUI 交互特性；c3 不使用 codex TUI。                                                                                                                                                                                 |
| `/plugins` 远程插件分区与推荐安装（#26703 等）                                                                       | 不适用           | 插件/TUI 特性，c3 无落点。                                                                                                                                                                                          |
| 定时 UTC 时间提醒 / 直接查询当前时间（含 app-server 时钟）（#28822 等）                                              | 不适用           | app-server 时钟特性；c3 不走该路径。                                                                                                                                                                                |
| exec-server 进程与 stdio MCP 会话在瞬断后存活（含签名 URL 刷新、重试安全 stdin 写入）（#28512/#28374/#28546/#28895） | 不适用           | c3 注入的是 **streamable-HTTP MCP**（`config.mcp_servers.<name>.url`），不是 stdio MCP；且 `codex exec` 是一次性子进程，不用 exec-server。此项不触及 c3 的 MCP 注入与确认门链路。                                   |
| 远程环境保留 executor-native 路径 / shell / `AGENTS.md` 发现 / sandbox 行为（#28146 等）                             | 不适用           | 涉及 Codex-hosted 远程执行器特性。c3 的「远程/沙箱」是自管 Docker 容器 + `docker exec codex`，不使用 codex 的 `--remote` 类宿主远程路径。                                                                           |
| 插件加载/安装健壮性（根 marketplace 布局、manifest 回退、多 skill 路径等）（#28771 等）                              | 不适用           | 插件特性，c3 无落点。                                                                                                                                                                                               |
| 父 agent 收到子 agent 终止错误（而非空成功）（#28375）                                                               | 不适用           | 多 agent 特性；c3 单线程 driver 无子 agent。                                                                                                                                                                        |
| goal-first 线程重新被 `thread/list` 与 `thread/search` 返回（#28808）                                                | 不适用           | c3 的 `CodexSessionStore.list()` 从磁盘 `~/.codex/sessions/` JSONL 逐文件扫描，不调用 Codex CLI 的 `thread/list` API。c3 的会话列举行为不变。                                                                       |
| 启动/会话延迟优化、日志 churn 削减（#28542 等 / #29432/#29457）                                                      | 兼容确认（获益） | 透明性能/日志改进，操作侧把 PATH codex 升到 0.142.x 后自动获益，无 c3 接口面。                                                                                                                                      |
| Linux TUI `Ctrl+Z`/`fg` 恢复渲染（#28342）                                                                           | 不适用           | TUI 特性。                                                                                                                                                                                                          |

### 0.142.1

| changelog 项（PR）                                                           | 决策     | 依据                                                                                                                                                                           |
| ---------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 可选的 Windows 系统代理支持（PAC / WPAD / 静态代理 / bypass 规则）（#26708） | 兼容确认 | opt-in、默认关闭；与 c3 在 relay/MCP 路径对 loopback 注入 `NO_PROXY`（`withLoopback`）正交，不改变 c3 的回环 hop 绕代理行为。c3 部署主体为 macOS/Linux，Windows 代理无回归面。 |

### 0.142.2

| changelog 项（PR）                                                                                                               | 决策         | 依据                                                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP 工具默认改用 tool search（#29486）                                                                                           | **兼容确认** | 见上文「MCP 工具默认改用 tool search」专节：`enabled_tools` 白名单与 tool search 正交，意图三工具仍可发现/调用，零代码改动。                                                       |
| 远程 stdio MCP 服务器接受绝对工作目录（#29493）                                                                                  | 不适用       | c3 用 streamable-HTTP MCP，非 stdio MCP；不涉及 stdio cwd。                                                                                                                        |
| 远程 HTTP(S) 图片输入返回模型可见的校验错误（#29417/#29419）                                                                     | 不适用       | c3 的图片输入走 `local_image` 路径（`--image <FILE>` 写临时文件，`image-files.ts`），不是远程 HTTP(S) 图片 URL。现有「带图 user_prompt」适配不受影响、不回归。                     |
| PowerShell 不可解析 AST 区段的命令需审批（#24092）                                                                               | 兼容确认     | Windows shell 审批收紧。c3 codex 为非交互 `exec`，审批由 launch-time 的 sandbox/approvalPolicy 决定（`gateToCodexPolicy`），无 per-tool 交互点；macOS/Linux 主体无 PowerShell 面。 |
| Code Mode 在所选模型缺元数据时告警（#29490）                                                                                     | 兼容确认     | 仅为告警；c3 不依赖 Code Mode 元数据路径。                                                                                                                                         |
| macOS 认证客户端可遵循系统代理（#26709）                                                                                         | 兼容确认     | 认证侧代理改进；c3 对 loopback 注入 `NO_PROXY` 的行为不受影响。                                                                                                                    |
| 插件暗色 logo（#29488）、Apps 更丰富的 safety-buffering UI（#29473）、远程插件精选排序（#29485）、Bedrock 凭据错误指引（#28992） | 不适用       | 插件/Apps/Bedrock 特性，c3 无落点。                                                                                                                                                |
| OpenSSL / esbuild 依赖更新、formatter 成功时静默（#29487/#29489/#29467）                                                         | 兼容确认     | 上游 chore，无 c3 接口面。                                                                                                                                                         |

### 0.142.3

| changelog 项                            | 决策     | 依据                                               |
| --------------------------------------- | -------- | -------------------------------------------------- |
| 维护版补丁，自 0.142.2 起无用户可见变化 | 兼容确认 | 纯维护版；目标版本号选它即为「升到当前最新稳定」。 |

## 验证

- **SDK dist 字节对比**：`npm pack @openai/codex-sdk@0.141.0 @openai/codex-sdk@0.142.3` 解包后
  `diff -rq dist`（`index.d.ts` / `index.js` / `index.js.map`）→ `DIST IDENTICAL`；`package.json`
  仅 `version` + `@openai/codex` 依赖号不同。这是 SDK 类型/产物无变化的最直接证据。
- **锁文件 diff 纯净**：`git diff pnpm-lock.yaml` 仅含 `@openai/codex-sdk` 与 `@openai/codex`
  （含六平台二进制）的版本行，无 Claude SDK 或其它依赖夹带。
- **`pnpm typecheck`**：通过（绿）。这是 SDK 类型无变化的第二直接证据。
- **`pnpm lint`**：0 error（1 个与本次无关的预存 warning：`web/src/controls/schedule-actions.test.ts`
  未使用变量）。
- **`pnpm vitest run`**：3160 passed、1 failed、3 skipped。
  - 全部 codex 相关用例通过：`adapters/codex/*`、`transport/codex-relay/*`、`transport/intent-mcp/*`
    合计 **113 passed / 1 skipped**（skip = 需登录 codex 的 intent-mcp e2e）。其中
    `codex-relay/e2e.codex.test.ts` 用**真实 codex 二进制**端到端跑通 relay 路径。
  - 唯一 failed（`features/intents/automation.test.ts > … > codex: writes a pending projection row
with the intent title`）经 `git stash` 全部改动后在**纯 HEAD 状态下同样失败**，确认为
    **与本升级无关的预存红**（见记忆 `automation-test-worktree-stale-red`）。
- **预存损坏修复（顺手、经用户确认）**：HEAD（commit `d05d016`）中两个测试文件存在语法损坏，卡死
  typecheck/lint/全量 vitest 三道门，与 codex SDK 升级无关：
  - `server/src/features/works/session-counts.test.ts`：`discussion-running` 块缺失对象体与闭合 `}`
    （补回 `abort`/`handle` 两行 + `}`）。
  - `server/src/list-sessions.test.ts`：多出一个 `})`（删除）。
    二者均为对明显意图的无歧义还原；修复后三门转绿（除上述预存红 1 例与预存 warning 1 例）。
