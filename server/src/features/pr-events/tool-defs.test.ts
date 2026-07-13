/**
 * Unit tests for the framing-free `publish_pr_event` core (AC1, AC2): input
 * validation rejects illegal/missing required fields without publishing, and the
 * safety normalization strips tokens / raw CLI output / absolute paths from the
 * event before it leaves c3.
 */
import { describe, expect, it, vi } from 'vitest'
import type { GenericEvent, PrOperationEvent } from '@ccc/shared/protocol'
import { EventNormalizerRegistry } from '../../kernel/events/generic-event.js'
import {
  PR_EVENT_TYPE,
  genericEventToPrOperation,
  normalizeErrorSummary,
  normalizePrEvent,
  normalizePrGenericEvent,
  prArgsToGenericEvent,
  redactSecrets,
  runPublishPrEvent,
  type PublishPrEventArgs,
} from './tool-defs.js'

/** A registry with only the PR normalizer, mirroring the composition root. */
function makeNormalize(): (core: GenericEvent) => ReturnType<EventNormalizerRegistry['normalize']> {
  const registry = new EventNormalizerRegistry()
  registry.register(PR_EVENT_TYPE, normalizePrGenericEvent)
  return (core) => registry.normalize(core)
}

describe('runPublishPrEvent — validation (routed through the registry)', () => {
  const normalize = makeNormalize()

  it('publishes on a valid create/success event', () => {
    const published: PrOperationEvent[] = []
    const r = runPublishPrEvent(
      { operation: 'create', result: 'success', pr: { number: 7, url: 'https://x/pr/7' } },
      normalize,
      (e) => published.push(e),
    )
    expect(r.isError).toBeUndefined()
    expect(published).toHaveLength(1)
    expect(published[0]).toMatchObject({
      operation: 'create',
      result: 'success',
      pr: { number: 7 },
    })
  })

  it.each(['create', 'review', 'merge', 'close', 'comment', 'update'] as const)(
    'accepts the %s operation with success, failure and error',
    (operation) => {
      const published: PrOperationEvent[] = []
      runPublishPrEvent({ operation, result: 'success' }, normalize, (e) => published.push(e))
      runPublishPrEvent({ operation, result: 'failure' }, normalize, (e) => published.push(e))
      runPublishPrEvent({ operation, result: 'error' }, normalize, (e) => published.push(e))
      expect(published.map((e) => e.result)).toEqual(['success', 'failure', 'error'])
      expect(published.every((e) => e.operation === operation)).toBe(true)
    },
  )

  it('rejects an illegal operation enum and publishes nothing', () => {
    const publish = vi.fn()
    const r = runPublishPrEvent(
      { operation: 'rebase' as PublishPrEventArgs['operation'], result: 'success' },
      normalize,
      publish,
    )
    expect(r.isError).toBe(true)
    expect(publish).not.toHaveBeenCalled()
  })

  it('rejects an illegal result enum and publishes nothing', () => {
    const publish = vi.fn()
    const r = runPublishPrEvent(
      { operation: 'merge', result: 'maybe' as PublishPrEventArgs['result'] },
      normalize,
      publish,
    )
    expect(r.isError).toBe(true)
    expect(publish).not.toHaveBeenCalled()
  })

  it('fails (publishing nothing) when the PR type has no registered normalizer', () => {
    const emptyRegistry = new EventNormalizerRegistry()
    const publish = vi.fn()
    const r = runPublishPrEvent(
      { operation: 'create', result: 'success' },
      (core) => emptyRegistry.normalize(core),
      publish,
    )
    expect(r.isError).toBe(true)
    expect(publish).not.toHaveBeenCalled()
  })
})

describe('normalizePrGenericEvent — the pr:operation registry entry (AC3)', () => {
  const normalize = makeNormalize()

  it('round-trips a full event core through normalize → bridge unchanged', () => {
    const core = prArgsToGenericEvent({
      operation: 'review',
      result: 'success',
      pr: { number: 42, id: 'pr-1', title: 'Add cache', state: 'open' },
      repo: { provider: 'gitlab', host: 'gitlab.com', owner: 'g', name: 'r' },
      ref: { head: 'feat/cache', base: 'main' },
      association: { intentId: 'intent-1', intentTitle: 'Cache work' },
    })
    const res = normalize(core)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.event.type).toBe(PR_EVENT_TYPE)
    expect(genericEventToPrOperation(res.event)).toEqual({
      operation: 'review',
      result: 'success',
      pr: { number: 42, id: 'pr-1', title: 'Add cache', state: 'open' },
      repo: { provider: 'gitlab', host: 'gitlab.com', owner: 'g', name: 'r' },
      ref: { head: 'feat/cache', base: 'main' },
      association: { intentId: 'intent-1', intentTitle: 'Cache work' },
    })
  })

  it.each([
    ['pr.title', { pr: { title: 'x ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345' } }],
    ['repo.owner', { repo: { owner: 'o glpat-ABCDEFGHIJKLMNOP1234' } }],
    ['ref.head', { ref: { head: 'feat sk-abcdefghijklmnopqrstuvwxyz' } }],
    [
      'association.intentTitle',
      { association: { intentTitle: 'x ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345' } },
    ],
  ] as const)('redacts a secret embedded in %s', (_label, extra) => {
    const core = prArgsToGenericEvent({ operation: 'review', result: 'failure', ...extra })
    const res = normalize(core)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const serialized = JSON.stringify(res.event)
    expect(serialized).toContain('[redacted]')
    expect(serialized).not.toMatch(/ghp_|glpat-|sk-[A-Za-z]/)
  })

  it('strips POSIX and Windows absolute paths from the error summary', () => {
    const core = prArgsToGenericEvent({
      operation: 'merge',
      result: 'error',
      errorSummary: 'failed at /Users/alice/repo/.git and C:\\Users\\bob\\secret\\repo',
    })
    const res = normalize(core)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.event.description).not.toContain('/Users/alice')
    expect(res.event.description).not.toContain('C:\\Users\\bob')
  })

  it('caps a structural field at 256 chars', () => {
    const core = prArgsToGenericEvent({
      operation: 'review',
      result: 'success',
      pr: { title: 'x'.repeat(500) },
    })
    const res = normalize(core)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(genericEventToPrOperation(res.event).pr?.title?.length).toBe(256)
  })

  it('caps the error summary at 500 chars and collapses whitespace', () => {
    const core = prArgsToGenericEvent({
      operation: 'merge',
      result: 'failure',
      errorSummary: `${'x'.repeat(600)}\n\n  multi   line`,
    })
    const res = normalize(core)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect((res.event.description ?? '').length).toBeLessThanOrEqual(501)
    expect(res.event.description).not.toContain('\n')
  })

  it('removes an empty nested object after normalization', () => {
    const core = prArgsToGenericEvent({
      operation: 'close',
      result: 'success',
      pr: { title: '   ' },
    })
    const res = normalize(core)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.event.data?.pr).toBeUndefined()
    expect(genericEventToPrOperation(res.event).pr).toBeUndefined()
  })

  it('ignores unknown/forged data keys (they never reach the bus payload)', () => {
    const res = normalize({
      type: PR_EVENT_TYPE,
      status: 'success',
      metadata: { operation: 'create' },
      data: { workspacePath: 'evil', sessionId: 'evil', pr: { number: 1 } },
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const recovered = genericEventToPrOperation(res.event)
    expect(recovered).toEqual({ operation: 'create', result: 'success', pr: { number: 1 } })
    expect(JSON.stringify(res.event)).not.toContain('evil')
  })
})

describe('redactSecrets / normalizeErrorSummary — safety normalization', () => {
  it('redacts GitHub / generic tokens from free text', () => {
    const out = redactSecrets('token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 leaked')
    expect(out).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345')
    expect(out).toContain('[redacted]')
  })

  it('strips absolute paths and collapses whitespace in the error summary', () => {
    const raw = 'fatal: push failed\n  at /Users/alice/secret/repo/.git\n\nstderr dump'
    const out = normalizeErrorSummary(raw)!
    expect(out).not.toContain('/Users/alice')
    expect(out).not.toContain('\n')
  })

  it('redacts a key=value secret and a bearer token', () => {
    const out = normalizeErrorSummary(
      'api_key=sk-abcdefghijklmnopqrstuvwxyz Authorization: bearer foobarbazqux',
    )!
    expect(out).not.toContain('sk-abcdefghijklmnopqrstuvwxyz')
    expect(out.toLowerCase()).not.toContain('bearer foobar')
  })

  it('caps an excessively long summary', () => {
    const out = normalizeErrorSummary('x'.repeat(2000))!
    expect(out.length).toBeLessThanOrEqual(501)
  })
})

describe('normalizePrEvent — full event normalization', () => {
  it('sanitizes errorSummary and drops empty nested objects', () => {
    const event = normalizePrEvent({
      operation: 'merge',
      result: 'failure',
      pr: {},
      repo: { provider: 'github', owner: 'acme', name: 'web' },
      errorSummary: 'merge blocked, see ghp_TOKEN1234567890ABCDEFGHIJKLMNOP',
    })
    expect(event.pr).toBeUndefined() // empty object dropped
    expect(event.repo).toEqual({ provider: 'github', owner: 'acme', name: 'web' })
    expect(event.errorSummary).toBeDefined()
    expect(event.errorSummary).not.toContain('ghp_TOKEN1234567890ABCDEFGHIJKLMNOP')
  })

  it('carries pr/repo/ref/association for listener matching (AC2)', () => {
    const event = normalizePrEvent({
      operation: 'review',
      result: 'success',
      pr: { number: 42, title: 'Add cache', state: 'open' },
      repo: { provider: 'gitlab', host: 'gitlab.com', owner: 'g', name: 'r' },
      ref: { head: 'feat/cache', base: 'main' },
      association: { intentId: 'intent-1' },
    })
    expect(event).toMatchObject({
      operation: 'review',
      result: 'success',
      pr: { number: 42, title: 'Add cache', state: 'open' },
      repo: { provider: 'gitlab', host: 'gitlab.com', owner: 'g', name: 'r' },
      ref: { head: 'feat/cache', base: 'main' },
      association: { intentId: 'intent-1' },
    })
  })

  it('publishes an error result event and carries it through', () => {
    const event = normalizePrEvent({
      operation: 'review',
      result: 'error',
      pr: { number: 99, id: 'pr-xyz' },
      errorSummary: 'CI pipeline failed with timeout',
    })
    expect(event).toMatchObject({
      operation: 'review',
      result: 'error',
      pr: { number: 99, id: 'pr-xyz' },
    })
    expect(event.errorSummary).toBe('CI pipeline failed with timeout')
  })

  it('carries intentTitle alongside intentId in association', () => {
    const event = normalizePrEvent({
      operation: 'review',
      result: 'failure',
      association: { intentId: 'intent-42', intentTitle: 'Add user auth' },
    })
    expect(event.association).toEqual({ intentId: 'intent-42', intentTitle: 'Add user auth' })
  })

  it('writes association when only intentTitle is present (no intentId)', () => {
    const event = normalizePrEvent({
      operation: 'review',
      result: 'error',
      association: { intentTitle: 'Fix login bug' },
    })
    expect(event.association).toEqual({ intentTitle: 'Fix login bug' })
  })

  it('redacts secrets from intentTitle', () => {
    const event = normalizePrEvent({
      operation: 'review',
      result: 'failure',
      association: { intentTitle: 'Fix token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345' },
    })
    expect(event.association?.intentTitle).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345')
    expect(event.association?.intentTitle).toContain('[redacted]')
  })

  it('truncates long intentTitle to 256 chars', () => {
    const event = normalizePrEvent({
      operation: 'review',
      result: 'error',
      association: { intentTitle: 'x'.repeat(500) },
    })
    expect(event.association?.intentTitle?.length).toBe(256)
  })

  it('drops association when both intentId and intentTitle are empty after normalization', () => {
    const event = normalizePrEvent({
      operation: 'review',
      result: 'failure',
      association: { intentId: '', intentTitle: '' },
    })
    expect(event.association).toBeUndefined()
  })
})
