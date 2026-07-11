# 0013 — 线路上的规范信封 + c3 会话命名空间内部化

- **Status:** accepted
- **Date:** 2026-06-06

## Context

ADR-0011 引入了厂商中立的规范消息模型,但它只存在于内核适配层内部。两个后续问题被留了下来:

1. **中立信封应该归属于哪里?** 如果每个厂商的消息都映射到各自的 wire 形态,wire 就会为每个
   厂商多长出一套 schema,前端也要学习三套消息模型。010 的字段 diff 已经证明存在一个共同的
   信封;它应该是唯一跨越 wire 的形态,只增加一个 `vendor` _维度_,而不是一套并行 schema。
2. **会话如何跨厂商命名?** Claude 按 JSONL 为 transcript 加键(在厂商名之下),这使命名空间与
   厂商耦合,一个会话无法被中立地寻址。原生存储必须保持为事实来源,c3 不能变成每份 transcript
   的第二份拷贝。

第三个、较小的问题:两个厂商的消息*形态*不同。Claude 每帧发出一条完整消息;Codex 发出原地修订
早前条目的增量更新帧。一个天真的仅追加式消费者会为增量形态重复出 block。

## Options considered

1. **信封留在内核里;按厂商映射到各自定制的 wire 事件。** _Con:_ wire 上为每个厂商多一套
   schema;前端按厂商分支;010 得出的"存在一个共同信封"的结论在边界处被丢弃。
2. **把信封提升到 wire 上;持久化一个 c3 会话注册表,映射 c3 id ↔ 厂商 id。** _Con:_ 一个
   持久化的注册表是第二个存储,必须与每个厂商的原生存储保持同步——双写、漂移、迁移面,这恰恰是
   "原生存储即事实来源"想要避免的。
3. **把信封提升到共享协议定义(内核重新导出);让 c3 id 成为一个由只读惰性访问器解析的、确定性的
   无厂商摘要。** 信封在 wire 上只定义一次(不含 SDK);内核重新导出它,使既有消费者不受影响。
   c3 会话 id 是对厂商和厂商会话 id 的一次哈希——跨重启稳定(无需持久化),且既不包含厂商名也
   不包含原始 id 作为子串(URL/存储安全)。一个只读访问器包裹各厂商的会话存储,按需归一化
   listing,并从这些 listing 中惰性构建 c3-id → 厂商引用的索引。Block 更新按 (会话 id, block
   id) upsert,因此两种厂商形态都收敛到同一条规则。

## Decision

采纳方案 3。

- **线路上的规范信封。** 厂商 id、适配器能力集、规范角色(role)、规范工具结果、规范 block、
  规范消息在共享协议定义中只定义一次——零运行时、不含 SDK(ADR-0009)。内核适配层重新导出它们
  (单一事实来源)。wire 在一个信封上增加一个 `vendor` 维度;它**不**开启一套按厂商的 schema。
- **D-A —— 保留内嵌工具结果。** 011 的 D3 裁决维持:**没有**独立的 tool-result block;一个
  工具的返回值按 id-upsert 折叠进 tool-use block 的 result 字段。三厂商共同的 block 集合是
  text / thinking / tool-use。其他厂商特有的形态**不**被提升为各自的 block 变体(目前没有
  适配器产出它们——宁丢勿强塞)。一个未来的、按厂商标签区分的转义变体是这条扩展点。
- **双形态 upsert。** 规范累加器按 (会话 id, block id) 为 block 加键并 upsert:一个同 id 的
  block 原地修订,一个匿名(无 id)的 block 追加,一个工具结果单调地回填它所属的 tool-use
  block(一次更晚的、仅有输入的修订永远不会抹掉已经到达的结果)。Claude 的整条消息形态与 Codex
  的增量形态收敛到同一个归一化视图。
- **D-C —— c3 会话命名空间内部化。** c3 会话 id 是不透明的(一个不透明前缀加上对厂商和厂商
  会话 id 的一次哈希),确定性,且无厂商信息——它是唯一跨出内核的 id。厂商会话引用(厂商 +
  厂商会话 id)留在内核内部。会话访问器是各可用厂商会话存储之上的一个**只读**联合体:listing
  跨厂商合并(原生 id 隐藏在一个 vendor-extra 字段里,从不出现在顶层),读取通过一个惰性构建的
  c3-id → 厂商引用索引路由到所属存储。**没有双写:** 原生存储是事实来源;索引是一个派生的、
  运行时缓存,由 listing 重建,而不是会话内容的第二份拷贝("存储形态归一、位置不归一")。
- **Approval 不进入消息模型。** Approval / permission 事件**不是**规范消息——它们走
  approval-bridge 流,因此信封永远不会变成一个上帝类型。

本阶段止步于内核 + 共享类型 + 只读访问器,它**不**重新接线线上的 wire 帧、Claude 运行路径,也
不涉及 web 的 URL/存储层(web 目前只把会话 id 存在内存里,所以没有迁移债务)。

## Consequences

- **Easier:** wire 上只有一个信封;前端学习单一消息模型,带一个 `vendor` 标签。一个新厂商把
  自己的消息映射到同一个形态,把自己的会话映射到同一个访问器——不需要新的 wire schema,不需要
  新的 id 命名空间。
- **Honest storage:** 原生存储仍然是唯一的事实来源;c3 只拥有一个派生的、可重建的索引——没有
  同步/迁移面,没有双写。
- **URL/storage safety:** 厂商 id 永远不会泄漏进 URL 或存储键,因为唯一暴露出去的句柄是一个
  不透明摘要。
- **Boundary:** 共享协议定义和适配层保持不含 SDK(ADR-0009);访问器只依赖中立的会话存储抽象。
- **Deferred:** 把信封/c3 id 接线进线上的 wire 帧、前端,以及 URL/ 针对中立 reducer 的合成
  帧);显式的 `reasoning`/`diff` block。

## Compliance

- 共享协议定义以及内核适配层 + 会话层(不含 Claude 专属适配器)**不得** import 任何厂商 SDK
  类型。
- 铸造一个 c3 会话 id **必须**是确定性的,其输出**不得**包含厂商名或原始厂商 id 作为子串;由一个
  访问器测试钉住。
- Block upsert **必须**原地修订同 id 的 block(不产生数组增长),**不得**在一次更晚的、仅有
  输入的修订上抹掉已到达的工具结果;由一个累加器测试钉住。
- 会话访问器**必须**是只读的,并使用**原生** id(从不是 c3 id)把读取路由到所属的厂商存储;
  由一个访问器测试钉住。
- 内核重新导出**必须**保持既有消费者行为等价:既有适配器测试与 Claude 适配器测试保持为绿。
- Typecheck、lint 以及服务端测试套件**必须**为绿。

## References

- [ADR 0011](0011-vendor-neutral-agent-abstraction.md) —— 本 ADR 把规范消息模型 + D3 内嵌
  结果裁决提升到 wire 上。
- [ADR 0012](0012-host-binary-probe-first-capability-gate.md) —— 可用适配器解析产出会话访问器
  所包裹的厂商列表。
- [ADR 0009](0009-unidirectional-boundaries.md) —— 共享层与适配层遵守的不含 SDK 边界。
- [ADR 0004](0004-persist-workspace-session-registry.md) —— c3 命名空间最终将要面向的
  工作区/会话注册表(推迟)。
- [agent-session domain spec](../../domains/core/agent-session/agent-session-spec.md) ——
  信封/命名空间规则。

---

## Amendment:统一的 `session_metadata` 投影表(2026-06-07;2026-06-28 泛化)

跨厂商的 `list_sessions` 路径,从一次按请求扇出重写为直接读取 c3 运行时数据库中的一张会话
元数据投影表,读取上文的访问器联合体。2026-06-28,原先的 `work_session_metadata` 表被原地
改名为 `session_metadata`,并被泛化为承载六种业务会话类别:work、intent、spec、discussion、
automation、tool。本 amendment 记录这份契约。

### 投影表契约

会话元数据投影是一个**可重建的缓存**,而不是会话内容的第二份拷贝。原生/厂商存储以及每个领域
自己的业务表,仍然是会话*内容*与归属事实的事实来源。这份投影只承载用于读侧聚合的
寻址/生命周期元数据:

| Field             | Purpose                                                                                                                          |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| c3 session id     | 不透明的 c3 会话 id(确定性的无厂商摘要)。主键。                                                                                  |
| workspace         | 这一行所属的工作区;驱动每日读路径的过滤条件。                                                                                    |
| vendor session id | 原生的厂商 id(pending 行可为空)。                                                                                                |
| agent             | 该会话运行所在的 agent(一个绑定事实或一个待处理意图)。                                                                           |
| title             | 展示标题;由惰性校验/运行结束重写。                                                                                               |
| last modified     | UTC 毫秒;对一个真实行(所有厂商,包括 Codex——SR-R13)戳记为绑定时刻,由惰性校验细化为原生 transcript 的 mtime;仅 pending 行为 null。 |
| state             | 生命周期状态(born / alive / stale / orphaned / ghost)。                                                                          |
| state updated at  | UTC 毫秒;驱动 STALE 窗口和预热策略。                                                                                             |
| kind              | 为兼容性保留的旧版绑定标记;读路径忽略它。                                                                                        |
| session kind      | 业务类别:work / intent / spec / discussion / automation / tool。                                                                 |
| owner kind        | 可为空的逻辑归属者类别(当前为 intent / discussion / automation),供客户端"跳回"规则使用。                                         |
| owner id          | 可为空的逻辑归属者 id。                                                                                                          |
| bound             | 取代 `kind` 的整型布尔值:真实行为 `1`,仅供 work 使用的 pending 占位行为 `0`。                                                    |

**这份投影**从不写入任何 transcript、prompt、工具调用或工具结果内容。由一个字段白名单
正向断言测试钉住。

### Lifecycle states

| State    | Meaning                                                                 |
| -------- | ----------------------------------------------------------------------- |
| born     | 刚被插入;尚未被一次原生 listing 见过。                                  |
| alive    | 由一次最近的原生 listing 写入,或在上一个 STALE 窗口内被其中一次校验过。 |
| stale    | 超过 STALE 窗口(24 小时)未被校验。渲染带一个"Unvalidated"标签。         |
| orphaned | 被确认在原生存储中不存在(预热:2 次 janitor 巡检)。渲染为灰显。          |
| ghost    | 原生存储出错(REST 宕机、transcript 不可读)。渲染带一个"Retry"入口。     |

### Read path

每日的 `list_sessions` 对每个 workspace 和 `session_kind` 单次查询这张投影表。会话页面因此
可以从同一份契约渲染按类别分的 tab 和运行计数徽标。Pending 行(`bound = 0`)从 wire list 中
被排除——每个连接的"正在查看会话"徽标就是这条 pending 条目,而不是一条列表项。本阶段,work、
intent、spec 和 automation 被接到真实数据上;discussion/tool 行仍是留给后续阶段的合法
schema 目标。

一个环境变量开关(默认开启)可以把读路径回滚到旧版仅 Claude 的 listing 路径。

### Write triggers

| Trigger                     | Effect                                                                                                                                                                                                   |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create work session (UI)    | 插入一条 work 类别的 pending 行(ADR-0015 那个意图的新归宿)。                                                                                                                                             |
| Freeze session agent (bind) | 丢弃 pending 行,插入真实行(两条运行路径共用的单一入口点);由 intent 发起的开发会话携带 `owner_kind='intent'` 与 `owner_id=<intent id>`,手动创建的 work 会话保持 owner 为空。                              |
| Intent chat lifecycle       | 为 intent 通信会话 upsert intent 类别的已绑定行;rename/delete 与 intent 会话列表保持镜像同步。                                                                                                           |
| Same-vendor agent swap      | 更新真实行的 agent。                                                                                                                                                                                     |
| Rename session              | 更新真实行的 title。                                                                                                                                                                                     |
| Finalize run (run end)      | 更新真实行的 title(从原生存储解析——与标题栏/janitor 使用**同一个**来源,而不是首次运行时为空的基线;首个用户 prompt 作为兜底)、last-modified 和 agent,然后重新广播列表(异步的原生读取在运行结束后才落地)。 |
| Remove session (delete)     | 删除该行。                                                                                                                                                                                               |

### Freshness & janitor

一次惰性校验会重新核对超过校验窗口(24 小时)的行,对照原生存储;Codex 行被显式跳过。一个每日
janitor(半个 STALE 窗口 = 12 小时)把 born/alive → stale,并在一次预热(2 次巡检)之后,把
stale → orphaned。

### Schema-version rule

这份投影存储**不**写入一个全局 schema-version pragma——三个领域存储(intents、
discussions、session-metadata)会互相覆盖。所有领域存储今后都应遵循这个立场;迁移应基于
每张表各自的列内省加一个增量式的 ensure-column 步骤,绝不基于一个全局 schema-version
pragma。

### Native-is-SoT invariant

当投影与原生存储不一致时(标题不符、会话消失、存储出错),原生存储胜出。投影被刷新,而不是
被偏向。当投影为空时(一次全新安装或一张被删除的表),读路径会透明地从访问器加上已记录的
会话-agent 事实重建,并重新读取;可枚举的厂商如 Claude 和 Codex 都会参与这一次性重建。这份
投影是一个缓存,而不是一道关卡——它从不阻塞 wire。
