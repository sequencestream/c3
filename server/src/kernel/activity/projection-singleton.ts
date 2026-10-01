/**
 * Process-wide badge projection, subscribed to the activity registry singleton.
 * Tests that construct a private ActivityRegistry do not touch this instance.
 */
import { activityRegistry } from './activity-registry.js'
import { BadgeProjection } from './badge-projection.js'

export const badgeProjection = new BadgeProjection()

activityRegistry.subscribe((mutation) => badgeProjection.apply(mutation))
