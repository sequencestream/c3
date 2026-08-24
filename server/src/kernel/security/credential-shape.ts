/**
 * Credential-shape detection — the conservative shape recognizer shared by
 * every write/outbound gate: the memory write guard (which additionally checks
 * artifact shapes) and the IM inbound/outbound gates.
 *
 * Lives in `kernel/` (pure, dependency-free) as the single owner of the
 * credential patterns. Detection is conservative by construction: it recognizes
 * shapes, it cannot prove prose is safe — so callers must not treat a clean
 * result as proof a secret is absent.
 */

/**
 * Credential shapes: private-key blocks, bearer tokens, vendor access tokens and
 * credential-name assignments. The assignment rule demands a secret-LOOKING
 * value (12+ token characters), so ordinary prose that merely mentions a
 * credential by name — "token 由环境变量注入" — stays writable.
 */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  /\bbearer\s+[A-Za-z0-9._~+/-]{16,}=*/i,
  /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})\b/,
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bc3k_[A-Za-z0-9_-]{16,}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
  /\b(?:api[_-]?key|secret|password|passwd|token|credential|private[_-]?key)\b\s*[:=]\s*["']?[A-Za-z0-9_\-./+]{12,}/i,
]

/**
 * Whether the text carries something shaped like a credential. Answers a
 * different question than the memory guard's artifact rules: this one asks
 * "would sending this leak a secret", which applies anywhere text leaves the
 * machine — the IM outbound path uses it alone, since an answer legitimately
 * containing a code fence must still be deliverable.
 */
export function detectCredentialShape(value: string): boolean {
  return CREDENTIAL_PATTERNS.some((p) => p.test(value))
}
