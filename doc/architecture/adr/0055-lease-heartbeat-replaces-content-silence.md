# 0055 — 用租约续约替换内容静默超时

- **Status:** accepted
- **Date:** 2026-10-01

## Context

Session Runtime 曾把「一段时间没有业务线事件」当作运行死亡：对账在 `running` 且 `lastActivityAt` 超过窗口时强制 abort。长编译、测试或部署可以合法地长时间无输出，会被误杀。活动注册表已有 generation / sequence 围栏和 `expire → stale`，但没有独立于内容流的续约，角标也无法在租约到期时先于 abort 收敛。

权限等待与 team parked 本来就不该被普通 TTL 清掉。瞬时 `reconnecting` 需要短宽限期，以免角标闪烁。

## Options considered

- **A. 继续用内容静默推断死亡并 abort** — 被否决。无法区分长工具与真正丢失的运行。
- **B. 完全取消超时，只等 teardown / AbortController** — 被否决。异常退出而 `finally` 未跑时，角标会永久悬挂。
- **C. runner 独立续约；到期先 stale 下角标；abort 另策** — 采纳。

## Decision

存活判断不再以 `assistant_text` / `tool_use` / `tool_result` 为唯一心跳。

优先级：子进程退出或 iterator 完成 → teardown/finally 明确 settle → AbortController 已触发 → runner 续约 → 租约到期推断。

- 每个新 run 是新 generation。`running` 事实带 `lastRenewedAt` 与 `leaseUntil`。
- 在途 run 指针未 abort 的 Session Runtime，以及仍为 running 的自动化执行日志，由周期 sweep 续约；续约不依赖模型输出。
- 租约到期只把 `running` 转为 `stale` 并移出 running 聚合。默认不因此 abort。当前 generation 的迟到续约可以把 stale 拉回 running；旧 generation 的续约或 settle 忽略。
- `awaiting_user` 与 `parked` 无普通 running 租约；`paused` 同样不按该租约过期。`reconnecting` 仍计为 running，但用短宽限期。
- 进程重启后 Runtime 为空；遗留的自动化 running 执行仍收敛为 failed。重建不会复活上一进程的 generation。
- 明确 settle 仍优先于 lease 过期。内容事件仍可更新 `lastActivityAt`（供意图「无进展」提示），但不作为存活证明。

## Consequences

- 正常长任务不会因无文本输出被终止，角标在续约窗口内保持。
- 停止续约的运行在租约窗口后从角标消失，运行本身仍可继续，直到独立 abort 策略或显式结束。
- 对账顺序：收敛已知死亡的 run → 从事实源重建（保留 generation / sequence / 租约，且不把 stale 仅因 Runtime 仍 running 而复活）→ 续约仍在持有 turn 的 runner → 到期 expire。

## Compliance

- 不得仅因无业务输出 abort 一个 `running` 会话。
- stale 展示与强制 abort 必须是两条策略；默认 abort-on-stale 为否。
- 迟到的旧 generation 续约不得延长当前租约。
- `awaiting_user` / `parked` 不得被普通 running 租约清掉。

## References

- [0050](0050-activity-registry-as-current-state.md) — 注册表围栏；当时未实施 lease
- [0051](0051-badge-projection-from-activity-sets.md) — stale 不计 running；续约不增加 revision
- [0054](0054-converge-activity-badge-polling.md) — 低频对账，摘要未变不广播
- [0006](0006-decouple-runs-from-connections.md) — 运行活在进程级 Session Runtime
