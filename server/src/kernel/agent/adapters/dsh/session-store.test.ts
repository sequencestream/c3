import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DshSessionStore } from './session-store.js'
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
    expect(out[0].title).toBe(out[0].sessionId)
  })

  it('decodes the path-segment escape DSH applies to session ids', async () => {
    const workspace = '/work/project'
    const dshHome = tempDshHome(workspace)
    mkdirSync(join(dshHome, 'sessions', '-work-project', 'a~002Fb'), { recursive: true })

    const out = await new DshSessionStore().list(opts(workspace))

    expect(out).toEqual([{ sessionId: 'a/b', title: 'a/b' }])
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
})
