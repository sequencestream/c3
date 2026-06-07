# ADR Conventions

Architecture Decision Records for c3.

## Numbering

- File pattern: `NNNN-title-with-dashes.md`, zero-padded and sequential (`0001`, `0002`…).
- Numbers are never reused.

## Lifecycle

- Status is one of: `proposed`, `accepted`, `deprecated`, `superseded`.
- ADRs are **never deleted**. A superseded ADR keeps its file, gains a header note linking
  to its replacement, and moves to `deprecated/`.
- `proposed` ADRs should resolve within a sprint.

## Required sections

Status · Date · Context · Options considered · Decision · Consequences · Compliance ·
References. See `../../.claude/skills/project-spec/references/adr.md` for the template.

## Index

| #                                                               | Title                                                                                                                                | Status     |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| [0001](deprecated/0001-c3-sole-permission-authority.md)         | c3 is the sole permission authority                                                                                                  | superseded |
| [0002](0002-websocket-as-permission-transport.md)               | WebSocket as the permission transport                                                                                                | accepted   |
| [0003](0003-single-binary-via-bun-compile.md)                   | Single binary via `bun build --compile`                                                                                              | accepted   |
| [0004](0004-persist-workspace-session-registry.md)              | c3 persists a workspace & session registry                                                                                           | accepted   |
| [0005](0005-inherit-user-project-settings.md)                   | Inherit user & project settings; c3 is the gateway                                                                                   | accepted   |
| [0006](0006-decouple-runs-from-connections.md)                  | Decouple agent runs from WebSocket connections                                                                                       | accepted   |
| [0007](0007-read-only-intent-agent.md)                          | Read-only intent agent; save via confirmation; cross-runtime SQLite                                                                  | accepted   |
| [0008](0008-streaming-input-for-agent-teams.md)                 | Streaming-input prompts for persistent agent teams                                                                                   | accepted   |
| [0009](0009-unidirectional-boundaries.md)                       | Unidirectional boundaries: kernel → transport/features, no back-edges                                                                | accepted   |
| [0010](0010-release-and-distribution-trust.md)                  | Release & distribution trust (orchestration skeleton)                                                                                | accepted   |
| [0011](0011-vendor-neutral-agent-abstraction.md)                | Vendor-neutral Agent abstraction: three-piece interface + capabilities (amended 2026-06-07 with structured session-lifecycle states) | accepted   |
| [0012](0012-host-binary-probe-first-capability-gate.md)         | Host-binary probing is the first capability gate                                                                                     | accepted   |
| [0013](0013-canonical-envelope-on-wire-c3-session-namespace.md) | Canonical envelope on the wire + c3 session namespace internalization                                                                | accepted   |
| [0014](0014-codex-in-process-responses-chat-relay.md)           | In-process Responses→Chat relay for codex Chat-Completions providers                                                                 | accepted   |
| [0015](0015-session-agent-binding-vendor-ownership.md)          | Two-key session→agent binding + frozen vendor ownership                                                                              | accepted   |
| [0016](0016-external-skill-git-mount.md)                        | 外部 skill 经 git 仓库挂载(扁平目录布局 + claude/codex vendor 范围)                                                                  | proposed   |
