/**
 * Template field whitelist and render rejection proofs.
 */
import { describe, expect, it } from 'vitest'
import { buildDeepLink, renderBroadcastTemplate } from './broadcast-templates.js'

describe('renderBroadcastTemplate', () => {
  it('renders a legal intent_parked template', () => {
    const r = renderBroadcastTemplate({
      kind: 'intent_parked',
      fields: {
        eventType: 'intent_parked',
        objectType: 'intent',
        objectId: 'i1',
        objectTitle: 'Fix login',
        reasonCode: 'permission_wait_timeout',
        deepLink: 'http://host/intents/i1',
      },
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.text).toContain('Fix login')
      expect(r.text).toContain('http://host/intents/i1')
    }
  })

  it('rejects extra fields', () => {
    const r = renderBroadcastTemplate({
      kind: 'intent_parked',
      fields: {
        eventType: 'intent_parked',
        objectType: 'intent',
        objectId: 'i1',
        objectTitle: 'x',
        detail: 'injected',
      } as never,
    })
    expect(r).toEqual({ ok: false, reason: 'extra_field' })
  })

  it('rejects unregistered field keys', () => {
    const r = renderBroadcastTemplate({
      kind: 'permission_queued',
      fields: { description: 'free text' } as never,
    })
    expect(r).toEqual({ ok: false, reason: 'extra_field' })
  })

  it('uses group downgrade text without object details', () => {
    const r = renderBroadcastTemplate({
      kind: 'delivery_review_required',
      fields: {
        eventType: 'delivery_review_required',
        objectType: 'delivery',
        objectId: 'd1',
        objectTitle: 'Secret delivery',
        deepLink: 'http://host/deliveries/d1',
      },
      groupDowngrade: true,
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.text).not.toContain('Secret delivery')
      expect(r.text).not.toContain('d1')
    }
  })

  it('omits deep link when baseUrl is missing or invalid', () => {
    expect(buildDeepLink(undefined, 'intent', 'i1')).toBeUndefined()
    expect(buildDeepLink('not-a-url', 'intent', 'i1')).toBeUndefined()
    expect(buildDeepLink('http://host', 'intent', 'i1')).toBe('http://host/intents/i1')
  })
})
