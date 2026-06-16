/**
 * `codes` feature handlers — read-only workspace code browsing.
 *
 * Every operation resolves the trust root from a registered workspace id and
 * accepts only workspace-relative paths. No handler writes to disk.
 */
import { open, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type {
  CodeDirEntry,
  CodeEntryType,
  CodeFileRead,
  CodeSearchHit,
  ServerToClient,
} from '@ccc/shared/protocol'
import type { UiErrorCode } from '@ccc/shared/ui-codes'
import { resolveWorkspaceRoot } from '../../state.js'
import type { Handler } from '../../transport/handler-registry.js'

export const MAX_FILE_BYTES = 1024 * 1024
export const SEARCH_RESULT_LIMIT = 100
export const SEARCH_TIMEOUT_MS = 1500

type CodesErrorCode =
  | Extract<UiErrorCode, 'workspace.unknown'>
  | Extract<
      UiErrorCode,
      | 'codes.invalidPath'
      | 'codes.notDirectory'
      | 'codes.notFile'
      | 'codes.readFailed'
      | 'codes.searchFailed'
    >

interface CodesError {
  code: CodesErrorCode
  path?: string
}

type GuardResult =
  | { ok: true; root: string; abs: string; rel: string }
  | { ok: false; error: CodesError }

interface SearchState {
  query: string
  mode: 'filename' | 'content'
  /** Compiled basename glob filters; null ⇒ match every file (`*`/empty). */
  patterns: RegExp[] | null
  startedAt: number
  hits: CodeSearchHit[]
  truncated: boolean
  timedOut: boolean
}

// Compile a user glob filter ("*.ts", "*.ts,*.tsx", "*") into basename matchers.
// `*` matches any run of chars, `?` one char; everything else is literal and
// case-insensitive. A bare `*` / empty input returns null (match every file).
export function compilePatterns(input: string): RegExp[] | null {
  const globs = input
    .split(/[,\s]+/)
    .map((g) => g.trim())
    .filter((g) => g.length > 0)
  if (globs.length === 0 || globs.every((g) => g === '*')) return null
  return globs.map((g) => {
    const body = g
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')
    return new RegExp(`^${body}$`, 'i')
  })
}

function matchesPattern(name: string, patterns: RegExp[] | null): boolean {
  return patterns === null || patterns.some((re) => re.test(name))
}

function errorFrame(error: CodesError): ServerToClient {
  return {
    type: 'error',
    error: { code: error.code, params: error.path ? { path: error.path } : undefined },
  }
}

function hasForbiddenSegment(rel: string): boolean {
  return rel.split(/[\\/]+/).some((part) => part === '..' || part === '.git')
}

function isWindowsAbsolute(rel: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(rel) || rel.startsWith('\\\\')
}

function normalizeRel(rel: string): string {
  return rel === '.' ? '' : rel
}

function isInsideRoot(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep)
}

function toWireRel(root: string, abs: string): string {
  const rel = relative(root, abs)
  return rel === '' ? '' : rel.split(sep).join('/')
}

async function safeRealpath(path: string): Promise<string | null> {
  try {
    return await realpath(path)
  } catch {
    return null
  }
}

export async function resolveCodePath(workspaceId: string, relInput: string): Promise<GuardResult> {
  const registered = resolveWorkspaceRoot(workspaceId)
  if (!registered) return { ok: false, error: { code: 'workspace.unknown', path: workspaceId } }

  const rel = normalizeRel(relInput)
  if (rel.includes('\0') || isAbsolute(rel) || isWindowsAbsolute(rel) || hasForbiddenSegment(rel)) {
    return { ok: false, error: { code: 'codes.invalidPath', path: relInput } }
  }

  const root = await safeRealpath(registered)
  if (!root) return { ok: false, error: { code: 'workspace.unknown', path: workspaceId } }

  const candidate = resolve(root, rel)
  const abs = await safeRealpath(candidate)
  if (!abs || !isInsideRoot(root, abs)) {
    return { ok: false, error: { code: 'codes.invalidPath', path: relInput } }
  }

  const wireRel = toWireRel(root, abs)
  if (hasForbiddenSegment(wireRel)) {
    return { ok: false, error: { code: 'codes.invalidPath', path: relInput } }
  }
  return { ok: true, root, abs, rel: wireRel }
}

async function entryType(abs: string): Promise<CodeEntryType | null> {
  const s = await stat(abs)
  if (s.isDirectory()) return 'directory'
  if (s.isFile()) return 'file'
  return null
}

async function listDir(workspaceId: string, rel: string): Promise<ServerToClient> {
  const guarded = await resolveCodePath(workspaceId, rel)
  if (!guarded.ok) return errorFrame(guarded.error)
  const type = await entryType(guarded.abs)
  if (type !== 'directory') return errorFrame({ code: 'codes.notDirectory', path: rel })

  const entries: CodeDirEntry[] = []
  for (const dirent of await readdir(guarded.abs, { withFileTypes: true })) {
    if (dirent.name === '.git') continue
    const childRel = guarded.rel ? `${guarded.rel}/${dirent.name}` : dirent.name
    const child = await resolveCodePath(workspaceId, childRel)
    if (!child.ok) continue
    const childType = await entryType(child.abs)
    if (!childType) continue
    entries.push({ name: dirent.name, path: child.rel, type: childType })
  }
  entries.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1,
  )
  return { type: 'dir_listed', workspaceId, rel: guarded.rel, entries }
}

function isBinary(buf: Buffer): boolean {
  return buf.includes(0)
}

async function readCodeFile(workspaceId: string, rel: string): Promise<ServerToClient> {
  const guarded = await resolveCodePath(workspaceId, rel)
  if (!guarded.ok) return errorFrame(guarded.error)
  const s = await stat(guarded.abs)
  if (!s.isFile()) return errorFrame({ code: 'codes.notFile', path: rel })

  const truncated = s.size > MAX_FILE_BYTES
  const sampleSize = Math.min(s.size, truncated ? 8192 : MAX_FILE_BYTES)
  const handle = await open(guarded.abs, 'r')
  let buf: Buffer
  try {
    buf = Buffer.alloc(sampleSize)
    await handle.read(buf, 0, sampleSize, 0)
  } finally {
    await handle.close()
  }
  const binary = isBinary(buf.subarray(0, Math.min(buf.byteLength, 8192)))
  const file: CodeFileRead = {
    path: guarded.rel,
    size: s.size,
    binary,
    truncated,
  }
  if (!binary && !truncated) file.content = buf.toString('utf-8')
  return { type: 'file_read', workspaceId, file }
}

function shouldStopSearch(state: SearchState): boolean {
  if (state.hits.length >= SEARCH_RESULT_LIMIT) {
    state.truncated = true
    return true
  }
  if (Date.now() - state.startedAt >= SEARCH_TIMEOUT_MS) {
    state.timedOut = true
    return true
  }
  return false
}

function addHit(state: SearchState, hit: CodeSearchHit): void {
  if (state.hits.length >= SEARCH_RESULT_LIMIT) {
    state.truncated = true
    return
  }
  state.hits.push(hit)
}

async function searchFileContent(abs: string, rel: string, state: SearchState): Promise<void> {
  const s = await stat(abs)
  if (!s.isFile() || s.size > MAX_FILE_BYTES) return
  const buf = await readFile(abs)
  if (isBinary(buf.subarray(0, Math.min(buf.byteLength, 8192)))) return
  const lines = buf.toString('utf-8').split(/\r?\n/)
  const needle = state.query.toLocaleLowerCase()
  for (let i = 0; i < lines.length; i++) {
    if (shouldStopSearch(state)) return
    const line = lines[i]
    const idx = line.toLocaleLowerCase().indexOf(needle)
    if (idx >= 0) {
      addHit(state, {
        path: rel,
        type: 'file',
        line: i + 1,
        lineText: line,
        match: line.slice(idx, idx + state.query.length),
      })
    }
  }
}

async function walkSearch(root: string, dirAbs: string, state: SearchState): Promise<void> {
  if (shouldStopSearch(state)) return
  for (const dirent of await readdir(dirAbs, { withFileTypes: true })) {
    if (shouldStopSearch(state)) return
    if (dirent.name === '.git') continue

    const rawAbs = join(dirAbs, dirent.name)
    const abs = await safeRealpath(rawAbs)
    if (!abs || !isInsideRoot(root, abs)) continue
    const rel = toWireRel(root, abs)
    if (hasForbiddenSegment(rel)) continue
    const type = await entryType(abs)
    if (!type) continue

    // The glob filter scopes which entries are matched/searched by basename;
    // directories are always *traversed* so a `*.ts` filter still reaches files
    // nested deep, but a non-default filter excludes directory name hits.
    const nameMatchesPattern = matchesPattern(dirent.name, state.patterns)

    if (
      state.mode === 'filename' &&
      nameMatchesPattern &&
      dirent.name.toLocaleLowerCase().includes(state.query.toLocaleLowerCase())
    ) {
      addHit(state, { path: rel, type, match: dirent.name })
    }
    if (type === 'directory') {
      await walkSearch(root, abs, state)
    } else if (state.mode === 'content' && nameMatchesPattern) {
      await searchFileContent(abs, rel, state)
    }
  }
}

async function searchCodes(
  workspaceId: string,
  query: string,
  mode: 'filename' | 'content',
  pattern: string,
): Promise<ServerToClient> {
  const guarded = await resolveCodePath(workspaceId, '')
  if (!guarded.ok) return errorFrame(guarded.error)
  const trimmed = query.trim()
  if (!trimmed) {
    return {
      type: 'codes_searched',
      workspaceId,
      query,
      mode,
      hits: [],
      truncated: false,
      timedOut: false,
    }
  }
  const state: SearchState = {
    query: trimmed,
    mode,
    patterns: compilePatterns(pattern),
    startedAt: Date.now(),
    hits: [],
    truncated: false,
    timedOut: false,
  }
  await walkSearch(guarded.root, guarded.root, state)
  return {
    type: 'codes_searched',
    workspaceId,
    query,
    mode,
    hits: state.hits,
    truncated: state.truncated,
    timedOut: state.timedOut,
  }
}

export const listDirHandler: Handler<'list_dir'> = async (_ctx, conn, msg) => {
  try {
    conn.send(await listDir(msg.workspaceId, msg.rel))
  } catch {
    conn.send(errorFrame({ code: 'codes.readFailed', path: msg.rel }))
  }
}

export const readFileHandler: Handler<'read_file'> = async (_ctx, conn, msg) => {
  try {
    conn.send(await readCodeFile(msg.workspaceId, msg.rel))
  } catch {
    conn.send(errorFrame({ code: 'codes.readFailed', path: msg.rel }))
  }
}

export const searchCodesHandler: Handler<'search_codes'> = async (_ctx, conn, msg) => {
  try {
    conn.send(await searchCodes(msg.workspaceId, msg.query, msg.mode, msg.pattern ?? '*'))
  } catch {
    conn.send(errorFrame({ code: 'codes.searchFailed' }))
  }
}
