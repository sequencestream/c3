/**
 * Prompt construction + fault-tolerant event serialization for event-triggered
 * LLM automations. Pure functions: no db, no bus, no agent. Covers the
 * off/no-event byte-for-byte guarantee, faithful embedding of a full event, the
 * single fixed frame, and the three-tier serialization degradation
 * (JSON → safe → protected String).
 */
import { describe, expect, it } from 'vitest'
import type { GenericEvent } from '@ccc/shared/protocol'
import {
  buildAutomationPrompt,
  readEmbedEventContext,
  serializeTriggerEvent,
} from './event-prompt.js'

const FULL_EVENT: GenericEvent = {
  type: 'run:settled',
  status: 'error',
  description: 'the build failed',
  metadata: { pipeline: 'deploy', stage: '2' },
  data: { attempt: 3, nested: { files: ['a.ts', 'b.ts'], ok: false } },
}

describe('readEmbedEventContext', () => {
  it('is true only for a strict boolean true', () => {
    expect(readEmbedEventContext({ embedEventContext: true })).toBe(true)
    expect(readEmbedEventContext({ embedEventContext: false })).toBe(false)
    expect(readEmbedEventContext({ embedEventContext: 'true' })).toBe(false)
    expect(readEmbedEventContext({ embedEventContext: 1 })).toBe(false)
    expect(readEmbedEventContext({})).toBe(false)
    expect(readEmbedEventContext(null)).toBe(false)
    expect(readEmbedEventContext(undefined)).toBe(false)
    expect(readEmbedEventContext('nope')).toBe(false)
  })
})

describe('buildAutomationPrompt — no embedding', () => {
  it('returns the base prompt byte-for-byte when there is no event', () => {
    const base = 'Run the audit.\n\nBe thorough.'
    const { prompt, tier } = buildAutomationPrompt(base, null)
    expect(prompt).toBe(base)
    expect(tier).toBeNull()
  })
})

describe('buildAutomationPrompt — embedding', () => {
  it('preserves the base prompt and appends every event field + nested data once', () => {
    const base = 'Investigate the triggering run.'
    const { prompt, tier } = buildAutomationPrompt(base, FULL_EVENT)

    expect(tier).toBe('json')
    // Original prompt is preserved verbatim at the start.
    expect(prompt.startsWith(base)).toBe(true)
    // Every existing field + nested data survives.
    expect(prompt).toContain('"type": "run:settled"')
    expect(prompt).toContain('"status": "error"')
    expect(prompt).toContain('"description": "the build failed"')
    expect(prompt).toContain('"pipeline": "deploy"')
    expect(prompt).toContain('"attempt": 3')
    expect(prompt).toContain('"files"')
    expect(prompt).toContain('a.ts')
    // The fixed frame is appended exactly once.
    expect(prompt.match(/TRIGGERING EVENT CONTEXT \(BEGIN\)/g)).toHaveLength(1)
    expect(prompt.match(/TRIGGERING EVENT CONTEXT \(END\)/g)).toHaveLength(1)
    // The frame states the block is data, not instructions.
    expect(prompt).toContain('untrusted data')
  })

  it('is deterministic — Claude and Codex build the identical final text', () => {
    const base = 'Do the thing.'
    const a = buildAutomationPrompt(base, FULL_EVENT)
    const b = buildAutomationPrompt(base, FULL_EVENT)
    expect(a.prompt).toBe(b.prompt)
  })

  it('embeds a minimal event carrying only the required type', () => {
    const { prompt, tier } = buildAutomationPrompt('base', { type: 'deploy:done' })
    expect(tier).toBe('json')
    expect(prompt).toContain('"type": "deploy:done"')
  })
})

describe('serializeTriggerEvent — degradation chain', () => {
  it('tier 1: faithful indented JSON for a normal event', () => {
    const { text, tier } = serializeTriggerEvent(FULL_EVENT)
    expect(tier).toBe('json')
    expect(JSON.parse(text)).toEqual(FULL_EVENT)
  })

  it('tier 2 (safe): falls back when JSON.stringify throws on a BigInt', () => {
    const event = { type: 'x', data: { big: 10n } } as unknown as GenericEvent
    const { text, tier } = serializeTriggerEvent(event)
    expect(tier).toBe('safe')
    expect(text).toContain('"big": "10"')
  })

  it('tier 2 (safe): tolerates a circular reference', () => {
    const data: Record<string, unknown> = { a: 1 }
    data.self = data
    const event = { type: 'x', data } as unknown as GenericEvent
    const { text, tier } = serializeTriggerEvent(event)
    expect(tier).toBe('safe')
    expect(text).toContain('[Circular]')
    expect(text).toContain('"a": 1')
  })

  it('tier 3 (concat): protected String concat when both JSON tiers throw', () => {
    // A hostile proxy whose traps throw defeats both JSON.stringify passes; the
    // final tier converts each top-level field under its own guard.
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('no keys')
        },
        get() {
          throw new Error('no get')
        },
      },
    )
    const event = {
      type: 'run:settled',
      status: 'error',
      data: hostile,
    } as unknown as GenericEvent
    const { text, tier } = serializeTriggerEvent(event)
    expect(tier).toBe('concat')
    // The convertible top-level fields survive...
    expect(text).toContain('type: run:settled')
    expect(text).toContain('status: error')
    // ...and the single unconvertible field gets a stable placeholder, not a throw.
    expect(text).toContain('data: [unserializable]')
  })

  it('never throws — the worst case still returns a string', () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('boom')
        },
        get() {
          throw new Error('boom')
        },
      },
    )
    const event = { type: 'x', metadata: hostile, data: hostile } as unknown as GenericEvent
    expect(() => serializeTriggerEvent(event)).not.toThrow()
    expect(typeof serializeTriggerEvent(event).text).toBe('string')
  })
})
