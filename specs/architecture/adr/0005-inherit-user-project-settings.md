# 0005 — Inherit user & project settings; c3 is the permission gateway

- **Status:** accepted
- **Date:** 2026-05-29
- **Supersedes:** [0001](deprecated/0001-c3-sole-permission-authority.md)

## Context

[ADR 0001](deprecated/0001-c3-sole-permission-authority.md) passed `settingSources: []`
so the SDK ignored all external settings, making c3 the **sole** permission authority. In
practice that discards configuration the user has deliberately set: project- and user-level
hooks, allow/deny rules, Skills, and `CLAUDE.md` instructions. A run inside c3 then behaves
differently from the same project run through the `claude` CLI, and power users must
re-approve in the browser everything they already trusted in `~/.claude/settings.json`.

We want c3 to honor the user's existing user/project configuration while still presenting a
browser approval UI for anything not already decided.

## Options considered

- **Keep `settingSources: []` (ADR 0001).** Pros: exactly one decision path; trivial to
  reason about safety. Cons: ignores the user's real configuration; diverges from CLI
  behavior; no Skills, no project `CLAUDE.md`; re-approve everything.
- **Inherit `['user', 'project']`; layer the browser UI on top.** Pros: respects existing
  hooks, allow/deny rules, Skills, and `CLAUDE.md`; matches CLI behavior; `canUseTool`
  still gates everything not pre-decided. Cons: a tool matched by an inherited allow-rule is
  auto-approved **without** appearing in the browser — c3 is no longer the _sole_ authority.
- **Inherit `['project']` only.** Pros: smaller surface; project rules travel with git.
  Cons: still bypasses the browser for project allow-rules; ignores user-level config the
  user expects everywhere.

## Decision

Pass `settingSources: ['user', 'project']` to `query()`. c3 is the permission **gateway**,
not the sole authority: the SDK applies inherited deny → ask → allow rules and the active
permission mode first; any tool **not** pre-decided by those flows through `canUseTool` and
out to the browser. Inherited allow-rules may auto-approve tools the browser never sees —
this is accepted and intended, mirroring the `claude` CLI.

## Consequences

- **Easier:** parity with the CLI; Skills and project `CLAUDE.md` are discovered; users keep
  their trusted allow-rules and hooks.
- **Harder:** the safety story is no longer "one path" — an inherited allow-rule can execute
  a sensitive tool without browser confirmation. Reasoning about what reaches the browser now
  requires knowing the inherited settings.
- Constitution **C-SEC-1** is amended from "sole authority" to "gateway"; **SEC-3** and the
  related anti-scenario are revised accordingly.

## Compliance

- `settingSources: ['user', 'project']` is the configured value passed to the SDK.
- Any future change to that option requires a new ADR and a constitution amendment.

## References

- `specs/constitution.md` § C-SEC-1
- `specs/non-functional/security.md` § SEC-3
- `specs/domains/core/permission-gateway/permission-gateway-spec.md`
- Superseded: [ADR 0001](deprecated/0001-c3-sole-permission-authority.md)
