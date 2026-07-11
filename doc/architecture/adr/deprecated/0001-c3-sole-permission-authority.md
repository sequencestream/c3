# 0001 — c3 是唯一权限权威

> **已被 [ADR 0005](../0005-inherit-user-project-settings.md) 取代**(2026-05-29)。
> c3 现在继承 `['user', 'project']` 设置，扮演权限*网关*而非*唯一*权威的角色。保留本
> 文作为历史记录。

- **Status:** superseded
- **Date:** 2026-05-29

## Context

Claude Agent SDK 可以继承用户的 `~/.claude/settings.json`——hook、允许规则与预批准的工
具。如果 c3 继承了这些，一些工具调用会被浏览器从未看到的设置自动批准，从而在决策边界周
围产生一条隐藏路径。c3 的全部意义正在于成为敏感工具使用被批准的场所。

## Options considered

- **继承用户设置，在其上叠加 UI。** 优点：尊重已有用户配置，对重度用户而言意外更少。
  缺点：静默绕过浏览器；破坏了 c3 能看到每一次敏感调用的核心保证。违背了安全性价值观。
- **传入 `settingSources: []`，让 SDK 忽略所有外部设置。** 优点：c3 是单一、可预测的权
  威；每个敏感工具都流经 `canUseTool`。缺点：用户已有的允许规则不生效；他们需要在浏览
  器中重新批准。

## Decision

向 `query()` 传入 `settingSources: []`。c3 是该会话唯一的权限权威。每个敏感工具调用都
流经 `canUseTool` 回调并送达浏览器。

## Consequences

- **Easier:** 安全性的推理——恰好只有一条决策路径。
- **Harder:** 依赖 `settings.json` 允许规则的用户必须在浏览器中作答(或切换权限模式)。
  可接受，且与产品意图一致。
- 这被写入 constitution 规则 **C-SEC-1**；移除它是一次安全性回退。

## Compliance

- `settingSources: []` 在 Claude 运行路径中被设置，并由评审断言。
- 对该选项的任何改动都需要修订 constitution。

## References

- [constitution](../../../constitution.md) § C-SEC-1
- [permission-gateway domain spec](../../../domains/core/permission-gateway/permission-gateway-spec.md)
