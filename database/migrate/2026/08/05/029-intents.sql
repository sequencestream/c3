-- intents 新增 spec_status — spec 文档状态三态化 (raw / pending / approved)
--
-- 运行时迁移由 server/src/features/intents/store.ts 的 schema ensure 幂等执行
-- (`PRAGMA table_info` 列存在性检查 + ALTER TABLE ADD COLUMN + 一次性回填)，可重复执行；
-- 从不 DROP。SCHEMA_VERSION v17 → v18。
--
-- 为什么加这一列：此前「spec 是否待批准」由 spec_path 是否存在 + spec_approved 组合推断。
-- write_spec 播种 seed 文件时会立刻回填 spec_path，于是一份内容还是占位的文档就被判成
-- 「已写好但尚未批准」——UI 弹待批准提示、action descriptor 产出 spec_awaiting_approval、
-- 队列据此阻塞并对占位内容发起 spec_review。spec_status 把「尚未撰写」与「待批准」分开，
-- 成为闸门与提示的唯一事实源。
--
-- 状态语义：
--   raw      无 spec，或仅有服务端播种的 seed；不算待批准，不可审核、不可批准，不产生阻塞。
--   pending  文档已有偏离 seed 的真实内容且未批准；唯一可发起审核、可批准、渲染待批准提示的状态。
--   approved 当前文档已通过人工或 opt-in 机器批准；SDD 开发准入以此为权威条件。
--
-- 状态迁移只发生在受控的写入边界：write_spec 播种 → raw；spec 编写运行结束时比对该轮启动前
-- 记录的内容指纹，内容确实变化才 raw → pending（批准后的改写同理回到 pending）；
-- update_spec_content 人工行内编辑 → pending；approve_spec / 机器批准 → approved；
-- revoke_spec_approval → pending。不以是否包含 `_(to be authored)_` 之类的文案判定状态，
-- 真实 spec 可以合法包含该文本；不可读、未改动或写入失败一律保持原状态。
--
-- 兼容字段：spec_approved / spec_approve_user 的对外形状不变，与 spec_status 在同一事务内双写
-- (approved ⇔ spec_approved=1 且保留批准人；raw/pending ⇔ spec_approved=0 且无批准人)。
-- 读路径以 spec_status 为准，兼容布尔不构成第二条可绕过的准入路径。
--
-- 存量回填（保守，一次性）：
--   spec_approved=1                        → 'approved'
--   spec_approved=0 且 spec_path IS NOT NULL → 'pending'
--   其余（无 spec_path 且未批准）             → 'raw'
-- 存量占位文件无法可靠区分「seed 后从未真实撰写」与「已撰写未批准」，因此有路径且未批准的一律
-- 维持既有待批准语义，不扫描文件内容纠正为 raw；raw 的修复只对新建 spec 生效。

ALTER TABLE intents ADD COLUMN spec_status TEXT NOT NULL DEFAULT 'raw'
  CHECK(spec_status IN ('raw','pending','approved'));

UPDATE intents
   SET spec_status = CASE
         WHEN spec_approved = 1 THEN 'approved'
         WHEN spec_path IS NOT NULL THEN 'pending'
         ELSE 'raw'
       END;
