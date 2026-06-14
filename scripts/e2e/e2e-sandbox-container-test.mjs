#!/usr/bin/env node
/**
 * Sandbox container E2E — config-via-c3 + real container path verification.
 *
 * This is the "true" sandbox e2e the backward-compat test (e2e-sandbox-test.mjs)
 * does NOT cover: that one runs a plain chat `create_session`, which per
 * ADR-0024 / SND-R13 never sandboxes (no `effectiveCwd`). Here we verify the
 * two halves that actually matter for the sandbox container feature:
 *
 *   Part A — Config flow (over the c3 WebSocket protocol, i.e. exactly what the
 *     System Settings + Workspace Settings UI emit):
 *       1. register a system sandbox def pointing at the local base image,
 *          via get_settings → save_settings;
 *       2. enable sandbox on a worktree-mode workspace via save_workspace_setting;
 *       3. read both back and assert they persisted (worktree-only normalize kept).
 *
 *   Part B — Container path (token-free, no LLM turn): start a container from the
 *     same image with a worktree bind-mounted at /workspace and run the vendor
 *     CLIs inside it via `docker exec -w /workspace <cid> <claude|codex>` — the
 *     identical mechanism c3's sandbox wrapper uses (SandboxLauncher.createSandboxWrapper).
 *     This proves the image has the CLIs and the mount/exec path works on a real
 *     Docker daemon, without provider credentials or token spend.
 *
 * Why Part B is independent of c3's own launchSandbox: there is no protocol hook
 * to "launch the sandbox only" — c3 starts the container as step 4 of a real
 * `start_development` run whose step 5 spawns a real agent turn (needs creds,
 * spends tokens). The launchSandbox → wrapper wiring is already unit-tested
 * (DockerDriver.test.ts, run-lifecycle). What unit tests can't cover — a real
 * image on a real daemon — is exactly Part B. (A full real-turn variant via
 * start_development would spend tokens and need provider creds — out of scope.)
 *
 * Prereqs: Docker running + the base image built
 *   (node scripts/e2e/sandbox/build-image.mjs). SKIPs (exit 5) when missing.
 *
 * Usage:
 *   node scripts/e2e/e2e-sandbox-container-test.mjs [ws-url]
 *
 * Exit: 0 PASS, 5 SKIP, 2 TIMEOUT, anything else FAIL.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const URL = process.argv[2] || 'ws://localhost:13000/ws'
const IMAGE = process.env.C3_SANDBOX_IMAGE || 'c3-sandbox-e2e:latest'
const DEF_NAME = 'c3-e2e'
const TIMEOUT_MS = 60_000
// Optional creds for when the target server has auth enabled (handshake gate).
const AUTH_USERNAME = process.env.C3_E2E_USERNAME || 'admin'
const AUTH_PASSWORD = process.env.C3_E2E_PASSWORD || ''

/** Thrown to signal a clean SKIP (exit 5) rather than a FAIL. */
class SkipError extends Error {}

// ─── Docker preflight (SKIP if unmet) ──────────────────────────────────────────

function docker(args, opts = {}) {
  return spawnSync('docker', args, { encoding: 'utf8', ...opts })
}

function dockerAvailable() {
  const r = docker(['info', '--format', '{{.ServerVersion}}'], { timeout: 8000 })
  return r.status === 0
}

function imageExists(tag) {
  return docker(['image', 'inspect', tag]).status === 0
}

if (!dockerAvailable()) {
  console.log('[e2e-sandbox-container] Docker not available — SKIP')
  process.exit(5)
}
if (!imageExists(IMAGE)) {
  console.log(
    `[e2e-sandbox-container] base image "${IMAGE}" not found — SKIP\n` +
      '  build it first:  node scripts/e2e/sandbox/build-image.mjs',
  )
  process.exit(5)
}

// ─── WebSocket linear-flow helpers ──────────────────────────────────────────────

let inbox = []
let cursor = 0
let notify = null

/** @type {WebSocket} */
let ws

function send(data) {
  ws.send(JSON.stringify(data))
}

/** Wire a socket's message/error handlers and reset the inbox cursor. */
function attach(socket) {
  ws = socket
  inbox = []
  cursor = 0
  socket.addEventListener('message', (evt) => {
    try {
      inbox.push(JSON.parse(typeof evt.data === 'string' ? evt.data : String(evt.data)))
      if (notify) notify()
    } catch {
      /* ignore non-JSON */
    }
  })
  socket.addEventListener('error', (err) => {
    console.error('[e2e-sandbox-container] ws error:', err.message ?? err)
    process.exit(3)
  })
}

function openSocket(url) {
  return new Promise((resolve) => {
    const s = new WebSocket(url)
    attach(s)
    s.addEventListener('open', () => resolve(s))
  })
}

/**
 * Connect and return once the session is authed (a `ready` was received).
 * Handles the auth handshake: when the server gates with `unauthenticated`,
 * log in (creds from env) and reconnect with `?token=`. SKIPs when auth is on
 * but no password was supplied.
 */
async function connectAuthed() {
  console.log(`[e2e-sandbox-container] connecting ${URL}`)
  await openSocket(URL)
  const first = await waitFor(
    (m) => m.type === 'ready' || m.type === 'unauthenticated',
    'ready|unauthenticated',
  )
  if (first.type === 'ready') {
    console.log('[e2e-sandbox-container] connected (auth disabled)')
    return
  }
  // Auth gate active.
  if (!AUTH_PASSWORD) {
    throw new SkipError(
      'server has auth enabled but no C3_E2E_PASSWORD provided — SKIP\n' +
        '  set C3_E2E_PASSWORD (and optionally C3_E2E_USERNAME) or run against an auth-disabled server',
    )
  }
  console.log('[e2e-sandbox-container] auth gate — logging in')
  send({ type: 'login', request: { username: AUTH_USERNAME, password: AUTH_PASSWORD } })
  const res = await waitFor((m) => m.type === 'login_result', 'login_result')
  if (!res.result?.ok || !res.result?.token) {
    throw new Error(`login failed: ${res.result?.reason ?? 'unknown'}`)
  }
  try {
    ws.close()
  } catch {
    /* ignore */
  }
  await openSocket(`${URL}?token=${encodeURIComponent(res.result.token)}`)
  await waitFor((m) => m.type === 'ready', 'ready (after auth)')
  console.log('[e2e-sandbox-container] connected (authenticated)')
}

/** Wait for the next message (from a moving cursor) matching `pred`. */
function waitFor(pred, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  return (async () => {
    for (;;) {
      while (cursor < inbox.length) {
        const m = inbox[cursor++]
        if (pred(m)) return m
      }
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`)
      await new Promise((r) => {
        notify = r
        setTimeout(r, 250)
      })
      notify = null
    }
  })()
}

// ─── Part B: container path verification (token-free) ───────────────────────────

/** Replicate the sandbox wrapper's `docker exec -w /workspace <cid> <bin>` path. */
function verifyContainerPath(image) {
  // The mount dir MUST live somewhere Docker Desktop shares with the VM. On
  // macOS that excludes /tmp and /var/folders (i.e. os.tmpdir()) but always
  // includes the user's HOME; on Linux any path works. So anchor under HOME.
  const worktree = mkdtempSync(join(homedir(), '.c3-e2e-worktree-'))
  writeFileSync(join(worktree, 'SENTINEL.txt'), 'c3-sandbox-e2e-sentinel\n')

  const checks = {
    container_started: false,
    claude_cli: false,
    codex_cli: false,
    mount_visible: false,
  }
  let cid = ''
  try {
    const run = docker([
      'run',
      '-d',
      '--label',
      'c3.sandbox=true',
      '-v',
      `${worktree}:/workspace`,
      image,
      'sleep',
      '120',
    ])
    if (run.status !== 0) {
      console.error(`[e2e-sandbox-container] docker run failed: ${run.stderr?.trim()}`)
      return checks
    }
    cid = run.stdout.trim()
    checks.container_started = true

    const claudeV = docker(['exec', '-w', '/workspace', cid, 'claude', '--version'])
    checks.claude_cli = claudeV.status === 0
    console.log(
      `[e2e-sandbox-container] in-container claude --version → ${claudeV.stdout?.trim() || claudeV.stderr?.trim()}`,
    )

    const codexV = docker(['exec', '-w', '/workspace', cid, 'codex', '--version'])
    checks.codex_cli = codexV.status === 0
    console.log(
      `[e2e-sandbox-container] in-container codex --version → ${codexV.stdout?.trim() || codexV.stderr?.trim()}`,
    )

    const cat = docker(['exec', '-w', '/workspace', cid, 'cat', 'SENTINEL.txt'])
    checks.mount_visible = cat.status === 0 && cat.stdout.includes('c3-sandbox-e2e-sentinel')
  } finally {
    if (cid) docker(['rm', '-f', cid], { stdio: 'ignore' })
    try {
      rmSync(worktree, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
  return checks
}

// ─── Main flow ──────────────────────────────────────────────────────────────────

async function main() {
  // Use a caller-supplied project (C3_SANDBOX_E2E_WORKSPACE) when given — lets the
  // test run against a real, persistent test project. Otherwise create a throwaway
  // git workspace. Either way it must be a git repo (worktree-mode requires one).
  const provided = process.env.C3_SANDBOX_E2E_WORKSPACE
  const workspace = provided || mkdtempSync(join(tmpdir(), 'c3-e2e-sandbox-ws-'))
  mkdirSync(workspace, { recursive: true })
  const git = (args) => spawnSync('git', args, { cwd: workspace, encoding: 'utf8' })
  if (git(['rev-parse', '--is-inside-work-tree']).status !== 0) {
    if (!provided) writeFileSync(join(workspace, 'README.md'), '# c3 sandbox container e2e\n')
    git(['init', '-q'])
    git(['config', 'user.email', 'e2e@c3.local'])
    git(['config', 'user.name', 'c3 e2e'])
    git(['add', '-A'])
    git(['commit', '-q', '-m', 'init'])
  }
  console.log(`[e2e-sandbox-container] workspace: ${workspace}${provided ? ' (provided)' : ''}`)

  await connectAuthed()

  // ── Part A.1: register the system sandbox def (image = local base image) ──────
  send({ type: 'get_settings' })
  const s1 = await waitFor((m) => m.type === 'settings', 'settings (initial)')
  const existing = Array.isArray(s1.settings?.sandboxes) ? s1.settings.sandboxes : []
  const def = {
    name: DEF_NAME,
    type: 'docker',
    image: IMAGE,
    networkDisabled: true,
    memoryLimit: '512m',
    cpuLimit: 1,
    description: 'c3 e2e sandbox base image (claude + codex)',
  }
  const mergedSettings = {
    ...s1.settings,
    sandboxes: [...existing.filter((d) => d.name !== DEF_NAME), def],
  }
  send({ type: 'save_settings', settings: mergedSettings })

  // Confirm persistence with a fresh read (skip any echo that lacks our def).
  send({ type: 'get_settings' })
  const s2 = await waitFor(
    (m) => m.type === 'settings' && (m.settings?.sandboxes ?? []).some((d) => d.name === DEF_NAME),
    'settings containing our sandbox def',
  )
  const savedDef = s2.settings.sandboxes.find((d) => d.name === DEF_NAME)
  const defOk = savedDef?.image === IMAGE && savedDef?.type === 'docker'
  console.log(`[e2e-sandbox-container] sandbox def persisted: ${defOk} (image=${savedDef?.image})`)

  // ── Part A.2: register the workspace + enable sandbox in worktree mode ────────
  send({ type: 'add_workspace', path: workspace })
  await waitFor((m) => m.type === 'workspaces', 'workspaces (after add)')

  send({
    type: 'save_workspace_setting',
    workspacePath: workspace,
    config: {
      gitBranchMode: 'worktree',
      sandbox: { enabled: true, sandbox: DEF_NAME, agentIds: [] },
    },
  })
  const ws1 = await waitFor((m) => m.type === 'workspace_setting', 'workspace_setting (echo)')
  const sb = ws1.config?.sandbox
  const wsOk =
    ws1.config?.gitBranchMode === 'worktree' && sb?.enabled === true && sb?.sandbox === DEF_NAME
  console.log(
    `[e2e-sandbox-container] workspace sandbox persisted: ${wsOk} ` +
      `(mode=${ws1.config?.gitBranchMode}, enabled=${sb?.enabled}, def=${sb?.sandbox})`,
  )

  // ── Part B: real container path (token-free) ──────────────────────────────────
  console.log('[e2e-sandbox-container] verifying container path against the real image …')
  const c = verifyContainerPath(IMAGE)

  // ── Report ────────────────────────────────────────────────────────────────────
  const checks = {
    sandbox_def_persisted: defOk,
    workspace_sandbox_persisted: wsOk,
    container_started: c.container_started,
    claude_cli_in_container: c.claude_cli,
    codex_cli_in_container: c.codex_cli,
    worktree_mount_visible: c.mount_visible,
  }
  console.log('\n========== E2E SANDBOX CONTAINER ==========')
  console.log('checks:', JSON.stringify(checks, null, 2))
  const ok = Object.values(checks).every(Boolean)
  console.log(`result: ${ok ? 'PASS' : 'FAIL'}`)
  console.log('===========================================\n')
  return ok ? 0 : 1
}

// ─── Entry ────────────────────────────────────────────────────────────────────

const timeout = setTimeout(() => {
  console.error('[e2e-sandbox-container] TIMEOUT')
  process.exit(2)
}, TIMEOUT_MS)

main()
  .then((code) => {
    clearTimeout(timeout)
    try {
      ws?.close()
    } catch {
      /* ignore */
    }
    process.exit(code)
  })
  .catch((err) => {
    clearTimeout(timeout)
    try {
      ws?.close()
    } catch {
      /* ignore */
    }
    if (err instanceof SkipError) {
      console.log(`[e2e-sandbox-container] ${err.message}`)
      process.exit(5)
    }
    console.error('[e2e-sandbox-container] fatal:', err.message ?? err)
    process.exit(1)
  })
