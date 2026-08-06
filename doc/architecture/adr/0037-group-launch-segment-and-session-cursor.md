# 0037 — Group 启动段 + 会话游标(跨 system/custom 边界的 failover)

- **Status:** accepted
- **Date:** 2026-08-06

## Context

ADR-0029 把 agent group 定义为"一组按 `order_seq` 排序的同 vendor agent",由 relay 在**单个请求内、首字节前**按序 failover。它隐含一个前提:组内所有成员都能被 relay 代理。

实际配置里最有价值的组恰恰不满足这个前提——"官方订阅额度优先,耗尽后切第三方 provider"要求组内同时存在 `system` 成员(用 vendor CLI 自身的登录)与 `custom` 成员(经 relay 接第三方)。而 relay 只能代理后者:`system` 模式没有 provider 三元组可注册,走的是 CLI 自己的凭证。

这带来两个问题:

1. **`system` 成员被静默跳过。** 原实现遍历全部候选、收集所有可 relay 的项,于是一个排在最前的 `system` 成员不产生候选,子进程的 `ANTHROPIC_BASE_URL` / codex `model_provider` 仍指向 relay——实际运行的是排第二的 `custom` 成员。界面显示的代表成员(组首)与真正执行的 agent 不是同一个,可见顺序不再等于运行顺序。
2. **边界无法在 run 内跨越。** provider 端点在 spawn 时写进子进程 env,一次 run 无法在"经 relay"与"CLI 自身登录"之间切换。relay 的请求级 failover 天然到不了边界另一侧。

## Options considered

1. **禁止组内混用 `custom` 与 `system`。** _Con:_ 直接砍掉最主要的用例(官方额度 → 第三方兜底),把配置模型的实现约束伪装成产品规则。
2. **进程级 failover:一跑失败就用下一个候选重启子进程。** _Con:_ 要改 run 生命周期与会话恢复,回归面覆盖所有 vendor 的所有运行路径;而 run 已经在失败后由用户或队列 resume,重启的收益主要是省一次人工点击。
3. **启动段 + 会话游标(采纳)。** 候选列表按 relay 可达性切段,一次 run 只服务段首所在的那一段且**段首一定被使用**;跨段切换发生在 resume——run 因可降级错误失败后推进会话游标,下一次启动落在下一个候选。

## Decision

采纳方案 3。

- **启动段。** `launchSegment(candidates)`:段首可 relay ⇒ 段含其后紧邻的连续可 relay 候选,整段注册给 relay,段内 failover 语义与 ADR-0029 一致;段首不可 relay(`system`、无 provider 三元组的 vendor、`baseUrl` 为空)⇒ 段只含它自己,该 run 用 CLI 自身登录。`launchForCandidates` 只消费启动段。
- **段首一定被使用。** 这是本决策要守住的不变量:可见顺序即运行顺序。"收集全部 custom 候选"的做法被显式排除。
- **会话游标。** `SessionAgentFact` 增可变字段 `groupCursor`(agent id),标明下次启动从组内哪个成员起算;`resolveSessionLaunch` 据此把成员列表旋转成环再取段。仅对绑定为组引用的会话有意义。
- **推进时机。** 订阅 `agent:error` 且 `degradable` 为真时推进到刚跑完那一段之后的成员——与 relay 的 failover 判定同一口径(`isDegradableError`)。非可降级失败(凭证被拒、请求本身有问题)不推进:换个兄弟也救不了。
- **组是环。** 越过末尾回绕到首项,会话不会被困在耗尽的尾部;游标指向已离组/被删成员时退回自然顺序;重新绑定 agent 清空游标。
- **与配额自动禁用正交。** 配额类失败另有通路:该成员被禁用至重置时刻,于是整个从组里消失。游标不感知这件事,两者互不依赖。

组的**编辑入口**随之收敛为分组容器:`group` 只能通过在容器间移动行来改,不再逐行手输组名——手输能凭空造出用户看不见的池,而现在"这个组里有谁、谁排第一"必须一眼可见,才撑得住"段首一定被使用"这条不变量。

完整规格见 [relay-architecture](../relay-architecture.md) §8.4。

## Consequences

- 组内可混 `custom` 与 `system` 成员,"官方额度优先、耗尽切第三方"成为可配置的一等用例。
- 跨段切换有一次 run 的延迟:边界另一侧要等 resume 才生效。这是有意的取舍——换取不动 run 生命周期。
- 会话多了一个**可变**的绑定侧状态(此前 `vendor`/`storeScope` 都是冻结的),它只影响下一次启动的起点,不影响任何已冻结的事实。
- relay 拿到的候选列表不再等于整个组,而是当前段。ADR-0029 的"每个请求从最高优先级候选重新开始"在段内不变,但"最高优先级"的所指由会话游标决定。
