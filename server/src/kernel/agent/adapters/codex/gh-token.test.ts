/**
 * Unit coverage for the codex GH_TOKEN bridge. The host `gh auth token` execution
 * is replaced by a stub runner so every branch — inject, skip-when-present, and
 * silent-degrade — is exercised deterministically without a real `gh` or keychain.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveCodexGhTokenEnv, type GhAuthTokenRunner } from './gh-token.js'

// buildChildEnv folds in process.env, so a stray GH_TOKEN/GITHUB_TOKEN in the test
// runner's own environment would mask the probe. Clear both around every case.
const SAVED_GH = process.env.GH_TOKEN
const SAVED_GITHUB = process.env.GITHUB_TOKEN
function clearHostTokens(): void {
  delete process.env.GH_TOKEN
  delete process.env.GITHUB_TOKEN
}

afterEach(() => {
  if (SAVED_GH === undefined) delete process.env.GH_TOKEN
  else process.env.GH_TOKEN = SAVED_GH
  if (SAVED_GITHUB === undefined) delete process.env.GITHUB_TOKEN
  else process.env.GITHUB_TOKEN = SAVED_GITHUB
})

const runner = (result: { ok: boolean; stdout: string }): GhAuthTokenRunner =>
  vi.fn(() => Promise.resolve(result))

describe('resolveCodexGhTokenEnv', () => {
  it('injects the trimmed token as GH_TOKEN when neither var is set', async () => {
    clearHostTokens()
    const run = runner({ ok: true, stdout: '  ghp_secret\n' })
    const out = await resolveCodexGhTokenEnv(undefined, run)
    expect(out).toEqual({ GH_TOKEN: 'ghp_secret' })
    expect(run).toHaveBeenCalledOnce()
  })

  it('preserves existing overrides and appends GH_TOKEN', async () => {
    clearHostTokens()
    const out = await resolveCodexGhTokenEnv(
      { HTTP_PROXY: 'http://p' },
      runner({ ok: true, stdout: 'ghp_secret' }),
    )
    expect(out).toEqual({ HTTP_PROXY: 'http://p', GH_TOKEN: 'ghp_secret' })
  })

  it('does not probe or overwrite when the override already sets GH_TOKEN', async () => {
    clearHostTokens()
    const run = runner({ ok: true, stdout: 'from-keyring' })
    const out = await resolveCodexGhTokenEnv({ GH_TOKEN: 'from-agent' }, run)
    expect(out).toEqual({ GH_TOKEN: 'from-agent' })
    expect(run).not.toHaveBeenCalled()
  })

  it('does not probe or overwrite when the override already sets GITHUB_TOKEN', async () => {
    clearHostTokens()
    const run = runner({ ok: true, stdout: 'from-keyring' })
    const out = await resolveCodexGhTokenEnv({ GITHUB_TOKEN: 'from-agent' }, run)
    expect(out).toEqual({ GITHUB_TOKEN: 'from-agent' })
    expect(run).not.toHaveBeenCalled()
  })

  it('does not probe when the host shell already exports GH_TOKEN', async () => {
    clearHostTokens()
    process.env.GH_TOKEN = 'from-shell'
    const run = runner({ ok: true, stdout: 'from-keyring' })
    const out = await resolveCodexGhTokenEnv(undefined, run)
    expect(out).toBeUndefined()
    expect(run).not.toHaveBeenCalled()
  })

  it('does not probe when the host shell already exports GITHUB_TOKEN', async () => {
    clearHostTokens()
    process.env.GITHUB_TOKEN = 'from-shell'
    const run = runner({ ok: true, stdout: 'from-keyring' })
    const out = await resolveCodexGhTokenEnv({ FOO: 'bar' }, run)
    expect(out).toEqual({ FOO: 'bar' })
    expect(run).not.toHaveBeenCalled()
  })

  it('treats a blank host var as absent and still injects', async () => {
    clearHostTokens()
    process.env.GH_TOKEN = '   '
    const out = await resolveCodexGhTokenEnv(undefined, runner({ ok: true, stdout: 'ghp_x' }))
    expect(out).toEqual({ GH_TOKEN: 'ghp_x' })
  })

  it('returns overrides unchanged when gh is missing / exits non-zero', async () => {
    clearHostTokens()
    const out = await resolveCodexGhTokenEnv({ FOO: 'bar' }, runner({ ok: false, stdout: '' }))
    expect(out).toEqual({ FOO: 'bar' })
  })

  it('returns undefined (no overrides) when gh fails and none were passed', async () => {
    clearHostTokens()
    const out = await resolveCodexGhTokenEnv(undefined, runner({ ok: false, stdout: '' }))
    expect(out).toBeUndefined()
  })

  it('does not inject when gh succeeds but stdout is empty/whitespace', async () => {
    clearHostTokens()
    const out = await resolveCodexGhTokenEnv(undefined, runner({ ok: true, stdout: '  \n' }))
    expect(out).toBeUndefined()
  })
})
