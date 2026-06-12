import { describe, expect, it } from 'vitest'
import { activeSessionTitleFromSessions } from './session-title-sync'
import type { SessionInfo } from '@ccc/shared/protocol'

const sessions: SessionInfo[] = [
  {
    sessionId: 's1',
    title: 'Renamed session',
    lastModified: 1,
    mode: 'default',
    isToolSession: false,
    vendor: 'claude',
  },
]

describe('activeSessionTitleFromSessions', () => {
  it('returns the refreshed title for the viewed session', () => {
    expect(
      activeSessionTitleFromSessions({
        activeWorkspace: '/repo',
        activeSession: 's1',
        workspacePath: '/repo',
        sessions,
      }),
    ).toBe('Renamed session')
  })

  it('ignores session lists for another workspace', () => {
    expect(
      activeSessionTitleFromSessions({
        activeWorkspace: '/repo',
        activeSession: 's1',
        workspacePath: '/other',
        sessions,
      }),
    ).toBeNull()
  })

  it('ignores lists that do not contain the viewed session', () => {
    expect(
      activeSessionTitleFromSessions({
        activeWorkspace: '/repo',
        activeSession: 'missing',
        workspacePath: '/repo',
        sessions,
      }),
    ).toBeNull()
  })
})
