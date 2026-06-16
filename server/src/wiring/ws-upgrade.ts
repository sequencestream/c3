/**
 * Wiring — WS upgrade factory (server refactor 3/3e-3).
 *
 * The `/ws` route upgrade closure that used to live in `server.ts`. It builds
 * the per-connection `Conn` (delivery + per-session view) and threads the
 * shared `broadcaster` + `handlerRegistry` + `ctx` through it. Behavior is
 * unchanged from the in-server.ts version — the only difference is the upgrade
 * is now a function the composition root calls.
 *
 * IMPORTANT (kernel boundary, ADR-0009 R1/R2/R6):
 * - This module lives in `wiring/`. It imports `transport/` (the single
 *   delivery egress + dispatch) but does NOT touch ws/HTTP semantics
 *   (the actual upgrade protocol is Hono's `upgradeWebSocket`).
 * - `assertNoTransportFields(ctx)` is the boot-time guard the assembler runs
 *   BEFORE calling this; the per-connection `Conn` is its own
 *   transport-scoped type and does not flow through the kernel.
 */
import type { Context, MiddlewareHandler } from 'hono'
import type { WSEvents } from 'hono/ws'
import type { ServerToClient } from '@ccc/shared/protocol'
import type WebSocket from 'ws'
import { dispatch, type Broadcaster, type Conn, type HandlerRegistry } from '../transport/index.js'
import type { KernelContext } from '../kernel/types.js'
import { getActiveSessionId, listWorkspaces, pathToId } from '../state.js'
import { listWorkspaceSessions } from '../sessions.js'
import { listSessionsVia } from '../kernel/agent/session/list-sessions.js'
import type { SessionAccessor } from '../kernel/agent/session/accessor.js'
import { listStatuses, removeViewer } from '../runs.js'
import { loadSettings } from '../kernel/config/index.js'
import { verifySession } from '../features/auth/session-store.js'
import { isAdminConn } from '../features/auth/authz.js'

/**
 * Rollback escape hatch for the cross-vendor `list_sessions` swap (ADR-0013).
 * Default ON: the wire lists via the {@link SessionAccessor} union. Set
 * `C3_SESSION_LIST_ACCESSOR=0` to fall back to the legacy claude-only
 * `listWorkspaceSessions` (the transition-period safety valve; the old path is
 * retired only after the transition).
 */
const USE_SESSION_ACCESSOR = process.env.C3_SESSION_LIST_ACCESSOR !== '0'

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// The Hono WS middleware type — the env generic defaults to `any` upstream, so
// we mirror that exact shape. The downstream `app.get('/ws', …)` infers from
// this; erasing the type to `unknown` makes Hono reject the call.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WsMiddleware = MiddlewareHandler<any, string, { outputFormat: 'ws' }>

/** A `createNodeWebSocket` `upgradeWebSocket` (typed to carry the Hono generics). */
type UpgradeWebSocketFn = (cb: (c: Context) => WSEvents<WebSocket>) => WsMiddleware

/**
 * Build the Hono WS upgrade handler. `upgradeWebSocket` is a Hono
 * `createNodeWebSocket` helper that maps to the underlying Node `ws` server;
 * we pass it the closure that produces per-connection lifecycle hooks.
 *
 * The closure holds a per-connection `sock` reference (set on `onOpen`,
 * cleared on `onClose`) and a `Conn` object the dispatcher uses to deliver
 * frames and to manage the per-session view (`conn.viewing`).
 */
export function createWsHandler(deps: {
  upgradeWebSocket: UpgradeWebSocketFn
  broadcaster: Broadcaster
  ctx: KernelContext
  handlerRegistry: HandlerRegistry
  /** Cross-vendor session listing union (ADR-0013); the new `list_sessions` core. */
  sessionAccessor: SessionAccessor
}): WsMiddleware {
  const { upgradeWebSocket, broadcaster, ctx, handlerRegistry, sessionAccessor } = deps
  const send = (ws: { send: (d: string) => void }, msg: ServerToClient): void =>
    ws.send(JSON.stringify(msg))

  return upgradeWebSocket((c) => {
    // This connection is a *view* onto sessions, not an owner of runs (ADR-0006).
    // Per-connection state (which session it watches + how to deliver) lives on
    // `conn`; shared run state lives in the module-level registry and `ctx`.
    let sock: { send: (d: string) => void } | null = null
    const conn: Conn = {
      send: (msg) => {
        if (sock) send(sock, msg)
      },
      // Default unauthenticated; `onOpen` resolves the handshake gate below.
      authed: false,
      authToken: null,
      subject: null,
      viewing: null,
      deliver: (msg) => {
        if (sock) send(sock, msg)
      },
      sendWorkspaces: () => {
        if (sock) send(sock, { type: 'workspaces', workspaces: listWorkspaces() })
      },
      sendSessions: async (workspacePath) => {
        if (!sock) return
        try {
          // New default: list across vendors via the accessor union (ADR-0013).
          // The env flag rolls back to the legacy claude-only path (the native id
          // stays on the wire either way — see list-sessions.ts).
          const sessions = USE_SESSION_ACCESSOR
            ? await listSessionsVia(sessionAccessor, workspacePath)
            : await listWorkspaceSessions(workspacePath)
          send(sock, { type: 'sessions', workspaceId: pathToId(workspacePath)!, sessions })
        } catch (err) {
          send(sock, {
            type: 'error',
            error: { code: 'session.listFailed', params: { detail: errMsg(err) } },
          })
        }
      },
    }

    return {
      onOpen(_evt, ws) {
        sock = ws
        // Handshake auth gate (ADR-0023). Auth disabled ⇒ admit unconditionally
        // (AUTH-R2: existing no-auth users are unaffected — the server never
        // emits `unauthenticated`). Auth enabled ⇒ verify the `?token=` handshake
        // param against the session store. On failure keep the socket OPEN but
        // unauthenticated and emit the 401-analogue WITHOUT leaking any snapshot:
        // no `ready`, no broadcaster subscription. The client shows the login gate;
        // a successful login mints a token and reconnects through this same gate.
        const auth = loadSettings().auth
        const authRequired = !!(auth && auth.enabled && auth.provider.kind === 'basic')
        if (authRequired) {
          const token = c.req.query('token') ?? null
          const result = verifySession(token)
          if (!result.ok) {
            conn.authed = false
            conn.authToken = null
            conn.subject = null
            send(ws, { type: 'unauthenticated', reason: result.reason })
            return
          }
          conn.authed = true
          conn.authToken = token
          // Bind the verified subject so the admin gate (ADR-0023 authz) can
          // authorize this connection's config mutations without re-reading the
          // session store on every frame.
          conn.subject = result.subject
        } else {
          conn.authed = true
        }
        broadcaster.add(conn.deliver)
        send(ws, {
          type: 'ready',
          workspaces: listWorkspaces(),
          activeSessionId: getActiveSessionId(),
          statuses: listStatuses(),
          // Whether this connection is the unique admin (UX hint only; the server
          // re-checks on every config mutation — the wire flag is never authority).
          isAdmin: isAdminConn(conn),
        })
      },
      // The 40+ case switch collapsed to a single registry dispatch (ADR-0009):
      // parse + validate + exhaustive lookup all live in `dispatch`.
      async onMessage(evt) {
        await dispatch(handlerRegistry, ctx, conn, String(evt.data))
      },
      onClose() {
        // Keep runs alive in the background; just stop delivering to this view.
        if (conn.viewing) removeViewer(conn.viewing, conn.deliver)
        broadcaster.remove(conn.deliver)
        sock = null
      },
    }
  })
}
