/**
 * The chat robot's local filesystem scope — the ONE adjudication every local
 * file access a robot turn can make has to pass through.
 *
 * An IM robot is the only c3 path that pushes an agent's answer to a third-party
 * cloud on its own initiative. Before this module the `robot` gate allowed a
 * tool because of its NAME ("Read is a read tool"), which said nothing about
 * WHERE it read: an absolute path, a `..` chain or a symlink pointing out of the
 * robot's directory all reached host data, and the final answer could then
 * recite it into a group chat. So the boundary cannot be "only the final text
 * leaves" — the content has to be unreachable before it is ever read.
 *
 * Three properties are what make this a boundary rather than a filter:
 *
 *  - **One table, no default-open.** A tool is adjudicable only if it is
 *    described here. A local read tool that appears in a vendor's manifest
 *    without a description is denied, and a test fails — a new tool can never
 *    arrive already permitted.
 *  - **Access location ≠ query content.** `Grep.pattern` is what to look for and
 *    is none of this module's business; `Grep.path` is where to look and is.
 *    Describing them per field is what keeps a search from being waved through
 *    because "the pattern looked harmless".
 *  - **Real paths, not strings.** Containment is decided on the path the
 *    filesystem actually resolves to, walked one segment at a time so a symlink
 *    (or a dangling one) cannot be jumped over by a lexical `..`. A target that
 *    does not exist is resolved from its nearest existing ancestor, so "not
 *    found inside the root" keeps the tool's own semantics while "outside the
 *    root" answers identically whether or not it exists.
 *
 * The verdict is binary: allow with the normalized input, or ONE fixed refusal.
 * The refusal never carries the requested path, the resolved path, or an
 * errno — a robot must not be usable as an oracle for "does this file exist on
 * the host". Audits record the tool and a reason CATEGORY, never the target.
 *
 * This module decides one call. It does not — and cannot — control what a tool
 * does once it is running (which symlinks a recursive search follows, what a
 * shell reads). That is the mandatory per-turn process isolation's job; the two
 * together are the boundary, and neither is sufficient alone.
 */
import { lstatSync, readlinkSync, realpathSync } from 'node:fs'
import path from 'node:path'

/** Stable code for every refusal this module produces. Audits key on it. */
export const ROBOT_FS_DENY_CODE = 'robot-local-read-denied'

/**
 * The ONE refusal a robot ever sees for an out-of-scope local access. Fixed on
 * purpose: a message that varied with the path, the errno, or whether the target
 * existed would turn the robot into a probe for host filesystem contents.
 */
export const ROBOT_FS_DENY_MESSAGE =
  'This chat robot may only access files inside its own run directory.'

/**
 * Why an access was refused, for the audit line only. Never rendered to the
 * model, never sent to a chat — the categories distinguish a malformed call from
 * an escape attempt without naming the target either way.
 */
export type RobotFsDenyReason =
  /** The tool has no path description, so its access locations are unknown. */
  | 'no-descriptor'
  /** Two alternate location fields were supplied at once, or an undeclared one was. */
  | 'field-conflict'
  /** A required location was missing, empty, or not a string. */
  | 'bad-location'
  /** The location resolved outside the frozen run root. */
  | 'outside-root'
  /** The run root itself vanished or changed identity mid-turn. */
  | 'root-unstable'

/** The adjudication result: allow with normalized input, or one fixed refusal. */
export type RobotFsVerdict =
  | { readonly ok: true; readonly input: Record<string, unknown> }
  | { readonly ok: false; readonly reason: RobotFsDenyReason }

// ─── Path description table ──────────────────────────────────────────────────

/**
 * What a described parameter means to the filesystem.
 *
 *  - `location` — a concrete file or directory the tool will open or walk.
 *  - `glob` — a pattern that may carry a literal path prefix or be absolute;
 *    its magic-free prefix is what decides where the walk starts.
 *  - `filter` — a name filter matched against results *below* an already
 *    adjudicated location (ripgrep's `--glob`, an ignore list). It may never be
 *    absolute or contain `..`, and it is not resolved.
 */
export type RobotPathKind = 'location' | 'glob' | 'filter'

/** What to do when none of a parameter's alternate fields is present. */
export type RobotPathAbsent =
  /** Normalize to the frozen run root (the tool's contract defaults to cwd). */
  | 'root'
  /** The location is required — refuse. */
  | 'deny'
  /** The parameter is genuinely optional and constrains nothing on its own. */
  | 'skip'

/** One path-bearing parameter of a tool. */
export interface RobotPathParam {
  /**
   * The field names that may carry this location. More than one because vendors
   * name the same thing differently across tools (`path` / `targetDirectory`).
   * Supplying two at once is a conflict, not a preference — c3 must not have to
   * guess which one the vendor will honour. `fields[0]` is where a `root`
   * default is written.
   */
  readonly fields: readonly string[]
  readonly kind: RobotPathKind
  readonly whenAbsent: RobotPathAbsent
  /** Whether the value may also be an array of strings (each adjudicated). */
  readonly list?: boolean
}

/**
 * Local file tools, keyed by the name the vendor's stream uses, mapped to the
 * parameters that decide WHERE they reach. Everything not listed for a tool is
 * query content and is left untouched.
 *
 * Codex contributes nothing: its manifest exposes no local read tool at all
 * (`web_search` leaves the machine, the task tools touch no disk). Its file
 * access rides `shell` / `apply_patch`, which are write-class — governed by the
 * robot's frozen allowlist, and bounded by the process isolation rather than by
 * a per-call description that codex offers no hook to apply.
 */
export const ROBOT_LOCAL_PATH_TOOLS: Readonly<Record<string, readonly RobotPathParam[]>> = {
  // ── Claude ────────────────────────────────────────────────────────────────
  Read: [{ fields: ['file_path'], kind: 'location', whenAbsent: 'deny' }],
  NotebookRead: [{ fields: ['notebook_path'], kind: 'location', whenAbsent: 'deny' }],
  LS: [
    { fields: ['path'], kind: 'location', whenAbsent: 'root' },
    { fields: ['ignore'], kind: 'filter', whenAbsent: 'skip', list: true },
  ],
  Grep: [
    { fields: ['path'], kind: 'location', whenAbsent: 'root' },
    { fields: ['glob'], kind: 'filter', whenAbsent: 'skip' },
  ],
  // `pattern` IS a location here (unlike Grep's, which is the query): a Glob
  // pattern may be absolute or carry a `../` prefix, so it moves the walk root.
  Glob: [
    { fields: ['path'], kind: 'location', whenAbsent: 'root' },
    { fields: ['pattern'], kind: 'glob', whenAbsent: 'deny' },
  ],

  // ── Cursor ────────────────────────────────────────────────────────────────
  // Cursor has no per-tool approval channel, so these never reach the gate in
  // practice and the process isolation is what actually binds them. They are
  // described anyway: the description is the record of which fields are access
  // locations, and it is what makes the gate fail closed rather than fall
  // through to the allowlist if a future cursor build ever gains that channel.
  read: [{ fields: ['path'], kind: 'location', whenAbsent: 'deny' }],
  ls: [{ fields: ['path', 'targetDirectory'], kind: 'location', whenAbsent: 'root' }],
  glob: [
    { fields: ['targetDirectory', 'path'], kind: 'location', whenAbsent: 'root' },
    { fields: ['globPattern'], kind: 'glob', whenAbsent: 'deny' },
  ],
  grep: [
    { fields: ['targetDirectory', 'path'], kind: 'location', whenAbsent: 'root' },
    { fields: ['globPattern'], kind: 'filter', whenAbsent: 'skip' },
  ],
  semSearch: [
    {
      fields: ['targetDirectories', 'targetDirectory', 'path'],
      kind: 'location',
      whenAbsent: 'root',
      list: true,
    },
  ],
  readLints: [{ fields: ['paths', 'path'], kind: 'location', whenAbsent: 'root', list: true }],
}

/**
 * Read-class tools that reach no local path at all, listed explicitly so the
 * completeness test can tell "reaches nothing" from "reaches something nobody
 * described yet". Web tools leave the machine; the task / plan / todo tools are
 * in-conversation bookkeeping.
 */
export const ROBOT_NON_LOCAL_READ_TOOLS: ReadonlySet<string> = new Set([
  'WebFetch',
  'WebSearch',
  'TaskCreate',
  'TaskList',
  'TaskUpdate',
  'TaskGet',
  'web_search',
  'task',
  'createPlan',
  'updateTodos',
])

/**
 * Field names that name a filesystem location in some tool's vocabulary. Their
 * presence on a tool that did NOT declare them means c3's description of that
 * tool is out of date — the call is refused rather than passed through with an
 * unexamined location on it. `pattern` is absent on purpose: it is a query for
 * Grep and a location for Glob, and both are described explicitly.
 */
const PATH_LIKE_FIELDS: ReadonlySet<string> = new Set([
  'file_path',
  'filePath',
  'file_paths',
  'filePaths',
  'notebook_path',
  'notebookPath',
  'path',
  'paths',
  'dir',
  'dirs',
  'directory',
  'directories',
  'targetDirectory',
  'targetDirectories',
  'cwd',
  'root',
  'glob',
  'globPattern',
  'globPatterns',
  'ignore',
  'include',
  'exclude',
  'absolute_path',
  'absolutePath',
])

/** Whether this tool reaches local paths and must therefore be adjudicated. */
export function isRobotLocalPathTool(toolName: string): boolean {
  return Object.hasOwn(ROBOT_LOCAL_PATH_TOOLS, toolName)
}

/**
 * Whether an input carries a caller-controlled filesystem location this module
 * has no description for.
 *
 * The c3 MCP tools a robot may select are bound to its own run directory at the
 * transport and take no path argument today, which is the only reason they are
 * allowed to skip adjudication. This is the guard on that reason: the day one of
 * them grows a path parameter, the call fails closed until the parameter is
 * described here, instead of quietly becoming a second way out of the root.
 */
export function carriesUndescribedLocation(input: unknown): boolean {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return false
  return Object.keys(input as Record<string, unknown>).some((key) => PATH_LIKE_FIELDS.has(key))
}

// ─── Root freezing ───────────────────────────────────────────────────────────

/**
 * Resolve a robot's run directory to the real path the whole turn is judged
 * against. Throws when the directory is missing or unresolvable: a turn that
 * cannot establish its own boundary must not start, because there is no
 * narrower thing to fall back to.
 */
export function freezeRobotRoot(dir: string): string {
  try {
    return realpathSync(dir)
  } catch (err) {
    throw new Error(
      `[c3] robot run root is not resolvable (${err instanceof Error ? err.message : String(err)})`,
      { cause: err },
    )
  }
}

/**
 * Whether the frozen root still IS the same real directory. A root that was
 * swapped mid-turn (renamed away and recreated, replaced by a symlink) is a
 * different place wearing the same name, and re-trusting it would hand the rest
 * of the turn to whoever performed the swap.
 */
function rootStillFrozen(root: string): boolean {
  try {
    return realpathSync(root) === root
  } catch {
    return false
  }
}

// ─── Canonicalization ────────────────────────────────────────────────────────

/** Guard against symlink cycles while resolving a chain by hand. */
const MAX_LINK_DEPTH = 24

/**
 * Split a path body into segments using THIS platform's separators. On POSIX a
 * backslash is an ordinary filename character and is deliberately not split on;
 * on Windows both separators are real, so both are.
 */
function splitSegments(body: string): string[] {
  const parts = process.platform === 'win32' ? body.split(/[\\/]+/) : body.split('/')
  return parts.filter((s) => s !== '' && s !== '.')
}

function tryRealpath(p: string): string | null {
  try {
    return realpathSync(p)
  } catch {
    return null
  }
}

function tryReadlink(p: string): string | null {
  try {
    return lstatSync(p).isSymbolicLink() ? readlinkSync(p) : null
  } catch {
    return null
  }
}

/**
 * Resolve an absolute path to the location the filesystem would actually reach,
 * walking ONE segment at a time.
 *
 * Segment-by-segment is the whole point. `path.resolve` collapses `..`
 * lexically, so `<root>/link-to-etc/..` would fold to `<root>` and pass a string
 * check while the kernel would hand back `/`. Here each existing component is
 * replaced by its real path first, so a `..` afterwards steps out of the LINK's
 * true parent. A component that does not exist contributes its literal name (the
 * caller then decides inside/outside on a path that simply is not there yet),
 * and a dangling symlink is followed to its declared target so a broken link
 * cannot smuggle in a location that is about to exist.
 *
 * Returns null when the chain cannot be resolved within the link-depth budget.
 */
function canonicalizeAbsolute(abs: string, depth = 0): string | null {
  if (depth > MAX_LINK_DEPTH) return null
  const { root } = path.parse(abs)
  if (!root) return null
  let cur = tryRealpath(root) ?? root
  for (const seg of splitSegments(abs.slice(root.length))) {
    if (seg === '..') {
      cur = path.dirname(cur)
      continue
    }
    const next = path.join(cur, seg)
    const real = tryRealpath(next)
    if (real !== null) {
      cur = real
      continue
    }
    const link = tryReadlink(next)
    if (link !== null) {
      const target = path.isAbsolute(link) ? link : path.join(cur, link)
      const resolved = canonicalizeAbsolute(target, depth + 1)
      if (resolved === null) return null
      cur = resolved
      continue
    }
    // Neither a real entry nor a link: the tail simply does not exist. Keep it
    // literal so an in-root miss stays an in-root miss.
    cur = next
  }
  return cur
}

/** Whether `target` is `root` itself or lives underneath it, by path segment. */
function withinRoot(root: string, target: string): boolean {
  const rel = path.relative(root, target)
  if (rel === '') return true
  if (path.isAbsolute(rel)) return false
  return rel !== '..' && !rel.startsWith(`..${path.sep}`)
}

/**
 * Resolve one raw value against the frozen root and decide containment.
 * `base` is an already-adjudicated in-root directory (the tool's own location
 * parameter) so a relative value is judged where the tool would actually apply
 * it; absolute values ignore it and are judged on their own merits — being
 * absolute earns no exemption.
 */
function locationInsideRoot(root: string, base: string, raw: string): boolean {
  const abs = path.isAbsolute(raw) ? raw : path.join(base, ...splitSegments(raw))
  // `path.join` above collapses nothing dangerous: the segments carry no
  // separators, and `..` is preserved for the segment walk to interpret.
  const canonical = canonicalizeAbsolute(abs)
  if (canonical === null) return false
  return withinRoot(root, canonical)
}

/** Glob metacharacters — the first segment carrying one ends the literal prefix. */
const GLOB_MAGIC = /[*?[\]{}!()]/

/**
 * The directory a glob pattern would start walking from: its leading
 * magic-free segments. `**\/*.ts` starts at the base, `/etc/**` starts at
 * `/etc`, and `/*` starts at the filesystem root — which is exactly why the
 * prefix, not the pattern, is what gets adjudicated.
 */
function globWalkRoot(base: string, pattern: string): string {
  const absolute = path.isAbsolute(pattern)
  const body = absolute ? pattern.slice(path.parse(pattern).root.length) : pattern
  const literal: string[] = []
  for (const seg of splitSegments(body)) {
    if (GLOB_MAGIC.test(seg)) break
    literal.push(seg)
  }
  return absolute ? path.join(path.parse(pattern).root, ...literal) : path.join(base, ...literal)
}

/** Whether a value carries a `..` segment — rejected outright in globs/filters. */
function hasParentSegment(value: string): boolean {
  return splitSegments(value).includes('..')
}

// ─── Adjudication ────────────────────────────────────────────────────────────

/** Read one alternate group off the input, refusing when two are supplied. */
function readParam(
  input: Record<string, unknown>,
  param: RobotPathParam,
): { field: string; value: unknown } | 'absent' | 'conflict' {
  const present = param.fields.filter((f) => input[f] !== undefined && input[f] !== null)
  if (present.length > 1) return 'conflict'
  if (present.length === 0) return 'absent'
  const field = present[0]!
  return { field, value: input[field] }
}

/** Normalize a value to the list of strings to adjudicate, or refuse. */
function asStrings(value: unknown, list: boolean): string[] | 'bad' {
  if (typeof value === 'string') return value === '' ? [] : [value]
  if (list && Array.isArray(value)) {
    const out: string[] = []
    for (const item of value) {
      if (typeof item !== 'string') return 'bad'
      if (item !== '') out.push(item)
    }
    return out
  }
  return 'bad'
}

/** A NUL byte truncates the path at the syscall boundary — never adjudicable. */
function hasNul(value: string): boolean {
  return value.includes('\0')
}

const DENY = (reason: RobotFsDenyReason): RobotFsVerdict => ({ ok: false, reason })

/**
 * Adjudicate ONE tool call against the robot's frozen run root.
 *
 * Both enforcement points call this with the same arguments so they cannot
 * disagree: the permission gate (Claude's per-tool callback) and the
 * pre-execution hook (which runs even for a call an inherited settings rule
 * auto-allowed, so no allow-rule can route around the gate).
 *
 * Total and side-effect-free apart from the filesystem reads it needs to resolve
 * real paths. Every non-allow answer is the same refusal, so the caller has no
 * way to leak a distinction it was never given.
 */
export function adjudicateRobotToolInput(args: {
  /** The turn's frozen run root (a real path, from {@link freezeRobotRoot}). */
  readonly root: string
  readonly toolName: string
  readonly input: unknown
}): RobotFsVerdict {
  const params = ROBOT_LOCAL_PATH_TOOLS[args.toolName]
  if (!params) return DENY('no-descriptor')
  if (!rootStillFrozen(args.root)) return DENY('root-unstable')

  const input = (args.input ?? {}) as Record<string, unknown>
  if (typeof input !== 'object' || Array.isArray(input)) return DENY('bad-location')

  const declared = new Set(params.flatMap((p) => p.fields))
  for (const key of Object.keys(input)) {
    if (PATH_LIKE_FIELDS.has(key) && !declared.has(key)) return DENY('field-conflict')
  }

  const normalized: Record<string, unknown> = { ...input }
  // The base for relative values: the tool's own adjudicated location parameter
  // when it has one, the run root otherwise. Locations are described before
  // globs/filters in every entry, so this is settled by the time they are read.
  let base = args.root

  for (const param of params) {
    const read = readParam(input, param)
    if (read === 'conflict') return DENY('field-conflict')
    if (read === 'absent') {
      if (param.whenAbsent === 'deny') return DENY('bad-location')
      if (param.whenAbsent === 'root') normalized[param.fields[0]!] = args.root
      continue
    }
    const values = asStrings(read.value, param.list === true)
    if (values === 'bad') return DENY('bad-location')
    if (values.length === 0) {
      // Present but empty (`''`, `[]`). Same answer as absent, so an empty
      // string cannot become a silent "wherever the process happens to be".
      if (param.whenAbsent === 'deny') return DENY('bad-location')
      if (param.whenAbsent === 'root') normalized[param.fields[0]!] = args.root
      continue
    }
    for (const value of values) {
      if (hasNul(value)) return DENY('bad-location')
      if (param.kind === 'filter') {
        // A filter is matched below an already-bounded location, so it may not
        // be a location itself.
        if (path.isAbsolute(value) || hasParentSegment(value)) return DENY('outside-root')
        continue
      }
      if (param.kind === 'glob') {
        if (hasParentSegment(value)) return DENY('outside-root')
        const walkRoot = canonicalizeAbsolute(globWalkRoot(base, value))
        if (walkRoot === null || !withinRoot(args.root, walkRoot)) return DENY('outside-root')
        continue
      }
      if (!locationInsideRoot(args.root, base, value)) return DENY('outside-root')
    }
    if (param.kind === 'location' && values.length === 1 && !param.list) {
      // Anchor later relative parameters at the location this call resolved to.
      const only = values[0]!
      base = path.isAbsolute(only) ? only : path.join(args.root, ...splitSegments(only))
    }
  }

  return { ok: true, input: normalized }
}
