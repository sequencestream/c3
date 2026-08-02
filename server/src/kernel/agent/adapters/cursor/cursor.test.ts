/**
 * CursorDriver tests. A fake `cursor-agent` shell script stands in for the real
 * CLI so the driver's actual spawn/readline/process-group path runs, without
 * spending model tokens.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import type { CanonicalMessage, DriverStartOptions } from '../types.js'
import { CursorDriver } from './driver.js'
import { CursorUnsupportedError, cursorExecArgs } from './launch.js'

function startOpts(over: Partial<DriverStartOptions> = {}): DriverStartOptions {
  return {
    prompt: 'do the thing',
    cwd: WORK,
    signal: new AbortController().signal,
    actionMode: 'build',
    toolGate: 'on-sensitive',
    ...over,
  }
}

async function collect(stream: AsyncIterable<CanonicalMessage>): Promise<CanonicalMessage[]> {
  const out: CanonicalMessage[] = []
  for await (const m of stream) out.push(m)
  return out
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

const dirs: string[] = []

// A real, long-lived workspace dir for the child's cwd — spawn fails with ENOENT
// (blamed on the command) when cwd does not exist. Kept OUT of `dirs` so the
// per-test cleanup never removes it mid-suite.
const WORK = mkdtempSync(join(tmpdir(), 'c3-cursor-work-'))

/**
 * Write a fake cursor-agent that prints the given lines, one per NDJSON event.
 *
 * Each line is emitted with its own single-quoted `printf`; the quotes keep the
 * JSON's braces and quotes literal. The script always ends with a newline and an
 * explicit `exit`, because a shebang script with no trailing newline is rejected
 * by the kernel with ENOEXEC.
 */
function fakeBin(lines: string[], { recordArgs }: { recordArgs?: string } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'c3-cursor-cli-'))
  dirs.push(dir)
  const path = join(dir, 'cursor-agent')
  const head = recordArgs ? [`printf '%s\\n' "$@" > ${shQuote(recordArgs)}`] : []
  const body = lines.map((l) => `printf '%s\\n' ${shQuote(l)}`)
  writeFileSync(path, ['#!/bin/sh', ...head, ...body, 'exit 0', ''].join('\n'))
  chmodSync(path, 0o755)
  return path
}

const driverFor = (bin: string, recordArgs?: string) =>
  new CursorDriver((opts) => ({
    command: opts.sandboxWrapperPath ?? bin,
    ...(recordArgs ? {} : {}),
  }))

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

afterAll(() => {
  rmSync(WORK, { recursive: true, force: true })
})

describe('CursorDriver', () => {
  it('resolves the session id from system/init and streams canonical messages', async () => {
    const bin = fakeBin([
      '{"type":"system","subtype":"init","session_id":"sid-9","model":"Auto"}',
      '{"type":"assistant","session_id":"sid-9","model_call_id":"m1","message":{"content":[{"text":"hello"}]}}',
      '{"type":"result","subtype":"success","session_id":"sid-9","is_error":false}',
    ])
    const run = await driverFor(bin).start(startOpts())
    expect(await run.sessionId()).toBe('sid-9')
    const msgs = await collect(run.messages())
    expect(msgs.some((m) => m.blocks.some((b) => b.type === 'text' && b.text === 'hello'))).toBe(
      true,
    )
  })

  it('rejects sessionId when the process exits without reporting an id', async () => {
    // No system/init frame; the CLI dies (auth error shape) before identifying.
    const bin = fakeBin([])
    const run = await driverFor(bin).start(startOpts())
    await expect(run.sessionId()).rejects.toThrow(/session id/)
    await expect(collect(run.messages())).rejects.toThrow()
  })

  it('uses the resume id immediately for a resumed run and passes --resume', async () => {
    const argsFile = join(mkdtempSync(join(tmpdir(), 'c3-cursor-args-')), 'args.txt')
    dirs.push(argsFile.replace(/\/args\.txt$/, ''))
    const bin = fakeBin(
      [
        '{"type":"system","subtype":"init","session_id":"sid-1","model":"Auto"}',
        '{"type":"result","subtype":"success","session_id":"sid-1","is_error":false}',
      ],
      { recordArgs: argsFile },
    )
    const run = await driverFor(bin).start(startOpts({ resume: 'sid-1' }))
    expect(await run.sessionId()).toBe('sid-1')
    await collect(run.messages())
    const argv = readFileSync(argsFile, 'utf-8').split('\n').filter(Boolean)
    const resumeAt = argv.indexOf('--resume')
    expect(resumeAt).toBeGreaterThanOrEqual(0)
    expect(argv[resumeAt + 1]).toBe('sid-1')
    expect(argv.at(-1)).toBe('do the thing') // prompt is last
  })

  it('fails the turn on a corrupt stream frame rather than skipping it', async () => {
    const bin = fakeBin([
      '{"type":"system","subtype":"init","session_id":"sid-2"}',
      'this is not json',
    ])
    const run = await driverFor(bin).start(startOpts())
    await expect(collect(run.messages())).rejects.toThrow(/unparseable/)
  })

  it('fails the turn on a non-zero exit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'c3-cursor-fail-'))
    dirs.push(dir)
    const bin = join(dir, 'cursor-agent')
    writeFileSync(
      bin,
      '#!/bin/sh\nprintf \'%s\\n\' \'{"type":"system","subtype":"init","session_id":"sid-3"}\'\nexit 3\n',
    )
    chmodSync(bin, 0o755)
    const run = await driverFor(bin).start(startOpts())
    await expect(collect(run.messages())).rejects.toThrow(/code 3/)
  })

  it('abort() signals the process group and the run settles without orphaning', async () => {
    // A run that would otherwise hang: emits init, then sleeps until signalled.
    const dir = mkdtempSync(join(tmpdir(), 'c3-cursor-abort-'))
    dirs.push(dir)
    const bin = join(dir, 'cursor-agent')
    writeFileSync(
      bin,
      [
        '#!/bin/sh',
        'printf \'%s\\n\' \'{"type":"system","subtype":"init","session_id":"sid-4"}\'',
        'sleep 60 &',
        'wait',
      ].join('\n'),
    )
    chmodSync(bin, 0o755)
    const run = await driverFor(bin).start(startOpts())
    expect(await run.sessionId()).toBe('sid-4')
    const done = collect(run.messages())
    run.abort()
    // Must settle (not hang) once the group is signalled.
    await expect(done).resolves.toBeInstanceOf(Array)
  })

  it('refuses a plan run rather than downgrading to a writable one', async () => {
    const bin = fakeBin([])
    await expect(driverFor(bin).start(startOpts({ actionMode: 'plan' }))).rejects.toBeInstanceOf(
      CursorUnsupportedError,
    )
  })
})

describe('cursorExecArgs', () => {
  it('forces all tools when the gate is never-ask and approves injected MCP', () => {
    const argv = cursorExecArgs(
      startOpts({
        toolGate: 'never-ask',
        mcpServers: { c3: { type: 'http', url: 'http://127.0.0.1:1/mcp' } },
      }),
      { command: 'cursor-agent' },
    )
    expect(argv).toContain('--force')
    expect(argv).toContain('--approve-mcps')
    expect(argv).toContain('--trust')
  })

  it('omits --force under the default sensitive gate', () => {
    const argv = cursorExecArgs(startOpts(), { command: 'cursor-agent' })
    expect(argv).not.toContain('--force')
  })

  it('throws for plan action mode', () => {
    expect(() =>
      cursorExecArgs(startOpts({ actionMode: 'plan' }), { command: 'cursor-agent' }),
    ).toThrow(CursorUnsupportedError)
  })
})
