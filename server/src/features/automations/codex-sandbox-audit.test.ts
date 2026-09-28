/**
 * The Codex full-access stock audit (2026-09-28). Detection is pure over rows so
 * the three cases that matter can be pinned without a database: promoted,
 * authorized, and the legacy-string exemption.
 */
import { describe, it, expect } from 'vitest'
import {
  detectPromotedAutomations,
  detectPromotedSessions,
  formatCodexSandboxAudit,
  isExplicitFullAccess,
} from './codex-sandbox-audit.js'

describe('isExplicitFullAccess', () => {
  it('only a strict true (or its persisted string) authorizes', () => {
    expect(isExplicitFullAccess(true)).toBe(true)
    expect(isExplicitFullAccess('true')).toBe(true)
    expect(isExplicitFullAccess(false)).toBe(false)
    expect(isExplicitFullAccess('false')).toBe(false)
    expect(isExplicitFullAccess(undefined)).toBe(false)
    expect(isExplicitFullAccess('')).toBe(false)
  })
})

describe('detectPromotedSessions', () => {
  it('reports a danger-full-access session with no marker', () => {
    expect(
      detectPromotedSessions([
        {
          session_id: 's1',
          config_key: 'codexPolicy.sandboxMode',
          config_value: 'danger-full-access',
        },
      ]),
    ).toEqual([
      {
        kind: 'session',
        id: 's1',
        detail: 'codexPolicy.sandboxMode=danger-full-access without explicitFullAccess',
      },
    ])
  })

  it('does NOT report a session whose marker is true', () => {
    expect(
      detectPromotedSessions([
        {
          session_id: 's1',
          config_key: 'codexPolicy.sandboxMode',
          config_value: 'danger-full-access',
        },
        { session_id: 's1', config_key: 'codexPolicy.explicitFullAccess', config_value: 'true' },
      ]),
    ).toEqual([])
  })

  it('does NOT report a session whose marker is false, but does report workspace-write-free rows', () => {
    expect(
      detectPromotedSessions([
        {
          session_id: 's1',
          config_key: 'codexPolicy.sandboxMode',
          config_value: 'danger-full-access',
        },
        { session_id: 's1', config_key: 'codexPolicy.explicitFullAccess', config_value: 'false' },
      ]),
    ).toHaveLength(1)
    expect(
      detectPromotedSessions([
        {
          session_id: 's2',
          config_key: 'codexPolicy.sandboxMode',
          config_value: 'workspace-write',
        },
      ]),
    ).toEqual([])
  })
})

describe('detectPromotedAutomations', () => {
  it('reports a JSON policy with danger-full-access and no marker', () => {
    expect(
      detectPromotedAutomations([
        {
          id: 'a1',
          workspace_name: '/w',
          mode: JSON.stringify({ sandboxMode: 'danger-full-access', approvalPolicy: 'never' }),
        },
      ]),
    ).toEqual([
      {
        kind: 'automation',
        id: 'a1',
        workspaceName: '/w',
        detail: 'mode.sandboxMode=danger-full-access without explicitFullAccess',
      },
    ])
  })

  it('does NOT report a JSON policy carrying the marker', () => {
    expect(
      detectPromotedAutomations([
        {
          id: 'a1',
          workspace_name: '/w',
          mode: JSON.stringify({
            sandboxMode: 'danger-full-access',
            approvalPolicy: 'never',
            explicitFullAccess: true,
          }),
        },
      ]),
    ).toEqual([])
  })

  it('does NOT report a legacy string token (it is an explicit choice)', () => {
    expect(
      detectPromotedAutomations([{ id: 'a1', workspace_name: '/w', mode: 'full-access' }]),
    ).toEqual([])
  })

  it('does NOT report a workspace-write or read-only automation', () => {
    expect(
      detectPromotedAutomations([
        {
          id: 'a1',
          workspace_name: '/w',
          mode: JSON.stringify({ sandboxMode: 'workspace-write', approvalPolicy: 'never' }),
        },
      ]),
    ).toEqual([])
  })
})

describe('formatCodexSandboxAudit', () => {
  it('states positively when nothing was promoted', () => {
    expect(formatCodexSandboxAudit([])).toContain('no silently-promoted full-access rows')
  })

  it('lists each finding', () => {
    const text = formatCodexSandboxAudit([
      { kind: 'session', id: 's1', detail: 'x' },
      { kind: 'automation', id: 'a1', workspaceName: '/w', detail: 'y' },
    ])
    expect(text).toContain('2 row(s)')
    expect(text).toContain('session s1')
    expect(text).toContain('automation a1 @ /w')
  })
})
