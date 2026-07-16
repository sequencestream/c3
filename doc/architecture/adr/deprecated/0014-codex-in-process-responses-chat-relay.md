# 0014 — 面向 codex Chat-Completions 提供方的进程内 Responses→Chat 中继

> **已被 [ADR-0029](../0029-vendor-neutral-relay-and-agent-group-failover.md) 取代**(2026-07-16)。
> relay 从 codex 专用泛化为 vendor 中立的核心模块:所有 vendor 的所有 provider 请求统一走 relay,
> 新增 agent group failover。本文的 codex Responses→Chat 翻译核心、token 换发、driver 接线等作为
> relay 的 codex 适配器由 ADR-0029 沿用;保留本文作为历史记录。

- **Status:** superseded
- **Date:** 2026-06-06

## Context

ADR-0011 让 codex 成为一个头等的驱动路径厂商;AC-R5 把一个自定义 codex agent 的 base URL 和
API key 映射到 codex SDK 上,使用户可以把 codex 指向一个第三方提供方(DeepSeek、Kimi、MiMo、
MiniMax……)。实际上,这个映射对这些提供方已经不再起作用。

两个事实相撞:

1. **Codex 0.137 在线路上只讲 OpenAI Responses API。** `wire_api = "chat"` 这个选项已经在
   上游被移除(openai/codex discussion #7782;chat 支持在 2026 年 2 月初变成了硬错误)。Codex
   内建的 `openai` provider 向 `<base_url>/responses` 发 POST,而且默认情况下它会先拨一个
   **websocket**(`responses_websocket`),失败后才回退到 HTTP POST + SSE。
2. **主流的第三方提供方只实现 Chat Completions**(`/v1/chat/completions`)。没有一个暴露
   `/responses`。所以一个指向 `https://api.deepseek.com/` 的 codex agent 会以
   `404 … /responses` 失败(观测到的是 `wss://api.deepseek.com/responses`)。

没有任何 codex 配置能够桥接这道鸿沟:`wire_api = "chat"` 已经不存在了。唯一的路径是一个把
Responses 协议翻译成 Chat Completions 的代理。产品需求(已与 operator 确认)是 c3 **透明地**
完成这件事:用户仍然配置真实的上游 URL,而由 c3 自己启动并运行这个代理——不需要外部进程,不需要
额外安装(一个外部中继二进制会带来这种负担,打破 ADR-0003 的单二进制契约)。

一份被捕获的 codex 0.137 `POST /responses` 请求体,以及 codex 自己的 Rust SSE 解析器
(`codex-rs/codex-api/src/sse/responses.rs` @ rust-v0.137.0)钉住了这条线路契约:codex 按 JSON
的 `type` 字段区分事件,**忽略未知事件**,把每个输出作为 `response.output_item.done` 里的一个
完整 `ResponseItem`,并要求这条流以 `response.completed`(携带一个必备的 `id` + 可选的
`usage`)结束。探测还揭示了两个宿主事实:一个提供方的 `supports_websockets = false` 会强制
codex 走纯 HTTP POST + SSE,而 codex 会经由一个配置的 `HTTP(S)_PROXY` 路由这一跳回环流量,
除非 `NO_PROXY` 把 `127.0.0.1` 排除在外。

## Options considered

需要安装第二个运行时(pip/cargo/Python),而打包一个按平台分发的二进制会打破单二进制分发
(ADR-0003)。这与"c3 自己启动它,不需要额外安装"相矛盾。2. **在 c3 自己的 HTTP server 上挂载
进程内翻译。** c3 托管一个回环端点;codex driver 通过一个自定义 `model_provider` 把 CLI 指向
它(`supports_websockets = false`),中继双向改写 Responses⇄Chat。_Pro:_ 没有外部依赖,能在
单二进制打包下存活,拥有完整控制权。_Con:_ c3 拥有协议翻译逻辑及其正确性的责任。3.
**按 agent 的 wire-API 开关。** 增加配置让用户声明 chat 还是 responses。_Con:_ 把一个协议
细节推给了用户;与"只需配置 URL"的需求相悖。已推迟——今天每一个自定义 codex 提供方都走这条
路径(第一方 OpenAI 使用系统配置模式,绕开了这个中继)。

## Decision

采纳方案 2。**对于带有一个提供方 URL 的自定义 codex agent,c3 通过一个进程内的
Responses→Chat 中继来驱动 codex;用户的配置保持不变(真实的上游 URL)。**

- **翻译核心** —— 一个纯粹的、不含 SDK 的、有单元测试覆盖的翻译层,立足于被捕获的请求 + codex
  的解析器契约。请求侧:instructions→system、developer→system,相邻的 function call 被合并进
  同一个 assistant 回合,function-call 输出 → tool 消息,codex 命名空间工具被展平,仅
  Responses 专有的字段被丢弃,streaming + usage 被强制开启。响应侧:实时流式输出
  output-text/reasoning 的增量,在完成时把每个输出物化为一个完整的 Responses 输出条目,始终以
  携带 id + usage 的 Responses 完成事件收尾。
- **中继** —— 一个按运行的 token 注册表加一个 HTTP handler。Driver 注册真实的 base URL + API
  key,拿回一个不透明的 token;handler 通过 `Authorization: Bearer <token>` 头解析这份绑定,
  拉取上游的 `/chat/completions`,并把翻译后的 Responses SSE 流回。未知 token 会被拒绝;这份
  绑定在运行结束时被逐出。
- **Driver 接线** —— 当中继存在且这次运行带有一个自定义 URL 时,codex 会带着一个自定义
  `model_provider` 启动(它的 `base_url` 指向中继,`wire_api = "responses"`,
  `supports_websockets = false`),token 以 `CODEX_API_KEY` 的形式传入,`NO_PROXY` 被补充上
  回环主机。真实的 key 从不会到达 codex 子进程。没有中继/没有自定义 URL ⇒ 原始的直连路径不变。
- **挂载** —— 中继在组合根(composition root)上,基于 c3 自己的端口构建,它的路由在静态兜底
  路由**之前**注册。

## Consequences

- 一个位于纯 Chat-Completions 提供方之上的 codex agent 现在可以开箱即用;`/responses 404`
  消失了。DeepSeek/Kimi/MiMo/MiniMax 都可以在无需用户自跑代理、无需额外安装的情况下访问。
- c3 拥有 Responses⇄Chat 的保真度责任。通过把每一种形态都立足于真实的线路契约(被捕获的请求 +
  codex 的 Rust 解析器)以及一个真实二进制的端到端测试(codex ⇄ 中继 ⇄ 一个假的 Chat 上游)来
  缓解这一点。
- 流式反压得以保留,但中继会在发出 `output_item.done` 之前,按条目缓冲文本/参数;对于回环上
  有界的 codex 回合来说,这是可以接受的。
- 只有那些会发出 `reasoning_content` 的上游(DeepSeek-R 一类)才能展现 reasoning;其他 chat
  上游一概不携带它。
- Node 的全局 `fetch` 不遵循 `HTTP_PROXY`,所以中继向一个公网提供方发出的出站调用是直连
  的——对这里所针对的中国大陆托管的提供方而言没有问题;一个上游要求经由强制出站代理的 operator
  超出了本次范围。

## Compliance

- **ADR-0009 R2** —— 中继属于 HTTP 传输 + 线路序列化,因此它的实现位于 transport 层,而非
  内核。内核只保留一个惰性句柄(中继的 base URL + register/unregister 钩子 + provider 名称
  常量),在组合根被注入进 driver;driver 从不看见这个 HTTP handler。内核保持不涉及 HTTP
  server 和线路序列化。
- **ADR-0003** —— 没有新增的打包二进制;中继是进程内的,能在 `bun build --compile` 下存活。
- **ADR-0011 / ADR-0009 SDK boundary** —— 没有厂商 SDK 类型进入中继;只有 JSON 形态跨越它。

## References

- ADR-0003(单二进制)、ADR-0009(边界)、ADR-0011(厂商中立 agent)。
- [agent-config domain spec](../../../domains/settings/agent-config/agent-config-spec.md) AC-R5。
- openai/codex discussion #7782(chat wire-api 移除);codex 的 Rust SSE 解析器
  (rust-v0.137.0)——这条事件契约。
