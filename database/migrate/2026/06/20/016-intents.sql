-- 016 — intents 新增 PR 可跳转链接列
-- 日期: 2026-06-20
-- 影响 store / 版本跨度:
--   intents  v13 → v14
--
-- 背景: 手动 Start Dev 开发会话结束后自动收尾 Git/PR。意图此前已有
-- branch_name / latest_commit_hash / pr_id / pr_status 四个 Git 跟踪字段,
-- 唯独缺少「PR 可跳转链接」。本意图补齐 pr_url 并贯通存储/协议/界面,使工作台
-- 在收尾后可直接点开 PR。
--   - pr_url : PR 的 web 链接 (如 GitHub PR URL)。与 latest_commit_hash 语义不重复,
--              不新增任何与最新提交哈希重复的 commit_hash 字段。可空,历史行保持 NULL。
--
-- 迁移由 store 的 ensureColumn(d, 'intents', 'pr_url', 'TEXT') 在 exec(SCHEMA)
-- 之后执行,幂等且可重入(以 PRAGMA table_info 守卫,缺列才 ADD)。从不 DROP、
-- 不丢数据。下面的等价 DDL 仅作记录,真实迁移在 store.ts 中以幂等守卫执行。

ALTER TABLE intents ADD COLUMN pr_url TEXT;
