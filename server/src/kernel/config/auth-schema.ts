/**
 * Runtime (zod) validation for the `kind`-discriminated {@link AuthConfig}
 * (ADR-0023). The **type** lives in `shared/protocol.ts` (zero-runtime, SDK-free
 * — ADR-0009); the **runtime schema** lives here so zod never enters the wire
 * module. A type-level assertion at the bottom pins the two together so they
 * cannot drift (same discipline as `agent-config/schema.ts`).
 *
 * Only `basic` has a provider arm this phase. `oauth`/`sso`/multi-user are the
 * **extension point**: a new provider adds its `z.object` arm to
 * {@link AUTH_PROVIDER_SCHEMAS}, appends it to {@link authProviderSchema}, and
 * the type pin forces the matching wire arm in `shared/protocol.ts`. Until then
 * an unknown `kind` simply fails to parse — `normalizeAuth` drops it (fail-soft,
 * equivalent to "auth disabled"), keeping the C-SEC-5 localhost-only default.
 *
 * Contract-only: no middleware, login, hashing, or token signing exists yet
 * (ADR-0023). This module only validates the persisted shape.
 */
import { z } from 'zod'
import type { AuthConfig, AuthProvider } from '@ccc/shared/protocol'

/** The single-admin `basic` provider arm: username + PHC password hash. */
export const basicAuthProviderSchema = z.object({
  kind: z.literal('basic'),
  username: z.string(),
  passwordHash: z.string(),
})

/**
 * Per-kind provider-arm registry — the **extension point**. A new auth method
 * registers its arm here (and in {@link authProviderSchema}). Partial over
 * {@link AuthProviderKind} on purpose: a kind without an entry has no shape yet.
 */
export const AUTH_PROVIDER_SCHEMAS = {
  basic: basicAuthProviderSchema,
} satisfies Partial<Record<AuthProvider['kind'], z.ZodTypeAny>>

/**
 * The full {@link AuthProvider} schema, routed by the `kind` discriminant.
 * `safeParse` dispatches an object to its kind's arm and rejects an unknown
 * kind or a provider that fails its arm. Single `basic` arm this phase; new
 * providers append their arm.
 */
export const authProviderSchema = z.discriminatedUnion('kind', [basicAuthProviderSchema])

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
 * Validate one persisted `auth` candidate. Returns the typed {@link AuthConfig}
 * on success, or `null` when it is absent or malformed (the normalize layer
 * treats `null` as "no auth" — the C-SEC-5 localhost-only default, fail-soft).
 */
export function normalizeAuth(raw: unknown): AuthConfig | null {
  if (raw === undefined || raw === null) return null
  const result = authConfigSchema.safeParse(raw)
  return result.success ? result.data : null
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
