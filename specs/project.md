# Project — c3 (Claude Code Center)

## Vision

Give Claude Code a **browser-based permission console**. Every time the agent wants to
run a sensitive tool (write a file, edit code, run a dangerous shell command), a human
approves or denies it in a browser tab instead of the terminal — with a readable view of
exactly which tool and which inputs are about to run.

## Problem

Claude Code's permission prompts live in the terminal where the agent runs. That couples
the approval surface to the terminal session: it is hard to read structured tool inputs,
hard to expose to a non-terminal workflow, and hard to centralize. c3 decouples the
**decision surface** (browser) from the **execution surface** (local agent process).

## Scope

**In scope**

- A local server that drives the Claude Agent SDK `query()` loop against one project
  directory.
- Interception of every SDK permission request and routing it to a browser over WebSocket.
- A browser console: send prompts, stream assistant text and tool activity, answer
  Allow/Deny, and switch permission mode.
- Packaging as a single self-contained binary.

**Out of scope (non-goals)**

- Not a hosted/multi-tenant service. c3 binds to localhost and serves a single local user.
- Not an authentication or authorization system — it assumes the local OS user is trusted.
- Not a replacement for the `claude` CLI. The CLI is a **hard runtime dependency**: it
  must be installed and logged in (`claude /login`) on the host.
- Not a multi-project workspace. One server process serves one `--project` directory.
- Not a persistent store. There is no database, no history persistence across restarts.

## Stakeholders

| Role                           | Interest                                                           |
| ------------------------------ | ------------------------------------------------------------------ |
| Local developer (primary user) | Runs c3 against a project, approves tool use from the browser      |
| Maintainer                     | Owns the server, protocol, and frontend                            |
| Agent SDKs                     | Three upstream dependencies, each with distinct SDK architecture:  |
|                                | • `@anthropic-ai/claude-agent-sdk` — subprocess JSON stdio wrapper |
|                                | • `@openai/codex-sdk` — subprocess HTTP/SSE + Responses→Chat relay |
|                                | • `@opencode-ai/sdk` — remote REST + SSE service client            |
| Host CLIs                      | `claude`, `codex`, `opencode` — must each be installed on the host |

## Success criteria

- A user can open the browser console, send a prompt, and have the agent run to
  completion with every sensitive tool gated through the browser.
- No tool that the SDK classifies as sensitive ever executes without an explicit browser
  decision (or an explicit mode that authorizes auto-execution).
- The single binary runs on a host that has only `bun` and `claude` installed.

## Current state

Version `0.1.0`. Single developer. Workspaces: `server`, `web`, `shared`. Built and
shipped as a Bun-compiled single binary plus a Node CJS bundle.
