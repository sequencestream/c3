/**
 * The one read-only scan the session launch paths share.
 *
 * Launch is NOT gated on this: the analyzer is pure, the write is a sidechannel
 * that swallows its own failures, and the warnings never reach a prompt. So the
 * worst outcome of anything below is a `console.warn` — a session always starts.
 */

import { readFileSync } from 'node:fs'
import { analyzeSpec } from './spec-analyzer.js'
import { recordSpecWarnings } from './spec-metrics-store.js'
import { resolveSpecFileAbs } from './specs-root.js'
import { specFingerprint } from './spec-review.js'

/**
 * Scan one spec file and record the warnings. Returns the warning count so a
 * caller (or a test) can observe that the scan ran, not merely that it was
 * called. An unreadable file scans as zero warnings — an unreadable spec is not
 * a defective one, and the launch path has already refused those upstream.
 */
export function scanSpecForWarnings(
  workspacePath: string,
  specPath: string,
  intentId: string,
): number {
  try {
    const abs = resolveSpecFileAbs(workspacePath, specPath)
    const content = readFileSync(abs, 'utf8')
    const warnings = analyzeSpec(content)
    if (warnings.length === 0) return 0
    recordSpecWarnings(
      warnings.map((warning) => ({
        intentId,
        fingerprint: specFingerprint(content),
        warning,
      })),
    )
    return warnings.length
  } catch (err) {
    console.warn(
      `[c3:intents] spec read-only scan failed: ${err instanceof Error ? err.message : String(err)}`,
    )
    return 0
  }
}
