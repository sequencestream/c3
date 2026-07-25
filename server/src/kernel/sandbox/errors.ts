/**
 * Sandbox — Typed Launch Failure
 *
 * Lives in its own module so both the launcher and the per-vendor auth strategy
 * layer can throw it without importing each other (the launcher consumes the
 * strategy registry; the registry must be able to fail closed on an unknown
 * vendor). Re-exported from `SandboxLauncher.ts`, which stays the public entry
 * point for existing importers.
 *
 * Layer: kernel/sandbox (inner domain)
 *
 * @module
 */

import type { SandboxUiCode } from './types.js'

/**
 * A sandbox launch failure carrying a stable {@link SandboxUiCode}. Thrown by
 * path resolution (illegal / escaping path) and by auth-profile resolution
 * (unregistered vendor), and surfaced by the run lifecycle as a hard-fail —
 * never a silent host fallback.
 */
export class SandboxLaunchError extends Error {
  readonly uiCode: SandboxUiCode
  constructor(uiCode: SandboxUiCode, message: string) {
    super(message)
    this.name = 'SandboxLaunchError'
    this.uiCode = uiCode
  }
}
