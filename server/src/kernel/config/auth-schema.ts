/**
 * Runtime (zod) validation for the `kind`-discriminated {@link AuthConfig}
 * (ADR-0023). The **type** lives in `shared/protocol.ts` (zero-runtime, SDK-free
 * — ADR-0009); the **runtime schema** lives here so zod never enters the wire
 * module. A type-level assertion at the bottom pins the two together so they
 * cannot drift (same discipline as `agent-config/schema.ts`).
 *
 * `basic` and `oauth` (generic OIDC, contract-only) have provider arms this
 * phase. `sso`/multi-user remain the **extension point**: a new provider adds its
 * `z.object` arm to {@link AUTH_PROVIDER_SCHEMAS}, appends it to
 * {@link authProviderSchema}, and the type pin forces the matching wire arm in
 * `shared/protocol.ts`. Until then an unknown `kind` simply fails to parse —
 * `normalizeAuth` drops it (fail-soft, equivalent to "auth disabled"), keeping
 * the C-SEC-5 localhost-only default.
 *
 * Contract-only: no middleware, login, hashing, or token signing exists yet
 * (ADR-0023). This module only validates the persisted shape.
 */
import { z } from 'zod'
import type { AuthConfig, AuthProvider, BasicAuthProvider } from '@ccc/shared/protocol'

/** The `none` provider arm: no auth, no config — `kind` alone is the shape. The
 *  `kind:'none' ⇔ enabled:false` invariant is enforced in {@link normalizeAuth},
 *  not here (this arm only validates the persisted shape). */
export const noneAuthProviderSchema = z.object({
  kind: z.literal('none'),
})

/** One `basic` account: username + PHC password hash. */
export const basicAuthAccountSchema = z.object({
  username: z.string(),
  passwordHash: z.string(),
})

/**
 * The `basic` provider arm: **multiple accounts + one admin**. Kept a plain
 * `z.object` (no preprocess/transform) so it stays a valid `discriminatedUnion`
 * member and the bottom type-pin holds. Legacy single-account migration runs in
 * {@link normalizeAuth} BEFORE parse (zod v4 cannot extract the `kind` discriminant
 * from a `z.preprocess`-wrapped arm). `accounts`/`adminUsername` default so an
 * absent/partial block normalizes to the unconfigured state.
 */
export const basicAuthProviderSchema = z.object({
  kind: z.literal('basic'),
  accounts: z.array(basicAuthAccountSchema).default([]),
  adminUsername: z.string().default(''),
})

/** Default OAuth scopes — OIDC core identity + verified email. */
export const DEFAULT_OAUTH_SCOPES = ['openid', 'profile', 'email']

/**
 * The generic-OIDC `oauth` provider arm — contract-only (no runtime). `scopes`,
 * `usePkce`, and `allowedEmails` carry zod defaults so a persisted block always
 * normalizes to fully-populated, matching the wire type's required fields (the
 * type pin checks the inferred *output* type). `clientSecretRef` is a reference
 * (env var name / keystore id), never the plaintext secret. An empty
 * `allowedEmails` is valid here — it means "nobody authorized", a decision the
 * future runtime enforces; the contract does not reject it.
 */
export const oauthAuthProviderSchema = z.object({
  kind: z.literal('oauth'),
  issuer: z.string(),
  clientId: z.string(),
  clientSecretRef: z.string(),
  redirectUri: z.string(),
  scopes: z.array(z.string()).default(DEFAULT_OAUTH_SCOPES),
  usePkce: z.boolean().default(true),
  allowedEmails: z.array(z.string()).default([]),
  // The single admin email (OAuth analogue of basic's adminUsername). Defaults to
  // '' so a freshly-switched/legacy oauth block normalizes; the save layer enforces
  // non-empty + ∈ allowedEmails. oauth is contract-only (enabled always false), so
  // an invalid adminEmail has no runtime effect and is NOT a normalize fail-soft trigger.
  adminEmail: z.string().default(''),
})

/**
 * Per-kind provider-arm registry — the **extension point**. A new auth method
 * registers its arm here (and in {@link authProviderSchema}). Partial over
 * {@link AuthProviderKind} on purpose: a kind without an entry has no shape yet.
 */
export const AUTH_PROVIDER_SCHEMAS = {
  none: noneAuthProviderSchema,
  basic: basicAuthProviderSchema,
  oauth: oauthAuthProviderSchema,
} satisfies Partial<Record<AuthProvider['kind'], z.ZodTypeAny>>

/**
 * The full {@link AuthProvider} schema, routed by the `kind` discriminant.
 * `safeParse` dispatches an object to its kind's arm and rejects an unknown
 * kind or a provider that fails its arm. `none` + `basic` + `oauth` arms this
 * phase; new providers append their arm.
 */
export const authProviderSchema = z.discriminatedUnion('kind', [
  noneAuthProviderSchema,
  basicAuthProviderSchema,
  oauthAuthProviderSchema,
])

/** Session-token policy: TTL (seconds) + a reference to the signing key. */
export const authSessionPolicySchema = z.object({
  ttlSeconds: z.number(),
  signingKeyRef: z.string(),
})

/** Default session-token lifetime: 30 days. Long enough that closing the tab and
 *  returning later no longer re-prompts (the previous 1h default expired between
 *  visits). Sessions still live only in-process (session-store.ts), so a server
 *  restart invalidates them regardless of this TTL. */
export const DEFAULT_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60
/** The former default (1h). A persisted block carrying exactly this value predates
 *  the 30-day bump; since the TTL has no editing UI it can only be the old default,
 *  never a deliberate user choice, so `normalize` migrates it up one-shot. */
export const LEGACY_DEFAULT_SESSION_TTL_SECONDS = 3600

/** Network-exposure / bind-address intent. */
export const authExposureConfigSchema = z.object({
  bindAddress: z.string().optional(),
})

/**
 * The full {@link AuthConfig} schema. Strict on the provider arm (unknown kind /
 * malformed provider ⇒ reject), so `normalizeAuth` can fail-soft to disabled.
 */
export const authConfigSchema = z.object({
  enabled: z.boolean(),
  provider: authProviderSchema,
  session: authSessionPolicySchema,
  exposure: authExposureConfigSchema.optional(),
})

/**
 * Whether a `basic` provider is effectively enabled: at least one account AND a
 * non-empty `adminUsername` that references one of them. The single derivation of
 * basic's `enabled` (AUTH-R: enabled ⇔ configured admin), mirrored by the auth
 * handlers when they persist and re-applied here on load. Empty accounts ⇒ the
 * unconfigured state ⇒ false (parallels `kind:'none' ⇔ enabled:false`).
 */
export function deriveBasicEnabled(provider: BasicAuthProvider): boolean {
  if (provider.accounts.length === 0 || !provider.adminUsername) return false
  return provider.accounts.some((a) => a.username === provider.adminUsername)
}

/** True iff `accounts` has no two entries sharing a (trim'd, case-sensitive) username. */
function usernamesUnique(provider: BasicAuthProvider): boolean {
  const names = provider.accounts.map((a) => a.username)
  return new Set(names).size === names.length
}

/**
 * One-shot legacy migration (pre-parse): the former single-account `basic` shape
 * `{ kind:'basic', username, passwordHash }` (no `accounts` field) → the
 * multi-account shape. Discriminant = `accounts` ABSENT (so an already-migrated
 * block is left untouched — idempotent). An empty `passwordHash` (a bootstrap
 * mid-state) migrates to NO account + empty admin, so no dangling admin is created.
 * Runs before zod parse because zod v4 cannot extract the `kind` discriminant from
 * a `z.preprocess`-wrapped union arm.
 */
function migrateLegacyBasicProvider(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw
  const candidate = raw as { provider?: unknown }
  const provider = candidate.provider
  if (typeof provider !== 'object' || provider === null) return raw
  const p = provider as Record<string, unknown>
  if (p.kind !== 'basic' || 'accounts' in p) return raw
  const username = typeof p.username === 'string' ? p.username : ''
  const passwordHash = typeof p.passwordHash === 'string' ? p.passwordHash : ''
  const migrated =
    username && passwordHash
      ? { kind: 'basic', accounts: [{ username, passwordHash }], adminUsername: username }
      : { kind: 'basic', accounts: [], adminUsername: '' }
  return { ...candidate, provider: migrated }
}

/**
 * Validate one persisted `auth` candidate. Returns the typed {@link AuthConfig}
 * on success, or `null` when it is absent or malformed (the normalize layer
 * treats `null` as "no auth" — the C-SEC-5 localhost-only default, fail-soft).
 *
 * Invariants enforced here (the fail-soft backstop for hand-edited settings.json;
 * the UI path is gated earlier by the save-layer handlers):
 * - `none` ⇒ `enabled:false` (a stale `enabled:true` on disk can never contradict "no auth").
 * - `basic` ⇒ usernames unique AND `adminUsername` references an account when accounts
 *   are non-empty; a violation has a runtime login consequence (a dangling admin), so the
 *   whole block is dropped to `null` (no auth). `enabled` is then re-derived (AC3.5).
 * - `oauth` ⇒ `enabled` forced false (contract-only, AC5.4). An invalid `adminEmail` is
 *   NOT a fail-soft trigger (no runtime effect; would needlessly wipe issuer/clientId) —
 *   it is rejected only at the save layer.
 */
export function normalizeAuth(raw: unknown): AuthConfig | null {
  if (raw === undefined || raw === null) return null
  const migrated = migrateLegacyBasicProvider(raw)
  const result = authConfigSchema.safeParse(migrated)
  if (!result.success) return null
  const auth = result.data
  if (auth.provider.kind === 'none') return auth.enabled ? { ...auth, enabled: false } : auth
  if (auth.provider.kind === 'oauth') return auth.enabled ? { ...auth, enabled: false } : auth
  // basic: enforce the unique-username + admin-reference invariants, fail-soft on violation.
  const provider = auth.provider
  if (!usernamesUnique(provider)) return null
  if (provider.accounts.length > 0 && !deriveBasicEnabled(provider)) return null
  const enabled = deriveBasicEnabled(provider)
  return enabled === auth.enabled ? auth : { ...auth, enabled }
}

/**
 * One-shot migration: a persisted session TTL equal to the former 1h default
 * (it had no editing UI, so this value can only be the old hard-coded default,
 * never a deliberate user choice) is bumped to the 30-day default so existing
 * installs stop re-prompting hourly. Any other value is left untouched.
 */
export function migrateLegacySessionTtl(auth: AuthConfig): AuthConfig {
  if (auth.session.ttlSeconds !== LEGACY_DEFAULT_SESSION_TTL_SECONDS) return auth
  return { ...auth, session: { ...auth.session, ttlSeconds: DEFAULT_SESSION_TTL_SECONDS } }
}

// ---- Type pin: the zod schema's inferred type IS the wire `AuthConfig` ----
// Both directions must hold; either failing is a compile error, so the runtime
// schema and the zero-runtime wire type can never drift.
type _AssertExtends<A extends B, B> = A & B
type _PinSchemaIsWire = _AssertExtends<z.infer<typeof authConfigSchema>, AuthConfig>
type _PinWireIsSchema = _AssertExtends<AuthConfig, z.infer<typeof authConfigSchema>>
// Reference the aliases so `noUnusedLocals`/lint do not flag them.
export type __AuthConfigSchemaPin = [_PinSchemaIsWire, _PinWireIsSchema]
