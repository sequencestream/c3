# memory — 设计

行为契约见 [memory-spec.md](memory-spec.md);实体见 [memory-models.md](memory-models.md)。

## 分层

两个入口通向同一个 store:模型走 MCP 读写,人走 WebSocket 看与删。

```
work session (claude / codex / cursor)      浏览器 (工作区设置 · 记忆 Tab)
        │  MCP over loopback HTTP                   │  WebSocket
        ▼                                           ▼
transport/event-mcp                         features/memory/handlers
  per-run token、回环守卫、工具注册            工作区解析、摘要投影、拒绝映射为 UiError
  enabledTools 派生                                 │
        │  注入的 tools 回调                        │
        ▼                                           │
features/memory/tool-defs                           │
  zod 入参、工具描述、两个核心 handler              │
        │                                           │
        └───────────────┬───────────────────────────┘
                        ▼
features/memory/store      ── 隔离、校验、去重、生命周期、SQLite 可用性降级
        │                        └─ features/memory/content-guard ── 集中的拒绝规则
        ▼
kernel/infra/db            ── 单文件 SQLite ~/.c3/c3.db
```

`features/memory/janitor` 挂在 store 旁边,由自己的进程内定时器驱动,不经过上面任何一条入口。

浏览器一侧只用到 `listActiveMemories` 与 `deleteMemory`,不新增任何存储语义:删除按钮触发的就是
`memory_write { op:'delete' }` 走的那一个函数。

## 文件

| 文件                                          | 职责                                                                    |
| --------------------------------------------- | ----------------------------------------------------------------------- |
| `server/src/features/memory/store.ts`         | 表与索引的惰性收敛、校验、归一化去重、生命周期写入、检索                |
| `server/src/features/memory/content-guard.ts` | 凭据形状与产物形状的集中拒绝规则 + 安全的拒绝文案                       |
| `server/src/features/memory/tool-defs.ts`     | 两个工具的 zod 入参、描述与核心 handler(框架无关)                       |
| `server/src/features/memory/handlers.ts`      | 设置页两条消息的 handler:工作区解析、摘要投影、store 拒绝映射为 UiError |
| `shared/src/protocol/memory.ts`               | 公共模型:两个闭集与 `WorkspaceMemoryListItem`(闭集的单一数据源)         |
| `shared/src/protocol/memory-messages.ts`      | 设置页四条消息的 arm 类型(不进公共导出面)                               |
| `server/src/features/memory/janitor.ts`       | 规则型清理:重复修复 + 失效行延迟物理删除;独立定时器,可注入时钟          |
| `server/src/transport/event-mcp/index.ts`     | work session 工具表(三个工具)、注册与 `enabledTools` 派生               |
| `server/src/kernel/permission/tools.ts`       | 两个工具的全限定名 + 免确认集合 `AUTO_ALLOWED_C3_TOOLS`                 |
| `server/src/kernel/run/run-lifecycle.ts`      | `sessionKind === 'work'` 正向选中 work session MCP profile              |
| `server/src/server.ts`                        | 组合根:作用域派生、工具注入、janitor 启停                               |

## SQLite 层

单表 `workspace_memories`,列级语义见
[`database/memory/workspace_memories.sql`](../../../../database/memory/workspace_memories.sql)。

**惰性收敛。**`ensureSchema` 先 `CREATE TABLE IF NOT EXISTS`,再按 `PRAGMA table_info` 逐列补齐
`subject` / `superseded_by` / `title_key`,最后建索引。索引在补列**之后**建,否则半初始化的库会在
「索引引用一个还不存在的列」上失败,整个 store 降级为不可用。补出 `title_key` 时立即按存储的 `title`
回填,使去重在不是由一串完整 store 调用产生的库上依然正确。

schema 就绪标记挂在**连接对象**上而非布尔量:`resetDbForTests` 会换一个指向新文件的连接,布尔量会
谎称那里也建好了表。

**`title_key` 是派生比较键。**它保存归一化后的 title,存在的唯一理由是让同名去重与 janitor 的修复
成为索引点查,而不是每次写入都要应用层重算的全表扫描。它不属于领域模型,`WorkspaceMemory` 不暴露它。

**三条索引各有用途。**`(workspace_name, status, updated_at DESC)` 服务目录与检索;
`(workspace_name, title_key, status)` 服务去重点查;`(status, updated_at)` 服务 janitor 的失效行扫描。

**事务。**每次写入(容量计数 + 插入 / 覆盖)在同一事务内,因此同进程并发写不会双双越过 500 行上限。
janitor 的一次 sweep 也是单事务。

**降级。**`getDb()` 不可用时读返回空、写抛 `MemoryStoreError('db_unavailable')`。这条抛错一路传到工具
层变成 `isError`,失败的写入不会得到成功回执。

## 工具接线

`transport/event-mcp` 持有一张 `TOOL_DEFS` 表,注册与 `enabledTools` **同源派生**:

```ts
const TOOL_DEFS = [publish_event, memory_search, memory_write]
export const EVENT_MCP_TOOL_NAMES = TOOL_DEFS.map((t) => t.name)
```

这不是风格选择。Codex 把 `enabledTools` 里的每个名字标记为 required/approved 并**静默禁用**未列出的
工具,一份手维护的第二名单只会在一个 vendor 上失效,且现象是「工具凭空消失」而不是报错。测试对
`listTools()` 与 `enabledTools` 做精确相等断言,把这条约束钉住。

**作用域在组合根派生**,不在传输层也不在 store:

```ts
const memoryScope = (binding) => ({
  workspaceName: workspaceNameFor(binding.workspacePath),
  sessionId: binding.getRunId(),
})
```

`workspaceNameFor` 把 run 绑定的路径换成不可变的持久化身份;`getRunId` 是取值函数,因此
pending→real 重绑后写入归因到真实会话。传输层因此保持纯管道,不反向依赖任何 store。

## Run 生命周期接线

```ts
const isWork = rt.sessionKind === 'work'
const resolvedSessionProfile =
  isWork && deps.sessionProfile ? deps.sessionProfile(workspacePath) : undefined
```

正向谓词是安全属性:写成「其它 profile 都没匹配」会让每一个将来新增的 session kind 默认继承记忆工具,
首当其冲的是讨论 agent。claude 路径与 driver 路径(codex / cursor)消费同一个 `resolvedSessionProfile`,
所以三个 vendor 的工具面不可能分叉。

## 权限门接线

`AUTO_ALLOWED_C3_TOOLS = { publish_event, memory_search, memory_write }`,在 `createCanUseTool` 的最前面
统一放行,早于任何 gate 分支。放行是「已绑定的工具不需要对话框」的判断,**不是**让工具可达的判断——
可达性由上面的 profile 选择独立决定。

## Janitor

独立的进程内定时器(启动延迟 90s,此后固定 24h 一次),与 agent 无关,与 session-cleanup 的开关无关。
一次 sweep 在单事务内按顺序执行两条规则:

1. **重复修复。**取所有未 `superseded` 行,按 `(workspace_name, title_key, updated_at DESC, id DESC)`
   排序后线性扫描:每组首行为留下者,其余标 `superseded`、`superseded_by` 指向留下者、`updated_at`
   置为当前时刻(回收期由「成为失效行的那一刻」起算)。平局按 id 降序,因此两次 sweep 结论一致。
   普通写入本就去重,这条规则是为**不由一串完整 store 调用产生**的库准备的:半写入的表、外部工具
   检视过的文件。
2. **延迟物理删除。**删除 `status IN ('superseded','deleted')` 且 `updated_at <= now - 30 天` 的行,
   随后清空指向已删除目标的 `superseded_by`(它是恢复线索,不是外键)。规则 1 刚标记的行 `updated_at`
   等于当前时刻,不会在同一次 sweep 被删。

时钟通过 `runMemorySweepOnce({ now })` 注入。整个 sweep 永不抛出:崩掉的 sweep 只是把失效行多留一天,
比提前删除安全得多,下一次定时器 tick 会重试。
