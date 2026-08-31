/**
 * Recover a PR's real-world identity (`forge` + `repo`) from its web URL.
 *
 * `intent_prs` keys a PR by `(forge, repo, number)`, but neither of the first two
 * was ever persisted by the legacy model — the forge was probed live off `origin`
 * and the repo existed only inside the URL. So both the one-shot backfill from the
 * legacy columns and every create path recover them the same way, from the one
 * artefact that always carried them: the URL the forge CLI printed.
 *
 * A URL that yields nothing is not an error. The columns stay `null`, meaning
 * "origin unknown"; such a row simply does not participate in the identity key,
 * and the next write through `upsertIntentPr` fills it in.
 */
import type { IntentPrForge } from '@ccc/shared/protocol'

export interface PrIdentity {
  forge: IntentPrForge | null
  repo: string | null
}

/** The path markers each forge puts between the repo path and the change-request number. */
const CHANGE_REQUEST_MARKERS = ['/pull/', '/-/merge_requests/', '/merge_requests/']

/**
 * Parse a user-supplied PR reference — bare number (`42`, `#42`) or a forge URL —
 * into the repository-local PR/MR number string. Returns `null` when the input
 * cannot be interpreted.
 */
export function parsePrReference(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  const numMatch = trimmed.match(/^#?(\d+)$/)
  if (numMatch) return numMatch[1]
  for (const marker of CHANGE_REQUEST_MARKERS) {
    const at = trimmed.indexOf(marker)
    if (at < 0) continue
    const rest = trimmed.slice(at + marker.length)
    const num = rest.match(/^(\d+)/)
    if (num) return num[1]
  }
  return null
}

/**
 * Parse `forge` and `repo` out of a PR/MR URL. GitHub is identified by its
 * hostname; every other host — including self-hosted GitLab — reads as GitLab,
 * matching `detectForge`'s origin-based rule so the two never disagree about the
 * same repository. Returns `{forge: null, repo: null}` for an absent or
 * unparseable URL.
 */
export function parsePrIdentity(url: string | null | undefined): PrIdentity {
  const raw = url?.trim()
  if (!raw) return { forge: null, repo: null }
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return { forge: null, repo: null }
  }
  const forge: IntentPrForge = parsed.hostname.includes('github.com') ? 'github' : 'gitlab'
  const path = parsed.pathname
  for (const marker of CHANGE_REQUEST_MARKERS) {
    const at = path.indexOf(marker)
    if (at <= 0) continue
    const repo = path.slice(0, at).replace(/^\/+|\/+$/g, '')
    return { forge, repo: repo || null }
  }
  // A host we can name but a path shape we cannot: keep the forge (it is a real
  // fact) and leave the repo unknown rather than guessing at path segments.
  return { forge, repo: null }
}
