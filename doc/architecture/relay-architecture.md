# Relay 架构(统一 provider relay + group failover)

- **Status:** implemented(Phase A–E 全部落地)
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
// shared/src/protocol/agent-config.ts(类型)+ agent-config/schema.ts(zod)同步新增:
group?: string // 非空 ⇒ 该 agent 归入 (group, vendor) 组;为空/缺省 ⇒ 不参与任何组
```

组的定义与约束:

- **组身份 = `(vendor, group)`**:相同 `group` 且相同 `vendor` 的 **enabled** agent 构成一个组。
- **虚拟引用编码 vendor,故 group-name 可跨 vendor 复用**:虚拟引用形如 `_c3_<vendor>_<group>`(见 §7.1),vendor 已编码在 id 中,`(vendor, group)` 天然无歧义。因此**不同 vendor 可使用相同 group-name**——`claude`/`fast` 与 `codex`/`fast` 是**两个独立组**,分别暴露为 `_c3_claude_fast` 与 `_c3_codex_fast`。normalize 不做 vendor 锁定、不改写 `group` 字段(仅保留 `_c3_` 保留前缀告警)。
- **组内优先级 = `order_seq` 升序**:沿用全局排序键,`order_seq` 越小优先级越高。
- **只含 enabled agent**:`enabled === false` 的 agent 不进入组(与 `enabledAgents` 口径一致)。
- 空组(该 `(vendor, group)` 下无 enabled agent)不产生虚拟 group agent。
- **成员可混 `custom` 与 `system`**:`system` 成员用 vendor CLI 自身登录,是合法的一跳(典型用法:官方订阅额度优先,耗尽后切第三方 provider)。二者不能在同一次 run 内切换——跨越这条边界由启动段与会话游标承担(§8.4)。

配置示例:

```jsonc
// 三个 claude agent 归入同一组 "fast"，优先级由 order_seq 决定
{ "id": "a1", "vendor": "claude", "group": "fast", "order_seq": 0, "config": { "baseUrl": "…deepseek…/anthropic", "model": "deepseek-v4-flash" } }
{ "id": "a2", "vendor": "claude", "group": "fast", "order_seq": 1, "config": { "baseUrl": "…moonshot…/anthropic", "model": "kimi-k2" } }
{ "id": "a3", "vendor": "claude", "group": "fast", "order_seq": 2, "config": { "baseUrl": "…mimo…/anthropic",     "model": "mimo" } }
// ⇒ 产生虚拟 group agent  _c3_claude_fast (vendor=claude)
// 另有 codex agent 也可复用 "fast" 名 ⇒ 产生独立的 _c3_codex_fast
{ "id": "c1", "vendor": "codex",  "group": "fast", "order_seq": 3, "config": { "baseUrl": "…deepseek…", "model": "deepseek-chat", "wireApi": "chat" } }
```

## 7. Group Agent 虚拟引用

### 7.1 虚拟 id 与枚举

- 虚拟 group agent 的引用 id 形如 **`_c3_<vendor>_<group>`**(保留前缀 `_c3_` + vendor 段 + group 段;vendor 取自闭集 `VENDOR_IDS`,故 group 名本身可含下划线——`_c3_<vendor>_` 之后整段为 group)。用户配置的真实 agent id 不得以 `_c3_` 前缀开头——normalize 告警。
- 在"可选 agent"枚举里(default / tool / intent / spec / automation agent 选择、session 绑定、session 标题栏 agent 切换器等所有 agent 选择点),除真实 agent 外,**为每个 `(vendor, group)` 追加一个虚拟 group agent**:
  - `id = _c3_<vendor>_<group>`,`displayName = 同 id`(带前缀,便于与真实 agent 区分),`vendor = 组 vendor`。
  - 虚拟 agent 只用于**引用与展示**,不可编辑、不落盘为真实 agent。

### 7.2 resolve:从引用到候选列表

现有 `resolveAgent(id): AgentConfig` 返回单个 agent;新增候选解析,统一被 launch 使用:

解析的唯一入口是 `resolveAgentTarget(ref)`,它同时产出**绑定身份**与**代表成员**,避免调用方从"单个 agent"反推该绑定什么:

```ts
resolveAgentTarget(ref: string | null, cursor?: string | null): AgentTarget
//  { ref, agent, candidates, isGroup }
//  真实 id                → ref = 该 id，candidates = [该 agent]（长度 1）
//  _c3_<vendor>_<group>   → ref = 组引用，candidates = 该 (vendor, group) 内 enabled agent 按 order_seq 升序，
//                           并以 cursor 指名的成员为环形起点（§8.4；cursor 为空或已离组 ⇒ 自然顺序）
//  空（角色"跟随默认"哨兵）/ 未知 id
//                         → 跟随 defaultAgentId，对其套用上面两条规则；默认值本身是组时按组解析
//  默认值也不可用          → 系统 agent，否则合成兜底（设置整体为空/损坏时的最后防线）
//  组内无 enabled 成员      → 抛 AgentGroupUnavailableError（携带出错的组引用），不回退
```

- `ref` 是**要持久化的路由身份**:组保持组引用(每次 run 重新展开、重新从最高优先级 failover),具体 agent 存解析后的真实 id。
- `agent` 是**代表成员**:vendor、展示信息、默认模式与首次启动参数全部由它派生,因此绑定不可能出现"组引用 + 另一个 agent 的 vendor"的分裂状态。
- `resolveAgent` 保留为"单个代表 agent"视图(展示 vendor、model 占位),即 `resolveAgentTarget(ref).agent`。
- **空组不回退**:组内无 enabled 成员是可操作的配置错误,解析抛错而非降级到默认/System。`tryResolveAgentTarget` / `tryResolveRoleAgentTarget` 是不抛版本,供两类调用方使用:会话创建路径据此**明确拒绝**(见 §7.4),展示/投影读取据此保持可渲染(`resolveAgentVendor` 从组引用自带的 vendor 段取值)。
- `resolveSessionLaunch` / `resolveToolSessionLaunch` 等改为:解析候选列表 → 见 §10。

### 7.4 角色引用与会话绑定

default / tool / intent / spec / spec-review 五个角色共用 `resolveRoleAgentTarget(role)`——同一套规则,不允许各自复制或改变:

- 角色字段直接配组,与"角色字段为空 + 默认值是组",解析结果完全一致(同一 `ref`、同一代表成员、同一候选序)。
- 新建 work / 意图沟通 / 规格编写 / 规格审查会话时,pending intent 与 `session_metadata.agent_id` 保存完整组引用;`vendor` 取同一次解析的代表成员。首次运行冻结绑定时同样保留组引用与该组锁定的 vendor。
- **组不可用 ⇒ 拒绝创建**。"不可用"包含两种:组内无 enabled 成员;组所属 vendor 的宿主运行时不存在(该 vendor 门槛只作用于组,具体 agent 维持原有可用性提示语义)。判定发生在任何副作用之前——不留 pending intent、运行时、投影行,也不切换当前视图——服务端返回结构化错误码 `agent.groupUnavailable`(携带组引用),Web 以全局 toast 呈现并释放启动遮罩。
- **重新打开已有会话不受影响**:已冻结的会话沿用自身绑定与 vendor;组解析失败只影响创建与首次绑定,不阻断读取历史会话。
- 只有**设置整体为空/损坏**时才合成 System 兜底;"组为空"不属于此列。

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

- **请求级无粘性**:每个请求都从 token 绑定候选列表的首项重新开始。跨 run 的粘性由会话游标承担(§8.4),它决定的是这次 run 绑定了哪一段候选,而非段内的尝试顺序。

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

### 8.4 启动段与会话游标(跨段 failover)

provider 端点在 spawn 时就写进子进程 env(`ANTHROPIC_BASE_URL`、codex 的 `model_provider`),一次 run 无法在"走 relay 的 custom 候选"与"用 CLI 自身登录的 system 成员"之间切换。因此候选列表按 relay 可达性切成**启动段**:

- `launchSegment(candidates)`:首项可 relay ⇒ 取首项及其后紧邻的连续可 relay 候选;首项不可 relay(`system`、无 provider 三元组的 vendor、`baseUrl` 为空)⇒ 只取首项,该 run 用 CLI 自身登录。
- **首项一定被使用**。若改为"收集全部 custom 候选",一个排在最前的 `system` 成员会被静默跳过,可见顺序就不再等于实际运行的 agent。
- 段内 failover 由 relay 负责(§8.1/§8.2),段边界由**会话游标**跨越。

会话游标 `SessionAgentFact.groupCursor`(state.json,类比已冻结的 `vendor`/`storeScope`,但它是可变的):

- 记录**下一次启动从组内哪个成员起算**,仅在绑定为组引用时有意义。
- `resolveSessionLaunch` 读它,把成员列表旋转成以该成员为首,再取启动段。
- run 因**可降级错误**失败(与 `isDegradableError` 同一口径,即 `agent:error` 事件的 `degradable`)时,游标推进到刚跑完那一段之后的成员;resume 或下一次 run 即落在下一个候选上。
- 组是**环**:推进越过末尾回绕到首项,会话不会被困在耗尽的尾部。游标指向已离组/被删除的成员时退回自然顺序。
- 重新绑定 agent(`changeSessionAgentFact`)清空游标——它索引的是旧绑定的成员序。
- 配额类失败另有专门通路:该成员被禁用直到重置时刻,于是它整个从组里消失,与游标机制正交。

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

`launchForAgent(agent)` 从"按 vendor 注入真实连接"改为"产出候选列表 + 由 spawn 点接 relay"。**register 不在 launch 层做**——`launchForAgent`/`resolveSessionLaunch` 会被非启动场景反复调用(vendor 探测、展示),在此 register 会泄漏 token;register 落在真正 fork 子进程的三个点。

- 新增 `launchForCandidates(candidates: AgentConfig[]): LaunchOverrides`(单 agent 是长度 1 的候选,`launchForAgent = launchForCandidates([agent])`)。它只服务候选列表的**启动段**(§8.4),是**纯数据**:
  - `relayCandidates?: RelayCandidate[]`——启动段内各候选的真实上游 `{baseUrl, apiKey, model, wireApi?}`(codex 带 `wireApi`,claude 不带)。首项是 `system`/无 provider 配置时该段长度为 1 且不产生 relay 候选,run 用 CLI 自身登录。
  - `model` = 段首候选 model(CLI 固定占位;relay 转发时按命中候选覆盖)。
  - `envOverrides` 只含**非机密** env(代理变量、claude 第三方 `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING` workaround)——**真实 key 不再进 env**。
  - `contextWindow?` / `maxOutputTokens?`——**codex-only** 可选能力字段(2026-08-08-013),取自启动段**首个 relay 可达成员**(codex)的 `config`,经 `DriverStartOptions` 送到 codex driver:配置时 driver 的 relay 分支为该模型 id 注册本地 model catalog(消「Model metadata not found」fallback);未配置(`undefined`)时不生成 catalog,行为保持现状。system 成员(无 relay 候选)不产生这两个字段;claude/cursor 忽略。
- **register/unregister 落在三个 spawn 点**(生命周期各自自持):
  - **codex driver**:`opts.relayCandidates` 存在 + relay 就绪 ⇒ `relay.register(candidates)` → token 作 `CODEX_API_KEY`;`base_url = relay.endpoint('codex')`;`CODEX_RELAY_PROVIDER` provider(`wire_api=responses` + `supports_websockets=false`);run 结束/abort `unregister`。
  - **自定义模型 catalog 注册**(2026-08-08-013):codex 内置 metadata catalog 不认识三方模型 id(如 `deepseek-v4-flash`),无注册时每次 relay 运行都 fallback 默认元数据(「Model metadata not found」告警,能力错配)。配置了能力字段时,codex driver 的 relay 分支用 `adapters/codex/model-catalog.ts` 生成一份**最小合法 catalog JSON**(只注册 CLI 启动模型 id = 启动段首候选 `model`,候选间能力差异无法逐候选声明),经 `model_catalog_json` 顶层配置键交给 codex——展平成 `--config model_catalog_json=<path>`,与 `model_provider`/`mcp_servers` 同一通道。**落盘位置随运行形态**:宿主运行落 `os.tmpdir()`;arapuca 沙箱运行落 `DriverStartOptions.sandboxTmpDir`(allow set rw 目录——宿主机 OS tmpdir 不在 allow set 内,沙箱内 codex 读不到会启动报错);`sandboxTmpDir` 缺失时**丢弃 catalog + console.warn,绝不写 allow set 外**。文件随运行 `finally` 清理(成功/错误/abort),与 prompt-image 临时文件同生命周期。目录的必填字段集是 0.146.0 serde 实测快照,codex 升级时按 `doc/architecture/sdk-upgrade/` 既有流程复查。
  - **claude 常驻路径**(`run-lifecycle` 每次 attempt)与**一次性 advisor**(`agent-once`)/**讨论**/**automations claude 分支**:调用 `bindClaudeRelay(candidates)` → `relay.register` → 注入 `env.ANTHROPIC_BASE_URL = relay.endpoint('claude')`、`env.ANTHROPIC_API_KEY = env.ANTHROPIC_AUTH_TOKEN = token`、`NO_PROXY += 127.0.0.1,localhost,::1`;attempt/turn 结束 `unbindRelay(token)`。
  - relay 单例经 `kernel/relay/runtime.ts` 的 `setRelay/getRelay` 在组合根注入,供 claude 路径与 advisor 读取;codex driver 仍走注入句柄(便于测试)。
- `wireApi` 不再在 LaunchOverrides 里区分 direct/relay——**所有 codex custom 都走 relay**;`wireApi` 下沉为**候选级**属性(每候选 chat 还是 responses,决定 relay 内部翻译 vs 透传)。
- `resolveSessionLaunch` / `resolveToolSessionLaunch` / `resolveDegradationAgent`:改为 `resolveAgentCandidates(ref)` → `launchForCandidates`;group 引用 `_c3_<group>` 保持为 session 绑定的 agentId,每次 run 重解析。会话路径额外读入该会话的组游标(§8.4),从游标成员起算而非恒定从组首。

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

- **Phase A — relay 泛化(已完成)**:`transport/codex-relay` → `transport/relay`(vendor 中立);kernel handle 泛化为 `kernel/relay/contract.ts` 的 `Relay`(`register(candidates)` / `unregister` / `endpoint(vendor)`);端点按 vendor 拆分(`/internal/relay/v1/codex/responses`、`/internal/relay/v1/anthropic/v1/messages`)+ codex 旧端点别名 `/internal/codex-relay/v1/responses`。
- **Phase B — claude 走 relay(已完成)**:新增 anthropic 透传(`anthropicHandler`,auth 换发 + model 覆盖);claude 常驻路径 / 一次性 advisor / 讨论 / automations claude 分支经 `bindClaudeRelay` 指向 relay + 传 token;`launchForAgent` claude 分支不再注入真实 baseUrl/key。
- **Phase C — group 配置(已完成)**:`AgentConfig`/`baseShellSchema` 加 `group?`;`lockGroupVendors` 组化 + 首 agent 锁定组 vendor + 异 vendor 告警;`_c3_` 前缀保护(`GROUP_AGENT_PREFIX` + `groupAgentRef`/`isGroupAgentRef`/`parseGroupAgentRef`)。
- **Phase D — resolve + failover(已完成)**:`resolveAgentCandidates` / `groupAgents` / `launchForCandidates`;relay 候选列表首字节前 failover(连接失败 / 5xx / 429 切下一个,其它 4xx 透出)+ 命中候选 model 覆盖;连接级失败判定复用 `isDegradableError`。
- **Phase E — UI/协议(已完成)**:SettingsPanel agent 编辑增 `group` 文本字段(makeAgent/setVendor 保留);客户端 `lib/group-agents.ts` 派生虚拟 group agent(`_c3_<vendor>_<group>`,不同 vendor 可同名各成一组);各 agent 选择器(SettingsPanel 默认/工具/意图/spec/automation 下拉、NewSessionModal、AutomationForm)以 `<optgroup>` 列出 group agent,选项显示带前缀 id;**session 标题栏 agent 切换器**候选含同 vendor group agent(可切换到组);`freezeSessionAgent`/`setSessionAgent`/`resolveSessionAgentSwitch`/`resolveDefaultAgentId` 保留并展示 `_c3_<vendor>_<group>` 虚拟 id(组绑定每次 run 重解析)。i18n 键补全 5 语言。
