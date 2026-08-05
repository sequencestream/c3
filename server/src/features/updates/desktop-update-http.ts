/**
 * Desktop-update HTTP endpoints — the thin HTTP surface the Tauri shell talks to.
 *
 * The shell owns the update state machine, the staging directory and the installer;
 * the sidecar owns the VERSION FACTS, the TRANSPORT and the INTEGRITY RULES, via the
 * shared kernel (`upgrade-core.ts`). These two endpoints are that boundary:
 *
 *   `GET /api/update/check`   → is a newer release available, and which `desktop`
 *                               artifact matches this platform/arch? Never throws a
 *                               5xx — a failed check is data (`available:false` +
 *                               `error`) the shell can surface and let the user retry.
 *   `GET /api/update/download`→ stream a release package to the shell after
 *                               cross-checking the release's `.sha256` sidecar
 *                               against the manifest checksum the shell passed in.
 *                               The shell writes the bytes to its own staging dir
 *                               (never `~/.c3`) and compares the final sha256 itself.
 *
 * Both routes are loopback-guarded: even though c3 binds 127.0.0.1 by default, a
 * user-configured wider bind must not expose update download to the network.
 */
import { getConnInfo } from '@hono/node-server/conninfo'
import type { Context } from 'hono'
import {
  DEFAULT_REPO,
  UpgradeError,
  decideAction,
  downloadBuffer,
  fetchReleaseManifest,
  githubHeaders,
  normalizeVersion,
  parseSha256Line,
  releaseDownloadUrl,
  resolveLatestRelease,
  selectDesktopArtifact,
} from '../../upgrade-core.js'

/** The route the desktop shell calls to ask "is an update available?". */
export const DESKTOP_UPDATE_CHECK_PATH = '/api/update/check'
/** The route the desktop shell calls to stream a verified package. */
export const DESKTOP_UPDATE_DOWNLOAD_PATH = '/api/update/download'

export interface DesktopUpdateHttpDeps {
  fetchFn?: typeof fetch
  env?: NodeJS.ProcessEnv
  repo?: string
}

export interface DesktopUpdateHttp {
  check(c: Context): Promise<Response>
  download(c: Context): Promise<Response>
}

/** Defence-in-depth loopback predicate (same set the other loopback routes use). */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
function isLoopback(address: string | undefined): boolean {
  if (!address) return false
  return LOOPBACK.has(address) || address.startsWith('127.')
}

/** The only download origins the updater will stream from (the trust root). */
const GITHUB_DOWNLOAD_PREFIX = 'https://github.com/'

export function createDesktopUpdateHttp(deps: DesktopUpdateHttpDeps = {}): DesktopUpdateHttp {
  const fetchFn = deps.fetchFn ?? fetch
  const env = deps.env ?? process.env
  const repo = deps.repo ?? DEFAULT_REPO

  function rejectNonLoopback(c: Context): Response | null {
    const remote = getConnInfo(c).remote.address
    return isLoopback(remote) ? null : c.json({ error: 'update API is loopback-only' }, 403)
  }

  async function check(c: Context): Promise<Response> {
    const guard = rejectNonLoopback(c)
    if (guard) return guard

    const current = normalizeVersion(c.req.query('current') ?? '')
    const platform = c.req.query('platform') ?? ''
    const arch = c.req.query('arch') ?? ''
    if (!current || !platform || !arch) {
      return c.json({ available: false, error: 'missing current/platform/arch' }, 400)
    }

    try {
      const resolved = await resolveLatestRelease(repo, fetchFn, env)
      const latest = normalizeVersion(resolved.tag)
      const action = decideAction({ current, latest })
      if (action !== 'update') {
        return c.json({
          available: false,
          currentVersion: current,
          targetVersion: latest,
          error: null,
        })
      }
      const manifest = await fetchReleaseManifest(repo, resolved.tag, fetchFn, env)
      const artifact = selectDesktopArtifact(manifest, { platform, arch, version: latest })
      return c.json({
        available: true,
        currentVersion: current,
        targetVersion: latest,
        error: null,
        artifact: {
          file: artifact.file,
          kind: artifact.kind ?? null,
          bytes: artifact.bytes,
          sha256: artifact.sha256,
          url: releaseDownloadUrl(repo, resolved.tag, artifact.file),
        },
      })
    } catch (e) {
      // A failed check is a user-visible, retryable state — not a server error.
      const message = e instanceof UpgradeError ? e.message : (e as Error).message
      return c.json({
        available: false,
        currentVersion: current,
        targetVersion: null,
        error: message,
      })
    }
  }

  async function download(c: Context): Promise<Response> {
    const guard = rejectNonLoopback(c)
    if (guard) return guard

    const url = c.req.query('url') ?? ''
    const bytes = Number(c.req.query('bytes') ?? '0')
    const sha256 = (c.req.query('sha256') ?? '').toLowerCase()
    if (
      !url.startsWith(GITHUB_DOWNLOAD_PREFIX) ||
      !/^[0-9a-f]{64}$/.test(sha256) ||
      !Number.isFinite(bytes)
    ) {
      return c.json({ error: 'bad download parameters' }, 400)
    }

    // Gate #1: the release's own `.sha256` sidecar must EXIST and must equal the
    // manifest checksum the shell verified earlier. A mismatch here means the
    // release changed between check and download — fail closed before any byte
    // of the package is streamed to the shell.
    try {
      const sidecar = await downloadBuffer(`${url}.sha256`, fetchFn, env)
      const expected = parseSha256Line(sidecar.toString('utf-8'))
      if (!expected || expected !== sha256) {
        return c.json({ error: 'release .sha256 does not match the manifest checksum' }, 422)
      }
    } catch (e) {
      const message = e instanceof UpgradeError ? e.message : (e as Error).message
      return c.json({ error: message }, 422)
    }

    // Stream the package. The shell reads the body, counts bytes against
    // `Content-Length` (== `bytes`) for progress, and independently verifies the
    // final sha256 against `X-C3-Sha256` after writing — so a truncated or
    // corrupted transfer never becomes an installable artifact.
    let upstream: Response
    try {
      upstream = await fetchFn(url, { headers: githubHeaders(env) })
    } catch (e) {
      return c.json({ error: `download failed: ${(e as Error).message}` }, 502)
    }
    if (!upstream.ok || !upstream.body) {
      return c.json({ error: `download failed: HTTP ${upstream.status}` }, 502)
    }
    return new Response(upstream.body as ReadableStream<Uint8Array>, {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(bytes),
        'X-C3-Sha256': sha256,
      },
    })
  }

  return { check, download }
}
