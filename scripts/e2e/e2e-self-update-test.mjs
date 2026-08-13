#!/usr/bin/env node
/**
 * End-to-end contract for the console self-update surface.
 *
 * The e2e server runs from source under an interpreter, which is exactly the
 * runtime form self-update must REFUSE (there is no single binary to swap). So
 * this test asserts the refusal is real and complete:
 *
 *   - the `ready` handshake carries a `selfUpdate` snapshot at all;
 *   - it reports `capable:false` with the `dev-runtime` reason;
 *   - `start_self_update` and `apply_self_update` are accepted on the wire but
 *     change nothing — no download starts, no restart happens, the connection
 *     stays up and the phase stays `idle`.
 *
 * The happy path (a real download + binary swap + relaunch) cannot run here: it
 * needs a published release and a compiled binary. It is covered by unit tests
 * over the state machine and by the manual release smoke.
 */
const url = process.argv[2] ?? 'ws://localhost:13000/ws'

const ws = new WebSocket(url)
let ready = null
let finished = false

const timeout = setTimeout(() => finish(false, 'TIMEOUT'), 15_000)

function send(message) {
  ws.send(JSON.stringify(message))
}

function finish(ok, detail) {
  if (finished) return
  finished = true
  clearTimeout(timeout)
  console.log(`self-update: ${detail}`)
  console.log(ok ? 'RESULT: PASS' : 'RESULT: FAIL')
  ws.close()
  process.exitCode = ok ? 0 : 1
}

ws.addEventListener('error', (event) => finish(false, event.message ?? 'websocket error'))

ws.addEventListener('close', () => {
  // A restart would drop this connection. Under a dev runtime it must not.
  if (!finished) finish(false, 'the server dropped the connection — apply must be refused here')
})

ws.addEventListener('message', (event) => {
  const msg = JSON.parse(String(event.data))

  if (msg.type === 'ready') {
    ready = msg
    if (!ready.selfUpdate) return finish(false, 'ready frame carries no selfUpdate snapshot')
    const s = ready.selfUpdate
    if (s.capable !== false) return finish(false, `expected capable:false, got ${s.capable}`)
    if (s.incapableReason !== 'dev-runtime') {
      return finish(false, `expected incapableReason:dev-runtime, got ${s.incapableReason}`)
    }
    if (s.phase !== 'idle') return finish(false, `expected phase:idle, got ${s.phase}`)

    // Both mutating actions, back to back. Neither may do anything.
    send({ type: 'start_self_update' })
    send({ type: 'apply_self_update' })
    // Give the server a beat to (not) act, then re-read the snapshot from a
    // fresh handshake-independent source: any pushed state change would arrive
    // before this fires.
    setTimeout(() => send({ type: 'ping' }), 1500)
    return
  }

  if (msg.type === 'self_update_state') {
    const s = msg.selfUpdate
    if (s.phase !== 'idle' || s.capable !== false) {
      finish(false, `self-update moved on a dev runtime: ${JSON.stringify(s)}`)
    }
    return
  }

  if (msg.type === 'pong') {
    finish(true, 'dev runtime reports capable:false/dev-runtime; start+apply were no-ops')
  }
})
