# intent-management — 数据模型

以领域术语给出的实体定义;物理接线(SQLite 驱动、schema 迁移)见
[intent-management-design.md](intent-management-design.md)。intent、proposed-intent、priority 与 status 的线上形状统一定义在
[共享协议](../../../shared/api-conventions/websocket-protocol.md)中;领域文档引用它们,
而不是重新定义消息形状。

## Intent

一个限定在单个项目范围内的台账条目。

- **`id`**(text, UUID): 稳定标识符;被依赖关系与开发反向链接引用
- **`workspaceName`**(text): 不可变且唯一的工作区名称;项目键(RM-R1, RM-R10)
- **`title`**(text): 简短的意图标题
- **`shortEnTitle`**(text | null): 简短英文 ASCII 短标题 — 派生 Git 分支名 / worktree 目录名的稳定来源；落库前截断到 128 字符；历史行为 `null`，仅在 refine 时补齐
- **`content`**(text): 完整的意图描述
- **`priority`**(enum `P0`|`P1`|`P2`|`P3`): 需求级别;P0 最高 —— 排的是**何时做**
- **`impactLevel`**(enum `L1`|`L2`|`L3`|`L4`|`L5`| null): 影响范围等级 —— 做错了**波及多远**;`L1` 最高(核心流程/资金/数据完整性),`L5` 最低(文案/界面微调);`null` = 未定级。与 `priority` 正交,互不替代也不合并。创建时由沟通智能体判定,`in_progress`/`reviewing`/`done` 之外可手改(代码已产出,影响范围已成事实,评审期间同样不可改写);持久值无法解释时读作未定级而非中间档(RM-R49)。等级联动 spec 准入与机器审批见 RM-R51:L1/L2 强制规格先行且禁止机器批准,L4/L5 默认规格延后,中间档与未定级不联动。
- **`module`**(text): 模块名称 — 意图所属模块,由沟通智能体根据标题/内容推断;未识别或历史行数据为 `''`(RM-R14)
- **`status`**(enum): `draft`|`todo`|`in_progress`|`reviewing`|`done`|`cancelled` (RM-R6, RM-R8, RM-R9, RM-R48)。`reviewing` = 代码已提交、PR 已建立或待建立,评审/修复/合并尚未了结 —— 它是接力候选存在的唯一状态;`done` = 全流程完成 = 评审了结(免评审 或 `reviewStatus === 'approved'`)且该意图 PR 聚合为 `merged`,无 PR 阶段的模式(共享检出/当前分支)下仍等于「工作完成」
- **`dependsOn`**(`id[]`): 该条目所依赖的项目内其他意图 id(聚合;RM-R1)
- **`lastWorkSessionId`**(text | null): 最近一次由意图发起的开发运行所产生的会话 id;反向链接目标(RM-R8/13)
- **`automate`**(boolean): 自动化编排器是否可以拾取该条目;由用户切换,默认 `false`(RM-A1)
- **`createdAt`**(timestamp): 创建时间
- **`updatedAt`**(timestamp): 最近一次变更时间
- **`completedAt`**(timestamp | null): 意图进入 `done` 状态的时间;在转为 `done` 时打上时间戳,状态离开 `done`(包括进入 `reviewing`)时清空(置为 null)(RM-R6/RM-R9/RM-R48)
- **`specMode`**(`'sdd'`|`'fast'`| null): 每意图级规格模式覆盖;`null` 继承工作区 `sddEnabled`(开启 ⇒ `sdd`,关闭 ⇒ `fast`),显式值始终覆盖派生值且不随开关变化。**仅在规范与开发均未起步前可改**:`specPath` 空白且 `specStatus === 'raw'`、`specSessionId`/`specReviewSessionId` 均为空、`lastWorkSessionId` 为空,三条同时成立才允许写入(判据 = `canEditIntentSpecMode`);否则概览页降级为只读、`set_intent_spec_mode` 返回 `intent.specModeLocked`(RM-R43)
- **`effectiveSpecMode`**(`'sdd'`|`'fast'`): 发送时投影的已解析有效规格模式 —— 从持久 `specMode` + 工作区 `sddEnabled` + `impactLevel` 经 `resolveEffectiveSpecMode` 推导一次,客户端/准入层/落定处理读取同一值;`sddEnabled` 关闭时无规格闸门与规格阶段,`fast` 只是与现状一致的自然默认。高影响 L1/L2 强制 `sdd`、低影响 L4/L5 在 `specMode` 为空时默认 `fast`(RM-R51、RM-R43)
- **`actionDescriptor`**(ActionDescriptor | null): 派生的「下一步」;无阻塞时为 `null`。发送时投影,不落库(见下)
- **`prs`**(`IntentPr[]`): 该意图拥有的全部 PR/MR,按 `createdAt` 升序;无 PR 时为空数组。发送时由 `intent_prs` 批量挂载(见下)
- **`linkedDeliveries`**(`{ id, title }[]`): 该意图关联的交付,按建边顺序;无关联时为空数组。发送时由 `intent_deliveries` + `deliveries` 批量挂载,是**只读投影** —— 关联边归 delivery 域写入
- **`baseBranch`**(text): 意图的**基准分支快照** —— 它建在哪个分支上;非空。PR 目标与 worktree 基线共读此值(见下)
- **`baseBranchFallback`**(boolean): `baseBranch` 是否为读时派生的主分支回退(持久值缺失或不可用),而非记录下来的事实;界面据此标注,不把回退伪装成历史
- **`reviewSessionId`**(text | null): 当前或最近一次 PR 评审会话的 `c3SessionId`;与 `specReviewSessionId`(spec 只读审核)分属不同权限域,亦不是厂商 session id 或自动化 execution id
- **`reviewStatus`**(enum `pending`|`approved`|`rejected`| null): PR AI 评审结论;`null` = 未评审,`pending` = 待结论,`approved` = 通过,`rejected` = 发现问题(表达修复要求)。持久值无法解释时读作 `null`(RM-R52)。`pending` 只表示「等待结论」,是否真的在跑由会话存活派生 —— 队列是它的唯一写入方(RM-A25)
- **`reviewFixRounds`**(number): 已认领的修复轮次;非负整数,只增不改(RM-R52)。**首次评审保持 0** —— 只有队列成功认领一次 Fix 才 +1,恢复一个崩溃的阶段不再累加,普通 unpark 也不重置;上限 `MAX_REVIEW_FIX_ROUNDS = 3`,即正常闭环最多三次修复、四次评审(RM-A25)
- **`fixSessionId`**(text | null): 当前或最近一次 Fix 会话的 `c3SessionId`
- **`fixStatus`**(enum `pending`|`fixed`| null): PR 修复结论;`null` = 尚未进入 Fix,`pending` = 待结论,`fixed` = 已处理。`fixed` 不等于评审通过,不能自动写成 `approved`。持久值无法解释时读作 `null`(RM-R52)。进入复审时由队列清空,使旧的 `fixed` 不能满足下一次 `rejected`(RM-A25)

共享纯函数 `needsReview(impactLevel)` 只在 `L5` 时返回 `false`,`L1`~`L4` 与 `null` 均返回 `true`;不读数据库、不改状态,也不依据 priority、spec 模式或既有 Review 结论改变结果。它只决定**首次**评审是否需要:已经存在任何评审结论后,接力不再受影响范围改判左右(RM-A24)。

关系:属于一个项目(以 `workspaceName` 标识);拥有零个或多个 Intent
Dependencies;拥有零个或多个 Intent PR;关联零个或多个 Delivery(关联边见
[delivery-models.md](../delivery/delivery-models.md));可能引用一个开发 Session(一个普通会话,归
session-registry 所有)。

`linkedDeliveries` 与 `prs[].deliveryId` 不重复:前者是「属于哪个交付」,后者是「对某个
交付开了哪条 PR」。意图详情把两者合并呈现 —— 元信息区先列关联交付,PR 行再按交付分组。
已关联但尚未提 PR 的意图只有前者,这正是不能用 PR 行代表关联的原因。

### 基准分支 (`baseBranch`)

「这个意图建在哪个分支上」只有一个答案,并且是**落库的快照** —— 不是每个读点各自现算的
推导。它只在几个生命周期边沿被写入(创建、首次关联就绪交付、该交付分支由未就绪变就绪、
失去最后一条关联),之后不追随交付分支的推进、改名或重建;写入时机、取值优先级与两个
消费点的规则见 [spec RM-R44](intent-management-spec.md)。

`baseBranchFallback` 区分「记录下来的决定」与「当场派生的回退」:持久值缺失或不可用时读
模型给出工作区主分支并置位,界面据此标注,且**不回写** —— 读时推导一旦落库,事后就再也
分不清两者。

## Intent PR

一条 PR/MR,是一等实体而非意图上的几个字段 —— 一个意图可对不同交付各持有一条。
持久化于 `intent_prs`,写入唯一经仓储层 `upsertIntentPr`。

- **`id`**(uuid): 台账行标识(不是 PR 编号)
- **`intentId`**(id): 所属意图
- **`deliveryId`**(text | null): 所属交付;`null` 表示无交付归属
- **`forge`**(`'github'`|`'gitlab'`| null): 托管平台;`null` 表示来源未知
- **`repo`**(text | null): 仓库标识(`owner/name`);`null` 表示来源未知
- **`number`**(text): 仓库内 PR/MR 编号,由 gh/glab 创建输出解析
- **`url`**(text | null): 可跳转链接;与 `latestCommitHash` 语义不同(链接指向变更请求,哈希指向提交)
- **`status`**(enum): `reviewing`|`rejected`|`failed`|`merged`|`closed`;有自己的生命周期,不随意图状态变化,反向则派生一条边:PR 聚合为 `merged` 时,`in_progress` 意图自动转 `done`(手动路径的历史规则)、`reviewing` 意图在「评审了结(免评审 或 `approved`)」后收敛为 `done`(RM-R48)
- **`headBranch` / `baseBranch`**(text | null): 源分支 / 目标分支,每行独立记录
- **`createdAt` / `updatedAt`**(timestamp): 创建 / 最近更新时间

`(forge, repo, number)` 是 PR 的真实身份且全库唯一;把一条已归属某意图的 PR 写到另一个
意图上会被拒绝。`forge`/`repo` 可空是对"来源未知"的降级承接 —— 这类行不参与唯一键,
下一次经 `upsertIntentPr` 的写入即补齐。

**聚合态**:需要"这个意图的 PR 到底怎么样了"这一个答案的读点(闸门、进度条、队列事实)
一律用共享纯函数 `deriveIntentPrAggregate` 归约,梯子为未定结论优先于终态、有合并成果
优先于纯关闭:无行 → `null`;有 `reviewing` → `reviewing`;否则有 `failed` → `failed`;
否则有 `rejected` → `rejected`;否则有 `merged` → `merged`;否则(全部 `closed`)→ `closed`。
需要"跳到哪一条 PR"的读点用 `pickPrimaryIntentPr`:第一条活跃的,全部终态则取最早一条。

## 工程进度条

展示派生的唯一规则源是 `web/src/lib/intent-engineering-progress.ts` 的
`deriveIntentEngineeringProgress`。阶段顺序为意图 → [规范] → 工作 → PR → [评审] → [修复] → 合并;
仅 `worktree` 模式显示 PR、评审、修复与合并段。SDD 关闭时隐藏规范段;
`fast` 意图尚无规范路径或规范会话时也隐藏规范段。

- 意图:`draft` 为进行中,其余为已完成。
- 规范:已批准且有规范路径为已完成,有规范路径或规范会话为进行中,其余为未开始。
- 工作:`done`、`reviewing` 为已完成;否则有工作会话或 PR 行、或状态为 `in_progress`/`blocked`/`failed`
  时为进行中,其余为未开始。
- PR:无 PR 行为未开始;只要存在 PR 行即已完成,表示已提交 PR。
- 评审:仅 `needsReview(impactLevel)` 为真且存在 PR 行或非空 `reviewStatus` 时显示。
  PR 聚合为 `merged` 时已完成;否则 `null`、缺省或 `pending` 为进行中,
  `approved` 为已完成,`rejected` 为已关闭/失败。
- 修复:有修复会话或非空 `fixStatus` 时显示;`pending` 为进行中,`fixed` 为已完成,其余为未开始。
- 合并:固定置于末尾;PR 聚合为 `merged` 时已完成,`rejected`、`failed`、`closed` 时已关闭/失败,
  有 PR 未合并或无 PR 时均为未开始。

该投影不回写台账或改变服务端状态机;评审与合并节点已完成并不要求台账 `reviewStatus` 已是 `approved`。

## Action Descriptor

一条派生的「下一步」:当意图被某个**不可自动解决**的事实挡住时,告诉用户这是什么情况、
可以去哪里处理。它是**运行时展示投影,不是业务状态** —— 每次发送(列表 / 刷新 / 广播)从
已有事实按优先级重新派生,不落库、不新增表,也不改变意图 `status`、队列的 action /
reason / 重试 / park,或任何闸门。

优先级(高 → 低,只投影一条):vendor 凭据/额度阻塞 → 该意图关联的 `todo` wait-user 事件
(`AskUserQuestion` 或普通权限门控) → 规格返工触顶 → SDD 开启且 spec `specStatus === 'pending'`(已撰写未批准;
仅播种占位的 `raw` 不算,不产生该提示) → 硬依赖闸门所指的前序意图 → 静默超时(RM-R38)。
静默排在最后是刻意的:它是对一条意图能说的最不具体的话,任何有明确根因、可直接处理的
原因都必须压过它。

依赖阻塞指引复用依赖闸门自身的判定:取 `dependsOn` 声明顺序中第一个仍会触发硬闸门的前序
意图为目标(worktree 下「已完成但尚未进入主线」同样视为阻塞),目标只带其 `intentId`,标题与
状态由客户端从同一批 `intents` 读模型解析、本地化状态文案;目标不在当前视野时提示语不声称
标题,绝不显示裸 id。依赖指引只描述 `todo` / `in_progress` 意图 —— 终态意图没有「下一步」,
前序满足闸门后指引消失。

- **`labelCode`**(ActionLabelCode): 稳定原因码(本地化码,不是文案);闭集见协议
- **`target`**(ActionTarget): 跳转目标;以 `type` 判别的联合:`system-settings-agent` / `intent-spec` / `intent-detail` / `workcenter-event` / `intent-work-session`

边界:

- **只承载导航。**`target` 不含 URL、命令或自由文本 payload,客户端只能跳到联合已列举的位置。
- **不泄漏。**只传稳定码与导航所需身份,绝不携带凭据、供应商原始错误全文或响应体。
- **自然消失。**更高优先级事实清除、事件决断、spec 批准或任何一次真实进展之后,投影回到
  更低优先级或 `null`。
- **不改变闸门。**派生只解释现有硬闸门结论,不提供跳过/放行依赖的入口。
- **扩展方式**是给 `target` 联合加分支,而不是给已有分支加可选字段。

## Git Action Failure Guidance

一次**已经发生**的 Git / 托管平台操作失败的定向修复指引:worktree 创建失败,或创建 PR 的
提交 → 推送 → 平台创建链上的失败。与 Action Descriptor 是同一个思路(稳定码而非文案),
但**是两套闭集**:Action Descriptor 描述一个**持续的阻塞态**并只做导航,本模型描述一次
**已失败的动作**并提供重试。它同样是**运行时展示投影**:不落库,不新增状态,也不改变那次
失败已经产生(或没有产生)的任何结果。

它挂在 `UiError` 上,字段**可选** —— 不认识它的客户端仍按既有 `code` + `params` 展示。

- **`reason`**(GitActionFailureReason): 稳定原因码(闭集,本地化码不是文案);无法判定时为 `unknown`
- **`detail`**(text): 当次失败命令的原始错误文本;已知与未知原因**都**保留,可能为空
- **`retry`**(IntentActionRetryTarget): `{ type: 'intent-action', intentId, action }`,`action` 为闭集重试入口

原因闭集:`worktree_branch_or_path_taken`(分支被其他 worktree 占用 / 同名分支或目录残留)、
`repo_conflict_unresolved`(仓库存在未解决冲突)、`filesystem_denied`(本地无权限 / 只读 /
空间不足)、`forge_cli_unavailable`(平台 CLI 未安装或未登录)、`remote_permission_denied`
(远端因无推送 / 建 PR 权限拒绝)、`push_rejected`(远端分支已前进,非快进)、
`network_unreachable`(DNS / 连接 / 超时)、`commit_hook_rejected`(提交 / 推送钩子或其
lint 校验链拒绝)、`forge_create_rejected`(平台校验拒绝,含该分支已存在 PR)、`unknown`。

重试入口闭集:`start-development` / `create-pr`。

边界:

- **只读当次证据。**原因仅由该次失败命令的退出码、stderr/stdout 与失败阶段推导,
  分类过程**不执行**任何额外 Git / forge 命令,也不读仓库。
- **不猜。**证据不足一律 `unknown`,绝不归入最相似类别;`unknown` 不展示任何修复步骤。
- **只承载重试身份。**`retry` 不含命令、URL、路径或任意回调,只有意图 id 与枚举动作。
- **不自动执行。**指引描述的是**用户**要做的事;c3 不清理 worktree、不解冲突、不改凭据、
  不动远端分支,也不自动重试。

## Proposed Intent

`save_intents` 调用内的单个条目;也是智能体在对话中列出待确认内容的字段来源。没有
`id` 时它尚未持久化 —— 只有在确认保存后才会成为一个 Intent(状态为 `todo`)
(RM-R5/RM-R6)。带 `id` 时,它是对该既有意图的**更新**(upsert,RM-R20)。

- **`id`**(`id`,可选): 设置时,原地更新这个**已存在**的同项目意图,而不是插入新的(upsert,RM-R20);`refine_intent` 流程会填充它,使 refine 后的意图更新其原始条目。省略则插入新意图。
- **`title`**(text): 提议的标题
- **`shortEnTitle`**(text,必填): 必填的简短英文 ASCII 短标题 — 派生分支/worktree 名的稳定来源；agent 应产出 ≤64 ASCII 字符，落库前截断到 128。新建与更新均要求传入
- **`content`**(text): 提议的描述
- **`priority`**(enum `P0`|`P1`|`P2`|`P3`): 提议的需求级别
- **`impactLevel`**(enum `L1`…`L5`| null,可选): 判定出的影响范围等级。省略 = 不改动(新建意图为未定级);显式 `null` = 清除为未定级。缺省与显式 `null` 刻意区分,使一次普通意图编辑不会意外抹掉已有判定(RM-R49)
- **`module`**(text,可选): 推断出的模块名称;省略时 —— 插入场景下落库为 `''`(RM-R14);更新场景下保留原值(RM-R20)
- **`dependsOn`**(`id[]`,可选): 对**已存在**的项目内意图的提议依赖(按 id);更新场景下,提供它(或 `dependsOnIndexes`)会替换依赖集合,两者都省略则保持不变(RM-R20)
- **`dependsOnIndexes`**(`number[]`,可选): 对同一批次内**兄弟**条目的提议依赖,按从 0 开始的数组下标;在保存时解析为该兄弟条目的 id(RM-R17)。被下标引用的兄弟条目自身也可能是一个更新目标(RM-R20)。
- **`intentSessionId`**(text,可选): 反向链接到产生此意图的沟通会话,持久化到 `intent_session_id`。**仅当该批次恰好保存一个意图时才生效** —— 多条目批次会忽略它(存储层只在 `length === 1` 时才写入)。智能体用注入到其提示词中的会话 id 来填充它;保存处理器会把它归一化为已绑定的沟通会话 id,以便通过 `open_intent_session` 解析。这弥补了 refine 的 `run:bound` 回填所无法覆盖的新建意图缺口。`save_intent_directly` 中不存在此字段。
- **`specMode`**(`'sdd'`|`'fast'`| null,可选): 每意图级规格模式覆盖。省略 = 不改动(新建意图按 `null` 继承工作区);显式 `null` = 清除覆盖恢复继承;`'sdd'` / `'fast'` = 固定该模式。缺省与显式 `null` 刻意区分,使一次普通意图编辑不会意外清除或改写已有模式。规范或开发已起步的意图,该字段经 `set_intent_spec_mode` 的写入(含清除覆盖)一律被拒(RM-R43)。

## Intent Dependency

一个项目内的一条有向边。

| 属性          | 类型        | 说明         |
| ------------- | ----------- | ------------ |
| `intentId`    | text (UUID) | 依赖方意图   |
| `dependsOnId` | text (UUID) | 被依赖的意图 |

仅用于展示 + 警示:任一依赖尚未 `done`(含 `reviewing` —— 代码已写完但评审/合并尚未了结)的条目会显示提示,对其发起开发会给出警告但不会被阻止(RM-R11)。
**对已持久化的图**,v1 中没有拓扑/环检测 —— 但单次 `save_intents` 批次内的批内引用
(`dependsOnIndexes`)会在插入时被校验(下标越界 / 自引用 / 成环会拒绝整个批次,RM-R17),
因为它们在任何行写入之前就已被解析为真实 id。

## Communication Session

用于细化(refine)意图的、按项目划分的隐藏智能体会话。每个项目持有这些会话的一个
**集合**(多行记录),它们都从常规的 `list_sessions` 响应中隐藏。当不带明确会话 id
进入意图视图时,每个项目中会有一个会话被标记为 `isCurrent`,作为默认打开的指针。
会话可以被列出、重命名和删除。

| 属性            | 类型         | 说明                                                                       |
| --------------- | ------------ | -------------------------------------------------------------------------- |
| `sessionId`     | text         | SDK 会话 id(在首次运行绑定之前,可能是一个 `pending:` id)                   |
| `workspaceName` | text         | 不可变且唯一的工作区名称(RM-R10)                                           |
| `title`         | text \| null | 用户指定的标题;null 时 ⇒ 客户端回退到 "New Intent" 或首个提示词/时间戳派生 |
| `isCurrent`     | boolean      | 默认打开指针 —— 每个项目最多一个当前会话(RM-R4)                            |
| `updatedAt`     | timestamp    | 最近一次绑定/重命名/运行时间                                               |

关系:一个项目的每一行共同构成该项目的**隐藏集合**(从 `list_sessions` 中排除,RM-R4);
`isCurrent` 那一行是在不带具体 `sessionId` 进入意图视图时被重新加载的会话。首次运行时,
`pending:` id 会被重新绑定为真实的厂商原生 id,同时保留 `isCurrent` 与隐藏集合的成员资格。
会话可以被重命名或物理删除(行删除 + 运行时移除,`isCurrent` 回退到最近剩余的会话)。
该会话还会以 `session_kind='intent'` 镜像到 `session_metadata` 中;refine/反向链接的会话
携带 `owner_kind='intent'` 与该意图的 id,使统一的 Sessions 页面与 WorkCenter 能够跳回,
而无需增加线上级别的 `jumpTarget`。

撰写 spec 的会话通过 `intents.spec_session_id` 关联,而不是通过单独的 spec 表。
当 `write_spec` 或 `reset_spec_session` 的 pending 运行时绑定到真实厂商会话 id 后,
同一个会话会以 `session_kind='spec'`、`owner_kind='intent'`、`owner_id=<intent.id>`
投影到 `session_metadata` 中。替换当前 spec 会话会清除旧的投影 owner,使一个意图
只暴露当前的 spec 条目作为其跳回目标。意图台账仍然是当前 spec 会话、`specStatus`(raw/pending/approved)
与批准状态的唯一真实来源(SoT);该投影是可重建的 Sessions 页面缓存。

## Workflow Status

一个工作区自动化队列(意图编排器)的实时摘要(RM-A1–RM-A9)。控制状态
(`running` / `paused` / `idle` 与强制跳过集合)持久化于 `queue_workspace_state`;
线上推送为 `workflow_status`(`WorkflowStatus`)。`queue_detail` 承载逐意图投影,不并入本摘要。

| 属性                 | 类型              | 说明                                                                                  |
| -------------------- | ----------------- | ------------------------------------------------------------------------------------- |
| `workspaceName`      | text              | 不可变且唯一的工作区名称(RM-R10)                                                      |
| `state`              | enum              | `idle`\|`running`\|`paused`\|`awaiting_gate`\|`developing`\|`fixing`\|`done`\|`error` |
| `currentIntentId`    | id \| null        | 当前正在开发的意图(未运行时为 null)                                                   |
| `currentSessionId`   | text \| null      | 当前意图的开发会话,用于反向链接                                                       |
| `awaitingPermission` | boolean           | 当当前开发轮次因权限提示而暂停、等待人工回答时为 true(RM-A9);轮次结束时清除           |
| `error`              | text \| null      | 最近一次 park 原因摘要;无 park 时为 null                                              |
| `completedIds`       | `id[]`            | 本次运行中已完成(已提交 + 已推送)的意图 id 列表                                       |
| `startedAt`          | timestamp \| null | 编排器启动的时间;从未启动时为 null                                                    |

## 持久化存储(c3.db)

位于 `~/.c3/c3.db` 的 SQLite 台账(与工作区注册表同库,不同表)。Schema 版本通过
`PRAGMA user_version` 管理(当前为 `25`)。表:
`intents`、`intent_deps`、`intent_chats`(会话集合 + 隐藏集合在同一张表中)、
`tool_sessions`(`session_id` PRIMARY KEY + `created_at`)—— 工具创建会话(完成判定器、
共识顾问)的持久化集合,使 session-registry 的“显示工具会话”过滤器能在重启后存续,
以及 `intent_sessions`、`intent_logs`、`intent_worknotes`(追加式内容历史,见下方 WorkNote)、
`intent_fast_turns`(每 turn 结算记录)与
`intent_prs`(PR/MR 关系表,见上方 Intent PR)。
`tool_sessions` 只是一张标记表;工具会话的来源链接存放在 `session_kind='tool'` 行的
`session_metadata.owner_kind` / `owner_id` 中,无 owner 的工具行仅用于展示。会话被删除时,
其行也会被删除。`intent_deliveries`(意图↔交付关联边)由 delivery 域拥有并唯一写入,
本域的 SCHEMA 也声明同一 `CREATE TABLE IF NOT EXISTS` 并在删除意图的同一事务里清边 ——
一个从未打开过交付页的库里 delivery store 尚未初始化,那条 DELETE 会撞 "no such table"
并回滚整个删除事务;读侧 `hydrate` 亦只读该表与 `deliveries` 拼出 `linkedDeliveries`。
`intents` 表的时间戳列(`created_at`/`updated_at`/`completed_at`)以
`INTEGER` 存 epoch-ms,受控写入一律 `Date.now()`。`intents` 上的 `pr_id`/`pr_url`/`pr_status`
三列已冻结:运行时不读不写,只作为反向回填脚本 `scripts/rollback-intent-prs.mjs` 的落点保留
(裁决见 [ADR-0035](../../../architecture/adr/0035-intent-pr-table-split-and-migration-markers.md))。
一次性数据迁移的完成与否由跨域标记表 `schema_migrations` 判定,而非列存在性检查或
`PRAGMA user_version`。跨运行时驱动适配器与迁移处理见
[intent-management-design.md](intent-management-design.md)。

### WorkNote(追加式内容历史)

意图拥有的**只增不改不删**的内容历史,区别于 `intent_logs` 的简短操作审计:`intent_worknotes`
每行承载一个 `work` 完成总结 / `review` 问题 / `fix` 修复说明的自由文本正文,供后续 Agent 读取
前序上下文,不必仅凭 PR diff 推断。字段与共享协议 `IntentWorknote` 一一映射:`id`(uuid)、
`intentId`、`kind`(`work`/`review`/`fix` 封闭枚举)、`note`(原样保存,含换行与首尾空白)、
`sessionId`(可选历史引用,null 表示未知或省略)、`createdAt`(epoch-ms)。纠正通过再次追加表达;
不决定意图、PR 或 Review/Fix 的当前状态,不提供单条更新/删除/覆盖。唯一例外是意图物理删除,
在删除主记录的同一事务内级联清除。经 MCP 工具 `append_intent_worknote` / `list_intent_worknotes`
读写(见 spec RM-R50)。

跨领域的 `session_metadata` 投影存在于意图台账的唯一真实来源表之外。intent 的写入操作
会为列表/计数读取 upsert/delete 投影行,但意图内容、当前会话选择、以及隐藏集合成员资格
仍归 `intent_chats` 所有。
</content>
