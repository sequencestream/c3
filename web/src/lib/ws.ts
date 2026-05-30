import type { ClientToServer, ServerToClient } from '@ccc/shared/protocol'

export type WsListener = (msg: ServerToClient) => void
export type WsStatus = 'connecting' | 'open' | 'closed'

// Heartbeat keeps idle proxies/load-balancers from silently dropping the socket
// and lets us detect a half-open connection the browser hasn't noticed yet.
const HEARTBEAT_MS = 25_000
// If a `pong` doesn't come back within this window, treat the socket as dead.
const PONG_TIMEOUT_MS = 10_000
// Reconnect backoff: starts small, doubles, caps — with jitter to avoid a
// thundering herd when the server restarts and every tab reconnects at once.
const RECONNECT_MIN_MS = 1_000
const RECONNECT_MAX_MS = 30_000

export interface WsClientOptions {
  onMessage: WsListener
  onStatus: (s: WsStatus) => void
  // Fired after a *reconnect* succeeds (not the first connect), so callers can
  // resync server-side per-connection view state (e.g. re-select the session).
  onReopen?: () => void
}

export function createWsClient(opts: WsClientOptions) {
  const { onMessage, onStatus, onReopen } = opts
  const loc = window.location
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:'
  const url = `${proto}//${loc.host}/ws`

  let ws: WebSocket | null = null
  let stopped = false
  let connectedOnce = false
  let backoff = RECONNECT_MIN_MS
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  let pongTimer: ReturnType<typeof setTimeout> | null = null

  function clearTimers() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
    if (pongTimer) {
      clearTimeout(pongTimer)
      pongTimer = null
    }
  }

  function startHeartbeat() {
    clearTimers()
    heartbeatTimer = setInterval(() => {
      if (ws?.readyState !== WebSocket.OPEN) return
      ws.send(JSON.stringify({ type: 'ping' } satisfies ClientToServer))
      // Expect a pong promptly; otherwise the link is half-open — force a close
      // so `onclose` schedules a reconnect.
      if (pongTimer) clearTimeout(pongTimer)
      pongTimer = setTimeout(() => {
        pongTimer = null
        ws?.close()
      }, PONG_TIMEOUT_MS)
    }, HEARTBEAT_MS)
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return
    const jitter = backoff * 0.25 * (0.5 - deterministicJitter())
    const delay = Math.min(backoff, RECONNECT_MAX_MS) + jitter
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      backoff = Math.min(backoff * 2, RECONNECT_MAX_MS)
      connect()
    }, delay)
  }

  // Avoid Math.random (kept deterministic-friendly); a coarse time-based jitter
  // is enough to spread reconnect storms across tabs.
  function deterministicJitter(): number {
    return (Date.now() % 1000) / 1000
  }

  function connect() {
    if (stopped) return
    onStatus('connecting')
    ws = new WebSocket(url)

    ws.onopen = () => {
      backoff = RECONNECT_MIN_MS
      onStatus('open')
      startHeartbeat()
      if (connectedOnce) onReopen?.()
      connectedOnce = true
    }

    ws.onmessage = (evt) => {
      let msg: ServerToClient
      try {
        msg = JSON.parse(evt.data) as ServerToClient
      } catch {
        return
      }
      // Swallow heartbeat replies here; they're a transport concern, not app data.
      if (msg.type === 'pong') {
        if (pongTimer) {
          clearTimeout(pongTimer)
          pongTimer = null
        }
        return
      }
      onMessage(msg)
    }

    ws.onclose = () => {
      clearTimers()
      ws = null
      if (stopped) return
      onStatus('closed')
      scheduleReconnect()
    }

    // `onerror` is followed by `onclose`; let close drive the reconnect to avoid
    // scheduling twice.
    ws.onerror = () => onStatus('closed')
  }

  function send(msg: ClientToServer) {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg))
    } else {
      console.warn('[ws] not open, dropping', msg)
    }
  }

  function close() {
    stopped = true
    clearTimers()
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    ws?.close()
    ws = null
  }

  connect()
  return { send, close }
}
