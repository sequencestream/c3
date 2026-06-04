/**
 * `kernel/` barrel — slice 1/3 (ADR-0009).
 *
 * Re-export shim so any future `import { ... } from '../kernel/index.js'` path
 * is already valid. Kernel is pure domain: it MUST NOT import from `transport/`
 * or `features/` (ADR-0009 R1), and MUST NOT touch ws/HTTP semantics (R2).
 */
export type { AppContext, LaunchRunDeps, LaunchCbs, DiscussionRunControl } from './types.js'
export { assertNoTransportFields } from './types.js'
