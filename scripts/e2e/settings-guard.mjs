/**
 * The e2e settings guard — a process-level gate for every e2e that calls
 * `save_settings`.
 *
 * Those tests rewrite the running server's configuration (default agent,
 * consensus switch, agent list, sandbox definitions) and undo it from an exit
 * handler. That undo never runs when the test is killed on timeout, Ctrl-C'd, or
 * crashes — so pointing one at a server on the real `~/.c3/settings.json`
 * silently corrupts the developer's own config. The guard closes that hole
 * before the first byte is written: ask the server where its settings.json
 * actually lives, and refuse to run when that is the real one.
 *
 * Zero dependencies (Node built-ins only) so both the plain `.mjs` test scripts
 * and vitest can load it without a build step.
 */
import { homedir } from 'node:os'
import { realpathSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

/** Exit code a refusal exits with — distinct from 0 PASS, 5 SKIP, 1 FAIL. */
export const GUARD_REFUSED_EXIT_CODE = 3

/** The one path e2e must never write: the developer's own config. */
export function realSettingsPath() {
  return join(homedir(), '.c3', 'settings.json')
}

/**
 * Canonicalize a path for comparison: expand `~`, make it absolute, and resolve
 * symlinks where the path exists (macOS `/var` → `/private/var` is the case that
 * bites — a temp dir compared against a realpath'd home would otherwise look
 * unrelated by luck rather than by intent). A non-existent path keeps its
 * lexical form; that is enough, since the real settings.json is what we compare
 * against and a missing file cannot be the one being written.
 */
function canonicalize(path) {
  const expanded = path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
  const absolute = isAbsolute(expanded) ? expanded : resolve(expanded)
  try {
    return realpathSync(absolute)
  } catch {
    return resolve(absolute)
  }
}

/**
 * Decide from the server's reported settings path alone — no I/O beyond
 * canonicalization, so the whole rule is directly testable.
 *
 * `settingsPath` absent means an older server that does not report the field.
 * That is refused too rather than assumed safe: "no proof of isolation" and
 * "proof of the real config" carry the same risk, and the fix (`pnpm build`) is
 * one command.
 *
 * @param {string | undefined | null} settingsPath value from the `settings` reply
 * @returns {{ allowed: boolean, reason: string }}
 */
export function decideGuard(settingsPath) {
  if (typeof settingsPath !== 'string' || settingsPath.length === 0) {
    return {
      allowed: false,
      reason:
        'the server did not report its settings path (older build) — cannot prove it is isolated',
    }
  }
  if (canonicalize(settingsPath) === canonicalize(realSettingsPath())) {
    return {
      allowed: false,
      reason: `the server is running on the real config: ${settingsPath}`,
    }
  }
  return { allowed: true, reason: `isolated settings: ${settingsPath}` }
}

/**
 * The refusal message: why it refused, plus the two commands that fix it. Kept
 * as a pure function so the meta-test can assert the operator actually gets a
 * runnable way out instead of just a complaint.
 */
export function refusalMessage(reason, { testScript, port = 13000 } = {}) {
  const script = testScript ?? 'scripts/e2e/<test>.mjs'
  return [
    `[e2e-guard] REFUSED — ${reason}`,
    '[e2e-guard] this test rewrites the server settings; it will not touch the real ~/.c3/settings.json.',
    '[e2e-guard] start an isolated server instead, then re-run:',
    `[e2e-guard]   pnpm build && node scripts/e2e/isolated-server.mjs --port ${port}`,
    `[e2e-guard]   node ${script} ws://localhost:${port}/ws`,
  ].join('\n')
}

/**
 * Ask `url` for its settings path over a short-lived, read-only WebSocket
 * (`get_settings` only — the guard never writes) and resolve the server's
 * answer. Separate from the test's own connection so it cannot disturb the
 * test's snapshot/restore sequencing.
 *
 * @returns {Promise<string | undefined>} the reported path, or undefined when the
 *   server does not report one. Rejects on connection/timeout failure — the
 *   caller surfaces that as its own failure, unchanged.
 */
export function probeSettingsPath(url, timeoutMs = 10_000) {
  return new Promise((resolvePromise, reject) => {
    const ws = new WebSocket(url)
    let settled = false
    const done = (fn, arg) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        ws.close()
      } catch {
        /* already closing */
      }
      fn(arg)
    }
    const timer = setTimeout(
      () =>
        done(reject, new Error(`settings guard: no settings reply from ${url} in ${timeoutMs}ms`)),
      timeoutMs,
    )
    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'get_settings' })))
    ws.addEventListener('error', () =>
      done(reject, new Error(`settings guard: cannot connect to ${url}`)),
    )
    ws.addEventListener('close', () =>
      done(
        reject,
        new Error(`settings guard: connection to ${url} closed before a settings reply`),
      ),
    )
    ws.addEventListener('message', (event) => {
      let msg
      try {
        msg = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (msg?.type === 'settings') done(resolvePromise, msg.settingsPath)
    })
  })
}

/** The port to quote in the fix commands, read off the url under test. */
function portOf(url) {
  try {
    return Number(new globalThis.URL(url).port) || 13000
  } catch {
    return 13000
  }
}

/**
 * Apply the verdict to a `settingsPath` the caller already has — for a test that
 * reads `get_settings` on its own connection anyway (and whose connection may be
 * auth-gated, which the anonymous probe below cannot pass). Exits non-zero with
 * the fix when refused; returns normally only when isolation is proven.
 *
 * @param {string | undefined} settingsPath from the `settings` reply
 * @param {{ testScript?: string, url?: string }} opts
 */
export function enforceIsolatedSettings(settingsPath, opts = {}) {
  const verdict = decideGuard(settingsPath)
  if (verdict.allowed) return settingsPath
  console.error(
    refusalMessage(verdict.reason, { testScript: opts.testScript, port: portOf(opts.url) }),
  )
  process.exit(GUARD_REFUSED_EXIT_CODE)
}

/**
 * The single call a settings-writing e2e makes, before it opens its own
 * connection: probe, decide, and exit non-zero with the fix when refused.
 * Returns normally only when the server is proven isolated.
 *
 * @param {string} url ws:// url of the server under test
 * @param {{ testScript?: string, timeoutMs?: number }} opts
 */
export async function assertIsolatedSettings(url, opts = {}) {
  const settingsPath = await probeSettingsPath(url, opts.timeoutMs)
  return enforceIsolatedSettings(settingsPath, { testScript: opts.testScript, url })
}
