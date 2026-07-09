/**
 * C-SEC unit tests for the permission gateway chokepoint (server refactor 3/3).
 *
 * Covers the two no-consensus gate policies end to end (intent /
 * discussion-research) — read tools pass, everything else is DENIED BY DEFAULT
 * (PG-R4) — and asserts the load-bearing C-SEC invariant: a permission verdict is
 * EPHEMERAL. Resolving any number of prompts never writes to disk (the gateway +
 * registry hold state only in memory, unlike settings/state which persist). The
 * standard (consensus) gate's default-deny is pinned by the C4 golden contract.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import type { ServerToClient } from '@ccc/shared/protocol'
import { createCanUseTool, type GatewaySpec } from './gateway.js'
import { resolveDecision } from './registry.js'

// Consensus modules are mocked so standard-gate tests can control return values.
vi.mock('../../consensus.js')
import { runConsensusVote, runAskConsensus } from '../../consensus.js'

function spec(overrides: Partial<GatewaySpec> = {}): GatewaySpec {
  const base: GatewaySpec = {
    gate: 'intent',
    sessionKind: 'intent',
    send: () => {},
    signal: new AbortController().signal,
    currentAgentId: null,
    // Default to current-branch semantics (config/audit root === effective cwd);
    // a worktree regression case overrides `workspacePath` to differ from `cwd`.
    workspacePath: overrides.workspacePath ?? overrides.cwd ?? '/tmp',
    cwd: '/tmp',
    recentContext: () => '',
    sessionId: () => '',
    ...overrides,
  }
  // Mirror production (agent/index.ts): sessionKind is derived from the gate unless the
  // test pins it explicitly, so a standard-gate prompt registers as 'work'.
  return overrides.sessionKind
    ? base
    : {
        ...base,
        sessionKind:
          base.gate === 'intent'
            ? 'intent'
            : base.gate === 'spec'
              ? 'spec'
              : base.gate === 'discussion-research'
                ? 'discussion'
                : 'work',
      }
}

beforeEach(() => {
  // Default: no consensus → fall through to permission_request.
  vi.mocked(runConsensusVote).mockResolvedValue(null as never)
  vi.mocked(runAskConsensus).mockResolvedValue(null as never)
})

afterEach(() => vi.restoreAllMocks())

describe('intent gate — read-only, deny-by-default', () => {
  it('allows a read-class built-in with the original input (no prompt)', async () => {
    const gate = createCanUseTool(spec())
    const out = await gate('Read', { file_path: '/x' }, {} as never)
    expect(out).toMatchObject({ behavior: 'allow', updatedInput: { file_path: '/x' } })
  })

  it('DENIES a write/exec tool by default', async () => {
    const gate = createCanUseTool(spec())
    const out = await gate('Bash', { command: 'rm -rf /' }, {} as never)
    expect(out).toMatchObject({ behavior: 'deny' })
    expect((out as { message: string }).message).toMatch(/read-only/)
  })

  it('lets save_intents through without a gate prompt (the handler owns the confirmation)', async () => {
    // The save confirmation is sunk into the save handler (`gatedSave`, codex-parity),
    // so the gate ALLOWS save through to reach it — emitting NO permission_request of
    // its own. A vendor allow-rule that bypasses this `canUseTool` therefore still hits
    // the handler's prompt, and the gate can't double-prompt.
    const sent: ServerToClient[] = []
    const gate = createCanUseTool(spec({ send: (m) => sent.push(m) }))
    const out = await gate('mcp__c3__save_intents', { items: [] }, {} as never)
    expect(out).toMatchObject({ behavior: 'allow' })
    expect(sent.find((m) => m.type === 'permission_request')).toBeUndefined()
  })
})

describe('publish_pr_event — auto-allowed with no prompt (2026-06-20)', () => {
  it('auto-allows in the standard gate and emits NO permission_request', async () => {
    const sent: ServerToClient[] = []
    const gate = createCanUseTool(spec({ gate: 'standard', send: (m) => sent.push(m) }))
    const out = await gate(
      'mcp__c3__publish_pr_event',
      { operation: 'merge', result: 'success' },
      {} as never,
    )
    expect(out).toMatchObject({ behavior: 'allow' })
    expect(sent.find((m) => m.type === 'permission_request')).toBeUndefined()
    // The non-destructive publish never runs consensus either.
    expect(vi.mocked(runConsensusVote)).not.toHaveBeenCalled()
  })
})

describe('discussion-research gate — read-only, deny-by-default', () => {
  it('allows a read tool, denies everything else', async () => {
    const gate = createCanUseTool(spec({ gate: 'discussion-research' }))
    expect(await gate('Grep', { pattern: 'x' }, {} as never)).toMatchObject({ behavior: 'allow' })
    expect(await gate('Write', { file_path: '/x' }, {} as never)).toMatchObject({
      behavior: 'deny',
    })
  })
})

describe('spec gate — write-confined, deny-by-default', () => {
  const specDir = '/proj/.specs/2026/06/18/2026-06-18-001-add-login'
  const g = () => createCanUseTool(spec({ gate: 'spec', specDir, cwd: '/proj' }))

  it('allows a read tool at any path (no prompt)', async () => {
    expect(await g()('Read', { file_path: '/proj/src/secret.ts' }, {} as never)).toMatchObject({
      behavior: 'allow',
    })
    expect(await g()('Grep', { pattern: 'x' }, {} as never)).toMatchObject({ behavior: 'allow' })
  })

  it('ALLOWS the read-only ledger query tools find_intents / view_intent (no prompt)', async () => {
    // The spec author may search/inspect THIS project's intents to ground the spec.
    // Both are read-only + project-bound in the MCP tool closure, so the gate passes
    // them like a read built-in (no confirmation).
    const sent: ServerToClient[] = []
    const gate = createCanUseTool(
      spec({ gate: 'spec', specDir, cwd: '/proj', send: (m) => sent.push(m) }),
    )
    expect(await gate('mcp__c3__find_intents', { keyword: 'x' }, {} as never)).toMatchObject({
      behavior: 'allow',
    })
    expect(await gate('mcp__c3__view_intent', { id: 'abc' }, {} as never)).toMatchObject({
      behavior: 'allow',
    })
    expect(sent.find((m) => m.type === 'permission_request')).toBeUndefined()
  })

  it('DENIES mcp__c3__save_intents (the spec session must never write the ledger)', async () => {
    // The spec MCP server doesn't register save (main defence); the gate is the
    // second line — its read-pass set is an explicit read-only union, so save is NOT
    // allowed-through (unlike the intent gate) and falls to deny-by-default. This
    // holds even if save were ever mis-registered or vendor-preapproved.
    const out = await g()('mcp__c3__save_intents', { intents: [] }, {} as never)
    expect(out).toMatchObject({ behavior: 'deny' })
    expect((out as { message: string }).message).toMatch(/spec-only/)
  })

  it('ALLOWS a write inside the spec directory', async () => {
    const out = await g()('Write', { file_path: `${specDir}/spec.md` }, {} as never)
    expect(out).toMatchObject({ behavior: 'allow' })
  })

  it('DENIES a write to a project path outside the spec directory', async () => {
    const out = await g()('Write', { file_path: '/proj/src/index.ts' }, {} as never)
    expect(out).toMatchObject({ behavior: 'deny' })
    expect((out as { message: string }).message).toMatch(/spec directory/)
  })

  it('DENIES a prefix-confusion sibling dir (.specsEVIL vs .specs/...)', async () => {
    const out = await g()(
      'Write',
      { file_path: '/proj/.specs/2026/06/18/2026-06-18-001-add-loginEVIL/x.md' },
      {} as never,
    )
    expect(out).toMatchObject({ behavior: 'deny' })
  })

  it('DENIES a ../ traversal escaping the spec directory', async () => {
    const out = await g()('Write', { file_path: `${specDir}/../../../../etc/passwd` }, {} as never)
    expect(out).toMatchObject({ behavior: 'deny' })
  })

  it('DENIES a write tool with no resolvable target path (fail-closed)', async () => {
    const out = await g()('Write', { content: 'no path' }, {} as never)
    expect(out).toMatchObject({ behavior: 'deny' })
  })

  it('DENIES Bash (exec is blocked on the spec gate)', async () => {
    const out = await g()('Bash', { command: 'echo hi > /proj/src/x.ts' }, {} as never)
    expect(out).toMatchObject({ behavior: 'deny' })
    expect((out as { message: string }).message).toMatch(/spec-only/)
  })
})

describe('C-SEC — permission verdicts are NOT persisted (no-persist)', () => {
  it('a full allow + deny + save flow never writes to disk', async () => {
    const writeFile = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {})
    const gate = createCanUseTool(spec())

    await gate('Read', { file_path: '/a' }, {} as never) // allow
    await gate('Bash', { command: 'x' }, {} as never) // deny
    await gate('mcp__c3__save_intents', { items: [] }, {} as never) // allow through to handler

    // The verdict path is entirely in-memory: no settings-style fs write happened.
    expect(writeFile).not.toHaveBeenCalled()
  })
})

describe('onPermissionRequest callback', () => {
  // ── Intent gate tests (no consensus dependency) ──

  it('does NOT call callback on intent-gate save (the handler owns that prompt now)', async () => {
    // Save's confirmation — and its WorkCenter `onPermissionRequest` registration —
    // moved into the save handler (`gatedSave`). The gate now allows save straight
    // through, so it must NOT emit a permission_request or fire the callback here
    // (doing so would double-register the WaitUserInvolveEvent and double-prompt).
    const onPermissionRequest = vi.fn()
    const sent: ServerToClient[] = []
    const gate = createCanUseTool(
      spec({ gate: 'intent', send: (m) => sent.push(m), onPermissionRequest }),
    )
    const out = await gate('mcp__c3__save_intents', { items: [] }, {} as never)
    expect(out).toMatchObject({ behavior: 'allow' })
    expect(sent.find((m) => m.type === 'permission_request')).toBeUndefined()
    expect(onPermissionRequest).not.toHaveBeenCalled()
  })

  it('calls callback on intent-gate AskUserQuestion with source intent (#3)', async () => {
    // The read-only comm agent's clarifying question DOES involve the human, so
    // it must register a WaitUserInvolveEvent — previously (wrongly) excluded.
    const onPermissionRequest = vi.fn()
    const sent: ServerToClient[] = []
    const gate = createCanUseTool(
      spec({ gate: 'intent', send: (m) => sent.push(m), onPermissionRequest }),
    )
    const askInput = {
      questions: [{ question: 'test?', header: 'h', options: [{ label: 'a' }] }],
    }
    const p = gate('AskUserQuestion', askInput, {} as never)
    const req = sent.find((m) => m.type === 'permission_request')
    expect(req).toBeDefined()
    if (req?.type === 'permission_request')
      resolveDecision(req.requestId, 'allow', { 'test?': 'a' })
    await p
    expect(onPermissionRequest).toHaveBeenCalledTimes(1)
    expect(onPermissionRequest).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'AskUserQuestion', sessionKind: 'intent' }),
    )
  })

  it('does NOT call callback on discussion-research read tool (no permission_request)', async () => {
    const onPermissionRequest = vi.fn()
    const gate = createCanUseTool(spec({ gate: 'discussion-research', onPermissionRequest }))
    await gate('Grep', { pattern: 'x' }, {} as never)
    expect(onPermissionRequest).not.toHaveBeenCalled()
  })

  // ── Standard gate: skillWriteGuard (bypasses consensus) ──

  it('calls callback on skillWriteGuard write tool (#4)', async () => {
    const onPermissionRequest = vi.fn()
    const sent: ServerToClient[] = []
    const gate = createCanUseTool(
      spec({
        gate: 'standard',
        send: (m) => sent.push(m),
        onPermissionRequest,
        skillWriteGuard: true,
      }),
    )
    const p = gate('Write', { file_path: '/x' }, {} as never)
    const req = sent.find((m) => m.type === 'permission_request')
    expect(req).toBeDefined()
    if (req?.type === 'permission_request') resolveDecision(req.requestId, 'allow')
    await p
    expect(onPermissionRequest).toHaveBeenCalledTimes(1)
    expect(onPermissionRequest).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'Write', sessionKind: 'work' }),
    )
  })

  // ── Standard gate: AskUserQuestion consensus ──

  it('calls callback on AskUserQuestion when consensus is NOT unanimous (#2)', async () => {
    // runAskConsensus returns a non-fullyUnanimous outcome → permission_request sent.
    vi.mocked(runAskConsensus).mockResolvedValue({
      kind: 'ask',
      fullyUnanimous: false,
      perQuestion: [
        {
          index: 0,
          question: 'test?',
          header: 'h',
          multiSelect: false,
          answers: [{ agentId: 'a1', agentName: 'A1', optionLabels: ['yes'], reason: 'ok' }],
          unanimous: true,
          agreed: 'yes',
        },
      ],
      agreedAnswers: { 'test?': 'yes' },
      summary: 'one answer',
    } as never)
    const onPermissionRequest = vi.fn()
    const sent: ServerToClient[] = []
    const gate = createCanUseTool(
      spec({ gate: 'standard', send: (m) => sent.push(m), onPermissionRequest }),
    )
    const askInput = {
      questions: [{ question: 'test?', header: 'h', options: [{ label: 'yes' }, { label: 'no' }] }],
    }
    // Start the gate call; it suspends at `await runAskConsensus(...)`.
    const p = gate('AskUserQuestion', askInput, {} as never)
    // Yield to the microtask queue so the mock's resolved Promise flushes,
    // letting the gateway continue to `send(permission_request)` and then
    // suspend on `waitForDecision(...)`.
    await new Promise<void>((r) => queueMicrotask(r))
    const req = sent.find((m) => m.type === 'permission_request')
    if (req?.type === 'permission_request') resolveDecision(req.requestId, 'allow')
    await p
    expect(onPermissionRequest).toHaveBeenCalledTimes(1)
  })

  it('does NOT call callback on AskUserQuestion when fullyUnanimous (#3)', async () => {
    // runAskConsensus returns fullyUnanimous → consensus_auto, NOT permission_request.
    vi.mocked(runAskConsensus).mockResolvedValue({
      kind: 'ask',
      fullyUnanimous: true,
      perQuestion: [
        {
          index: 0,
          question: 'test?',
          header: 'h',
          multiSelect: false,
          answers: [{ agentId: 'a1', agentName: 'A1', optionLabels: ['yes'], reason: 'ok' }],
          unanimous: true,
          agreed: 'yes',
        },
      ],
      agreedAnswers: { 'test?': 'yes' },
      summary: 'all agree',
    } as never)
    const onPermissionRequest = vi.fn()
    const onConsensusResolved = vi.fn()
    const gate = createCanUseTool(
      spec({ gate: 'standard', onPermissionRequest, onConsensusResolved }),
    )
    const askInput = {
      questions: [{ question: 'test?', header: 'h', options: [{ label: 'yes' }, { label: 'no' }] }],
    }
    const result = await gate('AskUserQuestion', askInput, {} as never)
    expect(result).toMatchObject({ behavior: 'allow' })
    expect(onPermissionRequest).not.toHaveBeenCalled()
    // The auto-answer is recorded for audit (status 'auto'), with the ask outcome.
    expect(onConsensusResolved).toHaveBeenCalledTimes(1)
    expect(onConsensusResolved).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'AskUserQuestion',
        outcome: expect.objectContaining({ kind: 'ask', fullyUnanimous: true }),
      }),
    )
  })

  // ── Standard gate: write tool consensus ──

  it('calls callback on write tool when consensus returns null (#5)', async () => {
    // Default mock: runConsensusVote returns null → falls through to permission_request.
    const onPermissionRequest = vi.fn()
    const onConsensusResolved = vi.fn()
    const sent: ServerToClient[] = []
    const gate = createCanUseTool(
      spec({
        gate: 'standard',
        send: (m) => sent.push(m),
        onPermissionRequest,
        onConsensusResolved,
      }),
    )
    // Start the gate call; it suspends at `await runConsensusVote(...)`.
    const p = gate('Write', { file_path: '/x' }, {} as never)
    // Yield so the mock's resolved Promise flushes → gateway continues to
    // send(permission_request) and then suspends on waitForDecision.
    await new Promise<void>((r) => queueMicrotask(r))
    const req = sent.find((m) => m.type === 'permission_request')
    expect(req).toBeDefined()
    if (req?.type === 'permission_request') resolveDecision(req.requestId, 'allow')
    await p
    expect(onPermissionRequest).toHaveBeenCalledTimes(1)
    // A human decided it — it is NOT a consensus auto-resolution.
    expect(onConsensusResolved).not.toHaveBeenCalled()
  })

  it('does NOT call callback on write tool when consensus auto-resolves (#6)', async () => {
    // runConsensusVote returns a decision → consensus_auto, NOT permission_request.
    vi.mocked(runConsensusVote).mockResolvedValue({
      kind: 'tool',
      votes: [{ agentId: 'a1', agentName: 'A1', decision: 'allow', reason: 'ok' }],
      summary: 'all agree',
      unanimous: true,
      decision: 'allow',
    } as never)
    const onPermissionRequest = vi.fn()
    const onConsensusResolved = vi.fn()
    const gate = createCanUseTool(
      spec({ gate: 'standard', onPermissionRequest, onConsensusResolved }),
    )
    const result = await gate('Write', { file_path: '/x' }, {} as never)
    expect(result).toMatchObject({ behavior: 'allow' })
    expect(onPermissionRequest).not.toHaveBeenCalled()
    // No human prompt, but the consensus auto-decision is recorded for audit.
    expect(onConsensusResolved).toHaveBeenCalledTimes(1)
    expect(onConsensusResolved).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'Write',
        sessionKind: 'work',
        outcome: expect.objectContaining({ kind: 'tool', decision: 'allow' }),
      }),
    )
  })
})

describe('worktree isolation — config/audit key is workspacePath, advisor cwd is the worktree', () => {
  // Regression for the #155 slip: under worktree isolation the gateway must read
  // consensus config and attribute WorkCenter events off the registered ROOT
  // (`workspacePath`), while the advisor queries still launch in the worktree
  // (`cwd`). A run where the two paths differ pins that split.
  const ROOT = '/project/root'
  const WORKTREE = '/c3-home/worktrees/project/intent-abc'

  it('write-tool consensus receives workspacePath=root and cwd=worktree; audit ctx uses root', async () => {
    vi.mocked(runConsensusVote).mockResolvedValue({
      kind: 'tool',
      votes: [{ agentId: 'a1', agentName: 'A1', decision: 'allow', reason: 'ok' }],
      summary: 'all agree',
      unanimous: true,
      decision: 'allow',
    } as never)
    const onConsensusResolved = vi.fn()
    const gate = createCanUseTool(
      spec({ gate: 'standard', cwd: WORKTREE, workspacePath: ROOT, onConsensusResolved }),
    )
    const result = await gate('Write', { file_path: '/x' }, {} as never)
    expect(result).toMatchObject({ behavior: 'allow' })
    // Config read keys off the registered root; the advisor query launches in the worktree.
    expect(vi.mocked(runConsensusVote)).toHaveBeenCalledWith(
      expect.objectContaining({ workspacePath: ROOT, cwd: WORKTREE }),
    )
    // The auto-resolution audit event is attributed to the root, not the worktree.
    expect(onConsensusResolved).toHaveBeenCalledWith(
      expect.objectContaining({ workspacePath: ROOT }),
    )
  })

  it('AskUserQuestion consensus receives workspacePath=root and cwd=worktree; prompt ctx uses root', async () => {
    // Non-unanimous ⇒ falls through to a human permission_request (fires onPermissionRequest).
    vi.mocked(runAskConsensus).mockResolvedValue({
      kind: 'ask',
      fullyUnanimous: false,
      perQuestion: [
        {
          index: 0,
          question: 'test?',
          header: 'h',
          multiSelect: false,
          answers: [{ agentId: 'a1', agentName: 'A1', optionLabels: ['yes'], reason: 'ok' }],
          unanimous: true,
          agreed: 'yes',
        },
      ],
      agreedAnswers: { 'test?': 'yes' },
      summary: 'one answer',
    } as never)
    const onPermissionRequest = vi.fn()
    const sent: ServerToClient[] = []
    const gate = createCanUseTool(
      spec({
        gate: 'standard',
        cwd: WORKTREE,
        workspacePath: ROOT,
        send: (m) => sent.push(m),
        onPermissionRequest,
      }),
    )
    const askInput = {
      questions: [{ question: 'test?', header: 'h', options: [{ label: 'yes' }, { label: 'no' }] }],
    }
    const p = gate('AskUserQuestion', askInput, {} as never)
    await new Promise<void>((r) => queueMicrotask(r))
    const req = sent.find((m) => m.type === 'permission_request')
    if (req?.type === 'permission_request')
      resolveDecision(req.requestId, 'allow', { 'test?': 'yes' })
    await p
    expect(vi.mocked(runAskConsensus)).toHaveBeenCalledWith(
      expect.objectContaining({ workspacePath: ROOT, cwd: WORKTREE }),
    )
    expect(onPermissionRequest).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'AskUserQuestion', workspacePath: ROOT }),
    )
  })
})
