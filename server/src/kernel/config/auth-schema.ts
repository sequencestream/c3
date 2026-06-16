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
import type { AuthConfig, AuthProvider } from '@ccc/shared/protocol'

/** The `none` provider arm: no auth, no config — `kind` alone is the shape. The
 *  `kind:'none' ⇔ enabled:false` invariant is enforced in {@link normalizeAuth},
 *  not here (this arm only validates the persisted shape). */
export const noneAuthProviderSchema = z.object({
  kind: z.literal('none'),
})

/** The single-admin `basic` provider arm: username + PHC password hash. */
export const basicAuthProviderSchema = z.object({
  kind: z.literal('basic'),
  username: z.string(),
  passwordHash: z.string(),
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
 * Validate one persisted `auth` candidate. Returns the typed {@link AuthConfig}
 * on success, or `null` when it is absent or malformed (the normalize layer
 * treats `null` as "no auth" — the C-SEC-5 localhost-only default, fail-soft).
 *
 * Single truth source for the `none` provider: a `kind:'none'` block always
 * normalizes to `enabled:false`, so a stale `enabled:true` on disk can never
 * contradict "no auth". The UI reads `provider.kind`, never a second flag.
 */
export function normalizeAuth(raw: unknown): AuthConfig | null {
  if (raw === undefined || raw === null) return null
  const result = authConfigSchema.safeParse(raw)
  if (!result.success) return null
  const auth = result.data
  if (auth.provider.kind === 'none' && auth.enabled) return { ...auth, enabled: false }
  return auth
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
