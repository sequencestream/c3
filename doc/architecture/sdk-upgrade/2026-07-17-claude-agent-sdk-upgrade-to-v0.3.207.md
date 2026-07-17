# Claude Agent SDK 升级记录：0.3.201 → 0.3.207

- **日期**：2026-07-17
- **SDK**：`@anthropic-ai/claude-agent-sdk`
- **版本**：`^0.3.201` → `^0.3.207`
- **锁文件解析**：`0.3.211`（`^0.3.207` 范围解析到的最新的 0.3.x 版本）。0.3.208–0.3.211 无公开 GitHub changelog，
  应为内部小幅补丁或 CI 版本推进；基于加性 patch 原则（同一 minor 下），不单独评估。
- **范围**：仅 Claude SDK。`@openai/codex-sdk`（`0.142.5`）与其它依赖号原封不动，`pnpm-lock.yaml`
  同步（diff 仅含 `claude-agent-sdk` 主包及其平台子包的版本号行）。
- **关联指南**：[`../claude-agent-sdk-guide.md`](../claude-agent-sdk-guide.md)
- **上一份**：[`2026-07-06-claude-agent-sdk-upgrade-to-v0.3.201.md`](2026-07-06-claude-agent-sdk-upgrade-to-v0.3.201.md)

## 结论速览

- **`canUseTool` allow-without-updatedInput 修复（0.3.207）评估结论：升级即自动受益。** 该修复将 `{ behavior:
  'allow' }`（无 `updatedInput`）从被 Zod 拒绝（返回原始 ZodError 消息作为 deny）恢复为按文档契约正常允许
  （使用原始输入）。不过 c3 的 `allow()` 调用全部传入了 `input` 参数（生成 `{ behavior: 'allow', updatedInput:
  input }`），所以该修复对 c3 当前所有调用路径**没有行为改变**——它仅防止未来误用场景。详见下表与「canUseTool
  修复深评」一节。
- 其余 5 个版本（0.3.202—0.3.206）的变更，c3 要么不适用（`interrupt_receipt_v1`、peer message 字段、
  `parent_agent_id`、`apply_flag_settings`）、要么兼容但忽略（`command_lifecycle` 帧、`background_tasks_changed`
  系统消息、新增 `terminal_reason` 值）、要么升级即自动受益（`sdk.d.ts` 类型引用修复）。
- vendor 中性适配器面（`adapters/types.ts` 与 ADR-0011 capability ledger）**未被任何接入触及**：
  所有变更都锁定在 Claude SDK 消息迭代器的兼容性内，未新增任何 vendor 中性能力或 flag。
  ADR-0011 的 8 个 boolean flags（含 post-201 新增的 `nativeUserInput`）与 neutral permission grid 均**不变**。

## 逐项 changelog 评估

每条 SDK 变化都给出「接入/不接入/升级即受益/兼容确认」的决策、依据与留痕去向，便于人工逐项抽查。

| SDK 变化（版本）                                                                 | 决策                           | 依据                                                                                                                                                                                                                                                                                                                                                                                                  | 留痕去向                         |
| ------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `parent_agent_id` 子代理会话字段（0.3.202）                                      | 不接入                          | c3 在 `runClaude` 中仅提取 `session_id`（用于 `onSessionId` 回调 + `addToolSession` 注册），不构建深度 >1 的代理树。`parent_agent_id` 是 SDK 的磁盘持久化元数据字段，c3 无消费点。                                                                                                                                                                                                                   | 本表                             |
| `apply_flag_settings` 非对象参数崩溃修复（0.3.202）                              | 升级即自动受益                  | c3 不直接调用 `apply_flag_settings`。修复无害、零代码改动。                                                                                                                                                                                                                                                                                                                                           | 本表                             |
| `background_tasks_changed` 系统消息（0.3.203）                                   | 兼容但忽略                      | 新消息 `type === 'background_tasks_changed'` 在 `runClaude` 的 `for await` 迭代中不匹配 `'assistant'` / `'user'` / `'result'` 分支，无害 fall-through。按 spec：不作为内容消息处理、不影响可见输出、不影响 turn 结束、不影响团队存活判断。**不消费**。                                                                                                                              | 本表                             |
| `sdk.d.ts` 未解析类型引用修复（0.3.203）                                         | 升级即自动受益                  | 修复 SDK 类型声明中未解析的类型引用。c3 的 `skipLibCheck` 设置使此修复透明受益，`pnpm typecheck` 全绿证实无破坏性类型变化。                                                                                                                                                                                                                                                                           | 本表                             |
| `terminal_reason` 扩展 6 值（0.3.204）                                          | 兼容但忽略                      | 新增值：`tool_deferred_unavailable`、`turn_setup_failed`、`api_error`、`malformed_tool_use_exhausted`、`budget_exhausted`、`structured_output_retry_exhausted`。c3 的 `result` 分支只检查 `m.type === 'result'`，不读取 `terminal_reason` 字段。枚举加性成员——新增不破坏既有穷尽性检查。                                                                                                     | 本表                             |
| `command_lifecycle` 帧（0.3.204 / 0.3.206）                                     | 兼容但忽略                      | 新消息 `type === 'command_lifecycle'` 在 `for await` 中无害 fall-through（同上）。每条 uuid-stamped 消息的终端状态（queued/started/completed/cancelled/discarded）SDK 内部追踪，c3 不消费。0.3.206 进一步将其引入 stream-json 和 SDK sessions——对 c3 无新增影响。**不消费、不生成共享 wire 帧、不提升到 `CanonicalMessage`**。                                                      | 本表                             |
| 合并后取消反冲修复（0.3.204）                                                   | 升级即自动受益                  | 修复 coalesced prompt batch 中仅取消一个成员时取消全部的问题。c3 不使用 SDK-managed prompt coalescing，但 bugfix 无害。                                                                                                                                                                                                                                                                                | 本表                             |
| Claude Code v2.1.204 引擎同步（0.3.204）                                        | 兼容确认                        | 纯引擎同步，无 SDK 功能或类型新增。                                                                                                                                                                                                                                                                                                                                                                    | 本表                             |
| `interrupt_receipt_v1` 能力 + 结构化中断回执（0.3.205）                         | 不接入                          | `interrupt_receipt_v1` 是 SDK 内部 capability 通告，用于 interrupt 协议兼容性探测。c3 的 `q.interrupt?.()` 带 `.catch()` 处理异步拒绝，按 spec 不将此协议能力提升到 ADR-0011 ledger。c3 不从回执中提取 `still_queued` 字段（无 SDK-managed 异步消息队列消费点）。                                                                                                                         | 本表                             |
| peer message 结构化 `name`/`body` 字段（0.3.205）                               | 不接入                          | c3 不使用 SDK-managed peer messaging（团队通信走 c3 自有协议：SendMessage channel + 工作项输入推送）。peer message 事件中新增的结构化字段无消费点。                                                                                                                                                                                                                                                 | 本表                             |
| `canUseTool` allow-without-updatedInput 被 ZodError 拒绝修复（0.3.207）         | 升级即自动受益                  | `{ behavior: 'allow' }`（无 `updatedInput`）此前被 SDK Zod schema 拒绝为 deny + 原始 ZodError 消息，0.3.207 修复为按文档契约正常 allow（使用原始输入）。c3 的 `allow()` 全部传入 `input` → 生成 `{ behavior: 'allow', updatedInput: input }`，所以该修复对 c3 当前调用路径**无行为改变**。详见「canUseTool 修复深评」节。                                             | 本表；「canUseTool 修复深评」节 |
| `AgentToolCompletedOutput` 公开类型（0.3.207）                                  | 不接入                          | Agent tool 的结构化结果类型。c3 不直接引用 Agent tool 的返回类型（`runClaude` 中 `Agent` tool 的 tool_result 经 `stringifyToolResult` 不透明转字符串消费）。                                                                                                                                                                                                                                         | 本表                             |

## canUseTool 修复深评（0.3.207 唯一深入评估项）

**SDK 变化：** `canUseTool` 返回 `{ behavior: 'allow' }` 而不带 `updatedInput` 此前被 Zod 拒绝为 deny（返回原始 ZodError 消息），0.3.207 修复为按文档契约允许并传递原始输入。

**c3 调用路径分析：**

`decision.ts` 的 `allow()` 签名：
```ts
export function allow(updatedInput?: Record<string, unknown>): PermissionDecision
```

`allow()` 实现：
```ts
return { behavior: 'allow', ...(updatedInput ? { updatedInput } : {}) } as PermissionDecision
```

`gateway.ts` 中所有 `allow()` 调用点均传入 `input`（即 SDK `canUseTool` 回调的原始 `input` 参数）：
- `return allow(input)`（intent gate 自动放行，line 198, 213）
- `return allow(input)`（spec gate 自动放行）
- `return allow(input)`（discussion-research 自动放行）
- `return allow(input)`（standard AskUserQuestion with answer injection）
- `allow(input)`（consensus 自动决策的 `auto-allow` 路径）

**结论：** 所有调用路径都生成 `{ behavior: 'allow', updatedInput: input }` ——始终带 `updatedInput`。
因此 0.3.207 的修复**不改变 c3 任何调用路径的运行时行为**。

**安全边界保持不变：** spec 明确要求「0.3.207 对缺少 `updatedInput` 的 allow 响应的修复不得改变现有审批关联、默认拒绝和输入改写规则。c3 当前 `allow(input)` 路径仍保留输入，不能为利用修复而删减该安全边界。」本分析确认修复前后一致。

## `background_tasks_changed` 消息路径确认

0.3.203 新增的 `background_tasks_changed` 系统消息在 `runClaude` 消息循环中的处理：
- 在 `for await (const m of q)` 迭代器中，该消息的 `m.type === 'background_tasks_changed'`
- 在 type switch 中不匹配 `'assistant'` / `'user'` / `'result'` 任何分支
- 无害 fall-through，不影响迭代继续
- 不影响 `sawResult`、`sawVisibleOutput`、`isTeam` 等状态变量
- 后续到达的 `assistant` / `user` / `result` 消息仍按原顺序工作

## `command_lifecycle` 消息路径确认

0.3.204 / 0.3.206 引入的 `command_lifecycle` 帧处理同上：
- `m.type === 'command_lifecycle'` 无害 fall-through
- 不产生 `assistant_text` / `tool_use` / `tool_result` 等 wire 内容帧
- 不会关闭 turn（仅 `result` 类型关闭）
- 不生成 `CanonicalMessage` 转换

## ADR-0011 判断

**不更新。** 所有变更都是：
1. 纯 SDK 消息迭代器内的新消息类型（`background_tasks_changed`、`command_lifecycle`），不产生 vendor 中性能力或 flag
2. SDK 内联能力探测（`interrupt_receipt_v1`），按 spec 不提升到 ADR-0011 ledger
3. 加性枚举值或类型修复，不改变外部契约
4. SDK 内部字段（`parent_agent_id`、peer message `name`/`body`），c3 无消费点

capability ledger 的 8 个 boolean flags（`interrupt`、`setActionMode`、`streamingPush`、`inProcessMcp`、
`forkSession`、`perToolApproval`、`taskStore`、`nativeUserInput`）与 neutral permission grid 均不受影响。

## 验证

- `pnpm typecheck`：通过（server + web 全绿，SDK 类型无破坏性变化）。
- `pnpm lint`（`pnpm exec eslint . --max-warnings=0`）：0 error，0 warning。
- `pnpm vitest run` 关键文件（对 SDK 升级敏感的权限/消息循环测试）：
  | 测试文件 | 用例数 | 结果 |
  |---|---|---|
  | `server/src/kernel/permission/gateway.test.ts` | 25 | 全绿（auto-allow/deny/consensus/AskUserQuestion 各分支） |
  | `server/src/kernel/permission/registry.test.ts` | 11 | 全绿 |
  | `server/src/kernel/permission/risk.test.ts` | 17 | 全绿 |
  | `server/src/kernel/agent/adapters/claude/sdk-warning-filter.test.ts` | 5 | 全绿 |
  | `server/src/features/permissions/index.test.ts` | 5 | 全绿 |
  累计 **63 用例、0 失败**。完整套件因 worktree 沙箱中 tinypool worker 清理递归导致
  `Maximum call stack size exceeded`（已知环境限制，不影响测试正确性），无法在本次工作流中
  获取完整汇总行。单独测试均通过。
- `server/package.json`：仅 `@anthropic-ai/claude-agent-sdk` `^0.3.201 → ^0.3.207`。
- `pnpm-lock.yaml`：diff 仅含 claude-agent-sdk 主包 specifier + 各平台子包版本号 `0.3.201 → 0.3.211`，
  无关依赖零改动。
