# 0017 — 外部 skill 加载机制:软链挂载 + 信任审批 + 写操作管控

- **Status:** proposed
- **Date:** 2026-06-07

> 承接 ADR-0016(扁平布局 + vendor 范围),本条定型加载层的核心编排决策:软链为主的多 vendor
> 适配策略、trust 三档审批与 .gitignore ack 状态机、devSkill↔skillRepos 触发-加载解耦、
> 供应链接写操作审批。

## Context

ADR-0016 已完成 spike 验证并定型了两个前提:

1. **扁平布局**:`<vendorSkillDir>/_c3_<id>/SKILL.md`(嵌套两层不被发现)。
2. **vendor 范围**:claude ✅、codex ✅(user 级已证,项目级假定)、opencode ❌(未实证 → 暂不建链)。

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

### D3 — trust 三档审批,状态持久化 state.json

| trust 档         | 审批触发条件                    | 取消后果                                          |
| ---------------- | ------------------------------- | ------------------------------------------------- |
| pinned           | 永不审批(cat-file 校验是唯一闸) | 强制 force-push 检测:clone 后 SHA 不可达→建链失败 |
| review-on-update | 首次 + 远程 ref 的 SHA 变化     | 挂载跳过(不启动 session)                          |
| unreviewed       | 每次 ensureLink                 | **抛 `SkillLoadCancelled` → session 不启动**      |

`.gitignore` 追加按**项目维度**一次性 ack,落 `state.json.skillAcks[projectDir].gitignore`。

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

### codex 项目级缺口

ADR-0016 spike B 只实证了 codex **user 级**(`~/.codex/skills/`) skill 发现。本批遵任务表将 codex 软链
落在**项目级** `<projectDir>/.codex/skills/_c3_<id>/`,以与 claude 的项目级一致。此行为未实证——
若 codex CLI 不扫描项目级目录,链会「死」:session 仍启动,仅该 skill 不可用(与 opencode 标灰等效)。
`detectSkillSupport` 以 CLI 在位作为支持存在标志,`codex` CLI 不存在时同样返回 `none`。

## Consequences

- 3/3 渲染的三个模态框(trust、.gitignore、orphan)由本 ADR 定 wire 协议。
- codex 项目级缺口暴露一个已知风险:需要一个由 codex 用户验证的补证 spike。
- 软链方案使 skill 升级成本低(`git fetch + reset --hard` 即可更新),且三 vendor 共享同一份克隆。

## Compliance

- `SkillLoader` 接口 + 三 vendor 实现落 `adapters/{claude,codex,opencode}/skill.ts`。
- `ensureLinksForLaunch`/`scanOrphans` 落 `kernel/skill-loader/`。
- trust/gitignore 审批状态机落 `kernel/skill-loader/approval.ts`。
- 写操作守卫落 `kernel/permission/gateway.ts`(`skillWriteGuard`)。
- 所有模块各有单测。

## References

- ADR-0016(扁平布局 + vendor 范围,本 ADR 的前提)。
- `changes/2026/06/07/2026-06-07-006-external-skill-git-loader/spec.md`(设计 spec)。
- `specs/architecture/claude-agent-sdk-guide.md` §5「它如何读取 Skill」(全局 glob 行为)。
