# im-robot — 实体

物理表见 `database/robots/`;行为契约见 [im-robot-spec.md](im-robot-spec.md)。

## Robot

一个已配置的聊天机器人。身份是 `name`——它同时是显示名、工作目录名与唯一键,受路径安全约束
(小写字母/数字/`-`/`_`,以字母或数字开头,最长 32 字符),**创建后不可修改**:改名等于换一个机器人。

字段分四组:

- **平台连接** —— `platform`、`appId`、`appSecret`。密钥加密落库,线上只出现 `hasSecret` 布尔值,
  永不回传明文。
- **执行身份** —— `vendor` 与 `agentId`。后者可以是真实 agent id,也可以是一个组引用;组的故障转移
  按轮次重新解析,因此这里存的是引用而非解析结果。
- **预设权限** —— `mode` 与 `toolAllowlist`。白名单由权限网格勾选而来:真实工具名,外加一个可选的
  `network-access` 伪条目(能力开关,见规格);为空即只读,这是创建时的取值。
- **响应面与限额** —— `requireMention`(默认真)、`chatAllowlist`(空即不限群)、`dmMode`(默认不响应
  单聊)、`dmAllowlist`、`maxTurnMs`(空即用默认值)。

另有两个字段承载授权状态:`enabled` 默认为假,`outboundAckAt` 记录用户确认外发范围的时刻。

**连接状态不是字段。** 连上没有、重连第几次、上次为何失败都是进程内的运行时事实,随查询附加在
Robot 上回传,从不落库。

**运行目录不是会话存储。** `~/.c3/robots/<name>/` 只提供一轮运行所需的可重建目录;删除或重建不得
改变数据库中的 Conversation 归属或可恢复上下文。

## Conversation

一条发送者隔离的持续对话,身份是 `(platform, robotId, threadKey, senderId)`。

`threadKey` 是平台中性的线程身份,由归一化规则得出,优先级为:平台原生话题 → 回复链根 → 会话本身。
三者各带前缀,因此一个会话 id 不会与另一个会话的话题 id 相撞。

`senderId` 是平台提供的不透明外部标识,只在所属平台、机器人与线程内有意义;不是 c3 用户,不跨平台
合并。同一群、同一线程、不同发送者是不同 Conversation,互不可读、不可恢复、不可覆盖。

`sessionId` 可空——原生厂商会话只是续接缓存,且必须与 Conversation 的 `vendor`、已提交修订一致才可
使用。缓存缺失或 vendor 变更时,从数据库已提交 Context Turn 恢复。`contextRevision` 随每次成功提交
递增。

## Context Turn

一次可恢复的 IM 可见往来,归属于一个 Conversation。状态为 `pending` / `committed` / `failed`:

- **pending** —— 入站 `messageId` 已认领;正文暂不落库
- **committed** —— 用户文本与已投递最终回答同事务写入;进入后续恢复上下文
- **failed** —— 超时、阻塞、守卫拒绝、投递失败或崩溃遗留;正文保持为空,并使原生会话缓存失效

认领以 `(platform, robotId, messageId)` 唯一。每 Conversation 最多保留最近 50 个已提交回合,且每个
回合自提交起最多 30 天;超出即硬删除完整回合。用户与 assistant 正文各最多 4000 个 Unicode 码点。

## Turn(审计)

一次回合的审计行。它回答的是**何时、对谁、发了多长、结果如何**,不回答**说了什么**:
`outboundChars` 是长度而非内容,入站也只留消息 id。IM 可见正文只存在于 Context Turn(ADR-0048)。

`outcome` 覆盖全部结局:

- `complete` —— 已回答
- `error` —— 运行出错,或平台拒绝了投递
- `blocked` —— 回合撞上一个无人能答的授权请求
- `timeout` —— 墙钟到点
- `guard_refused` —— 出站守卫在回答里认出凭据形状而拒发
- `input_rejected` —— 入站凭据或超长守卫拒绝;封闭原因在 `rejectReason`(`credential` | `too_long`)
