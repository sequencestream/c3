/**
 * Two-form canonical upsert coverage (ADR-0013).
 *
 * The reducer must collapse BOTH vendor message forms — Claude's whole-message
 * frame and Codex's incremental `ItemUpdated` frame — to one `(sessionId, blockId)`
 * upsert rule: a same-id block revises in place (no array growth), tool returns
 * back-fill onto their `tool_use` (011 D3), and anonymous blocks still append.
 */
import { describe, expect, it } from 'vitest'
import { CanonicalAccumulator, upsertBlock } from './canonical-accumulator.js'
import type { CanonicalBlock, CanonicalMessage } from './types.js'

const msg = (over: Partial<CanonicalMessage> & { blocks: CanonicalBlock[] }): CanonicalMessage => ({
  vendor: 'claude',
  sessionId: 's1',
  role: 'assistant',
  ts: 1,
  ...over,
})

describe('upsertBlock', () => {
  it('appends a block with a fresh id', () => {
    const out = upsertBlock([], { type: 'text', id: 'b1', text: 'hi' })
    expect(out).toHaveLength(1)
  })

  it('appends anonymous (id-less) blocks rather than collapsing them', () => {
    let blocks: CanonicalBlock[] = []
    blocks = upsertBlock(blocks, { type: 'text', text: 'a' })
    blocks = upsertBlock(blocks, { type: 'text', text: 'b' })
    expect(blocks).toHaveLength(2)
  })

  it('revises a same-id block in place (no growth, position kept)', () => {
    const blocks: CanonicalBlock[] = [
      { type: 'text', id: 'b1', text: 'partial' },
      { type: 'text', id: 'b2', text: 'other' },
    ]
    const out = upsertBlock(blocks, { type: 'text', id: 'b1', text: 'complete' })
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ id: 'b1', text: 'complete' })
    expect(out[1]).toMatchObject({ id: 'b2' })
    // Input array is not mutated.
    expect((blocks[0] as { text: string }).text).toBe('partial')
  })

  it('back-fills a tool_use result without erasing it on a later input-only revision', () => {
    let blocks: CanonicalBlock[] = []
    blocks = upsertBlock(blocks, { type: 'tool_use', id: 't1', name: 'Read', input: { a: 1 } })
    blocks = upsertBlock(blocks, {
      type: 'tool_use',
      id: 't1',
      name: 'Read',
      input: { a: 1 },
      result: { content: 'ok', isError: false },
    })
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ result: { content: 'ok', isError: false } })
    // A subsequent revision that omits result must NOT erase the back-fill.
    blocks = upsertBlock(blocks, { type: 'tool_use', id: 't1', name: 'Read', input: { a: 2 } })
    expect(blocks[0]).toMatchObject({ input: { a: 2 }, result: { content: 'ok' } })
  })
})

describe('CanonicalAccumulator', () => {
  it('Claude whole-message form: a re-emitted full message is idempotent by id', () => {
    const acc = new CanonicalAccumulator()
    const whole = msg({
      blocks: [
        { type: 'text', id: 'b1', text: 'thinking out loud' },
        { type: 'tool_use', id: 't1', name: 'Bash', input: { cmd: 'ls' } },
      ],
    })
    acc.upsert(whole)
    acc.upsert(whole) // idempotent re-emit
    expect(acc.snapshot('s1')).toHaveLength(2)
  })

  it('Codex incremental form: ItemUpdated revises a block in place, not append', () => {
    const acc = new CanonicalAccumulator()
    acc.upsert(msg({ vendor: 'codex', blocks: [{ type: 'text', id: 'r1', text: 'reaso' }] }))
    acc.upsert(
      msg({ vendor: 'codex', blocks: [{ type: 'text', id: 'r1', text: 'reasoning done' }] }),
    )
    const blocks = acc.snapshot('s1')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ id: 'r1', text: 'reasoning done' })
  })

  it('both forms converge to the same normalized view (tool result folded in)', () => {
    // Claude path: one message carrying tool_use, then a second carrying the result.
    const claude = new CanonicalAccumulator()
    claude.upsert(msg({ blocks: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] }))
    claude.upsert(
      msg({
        blocks: [
          {
            type: 'tool_use',
            id: 't1',
            name: 'Read',
            input: {},
            result: { content: 'X', isError: false },
          },
        ],
      }),
    )

    // Codex path: the same tool item updated in place with its output.
    const codex = new CanonicalAccumulator()
    codex.upsert(
      msg({ vendor: 'codex', blocks: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] }),
    )
    codex.upsert(
      msg({
        vendor: 'codex',
        blocks: [
          {
            type: 'tool_use',
            id: 't1',
            name: 'Read',
            input: {},
            result: { content: 'X', isError: false },
          },
        ],
      }),
    )

    expect(claude.snapshot('s1')).toHaveLength(1)
    expect(codex.snapshot('s1')).toHaveLength(1)
    expect(claude.snapshot('s1')[0]).toMatchObject({ result: { content: 'X' } })
    expect(codex.snapshot('s1')[0]).toMatchObject({ result: { content: 'X' } })
  })

  it('keeps separate views per sessionId', () => {
    const acc = new CanonicalAccumulator()
    acc.upsert(msg({ sessionId: 'a', blocks: [{ type: 'text', id: 'b1', text: 'A' }] }))
    acc.upsert(msg({ sessionId: 'b', blocks: [{ type: 'text', id: 'b1', text: 'B' }] }))
    expect(acc.snapshot('a')).toHaveLength(1)
    expect(acc.snapshot('b')).toHaveLength(1)
    expect(acc.message('a')?.blocks[0]).toMatchObject({ text: 'A' })
  })
})
