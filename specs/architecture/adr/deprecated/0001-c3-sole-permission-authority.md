# 0001 — c3 is the sole permission authority

> **Superseded by [ADR 0005](../0005-inherit-user-project-settings.md)** (2026-05-29).
> c3 now inherits `['user', 'project']` settings and acts as the permission _gateway_
> rather than the _sole_ authority. Kept for historical record.

- **Status:** superseded
- **Date:** 2026-05-29

## Context

The Claude Agent SDK can inherit the user's `~/.claude/settings.json` — hooks, allow-rules,
and pre-approved tools. If c3 inherited those, some tool calls would be auto-approved by
settings the browser never sees, creating a hidden path around the decision boundary. c3's
entire purpose is to be the place where sensitive tool use is approved.

## Options considered

- **Inherit user settings, layer the UI on top.** Pros: respects existing user config,
  fewer surprises for power users. Cons: silently bypasses the browser; breaks the core
  guarantee that c3 sees every sensitive call. Violates the safety value.
- **Pass `settingSources: []` so the SDK ignores all external settings.** Pros: c3 is the
  single, predictable authority; every sensitive tool flows through `canUseTool`. Cons:
  user's existing allow-rules don't apply; they re-approve in the browser.

## Decision

Pass `settingSources: []` to `query()`. c3 is the sole permission authority for the
session. Every sensitive tool call flows through the `canUseTool` callback and out to the
browser.

## Consequences

- **Easier:** reasoning about safety — there is exactly one decision path.
- **Harder:** users who relied on `settings.json` allow-rules must answer in the browser
  (or switch permission mode). Acceptable, and aligned with the product intent.
- This is enshrined as constitution rule **C-SEC-1**; removing it is a security regression.

## Compliance

- `settingSources: []` is set in the Claude run path and asserted by review.
- Any change to that option requires amending the constitution.

## References

- [constitution](../../../constitution.md) § C-SEC-1
- [permission-gateway domain spec](../../../domains/core/permission-gateway/permission-gateway-spec.md)
