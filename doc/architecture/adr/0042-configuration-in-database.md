# 0042 — 配置只有一处事实源:c3.db

- **Status:** accepted
- **Date:** 2026-08-12

## Context

在此之前,c3 的配置被劈成三份 JSON 文件加一个数据库,而且边界互相错位:

| 位置                      | 内容                                                   |
| ------------------------- | ------------------------------------------------------ |
| `~/.c3/settings.json`     | 系统设置、每工作区设置、个性化设置、MCP 密钥           |
| `~/.c3/state.json`        | 会话 ↔ agent 绑定、待定意图                            |
| `~/.claude/c3/state.json` | 工作区注册表、会话权限模式、codex 策略、skill 挂载索引 |
| `~/.c3/c3.db`             | 25 张业务表                                            |

这套划分制造了三个具体问题,它们都不是"文件不如数据库"这种口味之争:

1. **一个实例需要两个不相干的覆盖项才能搬走。** `--settings` 只改配置目录 (`kernel/config/paths.ts`),
   `C3_DB_PATH` 只改数据库 (`kernel/infra/db.ts`),两条解析链只在默认值上重合。e2e 因此长期背着
   「必须同时给两个覆盖」的约定,漏一个就会让一个本以为隔离的服务器写进开发者真实的 `~/.c3`。

2. **每次保存都是整份文档的读改写。** 改一个工作区开关要读回 70KB JSON、合并、整体落盘。整体落盘
   要求写入方带上它并不拥有的字段,于是需要一套手写的反覆盖合并去补救——而这类补救漏一处就是静默
   丢数据:`saveWorkspaceSetting` 落盘时未回挂 `personalizedSettings`/`agentLang`/`mcpApiKeys`,
   任何一次工作区保存都会把这三类记录从磁盘上抹掉。

3. **并发靠自造锁。** `kernel/config/store.ts` 用 `mkdirSync` 目录锁 + 陈旧锁按龄回收 + 超时后
   降级为 best-effort,模拟的正是同一个进程里 SQLite 的事务与 WAL 本就提供的东西。

## Options considered

- **A. 维持文件,修补第 2 类缺陷** —— 被否决。反覆盖合并是整份文档写入这一形态的必然产物,补一处
  仍会在下一个写入路径重现;它治的是症状。
- **B. 配置整体作为一行 JSON 存进数据库** —— 被否决。它解决了路径与并发,却把读改写原样搬进了库里:
  仍是整块读、整块写,仍需要反覆盖合并,152 个工作区的规模问题也一点没变。
- **C. 细粒度 KV:一字段一行,按作用域分表。** **采纳。**
- **D. 每个设置类型建专用列式表** —— 被否决。设置字段增删频繁,列式表意味着每加一个开关就要一次
  schema 迁移;而这些字段的读写形态高度一致,不值得为它们各自造一张表。

## Decision

- **配置只有 `c3.db` 一处事实源。** 六张表:`workspaces` (工作区身份) 与五张形态一致的配置表
  (`system_configs` / `workspace_configs` / `personalized_configs` / `session_configs` /
  `mcp_api_keys`)。
- **一字段一行。** `config_key` 是点分字段路径,`config_type ∈ {string, number, boolean, json,
secret}` 说明值怎么解码。只有「多值且无稳定身份」的子树才整体落 JSON;有稳定 id 的记录集合以 id
  作为一段展开 (`agents.<id>.vendor`),另存一条 `_order` 行保序。
- **`secret` 是一个类型而不是一种约定。** agent apiKey、auth 口令哈希、MCP 密钥摘要以
  `config_type='secret'` 落库,值仍是既有的 `c3secretv1:` 密文;哪些行是密文由类型直接回答,不必再去
  猜值的前缀。
- **`--db <path>` 是唯一能搬走整个实例的覆盖项。** c3 home 目录 (日志、worktree、sandbox 分发) 跟随
  数据库文件所在目录。`--settings` 保留但标记 deprecated,只用于指定要导入的旧文件。
- **旧文件一次性导入后弃用。** 三条 `schema_migrations` 标记各自幂等,数据与标记同事务。导入**只由
  启动中的服务端触发**;旧文件在事务提交后重命名为 `<name>.migrated-<epoch>`。
- **跨进程原子性交给 SQLite。** 配置侧不再使用 `withFileLock`;`writeAtomic` / `readJsonFile` 仅
  vendor manifest 仍在用。

## Consequences

- 保存工作区配置与保存系统设置在存储层不再相交,第 2 类缺陷连同它所需要的补救逻辑一起消失。这不是
  修好了一个 bug,而是让这一类 bug 不再有产生的位置。
- e2e 隔离从「两个覆盖」变成一个 `--db`。隔离服务器的种子改为从真实库只读复制配置表 (剥离 `auth.*`),
  并预先盖上三条导入标记——否则一个隔离服务器会去读、并弃用开发者真实的 `settings.json`。
- 读路径不得隐式触发导入。任何只是读一下设置的进程 (单测、一次性脚本) 若能触发导入,就会改写并重命名
  用户的真实文件;导入的触发点因此收在 `startServer` 一处。
- 工作区从列表移除只置 `registered=0`。删行会让其配置成为孤儿,重新添加同一目录还会换一个新 id——
  用户看到的就是「设置莫名回到默认」。
- 数据库不可用时,配置读退化为默认值、写抛错。此前文件不可读时也是同样的降级方向,但现在失败面更集中:
  一个文件打不开,整套配置一起不可用。这是单一事实源的代价,已被 WAL + 打开失败即显式报错覆盖。
- `PersistedState` 的 v1→v2 迁移逻辑从运行时读路径移入一次性导入。运行时不再理解 v1 形状。

## Compliance

- 新配置字段落在 `kernel/config/config-schema.ts` 的规则表里,不新增表、不新增迁移。
- 任何配置读写都经 `config-store.ts` 的作用域原语,不直接写 SQL。
- `config_type='secret'` 的写入必须经 codec;任何位置不得把明文密钥写进 `config_value`。
- e2e 与单测必须指向一次性数据库 (`useConfigDb` / `--db`),不得依赖真实 `~/.c3`。

## References

- `database/config/*.sql`、`database/migrate/2026/08/12/038-config-tables.sql`
- `doc/domains/settings/settings-overview.md`、`doc/shared/data-conventions/persistence.md`
- ADR-0035 (`schema_migrations` 迁移标记表)
