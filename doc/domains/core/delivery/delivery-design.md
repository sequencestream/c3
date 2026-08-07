# delivery — 设计

实现 [delivery-spec.md](delivery-spec.md)。该能力由 `server/src/features/deliveries/`(store + 状态机 + handlers)、`server/src/git.ts`(交付分支与交付 PR 的 git/forge 助手)、`shared/src/protocol/delivery*.ts`(线契约)与 `web/src/pages/deliveries/`(一级页面)构成,并挂钩到 `wiring/broadcasts.ts` 的广播。

**复用基线。** 复用共享 `Db`(单文件 SQLite,`PRAGMA user_version` 只是各 store 自有的信息戳)、`resolveWorkspaceRoot`/`pathToId` 工作区解析、`HandlerMap` 穷尽注册门(ADR-0009)、通用事件归一化管道(ADR-0026)、既有 `ConfirmDialog`/`MobileStack`/i18n 类型安全 `t`。真正全新的是:deliveries 台账表、交付状态机纯函数、`delivery_transition_failed` 结构化缺口帧、按工作区计算角标、交付分支生命周期(create/bind 初始化 + 孤儿防御 + 多仓拒绝 + 终态清理),以及交付 PR 生命周期(先查 forge 事实的幂等 + 三类失败分层 + `delivered` 原子写)。

## 职责

| 关注点            | 说明                                                                                                                                                                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 台账读写          | `store.ts`:`listDeliveries`/`getDelivery`/`createDelivery`/`updateDelivery`/`setDeliveryStatus`/`integrationAggregate`/`setDeliveryBranch`/`clearDeliveryBranch`/`activeDeliveryHoldsBranch`                                                                             |
| 交付 PR + 日志    | `store.ts`:`getLatestDeliveryPr`/`upsertDeliveryPr`/`updateDeliveryPrFacts`/`insertDeliveryLog`/`listDeliveryLogs`/`commitDeliveryDelivered`/`commitDeliveryMergeConflict`;handler 端 `createDeliveryPrHandler` / `syncDeliveryPrHandler`                                |
| 关联边            | `store.ts`:`insertIntentDelivery`/`deleteIntentDelivery`/`isIntentLinked`/`listAssociatedIntents`/`deleteIntentPr`;handler 端 `linkIntentToDeliveryHandler` / `unlinkIntentFromDeliveryHandler`                                                                          |
| 状态机            | `state-machine.ts`:`canTransitionDelivery`(唯一写状态门)/`deliveryTargets`/`computeTransitionPlan`/`deliveryRequiresAction`/`countDeliveriesNeedingAction`                                                                                                               |
| 分支生命周期      | `git.ts`:`isMultiRepoWorkspace`/`fetchRemoteBaseAsync`/`remoteBranchHead`/`resolveRefHead`/`createDeliveryBranch`/`deleteLocalBranch`;handler 端 `initDeliveryBranchHandler` 编排 fetch → 期望起点 → 远端探测 → create/bind/孤儿判定 → DB 写入                           |
| forge 交互        | `git.ts`:`getForgePrStatus`(解除前的实时状态复核)/`closeForgePr`(已关闭视为成功)/`detectDeliveryDiffBloat`(关联时的分叉点检测)/`findOpenForgePr`(建交付 PR 前查开放 PR)/`getForgeDeliveryPrFacts`(状态+冲突+CI+审批,双 provider 归一)/`deliveryMergeTrial`(冲突文件枚举) |
| 工作区隔离 + 广播 | handlers 经 `resolveWorkspaceRoot` 解析路径、校验 `delivery.workspaceId` 归属;变更后 `broadcastDeliveries` 全量重读并带角标                                                                                                                                              |
| 页面              | `web/src/pages/deliveries/`:列表 + 详情两 Tab + 标题栏状态区(徽标 + 可达目标推进)+ 缺口异常框 + 分支初始化区,只消费服务端 `transitionPlan`                                                                                                                               |

## SQLite 层

- 位置:`server/src/features/deliveries/store.ts`。单文件 `~/.c3/c3.db`,惰性建表,`CREATE TABLE IF NOT EXISTS` 幂等;软失败:库不可用时读返回空/null、写抛错。
- 版本戳:`SCHEMA_VERSION=2`,写 `PRAGMA user_version=2`(仅信息性,与其它 store 互相覆盖无妨)。
- `intent_prs` 由 intent-management 域拥有;`integrationAggregate` 直接查该表,表未建时对 `sqlite_master` 判定降级 `0/0`(boot 期意图库可能尚未初始化)。`listAssociatedIntents` 同理对 `intents`/`intent_prs` 判存在,缺失返回 `[]`。
- `intent_deliveries` 由本域拥有并唯一写入,但 **intent store 的 SCHEMA 也声明同一 `CREATE TABLE IF NOT EXISTS`**:永久删除意图要在同一事务里 `DELETE FROM intent_deliveries`,而一个从未打开过交付页的库里本 store 的 schema ensure 尚未跑过,那条 DELETE 会撞 "no such table" 并回滚整个删除事务。两处均 `IF NOT EXISTS`,先初始化者建表。反向地,intent store 的 `hydrate` 只**读** `deliveries` 表拼出 `Intent.linkedDeliveries`(同样带表存在守卫),写仍然只在本域。

## Schema(PRAGMA user_version 迁移)

`deliveries` 表 + 索引(新库与迁移 `database/migrate/2026/08/06/032-deliveries.sql` 同构):

- `id` PK / `workspace_path` NOT NULL / `title` NOT NULL / `description` DEFAULT '' / `status` NOT NULL CHECK 六态 / `start_date` / `end_date` / `branch_name` / `base_branch` NOT NULL / `branch_ready` DEFAULT 0 / `created_at` / `updated_at`
- `idx_delivery_workspace_status(workspace_path, status)`
- `idx_delivery_workspace_active_branch` 部分唯一:`ON (workspace_path, branch_name) WHERE branch_name IS NOT NULL AND status NOT IN ('delivered','cancelled')`

`intent_deliveries` 关联边表(新库与迁移 `database/migrate/2026/08/06/033-intent_deliveries.sql` 同构):

- `id` PK / `delivery_id` NOT NULL / `intent_id` NOT NULL / `created_at` NOT NULL
- `idx_intent_delivery_unique` 唯一:`ON (delivery_id, intent_id)`——重复关联在应用层先判、索引兜底;唯一键**不是** `intent_id`,同一意图对多个交付各一条边是允许的
- `idx_intent_delivery_delivery(delivery_id)` / `idx_intent_delivery_intent(intent_id)`——交付详情按前者查关联意图,意图列表按后者查关联交付

`delivery_prs` 交付 PR 表(新库与迁移 `database/migrate/2026/08/07/035-delivery_prs.sql` 同构):

- `id` PK / `delivery_id` / `forge` / `repo` / `number` / `url` / `head_branch` / `base_branch` / `base_sha` / `head_sha` / `status` CHECK(`reviewing`/`merged`/`closed`)/ `blocked_reason` CHECK(`ci_failed`/`approval`)/ `conflict_files`(JSON 数组)/ 时间戳
- `idx_delivery_pr_identity` 唯一:`ON (forge, repo, number)`——一条真实 PR 一行
- `idx_delivery_pr_idempotency` 唯一:`ON (delivery_id, base_sha, head_sha)`——并发重试兜底
- `idx_delivery_pr_delivery(delivery_id, created_at DESC)`——页面只渲染最新一行

`delivery_logs` 操作审计表(新库与迁移 `database/migrate/2026/08/07/036-delivery_logs.sql` 同构):

- `id` PK / `delivery_id` / `operation_type` / `summary` / `actor` / `created_at` + `idx_delivery_log_delivery_created(delivery_id, created_at DESC)`

四张表均无存量回填:交付、关联边、交付 PR 与交付日志都是本域自有实体。

## Store

`createDelivery` 在单事务内:先 `COUNT(*)` 该工作区已有交付行判定首次 → `INSERT` → 返回 `{ delivery, prMergeNotice }`。`toDelivery` 每次读取附加 `integrationAggregate`(实时派生,永不落库)。`setDeliveryStatus` 只写库,**不做状态机校验**——调用方(handler)必须先过 `canTransitionDelivery`,该门在 feature 层唯一。

分支生命周期写入:`setDeliveryBranch(id, branchName, ready)` 一次性写 `branch_name` + `branch_ready`(仅 git 侧成功后调用);`clearDeliveryBranch(id)` 清空两者(仅终态手动清理);`activeDeliveryHoldsBranch(workspacePath, branchName, excludeId)` 供 `bind` 的占用检测(`excludeId` 排除自身重试),DB 层 `idx_delivery_workspace_active_branch` 部分唯一索引兜底。

## 分支生命周期(init_delivery_branch)

- **handler 编排** `initDeliveryBranchHandler`:多仓检测(`isMultiRepoWorkspace`,先于任何 git 命令)→ `fetch origin <base_branch>`(`fetchRemoteBaseAsync` 的异步等价,不取本地 ref)→ 以 `origin/<base_branch>` HEAD(`resolveRefHead`)为期望起点 → `remoteBranchHead` 探测远端同名分支 → 分派:
  - `create` + 远端不存在 → `createDeliveryBranch`(fetch → `git branch <name> <remote>/<base>` → `git push -u`),push 成功后才写 DB;
  - `create` + 远端存在且 HEAD == 期望起点 → 孤儿(上次 push 成功但 DB 写失败)幂等绑定,不重新 push;
  - `create` + 远端存在且 HEAD != 期望起点 → `delivery.branchConflict`,**绝不覆盖**;
  - `bind` + 远端不存在 → `delivery.branchNotFound`;
  - `bind` + 远端存在 → 占用检测(`activeDeliveryHoldsBranch`)→ 写 DB;HEAD 与基线不一致时结果帧携带 `warning: 'delivery.branchBehindMain'`(只警告不拒绝)。
- **git.ts 复用**:`isMultiRepoWorkspace`/`fetchRemoteBaseAsync`/`remoteBranchHead`/`resolveRefHead`/`createDeliveryBranch`/`deleteLocalBranch` 均为异步(与 `createWorktree` 的同步 `execFileSync` 区分——分支初始化是独立用户动作,不阻塞自动化 FSM);`createDeliveryBranch` 的 push 拒绝(`non-fast-forward`/`fetch first`)映射 `errorKind:'branchConflict'`。
- **进度**:`delivery_branch_init_progress` 按 `fetching → creating → pushing`(create 路径)或单个 `binding`(bind/孤儿幂等)推送请求连接;成功发 `delivery_branch_init_result` 并广播 `deliveries`。
- **清理**:`cleanupDeliveryBranchHandler` 仅接受终态(`delivered`/`cancelled`),`deleteLocalBranch` 尽力删本地引用(缺失即无事可删),随后 `clearDeliveryBranch`;远端分支永不触碰。

## 关联/解除接线

- **消息归 delivery 域**(`shared/src/protocol/delivery-messages.ts` 的 `ClientLinkIntentToDelivery` / `ClientUnlinkIntentFromDelivery`,不 re-export):关联边的生命周期与交付守卫紧密耦合(merged 禁解、集成聚合),放 intent 域会造成跨域反向依赖。回包是 `delivery_detail`(携 `associatedIntents`,以及仅在关联时可能出现的 `linkWarning`)+ `deliveries` 广播,无专用回复类型;**不发** `delivery:intent_linked/unlinked` 事件。
- **`detailFrame` 是唯一装配点**:每一条携带交付详情的回包都经它,保证 `transitionPlan` 与 `associatedIntents` 不会来自两次不同的读。
- **关联** `linkIntentToDeliveryHandler`:校验 workspace/delivery/intent 归属 → 事务内判重后插边(唯一索引兜底,冲突报 `delivery.intentAlreadyLinked`)→ diff 膨胀检测(纯观测,失败静默)→ 回 `delivery_detail` + 广播 `deliveries` **与 `intents`**(意图侧要看到 `linkedDeliveries`)。**不改投**已有的无交付归属 PR:关联只建立边,改一条开着的 PR 的 base 不该由一次关联点击代劳。
- **解除** `unlinkIntentFromDeliveryHandler`:取该意图**对本交付**的 PR 行 → 本地 `merged` 直接拒 → 否则向 forge 查实时状态(查不到即 `delivery.unlinkPrStatusCheckFailed` 阻塞;forge 说 merged 则同步本地状态后拒)→ 确认未合并才 `closeForgePr` → 关闭成功后删 PR 行、再删边 → 回包 + 双广播。关闭失败报 `delivery.unlinkClosePrFailed`,边与 PR 行都不动。守卫理由与「为什么删行而非留 `closed`」见 [delivery-models.md](delivery-models.md)。
- **git.ts 侧**:`closeGhPr`/`closeGlabMr` 把「已关闭 / not open」类输出识别为**成功**(子串匹配,与既有 `GH_NOT_LOGGED_IN_MARKERS` 同风格),但显式排除含 `merged` 的输出——merged 是必须拒绝的另一种状态,绝不吞掉。`detectDeliveryDiffBloat` 实现分叉点判据(见 models),对无交付分支/ref 缺失/非仓库一律返回 `false`。
- **清理**:`deleteIntentRecords` 同事务追加 `DELETE FROM intent_deliveries`(远端 PR 不动);`cancel_delivery` 不碰关联边。

## 状态机接线

- `state-machine.ts` 是纯函数模块(无 DB/WS 依赖),表驱动 `EDGES` 定义六态边 + 角色 + 守卫序列;`canTransitionDelivery` 对非法边返回 `delivery.invalidStatusTransition`,对角色/原因/守卫不满足返回 `delivery.transitionGuardFailed` + 缺口列表。
- handler 的 `applyTransition` 统一服务 `transition_delivery` 与 `cancel_delivery`:从当前事实(分支就绪、聚合)重新计算守卫,失败发 `delivery_transition_failed`(含 `currentStatus` + `to` + 缺口),成功写库并回 `delivery_detail` + 广播。
- 系统专属边(`verified → delivered`、`verified → verifying`)的唯一写入口是 `sync_delivery_pr`:它以 `role:'system'` 求值,通过后经 `commitDeliveryDelivered` / `commitDeliveryMergeConflict` 在单事务内落定。状态机本身不因此改动——两条边本就在 `EDGES` 表中。
- `branchNotReady` 缺口的 `jumpTo` 为 `branch`(本页分支初始化区),不再是 `workspace-settings`;`branch_ready` 变为可写后,`branchNotReady` 守卫真正生效。

## 事件接线(`delivery:*`)

- 发布集中在 handler 层,**不在 store 层**:store 拿不到 `ctx`,也不该触碰总线。唯一发布入口是 `deliveries/index.ts` 的 `publishDeliveryEvent(ctx, workspacePath, action, metadata)`(`ctx.normalizeEvent` → `ctx.eventBus.publish('event', …)`,`sessionId` 为一次性 uuid);`publishDeliveryStatusChanged` 与 `publishDeliveryDelivered` 都只是它的具名封装。
- 发布点:`createDeliveryHandler`(`created`)、`applyTransition`(`status_changed`,目标为 `cancelled` 时再发 `cancelled`)、`initDeliveryBranchHandler` 的三条 ready 路径(`branch_ready`,由局部 `announceBranchReady` 统一;已就绪的幂等短路不发——没有新事实)、`createDeliveryPrHandler`(`pr_created`,创建与 forge-first 复用同发)、`syncDeliveryPrHandler` 的冲突回退(`status_changed` verified→verifying)、`settleDeliveryDelivered`(`status_changed` + `delivered` 双发)。
- 每一处都在状态写提交、`conn.send` 与 `broadcastDeliveries` **之后**调用;`publishDeliveryEvent` 内部把归一化失败收敛成一行 warn 日志,调用方不检查返回值——事件发布不是状态写的一部分(DR-R38)。
- 没有专用归一化器:`delivery:*` 落在注册表的**默认**归一化器上(结构化脱敏 + 截断),与 `delivery:delivered` 既有路径完全一致。订阅侧同样零改动——事件总线的 `eventFilters[]` 多行 OR 与 `<category>:*` 大类通配本就覆盖 `delivery:*`。
- 唯一的代码事实源是 `shared/src/event-catalog.ts` 的 `delivery` 类别(六个 action,均无 status 维度),自动化表单的级联选择器直接读它。

## 交付只读 MCP 工具接线

- `deliveries/tool-defs.ts` 是 framing-free 的核心(zod 形状 + 描述串 + `runFindDeliveries` / `runViewDelivery`),仿 `intents/tool-defs.ts` 的 find/view 模式,复用 store 的 `listDeliveries` / `getDelivery` / `listAssociatedIntents` / `getLatestDeliveryPr`;跨工作区读被 `resolveWorkspaceRoot(delivery.workspaceId) !== resolve(workspacePath)` 拦成友好的「未找到」。
- 自动化面:进 `automations/mcp-freeze.ts` 的 `C3_MCP_TOOLS`(`isWrite: false`,`find_`/`view_` 前缀也会被 `classifyTool` 独立判成只读)与 `automations/c3-tools.ts` 的 `buildAutomationC3Tools`;`getAutomationToolManifest` 自动带出,表单可勾选。
- 外部面:进 `external-mcp/tools.ts` 的目录与 `shared/src/protocol/settings.ts` 的 `EXTERNAL_MCP_READ_TOOLS`,分级 `read`;底部编译期目录钉死(built set == 名表)保持不变。
- **「默认不勾选」的落法**:外部面把「可授权目录」与「新 key 默认集」拆成两份名表——`EXTERNAL_MCP_READ_TOOLS` 只作分级来源,`EXTERNAL_MCP_DEFAULT_TOOLS` 才是建 key 时服务端强制写入的初值,交付工具进前者不进后者;另有一条编译期断言钉死默认集只能取读级工具。自动化面靠「不进任何内置模板的默认 `toolAllowlist`」达成同一语义。
- 不注册任何交付写工具,顾问面(`transport/advisor-mcp`)也不加交付工具。

## 角标

`countDeliveriesNeedingAction` 对工作区每个交付求 `deliveryRequiresAction`(可执行人工推进/返工动作存在、存在人工可解决缺口,或存在可执行的交付 PR 动作)之和。`HUMAN_SOLVABLE_GAPS` 是空集:转移计划能报出的缺口要么在页面别处解决(分支初始化、意图关联),要么是纯系统等待。挂在系统边上的那个人工动作——建交付 PR / 解合并受阻——**无法表达为计划缺口**(计划看不见有没有 PR),因此走独立的 `mergeActionable` 入口:判定读台账,唯一实现在 `merge-attention.ts` 的 `deliveryMergeActionable`(`verified` + `worktree` + 「无 PR 或 PR 已关闭」或「PR 开放且受阻」),由列表回包与广播共用。角标随 `deliveries` 帧下发(`needsActionCount`),前端不重算。

## 广播

`wiring/broadcasts.ts` 的 `broadcastDeliveries(workspacePath)`:库可用时重读 `listDeliveries` + `countDeliveriesNeedingAction`,以 `ServerDeliveries` 帧推所有连接。`KernelContext` 挂 `broadcastDeliveries`,`server.ts` 装配。

## 前端

`web/src/pages/deliveries/` 容器经 `App.vue` 注入 `currentDeliveries`/`activeDelivery`/`activeDeliveryPlan`/`activeDeliveryIntents`/`deliveryLinkIntents`/`activeDeliveryBranchInit`/`workspaceGitBranchMode`。页面只消费服务端 `transitionPlan`,在常驻标题栏渲染状态徽标(六态分别配色、纯展示)与推进区:推进区只渲染可达目标(非法目标与守卫未满足/系统专属的目标均不出现),「集成就绪 N/M」以小字落在同一动作组内;缺口(`delivery.guard.*` 文案 + 跳转)由标题栏下方的异常框呈现。`verifying → verified` 点击先弹 ConfirmDialog 显式人工确认。`current-branch` 模式显示「仅聚合视图」说明文案,动作区不渲染分支/PR/合并动作。角标 `HEADER_TABS` 取 `deliveriesNeedsAction[currentWorkspace]`。

**分支初始化区**(概览 tab,`worktree` 模式):未就绪时显示 create/bind 切换 + 分支名输入框(默认 `delivery/<short-id>-<slug>`,由 `defaultDeliveryBranchName` 生成)+「初始化分支」按钮 + 进度行(`delivery_branch_init_progress` 相位文案);就绪后显示分支名;终态且持有分支时显示「清理分支」入口(danger ConfirmDialog 二次确认)。`branchNotReady` 缺口跳转 `branch` 会切到概览并聚焦该区。`message-handler` 处理 `delivery_branch_init_progress`/`delivery_branch_init_result`(成功清 in-flight + 采纳模型 + 重取详情 + 落后警告 toast),并在 init 错误码时清 in-flight + toast。

## 交付 PR 接线(create_delivery_pr / sync_delivery_pr)

- **创建** `createDeliveryPrHandler`:`resolveDeliveryPrContext` 按固定顺序过闸(`worktree` → `verified` → 分支就绪)→ fetch 两端并解析 `base_sha`/`head_sha`(SHA 是幂等键的材料,读本地过期 ref 会把行钉在一个远端已不存在的状态上)→ `countCommitsAhead` 判有差异 → **`findOpenForgePr` 先查 forge**,命中即复用、未命中才 `createForgePr`、查询失败即中止 → `upsertDeliveryPr` + 交付日志 → 回 `delivery_detail` + 广播。
- **同步** `syncDeliveryPrHandler`:取最新交付 PR 行(无行报 `delivery.deliveryPrNotFound`)→ `getForgeDeliveryPrFacts` 归一化 forge 事实 → 分层落定:`merged` 走 `settleDeliveryDelivered`;`open + 冲突` 先 `deliveryMergeTrial` 枚举冲突文件再经状态机写 `verified → verifying`(交付已不是 `verified` 时只刷新冲突证据,不去要一条不存在的边);`open + CI/审批` 只写 `blocked_reason`;`open` 无阻塞清空 `blocked_reason`;`closed` 只同步行状态;查询失败什么都不写。
- **`settleDeliveryDelivered`**:`canTransitionDelivery(role:'system', mergeSucceeded:true)` → `commitDeliveryDelivered`(状态 + 日志 + PR 行同一事务)→ **提交后**发 `delivery:status_changed`(verified→delivered)与 `delivery:delivered` 两条事件(均经 `ctx.normalizeEvent` 走通用事件管道的默认归一化器)、`markQueueDirty` 触发跨交付闸门重算、广播 `deliveries` **与 `intents`**。已是 `delivered` 的重复同步只刷新 PR 行,不二次写日志、不重复发事件。
- **git.ts 侧**:`findOpenForgePr` 以 `gh pr list --head/--base --state open` 与 `glab mr list --source-branch/--target-branch` 归一为同一答案;`getForgeDeliveryPrFacts` 把 GitHub 的 `mergeable`/`statusCheckRollup`/`reviewDecision` 与 GitLab 的 `detailed_merge_status`/`has_conflicts`/pipeline 状态归一为 `conflict`/`ciFailed`/`approvalMissing` 三个布尔;`deliveryMergeTrial` 在**临时 detached worktree** 中试合(与 `syncDeliveryMainline` 同款),纯观测、失败即空列表。
- **前端**:概览 tab 的合并区(`worktree` 模式,`verified` 起或已有 PR 时渲染)给出建 PR / PR 链接与状态 / 「Forge 已合并,等待确认」/「合并受阻」/ 冲突文件列表 / 「同步」。`message-handler` 在 `delivery_detail` 到达时采纳 `deliveryPr`、清 busy 标志,并按 `autoSyncedDeliveryPrs` 做**进页一次**的自动同步(该帧同时是同步自己的回包,不设这道闸就会自激)。

## 依赖

`intent-management`(读 `intent_prs`)、`session-registry` 的工作区解析、`wiring/broadcasts`。不 import `transport/`(ADR-0009 R1 的 kernel 边界)。

**关联意图 tab**(`DeliveryIntentsTab.vue`):四列——意图标题 / 意图状态 / **该意图对本交付的 PR 状态** / head 分支,直接渲染服务端 `associatedIntents`,不做任何客户端聚合(用全局 PR 聚合会把别的交付的状态显示到这里)。解除入口收在行尾次级位置,PR 已 merged 的行渲染为禁用态 + tooltip,未合并行走 danger `ConfirmDialog` 二次确认;禁用只是提前表达,门禁在服务端。关联入口的候选只列「尚未归属任何交付」的意图——交互层不给出一个意图关联多个交付的路径。`openDeliveries` 顺带发 `list_intents`(用户可能直接落在交付页,意图列表未必加载过);候选取 `deliveryLinkIntents`(按**交付页**工作区取,不复用意图页的 `intentsProject`)。

标题渲染为链接态按钮,点击跳到该意图详情:emit `open-intent` 经 `DeliveryDetail` → `Deliveries` → `App.vue` 上抛,`App.vue` 以**交付页当前工作区**(`deliveriesProject`)调 `openLinkedIntent`(`openIntents(path)` + 写 `requestedIntentId`),由 `Intents.vue` 在列表加载后一次性选中该意图、桌面右栏显示详情默认 tab、移动端直接落详情视图;意图已被删除 / 未出现在列表时沿用 Intents 既有的兜底选中,不白屏。热区只覆盖标题文字(行尾就是「解除关联」危险按钮,整行可点会抬高误触风险),与意图详情侧「关联交付」的 `open-delivery` 反向对称。

**意图详情侧**(`IntentOverviewTab.vue`):元信息顺序 `ID → 分支+commit → 关联交付 → PR → 已创建 → …`。「关联交付」必须在 PR **之前**——交付决定 PR 提向哪条分支,先因后果读下来才成立。PR 行按交付分组(无交付归属的单列一组;只有一组且无交付归属时不渲染组标签,避免最常见场景平白多一行噪音)。该 tab 对关联**纯只读**,只负责导航:点击关联交付经 `open-delivery` 一路上抛到 `App.vue` 的 `openDeliveryFromIntent`(先 `openDeliveries` 再 `openDelivery`,否则详情会在没有列表的情况下半加载)。

**意图详情标题栏**(`IntentTitleBarActions.vue`):意图侧的关联/解除入口,与交付页入口并存,服务端是唯一门禁。入口排在建 PR 按钮之前,按 `linkedDeliveries` 分三态:

- **0 条** —「关联交付」按钮,打开 `IntentLinkDeliveryDialog`(候选 = 本意图工作区交付中 `status ∉ {delivered, cancelled}`)。意图页从不主动拉交付列表,故开框同时上抛让控制层补发 `list_deliveries`;候选取 `intentLinkDeliveries`(按**意图页**工作区取,与交付页的 `deliveryLinkIntents` 互为镜像)。候选按状态过滤是展示规则,服务端 `link` 本身没有终态守卫,本侧不代它加门禁。
- **恰 1 条** — 展示交付名(点击复用 `open-delivery` 跳转)+「解除关联」。解除先过 danger `ConfirmDialog`,文案点明**会关闭该意图提向此交付的 PR**;是否放行由服务端复核(本地 + forge 双层,已合并直接拒 `delivery.unlinkMergedPrDenied`,走中央错误链路,意图侧不特判)。
- **>1 条** — 只展示各交付名,不给关联/解除路径。与「多关联不渲染建 PR 入口」同一条裁决:目标不唯一时交互层不替用户选,数据层的多边关系不受影响。

**「当前意图独立交付」**(弹窗标题栏右侧):以当前意图的标题为交付标题、正文为描述,起止日期均为**本地当天**,一键建一次专属交付并达到 `branchReady`。纯前端编排三条既有消息,没有专属协议面:

```
create_delivery ──create_delivery_result──▶ link_intent_to_delivery ──▶ init_delivery_branch
```

- 三步靠控制层一个一次性的「待独立交付」pending 槽串起来(`create_delivery_result` 是新交付 id 存在的第一刻);该槽同时是防双发守卫,create 被拒时释放,交付页自己建的交付因槽为空而不会被误接。
- 顺序取**先关联、后初始化**:link 时交付分支尚未创建,diff 膨胀检测按「无分支」不报警——语义正确,独立交付分支必然自当前主线头创建,意图提交的分叉点按构造是其祖先。
- 日期以 `calendarDateToEpochMs(本地当天 YYYY-MM-DD)` 编码。wire 约定是「用户所选日历日的 UTC 零点」,若改用本地零点,UTC+8 等正时区会编码成前一天 16:00Z,详情页经 `epochMsToCalendarDate` 渲染成「昨天」。
- 按钮**仅 worktree 模式渲染**:current-branch 模式下交付侧本就不提供分支初始化与交付 PR 入口(服务端拒 `delivery.deliveryPrModeUnsupported`),一键创建到不了「能建 PR」这个目的;该模式下仍保留关联选择与展示/解除。
- 三步各自可能独立失败且不做协议级回滚,全部走既有错误链路:create 失败无残留;link 失败则交付已存在未关联,可去交付页补;init 失败则交付已关联但 `branchReady=false`,可在交付页分支初始化区重试(`init_delivery_branch` 幂等)。交付数量随意图增长而膨胀是「小改动也走交付分支」的既定代价,不做自动去重。

意图侧这组动作全部使用**显式参数变体**(`loadDeliveriesForLink` / `linkIntentDelivery` / `unlinkIntentDelivery` / `initDeliveryBranchFor` / `createStandaloneDelivery`):交付页现有方法一律绑定「当前打开的交付」(`activeDeliveryId` + `deliveriesProject`),而两个 tab 可以停在不同工作区,意图页也没有「打开的交付」。发出的协议消息与交付页完全相同。
