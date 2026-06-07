# 外部 Skill Git 挂载 — Release 文档

> 对应 ADR-0016(扁平布局 + vendor 范围)与 ADR-0017(软链挂载 + 信任审批 + 写操作管控)。

## 概述

c3 支持从外部 Git 仓库加载 Skill 文件(SKILL.md),将其挂载到各 vendor 的技能发现目录,使之如同内置 skill 一样在 `/` 列表中可见。本文档涵盖配置时的四个关键要点。

## 1. Vendor 适用范围

`vendor` 字段决定该仓库的 skill 被挂载到哪个 vendor 的发现目录。支持以下值:

| Vendor          | 值         | 支持状态                                   |
| --------------- | ---------- | ------------------------------------------ |
| Claude Code     | `claude`   | ✅ 已验证(claude 发现 `skills/*/SKILL.md`) |
| Codex           | `codex`    | ✅ User 级已验证(项目级未实证,假定可用)    |
| OpenCode        | `opencode` | ❌ 未验证 — 暂不建链                       |
| 全部支持 vendor | `all`      | 挂载到所有已验证 vendor 的发现目录         |

**注意**:选择一个 `detectSkillSupport` 返回 `none` 的 vendor 时,技能链接不会被构建,但 session 正常启动。设置面板中这些 vendor 会标灰显示。

**配置建议**:除非有特殊理由需要限定到某个 vendor,否则使用 `all` 以最大化 skill 可用性。

## 2. Trust 三等级

`trust` 字段控制外部技能内容变更时的审批策略。

| 等级       | 值                 | 行为                                                                 | 适用场景     |
| ---------- | ------------------ | -------------------------------------------------------------------- | ------------ |
| 锁定       | `pinned`           | 永不弹出审批,`cat-file` 验证 pinCommit SHA 是否存在;ref 变化视为错误 | 安全敏感技能 |
| 更新后审查 | `review-on-update` | 首次加载 + 远程 ref 的 SHA 变化时弹出审批框;用户批准后方可挂载       | 半信任来源   |
| 不审查     | `unreviewed`       | 每次 session 启动前弹出审批确认;取消则 session 不启动                | 完全信任来源 |

当 `trust` 设为 `pinned` 时,必须填写 `pinCommit`(40 位十六进制 commit SHA),c3 在 clone 后验证该 SHA 可达,以防 force-push 攻击。

## 3. Ref 必填

`ref` 字段指定仓库的分支(branch)、标签(tag)或提交(commit),**必须填写**。c3 不会静默回退到远程的默认分支。

**提示**:粘贴 GitHub URL 到 repo 字段时,若 URL 包含 `/tree/<ref>/<subpath>` 段,ref 和 subpath 会自动解析回填。

## 4. `.gitignore` 追加行为

首次挂载外部 skill 时,c3 会向项目根目录的 `.gitignore` 追加一条 `_c3_*` 全局匹配规则,将外部挂载的软链排除在版本控制之外。

### 追加的条目

```
# c3 external skill mounts
_c3_*
```

### 追加时机

- **一次性确认**:首次需要追加时弹出审批框,用户确认后写入。
- **确认后持久化**:同一项目后续的 skill 挂载不再重复询问。
- **`.gitignore` 不存在**:c3 会原地创建 `.gitignore` 文件。

### 手动管理

如果希望手动管理 `.gitignore`,可以在审批框中取消。此时 c3 不会写入 `.gitignore`,但外部技能也无法挂载。后续可手动添加 `_c3_*` 到 `.gitignore` 并重试 session 启动。

## 5. 配置示例

以下是一个完整的 `settings.json` 片段:

```jsonc
{
  "skillRepos": [
    {
      "id": "my-team-skills", // 唯一标识符
      "repo": "https://github.com/org/team-skills",
      "ref": "main",
      "subpath": "skills", // 可选:技能子目录
      "vendor": "all", // 挂载到所有 vendor
      "trust": "review-on-update", // 更新后审查
    },
    {
      "id": "pinned-utils",
      "repo": "https://github.com/trusted/utils",
      "ref": "v2.1.0",
      "trust": "pinned",
      "pinCommit": "abcdef1234567890abcdef1234567890abcdef12",
    },
  ],
}
```

## 6. 相关规范

- ADR-0016:`specs/architecture/adr/0016-external-skill-git-mount.md` — 扁平布局 + vendor 范围
- ADR-0017:`specs/architecture/adr/0017-external-skill-mount-mechanism.md` — 软链挂载 + 信任审批
