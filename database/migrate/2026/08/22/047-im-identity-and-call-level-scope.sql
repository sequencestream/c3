-- IM 身份绑定与调用级作用域: 挑战 / 绑定 / 群白名单 / 审计 + Conversation 主键升级。
--
-- 建表与幂等收敛由 identity-store.ts / robot-store.ts 的 ensureSchema 执行; 本文件是变更记录。
-- 一次性标记: schema_migrations `robots.identity_scope.v1` (与会话表重建同事务)。
--
-- 安全切断: 旧四维 im_robot_threads / Context Turn 正文不复制到新主键; 审计行保留并迁入
-- 扩展 outcome CHECK 的新 im_robot_turns。

-- 见 database/robots/im_identity_*.sql 与更新后的 im_robot_threads.sql / im_robot_context_turns.sql / im_robot_turns.sql
