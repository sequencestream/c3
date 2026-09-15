-- 模型提供方测速：一次运行的头记录 (只增)
--
-- 与 `model_provider_speed_test_requests` 配对：本表一行 = 一次测速，明细表按
-- `(run_id, sequence)` 存这次运行发出的每一个请求。写入只发生在收束时，且头行与全部明细
-- 在同一事务内落定 —— 一次运行花的真金白银，它的记录不能是「有头无尾」的半截事实。
--
-- 只增不改不删：没有任何 UPDATE/DELETE 路径。记录是「当时测出来是什么样」的证据，后来的
-- 改名、暂停、删除提供方都不改写它，纠正只能靠再跑一次新的。
--
-- provider_id 是**弱引用**：无外键、无级联、读时不 JOIN 配置。删除一条提供方绝不能连带
-- 删掉它跑出来的历史，所以展示名在开始时快照进 provider_display_name；配置没了就回退到快照，
-- 再不行回退到 id。新建一条恰好重名的提供方不会继承任何东西 —— 身份是 id。
--
-- summary_json 存整份汇总 (含 ttft/tpot/endToEnd 三段分布与各速率)。列式拆开只会让它随
-- 指标定义变化而反复改表，而这份 JSON 是「按当时的公式算出来的」，跟着校准版本一起读即可。
-- 计数字段另存为列，使台账页与候选列表的聚合查询不必解析 JSON。
--
-- 无 PRAGMA user_version：本模块不启用以判定迁移 (全局共享整数，见 database/tables.md
-- infra 一节)，建表由 store 惰性 CREATE TABLE IF NOT EXISTS 覆盖新库与旧库。

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

-- 历史按 provider 分页倒序读。排序列带上 run_id：同一毫秒收束的两轮若要一个稳定次序，
-- 只按 started_at 排会让其中一条在翻页时重复出现或永远读不到。
CREATE INDEX IF NOT EXISTS idx_speed_test_provider_recent
  ON model_provider_speed_tests(provider_id, started_at DESC, run_id DESC);
