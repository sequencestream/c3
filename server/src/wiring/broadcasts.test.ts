/**
 * `broadcastSessions` must never put a malformed frame on the wire.
 *
 * A run can execute in a directory that is not a registered workspace — an IM
 * chat robot runs in its own directory, which is deliberately never registered
 * (ADR-0046) — and `run:settled` fans out to this broadcast unconditionally,
 * before any session-kind check. Resolving such a path to a wire-level
 * workspace name yields null, so the guard has to stop the broadcast rather
 * than assert the name is present.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createBroadcasts } from './broadcasts.js'
import { pathToName } from '../state.js'
import { listSessionsVia } from '../kernel/agent/session/list-sessions.js'
import type { SessionAccessor } from '../kernel/agent/session/accessor.js'
import type { Broadcaster } from '../transport/index.js'

// Only `pathToName` is faked; the rest of the workspace registry stays real
// because sibling stores bind other exports (e.g. `workspaceNameFor`) at import.
vi.mock('../state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../state.js')>()),
  pathToName: vi.fn(),
}))
vi.mock('../kernel/agent/session/list-sessions.js', () => ({
  listSessionsVia: vi.fn(() => Promise.resolve([])),
}))

function harness() {
  const toAll = vi.fn()
  const broadcaster = { toAll } as unknown as Broadcaster
  const sessionAccessor = {} as SessionAccessor
  return { toAll, broadcasts: createBroadcasts({ broadcaster, sessionAccessor }) }
}

beforeEach(() => vi.clearAllMocks())

describe('broadcastSessions — unregistered workspace path', () => {
  it('broadcasts nothing when the path is not a registered workspace', async () => {
    vi.mocked(pathToName).mockReturnValue(null)
    const { toAll, broadcasts } = harness()

    broadcasts.broadcastSessions('/home/u/.c3/robots/helper')
    await Promise.resolve()
    await Promise.resolve()

    expect(toAll).not.toHaveBeenCalled()
  })

  it('does not even read the session projection for such a path', async () => {
    // The guard returns before the async read: an unregistered directory has no
    // session list anyone is subscribed to, so paying for the read is waste.
    vi.mocked(pathToName).mockReturnValue(null)
    const { broadcasts } = harness()

    broadcasts.broadcastSessions('/home/u/.c3/robots/helper')
    await Promise.resolve()

    expect(listSessionsVia).not.toHaveBeenCalled()
  })

  it('still broadcasts under the resolved name for a registered workspace', async () => {
    vi.mocked(pathToName).mockReturnValue('my-project')
    const { toAll, broadcasts } = harness()

    broadcasts.broadcastSessions('/src/my-project')
    await Promise.resolve()
    await Promise.resolve()

    expect(toAll).toHaveBeenCalledTimes(1)
    expect(toAll).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'sessions', workspaceName: 'my-project' }),
    )
  })
})
