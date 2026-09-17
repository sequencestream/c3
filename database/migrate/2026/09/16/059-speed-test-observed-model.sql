-- 059 — 保存模型提供方测速中上游响应声明的逐请求模型

ALTER TABLE model_provider_speed_test_requests ADD COLUMN observed_model TEXT;
