# 0029 — Vendor 中立 relay 核心 + agent group failover

- **Status:** accepted
- **Date:** 2026-07-16

## Context

ADR-0014 用一个进程内 Responses→Chat 中继,让自定义 codex agent 能接只讲 Chat Completions 的第三方提供方。它把 relay 定位为 **codex 专用**:只有 codex 的 `wireApi=chat` 路径走中继,其余 vendor 直连。

三个事实推动把 relay 泛化:

1. **claude 直连注入真实 key。** `launchForAgent` 对 custom claude agent 直接把 `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` 注入 vendor 子进程 env。真实 provider key 因此下沉到子进程——在 ADR-0028 的 arapuca 进程级沙箱下,这与"凭证默认不可见"的隔离目标相悖(codex 已经用 0014 的 token 换发规避了同一暴露面,claude 尚未)。
2. **单 agent 绑死单 provider。** 一个 agent 只有一个上游;provider 限流 / 故障 / 配额耗尽时没有容错路径。
3. **接线不一致。** codex 走 relay + token,claude 走 env + 真实 key,两条接线形态与安全属性不同,难以统一演进。

诉求(已与 operator 确认):所有 vendor 的所有 provider 请求统一走 relay(真实 key 不下沉);提供 provider 级容错;用户能把"一组按优先级排序的 agent"当作一个可选 agent 使用。

## Options considered

1. **维持 codex-only relay + claude 直连注入 key。** _Con:_ claude 真实 key 持续下沉子进程/沙箱;两 vendor 接线不一致;无 provider 容错。不满足诉求。
2. **统一 vendor 中立 relay + group failover(采纳)。** 所有 vendor 指向 c3 loopback relay + per-run token;relay 按 vendor 适配(codex Responses↔Chat 翻译 / claude anthropic-compat 透传);agent 加 `group`,`(group, vendor)` 构成组,虚拟 agent `_c3_<group>` 按优先级 failover。
3. **外部网关(LiteLLM / 独立 relay 二进制等)。** _Con:_ 需额外安装、打破 ADR-0003 单二进制契约、失去协议控制权——与 ADR-0014 排除外部代理的理由一致。

## Decision

采纳方案 2。**relay 从 codex 专用泛化为 vendor 中立的核心模块;所有 vendor 的所有 provider 请求经进程内 loopback relay;relay 承担认证换发、协议适配与 group 故障转移。** 完整规格见 [relay-architecture](../relay-architecture.md);要点:

- **统一接线。** 每个 vendor CLI 的 provider 连接收敛为"base_url = c3 loopback relay 的 vendor 端点,api_key = per-run token"。claude 不再注入真实 baseUrl/key。
- **token 换发扩展为候选列表。** `register` 绑定一个**有序候选列表**(每项含真实 `{baseUrl, apiKey, model, wireApi}`),返回不透明 token;真实 key 只在 relay 内存,子进程/沙箱只见 token;run 结束 `unregister`。
- **协议适配按 vendor。** codex:`wireApi=chat` 走 Responses↔Chat 双向翻译(沿用 ADR-0014 的翻译核心与线路契约)、`responses` 透传;claude:anthropic-compat 上游透传(跨协议翻译列为后续)。
- **group + failover。** agent 新增 `group`;相同 `(group, vendor)` 的 enabled agent 按 `order_seq` 优先级构成组,暴露为虚拟 agent `_c3_<group>`;每个请求从最高优先级候选起,**仅在向 CLI 回传首字节前**失败才切下一个候选;失败判定复用 `isDegradableError`;命中候选的真实 `model` 由 relay 覆盖请求(CLI 用逻辑 model 占位)。一个 `group-name` 归属单一 vendor,跨 vendor 不 failover。
- **端点按 vendor 分。** codex `/internal/relay/v1/codex/responses`、claude `/internal/relay/v1/anthropic/v1/messages`;ADR-0014 的 `/internal/codex-relay/v1/responses` 保留一个过渡期别名。

本 ADR **取代 ADR-0014**:0014 的 codex Responses↔Chat 翻译作为 relay 的 codex 适配器完整保留;relay 的适用范围从 codex-only 扩展到全 vendor 并新增 group failover。

## Consequences

- claude 真实 provider key 不再下沉 vendor 子进程 / 沙箱——相对现状的净安全提升;沙箱内所有 vendor 统一只传 token,与 ADR-0028 的"凭证默认不可见"一致。
- group agent 提供 provider 级容错(限流 / 故障 / 配额自动切换);运维需保证组内候选能力同档——relay 只做连接级故障转移,不消除模型能力差异。
- relay 成为所有 provider 出站流量的单点:进程内、loopback、除 token 绑定外无状态,故障面等同 c3 进程本身。
- c3 承担 claude + codex 两套上游协议的适配责任:codex 沿用 ADR-0014 的线路契约与 API 变更监控;claude 当前仅支持 anthropic-compat 透传,OpenAI-Chat 型 claude 网关的跨协议翻译超出本次范围。
- failover 只在首字节前;一旦开始流式回传,上游中断作为该请求的错误结束(与直连语义一致),不中途换 provider。
- `wireApi` 语义不变但从"direct vs relay 的路由开关"降级为 relay 内部"chat 翻译 vs responses 透传"的适配选择——所有 codex 都走 relay。无 `group` 的旧 agent 等价于候选长度 1 的普通 agent,行为不变。

## Compliance

- **ADR-0009 R2** —— relay 的 HTTP 面与协议翻译在 transport 层;kernel 只持惰性句柄(`register(candidates)` / `unregister` / 各 vendor 端点 baseUrl),在组合根注入 driver;driver 与 kernel 不触碰 HTTP handler。沿用 0014 的分层。
- **ADR-0003** —— relay 进程内,无新增打包二进制,`bun build --compile` 下存活。
- **ADR-0011 / SDK 边界** —— 无 vendor SDK 类型跨越 relay;只有 JSON 形态穿过协议适配层。
- **ADR-0028** —— relay 与 arapuca 沙箱正交:沙箱内 vendor 是宿主进程,经宿主回环访问 relay,仅传 token,不新增 `0.0.0.0` / bridge / LAN 绑定,真实 key 仍只存于宿主 relay 内存。

## References

- 取代 [ADR-0014](deprecated/0014-codex-in-process-responses-chat-relay.md)(codex 进程内 Responses→Chat relay)。
- 规格:[relay-architecture](../relay-architecture.md)。
- ADR-0003(单二进制)、ADR-0009(边界)、ADR-0011(vendor 中立 agent)、ADR-0028(arapuca 进程级沙箱)。
- [agent-config 数据模型](../../domains/settings/agent-config/agent-config-models.md)(`group` 字段)。
