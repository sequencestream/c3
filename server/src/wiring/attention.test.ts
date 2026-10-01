import { afterEach, describe, expect, it } from 'vitest'
import { badgeProjection, resetActivityRegistryForTests } from '../kernel/activity/index.js'
import {
  listPendingPermissions,
  setPendingPermissionsListener,
  waitForDecision,
  resolveDecision,
} from '../kernel/permission/index.js'
import { registerAttentionProjection } from './attention.js'

afterEach(() => {
  setPendingPermissionsListener(undefined)
  resetActivityRegistryForTests()
})

describe('registerAttentionProjection', () => {
  it('mirrors pending permissions into the badge projection by workspace', async () => {
    registerAttentionProjection()
    const pending = waitForDecision('req-a', undefined, 'ws-a')
    expect(badgeProjection.summaryFor('ws-a').attention.awaitingPermission).toBe(1)
    expect(listPendingPermissions()).toHaveLength(1)
    resolveDecision('req-a', 'allow')
    await pending
    expect(badgeProjection.summaryFor('ws-a').attention.awaitingPermission).toBe(0)
  })
})
