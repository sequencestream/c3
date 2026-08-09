/**
 * Attaching c3's MCP servers to a `cursor-agent` run.
 *
 * The CLI takes no MCP flag: it reads `<workspace>/.cursor/mcp.json` and the
 * user-level file, and no environment variable redirects either. So the only way
 * to give a run c3's tools is to write that project file for the duration of the
 * turn and put it back afterwards.
 *
 * Four things make that safe enough to do:
 *
 *  - the previous contents — including "there was no file" — are captured and
 *    restored when the turn ends, byte for byte;
 *  - a second run in the same workspace **refuses to start** rather than
 *    overwriting the first, whose cleanup would otherwise pull the file out from
 *    under it;
 *  - the file is excluded from git locally, so an agent running `git add -A`
 *    cannot commit the per-run token the URL carries;
 *  - a process exiting for any reason restores what it wrote, and a file left
 *    behind by one that could not is recognised and dropped on the next run.
 *
 * The write is assembled as text rather than serialized: this layer may not call
 * `JSON.stringify`, and a hand-built object is also the only way to be sure the
 * user's own servers survive verbatim.
 *
 * @module
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { withFileLock } from '../../../config/store.js'
import { CursorUnsupportedError } from './launch.js'
import type { RemoteMcpServer } from '../types.js'

/** A written project MCP file, and what has to be put back. */
export interface CursorMcpConfig {
  readonly path: string
  /** The bytes that were there before; `null` when the file did not exist. */
  readonly previous: string | null
}

/** Quote a string as a JSON value, escaping what the format requires. */
function jsonString(value: string): string {
  let out = '"'
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (char === '"') out += '\\"'
    else if (char === '\\') out += '\\\\'
    else if (char === '\n') out += '\\n'
    else if (char === '\r') out += '\\r'
    else if (char === '\t') out += '\\t'
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, '0')}`
    else out += char
  }
  return `${out}"`
}

/** One server entry: the url, plus an Authorization header when a token exists. */
function serverEntry(server: RemoteMcpServer): string {
  const token = server.bearerTokenEnvVar ? process.env[server.bearerTokenEnvVar] : undefined
  const url = `"url": ${jsonString(server.url)}`
  if (!token) return `{ ${url} }`
  return `{ ${url}, "headers": { "Authorization": ${jsonString(`Bearer ${token}`)} } }`
}

/**
 * Build the file's contents: the caller's servers merged over whatever the
 * workspace already declared, so a user's own MCP servers keep working during a
 * c3 run.
 */
function renderConfig(servers: Record<string, RemoteMcpServer>, previous: string | null): string {
  const existing = readExistingServers(previous)
  const names = [...new Set([...Object.keys(existing), ...Object.keys(servers)])]
  const entries = names.map((name) => {
    const own = servers[name]
    return `    ${jsonString(name)}: ${own ? serverEntry(own) : existing[name]}`
  })
  return `{\n  "mcpServers": {\n${entries.join(',\n')}\n  }\n}\n`
}

/**
 * The workspace's existing server entries, as raw text keyed by name.
 *
 * Parsed then re-rendered through the same hand-built path: an entry c3 is not
 * replacing has to survive with its own fields intact, whatever they are.
 */
function readExistingServers(previous: string | null): Record<string, string> {
  if (!previous) return {}
  try {
    const parsed: unknown = JSON.parse(previous)
    const servers = (parsed as { mcpServers?: unknown })?.mcpServers
    if (!servers || typeof servers !== 'object') return {}
    const out: Record<string, string> = {}
    for (const [name, value] of Object.entries(servers as Record<string, unknown>)) {
      out[name] = renderValue(value)
    }
    return out
  } catch {
    // An unparseable file is left out of the merge rather than guessed at; it is
    // restored byte-for-byte when the turn ends either way.
    return {}
  }
}

/** Re-render a parsed value as JSON text, without a serializer. */
function renderValue(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'string') return jsonString(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return `[${value.map(renderValue).join(', ')}]`
  if (typeof value === 'object') {
    const fields = Object.entries(value as Record<string, unknown>).map(
      ([key, item]) => `${jsonString(key)}: ${renderValue(item)}`,
    )
    return `{ ${fields.join(', ')} }`
  }
  return 'null'
}

/**
 * The files currently written by a live run, keyed by path.
 *
 * The file lock is only held across a single synchronous read-modify-write, which
 * is not the unit that matters here: what must not overlap is the whole *turn*.
 * Two runs sharing a workspace would otherwise leave the first one's cleanup
 * restoring the file out from under the second, which is still using it. This map
 * is that turn-length claim.
 */
const active = new Map<string, CursorMcpConfig>()

/**
 * Restore every live file. Registered once, and deliberately synchronous: an
 * `exit` handler cannot await, and leaving a run's config behind would strand a
 * per-run token in the user's workspace.
 */
let exitHookInstalled = false
function installExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  const restoreAll = (): void => {
    for (const handle of [...active.values()]) cleanupCursorMcpConfig(handle)
  }
  process.once('exit', restoreAll)
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      restoreAll()
      process.kill(process.pid, signal)
    })
  }
}

/**
 * The git metadata dir for `cwd`, or `null` when it is not a work tree. A linked
 * worktree's `.git` is a FILE pointing at the real dir, so the pointer is followed
 * rather than assumed away — c3's own isolated checkouts are exactly that shape.
 */
function gitInfoDir(cwd: string): string | null {
  const dotGit = join(cwd, '.git')
  try {
    const stat = statSync(dotGit)
    if (stat.isDirectory()) return join(dotGit, 'info')
    const pointer = readFileSync(dotGit, 'utf-8').trim()
    const match = /^gitdir:\s*(.+)$/.exec(pointer)
    if (!match) return null
    const dir = match[1]!.trim()
    return join(isAbsolute(dir) ? dir : join(cwd, dir), 'info')
  } catch {
    return null
  }
}

/**
 * Make git ignore the run's MCP file, locally.
 *
 * The URL carries a per-run binding token, so the one outcome that must be
 * impossible is the agent committing it — and an agent that runs `git add -A`
 * would. `.git/info/exclude` is the right place because it is per-checkout and
 * never itself committed: the user's own `.gitignore` stays untouched. The entry
 * is appended once and left in place; removing it later could take a line the
 * user wrote with it.
 */
function excludeFromGit(cwd: string): void {
  const infoDir = gitInfoDir(cwd)
  if (!infoDir) return
  const file = join(infoDir, 'exclude')
  try {
    const current = existsSync(file) ? readFileSync(file, 'utf-8') : ''
    if (current.split('\n').some((line) => line.trim() === GIT_EXCLUDE_ENTRY)) return
    mkdirSync(infoDir, { recursive: true })
    const prefix = current.length > 0 && !current.endsWith('\n') ? '\n' : ''
    appendFileSync(file, `${prefix}${GIT_EXCLUDE_ENTRY}\n`, 'utf-8')
  } catch {
    // Not fatal on its own — the run still restores the file when it ends.
  }
}

const GIT_EXCLUDE_ENTRY = '.cursor/mcp.json'

/**
 * Whether an entry is one c3 left behind: a loopback URL is c3's own MCP route,
 * and nothing else has a reason to put one in a project file.
 */
function isLeftoverEntry(rendered: string): boolean {
  return /"url":\s*"https?:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(rendered)
}

/**
 * Write the run's MCP file, returning what {@link cleanupCursorMcpConfig} needs
 * to undo it. Returns `null` when there is nothing to attach, so the caller has
 * one shape to clean up either way.
 *
 * @throws {@link CursorUnsupportedError} when another run already owns this file.
 */
export function writeCursorMcpConfig(
  cwd: string,
  servers: Record<string, RemoteMcpServer> | undefined,
): CursorMcpConfig | null {
  if (!servers || Object.keys(servers).length === 0) return null
  const path = join(cwd, '.cursor', 'mcp.json')
  if (active.has(path)) {
    // Refusing beats overwriting: the running turn would silently lose its tools
    // the moment this one finished and restored the file.
    throw new CursorUnsupportedError(
      `cursor: another run is already using ${path}. Concurrent cursor runs in one workspace cannot both attach c3's MCP servers — wait for the other turn to finish.`,
    )
  }
  installExitHook()
  excludeFromGit(cwd)
  const handle = withFileLock(path, () => {
    const raw = existsSync(path) ? readFileSync(path, 'utf-8') : null
    // A file left behind by a run that was killed still holds a stale token, and
    // treating it as "the user's file" would restore it again at the end.
    const previous = raw !== null && isLeftoverEntry(raw) ? null : raw
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, renderConfig(servers, previous), 'utf-8')
    return { path, previous }
  })
  active.set(path, handle)
  return handle
}

/** Put the workspace back the way the run found it. */
export function cleanupCursorMcpConfig(handle: CursorMcpConfig | null): void {
  if (!handle) return
  active.delete(handle.path)
  try {
    withFileLock(handle.path, () => {
      if (handle.previous === null) rmSync(handle.path, { force: true })
      else writeFileSync(handle.path, handle.previous, 'utf-8')
    })
  } catch {
    // Best effort: a workspace that vanished mid-run (a deleted worktree) has
    // nothing left to restore, and failing here would mask the run's own outcome.
  }
}
