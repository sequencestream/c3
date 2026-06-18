-- 013 — intents 新增 short_en_title 列
-- 日期: 2026-06-18
-- 影响 store / 版本跨度:
--   intents (intents)  v11 → v12
--
-- 背景: 现有意图标题多为中文,无法直接、安全地用作 Git 分支名 / worktree 目录名 (ASCII slug)。
-- 新增简短英文标题 short_en_title 作为派生分支/worktree 命名的稳定来源。
--   - 文档标注 VARCHAR(128),SQLite 实际为 TEXT (不强制长度),写入侧 (store.upsertIntents/
--     insertIntents) 落库前若 > 128 字符则截断到 128。
--   - 列允许 NULL 以容纳历史行;历史行保持 NULL 不回填,仅在被 refine (带 id 更新) 时补齐。
--   - required 仅在 save_intents 的 zod 入参层强制 (新建/更新都要求 agent 传)。
--   - 本意图只做「字段落库 + save_intents 存储」,不改造分支/worktree 命名逻辑去消费该字段。
--
-- 迁移由 store 的 ensureColumn(d, 'intents', 'short_en_title', 'TEXT') 在 exec(SCHEMA)
-- 之后执行,幂等且可重入 (以 PRAGMA table_info 守卫,缺列才 ADD)。从不 DROP。
-- 下面的等价 DDL 仅作记录,真实迁移在 store.ts 中以幂等守卫执行。

ALTER TABLE intents ADD COLUMN short_en_title TEXT;
