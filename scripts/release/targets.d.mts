// Minimal type declarations for the JS module targets.mjs. Only the exports
// consumed by TypeScript callers (server upgrade cross-consistency test) are typed.
export const P0_TARGETS: string[]
export const P1_TARGETS: string[]
export const EXPERIMENTAL_TARGETS: string[]
export const KNOWN_TARGETS: string[]
export const DEFAULT_TARGETS: string[]
export function isExperimental(target: string): boolean
export function hostTarget(platform?: string, arch?: string): string
export function isHostRunnable(target: string, platform?: string, arch?: string): boolean
