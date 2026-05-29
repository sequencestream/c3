# Glossary

Business and technical terms used across c3 specs. Defined once here; domain docs
reference these rather than redefining them.

| Term                    | Definition                                                                                                                                                                             |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **c3**                  | Claude Code Center. The application: a local web UI that gates Claude Code's tool use through a browser.                                                                               |
| **Agent run**           | A single `query()` invocation driven by one user prompt. Streams assistant text, tool activity, and permission requests until it completes or errors.                                  |
| **Permission request**  | A server→client event asking the user to authorize a specific tool call (tool name + input). Emitted from the SDK `canUseTool` callback. Identified by a `requestId`.                  |
| **Permission decision** | The user's answer to a permission request: `allow` or `deny`.                                                                                                                          |
| **Permission mode**     | The policy the SDK uses to decide which tools need a request. One of `default`, `auto`, `plan`, `acceptEdits`, `bypassPermissions`. Persists for the life of a connection.             |
| **canUseTool**          | The SDK callback c3 supplies. Invoked for sensitive tool calls; c3 routes the question to the browser and returns the resolved decision.                                               |
| **Sensitive tool**      | A tool the SDK classifies as needing approval under the active mode (e.g. `Write`, `Edit`, dangerous `Bash`). Read-only tools are auto-allowed by the SDK and never produce a request. |
| **Auto-deny**           | The outcome when a permission request receives no decision within the timeout window (60 seconds).                                                                                     |
| **Wire protocol**       | The JSON message contract over the `/ws` WebSocket. Two discriminated unions: `ClientToServer` and `ServerToClient`, defined in `shared/src/protocol.ts`.                              |
| **Project directory**   | The absolute path passed as `--project`, used as the SDK `cwd`. Claude reads and writes files relative to it. One per server process.                                                  |
| **Session**             | The lifetime of one WebSocket connection. Permission mode and the in-flight run handle are scoped to it. There is no cross-session persistence.                                        |
| **Run handle**          | Live controls for an in-flight run handed to the WS handler (`setPermissionMode`), letting a mode change apply mid-run.                                                                |
| **Interrupt / abort**   | Stopping the in-flight run. Triggered by a new user prompt or by the connection closing; calls the SDK `query.interrupt()`.                                                            |
| **Static embed**        | The web bundle inlined into the compiled binary (`server/src/static-embed.ts`, generated and gitignored). Served when no filesystem `web/dist` is present.                             |
| **claude CLI**          | The host-installed `claude` executable the SDK spawns to run the agent. Resolved from `$CLAUDE_PATH` or the PATH. A hard runtime dependency.                                           |
| **session_end**         | The terminal server→client event for an agent run, with `reason` `complete` or `error`.                                                                                                |
