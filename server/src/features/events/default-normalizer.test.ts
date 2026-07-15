/**
 * Unit tests for the default (custom-type) event normalizer: it preserves an
 * arbitrary shape while cleaning every free-text leaf (secret redaction, absolute
 * path stripping, length cap) and never changing the event `type`.
 */
import { describe, expect, it } from 'vitest'
import { normalizeGenericEventDefault } from './default-normalizer.js'

describe('normalizeGenericEventDefault — custom event safety', () => {
  it('preserves the type and passes an arbitrary shape through', () => {
    const out = normalizeGenericEventDefault({
      type: 'custom:create',
      status: 'ok',
      metadata: { k: 'v' },
      data: { nested: { list: [1, 'two', true, null] } },
    })
    expect(out).toEqual({
      type: 'custom:create',
      status: 'ok',
      metadata: { k: 'v' },
      data: { nested: { list: [1, 'two', true, null] } },
    })
  })

  it('redacts secrets in status / description / metadata / nested data', () => {
    const out = normalizeGenericEventDefault({
      type: 'custom:deploy',
      description: 'token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 leaked',
      metadata: { auth: 'bearer eyJabcdefgh.ijklmnop.qrstuvwx' },
      data: { deep: { key: 'sk-ABCDEFGHIJKLMNOP1234' } },
    })
    expect(out.description).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345')
    expect(out.metadata!.auth).not.toContain('eyJabcdefgh')
    expect((out.data!.deep as { key: string }).key).not.toContain('sk-ABCDEFGHIJKLMNOP1234')
  })

  it('strips absolute paths and caps long text', () => {
    const out = normalizeGenericEventDefault({
      type: 'custom:log',
      description: 'failed at /Users/alice/secret/project/file.ts',
      data: { blob: 'x'.repeat(5000) },
    })
    expect(out.description).not.toContain('/Users/alice')
    expect((out.data!.blob as string).length).toBeLessThanOrEqual(1000)
  })

  it('omits optional fields that were absent (no empty scaffolding)', () => {
    const out = normalizeGenericEventDefault({ type: 'custom:ping' })
    expect(out).toEqual({ type: 'custom:ping' })
  })
})
