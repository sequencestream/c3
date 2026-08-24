/**
 * Free-text secret redaction — the single C-SEC-4 execution path for any text
 * that leaves c3: event normalization, IM outbound replies and audit messages.
 *
 * Lives in `kernel/` (pure, dependency-free) because every feature-side outbound
 * path shares it; a feature importing another feature's internal function was
 * the exact backwards edge this move removes. Rule changes must stay here.
 */

/** Replacement text for every redacted match. */
const REDACTED = '[redacted]'

/** Token / secret patterns redacted from any free-text field before it leaves c3. */
const SECRET_PATTERNS: RegExp[] = [
  // GitHub / GitLab personal-access & app tokens.
  /\bgh[opusr]_[A-Za-z0-9]{16,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{16,}\b/g,
  // OpenAI / Anthropic-style keys.
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  // key=value / key: value secrets.
  /\b(?:token|secret|password|passwd|api[-_]?key|authorization)\b\s*[:=]\s*\S+/gi,
  // `bearer <token>` (space-separated).
  /\bbearer\s+[A-Za-z0-9._~+/=-]+/gi,
  // JWTs.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  // Long hex blobs (e.g. raw OAuth/40+ char hashes).
  /\b[0-9a-fA-F]{40,}\b/g,
]

/** Redact secret-shaped substrings from a free-text value. */
export function redactSecrets(s: string): string {
  let out = s
  for (const re of SECRET_PATTERNS) out = out.replace(re, REDACTED)
  return out
}
