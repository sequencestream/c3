/**
 * The two memory tools as the model experiences them: what an empty query lists,
 * what a query returns, what a receipt says, and what a failure says instead.
 *
 * The scope is the point. Both tools take it from the run binding, so a model
 * holding workspace A's binding has no argument that could reach workspace B —
 * that is asserted here as behavior, not as a code-reading conclusion.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetDbForTests } from '../../kernel/infra/db.js'
import {
  MEMORY_MAX_CHARS,
  countMemoryRows,
  listActiveMemories,
  resetMemoryStoreForTests,
} from './store.js'
import {
  runMemorySearch,
  runMemoryWrite,
  type MemoryScope,
  type MemoryToolResult,
  type MemoryWriteArgs,
} from './tool-defs.js'

let home: string
const alpha: MemoryScope = { workspaceName: 'alpha', sessionId: 'run-1' }
const beta: MemoryScope = { workspaceName: 'beta', sessionId: 'run-2' }

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'c3-memory-tools-'))
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

function payload(r: MemoryToolResult): Record<string, never> & Record<string, unknown> {
  expect(r.isError).toBeFalsy()
  return JSON.parse(r.content[0].text)
}

function errorText(r: MemoryToolResult): string {
  expect(r.isError).toBe(true)
  return r.content[0].text
}

const write = (scope: MemoryScope, args: MemoryWriteArgs): MemoryToolResult =>
  runMemoryWrite(scope, args)

function seed(scope: MemoryScope = alpha): void {
  write(scope, {
    op: 'create',
    type: 'preference',
    title: '提交信息用中文',
    content: '正文一律中文。',
  })
  write(scope, {
    op: 'create',
    type: 'lesson',
    title: '沙箱内 vitest 需单线程',
    content: 'Node 26 下会崩。',
  })
  write(scope, {
    op: 'create',
    type: 'constraint',
    title: 'PR 合入交付分支',
    content: '不是直接进 main。',
  })
  write(scope, {
    op: 'create',
    type: 'preference',
    title: '不写 Co-Authored-By',
    content: '提交信息里不要这一行。',
  })
}

describe('memory_search', () => {
  it('lists the whole directory grouped by type in a fixed order when there is no query', () => {
    seed()
    const out = payload(runMemorySearch(alpha, {}))
    expect(out.mode).toBe('directory')
    expect(out.total).toBe(4)
    // Fixed group order, empty groups omitted (`fact` was never written).
    expect(Object.keys(out.directory as object)).toEqual(['preference', 'constraint', 'lesson'])
    const dir = out.directory as Record<string, Array<{ title: string; type: string }>>
    expect(dir.preference.map((e) => e.title).sort()).toEqual([
      '不写 Co-Authored-By',
      '提交信息用中文',
    ])
    expect(dir.constraint).toEqual([{ title: 'PR 合入交付分支', type: 'constraint' }])
    // A directory entry carries the title and type only — never the content.
    for (const entry of Object.values(dir).flat())
      expect(Object.keys(entry).sort()).toEqual(['title', 'type'])
  })

  it('treats a blank query as no query at all', () => {
    seed()
    expect(payload(runMemorySearch(alpha, { query: '   ' })).mode).toBe('directory')
  })

  it('returns full details for a literal match', () => {
    seed()
    const out = payload(runMemorySearch(alpha, { query: 'VITEST' }))
    expect(out.mode).toBe('match')
    expect(out.total).toBe(1)
    const [hit] = out.memories as Array<Record<string, unknown>>
    expect(hit.title).toBe('沙箱内 vitest 需单线程')
    expect(hit.content).toBe('Node 26 下会崩。')
    expect(hit.type).toBe('lesson')
    expect(hit.sourceSessionId).toBe('run-1')
    expect(typeof hit.id).toBe('string')
  })

  it('reports an explicit empty result rather than falling back', () => {
    seed()
    const out = payload(runMemorySearch(alpha, { query: '这个词不存在' }))
    expect(out).toMatchObject({ mode: 'match', total: 0, memories: [] })
  })

  it('an empty workspace lists an empty directory', () => {
    expect(payload(runMemorySearch(alpha, {}))).toMatchObject({
      mode: 'directory',
      total: 0,
      directory: {},
    })
  })
})

describe('workspace isolation', () => {
  it('a binding for A cannot read, update or delete B', () => {
    seed(beta)
    expect(payload(runMemorySearch(alpha, {})).total).toBe(0)
    expect(payload(runMemorySearch(alpha, { query: 'vitest' })).total).toBe(0)
    expect(payload(runMemorySearch(beta, {})).total).toBe(4)

    const target = listActiveMemories('beta')[0]
    expect(errorText(write(alpha, { op: 'update', id: target.id, content: '偷改' }))).toContain(
      '不属于本工作区',
    )
    expect(errorText(write(alpha, { op: 'delete', id: target.id }))).toContain('不属于本工作区')
    expect(listActiveMemories('beta')).toHaveLength(4)
  })

  it('the same title written from two bindings makes two independent memories', () => {
    write(alpha, { op: 'create', type: 'fact', title: '默认分支', content: 'alpha 用 main' })
    write(beta, { op: 'create', type: 'fact', title: '默认分支', content: 'beta 用 master' })
    expect(payload(runMemorySearch(alpha, { query: '默认分支' })).total).toBe(1)
    expect(
      (
        payload(runMemorySearch(beta, { query: '默认分支' })).memories as Array<{ content: string }>
      )[0].content,
    ).toBe('beta 用 master')
  })
})

describe('memory_write receipts', () => {
  it('acknowledges the title actually saved, updated and deleted', () => {
    const created = payload(
      write(alpha, { op: 'create', type: 'fact', title: ' 默认分支 ', content: 'main' }),
    )
    expect(created).toMatchObject({
      ok: true,
      op: 'create',
      title: '默认分支',
      type: 'fact',
      status: 'active',
    })

    const id = created.id as string
    const updated = payload(
      write(alpha, { op: 'update', id, content: 'main,不是 master', subject: 'git' }),
    )
    expect(updated).toMatchObject({
      ok: true,
      op: 'update',
      id,
      title: '默认分支',
      status: 'active',
    })

    const removed = payload(write(alpha, { op: 'delete', id }))
    expect(removed).toMatchObject({
      ok: true,
      op: 'delete',
      id,
      title: '默认分支',
      status: 'deleted',
    })
    // Repeating a delete is idempotent and still names what it removed.
    expect(payload(write(alpha, { op: 'delete', id }))).toMatchObject({
      title: '默认分支',
      status: 'deleted',
    })
  })

  it('a same-title create reports the one row it replaced', () => {
    const first = payload(
      write(alpha, { op: 'create', type: 'fact', title: '默认分支', content: 'main' }),
    )
    const second = payload(
      write(alpha, { op: 'create', type: 'fact', title: '  默认分支 ', content: 'master' }),
    )
    expect(second.id).toBe(first.id)
    expect(countMemoryRows('alpha')).toBe(1)
  })
})

describe('memory_write refusals', () => {
  it('never turns a rejected write into a receipt', () => {
    expect(errorText(write(alpha, { op: 'create', type: 'fact', title: '缺正文' }))).toContain(
      'create 需要',
    )
    expect(errorText(write(alpha, { op: 'update', content: '缺 id' }))).toContain('update 需要 id')
    expect(errorText(write(alpha, { op: 'delete' }))).toContain('delete 需要 id')
    expect(errorText(write(alpha, { op: 'update', id: '不存在', content: 'x' }))).toContain(
      '不存在',
    )
    expect(countMemoryRows('alpha')).toBe(0)
  })

  it('refuses credential and artifact shapes without echoing them', () => {
    const secret = 'api_key=8f3c1a9d7e2b4056af11'
    const err = errorText(
      write(alpha, { op: 'create', type: 'fact', title: '密钥', content: secret }),
    )
    expect(err).not.toContain(secret)
    expect(err).toContain('凭据')

    const fenced = '```ts\nconst a = 1\n```'
    expect(
      errorText(write(alpha, { op: 'create', type: 'fact', title: '代码', content: fenced })),
    ).toContain('代码块')
    expect(countMemoryRows('alpha')).toBe(0)
  })

  it('refuses an over-long content and says the limit', () => {
    const err = errorText(
      write(alpha, {
        op: 'create',
        type: 'fact',
        title: '太长',
        content: '字'.repeat(MEMORY_MAX_CHARS + 1),
      }),
    )
    expect(err).toContain(String(MEMORY_MAX_CHARS))
    expect(countMemoryRows('alpha')).toBe(0)
  })
})
