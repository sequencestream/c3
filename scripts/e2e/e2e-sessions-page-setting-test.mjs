#!/usr/bin/env node
/** End-to-end settings round-trip for the sessions-page navigation gate. */

const url = process.argv[2] ?? 'ws://localhost:13000/ws'
const ws = new WebSocket(url)
let original = null
let phase = 'initial'
let finished = false

const timeout = setTimeout(() => finish(false, 'TIMEOUT'), 15_000)

function send(message) {
  ws.send(JSON.stringify(message))
}

function finish(ok, detail) {
  if (finished) return
  finished = true
  clearTimeout(timeout)
  console.log(`sessions page setting: ${detail}`)
  console.log(ok ? 'RESULT: PASS' : 'RESULT: FAIL')
  ws.close()
  process.exitCode = ok ? 0 : 1
}

ws.addEventListener('open', () => send({ type: 'get_settings' }))
ws.addEventListener('error', (event) => finish(false, event.message ?? 'websocket error'))
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(String(event.data))
  if (msg.type === 'error') return finish(false, JSON.stringify(msg.error))
  if (msg.type !== 'settings') return

  if (phase === 'initial') {
    original = msg.settings
    phase = 'expect-false'
    send({ type: 'save_settings', settings: { ...original, showSessionsPage: false } })
    return
  }
  if (phase === 'expect-false') {
    if (msg.settings.showSessionsPage !== false) return finish(false, 'false did not persist')
    phase = 'expect-true'
    send({ type: 'save_settings', settings: { ...msg.settings, showSessionsPage: true } })
    return
  }
  if (phase === 'expect-true') {
    if (msg.settings.showSessionsPage !== true) return finish(false, 'true did not persist')
    phase = 'restore'
    send({ type: 'save_settings', settings: original })
    return
  }
  finish(true, 'false and true round-trips verified; original settings restored')
})
