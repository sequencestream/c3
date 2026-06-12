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
| [0016](0016-external-skill-git-mount.md)                        | 外部 skill 经 git 仓库挂载(扁平目录布局;2026-06-12 改显式安装 + 两公共目录)                                                          | proposed   |
| [0017](0017-external-skill-mount-mechanism.md)                  | 外部 skill 加载机制:软链 + 写操作管控;2026-06-12 启动挂载→显式安装(`install_skill`)+ 状态查询(`get_skill_link_status`)               | proposed   |
| [0018](0018-event-bus-kernel-layer.md)                          | In-process event bus in the kernel layer (typed publish/subscribe, error isolation)                                                  | accepted   |
| [0020](0020-sandbox-driver-independent-kernel-module.md)        | SandboxDriver 作为独立 kernel 模块                                                                                                   | accepted   |
| [0021](0021-system-project-two-tier-sandbox-config.md)          | 系统定义 + 项目选择双层配置                                                                                                          | accepted   |
| [0022](0022-canonical-not-extended.md)                          | CanonicalMessage 不扩展（沙箱/Checkpoint 通过事件总线）                                                                              | accepted   |
| [0023](0023-auth-abstraction-network-exposure.md)               | 认证抽象边界：网络暴露的强制前提（basic 为首个 provider）                                                                            | proposed   |
