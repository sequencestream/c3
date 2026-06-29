# session-registry — Domain Overview

| Field          | Value                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------- |
| Responsibility | Manage workspaces and unified vendor-session list projection; own per-session mode & access order |
| API            | WebSocket `/ws` (see shared protocol)                                                             |
| Status         | active                                                                                            |

The session-registry is the bookkeeping layer behind the sidebar. It registers project
directories as **workspaces**, lists each workspace's **sessions** from the rebuildable
`session_metadata` projection (with vendor stores as validation/rebuild sources), tracks which
session is **active**, and remembers each session's permission **mode** and each workspace's
recent-access order across restarts.

It does not run the agent (that is [agent-session](../agent-session/agent-session-overview.md))
and does not render the sidebar (that is [web-console](../web-console/web-console-overview.md)).

See [session-registry-spec.md](session-registry-spec.md), [session-registry-models.md](session-registry-models.md), [session-registry-design.md](session-registry-design.md).
