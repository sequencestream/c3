# Claude Agent SDK 升级记录：0.3.195 → 0.3.201

- **日期**：2026-07-06
- **SDK**：`@anthropic-ai/claude-agent-sdk`
- **版本**：`^0.3.195` → `^0.3.201`
- **范围**：仅 Claude SDK。`@openai/codex-sdk`（`0.142.3`）与其它依赖号原封不动，`pnpm-lock.yaml`
  同步（diff 仅含 `claude-agent-sdk` 及其平台子包的版本号行）。
- **关联指南**：[`../claude-agent-sdk-guide.md`](../claude-agent-sdk-guide.md)
- **上一份**：[`2026-06-28-claude-agent-sdk-upgrade-to-v0.3.195.md`](2026-06-28-claude-agent-sdk-upgrade-to-v0.3.195.md)

## 结论速览

- **`canUseTool.requestId`（0.3.199）评估结论：不接入。** SDK 的 `options.requestId` 是 SDK↔worker
  **控制协议信封**的 id，唯一用途是消费者选择「带外回 `control_response`」（返回 `null` + 自己 echo
  该 id，例如签名 HTTP POST）时的匹配键。c3 走的是相反路径——`canUseTool` **内联返回** branded
  `allow`/`deny`，由 SDK 自己的 transport 送回控制响应，SDK 内部按自己的信封匹配，c3 从不需要该 id。
  c3 自有的 `randomUUID()` `requestId` 位于**另一个平面**（浏览器往返），已经充分覆盖
  wire/pending/event 关联，接入 SDK id 无可验证增益且返回 `null` 有永久阻塞风险。详见下表与「requestId
  深评」一节。
- vendor 中性适配器面（`adapters/types.ts` 与 ADR-0011 capability ledger）**未被任何接入触及**：
  `requestId` 关联完全内化在 Claude 权限网关内，不是新的能力 flag，也未提升到 neutral surface，
  故 capability grid / 7-flag ledger 均**不变**。
- 真正改代码的只有 1 处纯注释留痕（`createCanUseTool` 处扩展第三参说明，无逻辑改动）；其余项为
  「兼容确认 / 不适用 / 暂不接入 / 升级即自动受益」。

## 逐项 changelog 评估

每条 SDK 变化都给出「接入/不接入 + 依据 + 留痕去向」，便于人工逐项抽查。

| SDK 变化（版本）                                                            | 决策                 | 依据                                                                                                                                                                                                                                                                                                                           | 留痕去向                                                                                   |
| --------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `canUseTool.requestId`（0.3.199）                                           | 不接入               | SDK id 是控制协议信封键，仅供「返回 `null` + 带外 echo」模式使用；c3 内联返回 allow/deny，SDK 自匹配信封，无需该 id。c3 自有 id 覆盖浏览器往返 + consensus 自动决策 + AskUserQuestion 注入 + save_intents 门（后者在 MCP handler，SDK id 根本触不到）。返回 `null` 会因 fail-closed 无 `control_response` 导致 tool 永久阻塞。 | 代码注释：`kernel/permission/gateway.ts` 的 `createCanUseTool`；本表；「requestId 深评」节 |
| `canUseTool` 返回 `null` 抑制自动控制响应（0.3.199）                        | 不接入               | 同上；`null` 仅用于带外响应，c3 不接管 transport，误用即永久阻塞。c3 保持每个分支返回 branded verdict。                                                                                                                                                                                                                        | 同上                                                                                       |
| `workflow_agent.blocked` 进度字段（0.3.199）                                | 不适用               | c3 不消费 SDK `workflow_agent` 进度事件（无 SDK-managed workflow 产品入口）；`blocked` 无落点。                                                                                                                                                                                                                                | 本表                                                                                       |
| `sandbox.credentials` `mode:"mask"` + `injectHosts`（0.3.199）              | 不接入               | c3 的 `query()` 不传 `sandbox` 选项；隔离靠 Docker 容器 + `buildChildEnv` + `docker exec --env-file`，凭据边界已由容器 + env-file 覆盖，无 SDK 原生 sandbox credential 需求。                                                                                                                                                  | 本表                                                                                       |
| `canUseTool` + `allowedTools`/`bypassPermissions` 运行时警告（0.3.198）     | 兼容确认，无冲突     | SDK 仅在①`permissionMode==='bypassPermissions'` 或②传了裸 `allowedTools` 时 `process.emitWarning`。c3 **从不传 `allowedTools`**（query 选项只有 `disallowedTools`），故②不触发；①仅当用户显式选 never-ask/build 时出现，是「用户已授权 never-ask」的预期语义，非配置冲突。                                                     | 本表                                                                                       |
| `mcp_set_servers` per-server `request_timeout_ms`（0.3.198）                | 不接入               | c3 在 `query()` 构造时经 `mcpServers` 绑定 in-process MCP，不通过 SDK control request 动态下发服务器变更，无 `mcp_set_servers` 调用点（该字段在 sdk.mjs 中亦未出现于常规路径）。本次只记兼容性结论，不新增控制面。                                                                                                             | 本表                                                                                       |
| `isSynthetic` → `isMeta` 映射修复（0.3.198）                                | 升级即自动受益       | c3 代码零处引用 `isSynthetic`/`isMeta`（`stringifyToolResult` 不透明转字符串，message loop 不解析该字段），映射修复对 c3 透明。                                                                                                                                                                                                | 本表                                                                                       |
| 工作流进度事件丢弃最早 agent 条目修复（0.3.198）                            | 升级即自动受益       | 代码零改动；c3 不消费 workflow 进度事件，修复无害。                                                                                                                                                                                                                                                                            | 本表                                                                                       |
| `'manual'` 作为 `'default'` 权限模式别名（0.3.200）                         | 不接入               | c3 统一用 `'default'`（见 `claude/modes.ts` 与共享 wire `PermissionMode`）；别名加性，不加入 mode catalog / dropdown / 共享协议，无影响。                                                                                                                                                                                      | 本表                                                                                       |
| `onSetPermissionMode` 在 SDK-managed Remote Control 中未触发修复（0.3.200） | 不适用               | c3 不使用 SDK 托管 Remote Control；mode 切换走 `handle.setPermissionMode(...)`（`claude/driver.ts`），不经该路径。                                                                                                                                                                                                             | 本表                                                                                       |
| `set_model` 拒绝无效模型（0.3.200）                                         | 兼容确认，不新增校验 | c3 agent config 的 `model` 是字符串透传，运行时仍允许任意 provider/model 组合。SDK 侧多一层拒绝无效模型的防御有利无害；按「运行失败可见、配置不静默丢失」处理——若 SDK 拒绝未知 model override，c3 既有 degradable/error path 露出明确失败，不吞错、不改写用户配置。本次不建模型枚举白名单。                                    | 本表                                                                                       |
| `prompt_id` hook 负载字段（0.3.196，OTEL 关联）                             | 不接入               | c3 无 OTEL / telemetry 产品入口，无消费点。                                                                                                                                                                                                                                                                                    | 本表                                                                                       |
| 控制协议去重 1000 次解析后丢 tool-use ID 修复（0.3.196）                    | 升级即自动受益       | 代码零改动；长会话权限/工具关联自动受益。                                                                                                                                                                                                                                                                                      | 本表                                                                                       |
| 引擎同步 Claude Code v2.1.197 / v2.1.201（0.3.197 / 0.3.201）               | 兼容确认             | 纯引擎同步，无 SDK 功能新增；typecheck 全绿证实无破坏性类型变化。                                                                                                                                                                                                                                                              | 本表                                                                                       |

## requestId 深评（0.3.199 唯一深入评估项）

**两个 `requestId` 处于不同平面，不可互换：**

- **c3 的 `requestId`**（`kernel/permission/gateway.ts` 中 `randomUUID()`）关联**浏览器往返**：
  `permission_request` wire frame → `waitForDecision` pending map（`registry.ts`）→ 浏览器
  `permission_response` → WorkCenter `WaitUserInvolveEvent`。它还必须覆盖 SDK id 根本触不到的分支——
  consensus 自动决策（`consensus_auto`，无浏览器往返）、AskUserQuestion answer-injection、以及在 MCP
  handler（而非 `canUseTool`）内运行的 `save_intents` 确认门。单个 c3 id 已统一覆盖全部。
- **SDK 的 `options.requestId`**（0.3.199）是 SDK↔worker **控制协议信封**的 `request_id`，其类型文档明示：
  「返回 `null` **仅**在消费者已带外发出 `control_response`（例如 echo 该 `requestId` 的签名 HTTP POST）后
  使用；SDK 将跳过自己的 transport 写入。Fail-closed：误返回 `null` 意味不发 `control_response`，tool 将
  无限期阻塞——权限提示没有 park 截止。」

**为何不接入：**

1. c3 走内联返回路径：`canUseTool` 返回 branded `allow`/`deny`，SDK 用自己的 transport 送回控制响应并按
   自己的信封内部匹配，c3 无需也不应接管 transport，故 SDK id 无落点。
2. 采用 SDK id 会引入**第二个可响应 id**（违反 spec 的单 ID 边界），且它触不到 consensus/save-gate 分支，
   反而需要在这些分支另造 id，扩大而非收敛关联面。
3. 返回 `null` 对 c3 是危险路径：c3 依赖内联返回决策，误走 `null` 会让 tool 永久阻塞。
4. 浏览器往返本就单 id 可靠，SDK id 无可验证增益。

结论与 spec「不接入即非失败路径，但需留可审查结论」一致：c3 自有 id 已覆盖当前 wire/pending/event 关联，
SDK id 暂无可验证增益，接入需更大范围的 approval-bridge 重写（带外响应通道）。留痕见 `createCanUseTool`
处注释与本记录。**权限网关 wire 契约、单 ID 模型、branded allow/deny 边界均不变，现有权限网关测试全绿。**

## ADR-0011 判断

不更新。`requestId` 关联完全内化在 Claude 权限网关内，未把 SDK `requestId`、`blocked` workflow 进度或
其它新增能力提升到 vendor-neutral adapter surface；capability ledger 的 7 个 optional/degradable flags
与 neutral permission grid 均不受影响。

## 验证

- `pnpm typecheck`：通过（server + web 全绿，SDK 类型无破坏性变化）。
- `pnpm lint`：0 error。
- `pnpm vitest run`：250 test files passed，1 skipped；3476 tests passed，3 skipped（权限网关测试全绿，无逻辑改动）。
- `server/package.json`：仅 `@anthropic-ai/claude-agent-sdk` `^0.3.195 → ^0.3.201`。
- `pnpm-lock.yaml`：diff 仅含 claude-agent-sdk 主包 specifier + 各平台子包版本号 `0.3.195 → 0.3.201`，
  无关依赖零改动。
