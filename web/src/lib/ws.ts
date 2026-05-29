import type { ClientToServer, ServerToClient } from '@ccc/shared/protocol'

export type WsListener = (msg: ServerToClient) => void

export function createWsClient(
  onMessage: WsListener,
  onStatus: (s: 'connecting' | 'open' | 'closed') => void,
) {
  const loc = window.location
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:'
  const url = `${proto}//${loc.host}/ws`
  let ws: WebSocket | null = null

  function connect() {
    onStatus('connecting')
    ws = new WebSocket(url)
    ws.onopen = () => onStatus('open')
    ws.onmessage = (evt) => {
      try {
        onMessage(JSON.parse(evt.data) as ServerToClient)
      } catch {
        /* ignore */
      }
    }
    ws.onclose = () => {
      onStatus('closed')
      ws = null
    }
    ws.onerror = () => onStatus('closed')
  }

  function send(msg: ClientToServer) {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg))
    } else {
      console.warn('[ws] not open, dropping', msg)
    }
  }

  connect()
  return { send }
}
