# 0017 — 外部 skill 加载机制:软链挂载 + 静默最新版 + 写操作管控

- **Status:** proposed
- **Date:** 2026-06-07

> 承接 ADR-0016(扁平布局 + vendor 范围),本条定型加载层的核心编排决策:软链为主的多 vendor
> 适配策略、.gitignore ack 状态机、devSkill↔skillRepos 触发-加载解耦、供应链接写操作审批。

> **2026-06-07 简化(本 ADR 同日收敛)**:删除 trust 三档审批(D3 原 pinned/review-on-update/unreviewed)。
> 外部 skill 改为**静默挂载**:固定挂入所有 build-link-capable vendor、直取 `ref` 最新版软链、挂载前无 trust 弹窗。
> 连带删除:`evaluateTrustGate`/`recordTrustAck`、`SkillLoadCancelled`、orphan 机制(`scanOrphans`/
> `markMountsConsumed`/`SkillLinkRecord.trust`/`consumedAt`/`SkillAckRecord.reviewedRef`,在静默挂载下失去意义且
> 生产从未调用)。`SkillApprovalKind` 仅留 `'gitignore'`,3/3 只剩一个 `.gitignore` 模态框。理由见下文标注。

> **2026-06-12 生命周期改动(启动挂载 → 显式安装 + 状态查询)**:外部 skill **不再在 session 启动时挂载**。
> `ensureLinksForLaunch` 删除,`launchRun` 不再做任何挂载/网络操作。改为设置面板驱动的两个显式操作,
> 目标收敛为**两个共享公共目录** `.claude/skills` 与 `.agents/skills`(被多 vendor 共用,故只针对目录、不枚举 vendor;
> 旧实现还覆盖的 `.codex/skills` 不再纳入):
>
> - `get_skill_link_status`(只读、零网络):按 `id` 查 `_c3_<id>` 在两公共目录的软链存在性 → `SkillLinkStatus`。
> - `install_skill`(写):clone/pull `ref` 最新 head → **覆盖式**删旧链/目录后重建链到两目录;保留一次性 `.gitignore` ack。
>   始终取最新 —— 无 cache-hit / ref 过期判定(更新只由手动安装触发,从不静默)。
>   供应链写守卫(D5 `skillWriteGuard`)由「挂载产物 `mounted.length>0`」改为启动时**只读探测**
>   `hasAnyInstalledSkill`(任一配置 skill 在公共目录有活跃链即开守卫);配了未安装 → 无链 → 守卫关且该 skill 确实用不上,语义一致。
>   连带:`SkillLinkRecord` 软链缓存索引(`state.json.skillLinkIndex`)失去用途(状态改为 FS 实查),留作后续清理。
>   详见 `changes/2026/06/12/2026-06-12-001-external-skill-install-action/spec.md`。下文 D3/Consequences/Compliance 已据此更新。

## Context

ADR-0016 已完成 spike 验证并定型了两个前提:

1. **扁平布局**:`<vendorSkillDir>/_c3_<id>/SKILL.md`(嵌套两层不被发现)。

本批(2/3)在此基础上实现核心编排层——把 1/3 的 `ensureSkillRepo→skillDir` 接到 session 启动之间,
完成软链挂载、生命周期、信任审批、触发解耦和写操作管控。这五个方面各有设计决策。

## 设计决策

### D1 — 软链为主,不复制

c3 将外部 skill 的目录结构克隆到 `~/.c3/repo/<hash>` 后,**不复制文件**到 vendor 目录,而是在
`<vendorSkillDir>/_c3_<id>/` 建一个**目录符号链接**(symlink)指向克隆内的 skill 源目录。

- **为什么不是复制?** 复制引入同步问题(更新需要整体替换),且复制后的文件失去与上游的溯源关系。
  软链让 vendor SDK 直接读原位文件,更新只需 `git pull`。
- **为什么不是 hardlink?** 跨 filesystem 不可用,且不能表达「指向缓存目录内子路径」。
- **风险**:vendor CLI 升级时若改变 glob 行为可能意外扫到原先不可见的链接路径。但 spike A 已实证
  Claude SDK 的 `skills/*/SKILL.md` 单层 glob 不会递归扫子目录,且 soft-link 本身透明,
  行为等价于同目录内的真实目录。**此风险已收录**,re-probe 机制(见 D2)会在 SDK 版本变化时重验。

### D2 — detectSkillSupport 缓存 + SDK 升级主动失效

- 结果持久化 `state.json.skillSupport`,带 `sdkVersion` 字段。
- 失效条件:记录的 `sdkVersion` ≠ 当前 SDK/CLI 版本 → 重探。
- `none`/`temporarily-unavailable` → 该 vendor 不建链 → UI 标灰 → session 仍启动。

**为什么不是每次启动都探?** `detectSupport` 涉及子进程开销(`cli --version`+可能的 SDK 查询),
缓存一次 session 启动少 3 次子进程(三 vendor)。

### D3 — ~~trust 三档审批~~ → 静默挂载最新版(2026-06-07) → 显式安装(2026-06-12)

**已废弃** pinned/review-on-update/unreviewed 三档。**2026-06-12 起亦不在启动时挂载**:`installSkill`
由 `install_skill` 消息触发,对单个 config `ensureSkillRepo`(clone/pull 最新 head)+ **覆盖式**重建链到两公共目录,
**全程无 trust 弹窗**。始终取最新,无 ref 过期判定。`get_skill_link_status` 提供只读状态(两目录的链接存在性)。

唯一保留的人工闸是 `.gitignore` 追加:按**项目维度**一次性 ack,落 `state.json.skillAcks[projectDir].gitignore`,
确认后永久静默;安装时取消 ack 则该 skill 不安装(`install_skill` 返回 `reason: 'gitignore-cancelled'`)。

### D4 — devSkill↔skillRepos 触发-加载解耦

- devSkill 保持为斜杠命令前缀(触发器),无语义变化。
- skillRepos 中的 `id` 是加载源的全局唯一标符。
- 当 `devSkill` 去前导 `/` 后与某 `skillRepoConfig.id` 精确相等 → 该 repo 在 launch 之前被 ensureLink。
- **解耦的意义**:触发器只负责「启动什么」,加载源只负责「从哪里加载」。以前 devSkill 既是触发器又是
  源标识,两者混为一谈。现在一个 session 可以同时有 devSkill(触发)和 skillRepos(源),两个维度独立。

### D5 — 供应链写操作审批,复用 canUseTool 唯一 chokepoint

不引入 SDK `hooks.PreToolUse` 通道,而是复用已有的独一 `canUseTool` 函数(gateway.ts)。
判定:当 session 加载了外部 skill(`hasMountedSkills=true`)且工具是写类(不在 `INTENT_READ_TOOLS` 内
且不是 `AskUserQuestion`),走 `permission_request` + `waitForDecision`(MCP 同款)。

**为什么不做 frontmatter 解析?** skill 的 `allowed-tools` frontmatter 由 vendor SDK 内部处理,
c3 无权/无法介入解析。c3 的网关策略是 defense-in-depth:即使 SDK 对某个 write tool 发出
`canUseTool` 询问时标记为安全,c3 仍然要求人工确认。

### codex 项目级缺口(2026-06-12 收窄)

ADR-0016 spike B 只实证了 codex **user 级**(`~/.codex/skills/`) skill 发现。早期实现曾将 codex 软链落在
**项目级** `<projectDir>/.codex/skills/_c3_<id>/`。**2026-06-12 安装动作收敛为只覆盖两个共享公共目录**
(`.claude/skills`、`.agents/skills`),`.codex/skills` 不再纳入安装/状态。原 codex 项目级缺口随之关闭(不再建该链)。

## Consequences

- 3/3 仅渲染一个 `.gitignore` 模态框(简化后 trust、orphan 模态框已删);该模态框 2026-06-12 起由安装动作复用。
- **启动零开销 + 状态可见**(2026-06-12):`launchRun` 不再 clone/ls-remote/建链,仅做只读链探测;
  安装/状态收敛到两个公共目录,`.codex/skills` 不再覆盖,代价是接受「配了未安装则该 session 用不上该 skill」。
- 软链方案使 skill 升级成本低(`git fetch + reset --hard` 即可更新),且公共目录共享同一份克隆。
- 不再有「未消费链接」概念,orphan 启动扫描随之删除;`SkillLinkRecord` 软链缓存索引失去用途(状态改 FS 实查)。

## Compliance

- `installSkill` / `getSkillLinkStatuses` / `hasAnyInstalledSkill` + `PUBLIC_SKILL_DIRS` 落 `kernel/skill-loader/index.ts`
  (`ensureLinksForLaunch`/`scanOrphans`/`markMountsConsumed` 已删,2026-06-12)。
- 协议 `get_skill_link_status` / `install_skill`(client)+ `skill_link_status` / `skill_install_result`(server)落 `shared/src/protocol.ts`;
  handler 落 `server/src/features/skills/index.ts`。
- `.gitignore` ack 状态机落 `kernel/skill-loader/approval.ts`(trust 网关已删),安装动作复用。
- 写操作守卫落 `kernel/permission/gateway.ts`(`skillWriteGuard`);其 `hasMountedSkills` 信号 2026-06-12 起由
  `launchRun` 经 `detectMountedSkills`(只读探测 `hasAnyInstalledSkill`)产生,而非挂载产物。
- 所有模块各有单测(`kernel/skill-loader/index.test.ts` + `e2e-mount.integration.test.ts`)。

## References

- ADR-0016(扁平布局 + vendor 范围,本 ADR 的前提)。
- `changes/2026/06/07/2026-06-07-006-external-skill-git-loader/spec.md`(设计 spec)。
- `specs/architecture/claude-agent-sdk-guide.md` §5「它如何读取 Skill」(全局 glob 行为)。
