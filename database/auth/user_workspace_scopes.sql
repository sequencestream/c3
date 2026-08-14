-- user_workspace_scopes — 账号可访问哪些工作区 (管理员配置的授权状态)
-- 所属模块: auth
-- 对应 Store: server/src/features/auth/scope-store.ts
-- 迁移: migrate/2026/08/14/040-user-workspace-scopes.sql
--
-- 默认拒绝: 没有行 = 该 subject 一个工作区也到不了。这是本表存在的理由 —— 「无记录即
-- 全部」会让一次漏配变成全量放行。
--
-- 只有两个 subject 不走本表: 已配置的管理员, 以及无认证部署合成的 local 主体。两者在
-- resolver 里是显式分支而非行, 管理员因此无法把自己锁在外面。
--
-- 与 personalized_configs 判断标准相反: 那张表是用户自管的偏好, 本表是管理员管、被约束
-- 者只读的授权。共用一张表就会把「可以自己改」和「绝不能自己改」压在同一条写路径上。
--
-- 明细行拆在 user_workspace_scope_items: mode='selected' 且零条明细表示「选定了, 但一个
-- 都没选」, 与「压根没配」是两个状态, 单列列表表达不了。

CREATE TABLE IF NOT EXISTS user_workspace_scopes (
  subject    TEXT PRIMARY KEY,  -- 账号身份 (basic 的 username), 去首尾空白后区分大小写
  mode       TEXT NOT NULL      -- all=跟随注册表 (新注册的工作区自动纳入) / selected=固定名单
             CHECK(mode IN ('all','selected')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
