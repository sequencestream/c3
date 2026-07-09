/**
 * Regression: consensus config is read by `workspacePath`, NOT the effective cwd.
 *
 * Unlike `consensus.test.ts`, this suite does NOT mock `kernel/config` — it drives
 * the REAL `loadWorkspaceSetting` path with a temp `$HOME`/`projectConfigs`. It
 * seeds the consensus config under the registered ROOT key only, then invokes the
 * consensus entry points with `cwd` set to a worktree path that has NO config
 * entry. The config must still resolve (voting proceeds) because it keys off
 * `workspacePath`, not `cwd`. Passing the worktree as `workspacePath` misses the
 * config and correctly disables voting — this pins the #155 slip where the gateway
 * fed `effectiveCwd` in as the config key, silently killing consensus in every
 * worktree-isolated run.
 *
 * The SDK `query` and the voter roster are mocked (voting mechanics are covered in
 * consensus.test.ts); only the config-key path is exercised for real here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// One canned advisor reply per call (voter A, voter B, decider) — enough for a
// unanimous allow so the outcome is non-null when voting actually runs.
const responses = vi.hoisted(() => ({ queue: [] as Array<{ text: string }> }))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    const next = responses.queue.shift()
    return {
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: next?.text ?? '' }] },
        }
        yield { type: 'result' }
      },
      interrupt: () => Promise.resolve(),
    }
  },
}))

vi.mock('./kernel/infra/child-env.js', () => ({ findClaudeExecutable: () => undefined }))

// Fixed two-voter roster + a claude decider; the config key path is what's under
// test, not voter selection (that is settings.test.ts).
const agent = (id: string) => ({
  id,
  vendor: 'claude' as const,
  displayName: id.toUpperCase(),
  config: { baseUrl: '', apiKey: '', model: '' },
})
vi.mock('./kernel/agent-config/index.js', () => ({
  selectConsensusVoters: () => ['a', 'b'].map(agent),
  launchForAgent: () => ({}),
  resolveAgent: () => agent('decider'),
}))

import { runAskConsensus, runConsensusVote } from './consensus.js'
import { saveWorkspaceSetting, resetSettingsCacheForTests } from './kernel/config/index.js'
import type { WorkspaceSetting } from '@ccc/shared/protocol'

const ROOT = '/project/root'
const WORKTREE = '/c3-home/worktrees/project/intent-abc'

const QUESTION_INPUT = {
  questions: [
    { question: 'Pick one', header: 'H', multiSelect: false, options: [{ label: 'Alpha' }] },
  ],
}
const askVote = { text: JSON.stringify({ answers: [{ index: 0, choice: 'Alpha', reason: 'r' }] }) }
const toolVote = { text: JSON.stringify({ decision: 'allow', reason: 'safe' }) }
const summary = { text: 'all agree' }

let dir: string
let prevHome: string | undefined

beforeEach(() => {
  // Redirect ~/.c3 to a throwaway dir so the real config read never touches the
  // developer's settings.json (mirrors settings.test.ts).
  dir = mkdtempSync(join(tmpdir(), 'c3-consensus-cfg-'))
  prevHome = process.env.HOME
  process.env.HOME = dir
  resetSettingsCacheForTests()
  responses.queue = []
  // Enable consensus ONLY under the registered ROOT key — the worktree path has
  // no entry, so a lookup keyed on the worktree would miss and disable voting.
  saveWorkspaceSetting(ROOT, {
    consensus: { enabled: true, majority: false, mode: 'all' },
  } as unknown as WorkspaceSetting)
})

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME
  else process.env.HOME = prevHome
  resetSettingsCacheForTests()
  rmSync(dir, { recursive: true, force: true })
})

describe('consensus config read keys off workspacePath, not cwd', () => {
  it('runConsensusVote votes when cwd is an unconfigured worktree but workspacePath is the root', async () => {
    responses.queue = [toolVote, toolVote, summary]
    const out = await runConsensusVote({
      currentAgentId: 'decider',
      toolName: 'Write',
      input: { file_path: '/x.ts', content: 'x' },
      context: 'ctx',
      workspacePath: ROOT,
      cwd: WORKTREE,
      signal: new AbortController().signal,
    })
    // Config hit ⇒ voting ran ⇒ unanimous allow (NOT the null "disabled" short-circuit).
    expect(out).not.toBeNull()
    expect(out!.decision).toBe('allow')
    expect(out!.votes).toHaveLength(2)
  })

  it('runAskConsensus votes under the same cwd≠workspacePath split', async () => {
    responses.queue = [askVote, askVote, summary]
    const out = await runAskConsensus({
      currentAgentId: 'decider',
      toolName: 'AskUserQuestion',
      input: QUESTION_INPUT,
      context: 'ctx',
      workspacePath: ROOT,
      cwd: WORKTREE,
      signal: new AbortController().signal,
    })
    expect(out).not.toBeNull()
    expect(out!.fullyUnanimous).toBe(true)
  })

  it('the pre-fix behaviour is disabled: keying config on the worktree path returns null (no voting)', async () => {
    // Passing the worktree as workspacePath reproduces the #155 slip — the config
    // misses and consensus silently short-circuits to the human. No advisor fires.
    responses.queue = [toolVote, toolVote, summary]
    const out = await runConsensusVote({
      currentAgentId: 'decider',
      toolName: 'Write',
      input: { file_path: '/x.ts', content: 'x' },
      context: 'ctx',
      workspacePath: WORKTREE,
      cwd: WORKTREE,
      signal: new AbortController().signal,
    })
    expect(out).toBeNull()
    expect(responses.queue).toHaveLength(3) // no advisor query consumed the queue
  })
})
