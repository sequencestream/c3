-- 025: Add metadata to discussions (schema v5 → v6)
-- 讨论的自由形式业务 metadata (扁平 string→string, 存为 JSON 对象)。
-- 唯一写入方是 MCP start_discussion 工具 (校验复用 automation metadata 上限:
-- 最多 32 项 / key ≤64 / value ≤256); Web UI 启动与 continue_discussion 不写入。
-- 该值随 discussion:start / discussion:end 生命周期事件发出, 供自动化按业务上下文过滤。
-- 历史行经列默认值回填为空对象; 读取端对缺失/空/损坏值降级为 {}。
-- 幂等: store 以列存在性 (PRAGMA table_info) 为准增量补列, 可重复执行。

ALTER TABLE discussions ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}';
