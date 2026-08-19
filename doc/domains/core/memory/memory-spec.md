# memory — 规格

实体定义见 [memory-models.md](memory-models.md);物理接线见 [memory-design.md](memory-design.md)。

## 工具契约

work session 的 c3 工具面共三个工具,由同一条回环 MCP 路由提供:`publish_event` 与本域的
`memory_search` / `memory_write`。

### memory_search

入参只有可选的 `query`。作用域(工作区 + 会话)由服务端派生,调用方给不出。

**无 `query`(或空白)—— 目录模式。** 返回本工作区**全部** `active` 记忆的目录,按 `type` 以固定顺序
`preference → constraint → fact → lesson` 分组,空组省略。目录项只含 `title` 与 `type`,不含正文。
返回结构为 `{ mode: 'directory', total, directory }`。

**有 `query` —— 匹配模式。** 对 `title`、`subject`、`content` 做**字面**、不区分大小写的子串匹配,
仅限本工作区的 `active` 行。输入中的 SQL 通配符按普通文本处理。命中返回完整详情(`id`/`type`/`title`/
`subject`/`content`/`sourceSessionId`/`createdAt`/`updatedAt`),结构为 `{ mode: 'match', query, total,
memories }`。无命中返回显式空结果,**绝不**退回到另一个工作区或失效行。

字面检索会漏掉同义与改写。调用方的补救是先列目录(它小到可以整份读完)再换一个更短的词;系统不会
自行扩大范围,也不会调用语义检索。

### memory_write

`op` 三选一,一次调用只做一次变更。

- **`create`** —— 必填 `type`、`title`、`content`,可选 `subject`。`title` 归一化后命中未 `superseded`
  的行时**原地覆盖**该行:保留 `id` 与 `createdAt`,刷新正文、`sourceSessionId` 与 `updatedAt`,并把
  软删过的行重新置为 `active`。未命中则新建,受工作区容量上限约束。
- **`update`** —— 必填 `id` 与至少一个可改字段。目标必须存在、属于本工作区,且状态为 `active` 或
  `deleted`(`superseded` 行不是可编辑对象)。改 `title` 时套用同一条归一化唯一性规则:落到另一条存活
  记录上即拒绝,不合并、不由系统替调用方裁定谁该留下。
- **`delete`** —— 必填 `id`,**软删**本工作区内的目标行。重复删除幂等,且仍然回报存储中的 `title`,
  不重启回收期。

**每一次成功都回报实际保存或删除的 `title`。**校验失败、归属不符、目标不存在、容量已满与数据库不可用
一律返回 `isError` + 安全原因,且不产生任何部分变更。写入永不被静默丢弃、截断或改写成别的类型。

## 设置页管理

工作区设置页有一个**记忆** Tab。它存在的理由很窄:没有它,用户清理一条记忆就只能让 agent 去删,而需要
清理的场合往往正是 agent 自己写错了的时候——纠偏通道不能架在被纠偏的那一方身上。

**能做的只有两件事:看,和删。**

- **看** —— 列出本工作区的全部 `active` 记忆摘要(`title` / `type` / `status` / `updatedAt`),按 `type` 以与
  `memory_search` 目录模式相同的固定顺序 `preference → constraint → fact → lesson` 分组,空组省略,组内按
  `updatedAt` 倒序。**不含正文**:正文的读取属于 work session 里的 `memory_search`,设置页不是记忆的阅读器。
- **删** —— 逐条软删,语义与 `memory_write { op:'delete' }` **完全相同**(同一个 store 调用):行置为
  `deleted`、重复删除幂等、30 天回收期内仍占容量。二次确认后才发出;服务端确认删掉了哪一条(回报实际的
  `title`)之后,该行才从列表消失——被拒的删除不会让行消失,也就不会把没发生的事显示成发生了。

**不做新建、不做编辑、不做搜索/筛选。**写入路径保持唯一:agent 在 work session 中写。在设置页再开一个写入口,
等于给同一张表造出第二套会各自漂移的语义;而检索交给 `memory_search`,目录本身小到可以整份读完。

**范围与授权。**请求必须携带当前 `workspaceName`,服务端按与其它工作区读写同一套注册表解析;解析不到即拒绝
(`workspace.unknown`),因此浏览器够不到自己够不到的工作区。本 Tab 不经 MCP、不绑定 session kind——它服务的是人,
不是模型。没有账号级、也没有跨工作区的记忆管理入口。

**可用性。**列表沿用 store 的读降级:数据库不可用时返回空列表而不是错误(读永不抛)。删除相反,库不可用就显式
失败(`memory.unavailable`),绝不回报一个没发生的删除。

## 会话与权限

**工具面。**run 生命周期用 `sessionKind === 'work'` **正向**选中 work session 的 MCP profile,不允许
写成「其它 profile 都没匹配」。因此 `intent`、`spec`、`spec_review`、`discussion`(调研会话与编排的逐
agent 会话)都不获得这两个工具。理由与替代方案见
[ADR-0045](../../../architecture/adr/0045-workspace-memory-as-allowed-local-persistence.md)。

**vendor 中立。**Claude、Codex、Cursor 消费同一份绑定描述符。描述符的 `enabledTools` 由已注册工具列表
派生而非手写:Codex 会把 `enabledTools` 里的每个名字标记为 required/approved,**遗漏的名字被静默禁用**,
一份手维护的第二名单只会在一个 vendor 上失效且看起来像什么都没发生。

**权限门。**`mcp__c3__memory_search` 与 `mcp__c3__memory_write` 由标准权限门直接放行:不发
`permission_request` 线消息、不写用户介入记录、不走共识。免确认**不等于可用**——能否调用由上面的工具面
决定,两者是独立的两道。

## 业务规则

**M-R1 身份确定性。**身份是 `(workspaceName, 归一化 title)`。归一化 = 去首尾空白 + 折叠内部空白 +
Unicode 小写。这是本域唯一的自动语义判断。

**M-R2 矛盾不合并。**系统从不比较正文,也从不问 LLM 两句话是否一致。真正互斥的两条必须用不同 `title`,
可共用 `subject` 让分歧可发现,`content` 需写清各自成立的条件;两条都保持 `active`。

**M-R3 工作区隔离。**每次读写以 `workspace_name` 为边界。跨工作区的 id 一律按「不存在」处理并拒绝,
不产生任何变更。`subject` 只分组,不扩权。

**M-R4 长度与容量。**单字段 ≤ 2000 个 Unicode 码点(按码点计,不按 UTF-16 单元);单工作区 ≤ 500 物理行
(含全部状态)。覆盖既有 `title` 不占新槽位,因此容量满时仍可修改已有记忆。计数与插入同事务,同进程
并发写不会双双越界。**超限一律拒绝,绝不淘汰任何一条已有记忆。**

**M-R5 写入拒绝。**凭据形状与产物形状(代码围栏、工具调用/返回框架、角色转录行)一律拒绝,拒绝信息
不回显命中的内容。校验覆盖 `title`、`subject`、`content`。类别见
[memory-models.md](memory-models.md#拒绝类别)。

**M-R6 软删与回收期。**删除是状态变更,不物理擦除,也不立即让位给普通检索。`superseded` 与 `deleted`
行按各自的 `updatedAt` 满 30 天才被物理删除。回收期内它们仍占容量——这是刻意的取舍:宁可拒绝新条目,
也不缩短可恢复性或淘汰另一条记忆。

**M-R7 清理只按规则。**清理进程不读正文、不排序、不询问模型。两条规则:同工作区同归一化 title 保留
`updatedAt` 最大者(相同则按 id 确定性取舍),其余未 `superseded` 行标记 `superseded` 并指向留下的那条;
`superseded`/`deleted` 行满回收期即物理删除。**`active` 行永不因年龄被删除**——一条一年前的 `preference`
正是本域存在的理由。

**M-R8 可用性降级。**数据库不可用时检索返回空、写入显式失败。**失败的写入绝不能返回成功回执。**

## 用户场景

**沿用既有共识。**用户在新的 work session 里让 agent 改代码。agent 先调一次无参 `memory_search`,读到
`preference` 组里有「提交信息正文用中文」「不写 Co-Authored-By」,于是按此提交,用户不需要再说一遍。

**记下新共识。**用户在会话中说「PR 一律合进交付分支,不要直接进 main」。agent 用
`memory_write { op:'create', type:'constraint', title:'PR 合入交付分支', content:'…' }` 保存,并把回执里的
title 告诉用户。

**改口。**用户后来说「这个仓库例外,直接进 main」。agent 用同一个 `title` 再 create 一次即原地覆盖;
若两条规则实际共存(不同条件下各自成立),则用不同 `title` 分别保存并共用 `subject: 'pr'`。

**撤销。**用户说「那条不算了」。agent 用 `memory_write { op:'delete', id }` 软删。30 天内重新写入同名
条目即可恢复。

**容量满。**工作区攒到 500 条时,新 create 明确报错并提示先删除或合并;系统不会替用户淘汰任何一条。

## 验证要点

- schema:全新库与半初始化库都收敛到同一终态,列/枚举/索引精确,重复初始化幂等。
- store:归一化去重跨空白与大小写、工作区隔离、`createdAt` 稳定而 `updatedAt` 刷新、软删幂等、同名
  重写复活、2000 码点边界(收 2000 拒 2001)、500 行边界(收第 500 拒第 501 且不淘汰)、凭据与产物拒绝
  且不回显。
- 工具:空查询返回按 type 分组的目录、字面查询返回详情、A 的绑定读不到也改不动 B。
- 工具面:claude/codex/cursor 三方 work session 均列出三个工具并能调用两个记忆工具;`intent`/`spec`/
  `spec_review`/两种 `discussion` 均不获得记忆工具;描述符 `enabledTools` 精确等于已注册工具集。
- 权限门:两个记忆工具均放行且无线上权限事件、无用户介入记录、无共识调用。
- janitor(注入时钟):同 title 留最新且平局确定性、失效行满 30 天物理删除、老 `preference` 不因龄清理。
- 设置页协议:列表只出本工作区 `active` 行摘要且不含正文、工作区隔离(A 看不到 B)、未知工作区报错;删除后该行
  不再出现在后续列表、重复删除幂等、跨工作区 id 与不存在 id 均报 `memory.notFound` 且库内无变更、库不可用报
  `memory.unavailable`。
- 设置页交互:列表按 type 分组渲染 title/type/status/更新时间;点删除先二次确认,取消不发消息;行只在收到删除
  确认后消失,被拒时留在原处并出 toast。
