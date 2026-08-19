-- workspace_memories — 工作区长期记忆 (用户偏好 / 已验证约束 / 事实 / 教训)
-- 所属模块: memory
-- 对应 Store: server/src/features/memory/store.ts
-- 迁移: migrate/2026/08/19/043-workspace-memories.sql
--
-- 存在理由: 用户在多个 work session 里反复口头表达的偏好、验证过一次的项目约束、踩过的坑,
-- 仓库自身无法自证, 也不适合写进 CLAUDE.md (那里只承载「任何工具都能重新推导」的事实)。
-- 没有本表, 每个新 work session 都要用户把同一件事再说一遍。
--
-- 只存结论, 不存原料。本表刻意没有代码片段、命令、提示词、工具输入输出与对话转录的位置:
-- content 是一句可复述的结论, 写入时按集中的拒绝规则挡掉凭据形状与代码/工具/转录框架。
-- 记忆不是密钥库 —— 形状检测挡得住常见凭据, 挡不住任意散文。
--
-- 身份是确定性的: (workspace_name, title_key) 即一条记忆。title_key 是 title 的归一化派生键
-- (去首尾空白、折叠内部空白、Unicode 小写), 只为让去重与清理成为索引点查, 不属于领域模型。
-- 同名写入原地覆盖, 是本能力唯一的自动语义判断 —— 系统从不比较正文, 也不问 LLM 两句话是否矛盾。
-- 因此真正互相矛盾的两条必须用不同 title (可共用 subject 让分歧可发现), 两条都保持 active。
--
-- 生命周期只有三态。active 是普通检索唯一可见的状态; superseded 由去重产生并指向留下的那条;
-- deleted 由软删产生。后两者按各自的 updated_at 满 30 天才被物理删除 —— 回收期内它们仍占
-- 工作区容量, 这是刻意的取舍: 容量满时拒绝新条目, 而不是缩短可恢复性或淘汰另一条记忆。
-- active 的 preference 永不因年龄被清理。
--
-- 容量与长度是硬边界: 单条 content ≤ 2000 个 Unicode 码点, 单 workspace ≤ 500 物理行 (含全部状态)。
-- 计数与插入在同一事务内, 因此同进程并发写不会双双越过上限。超限一律显式报错, 绝不静默截断或淘汰。

CREATE TABLE IF NOT EXISTS workspace_memories (
  id                TEXT PRIMARY KEY,   -- uuid
  workspace_name    TEXT NOT NULL,      -- 归属工作区, 引用 workspaces.name; 每次读写的隔离边界
  subject           TEXT,               -- 可空归类标签; 不参与身份判定, 也不扩大可见范围
  type              TEXT NOT NULL       -- preference=用户偏好 / constraint=已验证约束 / fact=稳定事实 / lesson=教训
                    CHECK(type IN ('preference','constraint','fact','lesson')),
  title             TEXT NOT NULL,      -- 一句话标题, 原样保留用户措辞
  title_key         TEXT NOT NULL,      -- title 的归一化派生键 (去首尾空白+折叠空白+小写), 同工作区内即身份
  content           TEXT NOT NULL,      -- 结论正文, ≤ 2000 码点
  status            TEXT NOT NULL       -- active=生效 / superseded=被同名新条目取代 / deleted=已软删
                    CHECK(status IN ('active','superseded','deleted')),
  source_session_id TEXT NOT NULL,      -- 写下当前形态的 work session id (归因, 不设外键)
  created_at        INTEGER NOT NULL,   -- epoch ms; 同名覆盖时保持不变
  updated_at        INTEGER NOT NULL,   -- epoch ms; 也是 superseded/deleted 行 30 天回收期的起点
  superseded_by     TEXT                -- 去重时指向留下的那条; 目标被物理删除后置空 (恢复线索, 非外键)
);
CREATE INDEX IF NOT EXISTS idx_workspace_memory_scope
  ON workspace_memories(workspace_name, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_workspace_memory_title
  ON workspace_memories(workspace_name, title_key, status);
CREATE INDEX IF NOT EXISTS idx_workspace_memory_inactive
  ON workspace_memories(status, updated_at);
