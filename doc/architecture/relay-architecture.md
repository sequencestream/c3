# Relay 架构(统一 provider relay + group failover)

- **Status:** draft
- **Date:** 2026-07-16
- **Supersedes:** 原 `codex-relay.md`(codex 专用 Responses→Chat relay)——本文把 relay 从 codex 专用泛化为**vendor 中立的核心模块**,并新增 group agent 与 failover。
- **References:** [ADR-0029](adr/0029-vendor-neutral-relay-and-agent-group-failover.md)(vendor 中立 relay + group failover,取代 [ADR-0014](adr/deprecated/0014-codex-in-process-responses-chat-relay.md))。
- **挂载点:** relay 路由在 c3 主 Hono app 上注册(§4)。

## 1. 定位与目标

relay 是 c3 进程内的 **provider 接入枢纽**:所有 vendor CLI(claude / codex)的 provider 流量,不再直接连上游,而是统一发到 c3 自身 loopback 上的 relay 端点,由 relay 负责认证换发、协议适配与故障转移。

本次演进的三个目标:

1. **所有 agent 请求全部走 relay**(不再只有 codex)。claude 也经 relay,消除"真实 provider key 下沉到 vendor 子进程 / 沙箱"的暴露面。
2. **group agent + failover**:agent 配置新增 `group` 字段;相同 `(group, vendor)` 的 agent 构成一个组;用户可选虚拟 group agent `_c3_<group-name>`,请求时按组内优先级选最高的生效 agent,失败自动切下一个。
3. **relay 作为独立核心模块**:从 codex 专用的 `codex-relay` 提升为 vendor 中立的 relay 模块;各 vendor 的协议差异下沉为可插拔的"协议适配器"。

不变的核心约束(沿用原 codex-relay):

- 外部(vendor CLI)只持有 **per-run 不透明 token**;relay 按 token 查真实上游配置,**真实 key 永不离开 c3 进程**。
- relay 是 c3 主 Hono app 上的 loopback 端点;token 校验是纵深防御的最后一闸。
- 无 SDK 类型穿过协议翻译层(ADR-0009):翻译是纯函数,HTTP 面与 kernel 面分离。

## 2. 为什么统一走 relay

| 诉求        | 直连(现状 claude)               | 统一 relay(目标)                                        |
| ----------- | ------------------------------- | ------------------------------------------------------- |
| 凭证暴露    | 真实 key 注入子进程 / 沙箱 env  | 子进程只见 per-run token;真实 key 只在 relay 内存       |
| 协议适配    | 直连要求上游原生兼容 vendor协议 | relay 按 vendor 做协议翻译 / 透传(codex Responses↔Chat) |
| 多 provider | 一个 agent 绑死一个 provider    | group agent:一次请求可在多个候选 provider 间 failover   |
| 接线一致性  | claude 走 env、codex 走 relay   | 所有 vendor 统一"指向 loopback relay + 传 token"        |
| 沙箱网络    | 需把真实 key 传进沙箱           | 沙箱内只传 token;`127.0.0.1` 即宿主,relay 天然可达      |

统一走 relay 后,vendor CLI 的 provider 接线收敛为同一形态:**base_url = c3 loopback relay 的 vendor 端点,api_key = per-run token**;差异全部下沉到 relay 内部。

## 3. 架构总览

relay 是内核基础设施层的独立模块,vendor 中立。分层:

```
┌── c3 server process ─────────────────────────────────────────────┐
│                                                                   │
│  vendor CLI 子进程（宿主 or arapuca 沙箱内，均为宿主进程）        │
│    claude:  ANTHROPIC_BASE_URL = <relay>/anthropic                │
│             ANTHROPIC_API_KEY  = <token>                          │
│    codex:   model_providers.c3relay.base_url = <relay>/codex     │
│             CODEX_API_KEY = <token>                               │
│        │  Authorization: Bearer <token>（loopback）               │
│        ▼                                                          │
│  ┌── Relay Core（独立核心模块，vendor 中立）──────────────────┐  │
│  │  Token Registry：token → { candidates[], cursor }          │  │
│  │  Router / Failover：按优先级取候选，首字节前失败即切下一个 │  │
│  │  Protocol Adapters（按 vendor 可插拔）：                    │  │
│  │    - codex:  Responses↔Chat 翻译（wireApi=chat）/ 透传     │  │
│  │    - claude: Anthropic Messages 透传（/ 未来跨协议翻译）    │  │
│  │  Upstream Fetch：用候选真实 {baseUrl, apiKey, model} 出站   │  │
│  └────────────────────────────────────────────────────────────┘  │
│        │ register(candidates)→token / unregister(token)           │
│        ▼                                                          │
│  Agent-config resolve：真实 agent id 或 `_c3_<group>` →           │
│    候选列表（按 order_seq 优先级排序的同 (group,vendor) agents）  │
└───────────────────────────────────────────────────────────────────┘
```

职责边界:

| 层                          | 职责                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------- |
| Agent-config resolve        | 把 agent 引用(真实 id / `_c3_<group>`)解析为**有序候选列表**(每项含真实上游配置)。    |
| Relay kernel 面             | `register(candidates) → token` / `unregister(token)` / 各 vendor 端点 baseUrl。       |
| Relay transport 面          | HTTP handler、token registry、failover 路由、协议适配、上游出站(触碰 Hono / 序列化)。 |
| Protocol Adapter(每 vendor) | 纯函数:请求/响应流的协议翻译或透传;无 SDK、无 HTTP 依赖。                             |
| Vendor driver               | 把 CLI 指向 relay 的 vendor 端点、传 token、注入 `NO_PROXY`;不再注入真实 key。        |

## 4. Relay 端点(vendor 维度)

relay 按 vendor 暴露不同端点(不同 vendor 的线缆协议不同),token 机制通用:

| Vendor | 端点(loopback)                                  | 上游协议                       | 适配方式                                                |
| ------ | ----------------------------------------------- | ------------------------------ | ------------------------------------------------------- |
| codex  | `POST /internal/relay/v1/codex/responses`       | OpenAI Responses(CLI 侧固定)   | `wireApi=chat` → Responses↔Chat 翻译;`responses` → 透传 |
| claude | `POST /internal/relay/v1/anthropic/v1/messages` | Anthropic Messages(CLI 侧固定) | anthropic-compat 上游 → 透传;跨协议 → 翻译(后续)        |

- 端点前缀统一为 `/internal/relay/v1/<vendor>/…`;原 `/internal/codex-relay/v1/responses` 作为 codex 端点的迁移别名保留一个过渡期(§13)。
- CLI 侧协议由 vendor 决定、固定不变:codex 只说 Responses,claude 只说 Anthropic Messages。relay 的适配器把它转成候选上游能接受的协议。

## 5. 认证与 Token Registry(候选列表绑定)

沿用原 codex-relay 的 token 换发思路,**绑定对象从"单个上游"扩展为"有序候选列表"**:

```
register([
  { baseUrl:"https://api.deepseek.com",  apiKey:"sk-A", model:"deepseek-v4", wireApi:"chat" },   // 优先级 0
  { baseUrl:"https://api.moonshot.cn",   apiKey:"sk-B", model:"kimi-k2",     wireApi:"chat" },   // 优先级 1
]) → token "550e8400-…"
  → token 作为 vendor CLI 的 api key（Bearer <token>）
  → relay 按 token 取候选列表，按优先级出站；用命中候选的真实 {baseUrl, apiKey, model} 覆盖请求
  → run 结束 unregister(token)，清空绑定
```

- **真实 key 不出 relay**:CLI 只见 token;relay 用候选真实 key 出站。
- **model 也由 relay 覆盖**:CLI 用一个"逻辑 model"(见 §7.3)启动,relay 转发时把请求里的 model 替换为**当前命中候选的真实 model**,故 failover 切换 provider 时 model 一并切换。
- **token 生命周期**:per-run、run 结束注销;未知 token 返回 401。
- 普通(非 group)agent 是候选列表长度为 1 的退化情形,与 group agent 共用同一路径。

## 6. Agent 配置模型变更(`group` 字段)

`AgentConfig` 的 vendor 中立公共壳(`baseShellSchema`)新增可选字段:

```ts
// shared/protocol.ts(类型)+ agent-config/schema.ts(zod)同步新增:
group?: string // 非空 ⇒ 该 agent 归入 (group, vendor) 组;为空/缺省 ⇒ 不参与任何组
```

组的定义与约束:

- **组身份 = `(group, vendor)`**:相同 `group` 且相同 `vendor` 的 **enabled** agent 构成一个组。
- **一个 `group-name` 归属单一 vendor**:为让虚拟引用 `_c3_<group>` 无歧义(它不带 vendor),约定同一 `group-name` 只应包含同一 vendor 的 agent。normalize 阶段以**首个定义该 group 的 agent 的 vendor** 锁定该组 vendor;同名但异 vendor 的 agent **不并入**该组,并产生一次告警(fail-soft,不阻断保存)。
- **组内优先级 = `order_seq` 升序**:沿用全局排序键,`order_seq` 越小优先级越高。
- **只含 enabled agent**:`enabled === false` 的 agent 不进入组(与 `enabledAgents` 口径一致)。
- 空组(该 group-name 下无 enabled agent)不产生虚拟 group agent。

配置示例:

```jsonc
// 三个 claude agent 归入同一组 "fast"，优先级由 order_seq 决定
{ "id": "a1", "vendor": "claude", "group": "fast", "order_seq": 0, "config": { "baseUrl": "…deepseek…/anthropic", "model": "deepseek-v4-flash" } }
{ "id": "a2", "vendor": "claude", "group": "fast", "order_seq": 1, "config": { "baseUrl": "…moonshot…/anthropic", "model": "kimi-k2" } }
{ "id": "a3", "vendor": "claude", "group": "fast", "order_seq": 2, "config": { "baseUrl": "…mimo…/anthropic",     "model": "mimo" } }
// ⇒ 产生虚拟 group agent  _c3_fast (vendor=claude)
```

## 7. Group Agent 虚拟引用

### 7.1 虚拟 id 与枚举

- 虚拟 group agent 的引用 id 形如 **`_c3_<group-name>`**(保留前缀 `_c3_`,用户配置的真实 agent id 不得以此为前缀——normalize 校验)。
- 在"可选 agent"枚举里(default / tool / intent / spec agent 选择、session 绑定、consensus 参与者、sandbox agent 池等所有 agent 选择点),除真实 agent 外,**为每个非空组追加一个虚拟 group agent**:
  - `id = _c3_<group>`,`displayName = <group>`(UI 可加组标识 / 成员数),`vendor = 组 vendor`。
  - 虚拟 agent 只用于**引用与展示**,不可编辑、不落盘为真实 agent。

### 7.2 resolve:从引用到候选列表

现有 `resolveAgent(id): AgentConfig` 返回单个 agent;新增候选解析,统一被 launch 使用:

```ts
resolveAgentCandidates(ref: string): AgentConfig[]
//  真实 id            → [该 agent]（长度 1）
//  _c3_<group>        → 组内 enabled agent 按 order_seq 升序（优先级）
//  未知 / 空组         → 回退默认 agent（沿用 resolveAgent 的 default→system 兜底）
```

- 现有 `resolveAgent` 保留:对需要"单个代表 agent"的场景(如展示 vendor、model 占位),取候选列表首项(最高优先级)。
- `resolveSessionLaunch` / `resolveToolSessionLaunch` 等改为:解析候选列表 → 见 §10。

### 7.3 逻辑 model 与真实 model

vendor CLI 启动时 model 是固定参数,而候选间 model 可能不同。约定:

- CLI 以**首个候选的 model** 作为启动 model 参数(仅作占位/展示;上游 model 由 relay 决定)。
- relay 转发时,用**命中候选**的真实 `model` 覆盖请求体的 model 字段。failover 到 model 不同的候选时,上游收到的是该候选的真实 model。
- 因此 CLI 视角的 model 恒定,provider 视角的 model 随 failover 切换,两者解耦。

## 8. 请求路由与 Failover

### 8.1 路由算法

relay 收到一个带 token 的请求:

```
取 token → candidates[]（已按优先级排序）
for i in 0..candidates.len:
  cand = candidates[i]
  适配请求（协议翻译 / 透传，见 §9），用 cand.{baseUrl,apiKey,model} 出站
  若在“产出首个响应字节给 CLI 之前”失败（见 8.2）:
      记录该候选失败，continue 下一个候选
  否则:
      开始把（适配后的）响应流回传给 CLI —— 此后不再 failover
所有候选失败 ⇒ 回传该 vendor 协议的 error 事件（codex: response.failed / claude: error）
```

- **每个请求都从优先级最高的候选重新开始**(无粘性)——符合"每次请求组内生效的优先级最高 agent"的语义。若需要"粘住上次成功候选"作为优化,列为后续可选项,不在当前范围。

### 8.2 Failover 触发条件与粒度

**关键边界:failover 只发生在"尚未向 CLI 回传任何响应字节"之前。** 一旦开始流式回传,上游中断只能作为该请求的错误结束,不能中途换候选(会损坏协议流 / 丢失上下文)。

判定"候选失败"(在首字节前):

| 情况                                      | 是否 failover | 说明                                             |
| ----------------------------------------- | ------------- | ------------------------------------------------ |
| 连接失败(DNS / ECONNREFUSED / TLS / 超时) | 是            | 网络级不可达                                     |
| 上游 5xx                                  | 是            | 上游服务端错误                                   |
| 上游 429 / 配额耗尽                       | 是            | 可切换到下一个候选(容量/额度问题)                |
| 上游 4xx(非 429,如 400/401/403)           | 否            | 请求本身或该候选凭证问题,换候选通常无用;直接透出 |
| 已开始流式后上游断流                      | 否            | 首字节后不 failover;作为请求错误结束             |

- 触发条件集合应与现有 `isDegradableError`(agent 降级链判定)对齐/复用,保持"什么算可切换失败"的单一口径。

### 8.3 粒度与有状态会话

- failover 粒度是**单个 HTTP 请求(一个 turn 的一次上游调用)**,不是整个 session。
- codex thread / claude session 的上下文由 CLI 侧维护并随每次请求重发,故请求级换 provider 不丢历史;但**模型能力差异**(工具支持、上下文窗口、reasoning)可能导致体验不一致——这是 group 内候选应尽量同档的运维约束,不是 relay 能消除的。
- **跨 vendor 不 failover**:组身份含 vendor,claude 组只在 claude-compat 候选间切,codex 组只在 codex 候选间切。claude↔codex 语义不可互换。

## 9. 协议适配(按 vendor)

relay 的适配器是纯函数,按 vendor + 候选的上游协议选择"透传"或"翻译":

| Vendor | 候选上游协议                              | 适配                                                            |
| ------ | ----------------------------------------- | --------------------------------------------------------------- |
| codex  | Chat Completions(`wireApi=chat`)          | **Responses↔Chat 双向翻译**(沿用原 codex-relay,见 §9.1)         |
| codex  | Responses(`wireApi=responses`)            | 透传:仅 token→key、model 覆盖;不翻译                            |
| claude | Anthropic Messages(anthropic-compat 网关) | **透传**:仅 token→key、model 覆盖(你现有 `/anthropic` 端点即此) |
| claude | OpenAI Chat(仅 chat 的网关)               | Anthropic↔Chat 翻译(后续阶段;当前范围不含)                      |

### 9.1 codex Responses↔Chat 翻译(保留)

沿用原 codex-relay 的双向翻译,是 codex 走第三方 Chat-only provider 的核心。要点:

- **方向 A(Responses 请求 → Chat 请求)**:`instructions`/developer 角色折叠为 system;`function_call`/`function_call_output` ↔ assistant.tool_calls / tool 消息;`tools[].namespace` 扁平化;`stream` 强制 true;Responses 专用字段(store/include/reasoning/metadata)丢弃;`tool_choice` 对象值降级为 `auto`。
- **方向 B(Chat SSE → Responses SSE)**:`delta.content` → `response.output_text.delta`;`delta.reasoning_content` → `response.reasoning_text.delta`;`delta.tool_calls[].function.arguments` → `response.function_call_arguments.delta`;流结束补 `response.output_item.done` + **`response.completed`**(必需,否则 codex 报 "stream closed before response.completed");上游异常 → `response.failed`。
- codex Rust SSE 解析器**忽略未知事件类型**,为兼容缓冲。
- codex CLI 侧关键配置:`model_providers.c3relay.wire_api="responses"` + `supports_websockets=false`(强制 HTTP POST + SSE,relay 唯一支持的模式)+ `NO_PROXY` 含 loopback(防回环被 HTTP_PROXY 劫持)。

翻译的完整字段映射表、兼容契约与 API 变更监控见 §14(自原 codex-relay 保留)。

### 9.2 claude Anthropic 透传

- claude CLI 设 `ANTHROPIC_BASE_URL = <relay>/anthropic`,`ANTHROPIC_API_KEY = ANTHROPIC_AUTH_TOKEN = <token>`。
- relay 的 anthropic 端点:按 token 取候选 → 把请求原样转发到候选 `baseUrl`(anthropic-compat,如 `api.deepseek.com/anthropic`),`Authorization`/`x-api-key` 换成候选真实 key,请求体 `model` 覆盖为候选 model,SSE 响应原样回传。
- 现有针对第三方 anthropic 网关的 `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1` 兼容项继续在 CLI env 注入(与 relay 正交)。

## 10. Launch 接线变更

`launchForAgent(agent)` 从"按 vendor 注入真实连接"改为"统一指向 relay + 传 token",并支持候选列表:

- 新增 `launchForCandidates(candidates: AgentConfig[]): LaunchOverrides`(单 agent 是长度 1 的候选):
  1. `relay.register(candidates.map(toUpstream))` → `token`。
  2. 按 vendor 产出 CLI 接线:
     - **claude**:`env.ANTHROPIC_BASE_URL = <relay>/anthropic`;`env.ANTHROPIC_API_KEY = env.ANTHROPIC_AUTH_TOKEN = token`;`model` = 首候选 model(占位)。**不再注入真实 baseUrl/key。**
     - **codex**:`baseUrl = <relay>/codex`(codex POST `/responses`);`apiKey = token`;driver 用 `CODEX_RELAY_PROVIDER` provider 配置(`wire_api=responses` + `supports_websockets=false`);`model` = 首候选 model(占位)。
  3. `NO_PROXY += 127.0.0.1,localhost,::1`。
- `wireApi` 不再需要在 LaunchOverrides 里区分 direct/relay——**所有 codex 都走 relay**;`wireApi` 下沉为**候选级**属性(每个候选是 chat 还是 responses,决定 relay 内部翻译 vs 透传)。
- token 的注销:run 生命周期结束(现有 sandbox `cleanup()` / run teardown)时 `relay.unregister(token)`。
- `resolveSessionLaunch` / `resolveToolSessionLaunch` / consensus advisor 调用:改为 `resolveAgentCandidates(ref)` → `launchForCandidates`。

## 11. 沙箱接线

沿用原 codex-relay §2.6,并推广到 claude:

- 进程级沙箱(arapuca)下 vendor CLI 是宿主进程,`127.0.0.1` 即宿主本机,直接够到宿主回环上的 relay,无回连桥、无 URL 改写。
- 沙箱内只传 **token**(随 `CODEX_API_KEY` / `ANTHROPIC_API_KEY` env 进入),真实 key 只在宿主 relay 内存 —— 与"严格不把凭证 / 订阅传入沙箱"的隔离要求天然一致。
- 需要网络放行:沙箱 wrapper 已 `--seccomp baseline` 开网,loopback 随之可达(见 `sandbox-architecture.md` §8/§11)。
- `NO_PROXY` 含 loopback,防回环 hop 被代理劫持。

## 12. 安全模型

沿用原四层防御,并因"claude 也走 relay"而收敛暴露面:

1. **loopback 绑定**:relay 挂在主 Hono app,可达性随主 server 绑定地址(记录:主 server 未限定 hostname 时 Node 绑 `0.0.0.0`,LAN 可达,token 校验为唯一闸)。
2. **token 校验**:未知/过期 token → 401。
3. **token 一次性**:per-run,run 结束注销。
4. **真实 key 不出 relay**:所有 vendor 子进程只见 token;真实 provider key 只在 relay 内存的候选绑定里。**这是相对现状的净提升——现状 claude 把真实 key 注入子进程/沙箱,统一 relay 后消除。**

## 13. 与现有 codex-relay 的迁移

- 模块:`transport/codex-relay` → `transport/relay`(vendor 中立);codex 的 Responses↔Chat 翻译成为 `relay/adapters/codex`;新增 `relay/adapters/anthropic`(透传)。kernel 面 `CodexRelay` handle 泛化为 `Relay`(`register(candidates)/unregister/端点`)。
- 端点:`/internal/codex-relay/v1/responses` 作为 codex 端点的**过渡别名**保留一个版本周期,新端点 `/internal/relay/v1/codex/responses`。
- 配置:`AgentConfig` 新增 `group?`;`wireApi` 语义不变但从"direct vs relay 的路由开关"降级为"relay 内部 chat vs responses 的适配选择"(所有 codex 都走 relay)。
- 兼容:无 `group` 的旧 agent = 不参与组的普通 agent(候选长度 1),行为等价于"单 provider 走 relay"。
- 文档:本文替代 `codex-relay.md`;引用处(如 `doc/domains/settings/agent-config/agent-config-models.md`)改指本文。deprecated ADR 内的旧引用按宪法保留不改。

## 14. codex 协议兼容与 API 变更监控(自 codex-relay 保留)

codex 侧协议翻译是与上游(codex CLI / OpenAI Responses / 第三方 Chat)协议耦合最紧的部分,保留原有的兼容契约与监控机制:

- **有限子集**:relay 只翻译 codex 实际发送/解析的 Responses 子集(请求:instructions/input/tools/tool_choice/stream;响应:created/output_text.delta/output_item.\*/function_call_arguments.delta/reasoning_text.delta/completed/failed)。
- **反向兼容触发点**:codex CLI 改变发送的 Responses 结构、改变解析的 SSE 事件结构、第三方 Chat SSE 格式变更、codex 移除 `supports_websockets`/`wire_api`、OpenAI 发布新版 Responses API。
- **变更监控**:每 14 天经 c3 `automations` 检测 codex release / Responses schema / OpenAI docs / codex-sdk npm;命中则创建 Intent(P0/P1/P2,见变更等级矩阵);流程:收集证据 → 分析影响 → 建 Intent → 实施 → 验证。
- **测试**:翻译单元测试(真实 codex 请求 fixture)、token registry 单元测试、真实 codex 二进制 + fake Chat upstream 的 e2e。

> 上述监控矩阵与流程细节沿用原 codex-relay 文档,随 codex 协议演进更新。

## 15. 边界、非目标与风险

非目标(当前阶段):

- claude 的跨协议翻译(Anthropic↔OpenAI Chat):当前只支持 anthropic-compat 上游透传。
- 粘性 failover(粘住上次成功候选)、健康探测/熔断、跨请求的负载均衡:列为后续优化。
- relay 层做 vendor 之间的切换(claude↔codex):语义不可互换,明确不做。
- 把 consensus/多 agent 投票搬进 relay:consensus 属 run lifecycle 层,relay 只做"同 vendor 同组的 provider 故障转移",两层职责不重叠。

风险与决策:

| 风险                               | 决策                                                                       |
| ---------------------------------- | -------------------------------------------------------------------------- |
| 首字节后上游断流无法 failover      | 明确边界:failover 仅在首字节前;其后作为请求错误结束(与直连一致)。          |
| 组内候选模型能力不一致导致体验漂移 | 运维约束:同组候选应同档;relay 不消除模型差异,仅做连接级故障转移。          |
| `group-name` 混用 vendor 造成歧义  | normalize 以首个 agent 锁定组 vendor,异 vendor 不并入并告警。              |
| relay 成为所有流量单点             | 进程内、loopback、纯转发 + 翻译,无状态(除 token 绑定);故障面等同 c3 进程。 |
| 真实 key 集中在 relay 内存         | 仅内存、per-run、run 结束清除;不落盘、不进子进程/沙箱。                    |

## 16. 分阶段实施

- **Phase A — relay 泛化**:`codex-relay` 模块重命名/泛化为 vendor 中立 relay;kernel handle `register(candidates)`;端点按 vendor 拆分 + codex 旧端点别名。
- **Phase B — claude 走 relay**:新增 anthropic 透传适配器;`launchForAgent`(claude 分支)改为指向 relay + 传 token;e2e 用 `claude-deepseek` 验证 key 不下沉且真实请求成功。
- **Phase C — group 配置**:`AgentConfig` 加 `group?`;normalize 组化 + vendor 锁定校验;虚拟 group agent 枚举与 `_c3_<group>` 前缀保护。
- **Phase D — resolve + failover**:`resolveAgentCandidates`;relay 候选列表绑定 + 首字节前 failover + model 覆盖;失败判定复用 `isDegradableError`。
- **Phase E — UI/协议**:agent 编辑增 `group` 字段;agent 选择器列出 group agent;`freezeSessionAgent` / 展示层对虚拟 id 的处理。
