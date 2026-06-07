# 0016 — 外部 skill 经 git 仓库挂载(目录布局 + vendor 范围)

- **Status:** proposed
- **Date:** 2026-06-07

> 本批(1/3 后端基座)仅落地数据/资料层 + 前置 spike 结论;软链挂载与 UI 在 2/3、3/3。
> 本 ADR 先固化两条 **spike 实证结论**,作为后续批次的设计前提。

## Context

c3 的后台 dev skill 现仅支持 `devSkill?: string`(斜杠命令前缀=触发器,见
`shared/protocol.ts` 的 `SystemSettings.devSkill`)。新增独立配置 `skillRepos: SkillRepoConfig[]`,
允许用户配置一个 git 仓库作为外部 skill 来源,由 c3 在 session 启动前 clone 并以**软链**挂载到
对应 vendor 的 skill 发现目录。挂载的前提是:c3 放进 vendor skill 目录的文件**确实会被该 vendor 发现**。
故本批必须先以 spike 验证两点 —— ① Claude SDK 的嵌套目录扫描行为;② codex/opencode 的 skill 发现机制 ——
再据此定型最终目录布局与 vendor 范围。

## Spike 实证结论

### Spike A — Claude SDK 嵌套 skill 扫描(已实证)

- **方法**:临时项目 `<cwd>/.claude/skills/` 下同时放「扁平」`_c3_flat/SKILL.md`(单层)与「嵌套」
  `_c3_session/abc123def/SKILL.md`(两层),用与 `server/src/commands.ts` 同一机制
  (streaming-input `query()` + `supportedCommands()`,`settingSources: ['project']`)实列。
- **结果**:`flat=true, nested=false` —— 仅扁平的 `skills/<name>/SKILL.md` 被发现为 skill;
  嵌套的 `skills/<name>/<id>/SKILL.md` **未被发现**。与 `claude-agent-sdk-guide.md` 记载的
  `skills/*/SKILL.md` **单层 glob** 一致。
- **决策**:挂载目录**降级为扁平** `<vendorSkillsDir>/_c3_<id>/SKILL.md`(一个 id 一个目录,直挂 SKILL.md),
  **放弃**嵌套的 `_c3_session/<id>/` 方案。

### Spike B — codex / opencode skill 发现机制(部分实证)

- **codex(在位,已实证机制存在)**:`codex-cli 0.137.0` 自带 skill 体系 —— `~/.codex/skills/` 下
  `.system/<name>/SKILL.md` 为内建 skill,frontmatter(`name`/`description`/`metadata`)与 Claude
  **兼容**,布局为**单层** `<name>/SKILL.md`。用户级 skill 直接落 `~/.codex/skills/<name>/SKILL.md`。
  → codex 是**可建链 vendor**,沿用扁平 `_c3_<id>/` 布局。
  _(待 2/3 确认:项目级 `.codex/skills/` 是否同样被扫;以及 c3 软链落 user 级还是 project 级。)_
- **opencode(本机未装,未实证)**:host CLI 不在 PATH,无法验证 `.agents/skills` 发现机制。
  → 按「任一不扫则该 vendor 不建链」的安全降级,**opencode 本批不纳入建链范围**,待有 opencode 宿主时补做 spike。

## Decision

1. **目录布局**:扁平 `<vendorSkillsDir>/_c3_<id>/SKILL.md`(claude/codex 一致)。`_c3_` 前缀 + 配置 id 作目录名,便于按 id 反查/清理。
2. **vendor 范围(本批基座 + 后续建链)**:`claude` 与 `codex` 为已验证可建链 vendor;`opencode` 暂缓(未实证)。
   协议层 `SkillVendor` 仍保留 `'opencode'`/`'all'` 取值(向前兼容,不删字面量),但建链逻辑(2/3、3/3)对 opencode 不落链直到补证。
3. **通用 clone 缓存**:`~/.c3/repo/<hash>` 一份,claude/codex/opencode 三 vendor 共用同一份 clone,切 vendor 零重复下载;
   挂载阶段(2/3)只是软链到各 vendor 目录,不重复 clone。
4. **pinned 防伪**:`trust='pinned'` 时 clone 后 `git cat-file -p <pinCommit>` 校验,防 force-push 伪造 SHA。
5. **私有仓库鉴权**:MVP 不做,走宿主 SSH config / git credential helper。

## Consequences

- 后续批次的挂载点、清理逻辑、vendor 过滤都以本 ADR 的扁平布局 + claude/codex 范围为前提。
- opencode 留下明确的补证缺口(spike B 续作),协议字面量已为其预留,无需改类型即可启用。
- 嵌套布局被实证排除,避免了 2/3 写完挂载后才发现 vendor 不扫的返工。

## Compliance

- 协议三类型 `SkillTrust`/`SkillVendor`/`SkillRepoConfig` + `ProjectConfig.skillRepos?` 落 `shared/protocol.ts`。
- `getSkillRepos(projectPath)`(`server/src/kernel/config/index.ts`)从 `loadProjectConfig` 读取并 fail-hard 校验;git 操作层落 `server/src/skill-repo.ts`。
- 单测覆盖:配置四类非法报错 + GitHub URL 回填;git clone/pull/ls-remote/subpath/cat-file + 三 vendor 共用缓存。

## References

- ADR-0005(继承 user/project settings;c3 是网关)、ADR-0011(vendor 中性抽象)、ADR-0015(session→agent 绑定)。
- `specs/architecture/claude-agent-sdk-guide.md` §5「它如何读取 Skill」(`skills/*/SKILL.md` 单层 glob)。
- 变更会话:`changes/2026/06/07/2026-06-07-005-external-skill-git-backend/spec.md`。
