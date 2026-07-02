# Database Tables

所有表存储在单文件 SQLite 数据库 `~/.c3/c3.db` 中，通过 `node:sqlite` / `bun:sqlite` 内置驱动访问。Schema 在各 Store 模块中惰性创建 (`CREATE TABLE IF NOT EXISTS`)，迁移通过 `PRAGMA table_info` 列存在性检查做幂等演进。

> **注意**: 项目 Constitution 原声明 "no database or persistent store allowed"，但 ADR 实践中引入了 SQLite 作为本地持久化层。`~/.c3/c3.db` 是单实例本地文件，不存在网络访问风险。共 14 张表，6 个模块。

## 基础设施

| 文件                            | 说明                                                                    |
| ------------------------------- | ----------------------------------------------------------------------- |
| `server/src/kernel/infra/db.ts` | SQLite 访问层，封装 `getDb()` / `isDbAvailable()` / `resetDbForTests()` |

## 表一览

| #   | 模块         | 表名                        | SQL 文件                                                                               | Store 文件                                               | 用途                                                     |
| --- | ------------ | --------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------- |
| 1   | intents      | `intents`                   | [intents/intents.sql](intents/intents.sql)                                             | `server/src/features/intents/store.ts`                   | 意图(需求/任务)台账                                      |
| 2   | intents      | `intent_deps`               | [intents/intent_deps.sql](intents/intent_deps.sql)                                     | `server/src/features/intents/store.ts`                   | 意图依赖关系 (多对多)                                    |
| 3   | intents      | `intent_chats`              | [intents/intent_chats.sql](intents/intent_chats.sql)                                   | `server/src/features/intents/store.ts`                   | 沟通会话映射 + 隐藏会话集                                |
| 4   | intents      | `tool_sessions`             | [intents/tool_sessions.sql](intents/tool_sessions.sql)                                 | `server/src/features/intents/store.ts`                   | 工具创建的会话 ID 集合                                   |
| 5   | discussions  | `discussions`               | [discussions/discussions.sql](discussions/discussions.sql)                             | `server/src/features/discussions/store.ts`               | 讨论线程元数据                                           |
| 6   | discussions  | `discussion_messages`       | [discussions/discussion_messages.sql](discussions/discussion_messages.sql)             | `server/src/features/discussions/store.ts`               | 讨论消息                                                 |
| 7   | discussions  | `discussion_agent_sessions` | [discussions/discussion_agent_sessions.sql](discussions/discussion_agent_sessions.sql) | `server/src/features/discussions/store.ts`               | 讨论内 agent→vendor 会话映射                             |
| 8   | schedules    | `schedules`                 | [schedules/schedules.sql](schedules/schedules.sql)                                     | `server/src/features/schedules/store.ts`                 | 定时任务 (cron + event)                                  |
| 9   | schedules    | `schedule_execution_logs`   | [schedules/schedule_execution_logs.sql](schedules/schedule_execution_logs.sql)         | `server/src/features/schedules/store.ts`                 | 定时任务执行历史                                         |
| 10  | schedules    | `workspace_mcp_configs`     | [schedules/workspace_mcp_configs.sql](schedules/workspace_mcp_configs.sql)             | `server/src/features/schedules/store.ts`                 | 每 workspace 的 MCP 配置                                 |
| 11  | user-involve | `wait_user_involve_events`  | [user-involve/wait_user_involve_events.sql](user-involve/wait_user_involve_events.sql) | `server/src/features/user-involve/store.ts`              | 等待用户介入事件                                         |
| 12  | sessions     | `session_metadata`          | [sessions/session_metadata.sql](sessions/session_metadata.sql)                         | `server/src/features/sessions/session-metadata-store.ts` | 统一会话列表元数据投影 (由 `work_session_metadata` 改名) |
| 13  | intents      | `intent_sessions`           | [intents/intent_sessions.sql](intents/intent_sessions.sql)                             | `server/src/features/intents/store.ts`                   | intent work session 执行记录 (审计追踪)                  |
| 14  | intents      | `intent_logs`               | [intents/intent_logs.sql](intents/intent_logs.sql)                                     | `server/src/features/intents/store.ts`                   | 意图生命周期变更日志 (操作审计轨迹)                      |

## 模块说明

### intents

意图管理的核心域。`intents` 是主表，记录每个需求/任务的生命周期；`intent_deps` 表达意图间的先后依赖；`intent_chats` 同时充当 per-workspace 沟通会话映射和隐藏会话过滤器；`tool_sessions` 持久化工具自动创建的会话 ID 集合，仅回答“这个 vendor session 是否由工具创建”，不保存来源反链；`intent_sessions` 记录每次 intent work session 的执行审计历史；`intent_logs` 记录意图生命周期的操作审计轨迹 (谁、什么时间、做了什么)，只增不改，工作会话启动/结束不写本表 (由 `intent_sessions` 覆盖)。

Schema 版本: 16。v5→v6 完成了 `requirements*` → `intents*` 的就地表重命名迁移。v7→v8 新增 git 追踪字段: `branch_name`, `latest_commit_hash`, `pr_id`, `pr_status`。v8→v9 扩展 `intent_deps` 新增 `dep_type` (blocks/informs/soft_after) + `created_at`。v9→v10 新增 `intent_sessions` 表 (work session 审计追踪)。v10→v11 把工作区主键列 `project_path` 就地改名为 `workspace_path` (`intents` + `intent_chats`)，复合索引 `idx_intent_project_status` → `idx_intent_workspace_status`；单列索引 `idx_chat_project` 保留索引名、列引用随改 (详见迁移记录 `migrate/2026/06/14/012`)。v11→v12 新增 `intents.short_en_title` (nullable TEXT，派生分支/worktree 名的稳定 ASCII 来源；历史行保持 NULL，写入侧截断到 128；详见迁移记录 `migrate/2026/06/18/013`)。v12→v13 新增 spec 质量闸 + 会话字段: `spec_path` (nullable TEXT，已撰写 spec 文档路径)、`spec_approved` (INTEGER 0/1，DEFAULT 0，人工审批闸状态)、`spec_approve_user` (nullable TEXT，审批人)、`spec_session_id` (nullable TEXT，撰写/精炼 spec 的会话)、`intent_session_id` (nullable TEXT，refine/沟通会话；与 `last_work_session_id` 工作会话并存且语义不同)；历史行 `spec_approved=0`、其余 NULL；详见迁移记录 `migrate/2026/06/18/014`)。v13→v14 新增 `intents.pr_url` (nullable TEXT，PR 可跳转链接如 GitHub PR URL；与 `latest_commit_hash` 语义不重复，不引入重复的 `commit_hash` 字段；历史行保持 NULL；手动 Start Work 结束自动收尾 Git/PR 时写入；详见迁移记录 `migrate/2026/06/20/016`)。v14→v15 把最近一次意图工作会话指针列 `last_dev_session_id` 就地改名为 `last_work_session_id` (详见迁移记录 `migrate/2026/06/30/020`)。v15→v16 新增 `intent_logs` 表 (生命周期变更日志: `id` uuid 主键、`intent_id`、`operation_type`、`summary`、`actor`、`created_at`，索引 `idx_intent_log_intent_created(intent_id, created_at DESC)`；无历史数据迁移，从上线时刻开始记录；详见迁移记录 `migrate/2026/07/02/021`)。

### discussions

多 agent 结构化讨论域。`discussions` 记录讨论线程的元数据 (类型、目标、议程、参与者、结论)；`discussion_messages` 按 seq 序号存储发言；`discussion_agent_sessions` 记录每个讨论内 agent 与 vendor session 的绑定关系 (支持 resume)，并作为讨论 agent session 归属事实源。会话页展示不读取本表，而是由生命周期同步写入 `session_metadata(session_kind='discussion', owner_kind='discussion', owner_id=<discussion.id>)` 的可重建投影。

Schema 版本: 5。v2→v3 新增 `discussions.participant_agent_ids` (创建时选定的参与 agent 集合; `'[]'`=未设置→编排时回退全员, organizer 恒并入)。v3→v4 把工作区主键列 `project_path` 就地改名为 `workspace_path`，复合索引 `idx_disc_project_status` → `idx_disc_workspace_status` (详见迁移记录 `migrate/2026/06/14/012`)。v4→v5 新增 `discussions.organizer_agent_id` (指定组织者 agent id; NULL=使用全局默认)。

### schedules

定时任务调度域。`schedules` 支持 cron 和 event 两种触发类型 (event 含 run-lifecycle 与模型发布的 `pr:operation`)；`schedule_execution_logs` 记录每次执行的结果和真实 agent session id；`workspace_mcp_configs` 存储 per-workspace 的 MCP 服务器配置。写操作权限通过 toolAllowlist/toolDenylist 预配置，不再使用运行时 human-in-the-loop 审批。

Schema 版本: 9。迁移历史: status 列、write_approvals/workspace_mcp_configs 表、session_id 列、trigger 列 (v5)、vendor 列 (v6)、mcp_mode→mode 改名 (v7)、max_wall_clock_ms + agent_id 列 (LLM 任务显式绑定执行 agent)、event_pr_filter 列 (v8，2026-06-20，承载 `pr:operation` 触发的操作/结果过滤 JSON；`event_topic` 取值同步扩展容纳 `'pr:operation'`，无需改列类型；历史行/cron/run-lifecycle 行保持 NULL=任意；详见迁移记录 `migrate/2026/06/20/018)。v9 新增 `event_intent_filter`，用于意图生命周期阶段过滤；历史行和非意图事件行保持 NULL，表示任意阶段。

### user-involve

Schema 版本: 5。v1→v2 把工作区主键列 `project_path` 就地改名为 `workspace_path`，复合索引 `idx_wui_project_status` → `idx_wui_workspace_status` (详见迁移记录 `migrate/2026/06/14/012`)。v2→v3 新增 `outcome` (nullable TEXT，JSON)，仅 `status='auto'` 的共识自动决策审计记录携带 (AnyConsensusOutcome：投票/裁决/摘要)，人类决策事件为 NULL；同时 `status` 取值域扩展出非阻塞审计态 `'auto'`，不计待处理徽章 (详见迁移记录 `migrate/2026/06/20/015`)。v3→v4 把来源取值 `'session'` 折叠为 `'work'` (详见迁移记录 `migrate/2026/06/26/016`)。v4→v5 把来源列改名为真实会话身份：`source` → `session_kind` (放宽存完整 SessionKind)、`source_id` → `session_id` (产生事件的真实会话 id)，复合索引 `idx_wui_source_status` → `idx_wui_session_status`；读取端按 `session_id` 反查所属意图派生 `intentId`/`intentTitle` (不落库)，历史行降级不回填 (详见迁移记录 `migrate/2026/06/26/017`)。

### sessions

统一会话列表投影域。`session_metadata` 由旧 `work_session_metadata` 就地 RENAME 而来，是 work / intent / spec / discussion / schedule / tool 六类会话的列表读路径缓存。事实源仍在各业务表和 vendor native store；本表不存 transcript / prompt / tool_use / tool_result。新增 `session_kind` 区分业务分类，`owner_kind` / `owner_id` 支撑前端跳回，`bound` 替代旧 `kind` 的读语义 (`real`→1、`pending`→0)。spec 撰写/重置会话在绑定真实 session id 后写入 `session_kind='spec'`、`owner_kind='intent'`、`owner_id=<intent.id>`；讨论 agent vendor session 首次创建后写入 `session_kind='discussion'`、`owner_kind='discussion'`、`owner_id=<discussion.id>`、`bound=1`，标题使用讨论标题 + agent 展示名；LLM 定时任务拿到真实 agent session id 后写入 `session_kind='schedule'`、`owner_kind='schedule'`、`owner_id=<schedule.id>`，`schedule_execution_logs.session_id` 仍是执行历史的 SoT。`discussion_agent_sessions` 仍是当前 `(discussion_id, agent_id)` 归属的 SoT。`intents.spec_session_id` 仍是当前 spec 会话归属的 SoT。上述行均只是可重建读缓存。工具会话注册时写入 `session_kind='tool'`，有可路由来源时复用 `owner_kind` / `owner_id`，无来源或历史重建行保持 owner 为空，仅展示不可跳回。`tool_sessions` 仍是兼容标记表，不新增 `origin_kind` / `origin_id`，避免来源在两处漂移。旧 `kind` 列保留用于兼容和审计，新代码不再依赖它判断 pending/real。

无独立 schema 版本号 (不写 `PRAGMA user_version`，避免与其他 store 冲突)。

## 数据库设计约定

1. **单 SQLite 文件**: `~/.c3/c3.db`，`PRAGMA journal_mode=WAL`，`PRAGMA busy_timeout=3000`
2. **惰性 Schema**: 每个 store 模块首次访问时执行 `CREATE TABLE IF NOT EXISTS`，不依赖全局 migration 工具
3. **幂等迁移**: 驱动方式是 `PRAGMA table_info` 列存在性检查，不依赖共享的 `PRAGMA user_version` (多个 store 会互相覆盖)
4. **丢表从严**: 迁移从不执行 `DROP TABLE`，只做 `ALTER TABLE ... RENAME TO` 或 `ALTER TABLE ... ADD COLUMN`；索引迁移允许 `DROP INDEX` + `CREATE INDEX IF NOT EXISTS` 重建
5. **时间戳**: 统一使用 epoch 毫秒 (`Date.now()`)，列名后缀 `_at`
6. **JSON 列**: `config`、`agenda`、`tool_allowlist`、`tool_denylist`、`tool_input`、`config_json` 等配置类数据以 JSON 字符串存储，读写时 parse/stringify
7. **降级策略**: `getDb()` 返回 null 时，读操作返回空/null，写操作抛异常，保证 c3 在无数据库时仍可启动运行
8. **测试隔离**: `resetDbForTests()` 清空数据库 + 重置各 store 的 `schemaReady` 标志
