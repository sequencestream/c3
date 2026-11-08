import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { decodeDshSessionLog } from './session-log.js'
import { DshSessionStore, dshSessionTitle } from './session-store.js'
import { hostDshHome } from '../../../config/workspace-path.js'
import type { SessionListOptions } from '../types.js'

/**
 * The reader must follow DSH's own JSONL layout
 * (`$DSH_HOME/sessions/<project key>/<escaped session id>/`), not a path guess:
 * a store that scans the wrong directory silently reports zero sessions.
 */
const dirs: string[] = []
const savedC3Dir = process.env.C3_DIR

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  if (savedC3Dir === undefined) delete process.env.C3_DIR
  else process.env.C3_DIR = savedC3Dir
})

/** A temp c3 home plus the DSH home a run in `workspace` would write to. */
function tempDshHome(workspace: string): string {
  const root = mkdtempSync(join(tmpdir(), 'c3-dsh-store-'))
  dirs.push(root)
  process.env.C3_DIR = root
  const dshHome = hostDshHome(workspace)
  // Never write outside the temp home if some other override won.
  expect(dshHome.startsWith(root)).toBe(true)
  return dshHome
}

const opts = (cwd: string): SessionListOptions => ({ cwd })

describe('DshSessionStore', () => {
  it("lists the sessions under the project directory of DSH's sessions root", async () => {
    const workspace = '/work/project'
    const dshHome = tempDshHome(workspace)
    mkdirSync(join(dshHome, 'sessions', '-work-project', '1e6a-4c8f'), { recursive: true })
    mkdirSync(join(dshHome, 'sessions', '-work-project', '2b7c-90de'), { recursive: true })

    const out = await new DshSessionStore().list(opts(workspace))

    expect(out.map((s) => s.sessionId).sort()).toEqual(['1e6a-4c8f', '2b7c-90de'])
    expect(out[0].title).toBe('New session')
    expect(typeof out[0].vendorExtra?.lastModified).toBe('number')
  })

  it('decodes the path-segment escape DSH applies to session ids', async () => {
    const workspace = '/work/project'
    const dshHome = tempDshHome(workspace)
    mkdirSync(join(dshHome, 'sessions', '-work-project', 'a~002Fb'), { recursive: true })

    const out = await new DshSessionStore().list(opts(workspace))

    expect(out.map((s) => s.sessionId)).toEqual(['a/b'])
    expect(out[0].title).toBe('New session')
  })

  it('treats a workspace with no sessions root as empty', async () => {
    const workspace = '/work/untouched'
    tempDshHome(workspace)

    await expect(new DshSessionStore().list(opts(workspace))).resolves.toEqual([])
  })

  it('does not turn loose files into sessions', async () => {
    const workspace = '/work/project'
    const dshHome = tempDshHome(workspace)
    const root = join(dshHome, 'sessions')
    mkdirSync(join(root, '-work-project', 'kept'), { recursive: true })
    writeFileSync(join(root, 'README'), 'not a session')
    writeFileSync(join(root, '-work-project', 'stray'), 'not a session either')

    const out = await new DshSessionStore().list(opts(workspace))

    expect(out.map((s) => s.sessionId)).toEqual(['kept'])
  })

  it('reads a generated title from the projection cache', async () => {
    const workspace = '/work/project'
    const dshHome = tempDshHome(workspace)
    const sessionId = '1e6a-4c8f'
    mkdirSync(join(dshHome, 'sessions', '-work-project', sessionId), { recursive: true })
    writeProjection(dshHome, sessionId, {
      title: 'Refactor the parser',
      first: 'please refactor the parser and add tests',
      lastMessageTime: 999,
    })

    const out = await new DshSessionStore().list(opts(workspace))

    expect(out).toEqual([
      {
        sessionId,
        title: 'Refactor the parser',
        vendorExtra: { lastModified: 999, cwd: workspace },
      },
    ])
  })

  it('uses the first user message when the stored title is only a slice of it', async () => {
    const workspace = '/work/project'
    const dshHome = tempDshHome(workspace)
    const sessionId = '2b7c-90de'
    mkdirSync(join(dshHome, 'sessions', '-work-project', sessionId), { recursive: true })
    writeProjection(dshHome, sessionId, {
      title: '帮我分析下最近的一些修改，',
      first: '帮我分析下最近的一些修改，是不是存在bug？',
    })

    const out = await new DshSessionStore().list(opts(workspace))

    expect(out[0].title).toBe('帮我分析下最近的一些修改，是不是存在bug？')
  })
})

describe('dshSessionTitle', () => {
  it('prefers a summary that is not a leading slice of the first message', () => {
    expect(
      dshSessionTitle(
        cache({
          title: 'Fix the login bug',
          first: 'the login page throws when the token expires',
        }),
      ),
    ).toBe('Fix the login bug')
  })

  it('falls back to the first user message when no accepted title exists', () => {
    expect(dshSessionTitle(cache({ first: 'hello there' }))).toBe('hello there')
  })

  it('ignores a placeholder accepted title', () => {
    expect(dshSessionTitle(cache({ title: 'New session', first: 'hello' }))).toBe('hello')
  })

  it('clamps a long first message', () => {
    const first = 'a'.repeat(200)
    expect(dshSessionTitle(cache({ first }))).toBe('a'.repeat(120))
  })

  it('stays on the placeholder when the cache has no name', () => {
    expect(dshSessionTitle(null)).toBe('New session')
    expect(dshSessionTitle({ record: { rows: {} } })).toBe('New session')
  })
})

describe('DshSessionStore.read', () => {
  it('replays the human prompt, assistant text, and paired tool results', async () => {
    const workspace = '/work/project'
    const dshHome = tempDshHome(workspace)
    writeLog(dshHome, 'sess-1', CURRENT_LOG, false)

    const out = await new DshSessionStore().read('sess-1', opts(workspace))

    expect(out.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'assistant',
      'assistant',
      'assistant',
    ])
    expect(out[0].blocks).toMatchObject([{ type: 'text', text: 'hello' }])
    expect(out[1].blocks).toMatchObject([{ type: 'text', text: 'hi' }])
    expect(out[2].blocks[0]).toMatchObject({
      type: 'tool_use',
      id: 'dsh-4',
      name: 'read',
      input: { path: 'a.ts' },
      result: { content: 'file body', isError: false },
    })
    expect(out[3].blocks[0]).toMatchObject({
      type: 'tool_use',
      id: 'dsh-6',
      name: 'read',
      input: { path: 'b.ts' },
      result: { content: 'second', isError: true },
    })
    expect(out[4].blocks).toMatchObject([{ type: 'text', text: 'done' }])
    const visible = out.flatMap((message) =>
      message.blocks.flatMap((block) => {
        if (block.type === 'text') return [block.text]
        if (block.type === 'tool_use') return [block.name]
        return []
      }),
    )
    expect(visible).not.toContain('catalog')
    expect(visible).not.toContain('think')
    expect(visible).not.toContain('replaced')
  })

  it('decodes every compressed frame, including when one decompress stops at the first', () => {
    const header = '{"type":"session","version":4,"id":"s"}\n'
    const body =
      '{"type":"user/message","seq":1,"time":1,"surfaceOp":"append","data":{"role":"user","source":{"kind":"user"},"content":[{"type":"text","text":"weather"}]}}\n'
    const file = Buffer.concat([
      zstdCompressSync(Buffer.from(header)),
      zstdCompressSync(Buffer.from(body)),
    ])
    let calls = 0
    const text = decodeDshSessionLog(file, true, (frame) => {
      calls += 1
      return zstdDecompressSync(frame)
    })
    expect(calls).toBe(2)
    expect(text).toContain('weather')
  })

  it('reads a zstd log and keeps complete frames when the tail is torn', async () => {
    const workspace = '/work/project'
    const dshHome = tempDshHome(workspace)
    const sessionId = 'sess-zstd'
    const dir = join(dshHome, 'sessions', '-work-project', sessionId)
    mkdirSync(dir, { recursive: true })
    const frame = zstdCompressSync(Buffer.from(CURRENT_LOG))
    writeFileSync(
      join(dir, 'session.v4.jsonl.zstd'),
      Buffer.concat([frame, Buffer.from([1, 2, 3])]),
    )

    const out = await new DshSessionStore().read(sessionId, opts(workspace))

    expect(out[0].blocks).toMatchObject([{ type: 'text', text: 'hello' }])
    expect(out).toHaveLength(5)
  })

  it('prefers the highest generation over an older log', async () => {
    const workspace = '/work/project'
    const dshHome = tempDshHome(workspace)
    const sessionId = 'sess-gen'
    const dir = join(dshHome, 'sessions', '-work-project', sessionId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.v1.jsonl'), olderLog('from v1'))
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(CURRENT_LOG)))

    const out = await new DshSessionStore().read(sessionId, opts(workspace))

    expect(out[0].blocks).toMatchObject([{ type: 'text', text: 'hello' }])
  })

  it('returns nothing for a pre-current log, a missing session, or a corrupt file', async () => {
    const workspace = '/work/project'
    const dshHome = tempDshHome(workspace)
    writeLog(dshHome, 'old', olderLog('stale'), false)
    const broken = join(dshHome, 'sessions', '-work-project', 'broken')
    mkdirSync(broken, { recursive: true })
    writeFileSync(join(broken, 'session.v4.jsonl.zstd'), Buffer.from('not a frame'))
    const store = new DshSessionStore()

    await expect(store.read('old', opts(workspace))).resolves.toEqual([])
    await expect(store.read('missing', opts(workspace))).resolves.toEqual([])
    await expect(store.read('broken', opts(workspace))).resolves.toEqual([])
  })

  it('finds a session whose id was path-escaped', async () => {
    const workspace = '/work/project'
    const dshHome = tempDshHome(workspace)
    const dir = join(dshHome, 'sessions', '-work-project', 'a~002Fb')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.v4.jsonl'), CURRENT_LOG)

    const out = await new DshSessionStore().read('a/b', opts(workspace))

    expect(out[0].sessionId).toBe('a/b')
    expect(out[0].blocks).toMatchObject([{ type: 'text', text: 'hello' }])
  })
})

function cache(input: { title?: string; first?: string }): unknown {
  return {
    record: {
      rows: {
        ...(input.title !== undefined ? { title: { val: input.title } } : {}),
        ...(input.first !== undefined
          ? { titleInput: { val: { first: { text: input.first } } } }
          : {}),
      },
    },
  }
}

function writeProjection(
  dshHome: string,
  sessionId: string,
  input: { title?: string; first?: string; lastMessageTime?: number },
): void {
  const dir = join(dshHome, 'storages', 'session_projcache', 'sessions')
  mkdirSync(dir, { recursive: true })
  const rows: string[] = []
  if (input.title !== undefined) rows.push(`"title":{"val":${quote(input.title)}}`)
  if (input.first !== undefined) {
    rows.push(`"titleInput":{"val":{"first":{"text":${quote(input.first)}}}}`)
  }
  if (input.lastMessageTime !== undefined) {
    rows.push(`"timeContext":{"val":{"lastMessageTime":${input.lastMessageTime}}}`)
  }
  writeFileSync(join(dir, `${sessionId}.json`), `{"record":{"rows":{${rows.join(',')}}}}`)
}

function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** Current-format log: injected context, a replacement, reasoning, and two steps that reuse `call_00`. */
const CURRENT_LOG = [
  '{"type":"session","version":4,"id":"s1","createdAt":1,"isSeeded":false,"delegationDepth":0}',
  '{"type":"user/message","seq":1,"time":10,"surfaceOp":"append","data":{"role":"user","id":"u0","source":{"kind":"skill-catalog"},"content":[{"type":"text","text":"catalog"}]}}',
  '{"type":"user/message","seq":2,"time":11,"surfaceOp":"append","data":{"role":"user","id":"u1","source":{"kind":"user"},"content":[{"type":"text","text":"hello"}]}}',
  '{"type":"assistant/message","seq":3,"time":12,"surfaceOp":"append","data":{"turn":1,"step":1,"stream":[],"message":{"role":"assistant","content":[{"type":"reasoning","text":"think"},{"type":"text","text":"hi"},{"type":"tool-call","id":"call_00","name":"read","arguments":"{\\"path\\":\\"a.ts\\"}"}]}}}',
  '{"type":"tool/call","seq":4,"time":13,"data":{"turn":1,"step":1,"callId":"call_00","name":"read","arguments":"{\\"path\\":\\"a.ts\\"}"}}',
  '{"type":"tool/result","seq":5,"time":14,"surfaceOp":"append","data":{"turn":1,"step":1,"message":{"role":"tool","toolCallId":"call_00","isError":false,"content":[{"type":"text","text":"file body"}]}}}',
  '{"type":"tool/call","seq":6,"time":15,"data":{"turn":1,"step":2,"callId":"call_00","name":"read","arguments":"{\\"path\\":\\"b.ts\\"}"}}',
  '{"type":"tool/result","seq":7,"time":16,"surfaceOp":"append","data":{"turn":1,"step":2,"message":{"role":"tool","toolCallId":"call_00","isError":true,"content":[{"type":"text","text":"second"}]}}}',
  '{"type":"assistant/message","seq":8,"time":17,"surfaceOp":"append","data":{"message":{"content":[{"type":"text","text":"done"}]}}}',
  '{"type":"user/message","seq":9,"time":18,"surfaceOp":{"op":"replace","startSeq":2,"endSeq":2},"data":{"role":"user","id":"u2","source":{"kind":"user"},"content":[{"type":"text","text":"replaced"}]}}',
  '',
].join('\n')

function olderLog(text: string): string {
  return [
    '{"type":"session","version":3,"id":"s1","createdAt":1}',
    `{"type":"user/message","seq":1,"time":1,"surfaceOp":"append","data":{"role":"user","source":{"kind":"user"},"content":[{"type":"text","text":"${text}"}]}}`,
    '',
  ].join('\n')
}

function writeLog(dshHome: string, sessionId: string, body: string, compressed: boolean): void {
  const dir = join(dshHome, 'sessions', '-work-project', sessionId)
  mkdirSync(dir, { recursive: true })
  const name = compressed ? 'session.v4.jsonl.zstd' : 'session.v4.jsonl'
  const payload = compressed ? zstdCompressSync(Buffer.from(body)) : body
  writeFileSync(join(dir, name), payload)
}
