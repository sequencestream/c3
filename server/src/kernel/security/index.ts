/**
 * `kernel/security/` — the neutral home for credential-hygiene primitives.
 *
 * Both primitives were originally owned by individual features
 * (`pr-events/tool-defs`, `memory/content-guard`) and imported sideways by
 * others. This barrel is the single consumer entry; rule changes belong here.
 */
export { redactSecrets } from './credential-redact.js'
export { detectCredentialShape } from './credential-shape.js'
