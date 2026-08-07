# 0039 — 合并回主线走交付 PR

- **Status:** accepted
- **Date:** 2026-08-07

## Context

交付的终点是合入主线,而 c3 此前没有任何自动 merge 能力——`server/src/features/intents/worktree.ts` 明确 never auto-merge。服务端直接 `merge --no-ff && push` 在有保护分支的仓库上根本推不上去,更绕开了 CI、审批与 diff review。

同时,`delivered` 若靠人再点一次,必然出现「代码已进主线、状态还停在已验证」的漂移;而「合不了」这件事有三种完全不同的原因,把它们混成一类是最容易出错的设计。

## Options considered

- **A. 服务端直接 merge + push**:被否决。保护分支推不上去,CI 与审批被绕过,失败态无处安放。
- **B. 建一条「交付分支 → 主线」的 PR,人在 forge 上合并。采纳。**
- **C. 新增一种合并会话 / SessionKind,让 agent 去合**:被否决。合并主线是需要人担责的动作,交给 agent 只是把责任藏起来。
- **D. 后台定时轮询交付 PR 状态**:被否决。与「永不后台自动改写共享分支」同源的立场——感知窗口期用「进页自动同步一次 + 手动同步」覆盖即可。
- **E. 复用 `pr:merge` 事件表达交付上主线**:被否决。`pr:merge` 表达自动化对意图 PR 的操作指令,交付上主线是系统观测到的终态事实,复用会让既有订阅者的语义漂移。

## Decision

- **合并回主线走交付 PR,人在 forge 上点合并。** c3 只负责建 PR 与同步事实,从不代合、不自动关旧 PR、不删远端分支。
- **交付 PR 独立存 `delivery_prs` 表。** 与 `intent_prs`(意图 → 交付分支)粒度和生命周期都不同:后者喂「集成就绪 N/M」聚合、随解除关联删行,前者两者皆不。同表会让「哪条 PR 表达交付上主线」失去精确答案。
- **重试必须先查 forge 事实,不得凭本地返回码判定。** 按 (head = 交付分支, base = 主线) 查开放 PR:命中即复用落账,未命中才创建;查询本身失败则中止,「问不出来」绝不当作「没有」。这一条同时覆盖「创建成功但响应丢失」与「本地行丢失」。forge 对同一 (head, base) 只保留一条开放 PR,因此落账按 PR 身份就地刷新 SHA,`(delivery_id, base_sha, head_sha)` 唯一索引作并发兜底。
- **三类失败分层,对应三种截然不同的现实**:
  - merge 冲突 → 代码要改,系统写 `verified → verifying`,落库冲突文件列表与 SHA;
  - CI 失败 / 审批不足 → **代码没问题,缺的是外部条件**,状态不动,落 `blocked_reason`,页面展示「合并受阻」。此处回退状态只会让用户白白重做一次从未失效的验证;
  - 查询失败 / 网络故障 → 什么都没发生,不改状态、报可重试错误。
- **`delivered` 判定 = 交付 PR 状态变 merged,由系统在同一事务内原子写入**(状态 + 交付日志)。事务提交后才发事件、触发闸门重算与广播:它们是既成事实的后果,失败不得回滚已落定的 `delivered`。
- **系统可写交付状态的完整例外集仅两条**:合并成功 → `delivered`;merge 冲突 → 回退 `verifying`。两条都是状态机 `EDGES` 里既有的系统边,本变更只落地系统侧写入口,不改状态机。这不违反「开发会话不改状态」——该规则约束的是开发会话,而非异步终态回调。
- **`delivered` 后不改写关联意图状态。** 意图在 PR 合入交付分支时已 `done`,二次改写会给状态制造第二个驱动源。
- **`delivered` 后必须触发跨交付依赖闸门重算。** 闸门判据读 `delivered`(ADR-0038),不重算则被 `delivery_not_delivered` 阻塞的意图永不解锁。
- **创建交付 PR 为工作区成员权限,不设管理员门。** forge 侧的保护分支与审批已经是真正的守门,c3 再加一道只是重复管控。
- **承认 forge 合并到 c3 感知之间的窗口期**,用「等待确认」横幅 + 进页自动同步一次 + 手动同步入口覆盖,不做后台轮询。

## Consequences

- 交付分支更新后(新 `head_sha`)在 forge 上表现为同一条 PR 被更新,c3 就地刷新该行的 SHA;PR 被关闭后重建才产生新行,旧行留作历史,页面只渲染最新行。
- 角标口径扩展:`verified` 且交付 PR 待创建、或已建 PR 且「合并受阻」的交付计入「需要用户处理」;纯等待他人合并不计入。该判定读台账,因此不放在状态机纯函数里。
- 新增通用事件 `delivery:delivered`,自动化可按该类型订阅;它走既有归一化管道的默认归一化器,不需要专用归一化器。
- 多仓工作区与 `current-branch` 模式全程不可达(前者建交付已拒,后者没有交付分支),与既有裁决一致。
- 交付 PR 的 e2e **自起私有 server**,并在其 PATH 上放一个可编排的 `gh` 替身:合并、冲突、红 CI、缺审批、不可达这五种 forge 应答,沙箱仓库无法按需产生,而它们正是分层落定的输入。替身不放共享 server —— 那会顺带应答关联测试的查询,而后者存在的意义恰是证明「查不到状态必须阻塞」。被编排的只是输入,其下的 handler / 状态机 / 事务 / 台账 / 事件全是真的。

## Compliance

- `server/src/features/deliveries/index.ts` 的 `createDeliveryPrHandler` / `syncDeliveryPrHandler` 是交付 PR 的唯一入口;`detailFrame` 是 `deliveryPr` 的唯一装配点。
- 两处系统状态写都先过 `canTransitionDelivery`,并经 `commitDeliveryDelivered` / `commitDeliveryMergeConflict` 落在单个事务内(`server/src/features/deliveries/store.ts`)。
- 角标的台账侧判定唯一实现在 `server/src/features/deliveries/merge-attention.ts`,列表回包与广播共用。
- `delivery_prs` / `delivery_logs` 见 `database/tables.md` 与 `database/deliveries/`。
- 可编排的 `gh` 替身只存在于 `scripts/e2e/fixtures/fake-forge/`,且只被自起私有 server 的那一个 e2e 放上 PATH;把它挂到共享 server 上即违规。
- 覆盖:`server/src/features/deliveries/delivery-pr.test.ts`(闸门、先查 forge 的幂等、分层落定、`delivered` 原子写与连锁动作、角标)与 `scripts/e2e/e2e-delivery-pr-test.mjs`(同一批性质跑在真实导线上,含 `pr list` 先于 `pr create` 的调用序、真实 SHA、真实冲突文件与 `delivered` 原子写);跨交付闸门解锁由 `scripts/e2e/e2e-dependency-gate-test.mjs` 覆盖。
