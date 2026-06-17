# codes — Overview

## Purpose

The codes domain lets the browser inspect files inside the current registered workspace so the user
can browse project code without leaving c3.

## Scope

- Read-only directory listing, text file reading, and code search for one registered workspace.
- Workspace-relative paths only.
- Security boundary enforcement for all filesystem access.

## Out of scope

- Editing, writing, deleting, moving, or creating files.
- Cross-workspace browsing.
- Git diff, blame, symbol navigation, language indexing, or semantic search.
- Hiding non-`.git` sensitive files such as `.env`; this accepted risk is recorded in
  [security](../../../non-functional/security.md).

## Documents

- [codes-spec.md](codes-spec.md) — domain behavior and invariants.
- [codes-design.md](codes-design.md) — implementation contract and API shape.
- [codes-models.md](codes-models.md) — workspace-relative code result shapes.
