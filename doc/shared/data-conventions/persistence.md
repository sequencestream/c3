# 配置持久化

配置存在 `c3.db` 的 config 模块表中,一字段一行。表结构与展开规则见
[database/tables.md](../../../database/tables.md) § config。

## 作用域即写入边界

每类配置有自己的作用域,一次写入只触及一个作用域:

- 系统设置 → `system_configs`
- 每工作区设置 → `workspace_configs`,按 `workspaces.id` 分组
- 每账号个性化设置 → `personalized_configs`,按已验证身份分组
- 每会话事实 (agent 绑定 / 权限模式 / codex 策略) → `session_configs`
- MCP 密钥 → `mcp_api_keys`,按密钥 id 分组

因此保存一个工作区的设置不可能改到系统设置或另一个工作区,保存系统设置也不可能抹掉个性化设置
或 MCP 密钥——写入方无需"记得带上"它并不拥有的字段,存储层本身就不给它这个机会。

`system_configs` 另有两个不属于 `SystemSettings` 的键空间:`state.*` (活动会话、skill 挂载索引
与 ack) 与 `agentLang`。整体保存系统设置时以 `preservePrefixes` 保护它们。

## 原子性

写入在 SQLite 事务内完成 (`configTx`,可重入),数据库以 `journal_mode=WAL` +
`busy_timeout=3000` 打开。多个 c3 实例指向同一文件时,事务与 WAL 即是跨进程保证。

整体保存系统设置前先重读存储 (而非内存缓存) 并合并未携带的字段,使一次保存不会回退另一个实例
刚写入的值。

## 缓存

读路径带进程内缓存 (`loadSettings` / 个性化 / MCP 密钥 / 会话状态各一份),由本进程的写入刷新。
缓存不跨进程失效:另一个实例的写入要到下次重建缓存时才可见。

## agent apiKey 落盘加密

`config_type='secret'` 的行在磁盘上是密文,读出即解密——**内存恒明文、磁盘恒密文**。适用于
agent 的 `config.apiKey`、auth 账号口令哈希与 MCP 密钥摘要。加解密由 codec 在编解码时完成,
调用方看到的始终是明文。

密文格式 `c3secretvN:base64url(IV‖密文‖tag)`、多版本约定、懒迁移与混淆级强度见
[security](../../non-functional/security.md) § Agent apiKey at-rest encryption;原语在
`server/src/kernel/config/encryption.ts`。

## 不变量

- 配置读写一律经 `config-store.ts` 的作用域原语,不直接写 SQL。
- 一次写入只触及本作用域;未携带的键在其它作用域里不受影响。
- 整体保存以存储为权威重读合并,不以陈旧缓存为基准。
- `secret` 行永不以明文落库。
- 数据库不可用时读退化为默认值、写抛错,不静默丢写。
