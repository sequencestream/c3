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

| #                                                  | Title                                      | Status   |
| -------------------------------------------------- | ------------------------------------------ | -------- |
| [0001](0001-c3-sole-permission-authority.md)       | c3 is the sole permission authority        | accepted |
| [0002](0002-websocket-as-permission-transport.md)  | WebSocket as the permission transport      | accepted |
| [0003](0003-single-binary-via-bun-compile.md)      | Single binary via `bun build --compile`    | accepted |
| [0004](0004-persist-workspace-session-registry.md) | c3 persists a workspace & session registry | accepted |
