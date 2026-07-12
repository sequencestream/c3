# 0015 — 双键会话→agent 绑定 + 冻结的厂商归属

- **Status:** accepted
- **Date:** 2026-06-07

## Context

c3 普通会话领域正在从"100% 只读的 Claude 目录"演进为多 agent / 多厂商。记录一个会话运行在
哪个 agent 上的,曾经是单个映射——会话 id → agent id,存放在内核配置层——以会话当下持有的
任何 id 为键。一个新会话以一个 pending id(SR-R6/SR-R7)开始它的生命,并在它第一次运行时,由
绑定步骤重新以真实会话 id 为键,而这一步只搬运*运行时*状态(缓冲区、观看者、进行中的运行)。
这个绑定映射不携带厂商信息,也从未在绑定时被更新。

由此引出两个问题:

1. **没有厂商不变量。** 一个会话的 transcript **只**存在于它所属厂商的原生存储里(只读的会话
   访问器按厂商路由读取——ADR-0013)。c3 本身**从不存储任何会话内容**。所以一旦一个会话产生了
   transcript,把它重新绑定到一个*不同*厂商的 agent 上,就会读不到任何历史——历史会悄无声息地
   消失。没有任何机制强制这一点。
2. **意图与事实被混为一谈。** 一个 pending 会话的*期望* agent(可变,可能永远不会运行)和一个
   真实会话的*实际* agent(已落定,携带厂商信息)共享同一个映射、同一个键空间。一个从未运行过的
   pending 条目可能永远滞留,而一次绑定也从未把期望的 agent 拷贝进一个持久事实里。

## Options considered

1. **保留单个映射;按需从被绑定的 agent 推导厂商。** _Con:_ agent 记录可以被编辑或删除,所以
   那个"冻结"的厂商会不稳定/不可恢复;没有任何东西区分一个仍然可变的 pending 意图和一个已落定
   的事实,于是被放弃的 pending 条目会不断累积。
2. **两个键空间;在首次绑定时显式冻结厂商(选定)。** 把映射拆成一个可变的 pending-intents
   空间(pending id → 期望的 agent,带一个时间戳)和一个会话-agent *事实*空间(真实 id → 实际
   运行过的 agent + 它被冻结的厂商)。绑定把意图拷贝为一个事实,钉住厂商,并丢弃这个意图。一个
   janitor 清理被放弃的意图。_Pro:_ 这个不变量是持久且自证的;意图消亡永远不会产生一个孤儿
   事实。_Con:_ 一次状态文件 schema 升版 + 迁移。
3. **存储事实但允许厂商变更,配一条 transcript 迁移("replay-seed")路径。** _Con:_ 跨厂商的
   replay-seed 交接被 ADR-0011 明确推迟;现在构建它超出范围。

## Decision

采纳方案 2。**会话→agent 绑定是一个双键空间,且一个会话的厂商是一个在其首次绑定时被冻结的
不可变不变量。**

- **存储层(内核配置),对厂商无感知。** 持久化的状态文件升版到 schema version 2,带两张
  映射:
  - **intent 映射**(pending id → 期望的 agent + 创建时间戳):可变,可能被重新指向或清空,
    从不携带厂商信息。
  - **fact 映射**(真实 id → 实际运行过的 agent + 它被冻结的厂商)。
    操作包括:一次读取同时解析两个空间(pending id → intent,真实 id → fact);读取被冻结的
    厂商;设置/清空一个 intent(戳记创建时间);一次**首次绑定冻结**,仅当不存在时才写入
    fact,并总是丢弃 intent(幂等,从不重新冻结);一次强制该不变量的 fact-change(同厂商
    切换 → 成功;跨厂商 → 被拒绝,fact 保持不变);以及一个清理陈旧 intent 的 janitor。存储层
    把厂商作为一个普通参数接收,因此它从不 import agent 注册表——config → agent-config 这条
    边界保持无环(ADR-0009)。
- **解析层(内核 agent-config)。** 冻结包装器解析该 agent 的厂商,并调用存储层的首次绑定
  冻结;set-agent 包装器把一个 pending id 路由到 intent setter,把一个真实 id 路由经过
  fact-change,返回一个成功/失败结果,使一次跨厂商尝试被上报,而不是被悄悄丢弃。
- **绑定时机。** 冻结在与运行时绑定相同的时刻触发,发生在首个真实会话 id 上,两条运行路径
  (Claude 运行路径与 driver 运行路径)都是如此——因此这个事实总是从一次真实运行写入,而不仅仅
  是一个显式意图。
- **Janitor。** 组合根在启动时以及每小时,清扫早于 pending-intent TTL(7 天)的 pending
  意图。清空一个 intent 从不触及 fact 映射,因此它不可能孤立一个 fact。
- **迁移(v1 → v2)。** 一张旧版单一映射按键的形态被拆分:带 pending 前缀的键变成 intent
  (戳记为当前时间);其余所有键变成 fact,冻结到 Claude 厂商——这是多厂商出现之前唯一存在过的
  厂商,所以这次冻结在历史上是正确的。

这些不变量,直白地说:**一个会话的厂商不能改变;在同一个厂商内它的 agent 可以自由切换;c3
从不存储任何会话内容;跨厂商的 Fork / replay-seed 本周期不受支持**(依据 ADR-0011 推迟)。

## Consequences

- 跨厂商重新绑定一个会话,现在在结构上就是不可能的——一个会话产生的 transcript 永远可以从它
  被冻结的厂商的存储里读到。同厂商的 agent 切换依然自由。
- Pending 意图会被垃圾回收;一个被放弃的新会话不再留下一个永久条目,意图消亡也不会产生一个
  孤儿事实。
- 持久化的状态 schema 升版到了 v2;旧版安装在首次读取时透明迁移。
- 跨厂商的上下文交接(replay-seed、异构队友)仍然被推迟;想要换厂商的用户需要开启一个新会话。

## Compliance

- **ADR-0009 R1** —— 存储层不 import 解析层;厂商作为一个普通参数跨越这条边界。解析包装器
  位于 agent-config 层,该层已经依赖 config 层。这条边界保持无环。
- 冻结厂商这条不变量有单元测试覆盖:双键写入、绑定冻结 + 幂等性、同厂商切换 vs 跨厂商拒绝、
  意图消亡不产生孤儿、janitor 清理、以及 v1→v2 迁移。
- Typecheck、lint 以及测试套件保持为绿。

## References

- ADR-0011(厂商中立 agent;推迟的 replay-seed / 异构队友)、ADR-0013(c3 会话命名空间 +
  按厂商的存储)、ADR-0009(单向边界)、ADR-0004(会话注册表)。
- [agent-config domain spec](../../domains/settings/agent-config/)(AC-R\* 绑定规则)、
  [session-registry domain spec](../../domains/core/session-registry/)(pending 会话生命周期)、
  [agent-session domain spec](../../domains/core/agent-session/)(AS-R10 重新加键)。
