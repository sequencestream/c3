// Minimal type declarations for the JS module artifact-name.mjs. Only the exports
// consumed by TypeScript callers (server upgrade cross-consistency test) are typed.
export function normalizeVersion(version: string): string
export function binaryName(target: string): string
export function packageExt(target: string): string
export function packageName(version: string, target: string): string
export const artifactName: typeof packageName
