/**
 * Claude reference adapter conformance (ADR-0011). Hermetic: exercises the pure
 * translation / policy / approval pieces that make up the adapter's behavior, no
 * `claude` process spawned. The live `AgentDriver.start` stream is covered at the
 * translation seam ({@link ClaudeStreamTranslator}), which IS `messages()`'s core.
 */
import { describe, it, expect } from 'vitest'
import type { ServerToClient } from '@ccc/shared/protocol'
import type { ActionMode, PolicyContext, ToolGate } from '../types.js'
import { claudeCapabilities } from './capabilities.js'
import { ClaudeApprovalBridge } from './approval.js'
import { claudePolicy } from './policy.js'
import { fromPermissionMode, toPermissionMode } from './permission-map.js'
import { ClaudeStreamTranslator, transcriptToCanonical } from './translate.js'

const ctx = (actionMode: ActionMode, toolGate: ToolGate): PolicyContext => ({
  actionMode,
  toolGate,
  cwd: '/tmp',
})

describe('claude capabilities', () => {
  it('reports all six vendor abilities true and every session op `full` (the reference adapter)', () => {
    expect(claudeCapabilities).toEqual({
      interrupt: true,
      setActionMode: true,
      streamingPush: true,
      inProcessMcp: true,
      forkSession: true,
      perToolApproval: true,
      // The structured session-lifecycle sub-ledger (ADR-0011 addendum) — every
      // session op is `full` for the reference adapter (JSONL read, native
      // rename/delete, SDK resume, no caveat).
      sessions: {
        list: 'full',
        read: 'full',
        resume: 'full',
        rename: 'full',
        delete: 'full',
      },
    })
  })
})

describe('permission-map (PermissionMode ⇄ neutral grid)', () => {
  it('maps each Claude mode into the grid', () => {
    expect(fromPermissionMode('plan')).toEqual({ actionMode: 'plan', toolGate: 'on-sensitive' })
    expect(fromPermissionMode('acceptEdits')).toEqual({
      actionMode: 'build',
      toolGate: 'trusted-prefix',
    })
    expect(fromPermissionMode('bypassPermissions')).toEqual({
      actionMode: 'build',
      toolGate: 'never-ask',
    })
    expect(fromPermissionMode('default')).toEqual({ actionMode: 'build', toolGate: 'on-sensitive' })
    // auto collapses to default's cell — the bias is lossy (documented).
    expect(fromPermissionMode('auto')).toEqual({ actionMode: 'build', toolGate: 'on-sensitive' })
  })

  it('reverses the grid to the closest Claude mode', () => {
    expect(toPermissionMode('plan', 'on-sensitive')).toBe('plan')
    expect(toPermissionMode('plan', 'never-ask')).toBe('plan') // plan dominates
    expect(toPermissionMode('build', 'never-ask')).toBe('bypassPermissions')
    expect(toPermissionMode('build', 'trusted-prefix')).toBe('acceptEdits')
    expect(toPermissionMode('build', 'on-sensitive')).toBe('default')
    // always-ask has no Claude peer ⇒ nearest is default.
    expect(toPermissionMode('build', 'always-ask')).toBe('default')
  })
})

describe('claudePolicy (neutral verdicts)', () => {
  it('never-ask allows everything', () => {
    expect(claudePolicy('Bash', {}, ctx('build', 'never-ask'))).toBe('allow')
  })
  it('read-only tools auto-allow under any gate', () => {
    expect(claudePolicy('Read', {}, ctx('build', 'on-sensitive'))).toBe('allow')
    expect(claudePolicy('Grep', {}, ctx('plan', 'always-ask'))).toBe('allow')
  })
  it('plan refuses sensitive tools outright', () => {
    expect(claudePolicy('Write', {}, ctx('plan', 'on-sensitive'))).toBe('deny')
    expect(claudePolicy('Bash', {}, ctx('plan', 'trusted-prefix'))).toBe('deny')
  })
  it('on-sensitive asks for a sensitive tool', () => {
    expect(claudePolicy('Bash', {}, ctx('build', 'on-sensitive'))).toBe('ask')
  })
  it('trusted-prefix auto-allows edits, asks for the rest', () => {
    expect(claudePolicy('Edit', {}, ctx('build', 'trusted-prefix'))).toBe('allow')
    expect(claudePolicy('Bash', {}, ctx('build', 'trusted-prefix'))).toBe('ask')
  })
  it('always-ask asks for a sensitive tool', () => {
    expect(claudePolicy('Bash', {}, ctx('build', 'always-ask'))).toBe('ask')
  })
})

describe('ClaudeApprovalBridge (intercept → suspend → write back)', () => {
  it('routes an allow decision into a branded SDK verdict', async () => {
    const bridge = new ClaudeApprovalBridge()
    bridge.onRequest(async (req) => {
      expect(req.toolName).toBe('Bash')
      return { behavior: 'allow', updatedInput: { command: 'ls' } }
    })
    const verdict = await bridge.decide('req-1', 'Bash', { command: 'rm' })
    expect(verdict.behavior).toBe('allow')
    expect((verdict as { updatedInput?: unknown }).updatedInput).toEqual({ command: 'ls' })
  })

  it('routes a deny decision with its reason', async () => {
    const bridge = new ClaudeApprovalBridge()
    bridge.onRequest(async () => ({ behavior: 'deny', reason: 'nope' }))
    const verdict = await bridge.decide('req-2', 'Bash', {})
    expect(verdict.behavior).toBe('deny')
    expect((verdict as { message?: string }).message).toBe('nope')
  })

  it('default-denies with no handler registered', async () => {
    const bridge = new ClaudeApprovalBridge()
    const verdict = await bridge.decide('req-3', 'Bash', {})
    expect(verdict.behavior).toBe('deny')
  })

  it('disposer unregisters the handler', async () => {
    const bridge = new ClaudeApprovalBridge()
    const dispose = bridge.onRequest(async () => ({ behavior: 'allow' }))
    dispose()
    const verdict = await bridge.decide('req-4', 'Bash', {})
    expect(verdict.behavior).toBe('deny') // back to default-deny
  })
})

describe('ClaudeStreamTranslator (wire frame → canonical)', () => {
  const tick = () => {
    let n = 0
    return () => ++n
  }

  it('maps user/assistant text and ignores non-message frames', () => {
    const t = new ClaudeStreamTranslator(tick())
    t.setSessionId('s1')
    expect(t.translate({ type: 'user_text', text: 'hi' })).toMatchObject({
      vendor: 'claude',
      sessionId: 's1',
      role: 'user',
      blocks: [{ type: 'text', text: 'hi' }],
    })
    expect(t.translate({ type: 'assistant_text', text: 'yo' })).toMatchObject({
      role: 'assistant',
      blocks: [{ type: 'text', text: 'yo' }],
    })
    expect(t.translate({ type: 'notice', text: '...' })).toBeNull()
    expect(t.translate({ type: 'turn_end', reason: 'complete' } as ServerToClient)).toBeNull()
  })

  it('embeds a tool result onto the tool_use block (D3), recovering name/input', () => {
    const t = new ClaudeStreamTranslator(tick())
    t.setSessionId('s1')
    const use = t.translate({
      type: 'tool_use',
      toolUseId: 'tu1',
      toolName: 'Bash',
      input: { command: 'ls' },
    })
    expect(use?.blocks[0]).toEqual({
      type: 'tool_use',
      id: 'tu1',
      name: 'Bash',
      input: { command: 'ls' },
    })
    const result = t.translate({
      type: 'tool_result',
      toolUseId: 'tu1',
      content: 'a\nb',
      isError: false,
    })
    // No standalone tool_result block: the result rides the tool_use block, and
    // the prior name/input are recovered by id.
    expect(result?.blocks[0]).toEqual({
      type: 'tool_use',
      id: 'tu1',
      name: 'Bash',
      input: { command: 'ls' },
      result: { content: 'a\nb', isError: false },
    })
  })

  it('synthesizes name=unknown for an orphan tool_result', () => {
    const t = new ClaudeStreamTranslator(tick())
    const m = t.translate({ type: 'tool_result', toolUseId: 'x', content: 'r', isError: true })
    expect(m?.blocks[0]).toMatchObject({ type: 'tool_use', name: 'unknown', id: 'x' })
  })
})

describe('transcriptToCanonical (history replay → canonical)', () => {
  it('folds tool_result into the prior tool_use block in place (id-upsert)', () => {
    const msgs = transcriptToCanonical(
      [
        { kind: 'user', text: 'do it' },
        { kind: 'tool_use', toolUseId: 'tu1', toolName: 'Bash', input: { command: 'ls' } },
        { kind: 'tool_result', toolUseId: 'tu1', content: 'ok', isError: false },
        { kind: 'notice', text: 'thought only' },
      ],
      's1',
      () => 0,
    )
    // user msg + tool_use msg (result folded in); notice dropped; no extra msg.
    expect(msgs).toHaveLength(2)
    expect(msgs[0].role).toBe('user')
    expect(msgs[1].blocks[0]).toEqual({
      type: 'tool_use',
      id: 'tu1',
      name: 'Bash',
      input: { command: 'ls' },
      result: { content: 'ok', isError: false },
    })
  })

  it('emits an unknown tool_use for an orphan result', () => {
    const msgs = transcriptToCanonical(
      [{ kind: 'tool_result', toolUseId: 'z', content: 'r', isError: true }],
      's1',
      () => 0,
    )
    expect(msgs).toHaveLength(1)
    expect(msgs[0].blocks[0]).toMatchObject({ type: 'tool_use', name: 'unknown', id: 'z' })
  })
})
