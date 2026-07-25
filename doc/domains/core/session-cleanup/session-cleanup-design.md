# session-cleanup — 领域实现设计

## 1. 定位

vendor CLI 把每次会话的 transcript 落盘（codex 写 `<CODEX_HOME>/sessions/` 的 rollout，claude 写 `<CLAUDE_CONFIG_DIR>/projects/` 的 JSONL），run 结束不清理——正是这些文件让下一轮 `resume` 能续接、让 c3 能回看历史会话。代价是它们只增不减。

session-cleanup 领域提供**按保留期删除过期会话记录**的能力：一个进程级每日定时任务，把超过保留窗口的会话文件删掉。

## 2. 范围与边界

范围：系统级清理开关与保留期配置、会话存储目录的发现、按 mtime 的过期删除、定时调度。

边界：

- 不改变任何 vendor 的存储位置与目录布局——那由 sandbox 与 vendor adapter 决定（见 `doc/domains/core/sandbox/sandbox-design.md` §9）。
- 不删除会话之外的文件：vendor 配置、凭证、技能、状态库一律不动。
- 不清理 c3 自身的 SQLite 数据（会话台账、意图、讨论有各自的生命周期）。

## 3. 配置

清理是**系统级**能力，配置为 `SystemSettings.sessionCleanup`，与工作区无关，也与 sandbox 无关：

```ts
interface SessionCleanupConfig {
  enabled?: boolean // 总开关,缺省 false —— 不清理
  retentionDays?: number // 保留天数,缺省 30、最小 1
}
```

**为何是全局而非按工作区**：清理目标是 vendor 的共享 home——宿主 `~/.codex`、`~/.claude` 一处存放所有工作区的会话，无法按工作区分割。

normalize 规则：

- `enabled` 仅显式 `true` 落盘，其余（缺省 / `false` / 非布尔）一律视为关闭。默认关闭意味着未表态即不删任何东西。
- `retentionDays` 对有限正数向下取整并 clamp 到最小 1；非有限 / ≤ 0 / 非数字视为未设（读取回落默认 30）。仅当值 ≠ 默认才落盘。
- 两字段都无意义时整个配置块省略。保留期可以在关闭状态下独立保存，只是不生效。

读取入口 `getSessionCleanup()` 返回规整后的 `{ enabled, retentionDays }`。

## 4. 清理范围

**vendor 中立**：不维护 vendor 注册表，而是按各 vendor 共用的目录名约定识别会话存储——目录名为 `sessions` 或 `projects` 即视为会话目录，只清理其内部。新 vendor 沿用该约定即自动纳入，无需改代码；同级的 `config.toml`、`auth.json`、`skills/`、状态 sqlite 因不在会话目录内而不受影响。

扫描根有三处，覆盖沙箱与宿主两种运行形态：

- `~/.c3/relay/` — relay（custom）模式各 vendor 的隔离 home，全局一份。
- 宿主 codex home（`$CODEX_HOME` 或 `~/.codex`）。
- 宿主 claude 配置目录（`$CLAUDE_CONFIG_DIR` 或 `~/.claude`）。

自根向下最多 2 层查找会话目录（最深的布局是 `relay/codex/sessions`），命中即收集、不再下钻。存储不按工作区分割，因此清理不区分会话由哪个工作区产生。

## 5. 执行

单个模块级定时器随服务启动：延迟 60 秒首跑（让服务启动期让路），之后固定 24 小时周期，`setTimeout().unref()` 不阻塞退出，服务关闭时停止。开关与保留期每轮读取，改配置无需重启。

单轮 sweep：关闭即直接返回；启用则以 `now - retentionDays` 为 cutoff，递归删除会话目录内 mtime **严格早于** cutoff 的文件。只删文件、不删空目录树（空的 `sessions/YYYY/MM/DD` 无害）。

**fail-soft**：目录不可读则跳过该目录，单文件 stat/删除失败记录日志后跳过，均不中断本轮，更不会抛进服务启动路径。

## 6. 影响

被删除的会话不可再 `resume`，也不能在 c3 中回看——这正是保留期的语义。默认关闭，用户显式开启即视为已授权。
