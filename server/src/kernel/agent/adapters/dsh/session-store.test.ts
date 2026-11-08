import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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
