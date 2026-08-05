/**
 * Contract guards for the derived action descriptor.
 *
 * The descriptor is a compile-time contract, so most of the "must be rejected"
 * cases are pinned with `@ts-expect-error`: the assertion is that `vue-tsc` /
 * `tsc` fails the line, and the annotation itself errors if the code ever became
 * legal. The runtime assertions pin the parts a type cannot express — that the
 * label-code list stays closed and reaches the public barrel.
 */
import { describe, it, expect } from 'vitest'
import { ACTION_LABEL_CODES } from '../protocol.js'
import type { ActionDescriptor, ActionLabelCode, ActionTarget } from '../protocol.js'

describe('ActionDescriptor', () => {
  it('exports the closed label-code list through the public barrel', () => {
    expect(ACTION_LABEL_CODES).toEqual([
      'vendor_auth_invalid',
      'vendor_quota_exhausted',
      'spec_awaiting_approval',
      'spec_rework_exhausted',
      'permission_pending',
      'ask_user_question_pending',
      'dependency_blocked',
    ])
    // The runtime list and the type must stay the same set in both directions.
    const codes: readonly ActionLabelCode[] = ACTION_LABEL_CODES
    expect(new Set(codes).size).toBe(ACTION_LABEL_CODES.length)
  })

  it('accepts a well-formed system-settings-agent descriptor', () => {
    const descriptor: ActionDescriptor = {
      labelCode: 'vendor_auth_invalid',
      target: { type: 'system-settings-agent', vendor: 'claude', agentId: 'agent-1' },
    }
    expect(descriptor.target.type).toBe('system-settings-agent')
    if (descriptor.target.type === 'system-settings-agent') {
      expect(descriptor.target.vendor).toBe('claude')
      expect(descriptor.target.agentId).toBe('agent-1')
    }
  })

  it('accepts a well-formed intent-spec descriptor', () => {
    const descriptor: ActionDescriptor = {
      labelCode: 'spec_awaiting_approval',
      target: { type: 'intent-spec', intentId: 'intent-1' },
    }
    expect(descriptor.target.type).toBe('intent-spec')
    if (descriptor.target.type === 'intent-spec') {
      expect(descriptor.target.intentId).toBe('intent-1')
    }
  })

  it('accepts a well-formed intent-detail descriptor', () => {
    const descriptor: ActionDescriptor = {
      labelCode: 'dependency_blocked',
      target: { type: 'intent-detail', intentId: 'intent-2' },
    }
    expect(descriptor.target.type).toBe('intent-detail')
    if (descriptor.target.type === 'intent-detail') {
      expect(descriptor.target.intentId).toBe('intent-2')
    }
  })

  it('accepts a well-formed workcenter-event descriptor', () => {
    const descriptor: ActionDescriptor = {
      labelCode: 'ask_user_question_pending',
      target: { type: 'workcenter-event', eventId: 'evt-1' },
    }
    expect(descriptor.target.type).toBe('workcenter-event')
    if (descriptor.target.type === 'workcenter-event') {
      expect(descriptor.target.eventId).toBe('evt-1')
    }
  })

  it('rejects a descriptor missing labelCode', () => {
    // @ts-expect-error labelCode is required — a descriptor with no display code
    // would render as an unexplained button.
    const descriptor: ActionDescriptor = {
      target: { type: 'system-settings-agent', vendor: 'claude', agentId: 'agent-1' },
    }
    expect(descriptor).toBeTruthy()
  })

  it('rejects a target missing vendor', () => {
    // @ts-expect-error vendor is required — without it the settings page has no
    // configuration context to fall back to when the agent row is gone.
    const target: ActionTarget = { type: 'system-settings-agent', agentId: 'agent-1' }
    expect(target).toBeTruthy()
  })

  it('rejects a target missing agentId', () => {
    // @ts-expect-error agentId is required — it is what pins the exact failing row.
    const target: ActionTarget = { type: 'system-settings-agent', vendor: 'codex' }
    expect(target).toBeTruthy()
  })

  it('rejects an intent-spec target missing intentId', () => {
    // @ts-expect-error intentId is required — it is what selects the intent to open.
    const target: ActionTarget = { type: 'intent-spec' }
    expect(target).toBeTruthy()
  })

  it('rejects an intent-detail target missing intentId', () => {
    // @ts-expect-error intentId is required — it is what selects the predecessor to open.
    const target: ActionTarget = { type: 'intent-detail' }
    expect(target).toBeTruthy()
  })

  it('rejects a workcenter-event target missing eventId', () => {
    // @ts-expect-error eventId is required — it is what selects the pending item.
    const target: ActionTarget = { type: 'workcenter-event' }
    expect(target).toBeTruthy()
  })

  it('rejects an unknown target type', () => {
    // @ts-expect-error the target union is closed; a new blocked state must add
    // an arm to it rather than smuggle in an ad-hoc type.
    const target: ActionTarget = { type: 'external-url', url: 'https://example.com' }
    expect(target).toBeTruthy()
  })

  it('rejects an unknown label code', () => {
    // @ts-expect-error label codes are closed so the client can localize them all.
    const labelCode: ActionLabelCode = 'vendor_unreachable'
    expect(labelCode).toBeTruthy()
  })

  it('rejects free-text / command payload on a target', () => {
    const target: ActionTarget = {
      type: 'system-settings-agent',
      vendor: 'cursor',
      agentId: 'agent-1',
      // @ts-expect-error a target carries navigation only — never a command,
      // a URL, or an arbitrary payload.
      command: 'rm -rf /',
    }
    expect(target).toBeTruthy()
  })
})
