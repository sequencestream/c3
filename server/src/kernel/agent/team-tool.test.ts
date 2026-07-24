/**
 * Regression guard for the team-liveness predicate under the SDK 0.3.218 default
 * subagent environment. c3 keeps the SDK defaults (concurrency cap 20, spawn depth
 * 1) and does NOT inject `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` /
 * `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` (asserted in `infra/child-env.test.ts`).
 *
 * Team detection therefore rests entirely on TOP-LEVEL tool use: a background
 * `Agent` (`run_in_background: true`), `TeamCreate`, or `SendMessage` keep the lead
 * alive; a foreground `Agent` does not. The 5 → 1 spawn-depth cut removes only
 * grandchild subagents, which this predicate never depended on.
 */
import { describe, expect, it } from 'vitest'
import { isTeamTool } from './index.js'

describe('isTeamTool (team-liveness under SDK 0.3.218 default subagent env)', () => {
  it('marks a background Agent as a team (detached teammate keeps the lead alive)', () => {
    expect(isTeamTool('Agent', { run_in_background: true })).toBe(true)
  })

  it('does NOT mark a foreground Agent as a team (completes within the turn)', () => {
    expect(isTeamTool('Agent', { run_in_background: false })).toBe(false)
    expect(isTeamTool('Agent', {})).toBe(false)
    expect(isTeamTool('Agent', null)).toBe(false)
    // A non-boolean truthy value is not the literal `true` the SDK emits.
    expect(isTeamTool('Agent', { run_in_background: 'true' })).toBe(false)
  })

  it('marks TeamCreate and SendMessage as a team regardless of input', () => {
    expect(isTeamTool('TeamCreate', {})).toBe(true)
    expect(isTeamTool('SendMessage', null)).toBe(true)
  })

  it('leaves ordinary tools out of team detection', () => {
    expect(isTeamTool('Read', {})).toBe(false)
    expect(isTeamTool('Bash', { command: 'ls' })).toBe(false)
  })
})
