# 0016 — 外部 skill 经 git 仓库挂载(目录布局 + vendor 范围)

- **Status:** proposed
- **Date:** 2026-06-07

> 本批(1/3 后端基座)仅落地数据/资料层 + 前置 spike 结论;软链挂载与 UI 在 2/3、3/3。
> 本 ADR 先固化两条 **spike 实证结论**,作为后续批次的设计前提。

> **2026-06-07 简化(本 ADR 同日收敛)**:`SkillRepoConfig` 收敛为仅 `id`/`repo`/`ref`/`subpath`。
> 移除 `vendor`(skill 跨 vendor 通用 → 固定挂入所有 build-link-capable vendor,即原 `vendor='all'` 行为)、
> 移除 `trust` 三档与 `pinCommit`(用户始终要 `ref` 最新版,pinned/review/unreviewed 审批徒增复杂度 → 改为
> **静默挂载**:直取 `ref` 最新版软链,挂载前无任何 trust 弹窗)。因此 `SkillTrust`/`SkillVendor` 类型删除、
> pinned `git cat-file` 防伪删除。仅保留 `.gitignore` 一次性追加确认(写用户文件)。详见下文标注。

## Context

c3 的后台 dev skill 现仅支持 `devSkill?: string`(斜杠命令前缀=触发器,见
`shared/protocol.ts` 的 `SystemSettings.devSkill`)。新增独立配置 `skillRepos: SkillRepoConfig[]`,
允许用户配置一个 git 仓库作为外部 skill 来源,由 c3 clone 并以**软链**挂载到
对应 vendor 的 skill 发现目录。挂载的前提是:c3 放进 vendor skill 目录的文件**确实会被该 vendor 发现**。

> **2026-06-12 生命周期更新**:挂载时机由「session 启动前自动挂载」改为「设置面板**显式安装** + **链接状态查询**」,
> 启动不再做任何 clone/建链(详见 ADR-0017 的 2026-06-12 块)。本 ADR 的扁平布局 `_c3_<id>/` 与缓存策略不变;
> 安装目标收敛为两个共享公共目录(`.claude/skills`、`.agents/skills`)。
> 再据此定型最终目录布局与 vendor 范围。

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

- **codex(在位,已实证机制存在)**:`codex-cli 0.137.0` 自带 skill 体系 —— `~/.codex/skills/` 下
  `.system/<name>/SKILL.md` 为内建 skill,frontmatter(`name`/`description`/`metadata`)与 Claude
  **兼容**,布局为**单层** `<name>/SKILL.md`。用户级 skill 直接落 `~/.codex/skills/<name>/SKILL.md`。
  → codex 是**可建链 vendor**,沿用扁平 `_c3_<id>/` 布局。
  _(待 2/3 确认:项目级 `.codex/skills/` 是否同样被扫;以及 c3 软链落 user 级还是 project 级。)_

## Decision

1. **目录布局**:扁平 `<vendorSkillsDir>/_c3_<id>/SKILL.md`(claude/codex 一致)。`_c3_` 前缀 + 配置 id 作目录名,便于按 id 反查/清理。
   ~~协议层 `SkillVendor` 取值~~ **已移除**:挂载固定挂入所有 build-link-capable vendor,不再有 per-repo vendor 选择。
   挂载阶段(2/3)只是软链到各 vendor 目录,不重复 clone。
2. ~~**pinned 防伪**~~ **已移除**(简化):不再有 `trust='pinned'`/`pinCommit`,统一静默挂载 `ref` 最新版;
   `pullRepo` 的 `fetch + reset --hard FETCH_HEAD` 始终取远端 head,不做 `git cat-file` 防伪校验。
3. **私有仓库鉴权**:MVP 不做,走宿主 SSH config / git credential helper。

## Consequences

- 后续批次的挂载点、清理逻辑、vendor 过滤都以本 ADR 的扁平布局 + claude/codex 范围为前提。
- 嵌套布局被实证排除,避免了 2/3 写完挂载后才发现 vendor 不扫的返工。

## Compliance

- 协议 `SkillRepoConfig`(`id`/`repo`/`ref`/`subpath?`)+ `WorkspaceSetting.skillRepos?` 落 `shared/protocol.ts`(`SkillTrust`/`SkillVendor` 已删)。
- `getSkillRepos(workspacePath)`(`server/src/kernel/config/index.ts`)从 `loadWorkspaceSetting` 读取并 fail-hard 校验(id/repo/ref);git 操作层落 `server/src/skill-repo.ts`。
- 单测覆盖:配置非法报错(id/repo/ref/dup/devSkill 冲突)+ GitHub URL 回填;git clone/pull/ls-remote/subpath + vendor 共用缓存。

## References

- ADR-0005(继承 user/project settings;c3 是网关)、ADR-0011(vendor 中性抽象)、ADR-0015(session→agent 绑定)。
- `specs/architecture/claude-agent-sdk-guide.md` §5「它如何读取 Skill」(`skills/*/SKILL.md` 单层 glob)。
- 变更会话:`changes/2026/06/07/2026-06-07-005-external-skill-git-backend/spec.md`。
