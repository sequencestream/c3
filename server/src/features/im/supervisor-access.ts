/**
 * Read-only access to live robot send handles for the broadcast dispatcher.
 *
 * Keeps raw provider send out of the dispatcher while avoiding a circular import
 * with supervisor.ts (supervisor imports outbound-guard, dispatcher imports this).
 */
import type { RawImSend } from './outbound-guard.js'

type HandleView = {
  maxOutboundChars: number
  rawSend: RawImSend
}

let lookup: ((robotId: string) => HandleView | null) | null = null

export function registerRobotHandleLookup(fn: (robotId: string) => HandleView | null): void {
  lookup = fn
}

export function getRobotHandle(robotId: string): HandleView | null {
  return lookup?.(robotId) ?? null
}

export function resetRobotHandleLookupForTests(): void {
  lookup = null
}
