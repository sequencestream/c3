#!/usr/bin/env node
/**
 * Cursor CLI capability probe — the evidence source for Cursor's capability
 * ledger (see
 * `doc/domains/core/agent-session/features/agent-session-cursor.md`).
 *
 * Drives `cursor-agent` exactly as c3's driver does — `create-chat` to mint the
 * id, then `--print --output-format stream-json --resume <id>` with the prompt on
 * stdin — inside a throwaway workspace, and reports what the CLI actually
 * delivers rather than what its help text promises.
 *
 * Two gates are BLOCKING, because c3's session model cannot be honest without them:
 *   G1 minted id — the id `create-chat` returns is the one the run reports and
 *      the one it persists under. Without it a session's identity cannot precede
 *      its first frame, and `sessionId()` would have to pend on the stream.
 *   G2 resume — a second turn through `--resume <id>` remembers a secret
 *      established in the first. Without it `sessions.resume` cannot be `full`.
 *
 * The remaining checks are informational: they record the frame vocabulary, the
 * field the run identity travels under, the shape of the terminal `result` frame,
 * and the discriminated `tool_call` payload.
 *
 * Needs a working `cursor-agent` login or `CURSOR_API_KEY`, and outbound network
 * (spends a small amount of real quota), so it is NOT CI-safe and NOT part of
 * `pnpm e2e`. No credential ⇒ the gates report SKIP (exit 5).
 *
 * Usage:
 *   node scripts/e2e/cursor-cli-probe.mjs [--gates-only] [--json] [--keep]
 * Exit codes: 0 = GO (both gates pass), 1 = NO-GO, 5 = SKIP (unauthenticated).
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const args = new Set(process.argv.slice(2))
const GATES_ONLY = args.has('--gates-only')
const JSON_OUT = args.has('--json')
const KEEP = args.has('--keep')

const log = (s) => !JSON_OUT && console.log(`[cursor-probe] ${s}`)
const findings = []
const record = (name, ok, detail) => {
  findings.push({ name, ok, detail })
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

function skip(reason) {
  if (JSON_OUT) console.log(JSON.stringify({ verdict: 'SKIP', reason, findings }, null, 2))
  else console.log(`[cursor-probe] SKIP — ${reason}`)
  process.exit(5)
}

// Resolution order mirrors the server's launcher: $CURSOR_PATH then host PATH.
function resolveBinary() {
  const override = (process.env.CURSOR_PATH ?? '').trim()
  if (override) return existsSync(override) ? override : null
  const r = spawnSync('sh', ['-c', 'command -v cursor-agent'], { encoding: 'utf-8' })
  return r.status === 0 ? (r.stdout || '').trim() || null : null
}

const BIN = resolveBinary()
if (!BIN) skip('cursor-agent not found ($CURSOR_PATH or PATH)')

const authed =
  (process.env.CURSOR_API_KEY ?? '').trim().length > 0 ||
  (() => {
    const r = spawnSync(BIN, ['status'], { encoding: 'utf-8' })
    return r.status === 0 && !/not logged in|logged out/i.test(`${r.stdout}${r.stderr}`)
  })()
if (!authed) skip('no CURSOR_API_KEY and cursor-agent is not logged in')

const WS = mkdtempSync(join(tmpdir(), 'c3-cursor-probe-'))
writeFileSync(join(WS, 'README.md'), '# cursor cli probe\n')

/** Mint a chat id the way the driver does. */
function createChat() {
  const r = spawnSync(BIN, ['create-chat'], { cwd: WS, encoding: 'utf-8' })
  if (r.status !== 0) throw new Error(`create-chat exited ${r.status}: ${r.stderr}`)
  return (r.stdout || '').trim()
}

/** Run one turn, collecting every frame. */
function runTurn(chatId, prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      BIN,
      [
        '--print',
        '--output-format',
        'stream-json',
        '--trust',
        '--workspace',
        WS,
        '--force',
        '--resume',
        chatId,
      ],
      { cwd: WS },
    )
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.once('error', reject)
    child.once('exit', (code) => {
      const frames = []
      for (const line of out.split('\n')) {
        const text = line.trim()
        if (!text) continue
        try {
          frames.push(JSON.parse(text))
        } catch {
          frames.push({ type: '__unparseable__', raw: text })
        }
      }
      resolve({ code, frames, stderr: err })
    })
    child.stdin.write(prompt)
    child.stdin.end()
  })
}

const SECRET = `probe-${Date.now().toString(36)}`
let verdict = 'GO'

try {
  // ── G1: the minted id is the run's identity ────────────────────────────────
  const chatId = createChat()
  const first = await runTurn(chatId, `Remember this token: ${SECRET}. Reply with just: ok`)
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(chatId)
  const reported = first.frames.find((f) => f.session_id)?.session_id
  const g1 = uuid && first.code === 0 && reported === chatId
  record(
    'G1 minted id is the run identity',
    g1,
    g1 ? chatId : `minted=${chatId} reported=${reported} exit=${first.code} ${first.stderr}`,
  )
  if (!g1) verdict = 'NO-GO'

  // ── G2: resume carries context ─────────────────────────────────────────────
  const second = await runTurn(chatId, 'What token did I ask you to remember? Reply with it only.')
  const replied = second.frames
    .filter((f) => f.type === 'assistant')
    .map((f) => (f.message?.content ?? []).map((c) => c.text ?? '').join(''))
    .join('')
  const g2 = second.code === 0 && replied.includes(SECRET)
  record(
    'G2 resume carries context',
    g2,
    g2 ? `recalled ${SECRET}` : `replied: ${replied.slice(0, 120)}`,
  )
  if (!g2) verdict = 'NO-GO'

  if (!GATES_ONLY) {
    // ── Informational: the frame contract the translator is written against ──
    const types = [...new Set(first.frames.map((f) => f.type))]
    record('frame vocabulary', true, types.join(', '))

    const idField = first.frames[0]?.session_id !== undefined ? 'session_id' : 'agent_id'
    record('run identity field', idField === 'session_id', idField)

    const result = first.frames.find((f) => f.type === 'result')
    record(
      'terminal frame is `result` with is_error',
      Boolean(result) && typeof result.is_error === 'boolean',
      result ? `subtype=${result.subtype} is_error=${result.is_error}` : 'no result frame',
    )

    const status = first.frames.find((f) => f.type === 'status')
    record(
      'no `status` frame (result is the only terminal truth)',
      !status,
      status ? 'present' : 'absent',
    )

    // A tool turn, to capture the discriminated payload shape.
    const toolChat = createChat()
    const tool = await runTurn(
      toolChat,
      'Run the shell command `echo probe` and report its output.',
    )
    const call = tool.frames.find((f) => f.type === 'tool_call')
    const arm = call ? Object.keys(call.tool_call ?? {}).find((k) => k.endsWith('ToolCall')) : null
    record(
      'tool_call names its tool by a discriminated arm',
      Boolean(arm),
      arm
        ? `${arm} (subtype=${call.subtype}, call_id present=${Boolean(call.call_id)})`
        : 'no tool_call frame',
    )
  }
} catch (err) {
  record('probe execution', false, err?.message ?? String(err))
  verdict = 'NO-GO'
} finally {
  if (!KEEP) rmSync(WS, { recursive: true, force: true })
}

if (JSON_OUT) console.log(JSON.stringify({ verdict, findings }, null, 2))
else log(`VERDICT: ${verdict}`)
process.exit(verdict === 'GO' ? 0 : 1)
