/**
 * CursorDriver tests, in two layers.
 *
 * Most of them inject a fake {@link CursorCli}, so the driver's real
 * mint → shape → stream → settle path runs with no binary, no credential and no
 * model tokens, and the recorded spec is what the argv/env assertions read. A
 * few drive the genuine spawn path against a `#!/bin/sh` stand-in that echoes its
 * argv and prints scripted NDJSON — the only way to prove the command line and
 * stdin actually reach a child process.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CanonicalMessage, DriverStartOptions } from '../types.js'
import { CursorDriver } from './driver.js'
import type { CursorCli, CursorCliSpec, CursorMintSpec } from './cli.js'
import type { CursorEvent } from './translate.js'
import {
  CursorUnsupportedError,
  cursorCliArgs,
  cursorCliEnv,
  resolveCursorApiKey,
} from './launch.js'

// The driver resolves its binary through the launcher; the shim lets a test point
// that at a stand-in without touching the host PATH.
const launcherShim = vi.hoisted(() => ({ cursorPath: '' }))
vi.mock('../../process/launcher.js', () => ({
  resolve: (vendor: string) => launcherShim.cursorPath || vendor,
}))

const MINTED_ID = 'af58c3c7-a56e-405f-8414-d102a93aa338'

function startOpts(over: Partial<DriverStartOptions> = {}): DriverStartOptions {
  return {
    prompt: 'do the thing',
    cwd: '/ws',
    signal: new AbortController().signal,
    actionMode: 'build',
    toolGate: 'on-sensitive',
    envOverrides: { CURSOR_API_KEY: 'test-key' },
    ...over,
  }
}

async function collect(stream: AsyncIterable<CanonicalMessage>): Promise<CanonicalMessage[]> {
  const out: CanonicalMessage[] = []
  for await (const m of stream) out.push(m)
  return out
}

interface FakeCliCalls {
  minted: CursorMintSpec[]
  runs: CursorCliSpec[]
}

/**
 * A CLI that yields `frames` and then ends. `fail` makes the child report a
 * non-zero exit the way the real one does; `hang` never settles, for the abort
 * test.
 */
function fakeCli(
  frames: CursorEvent[],
  over: { fail?: Error; hang?: boolean; mintError?: Error } = {},
): { cli: CursorCli; calls: FakeCliCalls } {
  const calls: FakeCliCalls = { minted: [], runs: [] }
  const cli: CursorCli = {
    async createChat(spec) {
      calls.minted.push(spec)
      if (over.mintError) throw over.mintError
      return MINTED_ID
    },
    async *run(spec) {
      calls.runs.push(spec)
      for (const frame of frames) yield frame
      if (over.hang) {
        await new Promise<void>((resolve) => {
          spec.signal.addEventListener('abort', () => resolve(), { once: true })
        })
      }
      if (over.fail) throw over.fail
    },
  }
  return { cli, calls }
}

function systemFrame(sessionId = MINTED_ID): CursorEvent {
  return { type: 'system', subtype: 'init', session_id: sessionId, permissionMode: 'default' }
}

function assistantFrame(text: string, sessionId = MINTED_ID): CursorEvent {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    session_id: sessionId,
  }
}

function resultFrame(over: Partial<CursorEvent> = {}): CursorEvent {
  return { type: 'result', subtype: 'success', is_error: false, session_id: MINTED_ID, ...over }
}

describe('CursorDriver', () => {
  it('mints the session id before the run, so it is known without awaiting a frame', async () => {
    const { cli, calls } = fakeCli([systemFrame(), assistantFrame('hi'), resultFrame()])
    const driver = new CursorDriver(() => ({}), cli)

    const run = await driver.start(startOpts())

    // Resolved, not pending: nothing has been read off the stream yet.
    await expect(run.sessionId()).resolves.toBe(MINTED_ID)
    expect(calls.minted).toHaveLength(1)
    expect(calls.runs[0]?.argv).toContain(MINTED_ID)
  })

  it('resumes a known session without minting a new id', async () => {
    const { cli, calls } = fakeCli([resultFrame()])
    const driver = new CursorDriver(() => ({}), cli)

    const run = await driver.start(startOpts({ resume: 'existing-chat' }))

    expect(calls.minted).toHaveLength(0)
    await expect(run.sessionId()).resolves.toBe('existing-chat')
    expect(calls.runs[0]?.argv).toEqual(expect.arrayContaining(['--resume', 'existing-chat']))
  })

  it('joins assistant deltas into one block and ends the turn on the result frame', async () => {
    const { cli } = fakeCli([
      systemFrame(),
      assistantFrame('Hello '),
      assistantFrame('world'),
      resultFrame(),
    ])
    const driver = new CursorDriver(() => ({}), cli)

    const messages = await collect((await driver.start(startOpts())).messages())

    const texts = messages.flatMap((m) => m.blocks.filter((b) => b.type === 'text'))
    expect(texts).toHaveLength(1)
    expect(texts[0]).toMatchObject({ text: 'Hello world' })
  })

  it('fails the run when the result frame reports an error', async () => {
    const { cli } = fakeCli([
      systemFrame(),
      assistantFrame('partial'),
      resultFrame({ subtype: 'error_during_execution', is_error: true, message: 'model exploded' }),
    ])
    const driver = new CursorDriver(() => ({}), cli)

    const run = await driver.start(startOpts())
    await expect(collect(run.messages())).rejects.toThrow('model exploded')
  })

  it('surfaces a non-zero child exit as a run failure', async () => {
    const { cli } = fakeCli([systemFrame()], {
      fail: new Error('cursor-agent exited with code 1: boom'),
    })
    const driver = new CursorDriver(() => ({}), cli)

    const run = await driver.start(startOpts())
    await expect(collect(run.messages())).rejects.toThrow('boom')
  })

  it('settles quietly on abort rather than failing the run', async () => {
    const controller = new AbortController()
    const { cli } = fakeCli([systemFrame(), assistantFrame('working')], { hang: true })
    const driver = new CursorDriver(() => ({}), cli)

    const run = await driver.start(startOpts({ signal: controller.signal }))
    const collected = collect(run.messages())
    controller.abort()

    await expect(collected).resolves.toBeInstanceOf(Array)
  })

  it('resolves the session id even when the run dies before its first frame', async () => {
    // The upstream binder awaits sessionId() before reading messages, so a
    // sessionId that never settles would hang the whole run rather than fail it.
    const { cli } = fakeCli([], { fail: new Error('died immediately') })
    const driver = new CursorDriver(() => ({}), cli)

    const run = await driver.start(startOpts())

    await expect(run.sessionId()).resolves.toBe(MINTED_ID)
    await expect(collect(run.messages())).rejects.toThrow('died immediately')
  })

  it('turns a mint failure into an actionable error naming both credential paths', async () => {
    const { cli } = fakeCli([], { mintError: new Error('not logged in') })
    const driver = new CursorDriver(() => ({}), cli)

    await expect(driver.start(startOpts())).rejects.toBeInstanceOf(CursorUnsupportedError)
    await expect(driver.start(startOpts())).rejects.toThrow(/cursor-agent login|API key/)
  })

  it('starts without any api key, falling back to the keychain login', async () => {
    const { cli, calls } = fakeCli([resultFrame()])
    const driver = new CursorDriver(() => ({}), cli)

    const run = await driver.start(startOpts({ envOverrides: {} }))

    await expect(run.sessionId()).resolves.toBe(MINTED_ID)
    expect(calls.runs[0]?.env.CURSOR_API_KEY).toBeUndefined()
  })

  it('drops images loudly instead of failing the turn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { cli } = fakeCli([resultFrame()])
    const driver = new CursorDriver(() => ({}), cli)

    await driver.start(startOpts({ images: [{ data: 'ZmFrZQ==', mediaType: 'image/png' }] }))

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('image'))
    warn.mockRestore()
  })

  it('sends the system instruction as the prompt prefix on stdin', async () => {
    const { cli, calls } = fakeCli([resultFrame()])
    const driver = new CursorDriver(() => ({}), cli)

    await driver.start(startOpts({ systemInstruction: 'be terse' }))

    expect(calls.runs[0]?.stdin).toBe('be terse\n\ndo the thing')
  })
})

describe('cursor launch shaping', () => {
  it('always trusts the workspace, because a headless run cannot answer the prompt', () => {
    const args = cursorCliArgs(startOpts(), MINTED_ID)
    expect(args).toContain('--trust')
    expect(args).toEqual(expect.arrayContaining(['--print', '--output-format', 'stream-json']))
    expect(args).toEqual(expect.arrayContaining(['--workspace', '/ws']))
  })

  it('maps the tool gate onto auto-review versus force', () => {
    expect(cursorCliArgs(startOpts({ toolGate: 'on-sensitive' }), MINTED_ID)).toContain(
      '--auto-review',
    )
    const unattended = cursorCliArgs(startOpts({ toolGate: 'never-ask' }), MINTED_ID)
    expect(unattended).toContain('--force')
    expect(unattended).not.toContain('--auto-review')
  })

  it('maps the plan action mode onto the plan conversation mode', () => {
    expect(cursorCliArgs(startOpts({ actionMode: 'plan' }), MINTED_ID)).toEqual(
      expect.arrayContaining(['--mode', 'plan']),
    )
    expect(cursorCliArgs(startOpts({ actionMode: 'build' }), MINTED_ID)).not.toContain('--mode')
  })

  it('disables the built-in sandbox under a wrapper and enables it without one', () => {
    expect(cursorCliArgs(startOpts({ sandboxed: true }), MINTED_ID)).toEqual(
      expect.arrayContaining(['--sandbox', 'enabled']),
    )
    // arapuca has already confined the process; nesting a second sandbox fails on
    // the syscalls the outer one removed.
    expect(
      cursorCliArgs(startOpts({ sandboxed: true, sandboxWrapperPath: '/w/wrap.sh' }), MINTED_ID),
    ).toEqual(expect.arrayContaining(['--sandbox', 'disabled']))
  })

  it('passes each additional directory as its own root', () => {
    const args = cursorCliArgs(startOpts({ additionalDirectories: ['/a', '/b'] }), MINTED_ID)
    expect(args.filter((a) => a === '--add-dir')).toHaveLength(2)
    expect(args).toEqual(expect.arrayContaining(['--add-dir', '/a', '--add-dir', '/b']))
  })

  it('resolves the credential by precedence and treats absence as legal', () => {
    expect(resolveCursorApiKey({ apiKey: 'cfg' }, { CURSOR_API_KEY: 'env' })).toBe('cfg')
    expect(resolveCursorApiKey({}, { CURSOR_API_KEY: 'env' })).toBe('env')
    const saved = process.env.CURSOR_API_KEY
    delete process.env.CURSOR_API_KEY
    expect(resolveCursorApiKey({}, {})).toBeUndefined()
    if (saved !== undefined) process.env.CURSOR_API_KEY = saved
  })

  it('carries the credential into the child environment', () => {
    const env = cursorCliEnv(startOpts({ envOverrides: { CURSOR_API_KEY: 'k' } }), {})
    expect(env.CURSOR_API_KEY).toBe('k')
    // A complete environment, not a patch — spawn replaces rather than merges.
    expect(env.PATH).toBeTruthy()
  })
})

describe('CursorDriver over a real child process', () => {
  let dir = ''

  afterEach(() => {
    launcherShim.cursorPath = ''
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = ''
  })

  /** A stand-in that records how it was invoked and prints scripted frames. */
  function fakeBinary(): { path: string; argsFile: string; stdinFile: string } {
    dir = mkdtempSync(join(tmpdir(), 'c3-cursor-cli-'))
    const path = join(dir, 'cursor-agent')
    const argsFile = join(dir, 'args.txt')
    const stdinFile = join(dir, 'stdin.txt')
    writeFileSync(
      path,
      [
        '#!/bin/sh',
        `if [ "$1" = "create-chat" ]; then printf '%s\\n' '${MINTED_ID}'; exit 0; fi`,
        `printf '%s\\n' "$@" > ${argsFile}`,
        `cat > ${stdinFile}`,
        `printf '%s\\n' '{"type":"system","subtype":"init","session_id":"${MINTED_ID}"}'`,
        `printf '%s\\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]},"session_id":"${MINTED_ID}"}'`,
        `printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"${MINTED_ID}"}'`,
      ].join('\n'),
      'utf-8',
    )
    chmodSync(path, 0o755)
    return { path, argsFile, stdinFile }
  }

  it('mints an id, spawns with the shaped argv, and streams the reply', async () => {
    const bin = fakeBinary()
    launcherShim.cursorPath = bin.path

    const driver = new CursorDriver(() => ({}))
    const run = await driver.start(startOpts({ cwd: dir }))
    const messages = await collect(run.messages())

    await expect(run.sessionId()).resolves.toBe(MINTED_ID)
    const argv = readFileSync(bin.argsFile, 'utf-8').split('\n').filter(Boolean)
    expect(argv).toContain('--print')
    expect(argv).toContain('--trust')
    expect(argv).toEqual(expect.arrayContaining(['--output-format', 'stream-json']))
    expect(argv).toEqual(expect.arrayContaining(['--resume', MINTED_ID]))
    expect(readFileSync(bin.stdinFile, 'utf-8')).toBe('do the thing')
    expect(messages.flatMap((m) => m.blocks).filter((b) => b.type === 'text')).toMatchObject([
      { text: 'ok' },
    ])
  })

  it('fails the run with the child stderr when the binary is missing', async () => {
    dir = mkdtempSync(join(tmpdir(), 'c3-cursor-cli-'))
    launcherShim.cursorPath = join(dir, 'does-not-exist')
    expect(existsSync(launcherShim.cursorPath)).toBe(false)

    const driver = new CursorDriver(() => ({}))
    // The mint runs first, so a missing binary is caught before a turn is spent.
    await expect(driver.start(startOpts({ cwd: dir }))).rejects.toBeInstanceOf(
      CursorUnsupportedError,
    )
  })
})
