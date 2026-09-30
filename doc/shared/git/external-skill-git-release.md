# 外部 Skill Git 挂载

工作区把外部 git 仓库当作 Skill 来源。每条配置是 **id**、**仓库地址**、**ref** 与可选 **子路径**。安装把软链挂入 `.claude/skills` 与 `.agents/skills`，不按仓库选择厂商。决策见 [ADR-0016](../../architecture/adr/0016-external-skill-git-mount.md)、[ADR-0017](../../architecture/adr/0017-external-skill-mount-mechanism.md)。

## 配置

- **ref 必填**（分支、标签或提交）。不会静默落到远程默认分支。
- 仓库地址若是含 `/tree/<ref>/<subpath>` 的 GitHub URL，会回填 ref 与子路径。
- 安装始终取该 ref 当前最新 head。

## 安装与状态

会话启动不 clone、不建链。对某条配置 **安装**；**状态** 只读查看上述两目录里该 id 的链是否存在。未安装则会话用不上该 skill。

安装布局为扁平 `_c3_<id>/SKILL.md`。必须扁平：厂商不扫嵌套 skill（[Claude · 设置继承](../../architecture/claude-agent-sdk-guide.md#设置继承)、[Codex · 它如何读取 Skill](../../architecture/codex-sdk-guide.md#它如何读取 Skill)）。

## `.gitignore`

首次需要写入时按项目一次性确认，向项目 `.gitignore` 追加 `_c3_*`，把挂载链排除出版本控制；确认后该项目不再询问。取消则不写、该条不安装。
