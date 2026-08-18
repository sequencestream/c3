import { describe, expect, it } from 'vitest'
import type { ClientToServer, ServerToClient } from '@ccc/shared/protocol'
import { dispatch } from './dispatch.js'
import { createHandlerRegistry, type Conn, type HandlerMap } from './handler-registry.js'
import type { KernelContext } from '../kernel/types.js'

/** A registry that records what reached a handler, for the one type under test. */
function registryFor(type: ClientToServer['type'], seen: ClientToServer[]) {
  const map = { [type]: (_ctx: KernelContext, _conn: Conn, msg: ClientToServer) => seen.push(msg) }
  return createHandlerRegistry(map as unknown as HandlerMap)
}

function conn(authed: boolean): { conn: Conn; sent: ServerToClient[] } {
  const sent: ServerToClient[] = []
  const stub = { authed, send: (m: ServerToClient) => void sent.push(m) }
  return { conn: stub as unknown as Conn, sent }
}

describe('dispatch auth gate', () => {
  it('refuses a runtime-log read on a connection that has not cleared the handshake', async () => {
    const seen: ClientToServer[] = []
    const { conn: c, sent } = conn(false)
    await dispatch(
      registryFor('read_runtime_log', seen),
      {} as KernelContext,
      c,
      JSON.stringify({ type: 'read_runtime_log' }),
    )
    expect(seen).toEqual([])
    expect(sent).toEqual([{ type: 'unauthenticated', reason: 'missing' }])
  })

  it('admits a runtime-log read from any authenticated connection (no admin role)', async () => {
    const seen: ClientToServer[] = []
    // `authed` is true for every signed-in connection, and unconditionally when
    // auth is disabled — so both postures reach the handler through this path.
    const { conn: c, sent } = conn(true)
    await dispatch(
      registryFor('read_runtime_log', seen),
      {} as KernelContext,
      c,
      JSON.stringify({ type: 'read_runtime_log', offset: 42 }),
    )
    expect(seen).toEqual([{ type: 'read_runtime_log', offset: 42 }])
    expect(sent).toEqual([])
  })
})
