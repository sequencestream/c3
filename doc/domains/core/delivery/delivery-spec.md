# delivery — 领域规格

## 概览

交付域把「一批意图共同集成并最终进入主线」建模为 Git 生命周期单元,提供本地台账、受控状态机、一级页面,以及一条真实存在的**交付分支**承接所有关联意图的 PR。「创建交付」与「初始化分支」是两个独立动作:前者是纯本地数据动作(不触网、失败可重建),后者是可重试的显式 Git 动作(fetch 基线 → 建分支/绑定已有 → 写 `branch_ready`)。分支就绪后成为状态机、意图关联与建 PR 的共同闸门;终态后分支不自动删除,仅提供需二次确认的手动清理。合入主线走一条「交付分支 → 主线」的**交付 PR**,由人在 forge 上合并;c3 只建 PR、同步事实并在感知到 merged 时落定 `delivered`。多仓工作区(根非 repo 且有子仓)全程拒绝,因为单列 `branch_name` 无法表达多仓中「部分仓已推送、部分仓未推送」的状态。

- **范围:** deliveries 台账 CRUD + 取消、六态状态机与守卫、按工作区计算的「需要用户处理」角标、交付一级页面(列表 + 详情两 Tab + 标题栏状态区(徽标 + 可达目标推进) + 缺口异常框 + 合并区)、`pr:merge` 一次性知情告知、交付分支生命周期(create/bind 初始化 + 孤儿分支防御 + 多仓拒绝 + 终态手动清理)、意图↔交付关联/解除(merged 禁解 + 解除时关闭未合并 PR + 关联时 diff 膨胀提示;交付页与意图详情标题栏两处入口并存,后者另有「当前意图独立交付」一键编排)、交付 PR 生命周期(先查 forge 事实的幂等创建 + 三类失败分层 + `delivered` 原子写 + 跨交付闸门重算)。
- **边界:** 不做 Epic / 里程碑语义(目标、度量、审批)、不自动删除远端分支、不支持多仓交付、不做 PR 改投(关联只建立边,不改已有 PR 的 base)、**不在 c3 内合并交付 PR**、不后台轮询 forge、不自动关闭旧交付 PR、不增加冗余就绪计数列、不做甘特/时间轴/统计卡/独立提交时间线/重复 PR 卡片/自定义字段/多维筛选。

## 核心实体

| 实体                   | 说明                                  |
| ---------------------- | ------------------------------------- |
| Delivery               | 交付台账(见 models)                   |
| DeliveryPr             | 交付 PR:交付分支 → 主线(见 models)    |
| DeliveryIntegration    | 实时「集成就熟 N/M」聚合(不持久化)    |
| DeliveryGuardReason    | 守卫缺口原因 + 跳转目标               |
| DeliveryTransitionPlan | 服务端计算的可达性 + 缺口(页面只消费) |
| IntentDelivery         | 意图↔交付关联边(见 models)            |
| AssociatedIntent       | 交付详情的关联意图行(见 models)       |

## 状态与转移

```mermaid
flowchart LR
  P[planned 待集成] --> I[integrating 集成中]
  I --> V[verifying 验证中]
  V --> OK[verified 验证通过]
  OK --> D[delivered 已发布]
  V -->|人工返工| I
  OK -->|仅系统:合并冲突| V
  P --> C[cancelled 已取消]
  I --> C
  V --> C
  OK --> C
```

所有状态写入统一经领域纯函数 `canTransitionDelivery`;客户端只展示服务端给出的可达性与缺口,不能自行放宽规则。边与守卫按顺序求值,失败不产生部分状态写入:

| 边                        | 角色 | 守卫                                                                                            |
| ------------------------- | ---- | ----------------------------------------------------------------------------------------------- |
| `planned → integrating`   | 人工 | 分支已就绪                                                                                      |
| `integrating → verifying` | 人工 | 分支已就绪 + 至少一个关联意图且其面向本交付的 PR 均为 merged(缺失 PR 与非 merged PR 都计入缺口) |
| `verifying → verified`    | 人工 | 前述守卫 + 本次动作显式人工确认验证通过                                                         |
| `verifying → integrating` | 人工 | 无数据守卫(返工)                                                                                |
| `verified → delivered`    | 系统 | 交付 PR 已 merged(同步动作在原子单元内写入)                                                     |
| `verified → verifying`    | 系统 | 原因 = merge_conflict(forge 判定交付 PR 不可合并)                                               |
| 任意非终态 → `cancelled`  | 人工 | 无数据守卫(取消不清理关联事实或远端资源)                                                        |

- 不在图中的边返回 `delivery.invalidStatusTransition`;边合法但角色/原因/守卫事实不满足返回 `delivery.transitionGuardFailed`,携带 `delivery.guard.*` 原因列表与可跳转目标。
- 守卫顺序:分支就绪 → 有关联意图且其 PR 均已合入交付分支 → 人工验证确认 → 合并成功。
- 服务端提交时必须**重新计算**守卫(客户端显示的守卫可能因 PR 同步或并发操作变旧),拒绝过期操作并返回最新缺口。

## 业务规则

| ID     | 规则                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DR-R1  | `deliveries.status` 只接受六态闭集,数据库 CHECK 与共享协议同一闭集;越界值在数据库层拒绝                                                                                                                                                                                                                                                                                                                                                                                                      |
| DR-R2  | `base_branch` 在建交付时快照工作区当前有效 `defaultMainBranch`(解析规则所得值,不可写空串);之后修改配置不回写历史交付                                                                                                                                                                                                                                                                                                                                                                         |
| DR-R3  | `branch_ready` 初始为假;创建/编辑均不触发分支探测或远端操作。它只由显式的 `init_delivery_branch`(成功或幂等绑定后)置为真,由 `cleanup_delivery_branch`(终态手动清理)置回假                                                                                                                                                                                                                                                                                                                    |
| DR-R4  | 活动态 `(workspace_path, branch_name)` 唯一;`delivered`/`cancelled` 不占位,允许复用历史分支名;空分支名不参与冲突                                                                                                                                                                                                                                                                                                                                                                             |
| DR-R5  | 「集成就熟 N/M」实时由关联意图数 M 与其中面向本交付 PR 已 merged 数 N 聚合,不持久化计数;无关联显示 `0/0` 但不能据此通过集成守卫                                                                                                                                                                                                                                                                                                                                                              |
| DR-R6  | 创建、编辑、取消、转移均为本地事务:任一步失败整体回滚,不留下半创建交付;分支初始化的 DB 写入发生在 git 动作成功之后,「push 成功但 DB 写失败」由下一次重试的孤儿分支防御幂等恢复                                                                                                                                                                                                                                                                                                               |
| DR-R7  | 首次在某工作区创建交付时,同一创建事务内判定「该工作区是否已有交付记录」;只有第一个响应携带 `pr:merge` 一次性告知标记(取消记录仍保留 → 重启/换客户端/再次创建均不重复提示)                                                                                                                                                                                                                                                                                                                    |
| DR-R8  | 交付 CRUD、取消、关联、状态推进与交付 PR 创建/同步采用既有工作区成员权限,不设管理员门槛(forge 侧保护分支与审批已是真正守门,c3 不重复管控);不提供永久删除入口                                                                                                                                                                                                                                                                                                                                 |
| DR-R9  | 角标只统计「需要用户处理」的交付:存在尚未满足的人工可解决缺口、当前存在可执行的人工推进/返工动作,或存在可执行的交付 PR 动作(`verified` 且交付 PR 待创建、或已建 PR 且「合并受阻」)时计 1;纯系统等待(含「等别人点合并」)、终态以及 `current-branch` 模式中被隐藏的 Git 动作不计数;取消动作本身不使交付进入角标                                                                                                                                                                                |
| DR-R10 | `verified → delivered`、`verified → verifying` 为系统专属边,人工写入被拒(transitionGuardFailed,角色缺口)                                                                                                                                                                                                                                                                                                                                                                                     |
| DR-R11 | `current-branch` 模式下交付仍可创建、查看、编辑、取消并查看聚合进度;不得因该模式禁用关联;详情动作区不渲染分支初始化/交付 PR/合并动作并给说明文案,隐藏动作通过前端入口不可触发、服务端亦拒(`delivery.deliveryPrModeUnsupported`),但纯数据状态与读取契约一致                                                                                                                                                                                                                                   |
| DR-R12 | 多仓工作区(根目录本身不是 git repo 且 `discoverSubRepos` 返回至少一个子仓;根非 repo 但只有单个子仓也按多仓处理)在建交付与初始化分支两处均拒绝,报 `delivery.multiRepoUnsupported`;创建交付的多仓判定为纯本地目录遍历,不触网                                                                                                                                                                                                                                                                   |
| DR-R13 | 分支初始化基线只取远端:先 `fetch origin <base_branch>`,再以 `origin/<base_branch>` HEAD 作为期望起点建分支;不取本地 ref(本地过期会让交付起点落后于团队主线)                                                                                                                                                                                                                                                                                                                                  |
| DR-R14 | 孤儿分支防御:`create` 模式下若远端已存在同名分支,比较其 HEAD 与期望起点——匹配视为上次「push 成功但 DB 写失败」的孤儿,幂等绑定(不重新 push);不匹配报 `delivery.branchConflict`,**绝不覆盖**远端分支                                                                                                                                                                                                                                                                                           |
| DR-R15 | `bind` 模式绑定远端已有分支:远端必须已存在(否则 `delivery.branchNotFound`);该分支被其他活动交付占用时拒绝(`delivery.branchConflict`,自身重试不算占用);不校验分支是否落后主线,落后仅发 `delivery.branchBehindMain` 警告                                                                                                                                                                                                                                                                       |
| DR-R16 | `branch_ready=false` 时,`planned → integrating`(以及 `integrating → verifying`、`verifying → verified`)被 `delivery.guard.branchNotReady` 守卫拦截;面向该交付的意图 PR 创建同样被拒并返回可读原因                                                                                                                                                                                                                                                                                            |
| DR-R17 | 交付进入 `delivered`/`cancelled` 后分支不自动删除;手动清理入口需二次确认(ConfirmDialog danger),确认后仅删除本地分支引用(若存在),不删除远端分支;清理仅限终态交付(`delivery.cleanupForbidden` 拒非终态)                                                                                                                                                                                                                                                                                        |
| DR-R18 | 意图↔交付关联是一条独立的边,不由 PR 事实推断;一对(交付, 意图)至多一条,同一意图对多个交付各一条是允许的。关联只建立边,不改投任何已有 PR                                                                                                                                                                                                                                                                                                                                                       |
| DR-R19 | 该意图对本交付的 PR 已 merged 时**禁止解除关联**:先看本地状态,本地非 merged 时再向 forge 查实时状态,任一为 merged 即拒(`delivery.unlinkMergedPrDenied`)并把本地状态同步为 merged。forge 状态读不到时同样拒(`delivery.unlinkPrStatusCheckFailed`)——无法确认「不是 merged」即按「可能 merged」处理                                                                                                                                                                                             |
| DR-R20 | 解除未合并关联时先关闭该 PR,**PR 已是关闭态视为成功**;关闭成功后删除该 `intent_prs` 行再删边。关闭失败整个解除被阻塞(`delivery.unlinkClosePrFailed`),关联边与 PR 行都不动                                                                                                                                                                                                                                                                                                                    |
| DR-R21 | 关联时若意图提交基于主线而非交付分支(判据见 models 的分叉点检测),关联**仍然成功**并附带 diff 膨胀警告;检测失败一律不报警                                                                                                                                                                                                                                                                                                                                                                     |
| DR-R22 | 永久删除意图时同事务清除其关联边,远端 PR 不动;取消交付**不删**关联边,终态交付的关联意图仍可查                                                                                                                                                                                                                                                                                                                                                                                                |
| DR-R23 | 交付详情关联意图列表的 PR 列是「该意图**对本交付**的 PR 状态」,不是意图的全局 PR 聚合                                                                                                                                                                                                                                                                                                                                                                                                        |
| DR-R24 | 关联了交付的意图,其 PR 的 base 是**该交付的分支**;建 PR 的目标解析、幂等键 `(intent_id, delivery_id)` 与全部拒绝码见 intent-management 的 RM-R32。**手动、自动化队列(RM-A5)、会话结束清理(RM-R26)三条创建路径共用同一份目标解析**,自动路径不再把 base 写死为主线:未关联交付时**手动**入口仍可直提工作区主线,而两条**自动**路径不建 PR(记 `pr_skipped` 日志),分支未就绪等目标不可用时同样不建 PR 并推送说明原因的待办,绝不回退主线。交付是可选聚合层,不强制先建交付                           |
| DR-R25 | 建 PR 的目标交付必须**已被该意图关联**:服务端拒绝把 PR 行落到 `intent_deliveries` 没有边的交付下,`intent_prs.delivery_id` 与关联边因此不会脱节。人工入口与顾问 MCP 入口共用同一条解析,交互层不开放多交付的建 PR 入口(数据层允许一意图多交付)                                                                                                                                                                                                                                                 |
| DR-R26 | 交付是关联意图的**写入窗口**:`planned`/`integrating` 允许新的写入会话,`verifying`/`verified`/`delivered`/`cancelled` 一律禁止(验证期间继续合代码等于验证结论作废;终态不再有写入)。意图关联多个交付时取最严 —— 任一禁止即阻塞。判据是共享领域纯函数,手动启动与自动化队列共用同一份实现,不留「自动化被拦、手动放行」的裂缝;拒绝码与队列原因码见 intent-management 的 RM-R41                                                                                                                    |
| DR-R27 | 关联了交付的意图,其 worktree 基线是 `origin/<交付分支>` 而非工作区主线;交付分支未就绪时回退主线基线并说明。已存在的 worktree **从不自动重建、从不暗中 merge**,详见 RM-R42                                                                                                                                                                                                                                                                                                                    |
| DR-R28 | 「同步主线」把 `origin/<base_branch>` 合入交付分支并推送,**只在 `integrating` 提供**:之前无可集成之物,`verifying` 起改动树正是让验证结论作废的事。它永远由人触发并需二次确认——后台静默改写共享分支且失败无人看,正是 never-auto-merge 立场要防的事;不做定时自动回灌。合并在一个**临时 detached worktree** 中进行,用户检出与各意图 worktree 一律不受影响;冲突原样浮出、中止合并且不推送,c3 不代选解法。主线未领先时同步是成功的空操作,不是错误                                                 |
| DR-R29 | 交付详情展示「主线领先 N 个提交」,N 由本地 remote-tracking ref 计算(`origin/<base_branch>` 相对 `origin/<分支>`),**不为此触网**:每次打开详情都 fetch 既慢又出人意料,而分支初始化/建 PR/同步主线都会刷新这些 ref。无分支或 ref 不可解析时不展示。它的作用是把冲突处置时机前移,让 `verified → delivered` 的最终合并接近 fast-forward                                                                                                                                                           |
| DR-R30 | 合入主线走一条「交付分支 → `base_branch`」的**交付 PR**,由人在 forge 上合并。c3 从不代合、不自动关闭旧交付 PR、不删远端分支。创建守卫按固定顺序:`worktree` 模式 → 交付 `verified` → 分支就绪 → 交付分支相对主线有差异(无差异即已被手动合入,拒 `delivery.deliveryPrNoDiff`)                                                                                                                                                                                                                   |
| DR-R31 | 创建交付 PR 的重试**必须先查 forge 事实**:按(head = 交付分支, base = 主线)查开放 PR,命中即复用落账,未命中才创建;查询本身失败即中止,「问不出来」绝不当作「没有」。这同时覆盖「创建成功但响应丢失」与「本地行丢失」。forge 对同一 (head, base) 只保留一条开放 PR,故落账按 PR 身份就地刷新 SHA,`(delivery_id, base_sha, head_sha)` 唯一索引作并发兜底                                                                                                                                           |
| DR-R32 | 交付 PR 事实同步按三类失败**分层**落定:merge 冲突 → 系统写 `verified → verifying` 并落库冲突文件与 SHA(代码要改);CI 失败 / 审批不足 → 状态不动、落 `blocked_reason`、展示「合并受阻」(代码没问题,缺的是外部条件,回退只会让用户白做验证);查询失败 / 网络故障 → 不改状态、报可重试错误。PR 已关闭只同步行状态                                                                                                                                                                                  |
| DR-R33 | `delivered` 判定 = 交付 PR 状态变 merged,由同步动作在**同一事务**内写入状态与交付日志。事务提交后依次:不改写关联意图状态(意图在 PR 合入交付分支时已 `done`)、触发跨交付依赖闸门重算(判据读 `delivered`,不重算则被阻塞意图永不解锁)、发 `delivery:delivered`、广播。事件或重算失败**不回滚**已落定的 `delivered`,同步可重试且幂等                                                                                                                                                             |
| DR-R34 | 承认 forge 合并到 c3 感知之间的**窗口期**:详情页展示「Forge 已合并,等待确认」并提供手动「同步」,**进页自动同步一次**;不做后台定时轮询(与「永不后台自动改写共享分支」同源)。同步发现 merged 即当场落 `delivered`,无需二次确认                                                                                                                                                                                                                                                                 |
| DR-R35 | 交付分支更新后在 forge 上表现为同一条 PR 被更新,台账就地刷新该行 SHA;PR 被关闭后重建才产生新行,旧行留作历史,页面只渲染最新行。远端遗留的旧 PR 由用户自行处置,不构成 c3 侧正确性问题                                                                                                                                                                                                                                                                                                          |
| DR-R36 | 交付全生命周期发六类通用事件供订阅:`delivery:created`(建交付成功)/ `delivery:status_changed`(**每一次**状态写,metadata 带 `from`、`to`,取值即六态)/ `delivery:branch_ready`(create/bind/孤儿幂等三路,`branch_ready` 置真后)/ `delivery:pr_created`(交付 PR 创建或 forge-first 幂等复用——对订阅方是同一个事实「交付 PR 已就绪」;`sync_delivery_pr` 不发)/ `delivery:delivered` / `delivery:cancelled`。全部走既有 `normalizeEvent → eventBus` 通用管线,不新增专用归一化器、不做事件历史持久化 |
| DR-R37 | 进入 `delivered` / `cancelled` 时 `status_changed` 与对应终态事件**同发,不去重**:订阅 `delivery:*` 的拿到完整转移轨迹,只订阅终态的专门订阅者不受影响。代价是通配订阅收到两条事实,这是有意的                                                                                                                                                                                                                                                                                                  |
| DR-R38 | 事件发布在状态写**提交之后**:发布失败只落 warn 日志,不回滚状态写、不阻断广播与跨交付闸门重算;终态双发的两条事件独立发布,任一失败不影响另一条。事实已经为真,不宣告它并不能使它变假                                                                                                                                                                                                                                                                                                            |
| DR-R39 | 交付对两个 MCP 面各暴露**只读**工具 `find_deliveries` / `view_delivery`,两面都**默认不勾选**(自动化面=不进任何内置模板的默认 allowlist;外部面=在可授权目录内但不进新 key 的默认工具集)。刻意**不提供任何交付写工具**:状态写必须过 `canTransitionDelivery` 与全部守卫,一个能直接设状态的工具会绕开它们                                                                                                                                                                                        |
| DR-R40 | `pr:merge` 事件的 `ref` 增加可选 `baseBranch`(合并目标分支名)与 `baseTarget`(`mainline` / `delivery-branch`),让订阅方区分产出落在交付分支还是主线。只带 `head`/`base` 的事件形态同样合法,不读这两个字段的订阅方无需改动;`baseTarget` 取值不在闭集内会在归一化时被丢弃,订阅方永远不会看到第三种值。事件发出后无法撤回,区分只能由订阅方自己检查字段完成,前置告知由 DR-R7 的一次性提示承担                                                                                                      |

## 用户场景

- **US-1(创建交付):** 用户在交付页点「新建交付」,填标题/描述/起止日期;服务端在同一数据动作内快照 `defaultMainBranch` 为 `base_branch`,落 `planned` 态。(DR-R1/DR-R2/DR-R6)
- **US-2(首次告知):** 工作区首个交付创建成功时,响应携带 `pr:merge` 告知标记,客户端提示一次「pr:merge 现在可能指向交付分支,请检查自动化订阅」;之后刷新/重启/取消后再建/并发双建均不重复,不同工作区各自提示一次。(DR-R7)
- **US-3(初始化分支):** 交付详情页展示分支初始化区(输入框默认 `delivery/<short-id>-<slug>`,可改),选择「新建」或「绑定已有」后点「初始化分支」;进度帧按 `fetching → creating → pushing`(或单个 `binding`)推进,成功刷新详情并广播列表。(DR-R13/DR-R14)
- **US-4(绑定已有分支):** 企业已有 `release/*` 时选「绑定已有」;远端不存在该分支 → `delivery.branchNotFound`;被其他活动交付占用 → `delivery.branchConflict`;落后主线仅警告 `delivery.branchBehindMain`,不拒绝。(DR-R15)
- **US-5(推进被守卫拦住):** `planned` 且分支未就绪时,「集成中」这个被守卫挡住的目标**根本不渲染**——界面上不存在该目标,也就无从点起;标题栏下方的缺口异常框呈现缺口与跳转入口(跳转到本页分支初始化区),状态保持 `planned`。(DR-R5/DR-R16)
- **US-6(确认验证):** 交付在 `verifying` 时点「验证通过」弹确认框,显式确认后才写 `verifying → verified`;页面浏览或派生事实不能自动推进。(DR-R10 守卫第三级)
- **US-7(终态清理):** 交付 `delivered`/`cancelled` 后详情页出现「清理分支」入口,点击弹 danger 确认框;确认后仅删本地分支引用(远端保留),结果 toast 反馈。(DR-R17)
- **US-8(current-branch 聚合):** 在 `current-branch` 模式,交付可创建/查看/编辑/取消/看 N/M;分支/PR/合并动作不渲染并显示「当前模式只提供聚合视图」说明。(DR-R11)
- **US-9(多仓拒绝):** 多仓工作区(根非 repo 且有子仓)建交付与初始化分支均被拒,报 `delivery.multiRepoUnsupported`。(DR-R12)
- **US-10(关联意图):** 用户在交付详情「关联意图」tab 点「关联意图」,从「尚未归属任何交付」的意图中选一个;关联后两侧互见——交付详情列出该意图(含它对本交付的 PR 状态与 head 分支),意图详情的元信息在「分支+commit」之后、「PR」之前显示「关联交付」。意图详情标题栏另有一处等价入口(见 US-20)。(DR-R18/DR-R23)
- **US-11(关联提示 diff 膨胀):** 意图先在主线上开发、之后才关联交付时,关联成功并提示「本意图提交基于主线,提向交付分支的 PR 会包含主线与交付分支的差异」,用户据此决定是否 rebase。(DR-R21)
- **US-12(解除关联):** 未合并行的行尾有「解除关联」,danger 二次确认后解除,其提向本交付的 PR 一并关闭;PR 已 merged 的行不提供该入口,强行发起也被服务端拒绝并给出原因。意图详情概览的元信息「关联交付」行另有一处等价入口(见 US-20)。(DR-R19/DR-R20)
- **US-14(验证期间拒绝新写入):** 交付进入 `verifying` 后,其关联意图的「开始工作」被拒并说明该交付已停止接受新写入;自动化队列同样不再挑选它,队列页显示 `blocked_delivery_status`。返工回 `integrating` 后两侧同时恢复。(DR-R26)
- **US-15(同步主线):** `integrating` 的交付详情显示「主线领先 N 个提交」并提供「同步主线」;点击弹确认框说明「会把 origin/<base> 合入交付分支并推送,冲突原样浮出」,确认后按 `fetching → merging → pushing` 推进,成功后刷新领先数。冲突时中止合并、不推送,原样展示 git 输出由用户处置。(DR-R28/DR-R29)
- **US-16(创建交付 PR):** 交付到达 `verified` 后,详情页合并区出现「创建交付 PR」;点击后服务端先向 forge 查同一 (head, base) 的开放 PR,复用或新建,落账后页面显示 PR 链接与状态。重复点击不会开出第二条 PR。(DR-R30/DR-R31)
- **US-17(合并受阻):** 交付 PR 的 CI 未通过或审批不足时,同步后交付**仍是**「验证通过」,合并区展示「合并受阻」并说明是修 CI 还是找人评审——代码本身没问题,不需要重做验证。(DR-R32)
- **US-18(合并冲突回退):** forge 判定交付 PR 与主线冲突时,同步把交付回退到「验证中」,合并区列出冲突文件;用户解决冲突后重新验证。本地冲突枚举失败时列表为空,回退依然成立。(DR-R32)
- **US-19(等待确认 → 已发布):** 人在 forge 上合并交付 PR 后,c3 尚未感知的这段时间里详情页展示「Forge 已合并,等待确认」;进页会自动同步一次,也可手动点「同步」。同步到 merged 即当场置为「已发布」,同一事务写状态与交付日志,随后此前被该交付阻塞的意图解锁。(DR-R33/DR-R34)
- **US-13(PR 提向交付分支):** 已关联交付的意图点「创建 PR」,PR 的 base 是该交付的分支,PR 行落在该交付分组下并计入 N/M;交付分支未就绪时被拒并给出可读原因;意图关联多个交付时不渲染建 PR 入口。**自动路径同理**:自动化队列完成一条已关联交付的意图后,其自动 PR 的 base 同样是该交付分支并计入 N/M(建 PR 发生在意图置 `done` 之后);分支未就绪 / 多关联时不建 PR,工作台出现说明原因的待办;未关联交付的意图完成后不产生任何 PR,需先关联交付再建。(DR-R16/DR-R24/DR-R25)
- **US-20(意图侧设置归属):** 未关联交付的意图,详情页标题栏有「关联交付」(主色描边强调——它决定 PR 提向哪条分支);点击弹出本工作区非终态交付(planned / integrating / verifying / verified)的单选框,选定即关联,回包带 diff 膨胀警告时照常提示。已关联恰一个时,标题栏只展示交付名(可点击跳转交付详情),「解除关联」在概览元信息「关联交付」行的交付名之后,二次确认明确告知会关闭该意图提向此交付的 PR;PR 已合并则被服务端拒绝并给出原因。关联多个交付时只展示、不给关联/解除路径。与交付页的关联入口并存,服务端是唯一门禁。(DR-R18/DR-R19/DR-R20/DR-R21)
- **US-21(当前意图独立交付):** 在关联弹窗点「当前意图独立交付」,以意图标题为交付标题、意图正文为描述、起止日期均为当天建一条交付,并立即关联当前意图、初始化交付分支到就绪,使这条小改动也能走交付分支建 PR。仅 worktree 模式提供该入口——current-branch 模式本就不提供分支与 PR 动作,一键创建到不了目的。三步中任一步失败都停在该步并给出原因,已完成的部分保留,可从交付页继续(建分支幂等可重试)。(DR-R1/DR-R11/DR-R13/DR-R18)

## 领域事件(线协议)

- 消费:`list_deliveries` / `create_delivery` / `get_delivery_detail` / `update_delivery` / `cancel_delivery` / `transition_delivery` / `init_delivery_branch` / `sync_delivery_mainline` / `cleanup_delivery_branch` / `link_intent_to_delivery` / `unlink_intent_from_delivery` / `create_delivery_pr` / `sync_delivery_pr`
- 发出:`deliveries`(含 `needsActionCount`)/ `create_delivery_result`(含 `prMergeNotice`)/ `delivery_detail`(含 `transitionPlan`、`associatedIntents`、`mainlineAhead`、`deliveryPr`,以及关联时可能出现的 `linkWarning`)/ `delivery_transition_failed`(含结构化缺口)/ `delivery_branch_init_progress`(阶段)/ `delivery_branch_init_result`(含可选 `warning` 落后提示)/ `delivery_sync_mainline_progress` / `delivery_sync_mainline_result`。关联/解除不发 `delivery:intent_linked/unlinked` 事件(噪声大、无消费场景);交付生命周期发六类通用事件,见 DR-R36。`pr:merge` 仍表达「某个自动化合并了一条 PR」这一操作事实,不用于表达交付上主线
- 错误码:见 `@ccc/shared` 的 `UI_ERROR_CODES.delivery.*`(含 `delivery.multiRepoUnsupported` / `delivery.branchNotFound` / `delivery.initFailed` / `delivery.cleanupForbidden` / `delivery.intentAlreadyLinked` / `delivery.unlinkMergedPrDenied` / `delivery.unlinkClosePrFailed` / `delivery.unlinkPrStatusCheckFailed` / 建 PR 目标解析的 `delivery.prCreateDeliveryUnknown` / `delivery.prCreateNotLinked` / `delivery.prCreateAmbiguous` / 交付 PR 的 `delivery.deliveryPrForbidden` / `delivery.deliveryPrModeUnsupported` / `delivery.deliveryPrNoDiff` / `delivery.deliveryPrCreateFailed` / `delivery.deliveryPrNotFound` / `delivery.deliveryPrSyncFailed`);守卫缺口走 `delivery.guard.*` locale 叶子。

## 数据字典

见 [delivery-models.md](delivery-models.md) 与 `database/deliveries/`(`deliveries.sql`、`intent_deliveries.sql`、`delivery_prs.sql`、`delivery_logs.sql`)。
