/**
 * CodexSessionStore behaviour + the run-end title-backfill regression (codex
 * "New session" fix). Hermetic: a temp `~/.codex/sessions/<Y>/<M>/<D>/*.jsonl`
 * tree is written to disk and `os.homedir` is pointed at it, so no codex process
 * spawns. Covers title derivation from BOTH on-disk formats, cwd filtering, and —
 * crucially — that a codex-inclusive {@link SessionAccessor} surfaces a real
 * (non-"New session") title under the exact shape the `onRunEnd` hook matches on
 * (`vendor === 'codex'` + `vendorExtra.vendorSessionId === realId`). Before the
 * fix, codex was excluded from the accessor wired into `onRunEnd`, so its title
 * stayed "New session" forever.
 *
 * Fixtures are RAW JSON strings (kernel/ bans JSON.stringify — ADR-0009 R2);
 * every fixture's text is plain ASCII with no quotes, so interpolation is safe.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CodexSessionStore } from './session-store.js'
import { SessionAccessor } from '../../session/accessor.js'

let tmpHome: string

/** The mandatory first line of a codex session JSONL. */
function metaLine(sessionId: string, cwd: string): string {
  return `{"type":"session_meta","payload":{"id":"${sessionId}","cwd":"${cwd}"}}`
}

/** Codex-native user prompt frame (format 1). */
function userMessage(text: string): string {
  return `{"type":"event_msg","payload":{"type":"user_message","message":"${text}"}}`
}

/** Claude-style system-generated context frame (format 2). */
function responseItemUser(text: string): string {
  return `{"type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"${text}"}]}}`
}

function responseItemAssistant(text: string): string {
  return `{"type":"response_item","payload":{"role":"assistant","content":[{"type":"output_text","text":"${text}"}]}}`
}

/** Codex-native agent reply frame (format 1) — paired with responseItemAssistant on disk. */
function agentMessage(text: string): string {
  return `{"type":"event_msg","payload":{"type":"agent_message","message":"${text}"}}`
}

function responseItemCommand(id: string, command: string, output: string): string {
  return `{"type":"response_item","payload":{"id":"${id}","type":"command_execution","command":"${command}","status":"completed","aggregated_output":"${output}","exit_code":0}}`
}

/** Real on-disk shell call (format 1) — arguments is a JSON STRING with a `cmd` key. */
function functionCallShell(callId: string, cmd: string): string {
  const args = `{\\"cmd\\":\\"${cmd}\\",\\"workdir\\":\\"/work\\"}`
  return `{"type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"${args}","call_id":"${callId}"}}`
}

/** Real on-disk apply_patch call — a `custom_tool_call` whose `input` is the raw patch. */
function customToolCallPatch(callId: string, patch: string, status: string): string {
  return `{"type":"response_item","payload":{"type":"custom_tool_call","status":"${status}","call_id":"${callId}","name":"apply_patch","input":"${patch}"}}`
}

/** The result line paired to a function/custom tool call by `call_id`. */
function toolCallOutput(callId: string, output: string, custom = false): string {
  const t = custom ? 'custom_tool_call_output' : 'function_call_output'
  return `{"type":"response_item","payload":{"type":"${t}","call_id":"${callId}","output":"${output}"}}`
}

/**
 * Write a codex session JSONL into the temp home under today's date dir (so it
 * falls inside `list`'s recent-days scan window). `lines` are raw post-meta
 * transcript lines; the `session_meta` first line is synthesised from id + cwd.
 */
function writeSession(sessionId: string, cwd: string, lines: string[]): void {
  const d = new Date()
  const yyyy = String(d.getFullYear())
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const dir = path.join(tmpHome, '.codex', 'sessions', yyyy, mm, dd)
  mkdirSync(dir, { recursive: true })
  const body = [metaLine(sessionId, cwd), ...lines].join('\n') + '\n'
  writeFileSync(path.join(dir, `${sessionId}.jsonl`), body, 'utf-8')
}

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(os.tmpdir(), 'c3-codex-sess-'))
  vi.spyOn(os, 'homedir').mockReturnValue(tmpHome)
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(tmpHome, { recursive: true, force: true })
})

describe('CodexSessionStore.list — title derivation', () => {
  it('derives the title from a codex-native user_message (format 1)', async () => {
    const cwd = '/work/proj'
    writeSession('sess-a', cwd, [userMessage('Fix the login bug')])
    const out = await new CodexSessionStore().list({ cwd })
    expect(out).toHaveLength(1)
    expect(out[0].sessionId).toBe('sess-a')
    expect(out[0].title).toBe('Fix the login bug')
  })

  it('derives the title from a response_item role=user (format 2)', async () => {
    const cwd = '/work/proj'
    writeSession('sess-b', cwd, [responseItemUser('Add a dark mode toggle')])
    const out = await new CodexSessionStore().list({ cwd })
    expect(out[0].title).toBe('Add a dark mode toggle')
  })

  it('prefers the native user_message over an AGENTS.md block written before it', async () => {
    // Reproduces the real on-disk order: c3 injects the AGENTS.md instructions
    // (format 2) BEFORE the user's actual prompt (format 1). The title must be
    // the prompt, not the AGENTS.md blob.
    const cwd = '/work/proj'
    writeSession('sess-agents', cwd, [
      responseItemUser('# AGENTS.md instructions for /work/proj <INSTRUCTIONS> ## What'),
      responseItemUser('Refactor the parser'),
      userMessage('Refactor the parser'),
    ])
    const out = await new CodexSessionStore().list({ cwd })
    expect(out[0].title).toBe('Refactor the parser')
  })

  it('skips an injected AGENTS.md block when only format-2 lines exist', async () => {
    const cwd = '/work/proj'
    writeSession('sess-f2', cwd, [
      responseItemUser('# AGENTS.md instructions for /work/proj <INSTRUCTIONS> ## What'),
      responseItemUser('Add a dark mode toggle'),
    ])
    const out = await new CodexSessionStore().list({ cwd })
    expect(out[0].title).toBe('Add a dark mode toggle')
  })

  it('falls back to "New session" when no user prompt exists', async () => {
    const cwd = '/work/proj'
    writeSession('sess-c', cwd, [
      `{"type":"event_msg","payload":{"type":"agent_message","message":"hello"}}`,
    ])
    const out = await new CodexSessionStore().list({ cwd })
    expect(out[0].title).toBe('New session')
  })

  it('truncates a long prompt to 120 chars', async () => {
    const cwd = '/work/proj'
    const long = 'x'.repeat(300)
    writeSession('sess-d', cwd, [userMessage(long)])
    const out = await new CodexSessionStore().list({ cwd })
    expect(out[0].title).toHaveLength(120)
  })

  it('only returns sessions whose cwd matches the requested workspace', async () => {
    writeSession('mine', '/work/proj', [userMessage('keep me')])
    writeSession('other', '/work/elsewhere', [userMessage('drop me')])
    const out = await new CodexSessionStore().list({ cwd: '/work/proj' })
    expect(out.map((s) => s.sessionId)).toEqual(['mine'])
  })
})

describe('CodexSessionStore.read — history replay', () => {
  it('replays user, assistant, and command execution frames as canonical messages', async () => {
    const cwd = '/work/proj'
    writeSession('sess-history', cwd, [
      userMessage('Fix the login bug'),
      responseItemAssistant('I will inspect the auth flow.'),
      responseItemCommand('cmd-1', 'pnpm test', 'ok'),
    ])

    const out = await new CodexSessionStore().read('sess-history', { cwd })

    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant'])
    expect(out[0].blocks[0]).toMatchObject({ type: 'text', text: 'Fix the login bug' })
    expect(out[1].blocks[0]).toMatchObject({
      type: 'text',
      text: 'I will inspect the auth flow.',
    })
    expect(out[2]).toMatchObject({ preApproved: true })
    expect(out[2].blocks[0]).toMatchObject({
      type: 'tool_use',
      id: 'cmd-1',
      name: 'shell',
      input: { command: 'pnpm test' },
      result: { content: 'ok', isError: false },
    })
  })

  it('does not replay a message twice when it is persisted in both on-disk formats', async () => {
    // Real codex rollout files write every user/agent text message TWICE: once as
    // a native event_msg and once as a response_item transcript entry. Replaying
    // both showed each message twice — the bug this guards against.
    const cwd = '/work/proj'
    writeSession('sess-dup', cwd, [
      responseItemUser('# AGENTS.md instructions for /work/proj <INSTRUCTIONS>'),
      responseItemUser('Fix the login bug'),
      userMessage('Fix the login bug'),
      agentMessage('I will inspect the auth flow.'),
      responseItemAssistant('I will inspect the auth flow.'),
    ])

    const out = await new CodexSessionStore().read('sess-dup', { cwd })

    // Exactly one user + one assistant message; the injected AGENTS.md block and
    // both event_msg duplicates are gone.
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(out[0].blocks[0]).toMatchObject({ type: 'text', text: 'Fix the login bug' })
    expect(out[1].blocks[0]).toMatchObject({ type: 'text', text: 'I will inspect the auth flow.' })
  })

  it('renders real on-disk function_call/custom_tool_call as tool_use blocks with paired results', async () => {
    // Real codex rollout files record tool calls as `function_call` (exec_command)
    // and `custom_tool_call` (apply_patch), with the result on a SEPARATE
    // `*_output` line keyed by call_id. They must surface as tool_use blocks whose
    // names match the live driver ('shell' / 'apply_patch').
    const cwd = '/work/proj'
    writeSession('sess-tools', cwd, [
      userMessage('Run the tests'),
      functionCallShell('call-1', 'pnpm test'),
      toolCallOutput('call-1', 'exit code 0'),
      customToolCallPatch('call-2', '*** Begin Patch ... *** End Patch', 'completed'),
      toolCallOutput('call-2', 'patch applied', true),
    ])

    const out = await new CodexSessionStore().read('sess-tools', { cwd })

    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant'])
    expect(out[1]).toMatchObject({ preApproved: true })
    expect(out[1].blocks[0]).toMatchObject({
      type: 'tool_use',
      id: 'call-1',
      name: 'shell',
      input: { command: 'pnpm test' },
      result: { content: 'exit code 0', isError: false },
    })
    expect(out[2].blocks[0]).toMatchObject({
      type: 'tool_use',
      id: 'call-2',
      name: 'apply_patch',
      input: { patch: '*** Begin Patch ... *** End Patch' },
      result: { content: 'patch applied', isError: false },
    })
  })

  it('marks a failed custom_tool_call result as an error', async () => {
    const cwd = '/work/proj'
    writeSession('sess-tool-fail', cwd, [
      customToolCallPatch('call-x', '*** Begin Patch', 'failed'),
      toolCallOutput('call-x', 'apply_patch verification failed', true),
    ])
    const out = await new CodexSessionStore().read('sess-tool-fail', { cwd })
    expect(out[0].blocks[0]).toMatchObject({
      type: 'tool_use',
      name: 'apply_patch',
      result: { content: 'apply_patch verification failed', isError: true },
    })
  })

  it('keeps a native event_msg prompt that has no response_item counterpart', async () => {
    // Defensive: when a text lives ONLY in the native event_msg (no matching
    // response_item), it must still surface rather than be dropped.
    const cwd = '/work/proj'
    writeSession('sess-native-only', cwd, [
      userMessage('Only native prompt'),
      responseItemAssistant('A reply.'),
    ])

    const out = await new CodexSessionStore().read('sess-native-only', { cwd })

    expect(out.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(out[0].blocks[0]).toMatchObject({ type: 'text', text: 'Only native prompt' })
  })

  it('returns an empty history for a missing session or mismatched cwd', async () => {
    writeSession('sess-history', '/work/proj', [userMessage('Keep me')])
    const store = new CodexSessionStore()

    await expect(store.read('missing', { cwd: '/work/proj' })).resolves.toEqual([])
    await expect(store.read('sess-history', { cwd: '/work/elsewhere' })).resolves.toEqual([])
  })
})

describe('run-end title backfill — codex via SessionAccessor (regression)', () => {
  it('surfaces a real codex title under the shape onRunEnd matches on', async () => {
    const cwd = '/work/proj'
    const realId = 'codex-thread-1'
    writeSession(realId, cwd, [userMessage('Refactor the parser')])

    // The title-backfill accessor includes codex (unlike the list/janitor one).
    const accessor = new SessionAccessor([{ vendor: 'codex', sessions: new CodexSessionStore() }])
    const summaries = await accessor.list({ cwd })

    // Mirror the exact predicate in server.ts `setOnRunEnd`.
    const hit = summaries.find(
      (s) => s.vendor === 'codex' && s.vendorExtra?.vendorSessionId === realId,
    )
    expect(hit).toBeDefined()
    expect(hit?.title).toBe('Refactor the parser')
    // The fix's acceptance bar: the hook only adopts a non-placeholder title.
    expect(hit?.title).not.toBe('New session')
  })

  it('leaves the placeholder in place when the transcript has no user prompt', async () => {
    const cwd = '/work/proj'
    const realId = 'codex-thread-2'
    writeSession(realId, cwd, [`{"type":"event_msg","payload":{"type":"token_count","total":10}}`])
    const accessor = new SessionAccessor([{ vendor: 'codex', sessions: new CodexSessionStore() }])
    const hit = (await accessor.list({ cwd })).find(
      (s) => s.vendorExtra?.vendorSessionId === realId,
    )
    // Hook guards on `title !== 'New session'`, so this correctly does NOT overwrite.
    expect(hit?.title).toBe('New session')
  })
})
