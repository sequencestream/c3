# 0017 — 外部 skill 加载机制:软链挂载 + 静默最新版 + 写操作管控

- **Status:** proposed
- **Date:** 2026-06-07

> 承接 ADR-0016(扁平布局 + vendor 范围),本条定型加载层的核心编排决策:软链为主的多 vendor
> 适配策略、.gitignore ack 状态机、dev-skill 设置↔skill-repos 配置触发-加载解耦、供应链接写操作审批。

> **2026-06-07 简化(本 ADR 同日收敛)**:删除 trust 三档审批(D3 原 pinned/review-on-update/unreviewed)。
> 外部 skill 改为**静默挂载**:固定挂入所有 build-link-capable vendor、直取 `ref` 最新版软链、挂载前无 trust 弹窗。
> 连带删除:trust 闸的评估与确认逻辑、加载取消机制、orphan 机制(孤儿链扫描 /
> 挂载消费标记 / 链记录的 trust 字段 / 链记录的消费时戳 / ack 记录的已审引用,在静默挂载下失去意义且
> 生产从未调用)。skill 审批种类仅留 `'gitignore'` 一种,3/3 只剩一个 `.gitignore` 模态框。理由见下文标注。

> **2026-06-12 生命周期改动(启动挂载 → 显式安装 + 状态查询)**:外部 skill **不再在 session 启动时挂载**。
> 启动前的建链编排删除,启动 run 不再做任何挂载/网络操作。改为设置面板驱动的两个显式操作,
> 目标收敛为**两个共享公共目录** `.claude/skills` 与 `.agents/skills`(被多 vendor 共用,故只针对目录、不枚举 vendor;
> 旧实现还覆盖的 `.codex/skills` 不再纳入):
>
> - `get_skill_link_status`(只读、零网络):按 id 查 `_c3_<id>` 在两公共目录的软链存在性 → 链接状态。
> - `install_skill`(写):clone/pull `ref` 最新 head → **覆盖式**删旧链/目录后重建链到两目录;保留一次性 `.gitignore` ack。
>   始终取最新 —— 无 cache-hit / ref 过期判定(更新只由手动安装触发,从不静默)。
>   供应链写守卫(D5)由「挂载产物存在」改为启动时**只读探测**
>   「任一配置 skill 在公共目录有活跃链即开守卫」;配了未安装 → 无链 → 守卫关且该 skill 确实用不上,语义一致。
>   连带:软链缓存索引失去用途(状态改为 FS 实查),留作后续清理。
>   下文 D3/Consequences/Compliance 已据此更新。

## Context

ADR-0016 已完成 spike 验证并定型了两个前提:

1. **扁平布局**:`<vendorSkillDir>/_c3_<id>/SKILL.md`(嵌套两层不被发现)。

本批(2/3)在此基础上实现核心编排层——把 1/3 的 skill-repo 克隆产物接到 session 启动之间,
完成软链挂载、生命周期、信任审批、触发解耦和写操作管控。这五个方面各有设计决策。

## 设计决策

### D1 — 软链为主,不复制

将外部 skill 的目录结构克隆到 `${C3_DIR:-~/.c3}/repo/<hash>` 后,**不复制文件**到 vendor 目录,而是在
`<vendorSkillDir>/_c3_<id>/` 建一个**目录符号链接**(symlink)指向克隆内的 skill 源目录。

- **为什么不是复制?** 复制引入同步问题(更新需要整体替换),且复制后的文件失去与上游的溯源关系。
  软链让 vendor SDK 直接读原位文件,更新只需 `git pull`。
- **为什么不是 hardlink?** 跨 filesystem 不可用,且不能表达「指向缓存目录内子路径」。
- **风险**:vendor CLI 升级时若改变 glob 行为可能意外扫到原先不可见的链接路径。但 spike A 已实证
  Claude SDK 的 `skills/*/SKILL.md` 单层 glob 不会递归扫子目录,且 soft-link 本身透明,
  行为等价于同目录内的真实目录。**此风险已收录**,re-probe 机制(见 D2)会在 SDK 版本变化时重验。

### D2 — skill 支持探测缓存 + SDK 升级主动失效

- 探测结果持久化,带 `sdkVersion` 字段。
- 失效条件:记录的 `sdkVersion` ≠ 当前 SDK/CLI 版本 → 重探。
- `none`/`temporarily-unavailable` → 该 vendor 不建链 → UI 标灰 → session 仍启动。

**为什么不是每次启动都探?** 支持探测涉及子进程开销(`cli --version`+可能的 SDK 查询),
缓存一次 session 启动少 3 次子进程(三 vendor)。

### D3 — ~~trust 三档审批~~ → 静默挂载最新版(2026-06-07) → 显式安装(2026-06-12)

**已废弃** pinned/review-on-update/unreviewed 三档。**2026-06-12 起亦不在启动时挂载**:安装动作
由 `install_skill` 消息触发,对单个 config 克隆 / 拉取 skill-repo(clone/pull 最新 head)+ **覆盖式**重建链到两公共目录,
**全程无 trust 弹窗**。始终取最新,无 ref 过期判定。`get_skill_link_status` 提供只读状态(两目录的链接存在性)。

唯一保留的人工闸是 `.gitignore` 追加:按**项目维度**一次性 ack,持久化为该项目的 `.gitignore` ack,
确认后永久静默;安装时取消 ack 则该 skill 不安装(`install_skill` 返回 `reason: 'gitignore-cancelled'`)。

### D4 — dev-skill 设置↔skill-repos 配置触发-加载解耦

- dev-skill 设置保持为斜杠命令前缀(触发器),无语义变化。
- skill-repos 配置中的每条 repo 都有一个加载源的全局唯一标识。
- 当 dev-skill 去前导 `/` 后与某条 skill-repo 的标识精确相等 → 该 repo 在 launch 之前被建链。
- **解耦的意义**:触发器只负责「启动什么」,加载源只负责「从哪里加载」。以前 dev-skill 既是触发器又是
  源标识,两者混为一谈。现在一个 session 可以同时有 dev-skill(触发)和 skill-repos(源),两个维度独立。

### D5 — 供应链写操作审批,复用唯一的 permission-gateway chokepoint

不引入 SDK `hooks.PreToolUse` 通道,而是复用已有的单一 permission-gateway chokepoint。
判定:当 session 加载了外部 skill(存在挂载的 skill)且工具是写类(不在意图只读工具集内
且不是 `AskUserQuestion`),走审批请求 + 等待人工决策(MCP 同款)。

**为什么不做 frontmatter 解析?** skill 的 `allowed-tools` frontmatter 由 vendor SDK 内部处理,
本系统无权/无法介入解析。网关策略是 defense-in-depth:即使 SDK 对某个 write tool 发出
权限询问时标记为安全,本系统仍然要求人工确认。

### codex 项目级缺口(2026-06-12 收窄)

ADR-0016 spike B 只实证了 codex **user 级**(`~/.codex/skills/`) skill 发现。早期实现曾将 codex 软链落在
**项目级** `<projectDir>/.codex/skills/_c3_<id>/`。**2026-06-12 安装动作收敛为只覆盖两个共享公共目录**
(`.claude/skills`、`.agents/skills`),`.codex/skills` 不再纳入安装/状态。原 codex 项目级缺口随之关闭(不再建该链)。

## Consequences

- 3/3 仅渲染一个 `.gitignore` 模态框(简化后 trust、orphan 模态框已删);该模态框 2026-06-12 起由安装动作复用。
- **启动零开销 + 状态可见**(2026-06-12):启动 run 不再 clone/ls-remote/建链,仅做只读链探测;
  安装/状态收敛到两个公共目录,`.codex/skills` 不再覆盖,代价是接受「配了未安装则该 session 用不上该 skill」。
- 软链方案使 skill 升级成本低(`git fetch + reset --hard` 即可更新),且公共目录共享同一份克隆。
- 不再有「未消费链接」概念,orphan 启动扫描随之删除;软链缓存索引失去用途(状态改 FS 实查)。

## Compliance

- skill 安装、链接状态查询、已安装探测与两个公共目录的定义,落 skill-loader 模块
  (启动建链、orphan 扫描、挂载消费标记已删,2026-06-12)。
- 协议 `get_skill_link_status` / `install_skill`(client)+ `skill_link_status` / `skill_install_result`(server)落协议定义源;
  handler 落 skills 功能模块。
- `.gitignore` ack 状态机落 skill-loader 模块(trust 网关已删),安装动作复用。
- 写操作守卫落 permission gateway;其「存在挂载 skill」信号 2026-06-12 起由
  启动 run 经只读探测(查公共目录是否有活跃链)产生,而非挂载产物。
- 所有模块各有单测与挂载集成测试。

## References

- ADR-0016(扁平布局 + vendor 范围,本 ADR 的前提)。
- `doc/architecture/claude-agent-sdk-guide.md` §5「它如何读取 Skill」(全局 glob 行为)。
