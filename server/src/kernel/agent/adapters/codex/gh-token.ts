/**
 * Bridge the host's GitHub CLI credential into a Codex session's environment.
 *
 * `gh` stores its token in the OS keyring (macOS keychain). A Codex run executes
 * under codex's own seatbelt sandbox (and optionally a docker container), whose
 * processes cannot read the host keychain — so `gh` inside the session reports
 * "please run gh auth login" even when the host is fully authenticated and the
 * sandbox has network. gh reads `GH_TOKEN`/`GITHUB_TOKEN` from the environment
 * BEFORE consulting the keyring, so injecting the token as an env var restores
 * auth inside the sandbox.
 *
 * Codex-only: the claude path has no seatbelt boundary, and this must NOT live in
 * the vendor-shared {@link buildChildEnv}. The token is a session-scoped env
 * override delivered through the existing `DriverStartOptions.envOverrides`
 * channel; it is never written to disk, logged, or surfaced in telemetry.
 */
import { execFile } from 'node:child_process'
import { buildChildEnv } from '../../../infra/child-env.js'

/** Bounded so a hung keyring/gh prompt cannot stall session startup. */
const GH_AUTH_TOKEN_TIMEOUT_MS = 5_000

/** The outcome of running `gh auth token` on the host. */
export interface GhAuthTokenResult {
  /** The command spawned and exited 0. */
  ok: boolean
  /** Raw stdout (untrimmed); trimming happens in {@link resolveCodexGhTokenEnv}. */
  stdout: string
}

/**
 * Run `gh auth token` and report the result. The seam the unit tests replace to
 * cover the host command-execution boundary without a real `gh`. Never rejects.
 */
export type GhAuthTokenRunner = () => Promise<GhAuthTokenResult>

/**
 * Default runner: spawn `gh auth token` on the host (outside any sandbox) with a
 * bounded timeout. A missing command, non-zero exit, timeout, or spawn error all
 * surface as `ok: false` — the caller treats any of them as "no credential".
 */
const defaultGhAuthTokenRunner: GhAuthTokenRunner = () =>
  new Promise((done) => {
    execFile('gh', ['auth', 'token'], { timeout: GH_AUTH_TOKEN_TIMEOUT_MS }, (err, stdout) => {
      done({ ok: !err, stdout: stdout?.toString() ?? '' })
    })
  })

function hasValue(v: string | undefined): boolean {
  return typeof v === 'string' && v.trim().length > 0
}

/**
 * Resolve the env overrides for a Codex session, injecting `GH_TOKEN` from the
 * host `gh` credential when neither `GH_TOKEN` nor `GITHUB_TOKEN` is already set.
 *
 * Precedence follows {@link buildChildEnv}: an explicit value from the user's
 * shell (`process.env`) or an agent override always wins and suppresses the probe.
 * Only when both variables are absent do we run `gh auth token`; a successful,
 * non-empty (post-trim) token is appended as `GH_TOKEN`. Probe failure — command
 * missing, non-zero exit, timeout, or empty output — is non-fatal: the caller's
 * overrides pass through unchanged (never overwriting an existing value) and the
 * session still starts.
 */
export async function resolveCodexGhTokenEnv(
  envOverrides?: Record<string, string>,
  runGhAuthToken: GhAuthTokenRunner = defaultGhAuthTokenRunner,
): Promise<Record<string, string> | undefined> {
  const effective = buildChildEnv(envOverrides)
  if (hasValue(effective.GH_TOKEN) || hasValue(effective.GITHUB_TOKEN)) return envOverrides
  const { ok, stdout } = await runGhAuthToken()
  if (!ok) return envOverrides
  const token = stdout.trim()
  if (!token) return envOverrides
  return { ...(envOverrides ?? {}), GH_TOKEN: token }
}
