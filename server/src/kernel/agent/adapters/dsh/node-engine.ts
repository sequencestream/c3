import { spawnSync } from 'node:child_process'
import { DSH_MIN_NODE } from './capabilities.js'

/** Parse a `node -v` / `vX.Y.Z` string into comparable parts. */
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

/**
 * The version printed by a `node -v` probe, or null when the probe failed or
 * the text is not a version.
 */
export function nodeVersionFromProbe(status: number | null, stdout: string): string | null {
  if (status !== 0) return null
  const version = stdout.trim()
  return parseNodeVersion(version) ? version : null
}

/**
 * `node` on PATH. The dsh CLI is a `#!/usr/bin/env node` script, so this is the
 * interpreter that runs it. The c3 process may instead be the compiled binary,
 * whose `process.version` is Bun's Node compatibility string.
 *
 * Read once per process: the PATH node does not change while c3 is running,
 * and availability is checked on the session-switch path.
 */
let cachedPathNodeVersion: string | null | undefined

export function pathNodeVersion(): string | null {
  if (cachedPathNodeVersion !== undefined) return cachedPathNodeVersion
  cachedPathNodeVersion = probePathNode()
  return cachedPathNodeVersion
}

function probePathNode(): string | null {
  try {
    const result = spawnSync('node', ['-v'], {
      encoding: 'utf-8',
      timeout: 5_000,
      windowsHide: true,
    })
    return nodeVersionFromProbe(result.status, result.stdout ?? '')
  } catch {
    return null
  }
}
