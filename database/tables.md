# Database Tables

所有表存储在单文件 SQLite 数据库 `~/.c3/c3.db` 中，通过 `node:sqlite` / `bun:sqlite` 内置驱动访问。Schema 在各 Store 模块中惰性创建 (`CREATE TABLE IF NOT EXISTS`)，迁移通过 `PRAGMA table_info` 列存在性检查做幂等演进。

> **注意**: 项目 Constitution 原声明 "no database or persistent store allowed"，但 ADR 实践中引入了 SQLite 作为本地持久化层。`~/.c3/c3.db` 是单实例本地文件，不存在网络访问风险。

## 基础设施

| 文件 | 说明 |
|---|---|
| `server/src/kernel/infra/db.ts` | SQLite 访问层，封装 `getDb()` / `isDbAvailable()` / `resetDbForTests()` |

## 表一览

| # | 模块 | 表名 | SQL 文件 | Store 文件 | 用途 |
|---|------|------|----------|------------|------|
| 1 | intents | `intents` | [intents/intents.sql](intents/intents.sql) | `server/src/features/intents/store.ts` | 意图(需求/任务)台账 |
| 2 | intents | `intent_deps` | [intents/intent_deps.sql](intents/intent_deps.sql) | `server/src/features/intents/store.ts` | 意图依赖关系 (多对多) |
| 3 | intents | `intent_chats` | [intents/intent_chats.sql](intents/intent_chats.sql) | `server/src/features/intents/store.ts` | 沟通会话映射 + 隐藏会话集 |
| 4 | intents | `tool_sessions` | [intents/tool_sessions.sql](intents/tool_sessions.sql) | `server/src/features/intents/store.ts` | 工具创建的会话 ID 集合 |
| 5 | discussions | `discussions` | [discussions/discussions.sql](discussions/discussions.sql) | `server/src/features/discussions/store.ts` | 讨论线程元数据 |
| 6 | discussions | `discussion_messages` | [discussions/discussion_messages.sql](discussions/discussion_messages.sql) | `server/src/features/discussions/store.ts` | 讨论消息 |
| 7 | discussions | `discussion_agent_sessions` | [discussions/discussion_agent_sessions.sql](discussions/discussion_agent_sessions.sql) | `server/src/features/discussions/store.ts` | 讨论内 agent→vendor 会话映射 |
| 8 | schedules | `schedules` | [schedules/schedules.sql](schedules/schedules.sql) | `server/src/features/schedules/store.ts` | 定时任务 (cron + event) |
| 9 | schedules | `schedule_execution_logs` | [schedules/schedule_execution_logs.sql](schedules/schedule_execution_logs.sql) | `server/src/features/schedules/store.ts` | 定时任务执行历史 |
| 10 | schedules | `write_approvals` | [schedules/write_approvals.sql](schedules/write_approvals.sql) | `server/src/features/schedules/store.ts` | 写操作审批 (human-in-the-loop) |
| 11 | schedules | `workspace_mcp_configs` | [schedules/workspace_mcp_configs.sql](schedules/workspace_mcp_configs.sql) | `server/src/features/schedules/store.ts` | 每 workspace 的 MCP 配置 |
| 12 | user-involve | `wait_user_involve_events` | [user-involve/wait_user_involve_events.sql](user-involve/wait_user_involve_events.sql) | `server/src/features/user-involve/store.ts` | 等待用户介入事件 |
| 13 | works | `work_session_metadata` | [works/work_session_metadata.sql](works/work_session_metadata.sql) | `server/src/features/works/work-session-store.ts` | 会话列表元数据投影 |

## 模块说明

### intents

意图管理的核心域。`intents` 是主表，记录每个需求/任务的生命周期；`intent_deps` 表达意图间的先后依赖；`intent_chats` 同时充当 per-project 沟通会话映射和隐藏会话过滤器；`tool_sessions` 持久化工具自动创建的会话 ID 集合。

Schema 版本: 7。v5→v6 完成了 `requirements*` → `intents*` 的就地表重命名迁移。

### discussions

多 agent 结构化讨论域。`discussions` 记录讨论线程的元数据 (类型、目标、议程、结论)；`discussion_messages` 按 seq 序号存储发言；`discussion_agent_sessions` 记录每个讨论内 agent 与 vendor session 的绑定关系 (支持 resume)。

Schema 版本: 2。

### schedules

定时任务调度域。`schedules` 支持 cron 和 event 两种触发类型；`schedule_execution_logs` 记录每次执行的结果和 agent session id；`write_approvals` 实现 scheduled task 运行时的写操作 human-in-the-loop 审批；`workspace_mcp_configs` 存储 per-workspace 的 MCP 服务器配置。

Schema 版本: 5。迁移历史: status 列、write_approvals/workspace_mcp_configs 表、session_id 列、trigger 列 (v5)、vendor 列 (v6)、mcp_mode→mode 改名 (v7)。

### user-involve

用户介入事件域。`wait_user_involve_events` 记录需要人工决策的工具调用事件（如 schedule 运行时触发的敏感操作），按 source/source_id 关联触发源。

Schema 版本: 1。

### works

会话列表投影域。`work_session_metadata` 是会话列表读路径的核心缓存表，只存储 5 列核心元数据 (不含 transcript 内容)，通过 lazy validation 和 janitor 保持与 native 存储同步。kind 列区分 `real` (已 bind) 和 `pending` (未 bind 意图)。

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
