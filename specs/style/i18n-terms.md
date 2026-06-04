# 术语表与禁译表(i18n 译法冻结)

> 适用范围:`web/` UI 文案的多语种翻译。本表是**译法冻结点** —— 同一术语在所有 locale
> 中必须用此处的固定译法,翻译评审(AI/人校)与 `i18n:check` 后置校验均以本表为准。
> 配套命名规范见 [`i18n-spec.md`](./i18n-spec.md);术语定义见 [`../glossary.md`](../glossary.md)。

## 1. 术语表(固定译法)

同一术语**只允许一种译法**,不得在不同 key 间漂移。`zh` 列为 M1 首发译法。

| 源词(en)     | zh         | 说明                                                             |
| ------------ | ---------- | ---------------------------------------------------------------- |
| Allow        | 允许       | 权限决策动作,与 Deny 成对                                        |
| Deny         | 拒绝       | 权限决策动作,与 Allow 成对                                       |
| Session      | 会话       | c3 会话域(见 glossary)                                           |
| Schedule     | 定时任务   | c3 定时任务域;动词义「排期/调度」按上下文,但域名固定「定时任务」 |
| Discussion   | 讨论       | c3 讨论域                                                        |
| Requirement  | 需求       | c3 需求域                                                        |
| Permission   | 权限       | 权限请求/决策                                                    |
| Settings     | 设置       | 系统设置                                                         |
| Agent        | 智能体     | 多 agent 共识场景;若指代代码标识则不译                           |
| Consensus    | 共识       | 多 agent 共识                                                    |
| Workspace    | 工作区     |                                                                  |
| Cancel       | 取消       |                                                                  |
| Save         | 保存       |                                                                  |
| Submit       | 提交       |                                                                  |
| Create       | 新建       |                                                                  |
| Completed    | 已完成     |                                                                  |
| Created      | 已创建     |                                                                  |
| Depends on   | 依赖       |                                                                  |
| Custom reply | 自定义回复 | 权限 AskUserQuestion 面板                                        |

## 2. 禁译表(保持原文,不翻译)

以下为产品名 / 协议名 / 技术专名 / 工具标识 —— **任何 locale 均保持英文原文**,
不音译、不意译。`no-raw-text` 豁免:这些词若以 `t()` value 形式存在,value 各语种相同。

| 原文                    | 类别     | 说明                                             |
| ----------------------- | -------- | ------------------------------------------------ |
| Claude Code             | 产品名   | Anthropic 产品名,整体不译                        |
| Claude                  | 产品名   |                                                  |
| c3 / Claude Code Center | 产品名   | 本应用名                                         |
| MCP                     | 协议名   | Model Context Protocol,缩写不译                  |
| Hook                    | 技术专名 | Claude Code 钩子机制,不译                        |
| AskUserQuestion         | 工具标识 | 工具名,与代码一致,不译                           |
| 工具名 / 标识符         | 代码标识 | `Write`/`Edit`/`Bash`/`mcp__c3__*` 等,随代码原样 |

## 3. 校验约定

- 翻译评审时逐条核对术语表;命中禁译表的词在 value 中保持原文。
- 插值占位符 `{name}`/`{count}` 与复数分支由 `i18n:check` 守护(见 i18n-spec §5.1),
  译文不得改写/增删占位符。
- 新增固定术语:**先在本表登记,再落译文**。
