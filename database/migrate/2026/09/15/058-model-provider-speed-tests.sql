-- 058 — 新增模型提供方测速的两张表 model_provider_speed_tests / model_provider_speed_test_requests
-- 对应 DDL: database/config/model_provider_speed_tests.sql
--           database/config/model_provider_speed_test_requests.sql
-- 实际迁移逻辑在 settings/speed-test store 的惰性 schema ensure
-- (CREATE TABLE/INDEX IF NOT EXISTS, 可重复执行)。
--
-- 背景: 系统设置里每条模型提供方新增「测速」——向已保存的端点发真实流式生成,量 TTFT /
-- 端到端 / TPOT / 吞吐,并把结果留成可回看的单提供方报告。这要落库,理由不是「顺手存一下」:
-- 一次测速消耗真实额度与 token,结论必须能被复查,而内存里的数字在进程重启后就没了。
--
-- 两张表: 头记录 (一次运行一行, 计数字段 + summary_json 汇总) 与逐请求明细
-- (run_id + sequence 主键)。头行与全部明细在**同一事务**内落定,不存在半截事实。
--
-- 只增不改不删: 没有任何 UPDATE/DELETE 路径。记录是「当时测出来是什么样」的证据,后来的
-- 改名/暂停/删除提供方都不改写它,纠正只能靠再跑一次新的。
--
-- provider_id 是弱引用: 无外键、无级联、读时不 JOIN 配置。删除一条提供方绝不连带删掉它的
-- 历史,故展示名在开始时快照进 provider_display_name; 配置没了回退快照、再回退 id。
-- 新建一条恰好重名的提供方不继承任何东西——身份是 id。
--
-- 不持久化进行中的进度: 进度帧只在执行器内存里,收束时才写一次。代价写在明处——运行中崩溃
-- 会丢掉那批内存样本,不承诺断点续跑; 已提交的历史不受影响。
--
-- 兼容性: 纯新增两张表与一个索引,不改动任何既有表/列。无存量数据可回填,上线前的测速记录
-- 为空。不回填、无 schema_migrations 标记 (仅有建表,没有需要判定「做没做完」的数据迁移)。
--
-- 注意: 该模块未启用 PRAGMA user_version 作判定 (全局共享整数,见 database/tables.md infra 一节);
-- 惰性 ensure 用 IF NOT EXISTS 同时覆盖新库与旧库,建表后即可读写。

CREATE TABLE IF NOT EXISTS model_provider_speed_tests (
  run_id                TEXT    PRIMARY KEY,
  provider_id           TEXT    NOT NULL,
  provider_display_name TEXT    NOT NULL,
  started_at            INTEGER NOT NULL,
  finished_at           INTEGER NOT NULL,
  planned_count         INTEGER NOT NULL,
  completed_count       INTEGER NOT NULL,
  success_count         INTEGER NOT NULL,
  failure_count         INTEGER NOT NULL,
  cancelled_count       INTEGER NOT NULL,
  protocol_type         TEXT    NOT NULL CHECK(protocol_type IN ('openai','anthropic')),
  api_dialect           TEXT    NOT NULL CHECK(api_dialect IN ('chat','responses','messages')),
  model                 TEXT    NOT NULL,
  calibration_version   TEXT    NOT NULL,
  max_output_tokens     INTEGER NOT NULL,
  temperature           REAL    NOT NULL,
  outcome               TEXT    NOT NULL CHECK(outcome IN ('completed','failed','interrupted')),
  summary_json          TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS model_provider_speed_test_requests (
  run_id             TEXT    NOT NULL,
  sequence           INTEGER NOT NULL,
  started_at         INTEGER NOT NULL,
  outcome            TEXT    NOT NULL CHECK(outcome IN ('success','failure','cancelled')),
  failure_category   TEXT    CHECK(failure_category IS NULL OR failure_category IN ('timeout','http','network','stream')),
  http_status        INTEGER,
  ttft_ms            REAL,
  end_to_end_ms      REAL,
  output_tokens      INTEGER,
  token_count_source TEXT    CHECK(token_count_source IS NULL OR token_count_source IN ('usage','delta_estimate')),
  tpot_ms            REAL,
  PRIMARY KEY (run_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_speed_test_provider_recent
  ON model_provider_speed_tests(provider_id, started_at DESC, run_id DESC);
