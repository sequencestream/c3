-- intent_worknotes — 意图追加式内容历史 (work/review/fix 自由文本正文)
-- 与 intent_logs(简短操作审计) 区分:这里存「上一轮 work 做了什么 / review 发现了什么 /
-- fix 改了什么」的正文,供后续 Agent 读取前序上下文。只增不改不删,纠正通过再次追加表达。
-- 所属模块: intents
-- 对应 Store: server/src/features/intents/store.ts


CREATE TABLE IF NOT EXISTS intent_worknotes (
  id              TEXT    PRIMARY KEY,              -- uuid,服务端生成
  intent_id       TEXT    NOT NULL,                 -- 意图 ID (外键 → intents.id,须存在)
  kind            TEXT    NOT NULL CHECK(kind IN ('work','review','fix')),  -- 产生阶段
  note            TEXT    NOT NULL,                 -- 自由文本正文,原样保存(含换行与首尾空白)
  session_id      TEXT,                             -- 产生正文的会话引用,可空
  created_at      INTEGER NOT NULL                  -- 追加时间 (epoch ms)
);
CREATE INDEX IF NOT EXISTS idx_worknote_intent_created ON intent_worknotes(intent_id, created_at DESC);
