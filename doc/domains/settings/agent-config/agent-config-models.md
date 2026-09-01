# agent-config — 数据模型

实体定义。业务语义字段契约;物理接线见 [agent-config-design.md](agent-config-design.md)。
线上格式统一定义在
[共享协议](../../../shared/api-conventions/websocket-protocol.md)中。

## Agent(智能体)

一个启动档案:一个厂商无关的**公共外壳**加上一个按 `vendor` 判别的 `config`
子对象(AC-R12)。智能体配置是一个以 `vendor` 为键的判别联合类型;负责校验并路由它的
运行时 schema 通过编译期断言与线上格式绑定一致。

### 公共外壳

- **`id`**(text): 稳定 id;内建智能体固定为 `'system'`
- **`displayName`**(text): 展示名称
- **`enabled`**(bool,可选): 启用标志;缺省/`true` ⇒ 启用,只有显式 `false` 才禁用。禁用的智能体会从所有列表消费方(参与者、投票者、降级链、默认选择器)中退出,但仍可作为有效的启动兜底(AC-R10)
- **`icon`**(text,可选): 可选展示图标(表情符号/短文本)。空/缺省 ⇒ 无自定义图标。会被去除首尾空白并截断到 16 字符;不校验是否为真实的表情符号。没有该字段的配置加载为 `''`(AC-R11)
- **`providerId`**(text,可选): 引用一条 [ModelProvider](#modelprovider模型提供方) 的 id;绑定时按本 vendor 的协议支持列表取第一个有 URL 的槽作为上游(base URL / 账户 key / openai 的 wireApi)。为空 ⇒ 使用 vendor CLI 自身登录态。cursor 永不携带该字段。悬挂引用(指向不存在的 provider)fail-soft 回落并告警,不阻断启动
- **`modelOverrides`**(列表,可选): 逐模型的能力覆盖 `{ model, contextWindow?, maxOutputTokens? }`。运行时按 agent 选中的 `config.model` 匹配一条生效,优先于 provider 的模型目录
- **`configMode`**(`'system' | 'custom'`): **只读派生字段**,不是独立的状态源。规则:cursor 恒 `'system'`;`providerId` 非空 ⇒ `'custom'`;否则 `'system'`。残留的 `config.baseUrl`/`apiKey` 不参与派生
- **`group`**(text,可选): 分组名。非空 ⇒ 该 agent 归入 `(vendor, group)` 组;相同 `(vendor, group)` 的 enabled agent 按 `order_seq` 优先级构成一个可 failover 的候选集,暴露为虚拟 group agent `_c3_<vendor>_<group>`。虚拟引用编码 vendor,故**不同 vendor 可复用同一分组名**(各成独立组)。成员可混 `custom` 与 `system` 配置模式。为空/缺省 ⇒ 不参与任何组,控制台把这批 agent 归入名为 `default` 的容器展示。设计见 [relay-architecture](../../../architecture/relay-architecture.md) §6–§8

### Claude 配置子对象(`vendor === 'claude'`)

`baseUrl`/`apiKey` 是**未使用的残留字段**:连接只来自 `providerId` 指向的
provider 或厂商 CLI 登录。归一化在加载/保存时把它们写成空串;schema 仍要求这两个字符串,
以便旧记录能解析。`model` 与连接来源无关,任何一态下都是独立覆盖项。

| 属性      | 类型 | 说明                               |
| --------- | ---- | ---------------------------------- |
| `baseUrl` | text | 残留;归一化写成空串。不是连接来源  |
| `apiKey`  | text | 残留;归一化写成空串。不是连接来源  |
| `model`   | text | 模型别名或 id;为空 ⇒ 不覆盖(AC-R5) |

### Codex 配置子对象(`vendor === 'codex'`)

厂商中立的三元组加上 `wireApi`。Codex 的启动时策略闸门
(`sandboxMode`/`approvalPolicy`)**不**持久化在这里——它是在启动时根据
会话 `defaultMode` 通过中立映射表推导出来的(2026-06-06-008)。

- **`baseUrl`**(text): 残留;归一化写成空串。不是连接来源
- **`apiKey`**(text): 残留;归一化写成空串。不是连接来源
- **`model`**(text): 模型别名或 id;为空 ⇒ 不覆盖
- **`wireApi`**(`'responses' | 'chat'`): 残留的线上协议字段。连接解析读 provider 上的同名字段(缺省 `'chat'`),不读此处。schema 仍要求该字段,缺省的记录读为 `'chat'`。所有 custom codex 都走 relay(ADR-0029),provider 上的 `wireApi` 是**候选级**的 relay 内部适配选择:`'chat'` ⇒ 仅支持 Chat-Completions ⇒ relay 做 Responses↔Chat **翻译**;`'responses'` ⇒ 厂商原生 Responses ⇒ relay **透传**(仅换 key、覆盖 model)。与 `system` 模式的 codex 无关(无 custom 上游 ⇒ codex 自身登录)。见 [relay-architecture](../../../architecture/relay-architecture.md) §9。
- **`contextWindow`**(正整数,可选): 模型的上下文窗口(token)声明,能力解析链中优先级最低(agent `modelOverrides` > provider 模型目录 > 此处)。仅在有上游连接(codex 走 relay)时消费:codex driver 的 relay 分支把它与 `maxOutputTokens` 一起注册进本地 model catalog(`model_catalog_json`),让 codex 不再对三方模型 id 回退默认元数据(消「Model metadata not found」告警)。缺省 ⇒ 不生成 catalog。请按模型**真实能力**填写——值大于真实窗口可能引发上游截断/报错。见 [relay-architecture](../../../architecture/relay-architecture.md) §10。
- **`maxOutputTokens`**(正整数,可选): 模型单次输出上限(token)声明,与 `contextWindow` 同一机制。注意:**`max_output_tokens` 被 codex serde 接受,但是否被实际消费为生成上限未经真实上游验证**,当前仅作声明、**尽力而为**,不保证截断行为;不受支持时该声明无副作用。

> **数值边界告警**:`contextWindow`/`maxOutputTokens` 必须为正整数;`0`/负数/非整数会让 `codexConfigSchema` 校验失败,`parseAgentConfig` 返回 `null`,**整个 codex agent 被 normalize 按 fail-soft 策略从注册表丢弃**(与重复 id 同策略),会话回退到默认 agent。手改存储里的数值填错会导致该 codex agent 静默消失——这是既有 fail-soft 行为,不是「该字段被忽略」。

### Cursor 配置子对象(`vendor === 'cursor'`)

只有一个 key 和一个 model,**没有 `baseUrl`**:c3 没有讲 Cursor 协议的 relay,
故 Cursor 智能体不能被指向别的 provider,`configMode` 恒为 `'system'`(schema 拒绝
携带 `baseUrl` 的配置,手改存储里的 `'custom'` 在加载时被钉回 `'system'`)。
`apiKey` 是**可选**的:填了就用,留空则由 `cursor-agent login` 写入操作系统钥匙串的
登录态兜底,与其他厂商的 `system` 模式含义一致。

- **`apiKey`**(text): Cursor API key。为空 ⇒ 回落到服务端环境变量 `CURSOR_API_KEY`;两者皆空 ⇒ 运行在启动处即以可行动错误失败(同时点名这两处)
- **`model`**(text): 模型别名或 id(如 `auto`、`claude-4.5-sonnet`);为空 ⇒ 沿用 Cursor 的 `auto`

关系:零个或多个 Session(会话)绑定到一个 Agent;未绑定的会话使用默认智能体。

## ModelProvider(模型提供方)

一条**具名上游连接**,任意多个 agent 通过 `providerId` 共用。凭证从 agent 上提到这里,
轮换 key 或迁移端点就只改一条记录,而不是逐个 agent 改。持久化在 `system_configs` 的
`modelProviders.<id>.*` 键空间。

- **`id`**(text): 稳定 id,铸造规则与 agent id 相同(AC-R3);归一化提起残留内联三元组时用由三元组派生的确定性 id(`mp-<hash>`),与手工创建的可区分
- **`displayName`**(text): 展示名称(去首尾空白)
- **`template`**(text,可选): 创建时所用目录模板的 id。纯创建溯源,运行时从不读取
- **`vendor`**(Provider Vendor,可选): 上游厂商身份,取值 `anthropic` | `openai` | `deepseek` | `moonshot` | `doubao` | `zhipu` | `openrouter` | `custom`。见 [Provider Vendor 与模型清单](#provider-vendor-与模型清单)
- **`apiKey`**(text): **账户级** key,覆盖本 provider 上所有协议 URL;落库为 `secret` 类型
- **`urls`**(map `protocolType → string`): 逐协议风格的上游 base URL。`protocolType` 为 `openai` | `anthropic`(上游文档所说的兼容风格,不是 c3 的 VendorId)。非空才算该协议已连接
- **`wireApi`**(`'responses' | 'chat'`,可选): 仅 `urls.openai` 有意义;缺省按 `'chat'` 处理
- **`models`**(列表,可选): 本 provider **自有**的模型条目 `{ id, contextWindow?, maxOutputTokens? }`,是对内置清单的补充与覆盖。提供方表单只编辑 `id`(展示为模型名称),每条与删除按钮同一行;`contextWindow`/`maxOutputTokens` 仍被 schema 接受并参与能力解析,但不在表单上暴露
- **`paused`**(bool,可选): 运维暂停。为真时引用它的 agent 在启动处明确失败(而不是稍后以晦涩的鉴权错误暴露);可恢复,数据不丢

### Provider Vendor 与模型清单

`vendor` 声明这条上游是谁,`template` 只记录它由哪个目录模板创建:前者被持续读取以决定模型
建议,后者创建后再不读取。两者因此分开——自建端点可以认领一个已知厂商而不被重置连接字段。
归一化只从**已知的 template id** 推断身份,绝不从展示名或 URL 猜;缺失、空白、以及更新版
c3 写下的未知 id 一律读为 `custom`,provider 本身连同 key、URL、自有条目完整保留。
`custom` 与暂无内置条目的厂商都只是「没有内置建议」,不是错误。

每个已知厂商的模型清单随 c3 版本内置在 `shared/src/model-provider-catalog.ts`,发布维护时对
照厂商官方 API 文档核验,运行时**不发任何网络请求**去发现模型。内置条目只有模型 id:上下文
窗口一类的能力元数据由运维在自有条目上声明,猜大了会引发上游截断或报错。

**有效模型清单** = 内置条目 + 自有条目,按去空白后的 id 去重,空 id 丢弃;同名以自有条目为准
(保住运维填的能力元数据),但留在内置条目的位置上,故顺序只取决于厂商与自有条目的次序。
它是**建议**:agent 表单的 model 输入始终是自由文本,清单外的 id 照样保存;它不校验、不作运行
时兜底、不是白名单。运行时能力解析仍走既有优先级(agent `modelOverrides` > provider 模型条目)。
换 vendor 只替换内置那一半,不动自有条目、名称、key、URL、wireApi、暂停位,也不动任何 agent 的模型。

### ProtocolType 与 vendor 支持列表

每个 vendor 有一份**有序**的默认协议支持列表;agent 绑定 provider 时按该列表取**第一个**在 `urls` 中有非空 URL 的协议,从而得到 baseUrl:

- `claude` → `['anthropic']`
- `codex` → `['openai']`
- `cursor` → `['openai', 'anthropic']`(列表已声明;当前仍无讲 Cursor 协议的 relay,故 cursor agent 仍不绑定 provider)

关系:一个 provider 被零个或多个 agent 引用;一个 agent 至多引用一个 provider。

## System Agent(系统智能体)

内建智能体。与 Agent 使用相同的外壳,但其 id 为 `'system'`,vendor 为 `'claude'`,且其
配置始终是该厂商的**默认值**(对 claude 而言是全空——AC-R1)。始终存在,永不可
移除。它的 enabled 标志**会**被遵守,所以系统智能体也可以像其他智能体一样被禁用
(AC-R10)——禁用后它会退出各列表消费方,但仍作为启动兜底。它的 icon
字段同样会被遵守——系统智能体上的自定义图标会在归一化过程中保留
(AC-R11),这与 AC-R1 的“配置归零”是独立的两回事。

## System settings(系统设置)

整个配置,持久化在 `system_configs` 的 `agents.<id>.*` 键空间。

- **`agents`**(智能体列表): 注册表;始终包含系统智能体(AC-R1)
- **`modelProviders`**(provider 列表,可选): 具名上游注册表;缺省/空 ⇒ 没有 provider(各 agent 走 CLI 登录态)
- **`defaultAgentId`**(text): 某个已存在智能体的 id;找不到时回退到系统智能体(AC-R2)
- **`toolAgentId`**(text): 运行后台工具会话(完成度判定、自动化/会话命名推导;异常处理尚未由智能体驱动)的智能体 id。空字符串 ⇒“跟随默认智能体”(存储时保持为空);一旦设置了非空值,会像默认值一样按顺序号回退(AC-R21)。
- **`intentAgentId`**(text): 运行意图沟通会话(意图分析师的需求拆解对话)的智能体 id。空字符串 ⇒“跟随默认智能体”(存储时保持为空);一旦设置了非空值,会像默认值一样按顺序号回退(AC-R23)。
- **`specAgentId`**(text): 运行规格编写会话(编写/完善项目规格)的智能体 id。空字符串 ⇒“跟随默认智能体”(存储时保持为空);一旦设置了非空值,会像默认/工具/意图智能体一样按顺序号回退(AC-R24)。
- **`defaultMode`**(权限模式,可选): 新会话启动时所处的权限模式;为五种权限模式取值之一,找不到时回退到 `default`(AC-R8)。为 session-registry 中新会话的模式做种(SR-R6)。
- **`consensus`**(`{ enabled }`,可选): 权限提示上的多智能体共识投票;默认关闭。由权限网关消费——见 [consensus](../../core/permission-gateway/features/permission-gateway-consensus.md)。
- **`maxRoundsPerStage`**(number,可选): 多智能体讨论每阶段的轮次上限;归一化为 ≥ 8,默认 12(AC-R9)。由讨论引擎消费。
- **`timezone`**(text,可选): 用于解释每个自动化的 cron 字段的系统级 IANA 时区(例如 `Asia/Shanghai`);无效/未设置时回退到服务器本地时区。由 [automations](../../core/automations/automations-design.md) 引擎消费——见 SCH-R3a。

## Session binding(会话绑定,`session_configs`)

按会话的智能体绑定——一个**双键空间**(ADR-0015,AC-R16/R17),与
session-registry 自身的状态是分离的。

- **`version`**(`2`): Schema 版本(v1 单一 map 的旧数据在首次读取时迁移)
- **`pendingIntents`**(map `pendingId → { agentId, createdAt }`): **意图**——尚未运行的会话所期望的智能体;可变,无厂商信息;由清理任务在 7 天后回收(AC-R17)
- **`sessionAgents`**(map `realId → { agentId, vendor }`): **事实**——某个真实会话实际运行所用的智能体 + 其被冻结的 `vendor`;缺失该条目 ⇒ 使用默认智能体(AC-R4/R16)

### Session binding 实体

| 实体     | 属性        | 类型      | 说明                                                       |
| -------- | ----------- | --------- | ---------------------------------------------------------- |
| 待定意图 | `agentId`   | text      | 该待定会话希望据以启动的智能体                             |
| 待定意图 | `createdAt` | number    | 该意图首次被记录时的毫秒时间戳——用于驱动清理任务的过期判断 |
| 会话事实 | `agentId`   | text      | 实际运行所用的智能体(已应用默认兜底)                       |
| 会话事实 | `vendor`    | vendor id | **被冻结**的厂商;允许同厂商内的智能体互换,不允许跨厂商     |

关系:一个待定意图在首次绑定时会转变为**至多一个**会话事实(随后被
删除);一个事实的 `vendor` 在该会话的生命周期内不可变。
