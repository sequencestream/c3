import { DSH_MIN_NODE } from './capabilities.js'

/** Parse `process.version` / `vX.Y.Z` into comparable parts. */
export function parseNodeVersion(
  version: string,
): { major: number; minor: number; patch: number } | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim())
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) }
}

/** Whether `version` satisfies {@link DSH_MIN_NODE}. */
export function nodeMeetsDshEngine(version: string): boolean {
  const parsed = parseNodeVersion(version)
  if (!parsed) return false
  if (parsed.major !== DSH_MIN_NODE.major) return parsed.major > DSH_MIN_NODE.major
  return parsed.minor >= DSH_MIN_NODE.minor
}
