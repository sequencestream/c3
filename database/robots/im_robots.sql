-- im_robots — IM 聊天机器人配置 (执行身份 + 预设权限 + 响应面 + 外发授权)
-- 所属模块: robots
-- 对应 Store: server/src/features/im/robot-store.ts
-- 迁移: migrate/2026/08/20/044-im-robots.sql
--
-- 存在理由: 让 c3 的 agent 能力延伸到办公 IM —— 群里 @机器人 提问, c3 跑一轮会话把答案发回群里。
-- 这是 c3 唯一一条主动把 agent 产出送往第三方云的路径, 其授权模型由 ADR-0046 裁定, 本表是该裁决
-- 的落点: 四条授权凭据里有三条 (默认关闭、启用前确认、响应面收敛) 直接是这里的列。
--
-- 不绑工作区。本表刻意没有 workspace_name 列 —— 机器人是 c3 部署级 IM 出入口, 配置/连接/名册
-- 跨工作区一致, 但不等于无边界访问。运行目录 ~/.c3/robots/<name>/ 是隔离的工作容器, 不是授权范围
-- 或默认工作区; 涉及 c3 对象的能力须在每次工具调用时按调用者与可见范围重新求交。name 同时是显示名、
-- 目录名和身份, 受路径安全约束 (^[a-z0-9][a-z0-9_-]{0,31}$) 且创建后不可改 —— 改名等于换一个
-- 机器人, 已有线程的会话历史会随之失去归属。否决「每工作区一个机器人」与「连接/线程固定工作区」。
--
-- 默认关闭是结构性的。enabled 默认 0, 且没有「创建并启用」的一步操作: 启用永远是一次独立的、
-- 事后的决定。outbound_ack_at 记录用户确认「知晓哪些内容会被发往第三方云」的时刻, 服务端在启用时
-- 校验它 —— 前端少弹一个确认框不能让机器人通过。两者缺一, 本表就不再是 ADR-0046 的合规凭据。
--
-- 权限是预设的, 不是现场问的。群里没有人能回答权限对话框, 所以机器人的工具面在配置时冻结:
-- tool_allowlist 为空 (创建时的默认) 即只读, 写/执行能力必须由管理员显式列举。mode 与 automation
-- 同口径, 用于向下游 vendor 表达动作模式。
--
-- 连接状态不在这里。状态不是配置 —— 连上没有、重连第几次、上次为什么失败, 全部是进程内的运行时
-- 事实, 由 supervisor 持有并随查询回传, 重启后重新建立。把它落库只会产生一份必然过期的快照。

CREATE TABLE IF NOT EXISTS im_robots (
  id               TEXT PRIMARY KEY,   -- uuid
  name             TEXT NOT NULL,      -- 机器人名, 同时是工作目录名; 全局唯一, 创建后不可改
  platform         TEXT NOT NULL       -- IM 平台; 新增平台在 registry 加一行实现即可, 不改本约束以外的分支
                   CHECK(platform IN ('feishu')),
  app_id           TEXT NOT NULL,      -- 平台应用 ID (非机密, 明文)
  app_secret       TEXT NOT NULL       -- 平台应用密钥, encryption.ts 的 c3secretv1: 密文; 永不出现在线上/日志
                   DEFAULT '',
  vendor           TEXT NOT NULL,      -- 执行 vendor (claude/codex/cursor)
  agent_id         TEXT NOT NULL,      -- 真实 agent id, 或 _c3_<vendor>_<group> 组引用 (每轮重解析以支持 failover)
  mode             TEXT NOT NULL       -- 预设动作模式, 与 automations.mode 同口径
                   DEFAULT '',
  tool_allowlist   TEXT NOT NULL       -- JSON 数组: 显式放开的写/执行类工具; 空数组 = 只读 (默认)
                   DEFAULT '[]',
  require_mention  INTEGER NOT NULL    -- 1 = 群消息必须 @机器人 才响应 (默认); 0 = 群内任意消息都响应
                   DEFAULT 1,
  chat_allowlist   TEXT NOT NULL       -- JSON 数组: 允许的群 id; 空数组 = 不限群
                   DEFAULT '[]',
  dm_mode          TEXT NOT NULL       -- 单聊策略: disabled=不响应 (默认) / allowlist=仅名单内 / open=都响应
                   DEFAULT 'disabled'
                   CHECK(dm_mode IN ('disabled','allowlist','open')),
  dm_allowlist     TEXT NOT NULL       -- JSON 数组: dm_mode=allowlist 时允许发起单聊的用户 id
                   DEFAULT '[]',
  max_turn_ms      INTEGER,            -- 单回合墙钟上限 (ms); NULL = 用默认值
  enabled          INTEGER NOT NULL    -- 0 = 停用 (创建时的默认, ADR-0046 要求); 1 = 已授权外发并连接
                   DEFAULT 0,
  outbound_ack_at  INTEGER,            -- 用户确认外发内容范围的时刻 (epoch ms); 为空则拒绝启用
  locale           TEXT                -- 注册表文案语言; NULL = 系统默认 (en); 仅影响固定控制提示
                   CHECK(locale IS NULL OR locale IN ('en','zh','ja','ko','ru')),
  created_at       INTEGER NOT NULL,   -- epoch ms
  updated_at       INTEGER NOT NULL    -- epoch ms
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_im_robot_name ON im_robots(name);
CREATE INDEX IF NOT EXISTS idx_im_robot_enabled ON im_robots(enabled);
