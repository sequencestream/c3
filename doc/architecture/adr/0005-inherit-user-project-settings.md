# 0005 — 继承用户与项目设置；c3 作为权限网关

- **Status:** accepted
- **Date:** 2026-05-29
- **Supersedes:** [0001](deprecated/0001-c3-sole-permission-authority.md)

## Context

[ADR 0001](deprecated/0001-c3-sole-permission-authority.md) 传入 `settingSources: []`，
让 SDK 忽略所有外部设置，使 c3 成为**唯一**权限权威。实践中这会丢弃用户已明确设置的配
置：项目级与用户级 hook、允许/拒绝规则、Skills、以及 `CLAUDE.md` 指令。在 c3 中运行的项
目因此会与同一项目通过 `claude` CLI 运行时表现不同，重度用户还必须在浏览器中重新批准他
们在 `~/.claude/settings.json` 中已经信任过的一切。

我们希望 c3 尊重用户已有的用户/项目配置，同时仍为任何尚未决定的事项提供浏览器批准 UI。

## Options considered

- **保持 `settingSources: []`(ADR 0001)。** 优点：恰好一条决策路径；安全性易于推理。
  缺点：忽略用户真实的配置；与 CLI 行为不一致；没有 Skills，没有项目 `CLAUDE.md`；一切
  都要重新批准。
- **继承 `['user', 'project']`；在其上叠加浏览器 UI。** 优点：尊重已有的 hook、允许/拒绝
  规则、Skills 与 `CLAUDE.md`；与 CLI 行为一致；`canUseTool` 仍会为一切尚未预先决定的事
  项把关。缺点：被继承的允许规则匹配到的工具会被**自动批准**、且**不会**出现在浏览器
  中——c3 不再是*唯一*权威。
- **仅继承 `['project']`。** 优点：范围更小；项目规则随 git 一起流转。缺点：仍会绕开浏
  览器执行项目级允许规则；忽略用户预期在任何地方都生效的用户级配置。

## Decision

向 `query()` 传入 `settingSources: ['user', 'project']`。c3 是权限**网关**，而非唯一权
威：SDK 先应用继承的拒绝 → 询问 → 允许规则与当前活动的权限模式；任何未被这些流程预先决
定的工具都会流经 `canUseTool` 并送达浏览器。被继承的允许规则可能自动批准浏览器从未看到的
工具——这是被接受且有意为之的，与 `claude` CLI 的行为一致。

## Consequences

- **Easier:** 与 CLI 对齐；Skills 与项目 `CLAUDE.md` 会被发现；用户保留他们信任的允许规
  则与 hook。
- **Harder:** 安全性叙事不再是“单一路径”——一条继承的允许规则可以在没有浏览器确认的情
  况下执行敏感工具。要推理什么会送达浏览器，现在需要了解继承的设置。
- Constitution **C-SEC-1** 从“唯一权威”修订为“网关”；**SEC-3** 及相关反例场景相应修
  订。

## Compliance

- `settingSources: ['user', 'project']` 是传给 SDK 的配置值。
- 未来对该选项的任何改动都需要一份新的 ADR 与一次 constitution 修订。

## References

- `doc/constitution.md` § C-SEC-1
- `doc/non-functional/security.md` § SEC-3
- `doc/domains/core/permission-gateway/permission-gateway-spec.md`
- Superseded: [ADR 0001](deprecated/0001-c3-sole-permission-authority.md)
