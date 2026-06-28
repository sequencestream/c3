# Claude Agent SDK 升级记录：0.3.183 → 0.3.195

- **日期**：2026-06-28
- **SDK**：`@anthropic-ai/claude-agent-sdk`
- **版本**：`^0.3.183` → `^0.3.195`
- **范围**：仅 Claude SDK。`@openai/codex-sdk`（`0.141.0`）与其它依赖号原封不动，`pnpm-lock.yaml`
  同步（diff 仅含 claude-agent-sdk 行）。
- **关联指南**：[`../claude-agent-sdk-guide.md`](../claude-agent-sdk-guide.md)

## 结论速览

- vendor 中性适配器面（`adapters/types.ts` 与 ADR-0011 capability ledger）**未被任何接入触及**，
  故 capability grid 不变。
- 指南顶部四处维护语义（是否需本机 `claude`、`settingSources` 语义、会话存储路径、Skill 开关）
  经复核本次升级**均未改变**。
- 真正改代码的只有 3 处纯注释留痕（无逻辑改动）；其余项为「兼容确认 / 不适用 / 暂不接入」。

## 逐项 changelog 评估

每条 SDK 变化都给出「接入/不接入 + 依据 + 留痕去向」，便于人工逐项抽查。

| SDK 变化（版本）                                                                            | 决策               | 依据                                                                                                                                                                                                                                                            | 留痕去向                                                       |
| ------------------------------------------------------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `Query.reinitialize()`（0.3.195）                                                           | 不接入             | 它需要存活的 `Query` 句柄 + 常驻 transport（用于重连仍在运行的 daemon）；c3 在 socket 断连时 `for await` 已抛错、句柄被弃用，改用「弃旧 query + `resume:<sessionId>` 新进程」恢复，已满足自动恢复契约。接入需保留句柄，属架构级改动。                           | 代码注释：`kernel/agent/index.ts` 的 socket-disconnect 分支    |
| synced skills `commands_changed` 修复（0.3.195）                                            | 兼容确认获益       | skill 支持探测缓存键 = SDK 版本，升级即重探，仍判 `full`；该修复覆盖 c3 扁平 `_c3_<id>/SKILL.md` 挂载，skill 发现行为不变。                                                                                                                                     | 代码注释：`adapters/claude/skill.ts`                           |
| Browser SDK `promptSuggestions`（0.3.193）                                                  | 不适用             | c3 不集成 Browser SDK，无落点。                                                                                                                                                                                                                                 | 本表                                                           |
| `NotebookEdit.old_source`（0.3.191）                                                        | 兼容确认           | result 字段加性；c3 仅按名在 disallow/write 名单引用 `NotebookEdit`，不解析其内部结构，tool_result 内容以 `stringifyToolResult` 不透明转字符串。无类型处理改动。                                                                                                | 本表                                                           |
| usage / rate-limit 新字段（0.3.191：`model_scoped`；0.3.195：`seven_day_overage_included`） | 兼容确认，不接入   | `result` 分支不读 `usage` / `total_cost_usd`；新字段加性，经 `unknown` 收窄，缺字段/新字段安全。当前无成本/用量产品入口。                                                                                                                                       | 代码注释：`kernel/agent/index.ts` 的 `result` 分支             |
| `sandbox.credentials`（0.3.187）                                                            | 不接入             | 它是 SDK **原生** sandbox 的设置；c3 的 `query()` 不传 `sandbox` 选项，隔离靠 Docker 容器 + `buildChildEnv` + `docker exec --env-file`。凭据隔离已由容器边界 + env-file 覆盖，无独立 credential-deny 文件需求。                                                 | 本表                                                           |
| `can_use_tool.agent_id`（0.3.186）                                                          | 行为继承，暂不消费 | 该变更使 background/team agent 的权限提示**转发**到 `canUseTool`（而非 auto-deny）、并在后台任务运行时保持 stdin 打开——c3 的 team 会话自动获益。但 c3 把所有审批归到主会话 UI（按 `sessionId`），无区分发起 sub-agent 的产品入口，故第三参 `agentID` 暂不消费。 | 代码注释：`kernel/permission/gateway.ts` 的 `createCanUseTool` |
| `ReadMcpResourceDirTool`（0.3.186）                                                         | 兼容确认           | 新增只读内建工具（列 MCP 资源目录）；默认流经 `canUseTool`。与既有 `ReadMcpResourceTool` 一样不在只读门白名单（`INTENT_READ_TOOLS`）中，只读门 default-deny、标准门 flow-through 行为一致，无需特殊分类。                                                       | 本表                                                           |
| `rewind_conversation` / `Query.rewindFiles()`（0.3.186）                                    | 不接入             | c3 无会话回退产品入口；`SessionStore`（list/read/rename/delete）接口与 sessions 能力子账本均无回退轴，不受影响。                                                                                                                                                | 本表                                                           |

## 验证

- `pnpm typecheck`：通过。
- `pnpm lint`：0 error（1 个与本次无关的预存 warning）。
- `pnpm vitest run`：3132 passed，3 skipped。
- 升级敏感性：`pnpm build` 产物 `server/dist/cli.cjs` 可正常 `--version`。
