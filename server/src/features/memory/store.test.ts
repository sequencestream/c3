/**
 * The memory store. What is pinned here is what makes the table safe to read back
 * into a model's context: identity is deterministic across whitespace and case,
 * a workspace never sees another's rows, a bound refuses instead of truncating or
 * evicting, and credential/artifact shapes never reach disk — with the rejection
 * text never quoting what it rejected.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDb, resetDbForTests } from '../../kernel/infra/db.js'
import {
  MEMORY_MAX_CHARS,
  MEMORY_MAX_ROWS_PER_WORKSPACE,
  MemoryStoreError,
  countMemoryRows,
  createMemory,
  deleteMemory,
  ensureMemorySchema,
  getMemory,
  listActiveMemories,
  normalizeTitle,
  resetMemoryStoreForTests,
  searchMemories,
  updateMemory,
  type MemoryCreateInput,
} from './store.js'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'c3-memory-store-'))
  process.env.C3_DB_PATH = join(home, 'c3.db')
  resetDbForTests()
  resetMemoryStoreForTests()
})

afterEach(() => {
  resetDbForTests()
  delete process.env.C3_DB_PATH
  resetMemoryStoreForTests()
  rmSync(home, { recursive: true, force: true })
})

const input = (over: Partial<MemoryCreateInput> = {}): MemoryCreateInput => ({
  workspaceName: 'alpha',
  sourceSessionId: 'sess-1',
  type: 'preference',
  title: '提交信息用中文',
  content: '用户明确要求提交信息正文使用中文,不要英文。',
  ...over,
})

/** Assert a call refuses with a specific code, and return the error for inspection. */
function refusal(fn: () => unknown, code: string): MemoryStoreError {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(MemoryStoreError)
    const e = err as MemoryStoreError
    expect(e.code).toBe(code)
    return e
  }
  throw new Error(`expected a ${code} refusal, but the call succeeded`)
}

describe('schema', () => {
  it('materializes on first use and repeated initialization is a no-op', () => {
    expect(ensureMemorySchema()).toBe(true)
    createMemory(input(), 1000)
    resetMemoryStoreForTests()
    expect(ensureMemorySchema()).toBe(true)
    expect(listActiveMemories('alpha')).toHaveLength(1)
  })

  it('declares the exact columns, the closed enums and the three indexes', () => {
    ensureMemorySchema()
    const d = getDb()!
    const cols = d.all<{ name: string }>('PRAGMA table_info(workspace_memories)').map((c) => c.name)
    expect(cols).toEqual([
      'id',
      'workspace_name',
      'subject',
      'type',
      'title',
      'title_key',
      'content',
      'status',
      'source_session_id',
      'created_at',
      'updated_at',
      'superseded_by',
    ])
    const indexes = d
      .all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='workspace_memories' AND name NOT LIKE 'sqlite_%'",
      )
      .map((r) => r.name)
      .sort()
    expect(indexes).toEqual([
      'idx_workspace_memory_inactive',
      'idx_workspace_memory_scope',
      'idx_workspace_memory_title',
    ])
    // The enums are enforced by the database, not only by the application.
    expect(() =>
      d.run(
        `INSERT INTO workspace_memories VALUES ('x','alpha',NULL,'opinion','t','t','c','active','s',1,1,NULL)`,
      ),
    ).toThrow()
    expect(() =>
      d.run(
        `INSERT INTO workspace_memories VALUES ('y','alpha',NULL,'fact','t','t','c','archived','s',1,1,NULL)`,
      ),
    ).toThrow()
  })

  it('completes a partially initialized table and derives the missing comparison keys', () => {
    const d = getDb()!
    // A table that exists without the derived key column or the optional columns.
    d.exec(`CREATE TABLE workspace_memories (
      id TEXT PRIMARY KEY, workspace_name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('preference','constraint','fact','lesson')),
      title TEXT NOT NULL, content TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active','superseded','deleted')),
      source_session_id TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`)
    d.run(
      `INSERT INTO workspace_memories (id, workspace_name, type, title, content, status, source_session_id, created_at, updated_at)
       VALUES ('old','alpha','fact','  Deploy   Target ','走 staging','active','sess-0',1,1)`,
    )
    expect(ensureMemorySchema()).toBe(true)
    // The key was derived from the stored title, so a later same-title write finds it.
    const saved = createMemory(input({ title: 'deploy target', content: '改走 production' }), 2000)
    expect(saved.id).toBe('old')
    expect(countMemoryRows('alpha')).toBe(1)
  })
})

describe('title identity', () => {
  it.each([
    ['提交信息用中文', '  提交信息用中文  '],
    ['Commit Message Language', 'commit   message   language'],
    ['Deploy Target', 'DEPLOY\tTARGET'],
  ])('%s and %s normalize to one identity', (a, b) => {
    expect(normalizeTitle(a)).toBe(normalizeTitle(b))
  })

  it('a same-title create replaces in place, keeping id and created_at', () => {
    const first = createMemory(input({ title: 'Commit Message Language' }), 1000)
    const second = createMemory(
      input({
        title: '  commit   MESSAGE\tlanguage ',
        content: '改为:标题英文,正文中文。',
        sourceSessionId: 'sess-2',
      }),
      5000,
    )
    expect(second.id).toBe(first.id)
    expect(second.createdAt).toBe(1000)
    expect(second.updatedAt).toBe(5000)
    expect(second.content).toBe('改为:标题英文,正文中文。')
    expect(second.sourceSessionId).toBe('sess-2')
    expect(countMemoryRows('alpha')).toBe(1)
  })

  it('two contradictory statements under distinct titles both stay active', () => {
    createMemory(
      input({ title: 'CI 用 GitHub Actions', subject: 'ci', content: '默认走 Actions。' }),
      1000,
    )
    createMemory(
      input({
        title: 'CI 在内网走自建 runner',
        subject: 'ci',
        content: '内网仓库无法用云 runner。',
      }),
      2000,
    )
    const active = listActiveMemories('alpha')
    expect(active).toHaveLength(2)
    expect(active.every((m) => m.subject === 'ci')).toBe(true)
  })
})

describe('workspace isolation', () => {
  it('a workspace sees only its own rows and cannot reach another by id', () => {
    const mine = createMemory(input({ workspaceName: 'alpha' }), 1000)
    createMemory(input({ workspaceName: 'beta', title: 'beta 的偏好' }), 1000)
    expect(listActiveMemories('alpha').map((m) => m.title)).toEqual(['提交信息用中文'])
    expect(listActiveMemories('beta').map((m) => m.title)).toEqual(['beta 的偏好'])
    expect(getMemory('beta', mine.id)).toBeNull()
    refusal(() => deleteMemory('beta', mine.id), 'not_found')
    refusal(
      () =>
        updateMemory({ workspaceName: 'beta', id: mine.id, sourceSessionId: 's', content: 'x' }),
      'not_found',
    )
    expect(getMemory('alpha', mine.id)?.content).toBe(mine.content)
  })

  it('the same title in two workspaces is two independent memories', () => {
    createMemory(input({ workspaceName: 'alpha', content: 'alpha 的说法' }), 1000)
    createMemory(input({ workspaceName: 'beta', content: 'beta 的说法' }), 1000)
    expect(countMemoryRows('alpha')).toBe(1)
    expect(countMemoryRows('beta')).toBe(1)
  })
})

describe('search', () => {
  beforeEach(() => {
    createMemory(
      input({ title: '提交信息用中文', content: '正文使用中文。', subject: 'git' }),
      1000,
    )
    createMemory(
      input({
        type: 'lesson',
        title: '沙箱内 vitest 需单线程',
        content: 'Node 26 下 tinypool 会崩。',
      }),
      2000,
    )
  })

  it('matches literally over title, subject and content, case-insensitively', () => {
    expect(searchMemories('alpha', 'vitest').map((m) => m.title)).toEqual([
      '沙箱内 vitest 需单线程',
    ])
    expect(searchMemories('alpha', 'VITEST')).toHaveLength(1)
    expect(searchMemories('alpha', 'git').map((m) => m.title)).toEqual(['提交信息用中文'])
    expect(searchMemories('alpha', '正文使用中文')).toHaveLength(1)
  })

  it('treats SQL wildcards in the query as ordinary text', () => {
    expect(searchMemories('alpha', '%')).toEqual([])
    expect(searchMemories('alpha', '_')).toEqual([])
    createMemory(input({ title: '折扣 100% 生效', content: '优惠券叠加 100% 有效。' }), 3000)
    expect(searchMemories('alpha', '100%').map((m) => m.title)).toEqual(['折扣 100% 生效'])
  })

  it('returns nothing rather than widening scope when there is no match', () => {
    expect(searchMemories('alpha', '完全不存在的词')).toEqual([])
    expect(searchMemories('beta', 'vitest')).toEqual([])
  })
})

describe('lifecycle', () => {
  it('soft-deletes, hides from search, is idempotent, and still reports the title', () => {
    const m = createMemory(input(), 1000)
    const first = deleteMemory('alpha', m.id, 2000)
    expect(first.status).toBe('deleted')
    expect(first.title).toBe('提交信息用中文')
    expect(listActiveMemories('alpha')).toEqual([])
    expect(searchMemories('alpha', '中文')).toEqual([])
    const again = deleteMemory('alpha', m.id, 3000)
    expect(again.status).toBe('deleted')
    expect(again.title).toBe('提交信息用中文')
    // Idempotent: the second delete does not restart the recovery window.
    expect(again.updatedAt).toBe(2000)
    // The row is still there — physical removal is the janitor's job.
    expect(countMemoryRows('alpha')).toBe(1)
  })

  it('a later same-title create reactivates the soft-deleted row', () => {
    const m = createMemory(input(), 1000)
    deleteMemory('alpha', m.id, 2000)
    const revived = createMemory(input({ content: '用户又确认了一次。' }), 3000)
    expect(revived.id).toBe(m.id)
    expect(revived.status).toBe('active')
    expect(revived.createdAt).toBe(1000)
    expect(listActiveMemories('alpha')).toHaveLength(1)
  })

  it('updates the given fields, refreshes the source session, and keeps created_at', () => {
    const m = createMemory(input(), 1000)
    const updated = updateMemory(
      {
        workspaceName: 'alpha',
        id: m.id,
        sourceSessionId: 'sess-9',
        content: '改口了。',
        subject: 'git',
      },
      4000,
    )
    expect(updated.content).toBe('改口了。')
    expect(updated.subject).toBe('git')
    expect(updated.type).toBe('preference')
    expect(updated.title).toBe('提交信息用中文')
    expect(updated.createdAt).toBe(1000)
    expect(updated.updatedAt).toBe(4000)
    expect(updated.sourceSessionId).toBe('sess-9')
  })

  it('refuses an update with no editable field and a retitle onto another live row', () => {
    const a = createMemory(input({ title: 'A' }), 1000)
    createMemory(input({ title: 'B' }), 2000)
    refusal(
      () => updateMemory({ workspaceName: 'alpha', id: a.id, sourceSessionId: 's' }),
      'no_change',
    )
    refusal(
      () => updateMemory({ workspaceName: 'alpha', id: a.id, sourceSessionId: 's', title: '  b ' }),
      'invalid_title',
    )
    expect(getMemory('alpha', a.id)?.title).toBe('A')
  })
})

describe('bounds', () => {
  it(`accepts exactly ${MEMORY_MAX_CHARS} Unicode characters and rejects one more`, () => {
    // Astral-plane characters: 2000 code points, 4000 UTF-16 units. Counting the
    // wrong unit would reject this.
    const exact = '𝄞'.repeat(MEMORY_MAX_CHARS)
    expect(createMemory(input({ content: exact }), 1000).content).toHaveLength(exact.length)
    const over = '𝄞'.repeat(MEMORY_MAX_CHARS + 1)
    refusal(() => createMemory(input({ title: '另一条', content: over })), 'too_long')
    expect(countMemoryRows('alpha')).toBe(1)
  })

  it(`accepts the ${MEMORY_MAX_ROWS_PER_WORKSPACE}th row and refuses the next without evicting`, () => {
    for (let i = 0; i < MEMORY_MAX_ROWS_PER_WORKSPACE; i++) {
      createMemory(input({ title: `记忆 ${i}`, content: `第 ${i} 条` }), 1000 + i)
    }
    expect(countMemoryRows('alpha')).toBe(MEMORY_MAX_ROWS_PER_WORKSPACE)
    const err = refusal(
      () => createMemory(input({ title: '再来一条', content: '装不下了' })),
      'capacity',
    )
    expect(err.message).toContain(String(MEMORY_MAX_ROWS_PER_WORKSPACE))
    // Nothing was evicted to make room.
    expect(countMemoryRows('alpha')).toBe(MEMORY_MAX_ROWS_PER_WORKSPACE)
    expect(listActiveMemories('alpha')).toHaveLength(MEMORY_MAX_ROWS_PER_WORKSPACE)
    // A full workspace can still be edited: an existing title consumes no slot.
    const rewritten = createMemory(input({ title: '记忆 0', content: '改写第 0 条' }), 9000)
    expect(rewritten.content).toBe('改写第 0 条')
    const target = listActiveMemories('alpha').find((m) => m.title === '记忆 1')!
    expect(
      updateMemory(
        { workspaceName: 'alpha', id: target.id, sourceSessionId: 's', content: '也能改' },
        9001,
      ).content,
    ).toBe('也能改')
    expect(countMemoryRows('alpha')).toBe(MEMORY_MAX_ROWS_PER_WORKSPACE)
  })

  it('a deleted row keeps occupying capacity during the recovery window', () => {
    for (let i = 0; i < MEMORY_MAX_ROWS_PER_WORKSPACE; i++) {
      createMemory(input({ title: `记忆 ${i}`, content: `第 ${i} 条` }), 1000 + i)
    }
    const victim = listActiveMemories('alpha')[0]
    deleteMemory('alpha', victim.id, 8000)
    refusal(() => createMemory(input({ title: '新的', content: '仍然装不下' })), 'capacity')
  })

  it('refuses an empty title, an empty content and an unknown type', () => {
    refusal(() => createMemory(input({ title: '   ' })), 'invalid_title')
    refusal(() => createMemory(input({ content: '  \n ' })), 'invalid_content')
    refusal(() => createMemory(input({ type: 'opinion' })), 'invalid_type')
    expect(countMemoryRows('alpha')).toBe(0)
  })
})

describe('write-time rejection', () => {
  const secrets: Array<[string, string]> = [
    [
      'private key block',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----',
    ],
    ['bearer token', '调用时带 Authorization: Bearer sB3xQ0pLmN7vTz91aeKdRw'],
    ['github token', '用 ghp_A1b2C3d4E5f6G7h8I9j0KlMnOpQrSt 拉私仓'],
    ['anthropic-style key', '密钥是 sk-ant-api03-Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk'],
    ['aws access key id', '账号 AKIAIOSFODNN7EXAMPLE 有权限'],
    ['credential assignment', 'api_key=8f3c1a9d7e2b4056af11'],
  ]
  it.each(secrets)('rejects %s without echoing it', (_label, content) => {
    const err = refusal(() => createMemory(input({ content })), 'rejected_content')
    expect(err.message).not.toContain(content)
    for (const token of content.split(/\s+/).filter((t) => t.length >= 12)) {
      expect(err.message).not.toContain(token)
    }
    expect(countMemoryRows('alpha')).toBe(0)
  })

  const artifacts: Array<[string, string]> = [
    ['fenced code', '正确写法:\n```ts\nconst a = 1\n```'],
    ['tool-call framing', '它调用了 <invoke name="Bash">ls</invoke>'],
    ['tool-result framing', '返回 <tool_result>ok</tool_result>'],
    ['role transcript', 'user: 帮我改一下\nassistant: 好的'],
  ]
  it.each(artifacts)('rejects %s', (_label, content) => {
    const err = refusal(() => createMemory(input({ content })), 'rejected_content')
    expect(err.message).not.toContain(content)
    expect(countMemoryRows('alpha')).toBe(0)
  })

  it('applies the same rejection to title and subject', () => {
    refusal(
      () => createMemory(input({ title: 'api_key=8f3c1a9d7e2b4056af11' })),
      'rejected_content',
    )
    refusal(() => createMemory(input({ subject: '```ts' })), 'rejected_content')
    refusal(
      () =>
        updateMemory({
          workspaceName: 'alpha',
          id: 'x',
          sourceSessionId: 's',
          content: '```sh\nrm -rf /\n```',
        }),
      'rejected_content',
    )
  })

  it('leaves ordinary concise prose writable', () => {
    const prose = [
      '用户偏好:令牌一律由环境变量注入,不落配置文件。',
      'CI 的 secret 由运维在 forge 上配置,开发本地不持有。',
      '部署前必须先跑 pnpm allcheck,这是用户反复强调过的。',
      'password 策略由 IT 统一下发,c3 不参与。',
    ]
    for (const [i, content] of prose.entries()) {
      expect(createMemory(input({ title: `散文 ${i}`, content }), 1000 + i).content).toBe(content)
    }
    expect(countMemoryRows('alpha')).toBe(prose.length)
  })
})

describe('database availability', () => {
  it('reads degrade to empty while writes fail visibly', () => {
    createMemory(input(), 1000)
    // A database path whose parent is a regular FILE cannot be opened, on every
    // platform — the connection degrades rather than the process crashing.
    writeFileSync(join(home, 'blocker'), 'not a directory')
    process.env.C3_DB_PATH = join(home, 'blocker', 'c3.db')
    resetDbForTests()
    resetMemoryStoreForTests()
    expect(listActiveMemories('alpha')).toEqual([])
    expect(searchMemories('alpha', '中文')).toEqual([])
    refusal(() => createMemory(input()), 'db_unavailable')
  })
})
