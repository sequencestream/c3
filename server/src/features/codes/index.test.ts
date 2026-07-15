import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { CodeGitStatus, ServerToClient } from '@ccc/shared/protocol'
import type { Conn } from '../../transport/handler-registry.js'

const h = vi.hoisted(() => ({
  roots: new Map<string, string>(),
}))

vi.mock('../../state.js', () => ({
  resolveWorkspaceRoot: vi.fn((id: string) => h.roots.get(id) ?? null),
}))

import {
  compilePatterns,
  getCodeGitStatusHandler,
  listDirHandler,
  readFileHandler,
  resolveCodePath,
  searchCodesHandler,
  SEARCH_RESULT_LIMIT,
  SEARCH_TIMEOUT_MS,
} from './index.js'

let tmpRoot: string
let workspace: string

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'c3-codes-'))
  workspace = join(tmpRoot, 'workspace')
  await mkdir(workspace, { recursive: true })
  h.roots.clear()
  h.roots.set('ws-1', workspace)
})

afterEach(async () => {
  vi.restoreAllMocks()
  h.roots.clear()
  await rm(tmpRoot, { recursive: true, force: true })
})

function capture(): { conn: Conn; sent: ServerToClient[] } {
  const sent: ServerToClient[] = []
  return {
    sent,
    conn: {
      send: (m) => sent.push(m),
      deliver: () => {},
      sendWorkspaces: () => {},
      sendSessions: async () => {},
      viewing: null,
      authed: true,
      authToken: 'tok',
      subject: null,
    },
  }
}

const KCTX = {} as never

describe('codes path guard', () => {
  it('rejects unregistered workspace ids instead of treating them as roots', async () => {
    const got = await resolveCodePath('/Users/example/.ssh', '')
    expect(got).toEqual({
      ok: false,
      error: { code: 'workspace.unknown', path: '/Users/example/.ssh' },
    })
  })

  it('rejects absolute, parent traversal, .git, and null-byte relative paths', async () => {
    await expect(resolveCodePath('ws-1', '/etc/passwd')).resolves.toMatchObject({
      ok: false,
      error: { code: 'codes.invalidPath' },
    })
    await expect(resolveCodePath('ws-1', 'C:\\Users\\x')).resolves.toMatchObject({
      ok: false,
      error: { code: 'codes.invalidPath' },
    })
    await expect(resolveCodePath('ws-1', '\\\\server\\share')).resolves.toMatchObject({
      ok: false,
      error: { code: 'codes.invalidPath' },
    })
    await expect(resolveCodePath('ws-1', '../../etc/passwd')).resolves.toMatchObject({
      ok: false,
      error: { code: 'codes.invalidPath' },
    })
    await expect(resolveCodePath('ws-1', '.git/config')).resolves.toMatchObject({
      ok: false,
      error: { code: 'codes.invalidPath' },
    })
    await expect(resolveCodePath('ws-1', 'a\0b')).resolves.toMatchObject({
      ok: false,
      error: { code: 'codes.invalidPath' },
    })
  })

  it('rejects symlink escapes and sibling-prefix confusion', async () => {
    const evil = join(tmpRoot, 'workspace-evil')
    await mkdir(evil)
    await writeFile(join(evil, 'secret.txt'), 'secret')
    await symlink(evil, join(workspace, 'link-out'))

    const got = await resolveCodePath('ws-1', 'link-out/secret.txt')
    expect(got).toMatchObject({ ok: false, error: { code: 'codes.invalidPath' } })
  })

  it('accepts normal workspace-relative paths', async () => {
    await mkdir(join(workspace, 'src'))
    await writeFile(join(workspace, 'src', 'index.ts'), 'export {}\n')
    const got = await resolveCodePath('ws-1', 'src/index.ts')
    expect(got).toMatchObject({ ok: true, rel: 'src/index.ts' })
  })
})

describe('codes handlers', () => {
  it('lists root and child directories, excluding .git', async () => {
    await mkdir(join(workspace, 'src'))
    await mkdir(join(workspace, '.git'))
    await writeFile(join(workspace, 'README.md'), 'hello')
    const { conn, sent } = capture()

    await listDirHandler(KCTX, conn, { type: 'list_dir', workspaceId: 'ws-1', rel: '' })

    expect(sent[0]).toEqual({
      type: 'dir_listed',
      workspaceId: 'ws-1',
      rel: '',
      entries: [
        { name: 'src', path: 'src', type: 'directory' },
        { name: 'README.md', path: 'README.md', type: 'file' },
      ],
    })
  })

  it('reads text files', async () => {
    await writeFile(join(workspace, 'a.ts'), 'const x = 1\n')
    const { conn, sent } = capture()

    await readFileHandler(KCTX, conn, { type: 'read_file', workspaceId: 'ws-1', rel: 'a.ts' })

    expect(sent[0]).toEqual({
      type: 'file_read',
      workspaceId: 'ws-1',
      file: { path: 'a.ts', size: 12, binary: false, truncated: false, content: 'const x = 1\n' },
    })
  })

  it('returns metadata only for binary and oversized files', async () => {
    await writeFile(join(workspace, 'bin.dat'), Buffer.from([0, 1, 2]))
    await writeFile(join(workspace, 'large.txt'), 'x'.repeat(1024 * 1024 + 1))
    const { conn, sent } = capture()

    await readFileHandler(KCTX, conn, { type: 'read_file', workspaceId: 'ws-1', rel: 'bin.dat' })
    await readFileHandler(KCTX, conn, { type: 'read_file', workspaceId: 'ws-1', rel: 'large.txt' })

    expect(sent[0]).toEqual({
      type: 'file_read',
      workspaceId: 'ws-1',
      file: { path: 'bin.dat', size: 3, binary: true, truncated: false },
    })
    expect(sent[1]).toEqual({
      type: 'file_read',
      workspaceId: 'ws-1',
      file: { path: 'large.txt', size: 1024 * 1024 + 1, binary: false, truncated: true },
    })
  })

  it('searches filenames and content without returning .git results', async () => {
    await mkdir(join(workspace, 'src'))
    await mkdir(join(workspace, '.git'))
    await writeFile(join(workspace, 'src', 'target.ts'), 'needle here\n')
    await writeFile(join(workspace, '.git', 'target-secret'), 'needle hidden\n')
    const { conn, sent } = capture()

    await searchCodesHandler(KCTX, conn, {
      type: 'search_codes',
      workspaceId: 'ws-1',
      query: 'target',
      mode: 'filename',
    })
    await searchCodesHandler(KCTX, conn, {
      type: 'search_codes',
      workspaceId: 'ws-1',
      query: 'needle',
      mode: 'content',
    })

    expect(sent[0]).toMatchObject({
      type: 'codes_searched',
      hits: [{ path: 'src/target.ts', type: 'file', match: 'target.ts' }],
      truncated: false,
      timedOut: false,
    })
    expect(sent[1]).toMatchObject({
      type: 'codes_searched',
      hits: [{ path: 'src/target.ts', type: 'file', line: 1, lineText: 'needle here' }],
      truncated: false,
      timedOut: false,
    })
    expect(JSON.stringify(sent)).not.toContain('.git')
  })

  it('matches a query as a case-insensitive basename substring across hyphens and extension', async () => {
    await mkdir(join(workspace, 'doc'))
    await mkdir(join(workspace, '.git'))
    await writeFile(join(workspace, 'doc', 'sandbox-architecture.md'), '# sandbox\n')
    await writeFile(join(workspace, 'doc', 'unrelated.txt'), 'other\n')
    // Same-named file hidden under .git must never surface.
    await writeFile(join(workspace, '.git', 'sandbox-architecture.md'), '# hidden\n')

    async function search(query: string, pattern?: string) {
      const { conn, sent } = capture()
      await searchCodesHandler(KCTX, conn, {
        type: 'search_codes',
        workspaceId: 'ws-1',
        query,
        mode: 'filename',
        ...(pattern ? { pattern } : {}),
      })
      return (sent[0] as Extract<ServerToClient, { type: 'codes_searched' }>).hits
    }

    // Leading fragment, mixed case, and a fragment straddling the hyphen all hit,
    // and the hit carries the FULL basename as `match`.
    for (const q of ['sandbox', 'SANDBOX', 'box-architecture', 'architecture', '.md']) {
      const hits = await search(q)
      expect(hits).toEqual([
        { path: 'doc/sandbox-architecture.md', type: 'file', match: 'sandbox-architecture.md' },
      ])
    }

    // A query that is not a substring of the basename returns nothing.
    expect(await search('nomatch')).toEqual([])

    // Glob that admits markdown still hits; a glob that excludes markdown does not.
    expect((await search('sandbox', '*.md')).map((hh) => hh.path)).toEqual([
      'doc/sandbox-architecture.md',
    ])
    expect(await search('sandbox', '*.ts')).toEqual([])
  })

  it('scopes search to a glob file pattern in both modes', async () => {
    await mkdir(join(workspace, 'src'))
    await writeFile(join(workspace, 'src', 'target.ts'), 'needle here\n')
    await writeFile(join(workspace, 'src', 'target.js'), 'needle there\n')
    await writeFile(join(workspace, 'notes.md'), 'needle docs\n')
    const { conn, sent } = capture()

    // filename mode: *.ts keeps only the .ts file
    await searchCodesHandler(KCTX, conn, {
      type: 'search_codes',
      workspaceId: 'ws-1',
      query: 'target',
      mode: 'filename',
      pattern: '*.ts',
    })
    // content mode: multiple globs union (.ts + .js), markdown excluded
    await searchCodesHandler(KCTX, conn, {
      type: 'search_codes',
      workspaceId: 'ws-1',
      query: 'needle',
      mode: 'content',
      pattern: '*.ts,*.js',
    })

    const filenameHit = sent[0] as Extract<ServerToClient, { type: 'codes_searched' }>
    expect(filenameHit.hits.map((hh) => hh.path)).toEqual(['src/target.ts'])

    const contentHit = sent[1] as Extract<ServerToClient, { type: 'codes_searched' }>
    expect(contentHit.hits.map((hh) => hh.path).sort()).toEqual(['src/target.js', 'src/target.ts'])
  })

  it('treats * / absent pattern as match-all', () => {
    expect(compilePatterns('*')).toBeNull()
    expect(compilePatterns('')).toBeNull()
    expect(compilePatterns('  ')).toBeNull()
    const ts = compilePatterns('*.ts')
    expect(ts).not.toBeNull()
    expect(ts?.some((re) => re.test('a.ts'))).toBe(true)
    expect(ts?.some((re) => re.test('a.js'))).toBe(false)
  })

  it('caps search results', async () => {
    for (let i = 0; i < SEARCH_RESULT_LIMIT + 5; i++) {
      await writeFile(join(workspace, `match-${i}.txt`), 'x')
    }
    const { conn, sent } = capture()

    await searchCodesHandler(KCTX, conn, {
      type: 'search_codes',
      workspaceId: 'ws-1',
      query: 'match',
      mode: 'filename',
    })

    const msg = sent[0] as Extract<ServerToClient, { type: 'codes_searched' }>
    expect(msg.hits).toHaveLength(SEARCH_RESULT_LIMIT)
    expect(msg.truncated).toBe(true)
  })

  it('marks timeout without hanging the request', async () => {
    await writeFile(join(workspace, 'match.txt'), 'x')
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(SEARCH_TIMEOUT_MS + 1)
    const { conn, sent } = capture()

    await searchCodesHandler(KCTX, conn, {
      type: 'search_codes',
      workspaceId: 'ws-1',
      query: 'match',
      mode: 'filename',
    })

    expect(sent[0]).toMatchObject({ type: 'codes_searched', hits: [], timedOut: true })
  })
})

describe('get_code_git_status handler', () => {
  function initRepo(path: string): void {
    execFileSync('git', ['init', '-q'], { cwd: path })
    execFileSync('git', ['config', 'user.email', 't@t.dev'], { cwd: path })
    execFileSync('git', ['config', 'user.name', 'tester'], { cwd: path })
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: path })
    execFileSync('git', ['add', '-A'], { cwd: path })
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: path })
  }

  it('replies with the workspace-relative status map for a git workspace', async () => {
    initRepo(workspace)
    await writeFile(join(workspace, 'new.ts'), 'export const n = 1\n')

    const { conn, sent } = capture()
    await getCodeGitStatusHandler(KCTX, conn, { type: 'get_code_git_status', workspaceId: 'ws-1' })

    expect(sent).toHaveLength(1)
    const msg = sent[0] as Extract<ServerToClient, { type: 'code_git_status' }>
    expect(msg.type).toBe('code_git_status')
    expect(msg.workspaceId).toBe('ws-1')
    expect(msg.files['new.ts']).toEqual<CodeGitStatus>({
      modified: false,
      untracked: true,
      staged: false,
    })
  })

  it('non-git workspace → empty snapshot, never an error frame', async () => {
    const { conn, sent } = capture()
    await getCodeGitStatusHandler(KCTX, conn, { type: 'get_code_git_status', workspaceId: 'ws-1' })
    expect(sent[0]).toEqual({ type: 'code_git_status', workspaceId: 'ws-1', files: {} })
  })

  it('unknown workspace id → empty snapshot for that id (degrade, no throw)', async () => {
    const { conn, sent } = capture()
    await getCodeGitStatusHandler(KCTX, conn, {
      type: 'get_code_git_status',
      workspaceId: 'ws-unknown',
    })
    expect(sent[0]).toEqual({ type: 'code_git_status', workspaceId: 'ws-unknown', files: {} })
  })
})
