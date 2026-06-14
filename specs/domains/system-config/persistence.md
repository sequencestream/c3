# system-config: 持久化（唯一写入路径 + 双层锁）

> 2026-06-08-003 引入。`~/.c3/settings.json` 的全部写入收敛到一个并发安全的公共模块，
> 根治三类 bug：进程内丢更新、跨进程覆盖、覆盖式清空（“重启后项目配置消失”）。

## 唯一写入路径

`settings.json` 的所有写入必须经过 `server/src/kernel/config/store.ts` 暴露的锁包装
（`withFileLock`），不得再各自直接 `writeAtomic` 写 `settings.json`。当前三个写入点：

| 写入点                              | 行为                                                                  |
| ----------------------------------- | --------------------------------------------------------------------- |
| `saveSettings(next)`                | 系统配置整体保存（agent/语言/时区等）                                 |
| `saveWorkspaceSetting(path, cfg)`   | 单个工作区设置写入                                                    |
| `loadWorkspaceSetting` 迁移回写分支 | 旧全局默认值一次性 seed 到 per-project（经 `saveSettings`，非嵌套锁） |

> `state.json`（ADR-0015 的 session→agent 绑定）是独立文件、单进程语义，**不**纳入此锁，
> 仅共用 store 的 `writeAtomic`。

## 双层锁模型

1. **进程内串行**：整条 settings 写链路是同步代码、无 `await` 切点，JS 单线程同步执行已天然
   串行化本进程写入（强于 async mutex）。仍统一收口到单一入口，使该不变量是结构性的、非偶然的。
2. **跨进程文件锁**：基于原子 `mkdirSync` 的目录锁（`${file}.lock/`，零依赖、跨平台）。
   `mkdirSync`（不带 `recursive`）在目录已存在时抛 `EEXIST`，即原子 test-and-set，守护
   多 c3 实例（不同 `--workspace`）对同一文件的 read-modify-write **序列**。

## 写前持锁重读磁盘（不信任内存缓存）

每次写入：**持锁 → 重读磁盘 raw（绕过 `settingsCache`，磁盘为权威）→ 合并 → normalize →
原子写 → 用写盘结果刷新 `settingsCache` → 释放锁**。
内存 `settingsCache` 可能因别进程刚落盘而陈旧，因此写入绝不以缓存为基准合并。

## 合并而非覆盖（save_settings 不得清空项目级配置）

写入时对**未携带**的字段保留磁盘已有值：

- `projectConfigs`：`saveSettings` 中 `undefined ⇒ 保留磁盘整张表`；显式传入 ⇒ 逐项浅合并
  `{...disk, ...next}`（别进程新增的项目存活，`next` 的显式项覆盖）。`saveWorkspaceSetting`
  只写入目标 `path` 单键，兄弟项目（含别进程刚加的）原样保留。
- `degradationChain` / `socketAutoResume`：`undefined ⇒ 保留磁盘；显式 ⇒ 用传入值`。

这是杜绝 `save_settings` 清空项目配置的服务端硬规则。**第二层防御在前端**：`SettingsPanel`
重建 draft 时保留全部服务端字段（含 `projectConfigs/degradationChain/socketAutoResume`），
保存不丢字段。

## 锁健壮性

- **超时** `SETTINGS_LOCK_TIMEOUT_MS`（默认 5s）、退避 `SETTINGS_LOCK_RETRY_MS`（默认 25ms，
  用 `Atomics.wait` 同步 sleep，不空转 CPU）。
- **陈旧锁回收**：持锁方崩溃残留的锁，按锁内 `meta.json` 的 `ts`（或目录 mtime）判定超过
  `SETTINGS_LOCK_STALE_MS`（默认 30s）即回收后重试。
- **降级兜底（绝不静默丢写）**：拿锁超时 ⇒ `console.error` 大声告警并**仍执行写入**
  （best-effort），仅退化跨进程原子保证，不丢数据；且不删除别进程持有的锁。

## 不变量

- settings.json 任一写入都经 `withFileLock`；不存在绕过锁的 `settings.json` 直写。
- 写入以磁盘为权威重读合并，不以陈旧 `settingsCache` 为基准。
- 未携带字段保留磁盘值；`save_settings` 永不清空 `projectConfigs`。
- 拿锁失败不静默丢写。
