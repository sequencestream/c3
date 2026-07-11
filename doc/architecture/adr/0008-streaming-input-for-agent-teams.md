# 0008 — 面向长驻智能体团队的流式输入 prompt

- **Status:** accepted
- **Date:** 2026-05-30

## Context

运行循环原先用一个**字符串** prompt 驱动 SDK 的 `query()`——一次性的单轮交互。SDK 在字符串 prompt 下会在
`result` 一到达就结束该次 query:异步迭代器结束,底层的 `claude` 进程随之退出。这正是 c3 为普通会话所期望的
"下一轮通过 resume 恢复"模型。

然而,这与 **Claude Code 智能体团队**不兼容。当团队负责人(lead)把任务委派给一个后台队友(一次后台
`Agent` 工具调用)之后,它会为当前这一轮产出一个 `result`——但工作并未完成,队友仍在运行,并且必须向 lead
汇报。在字符串 prompt 下,lead 的 `result` 会结束该 query 并使进程退出,于是队友要么被杀掉要么被孤立,其结果
永远无法传达给 lead。团队在诞生的那一刻就已经死亡。

一个次要问题:SDK 的**控制请求**(`setPermissionMode`、`interrupt`)只有在流式输入模式下才会生效。在字符串
prompt 下,它们虽然被发出,却被悄无声息地吞掉了,因此运行中途的 `set_mode` 以及 `stop_run` 的中断实际上都是
空操作。

## Options considered

1. **只让团队会话使用流式输入。** 想办法先检测出是否为团队,再把该会话切换为流式 prompt。_缺点:_ 团队必须
   在 query 开始**之前**被检测出来,但团队属性只有在某个团队工具在运行中途被实际使用后才可知——你无法把一个
   正在进行中的字符串 query 切换为流式。这还会把运行路径分叉成两套代码形态。
2. **按入口点预先标记团队(例如 `/develop-pipeline`)。** 当会话是通过某个已知的团队衍生技能启动时,提前把
   它标记为团队。_缺点:_ 脆弱且不完整——lead 可以从任意 prompt 组建团队,不局限于某个被认可的 slash 命令;
   漏判会重新引入这个 bug,误判则会让非团队进程无谓地保持存活。
3. **所有会话都使用流式输入;在运行时检测团队;在 `result` 处分叉(采用)。** 始终用一个受控的异步可迭代
   prompt 驱动 `query()`。当第一个团队工具被使用时识别出这是一个团队。在 `result` 处,对非团队运行关闭
   输入流(重现一次性退出的行为),而对团队运行保持输入流打开(lead 保持存活)。_优点:_ 统一的运行路径;
   团队检测是准确的,因为它监视的是真实的工具调用流;顺带修复了控制请求。_缺点:_ 每次运行都多了一点点机制
   (一个受控输入流),包括那些从不组建团队的运行。

## Decision

采纳选项 3。

- **统一的流式输入。** 每次运行都用一个受控的用户消息异步可迭代对象驱动 `query()`,以用户的第一轮为种子。
  推送文本会把一轮追加到同一个存活的会话中;关闭该流会结束该会话,使 query 正常终止。
- **运行时团队检测。** 在每一次工具调用块出现时(在该轮的 `result` 之前),一次团队工具检查会把该运行标记
  为团队,并触发一次团队回调(仅一次)。团队工具指 `TeamCreate`、`SendMessage`,或一个后台
  `Agent`(`run_in_background === true`);前台 `Agent` 不算(它会在该轮内完成)。
- **`result` 处的分叉。** 在 `result` 处,该运行总是会发出一个已完成的 `turn_end`;随后一个**非团队**运行
  会关闭其输入(进程退出——一次性行为,下一轮会恢复一个新进程),而一个**团队**运行会保持输入打开,使 lead
  进程持续存活以便跨轮协调队友。
- **只在明确停止时结束。** 团队的输入永不自动关闭;中止路径会关闭它(同时中断 SDK),使
  `stop_run` / `delete_session` / `remove_workspace` 成为团队会话结束的唯一方式。"团队 lead 已完成"被等同于
  用户明确停止——不存在自动的团队拆除检测。
- **实时的团队轮次。** 当一个会话处于 `team` 状态时,一次 `user_prompt` 会被推入这个存活 lead 的输入流中
  (不开新的运行,不做 resume),而不是被当作串行违规而拒绝。
- **附带修复。** 由于所有运行现在都是流式的,`setPermissionMode` 与 `interrupt` 真正能够到达 SDK。

## Consequences

- **更容易:** 智能体团队能够端到端工作(lead 在委派之后仍然存活);`set_mode`/停止对一个存活运行现在是真正
  生效的;一套运行代码路径服务于两种模式。
- **更难:** 每次运行都携带流式输入的管线;一个团队会话是一个长驻进程,会持续消耗资源直到用户将其停止
  (这是设计使然——不存在自动拆除)。协议与注册表中新增了一个 `team` 会话状态、一个 `team_upgraded` 线上
  事件,以及运行时上的一个团队标志。
- **迁移:** 运行循环的 prompt 输入现在是一个受控的流,而非字符串;运行句柄增加了一个推送输入的控制点;
  运行选项增加了一个团队回调;会话运行时与会话状态增加了一个 `team` 状态;server-to-client 联合类型增加了
  `team_upgraded`。普通会话的一次性退出语义被原样保留(在 `result` 处关闭)。

## Compliance

- 运行 MUST 用受控输入流驱动 `query()`,绝不能用字符串 prompt。评审者应拒绝字符串 prompt。
- 团队会话 MUST NOT 被用户停止之外的任何方式结束;其输入 MUST NOT 自动关闭。非团队运行 MUST 在 `result`
  处关闭其输入,以免留下一个存活的进程泄漏。
- 团队检测 MUST 使用团队工具检查(前台 `Agent` 不算团队),并且团队回调每次运行最多触发一次。

## References

- [agent-session spec](../../domains/core/agent-session/agent-session-spec.md) —— AS-R13…R17(流式输入、
  团队检测、`result` 分叉、团队在停止时结束、团队下一轮推送)。
- [agent-session design](../../domains/core/agent-session/agent-session-design.md) —— 流式输入、团队会话、
  停止 / 中断、消息映射。
- [session-registry design](../../domains/core/session-registry/session-registry-design.md) —— 团队会话状态
  (团队标志与 emit 覆写)。
- [WebSocket protocol](../../shared/api-conventions/websocket-protocol.md) —— `team_upgraded`、
  `team` 会话状态、`user_prompt` 的团队语义。
- 建立在 [ADR 0006](0006-decouple-runs-from-connections.md) 之上 —— 拥有这个(如今可能长驻的)团队运行的
  会话运行时注册表。
