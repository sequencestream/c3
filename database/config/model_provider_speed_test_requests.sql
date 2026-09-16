-- 模型提供方测速：逐请求样本明细 (只增)
--
-- 一次运行发出的每个请求一行，`sequence` 从 1 开始、在运行内唯一，与头表
-- `model_provider_speed_tests.run_id` 组成主键。明细与头行在同一事务内写入，因此不存在
-- 「头行说跑了 10 次、明细只有 3 行」的中间态。
--
-- 只记**已发出的**请求：计划了但因中断没拨出去的次数不落行 —— 补一行假的「取消」会让
-- 明细表的行数与真实发生的上游调用对不上，而这张表存在的意义正是「花了多少次钱」。
--
-- 失败行保留它侥幸观测到的值 (文本先到、流随后断的请求仍有 ttft_ms)，这些值只在明细里
-- 展示，绝不进入任何聚合延迟统计。
--
-- 时长为 NULL 的含义各不相同，读侧不可一律当 0：
--   ttft_ms       NULL = 自始至终没有收到过任何非空文本增量
--   end_to_end_ms NULL = 该请求被中断取消 (唯一一种没有自然终点的情形)
--   tpot_ms       NULL = 非成功请求，或成功但输出 token 不足 2 (首 token 的成本已计入 TTFT，
--                  分母用 output_tokens 会重复计算；单 token 响应也没有可言的「间隔」)
-- token_count_source 说明 output_tokens 的来源：usage = 上游终局用量，delta_estimate = 按
-- 非空文本增量事件数估算 (一个增量可能含多个 token，误差可能很大，报告上会挂标记)。
-- observed_model 保存上游流中声明的模型；未声明时为 NULL，不以请求模型回填。
--
-- 外键关系同头表：run_id 指向本地记录，provider 侧不设外键 (弱引用，见头表注释)。

CREATE TABLE IF NOT EXISTS model_provider_speed_test_requests (
  run_id             TEXT    NOT NULL,
  sequence           INTEGER NOT NULL,
  started_at         INTEGER NOT NULL,
  outcome            TEXT    NOT NULL CHECK(outcome IN ('success','failure','cancelled')),
  failure_category   TEXT    CHECK(failure_category IS NULL OR failure_category IN ('timeout','http','network','stream')),
  http_status        INTEGER,
  observed_model     TEXT,
  ttft_ms            REAL,
  end_to_end_ms      REAL,
  output_tokens      INTEGER,
  token_count_source TEXT    CHECK(token_count_source IS NULL OR token_count_source IN ('usage','delta_estimate')),
  tpot_ms            REAL,
  PRIMARY KEY (run_id, sequence)
);
