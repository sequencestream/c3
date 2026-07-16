/**
 * Unit tests for `sandboxEligible` — the run-lifecycle sandbox entry decision.
 *
 * The entry condition is purely: host capability (`sandboxEnabled`), runtime
 * policy (`sandboxAllowed`), the workspace `enabled` master switch, and the run's
 * `sessionKind` being in `sandboxSessionKinds` (default `['work']`). The run's
 * source (Intent / spec / plain), its git branch mode, and whether it has an
 * isolated worktree are NOT inputs — proven here by the absence of any such
 * parameter and by identical results across session kinds.
 *
 * @module
 */
import { describe, it, expect } from 'vitest'
import { sandboxEligible } from './SandboxLauncher.js'
import type { WorkspaceSandboxConfig } from './types.js'
import type { SessionKind } from '@ccc/shared/protocol'

/** Build eligibility params with sensible defaults for the matrix. */
function params(over: {
  sandboxEnabled?: boolean
  sandboxAllowed?: boolean
  config?: WorkspaceSandboxConfig | undefined
  sessionKind?: SessionKind
}) {
  return {
    sandboxEnabled: over.sandboxEnabled ?? true,
    sandboxAllowed: over.sandboxAllowed ?? true,
    config: 'config' in over ? over.config : { enabled: true },
    sessionKind: over.sessionKind ?? ('work' as SessionKind),
  }
}

describe('sandboxEligible', () => {
  it('is true when enabled and the kind is in the (default) allowlist', () => {
    expect(sandboxEligible(params({ config: { enabled: true }, sessionKind: 'work' }))).toBe(true)
  })

  it('is false when the workspace sandbox is disabled or unconfigured', () => {
    expect(sandboxEligible(params({ config: { enabled: false } }))).toBe(false)
    expect(sandboxEligible(params({ config: undefined }))).toBe(false)
    expect(sandboxEligible(params({ config: {} }))).toBe(false)
  })

  it('is false when the session kind is not in the allowlist', () => {
    expect(
      sandboxEligible(
        params({ config: { enabled: true, sandboxSessionKinds: ['work'] }, sessionKind: 'intent' }),
      ),
    ).toBe(false)
  })

  it('is true for a non-work kind that is explicitly whitelisted', () => {
    expect(
      sandboxEligible(
        params({
          config: { enabled: true, sandboxSessionKinds: ['work', 'intent'] },
          sessionKind: 'intent',
        }),
      ),
    ).toBe(true)
  })

  it('is false when the host capability or runtime policy gate is closed', () => {
    expect(sandboxEligible(params({ sandboxEnabled: false }))).toBe(false)
    expect(sandboxEligible(params({ sandboxAllowed: false }))).toBe(false)
  })

  it('does not depend on the run source: same kind decides identically for Intent-launched and plain runs', () => {
    // There is no "source" input; two runs that share (config, kind) always agree.
    const cfg: WorkspaceSandboxConfig = { enabled: true, sandboxSessionKinds: ['work'] }
    const intentLaunchedWork = sandboxEligible(params({ config: cfg, sessionKind: 'work' }))
    const plainWork = sandboxEligible(params({ config: cfg, sessionKind: 'work' }))
    expect(intentLaunchedWork).toBe(plainWork)
    expect(plainWork).toBe(true)
  })
})
