import { afterEach, describe, expect, it } from 'vitest'
import { activityRegistry, resetActivityRegistryForTests } from './index.js'
import {
  bindPending,
  ensureRuntime,
  removeRuntime,
  removeRuntimesForWorkspace,
  setStatus,
} from '../../runs.js'

afterEach(() => {
  removeRuntime('pending:s')
  removeRuntime('real-s')
  removeRuntime('s-status')
  removeRuntimesForWorkspace('/ws')
  resetActivityRegistryForTests()
})

describe('Session Runtime writes the activity registry', () => {
  it('starts on running, transitions on permission wait, and settles on idle', () => {
    ensureRuntime('s-status', '/ws', 'default', [], 'work')
    setStatus('s-status', 'running')
    expect(activityRegistry.getBySessionId('s-status')?.state).toBe('running')
    setStatus('s-status', 'awaiting_permission')
    expect(activityRegistry.getBySessionId('s-status')?.state).toBe('awaiting_user')
    setStatus('s-status', 'idle')
    expect(activityRegistry.getBySessionId('s-status')).toBeUndefined()
  })

  it('binds pending to the real id without a second member', () => {
    const rt = ensureRuntime('pending:s', '/ws', 'default', [], 'work')
    setStatus('pending:s', 'running')
    bindPending('pending:s', 'real-s')
    expect(rt.sessionId).toBe('real-s')
    expect(activityRegistry.snapshotRunning()).toHaveLength(1)
    expect(activityRegistry.getBySessionId('real-s')?.sessionId).toBe('real-s')
    expect(activityRegistry.getBySessionId('pending:s')?.sessionId).toBe('real-s')
  })

  it('removeRuntime and workspace teardown drop the fact', () => {
    ensureRuntime('s-status', '/ws', 'default', [], 'work')
    setStatus('s-status', 'running')
    removeRuntime('s-status')
    expect(activityRegistry.snapshot()).toHaveLength(0)

    ensureRuntime('pending:s', '/ws', 'default', [], 'work')
    setStatus('pending:s', 'running')
    removeRuntimesForWorkspace('/ws')
    expect(activityRegistry.snapshot()).toHaveLength(0)
  })
})
