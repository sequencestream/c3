# Database Tables

所有表存储在单文件 SQLite 数据库 `~/.c3/c3.db` 中 (可由 CLI `--db <path>` 或 `C3_DB_PATH` 覆盖)，通过 `node:sqlite` / `bun:sqlite` 内置驱动访问。Schema 在各 Store 模块中惰性创建 (`CREATE TABLE IF NOT EXISTS`)，结构演进通过 `PRAGMA table_info` 列存在性检查做幂等判定；一次性**数据**迁移 (回填) 则由 `schema_migrations` 标记表判定——列在不在回答不了「回填做完没有」。

**配置也在这里**：系统设置、每工作区设置、个性化设置、会话绑定与 MCP 密钥自 2026-08-12 起全部落在 `config` 模块的六张表中，`~/.c3/settings.json` 与两份 `state.json` 由一次性导入迁入后弃用 (详见 ADR-0042)。这使 `--db` 成为唯一一个能搬走整个 c3 实例的覆盖项——c3 home 目录 (日志、worktree、sandbox) 跟随数据库文件所在目录。

所有工作区关联统一使用 `workspace_name`，其值引用 `workspaces.name`；绝对路径只保存在注册表并用于文件系统操作。迁移 `039-workspace-name-identity.sql` 由配置 store 在单事务内把历史 workspace UUID 和各业务表路径映射为名称。

> `~/.c3/c3.db` 是单实例本地文件。共 **49** 张表，**13** 个模块(见下方一览)。

## 基础设施

| 文件                                       | 说明                                                                                                                                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server/src/kernel/infra/db.ts`            | SQLite 访问层，封装 `getDb()` / `isDbAvailable()` / `resetDbForTests()`，路径解析 `dbPath()` / `setDbPath()`，以及一次性数据迁移的标记读写 `hasMigration()` / `markMigration()` |
| `server/src/kernel/config/config-store.ts` | 配置表访问层：作用域化 KV 原语 `readScope()` / `writeScope()` / `deleteScope()` + 可重入事务 `configTx()`                                                                       |
| `server/src/kernel/config/config-codec.ts` | 对象 ⇄ 配置行编解码 (`toEntries()` / `fromEntries()`)，展开规则声明在 `config-schema.ts`                                                                                        |

## 表一览

| #   | 模块         | 表名                         | SQL 文件                                                                                 | Store 文件                                                  | 用途                                                     |
| --- | ------------ | ---------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------- |
| 1   | intents      | `intents`                    | [intents/intents.sql](intents/intents.sql)                                               | `server/src/features/intents/store.ts`                      | 意图(需求/任务)台账                                      |
| 2   | intents      | `intent_deps`                | [intents/intent_deps.sql](intents/intent_deps.sql)                                       | `server/src/features/intents/store.ts`                      | 意图依赖关系 (多对多)                                    |
| 3   | intents      | `intent_chats`               | [intents/intent_chats.sql](intents/intent_chats.sql)                                     | `server/src/features/intents/store.ts`                      | 沟通会话映射 + 隐藏会话集                                |
| 4   | intents      | `tool_sessions`              | [intents/tool_sessions.sql](intents/tool_sessions.sql)                                   | `server/src/features/intents/store.ts`                      | 工具创建的会话 ID 集合                                   |
| 5   | discussions  | `discussions`                | [discussions/discussions.sql](discussions/discussions.sql)                               | `server/src/features/discussions/store.ts`                  | 讨论线程元数据                                           |
| 6   | discussions  | `discussion_messages`        | [discussions/discussion_messages.sql](discussions/discussion_messages.sql)               | `server/src/features/discussions/store.ts`                  | 讨论消息                                                 |
| 7   | discussions  | `discussion_agent_sessions`  | [discussions/discussion_agent_sessions.sql](discussions/discussion_agent_sessions.sql)   | `server/src/features/discussions/store.ts`                  | 讨论内 agent→vendor 会话映射                             |
| 8   | automations  | `automations`                | [automations/automations.sql](automations/automations.sql)                               | `server/src/features/automations/store.ts`                  | 自动化 (cron + event)                                    |
| 9   | automations  | `automation_execution_logs`  | [automations/automation_execution_logs.sql](automations/automation_execution_logs.sql)   | `server/src/features/automations/store.ts`                  | 自动化执行历史                                           |
| 10  | automations  | `workspace_mcp_configs`      | [automations/workspace_mcp_configs.sql](automations/workspace_mcp_configs.sql)           | `server/src/features/automations/store.ts`                  | 每 workspace 的 MCP 配置                                 |
| 11  | user-involve | `wait_user_involve_events`   | [user-involve/wait_user_involve_events.sql](user-involve/wait_user_involve_events.sql)   | `server/src/features/user-involve/store.ts`                 | 等待用户介入事件                                         |
| 12  | sessions     | `session_metadata`           | [sessions/session_metadata.sql](sessions/session_metadata.sql)                           | `server/src/features/sessions/session-metadata-store.ts`    | 统一会话列表元数据投影 (由 `work_session_metadata` 改名) |
| 13  | intents      | `intent_sessions`            | [intents/intent_sessions.sql](intents/intent_sessions.sql)                               | `server/src/features/intents/store.ts`                      | intent work session 执行记录 (审计追踪)                  |
| 14  | intents      | `intent_logs`                | [intents/intent_logs.sql](intents/intent_logs.sql)                                       | `server/src/features/intents/store.ts`                      | 意图生命周期变更日志 (操作审计轨迹)                      |
| 15  | intents      | `intent_fast_turns`          | [intents/intent_fast_turns.sql](intents/intent_fast_turns.sql)                           | `server/src/features/intents/store.ts`                      | fast 模式每 turn 反向补轨结算记录 (基线 + 幂等键)        |
| 16  | queue        | `queue_workspace_state`      | [queue/queue_workspace_state.sql](queue/queue_workspace_state.sql)                       | `server/src/features/intents/queue-store.ts`                | 自动化队列的工作区级控制状态 (启动/暂停/强制跳过)        |
| 17  | queue        | `queue_intent_state`         | [queue/queue_intent_state.sql](queue/queue_intent_state.sql)                             | `server/src/features/intents/queue-store.ts`                | 单意图调度元数据 (失败次数/退避/park/冷却)               |
| 18  | queue        | `queue_decision_log`         | [queue/queue_decision_log.sql](queue/queue_decision_log.sql)                             | `server/src/features/intents/queue-store.ts`                | 逐 tick/intent 的队列调度决策审计                        |
| 19  | queue        | `funnel_event`               | [queue/funnel_event.sql](queue/funnel_event.sql)                                         | `server/src/features/intents/funnel-store.ts`               | park 状态跃迁的本机观测事件 (恢复率统计, 90 天滚动)      |
| 20  | intents      | `intent_prs`                 | [intents/intent_prs.sql](intents/intent_prs.sql)                                         | `server/src/features/intents/store.ts`                      | 意图的 PR/MR 关系表 (一意图可多条)                       |
| 21  | infra        | `schema_migrations`          | [infra/schema_migrations.sql](infra/schema_migrations.sql)                               | `server/src/kernel/infra/db.ts`                             | 已完成的一次性数据迁移标记 (跨域)                        |
| 22  | deliveries   | `deliveries`                 | [deliveries/deliveries.sql](deliveries/deliveries.sql)                                   | `server/src/features/deliveries/store.ts`                   | 交付 (集成单元) 台账                                     |
| 23  | deliveries   | `intent_deliveries`          | [deliveries/intent_deliveries.sql](deliveries/intent_deliveries.sql)                     | `server/src/features/deliveries/store.ts`                   | 意图 ↔ 交付关联边 (意图 store 亦声明建表)                |
| 24  | deliveries   | `delivery_prs`               | [deliveries/delivery_prs.sql](deliveries/delivery_prs.sql)                               | `server/src/features/deliveries/store.ts`                   | 交付 PR (交付分支 → 主线)                                |
| 25  | deliveries   | `delivery_logs`              | [deliveries/delivery_logs.sql](deliveries/delivery_logs.sql)                             | `server/src/features/deliveries/store.ts`                   | 交付生命周期变更日志 (操作审计轨迹)                      |
| 26  | config       | `workspaces`                 | [config/workspaces.sql](config/workspaces.sql)                                           | `server/src/kernel/config/workspace-store.ts`               | 工作区注册表 (唯一名称 ↔ 磁盘 path)                      |
| 27  | config       | `system_configs`             | [config/system_configs.sql](config/system_configs.sql)                                   | `server/src/kernel/config/index.ts`                         | 系统级配置 + `state.*` 全局状态 (一字段一行)             |
| 28  | config       | `workspace_configs`          | [config/workspace_configs.sql](config/workspace_configs.sql)                             | `server/src/kernel/config/index.ts`                         | 每工作区配置 (原 projectConfigs)                         |
| 29  | config       | `personalized_configs`       | [config/personalized_configs.sql](config/personalized_configs.sql)                       | `server/src/kernel/config/personalized.ts`                  | 每账号个性化设置                                         |
| 30  | config       | `session_configs`            | [config/session_configs.sql](config/session_configs.sql)                                 | `server/src/kernel/config/index.ts` + `server/src/state.ts` | 每会话事实 (agent 绑定 / 权限模式 / codex 策略)          |
| 31  | config       | `mcp_api_keys`               | [config/mcp_api_keys.sql](config/mcp_api_keys.sql)                                       | `server/src/kernel/config/mcp-api-keys.ts`                  | 外部 MCP 访问密钥 (归属账号 + 密钥版本 + scrypt 摘要)    |
| 32  | auth         | `user_workspace_scopes`      | [auth/user_workspace_scopes.sql](auth/user_workspace_scopes.sql)                         | `server/src/features/auth/scope-store.ts`                   | 账号可访问哪些工作区 (管理员配置, 默认拒绝)              |
| 33  | auth         | `user_workspace_scope_items` | [auth/user_workspace_scope_items.sql](auth/user_workspace_scope_items.sql)               | `server/src/features/auth/scope-store.ts`                   | mode='selected' 的选定工作区明细                         |
| 34  | external-mcp | `external_mcp_write_audits`  | [external-mcp/external_mcp_write_audits.sql](external-mcp/external_mcp_write_audits.sql) | `server/src/features/external-mcp/audit-store.ts`           | 外部 MCP 写调用的只增审计轨迹                            |
| 35  | memory       | `workspace_memories`         | [memory/workspace_memories.sql](memory/workspace_memories.sql)                           | `server/src/features/memory/store.ts`                       | 工作区长期记忆 (偏好/约束/事实/教训)                     |
| 36  | robots       | `im_robots`                  | [robots/im_robots.sql](robots/im_robots.sql)                                             | `server/src/features/im/robot-config-store.ts`              | IM 聊天机器人配置 (执行身份/预设权限/外发授权)           |
| 37  | robots       | `im_robot_threads`           | [robots/im_robot_threads.sql](robots/im_robot_threads.sql)                               | `server/src/features/im/robot-context-store.ts`             | 发送者隔离 Conversation (七维身份含 binding/scope_hash)  |
| 38  | robots       | `im_robot_context_turns`     | [robots/im_robot_context_turns.sql](robots/im_robot_context_turns.sql)                   | `server/src/features/im/robot-context-store.ts`             | 有界 IM 可见上下文 (成对用户/回答正文, ADR-0048)         |
| 39  | robots       | `im_robot_turns`             | [robots/im_robot_turns.sql](robots/im_robot_turns.sql)                                   | `server/src/features/im/robot-turn-store.ts`                | 机器人回合外发审计 (只记元数据, 不记正文)                |
| 40  | robots       | `im_outbound_audit`          | [robots/im_outbound_audit.sql](robots/im_outbound_audit.sql)                             | `server/src/features/im/outbound-audit-store.ts`            | 统一 IM 外发审计 (reply/broadcast, 不含正文)             |
| 41  | robots       | `im_broadcast_claims`        | (同 im_outbound_audit.sql)                                                               | `server/src/features/im/outbound-audit-store.ts`            | L0 播报幂等认领                                          |
| 42  | robots       | `im_identity_challenges`     | [robots/im_identity_challenges.sql](robots/im_identity_challenges.sql)                   | `server/src/features/im/identity-store.ts`                  | IM 身份绑定一次性挑战 (仅存令牌哈希)                     |
| 43  | robots       | `im_identity_bindings`       | [robots/im_identity_bindings.sql](robots/im_identity_bindings.sql)                       | `server/src/features/im/identity-store.ts`                  | IM 外部发送者 ↔ c3 主体 的 active 绑定                   |
| 44  | robots       | `im_group_workspace_scopes`  | [robots/im_group_workspace_scopes.sql](robots/im_group_workspace_scopes.sql)             | `server/src/features/im/identity-store.ts`                  | 群聊明细可见工作区白名单                                 |
| 45  | robots       | `im_identity_audit`          | [robots/im_identity_audit.sql](robots/im_identity_audit.sql)                             | `server/src/features/im/identity-store.ts`                  | IM 身份/群范围变更审计 (只增)                            |
| 46  | robots       | `im_robot_write_grants`      | [robots/im_robot_write_grants.sql](robots/im_robot_write_grants.sql)                     | `server/src/features/im/write-grant-store.ts`               | IM 机器人 L2 写能力逐项授权 (与外发确认独立)             |
| 47  | robots       | `im_robot_write_audits`      | [robots/im_robot_write_audits.sql](robots/im_robot_write_audits.sql)                     | `server/src/features/im/write-grant-store.ts`               | L2 待办令牌作答审计 (不含令牌明文/正文)                  |
| 48  | robots       | `im_todo_tokens`             | [robots/im_todo_tokens.sql](robots/im_todo_tokens.sql)                                   | `server/src/features/im/todo-token-store.ts`                | 私聊待办一次性令牌 (仅存哈希)                            |
| 49  | user-involve | `im_todo_answer_contracts`   | [user-involve/im_todo_answer_contracts.sql](user-involve/im_todo_answer_contracts.sql)   | `server/src/features/user-involve/answer-contract-store.ts` | L2 可作答契约 (封闭答案集, 不含令牌)                     |

## 模块说明

### intents

意图管理的核心域。`intents` 是主表，记录每个需求/任务的生命周期；`intent_deps` 表达意图间的先后依赖；`intent_chats` 同时充当 per-workspace 沟通会话映射和隐藏会话过滤器；`tool_sessions` 持久化工具自动创建的会话 ID 集合，仅回答“这个 vendor session 是否由工具创建”，不保存来源反链；`intent_sessions` 记录每次 intent work session 的执行审计历史；`intent_logs` 记录意图生命周期的操作审计轨迹 (谁、什么时间、做了什么)，只增不改，工作会话启动/结束不写本表 (由 `intent_sessions` 覆盖)；`intent_fast_turns` 记录 fast 模式每 turn 反向补轨的结算基线 + 幂等键 (session_id 主键，settled_at/outcome 在落定处理前为 NULL，同时充当「启动 → 落定」握手；resume 复用同一 session 重建 baseline 时清除上一 turn 的 settled_at/outcome/spec_path，为每个 turn 各自开启新的可结算周期)。`intent_prs` 是意图的 PR/MR 关系表——一个意图可对不同交付各持有一条，写入唯一经仓储层 `upsertIntentPr`，任何位置不得直接 UPDATE。`(forge, repo, number)` 是 PR 的真实身份且全库唯一；`(intent_id, delivery_id)` 保证一意图一交付至多一条；`delivery_id` 恒可空，而 SQLite 在唯一索引中视 NULL 互不相等，故另有部分唯一索引 `UNIQUE(intent_id) WHERE delivery_id IS NULL` 兜住「每意图至多一条无交付归属的 PR」。`forge`/`repo` 可空表示「来源未知」，这类行不参与唯一键，下一次 upsert 即补齐。永久删除意图时，同一事务删除以该意图为起点或终点的 `intent_deps`、对应 `intent_sessions`、`intent_logs`、`intent_fast_turns`、`intent_prs`、`intent_deliveries` (交付关联边；远端 PR 不动，与本函数其余清理一致——清本地台账/git/会话，从不代用户在 forge 上做不可逆的事)，最后删除 `intents` 主记录；`intent_chats` 按删除前快照中的会话 ID 单独清理。

Schema 版本: 22。v5→v6 完成了 `requirements*` → `intents*` 的就地表重命名迁移。v7→v8 新增 git 追踪字段: `branch_name`, `latest_commit_hash`, `pr_id`, `pr_status`。v8→v9 扩展 `intent_deps` 新增 `dep_type` (blocks/informs/soft_after) + `created_at`。v9→v10 新增 `intent_sessions` 表 (work session 审计追踪)。v10→v11 把工作区主键列 `project_path` 就地改名为 `workspace_name` (`intents` + `intent_chats`)，复合索引 `idx_intent_project_status` → `idx_intent_workspace_status`；单列索引 `idx_chat_project` 保留索引名、列引用随改 (详见迁移记录 `migrate/2026/06/14/012`)。v11→v12 新增 `intents.short_en_title` (nullable TEXT，派生分支/worktree 名的稳定 ASCII 来源；历史行保持 NULL，写入侧截断到 128；详见迁移记录 `migrate/2026/06/18/013`)。v12→v13 新增 spec 质量闸 + 会话字段: `spec_path` (nullable TEXT，已撰写 spec 文档路径)、`spec_approved` (INTEGER 0/1，DEFAULT 0，人工审批闸状态)、`spec_approve_user` (nullable TEXT，审批人)、`spec_session_id` (nullable TEXT，撰写/精炼 spec 的会话)、`intent_session_id` (nullable TEXT，refine/沟通会话；与 `last_work_session_id` 工作会话并存且语义不同)；历史行 `spec_approved=0`、其余 NULL；详见迁移记录 `migrate/2026/06/18/014`)。v13→v14 新增 `intents.pr_url` (nullable TEXT，PR 可跳转链接如 GitHub PR URL；与 `latest_commit_hash` 语义不重复，不引入重复的 `commit_hash` 字段；历史行保持 NULL；手动 Start Work 结束自动收尾 Git/PR 时写入；详见迁移记录 `migrate/2026/06/20/016`)。v14→v15 把最近一次意图工作会话指针列 `last_dev_session_id` 就地改名为 `last_work_session_id` (详见迁移记录 `migrate/2026/06/30/020`)。v15→v16 新增 `intent_logs` 表 (生命周期变更日志: `id` uuid 主键、`intent_id`、`operation_type`、`summary`、`actor`、`created_at`，索引 `idx_intent_log_intent_created(intent_id, created_at DESC)`；无历史数据迁移，从上线时刻开始记录；详见迁移记录 `migrate/2026/07/02/021`)。v16→v17 新增 spec 审核事实字段: `spec_review_session_id` (nullable TEXT，只读审核会话；与撰写方 `spec_session_id` 分属不同权限域)、`spec_review_verdict` (nullable TEXT，`pass`/`changes_requested`，无有效结论为 NULL，未知/遗留值一律读作无结论)、`spec_review_reason` (nullable TEXT，结论理由)、`spec_review_at` (nullable INTEGER，结论产生时间)、`spec_review_fingerprint` (nullable TEXT，结论所绑定的 spec 内容指纹，与实时指纹不符即结论失效)、`spec_review_rework_rounds` (INTEGER NOT NULL DEFAULT 0，返工轮次)、`spec_review_machine_blocked` (INTEGER NOT NULL DEFAULT 0，人工撤销后对同一结论的机器批准抑制)；历史行按「无结论、0 轮、未抑制」解释，无回填，既有 spec 路径/批准状态/批准身份一律不改动；详见迁移记录 `migrate/2026/07/31/027`)。v17→v18 新增 `intents.spec_status` (TEXT NOT NULL DEFAULT 'raw'，CHECK(raw/pending/approved))——spec 文档生命周期状态，是闸门、待批准提示与详情主按钮的唯一事实源: `raw`=无 spec 或仅有服务端播种的 seed (不算待批准，不可审核/批准/阻塞)、`pending`=已有偏离 seed 的真实内容且未批准 (唯一可审核、可批准、渲染待批准提示的状态)、`approved`=已批准；`spec_path` 仍表示文档位置，`spec_approved`/`spec_approve_user` 保留为兼容字段并在同一事务内双写 (approved ⇔ spec_approved=1 且保留批准人；raw/pending ⇔ 0 且无批准人)，读路径一律以 `spec_status` 为准，兼容布尔不构成第二条准入路径；状态迁移只发生在受控写入边界 (write_spec 播种→raw；编写运行结束时比对指纹，内容确实变化→pending；update_spec_content 人工编辑→pending；approve_spec/机器批准→approved；revoke_spec_approval 或批准后改写→pending)，不以 seed 文案或实时文件内容反推状态，内容变回 seed 也不会自动退回 raw；存量一次性回填: spec_approved=1→approved / 有 spec_path 且未批准→pending / 其余→raw；详见迁移记录 `migrate/2026/08/05/029`)。v18→v19 新增每意图级 spec 模式与 fast 结算表: `intents.spec_mode` (nullable TEXT，CHECK(sdd/fast)，三态——NULL=继承工作区(sddEnabled=true⇒sdd，false⇒fast)、'sdd'=显式固定规格先行、'fast'=显式固定规格延后；模式切换不直接改 spec_status，存量行保持 NULL 继续派生)；新增 `intent_fast_turns` 表 (fast 模式每 turn 反向补轨的结算记录: session_id 主键、intent_id、workspace_name、baseline JSON、settled_at、outcome('no_change'|'small'|'over'|'failed')、spec_path、created_at + idx_intent_fast_turn_intent，防重复 settled 事件或重启重复生成规格；resume 复用同一 session 时重建 baseline 并重开可结算周期，使每个 turn 可独立 claim 落定)；详见迁移记录 `migrate/2026/08/06/030`)。v19→v20 把 PR 事实从 `intents` 的 `pr_id`/`pr_url`/`pr_status` 三列提升为独立关系表 `intent_prs` (`id`/`intent_id`/`delivery_id`/`forge`/`repo`/`number`/`url`/`status`/`head_branch`/`base_branch`/时间戳 + 上述三个唯一索引与 `idx_intent_pr_intent`、`idx_intent_pr_status`)，并从旧三列一次性回填 (选行 `pr_id` 非空；`number←pr_id`、`url←pr_url`、`head_branch←branch_name`、`base_branch←'main'`、时间戳取 `intents.updated_at` 并把 10 位 epoch-秒归一化为 epoch-ms；`forge`/`repo` 从 `pr_url` 解析，解析不出则留 NULL；`pr_status` 为空或越界时落 `reviewing`)。回填与其标记写入在同一事务内，以 `schema_migrations` 的 `intents.backfill_intent_prs.v1` 判定幂等，异常即回滚且不写标记。旧三列**冻结但从不 DROP**：运行时不读不写，只作为反向回填脚本 `scripts/rollback-intent-prs.mjs` 的落点保留 (裁决见 ADR-0035；详见迁移记录 `migrate/2026/08/06/031`)。v20→v21 新增 `intent_sessions.delivery_id` (nullable TEXT)——**会话的交付上下文**：交付引入后「我的 base 是什么」不再由意图唯一决定 (一个意图可关联多个交付，每个交付是一条不同分支)，worktree 基线与依赖闸门判据都读这个上下文，因此它是会话属性而非意图属性；fresh 启动时解析并写入 (0 关联→NULL、恰好 1 个→自动带入、≥2 个→拒绝启动要求显式选定)，resume/attach 原样复用同一值，不重新猜测。可空且不回填：NULL 表示「本次会话无交付上下文」，这正是未关联交付的意图与交付能力上线前所有历史会话的真实情况 (裁决见 ADR-0038；详见迁移记录 `migrate/2026/08/07/034`)。v21→v22 新增 `intents.base_branch` (nullable TEXT)——**意图的基准分支快照**，回答「这个意图建在哪个分支上」这一此前无人持久回答的问题：创建时取工作区 `defaultMainBranch`，缺失则由 `origin/HEAD` 探测，再兜底 `main`/`master`；首次关联到分支已就绪的交付时改写为该交付分支，该交付分支由未就绪变就绪时对仍只关联它的意图追平一次，失去最后一条关联时回退工作区主分支，多交付关联一律保持已设值 (关联顺序不是用户对基准的决定)。快照不追随交付分支之后的推进/改名/重建，已有 worktree 的不一致仍由既有基线守卫发现。关联/解除的基准写入与关联边 `intent_deliveries` 在同一事务内落定，任一失败两者都不留痕。磁盘可空 (`ADD COLUMN` 无法在不编造默认值的前提下声明 NOT NULL)，所有写入路径保证非空；读模型对空值派生工作区主分支回退并标注为「非持久事实」，**不回写**——读时推导一旦落库就再也分不清它是记录下来的决定还是当场猜的。详情元信息、`resolvePrTarget` (PR 目标) 与 `resolveWorktreeBaseline` (worktree 基线) 共读此列，只有建 PR 时人工显式选定交付这一种情形以所选交付分支为准。存量一次性回填：恰好关联一个交付且其分支已就绪→该交付分支，否则→工作区有效主分支；未就绪的交付分支绝不写入，已有有效值不动，空白/异常值按同一主分支规则修复；回填与其标记写入同事务，以 `schema_migrations` 的 `intents.backfill_base_branch.v1` 判定幂等，异常即回滚且不写标记 (详见迁移记录 `migrate/2026/08/08/037`)。

### infra

跨域基础设施表。`schema_migrations` (`id` 主键 + `applied_at`) 记录已完成的一次性**数据**迁移，一条标记 = 一次已完成的迁移。它回答列/表存在性检查回答不了的问题——「表已建好，但它的回填做完了吗」；迁移的数据写入与其标记必须放在同一事务内，回滚才能把标记一并带走。刻意不启用 `PRAGMA user_version` 作为判定依据：那是各 store 共享的单一整数，启用即要求全局串行编号。各 store 自己的 `user_version` 版本戳保持原样，不参与此判定。

### queue

自动化队列的确定性调度内核持久化域 (2026-07-31)。纯调度逻辑在 `server/src/kernel/queue/`
(不 import features/transport)；本模块只承担「事实之外那一点点必须持久化的状态」。

设计取舍: **不建重型 FSM 表**。队列每轮从意图账本 + run 存活探测重新推导运行阶段、当前会话
与全部闸门结果，因此这里只保存无法被重推导的三类东西——工作区级的启停意愿
(`queue_workspace_state`，让服务重启后能恢复用户真正要的状态而不是静默变 idle)、单意图的失败
隔离状态 (`queue_intent_state`：连续失败次数、退避截止、park 标记与原因、防自激冷却)，以及
决策审计 (`queue_decision_log`)。丢一行 `queue_intent_state` 最多导致多重试一次，不会卡死队列。

`queue_decision_log` **刻意不复用** `automation_execution_logs`：后者按「一次自动化执行」计量，
与「一次 tick 对某条意图的取舍」粒度对不上。日志只记结构化原因码与可展示摘要，绝不写入
prompt、凭据、权限请求正文或 transcript；写入失败不放宽任何闸门、不制造重复 launch，由后续
tick 继续对账。

`funnel_event` 是本域唯一的**观测**表，不参与调度：它只记 park 标记的状态跃迁 (`parked` /
`unparked`)，用来回答「意图被 park 之后人有没有捞回来」，据此判断本批 park 指引是否有效。
六列全是 id / 封闭枚举 / 时间戳，`stage` 与 `reason_code` 在写入边界按允许集合校验，因此
`queue_intent_state.park_detail`、意图标题、日志摘要结构上进不来——一张装不下自由文本的表
无法被改造成遥测。采集接在 park 标记的四个写入口 (`recordFailure` 的失败爬梯、`applyPark`、
`clearPark`、`applyHumanOverride`) 之后，且严格在状态持久化成功之后：状态没写成不产生事件，
事件没写成也不回滚已经成功的 park/unpark。固定滚动保留 90 天，追加事件与读取统计两条路径都做
幂等清理。意图被永久删除时 `queue_intent_state` / `queue_decision_log` 会被清理，本表不清理
——观测的是已经发生的事实，留到滚动过期为止。数据只在本机，不外传、不导出。

Schema 版本: 2。纯新增，不改动任何既有表。历史意图没有 `queue_intent_state` 行时按「零次失败、
未 park、无退避/无冷却」解释，无需回填；决策日志从上线时刻开始记录 (详见迁移记录
`migrate/2026/07/31/026`)。v1→v2 新增 `funnel_event` (`id`、`workspace_name`、`intent_id`、
`stage`、`reason_code`、`at` 六列 + 三个索引)。不回填 `queue_decision_log`：它限量保留，无法
可靠证明所有历史 park/unpark 的配对关系，上线前的历史一律不计入基线；旧库首次使用时建空表，
统计从「暂无足够样本」开始 (详见迁移记录 `migrate/2026/08/05/028`)。

### discussions

多 agent 结构化讨论域。`discussions` 记录讨论线程的元数据 (类型、目标、议程、参与者、结论、业务 metadata、研究会话指针)；`discussion_messages` 按 seq 序号存储发言；`discussion_agent_sessions` 记录每个讨论内 agent 与 vendor session 的绑定关系 (支持 resume)，并作为讨论 agent session 归属事实源。讨论的只读研究跑批本身也是一个正式会话，其 vendor session id 记在 `discussions.research_session_id` 上 (不进 `discussion_agent_sessions`——那张表按 agent 建键，研究不属于任何参与 agent)。会话页展示不读取本域的表，而是由生命周期同步写入 `session_metadata(session_kind='discussion', owner_kind='discussion', owner_id=<discussion.id>)` 的可重建投影 (研究会话与各 agent 会话同归此类)。

Schema 版本: 7。v2→v3 新增 `discussions.participant_agent_ids` (创建时选定的参与 agent 集合; `'[]'`=未设置→编排时回退全员, organizer 恒并入)。v3→v4 把工作区主键列 `project_path` 就地改名为 `workspace_name`，复合索引 `idx_disc_project_status` → `idx_disc_workspace_status` (详见迁移记录 `migrate/2026/06/14/012`)。v4→v5 新增 `discussions.organizer_agent_id` (指定组织者 agent id; NULL=使用全局默认)。v5→v6 新增 `discussions.metadata` (JSON 对象，扁平 `string→string` 业务 metadata，默认 `'{}'`；唯一写入方是 MCP `start_discussion`，上限复用 automation metadata 卫生规则；随 `discussion:start`/`discussion:end` 生命周期事件发出；历史行回填空对象，读取端对缺失/损坏值降级为 `{}`；详见迁移记录 `migrate/2026/07/26/025`)。v6→v7 新增 `discussions.research_session_id` (nullable TEXT，研究会话的 vendor session id；研究跑批捕获到 session id 时写入，NULL/`''` 表示该讨论没有研究会话——所有历史行，以及研究在绑定前就失败的新行；无回填可能；详见迁移记录 `migrate/2026/07/30/026`)。

### deliveries

交付 (集成单元) 域 (ADR-0036)。`deliveries` 是「一批意图共同集成并最终进入主线」的 Git 生命周期单元台账。`status` 只接受 `planned / integrating / verifying / verified / delivered / cancelled` 六值 (数据库 CHECK 与共享协议同一闭集，见 `@ccc/shared` 的 `DeliveryStatus`)，无「已完成」态——它等于「所有关联意图的 PR 已合入交付分支」这一可推导事实，只以「集成就绪 N/M」实时聚合呈现 (由 store 直接读 `intent_prs.delivery_id` 派生，不持久化计数、不读冗余列)。`base_branch` 是建交付时对工作区 `defaultMainBranch` 的快照，之后修改配置不回写历史交付。`branch_name`/`branch_ready` 承载交付分支生命周期：`branch_ready` 初始为 0，仅由显式 `init_delivery_branch` 在 git 侧成功 (push 成功或远端幂等绑定) 后置 1，终态手动清理 `cleanup_delivery_branch` 置回 0 并清空 `branch_name`；多仓工作区 (根非 repo 且有子仓) 建交付与初始化均被拒，分支基线只取 `fetch` 后的 `origin/<base_branch>`。`(workspace_name, status)` 有索引；`(workspace_name, branch_name)` 在活动状态 (非 `delivered`/`cancelled`) 下唯一，终态不占位、允许复用历史分支名，空分支名不参与冲突 (部分唯一索引 `idx_delivery_workspace_active_branch`)。状态写入唯一经 delivery 域纯函数 `canTransitionDelivery`，任何位置不得直接绕过。`intent_prs.delivery_id` 是意图→交付的**PR 落点** (由 intents 域 031 迁移预置)，回答「这个意图对某个交付开了哪条 PR」；`intent_deliveries` 是独立的**关联边**，回答「这个意图属于哪个交付」。二者职责分离而非冗余：关联先于 PR 存在 (刚关联时尚未提 PR)，解除关联时 PR 行会被删除而关联边的生死要独立判定，用「有没有 PR 行」代表「有没有关联」会让「已关联但尚未提 PR」这一最常见中间态无处安放。关联边由 delivery 域唯一写入 (`link_intent_to_delivery` / `unlink_intent_from_delivery`)，但 `intents` store 的 SCHEMA **也声明同一 `CREATE TABLE IF NOT EXISTS`**——永久删除意图要在同一事务里 `DELETE FROM intent_deliveries`，而一个从未打开过交付页的库里 delivery store 的 schema ensure 尚未跑过，那条 DELETE 会撞 "no such table" 并回滚整个删除事务；两处均 `IF NOT EXISTS`，先初始化者建表。`(delivery_id, intent_id)` 唯一 (重复关联在应用层先判、索引兜底)；同一意图对多个交付各一条边是允许的，多交付关联的**数据能力保留**、第一版前端不开放入口。**已 merged 的 PR 一律禁止解除关联** (本地 `intent_prs.status` + forge 实时状态双层检查)：代码已在交付分支上，删边会造成「关联没了但代码已在」，只能靠 revert 收场；解除未合并关联时先关闭 PR、成功后**删除**该 `intent_prs` 行 (保留 `closed` 行会让 `integrationAggregate` 继续计数而永久阻塞交付状态推进，置 `delivery_id` 为 NULL 则会撞 `idx_intent_pr_intent_nodelivery`)。永久删除意图同事务清关联边、远端 PR 不动；**取消交付不删关联边** (历史可查优先于表干净)。`delivery_logs` 是交付的只增操作审计轨迹：每一次落定的业务写入 (创建、字段编辑、六态状态机每条合法边、关联与解除关联、开出交付 PR) 与它的日志行在**同一事务**内落定，未落定的动作 (守卫拒绝、重复关联、无事实变化的编辑、外部操作失败) 一律不写；`operation_type` 是按动作语义划分的闭集 (见 `@ccc/shared` 的 `DeliveryLogOperation`)，`summary` 中的状态一律写线上原始状态码；读取按 `created_at DESC, rowid DESC` 稳定倒序 —— 同事务写入的两行共享同一毫秒，只有插入序能把它们分开。

`delivery_prs` 是**交付 PR**——「交付分支 → 主线」的变更请求 (ADR-0039)，与 `intent_prs` 分表而非共表：后者是「意图 → 交付分支」并喂「集成就绪 N/M」聚合、随解除关联删行，前者两者皆不。共表会让 `integrationAggregate` (按 `delivery_id` 计数) 把交付自己算成一个关联意图。`(forge, repo, number)` 是 PR 真实身份且全库唯一 (来源未知的行不参与，与 `intent_prs` 同口径)；`(delivery_id, base_sha, head_sha)` 是幂等键兜底——应用层重试一律先向 forge 查 (head, base) 的开放 PR，命中即复用落账，从不凭本地返回码判定;forge 对同一 (head, base) 只保留一条开放 PR (推新提交是更新同一条)，故落账按 PR 身份就地刷新 SHA，而不是每个 SHA 对插一行。`status` 只出现 `reviewing/merged/closed` 三值。三类失败在此分层：merge 冲突落 `conflict_files` 并把交付回退 `verifying` (代码要改)；CI 失败 / 审批不足落 `blocked_reason`、交付状态不动 (代码没问题，缺的是外部条件)；forge 查询失败什么都不写。旧行留作历史，页面只渲染该交付的最新一行。

`delivery_logs` 是交付操作审计轨迹 (仿 `intent_logs`，只增不改)。交付进入 `delivered` 的状态写与它的日志行在同一事务内落定，因此「代码已进主线但台账无痕」不可能出现；事件发布、跨交付闸门重算与广播都发生在事务提交之后，它们失败不回滚已落定的 `delivered`。

Schema 版本: 2。v1 纯新增 `deliveries` / `intent_deliveries` (详见迁移记录 `migrate/2026/08/06/032`、`033`)。v2 新增 `delivery_prs` 与 `delivery_logs` 两张纯新增表，无存量回填——交付 PR 与交付日志都是新实体，未建过 PR 的既有交付不受影响，历史交付的过往操作也没有留痕可追认 (裁决见 ADR-0039；详见迁移记录 `migrate/2026/08/07/035`、`036`)。

### automations

自动化调度域。`automations` 支持 cron 和 event 两种触发类型 (event 类型形如 `<大类>:<动作>`，含 run-lifecycle、模型发布的 `pr:<operation>` 与 `intent:<phase>`)；`automation_execution_logs` 记录每次执行的结果和真实 agent session id；`workspace_mcp_configs` 存储 per-workspace 的 MCP 服务器配置。写操作权限通过 toolAllowlist/toolDenylist 预配置，不再使用运行时 human-in-the-loop 审批。执行引擎在 `automations/engine.ts`；时间触发 (tick 循环) 在 `features/schedules/`，事件触发在 `features/triggers/`。

Schema 版本: 13。迁移历史: status 列、write*approvals/workspace_mcp_configs 表、session_id 列、trigger 列 (v5)、vendor 列 (v6)、mcp_mode→mode 改名 (v7)、max_wall_clock_ms + agent_id 列 (LLM 任务显式绑定执行 agent)、event_pr_filter 列 (v8，2026-06-20，承载 `pr:operation` 触发的操作/结果过滤 JSON；`event_topic` 取值同步扩展容纳 `'pr:operation'`，无需改列类型；历史行/cron/run-lifecycle 行保持 NULL=任意；详见迁移记录 `migrate/2026/06/20/018)。v9 新增 `event_intent_filter`，用于意图生命周期阶段过滤；历史行和非意图事件行保持 NULL，表示任意阶段。v10 (2026-07-03)：schedule→automation 改名，`schedules`→`automations`、`schedule_execution_logs`→`automation_execution_logs`、`schedule_id`→`automation_id`，历史库以 `ALTER TABLE ... RENAME`幂等就地迁移；SessionKind/ownerKind 字面量`'schedule'`→`'automation'`，`session_metadata`/`wait_user_involve_events` 历史行以 UPDATE 迁移。v11 (2026-07-04) 新增三列：`metadata` (JSON 对象文本，NOT NULL DEFAULT '{}'，自由 key/value 标注，仅随该 automation 自身的 run:started/run:settled 事件下发)、`event_session_kind_filter`(JSON 数组，run-lifecycle 事件触发的 sessionKind 多选，非空必填；存量 run-lifecycle event automation 回填`["work"]` 完全保持旧行为，cron/pr/intent 行为 NULL)、`event_metadata_filter`(JSON`{conditions,combinator}`，run-lifecycle 事件的 metadata 条件过滤，NULL=不过滤)。v12 (2026-07-13)：事件触发过滤器统一。新增单一 `event_filter`(JSON `GenericEventFilter {type, statuses?, metadata?}`)，收敛 `event_topic`(→`type`)、`event_reason_filter`/`event_pr_filter.results`/`event_intent_filter.phases`(→`statuses`)、`event_pr_filter.operations`(→`metadata`的 OR 条件`{key:'operation',value}`)、`event_metadata_filter`(→`metadata`)。事务内幂等回填：仅填 `event_filter IS NULL` 的 event 行，损坏旧 JSON 采用宽松解析(该维度通配)不收紧、不抛出。旧列 (`event_topic`/`event_reason_filter`/`event_pr_filter`/`event_intent_filter`/`event_metadata_filter`) **保留为迁移输入**，运行时不再读写/匹配；`event_session_kind_filter`保持独立(run-lifecycle 安全边界)。回填事务失败则中止 schema 初始化。详见`migrate/2026/07/13/`。v13 (2026-07-14)：`<大类>:<动作>`事件类型规范 + 多行订阅。新增`event_filters`(JSON `GenericEventFilter[]` 订阅行数组,任一命中即触发),动作维度提升为类型本身:`pr:operation`按 metadata.operation 的纯 OR 条件拆为逐`pr:<op>`行(其他 metadata 形态回退为`pr:*` 行原样携带,语义等价——PR 事件仍冗余携带 metadata.operation)、`intent:lifecycle`的 statuses(phases) 逐个提升为`intent:<phase>` 行(为空→`intent:_`)、run/自定义类型原样包数组;「任意动作」为 `<category>:_` 通配。`event*filter`**保留为迁移输入**,运行时只读写/匹配`event_filters`;`event_session_kind_filter`保持独立(判定条件改为「任一订阅行为 run 生命周期类型,含`run:*`」)。事务内幂等回填,仅填 `event_filters IS NULL`且`event_filter IS NOT NULL` 的 event 行。详见`migrate/2026/07/14/`。

### user-involve

Schema 版本: 5。v1→v2 把工作区主键列 `project_path` 就地改名为 `workspace_name`，复合索引 `idx_wui_project_status` → `idx_wui_workspace_status` (详见迁移记录 `migrate/2026/06/14/012`)。v2→v3 新增 `outcome` (nullable TEXT，JSON)，仅 `status='auto'` 的共识自动决策审计记录携带 (AnyConsensusOutcome：投票/裁决/摘要)，人类决策事件为 NULL；同时 `status` 取值域扩展出非阻塞审计态 `'auto'`，不计待处理徽章 (详见迁移记录 `migrate/2026/06/20/015`)。v3→v4 把来源取值 `'session'` 折叠为 `'work'` (详见迁移记录 `migrate/2026/06/26/016`)。v4→v5 把来源列改名为真实会话身份：`source` → `session_kind` (放宽存完整 SessionKind)、`source_id` → `session_id` (产生事件的真实会话 id)，复合索引 `idx_wui_source_status` → `idx_wui_session_status`；读取端按 `session_id` 反查所属意图派生 `intentId`/`intentTitle` (不落库)，历史行降级不回填 (详见迁移记录 `migrate/2026/06/26/017`)。

### sessions

统一会话列表投影域。`session_metadata` 由旧 `work_session_metadata` 就地 RENAME 而来，是 work / intent / spec / discussion / automation / tool 六类会话的列表读路径缓存。事实源仍在各业务表和 vendor native store；本表不存 transcript / prompt / tool_use / tool_result。新增 `session_kind` 区分业务分类，`owner_kind` / `owner_id` 支撑前端跳回，`bound` 替代旧 `kind` 的读语义 (`real`→1、`pending`→0)。spec 撰写/重置会话在绑定真实 session id 后写入 `session_kind='spec'`、`owner_kind='intent'`、`owner_id=<intent.id>`；讨论 agent vendor session 首次创建后写入 `session_kind='discussion'`、`owner_kind='discussion'`、`owner_id=<discussion.id>`、`bound=1`，标题使用讨论标题 + agent 展示名；LLM 自动化任务拿到真实 agent session id 后写入 `session_kind='automation'`、`owner_kind='automation'`、`owner_id=<automation.id>`，`automation_execution_logs.session_id` 仍是执行历史的 SoT。`discussion_agent_sessions` 仍是当前 `(discussion_id, agent_id)` 归属的 SoT。`intents.spec_session_id` 仍是当前 spec 会话归属的 SoT。上述行均只是可重建读缓存。工具会话注册时写入 `session_kind='tool'`，有可路由来源时复用 `owner_kind` / `owner_id`，无来源或历史重建行保持 owner 为空，仅展示不可跳回。`tool_sessions` 仍是兼容标记表，不新增 `origin_kind` / `origin_id`，避免来源在两处漂移。旧 `kind` 列保留用于兼容和审计，新代码不再依赖它判断 pending/real。没有 session→agent 事实的真实会话由本表按 `vendor_session_id` 反查绑定 (专用索引 `idx_sm_vendor_session_id`)，使会话列表与标题栏读到同一个 vendor / agent。

无独立 schema 版本号 (不写 `PRAGMA user_version`，避免与其他 store 冲突)。

### config

配置持久化域 (2026-08-12，ADR-0042)。取代 `~/.c3/settings.json`、`~/.c3/state.json` 与
`${CLAUDE_CONFIG_DIR:-~/.claude}/c3/state.json` 三份 JSON 文件。

`workspaces` 是工作区身份表：`name` 是 1–64 个 Unicode 字符、全局唯一、区分大小写且不可变的
协议与持久化身份，也是 `workspace_configs` 和各业务表 `workspace_name` 的关联键。`path` 唯一且只
用于文件系统定位。从列表移除一个工作区只置 `registered=0` 而不删行，重新添加同一目录恢复原名称
与配置；`registered=0` 的行也用来安置只在旧 `projectConfigs` 里出现、从未注册过的路径。

其余五张表是同一形态的细粒度 KV：`config_key` 是点分字段路径 (段内的 `.` 以 `%2E` 转义)，
`config_type ∈ {string, number, boolean, json, secret}` 说明 `config_value` 怎么解码。展开规则
集中声明在 `kernel/config/config-schema.ts`：定长对象逐字段展开 (`proxy.enabled`)，有稳定 id 的
记录集合以 id 作为一段 (`agents.<id>.vendor`，附一条 `<path>._order` 保序)，只有「多值且无稳定
身份」的子树才整体落 JSON (`degradationChain`、`sandbox.extraMounts`、以路径为键的 skill 挂载索引)。
`secret` 类型的值是 `encryption.ts` 的 `c3secretv1:` 密文 (agent apiKey、auth 口令哈希、MCP 密钥
摘要)，读时解密、写时加密；内存缓存始终明文，落库始终密文。

一字段一行带来的结构性后果：保存工作区配置与保存系统设置在存储层不再相交，写入方不必再带上它并
不拥有的字段，因此文件时代那套「反覆盖合并 + 把兄弟键挂回去」的补救逻辑连同它所补救的缺陷一起消失
(`saveWorkspaceSetting` 曾因漏挂而抹掉 `personalizedSettings`/`agentLang`/`mcpApiKeys`)。跨进程
原子性由 SQLite 事务 + WAL 承担，不再需要 `mkdirSync` 目录锁。

`system_configs` 另外容纳三类并不属于 `SystemSettings`、只是共享同一张表的键：`state.*` (原
state.json 的全局部分)、`agentLang`，以及授权策略的新鲜度计数器 `auth.policyEpoch`。整体保存系统
设置时以 `preservePrefixes` 保护它们——`auth.policyEpoch` 与 `SystemSettings.auth` 共享键空间但不
属于它，不保护就会被一次系统设置保存删掉。

旧 JSON 的一次性导入由 `kernel/config/import-legacy.ts` 完成，三条 `schema_migrations` 标记各自
幂等 (`config.import_workspaces.v1` / `config.import_settings.v1` / `config.import_session_state.v1`)，
数据与标记同事务。导入**只由启动中的服务端触发**，读路径一律不隐式触发——否则任何只是读一下设置的
进程 (单测、一次性脚本) 都会改写并弃用用户的真实文件。旧文件在事务提交后才重命名为
`<name>.migrated-<epoch>`：事务内改名会在回滚后幸存，把唯一的配置副本一起带走。

### auth

账号级授权域。`user_workspace_scopes` 记录一个 subject 的工作区范围模式 (`all` 跟随注册表 /
`selected` 固定名单)，`user_workspace_scope_items` 记录 `selected` 下的明细。拆两张表是为了让
「选定了但一个都没选」成为可表达的状态——单列名单会把它和「压根没配」压成同一个空值。

**默认拒绝**：没有策略行 = 一个工作区也到不了。已配置的管理员与无认证部署的合成主体 `local` 恒为
全部范围，且**不写行**——写行意味着管理员能编辑掉自己的恢复权限。

明细行对 `workspaces.name` 是弱引用，不设外键：注册表移除只置 `registered=0` 从不删行，而一个已
消失的名称必须退化为「什么也到不了」，不能级联删掉管理员仍想看到的配置。写入整体替换，与
`system_configs` 的 `auth.policyEpoch` 同事务提交。

### external-mcp

外部 MCP 调用的归因域。`external_mcp_write_audits` 是**只增**表：每一次**写工具**调用尝试一行，
记录 `key_id`、`owner_subject`、授权判定所针对的 `workspace_name`、工具名与 `result`
(`success`/`failure`/`rejected`)。吊销只能挡住下一次调用，回答不了「谁用哪把 key 对哪个工作区做了
什么」——业务台账记的是「什么被改了」，从不记「哪个凭据要求改的」。

刻意**没有**入参、工具输出、bearer、哈希与认证头列：能泄漏凭据的审计轨迹等于凭据的第二份副本。
`key_id` 对 `mcp_api_keys` 不设外键，key 吊销后历史仍须可读。写入不进业务事务：落库失败保持业务
结果不变，但必须发出脱敏的运维错误，让审计缺口可观测。读操作不入表 (见 security.md SEC-14 的已知
缺口)。

### memory

工作区长期记忆域。`workspace_memories` 承载仓库无法自证、也不适合写进 `CLAUDE.md` 的东西：用户口头
表达过的偏好、验证过一次的项目约束、稳定事实、踩过的坑。它是**结论**的存储，不是转录的存储——刻意
没有代码片段、命令、提示词、工具输入输出与对话原文的位置，写入时按集中的拒绝规则挡掉凭据形状与
代码/工具/转录框架 (记忆不是密钥库：形状检测挡得住常见凭据，挡不住任意散文)。

身份是 `(workspace_name, title_key)`。`title_key` 是 `title` 的归一化派生键 (去首尾空白、折叠内部
空白、Unicode 小写)，只为让去重与清理成为索引点查，不属于领域模型。同名写入原地覆盖，是本能力唯一
的自动语义判断——系统从不比较正文，也不问 LLM 两句话是否矛盾，因此真正互斥的两条必须用不同 `title`
(可共用 `subject` 让分歧可发现)，两条都保持 `active`。

`active` 是普通检索唯一可见的状态。`superseded` (去重的败者，`superseded_by` 指向留下的那条) 与
`deleted` (软删) 按各自的 `updated_at` 满 30 天才被物理删除，回收期内仍占容量——容量满时拒绝新条目，
而不是缩短可恢复性或淘汰另一条记忆；`active` 的 `preference` 永不因年龄被清理。硬边界为单条 `content`
≤ 2000 个 Unicode 码点、单工作区 ≤ 500 物理行，计数与插入同事务，超限一律显式报错。

### robots

IM 聊天机器人域。八张表把「群里 @机器人 提问、c3 跑一轮会话、把答案发回群里」以及 IM 身份绑定与
调用级作用域分开持有:`im_robots` 是配置与授权,`im_robot_threads` 是发送者隔离的 Conversation,
`im_robot_context_turns` 是可恢复的 IM 可见正文,`im_robot_turns` 是外发审计,`im_identity_challenges` /
`im_identity_bindings` / `im_group_workspace_scopes` / `im_identity_audit` 是 Web→私聊身份绑定、群明细
白名单与授权审计。它是 c3 唯一一条主动把 agent 产出送往第三方云的路径;授权模型由 ADR-0046 裁定,
上下文持久化例外由 ADR-0048 裁定,身份绑定与调用级作用域由 ADR-0049 裁定。正式定义见
[术语表·机器人](../doc/glossary.md)。

**部署级出入口、不绑工作区**是本域的结构性特征:`im_robots` 刻意没有 `workspace_name` 列——配置/
连接/名册跨工作区一致,但不等于无边界访问。机器人按 `name` 拥有独立工作目录
`~/.c3/robots/<name>/`,那是隔离的运行容器而非授权范围或默认工作区;`name` 同时是显示名、目录名与
身份,受路径安全约束且创建后不可改。该目录不进工作区注册表,也不是会话恢复或授权判断的输入。否决
工作区内机器人以及连接/线程级工作区绑定。

Conversation 身份是 `(platform, robot_id, thread_key, sender_id, binding_id, subject, scope_hash)`。
同一群内不同发送者互不相通;绑定后的 c3 主体与单调 `scope_hash` 决定可恢复的 Context Turn 候选。
`session_id` 只是同 vendor 下的续接缓存。正文只存在于 `im_robot_context_turns`(成对、有界、30 天硬删);
审计**只记元数据**——`outbound_chars` 是长度而非内容。没发出去的结局同样留痕
(`guard_refused` / `blocked` / `timeout` / `input_rejected` / `busy`)。

ADR-0046 的四条授权凭据里有三条落在这里:`enabled` 默认 `0` 且没有「创建并启用」的一步操作;
`outbound_ack_at` 记录用户确认外发范围的时刻,服务端在启用时校验它;每一次外发在 `im_robot_turns`
留一行。

权限在配置时冻结而非现场询问:群里没有人能回答权限对话框,所以 `tool_allowlist` 为空 (创建时的默认)
即只读,写/执行能力必须由管理员显式列举。响应面同样默认收敛:`require_mention` 默认 `1`,
`dm_mode` 默认 `disabled`。

连接状态不在库里。连上没有、重连第几次、上次为何失败都是进程内的运行时事实,由 supervisor 持有并
随查询回传——落库只会产生一份必然过期的快照。

## 数据库设计约定

1. **单 SQLite 文件**: `~/.c3/c3.db` (CLI `--db <path>` > `C3_DB_PATH` > `C3_DIR` > 默认)，`PRAGMA journal_mode=WAL`，`PRAGMA busy_timeout=3000`。配置也在库内，因此 `--db` 一个覆盖即可搬走整个实例，c3 home 目录跟随它
2. **惰性 Schema**: 每个 store 模块首次访问时执行 `CREATE TABLE IF NOT EXISTS`，不依赖全局 migration 工具
3. **幂等迁移**: 驱动方式是 `PRAGMA table_info` 列存在性检查，不依赖共享的 `PRAGMA user_version` (多个 store 会互相覆盖)
4. **丢表从严**: 迁移从不执行 `DROP TABLE`，只做 `ALTER TABLE ... RENAME TO` 或 `ALTER TABLE ... ADD COLUMN`；索引迁移允许 `DROP INDEX` + `CREATE INDEX IF NOT EXISTS` 重建
5. **时间戳**: 统一使用 epoch 毫秒 (`Date.now()`)，列名后缀 `_at`
6. **JSON 列**: `config`、`agenda`、`tool_allowlist`、`tool_denylist`、`tool_input`、`config_json` 等配置类数据以 JSON 字符串存储，读写时 parse/stringify
7. **降级策略**: `getDb()` 返回 null 时，读操作返回空/null，写操作抛异常，保证 c3 在无数据库时仍可启动运行
8. **测试隔离**: `resetDbForTests()` 清空数据库 + 重置各 store 的 `schemaReady` 标志
