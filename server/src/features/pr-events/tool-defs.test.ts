/**
 * Unit tests for the framing-free `publish_pr_event` core (AC1, AC2): input
 * validation rejects illegal/missing required fields without publishing, and the
 * safety normalization strips tokens / raw CLI output / absolute paths from the
 * event before it leaves c3.
 */
import { describe, expect, it, vi } from 'vitest'
import type { PrOperationEvent } from '@ccc/shared/protocol'
import {
  normalizeErrorSummary,
  normalizePrEvent,
  redactSecrets,
  runPublishPrEvent,
  type PublishPrEventArgs,
} from './tool-defs.js'

describe('runPublishPrEvent — validation', () => {
  it('publishes on a valid create/success event', () => {
    const published: PrOperationEvent[] = []
    const r = runPublishPrEvent(
      { operation: 'create', result: 'success', pr: { number: 7, url: 'https://x/pr/7' } },
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

  it.each(['create', 'review', 'merge', 'close', 'comment'] as const)(
    'accepts the %s operation with success, failure and error',
    (operation) => {
      const published: PrOperationEvent[] = []
      runPublishPrEvent({ operation, result: 'success' }, (e) => published.push(e))
      runPublishPrEvent({ operation, result: 'failure' }, (e) => published.push(e))
      runPublishPrEvent({ operation, result: 'error' }, (e) => published.push(e))
      expect(published.map((e) => e.result)).toEqual(['success', 'failure', 'error'])
      expect(published.every((e) => e.operation === operation)).toBe(true)
    },
  )

  it('rejects an illegal operation enum and publishes nothing', () => {
    const publish = vi.fn()
    const r = runPublishPrEvent(
      { operation: 'rebase' as PublishPrEventArgs['operation'], result: 'success' },
      publish,
    )
    expect(r.isError).toBe(true)
    expect(publish).not.toHaveBeenCalled()
  })

  it('rejects an illegal result enum and publishes nothing', () => {
    const publish = vi.fn()
    const r = runPublishPrEvent(
      { operation: 'merge', result: 'maybe' as PublishPrEventArgs['result'] },
      publish,
    )
    expect(r.isError).toBe(true)
    expect(publish).not.toHaveBeenCalled()
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
