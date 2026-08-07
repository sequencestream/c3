/**
 * Long-lived external-MCP API key store — the credential the public
 * `/mcp/<api-key>` route authenticates with.
 *
 * The keys live under ONE top-level `settings.json` key, `mcpApiKeys`, a
 * **sibling of** `SystemSettings` rather than a field of it (the same ownership
 * split `config/personalized.ts` uses). That placement is the security boundary:
 * a whole-object system-settings save neither carries these records nor can
 * inject/overwrite/read back a hash, so the only way in or out is the dedicated
 * admin-gated operations here.
 *
 * What reaches disk is metadata plus a per-key random salt and a `scrypt` hash —
 * never the plaintext. A key is therefore recoverable only at creation time;
 * rotation means "create a new key, repoint the client, delete the old one".
 *
 * The plaintext key is `c3k_<id>_<secret>`: the id half is deliberately NOT
 * secret so verification can locate the single candidate record and pay the
 * derivation cost exactly once, instead of hashing against every stored key. The
 * secret half carries 256 bits of CSPRNG entropy and is compared in constant time.
 *
 * Nothing here caches a "this key is valid" conclusion: every request re-reads
 * the current records, so deleting a key takes effect on the very next request.
 */
import { isAbsolute, resolve } from 'node:path'
import { realpathSync } from 'node:fs'
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { EXTERNAL_MCP_DEFAULT_TOOLS } from '@ccc/shared/protocol'
import { readJsonFile, withFileLock, writeAtomic } from './store.js'
import { settingsFile } from './paths.js'

/** The single settings-file key this module owns. */
const FILE_KEY = 'mcpApiKeys'

/** Plaintext key prefix — a stable, greppable marker so a leaked key is recognisable. */
const KEY_PREFIX = 'c3k'

/** Hex characters in the non-secret key id (8 random bytes). */
const ID_HEX_LEN = 16

/** Random bytes behind the secret half — 256 bit, per the spec's entropy floor. */
const SECRET_BYTES = 32

/**
 * `scrypt` cost parameters. Persisted per record (with {@link HASH_VERSION}) so a
 * future hardening pass can raise them without invalidating existing keys: a
 * record is always verified with the parameters it was written with.
 */
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 32 } as const

/** Hash-scheme version. An unknown version is rejected as invalid — never fail-open. */
const HASH_VERSION = 1

/**
 * The server-internal view of one key: everything except the verification
 * material. It carries a CANONICAL ABSOLUTE PATH because that is what an incoming
 * `/mcp/<api-key>` request resolves against. The wire-facing `McpApiKeyMeta`
 * addresses the workspace by opaque id instead; the settings handler translates.
 */
export interface McpApiKeyInfo {
  id: string
  name: string
  createdAt: number
  lastUsedAt: number | null
  /** The ONE canonical absolute path this key is bound to. Never empty, never a wildcard. */
  workspace: string
  /** The tool names this key may call. Empty ⇒ nothing, never "all". */
  tools: string[]
  /** The public, non-secret display prefix (`c3k_<id>`). */
  displayPrefix: string
}

/** The persisted record: {@link McpApiKeyInfo} plus the verification material. */
interface McpApiKeyRecord {
  id: string
  name: string
  createdAt: number
  lastUsedAt: number | null
  workspace: string
  tools: string[]
  hashVersion: number
  algo: string
  params: { N: number; r: number; p: number; keylen: number }
  /** base64 random salt, unique per key. */
  salt: string
  /** base64 `scrypt(secret, salt, params)`. */
  hash: string
}

/** The settings-file shape as far as this module cares; every other key is preserved verbatim. */
interface McpApiKeyFileShape extends Record<string, unknown> {
  mcpApiKeys?: unknown
}

/** In-memory mirror of the owned key; `null` until first read. Test seam via {@link resetMcpApiKeyCache}. */
let cache: McpApiKeyRecord[] | null = null

/** Drop the cache so the next read re-reads the (possibly relocated) settings file. */
export function resetMcpApiKeyCache(): void {
  cache = null
}

// ---- Workspace path canonicalization ----

/**
 * Force a raw workspace path into the ONE canonical form both the authorization
 * set and the request parameter are compared in. Returns `null` for anything that
 * is not an absolute path — a relative path is a client error, not a lookup miss.
 *
 * Canonicalization resolves `.`/`..`, collapses trailing separators AND follows
 * symlinks when the path exists, so two spellings of the same directory cannot
 * disagree about whether a key is authorized. A path that does not exist (or is
 * unreadable) keeps its lexically-resolved form: the authorization decision must
 * not depend on the filesystem being reachable at that instant.
 */
export function canonicalizeWorkspacePath(raw: string): string | null {
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  if (!trimmed || !isAbsolute(trimmed)) return null
  const resolved = resolve(trimmed)
  try {
    return realpathSync(resolved)
  } catch {
    return resolved
  }
}

// ---- Persistence ----

function readFile(): McpApiKeyFileShape {
  return readJsonFile<McpApiKeyFileShape>(settingsFile()) ?? {}
}

/**
 * Resolve the ONE workspace a record is bound to, migrating the pre-path-key
 * `workspaces: string[]` shape on the way.
 *
 * A legacy key that authorized exactly one workspace maps onto the new address
 * unambiguously, so it survives with its plaintext intact. A key that authorized
 * several — or none that still canonicalizes — has no single `/mcp/<api-key>`
 * meaning, and guessing one would silently narrow or widen what its holder was
 * granted. Those records are dropped, i.e. revoked: the administrator re-creates
 * a key per workspace and re-points the client.
 */
function migrateWorkspace(r: Record<string, unknown>): string | null {
  if (typeof r.workspace === 'string') return canonicalizeWorkspacePath(r.workspace)
  if (!Array.isArray(r.workspaces)) return null
  const legacy = dedupe(
    r.workspaces
      .filter((w): w is string => typeof w === 'string')
      .map((w) => canonicalizeWorkspacePath(w))
      .filter((w): w is string => w !== null),
  )
  return legacy.length === 1 ? legacy[0] : null
}

function normalizeRecord(raw: unknown): McpApiKeyRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const id = typeof r.id === 'string' ? r.id : ''
  const salt = typeof r.salt === 'string' ? r.salt : ''
  const hash = typeof r.hash === 'string' ? r.hash : ''
  if (!id || !salt || !hash) return null
  // No workspace ⇒ the key cannot be addressed at all; drop it rather than keep an
  // inert record that would still appear in a roster. Said out loud, because from
  // the administrator's side this is a revocation they did not ask for.
  const workspace = migrateWorkspace(r)
  if (!workspace) {
    console.warn(
      `[c3] external MCP key ${displayPrefix(id)} has no single bound workspace — revoked. ` +
        'Create one key per workspace and re-point the client to its /mcp/<api-key> address.',
    )
    return null
  }
  const p = (r.params && typeof r.params === 'object' ? r.params : {}) as Record<string, unknown>
  const num = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback
  return {
    id,
    name: typeof r.name === 'string' ? r.name : '',
    createdAt: num(r.createdAt, 0),
    lastUsedAt: typeof r.lastUsedAt === 'number' && r.lastUsedAt > 0 ? r.lastUsedAt : null,
    workspace,
    // A pre-scope record predates per-key tool authorization; it gets exactly the
    // default set it effectively had, never a write tool and never a read tool
    // that was not grantable back then.
    tools: Array.isArray(r.tools)
      ? dedupe(r.tools.filter((t): t is string => typeof t === 'string'))
      : [...EXTERNAL_MCP_DEFAULT_TOOLS],
    hashVersion: num(r.hashVersion, 0),
    algo: typeof r.algo === 'string' ? r.algo : '',
    params: {
      N: num(p.N, SCRYPT_PARAMS.N),
      r: num(p.r, SCRYPT_PARAMS.r),
      p: num(p.p, SCRYPT_PARAMS.p),
      keylen: num(p.keylen, SCRYPT_PARAMS.keylen),
    },
    salt,
    hash,
  }
}

/** Normalize the persisted array, dropping unusable entries and duplicate ids. */
function normalizeRecords(raw: unknown): McpApiKeyRecord[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: McpApiKeyRecord[] = []
  for (const entry of raw) {
    const rec = normalizeRecord(entry)
    if (!rec || seen.has(rec.id)) continue
    seen.add(rec.id)
    out.push(rec)
  }
  return out
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)]
}

function load(): McpApiKeyRecord[] {
  if (cache) return cache
  cache = normalizeRecords(readFile()[FILE_KEY])
  return cache
}

/**
 * The owned key as it must appear on disk, read from a raw file snapshot. The
 * system-settings write path re-attaches this so a whole-object save preserves
 * the key store instead of wiping it.
 */
export function mcpApiKeyFileKeys(diskRaw: unknown): { mcpApiKeys?: McpApiKeyRecord[] } {
  const raw = (diskRaw && typeof diskRaw === 'object' ? diskRaw : {}) as McpApiKeyFileShape
  const records = normalizeRecords(raw[FILE_KEY])
  return records.length > 0 ? { mcpApiKeys: records } : {}
}

/**
 * Read-modify-write the owned key inside the cross-process settings lock, with a
 * fresh disk read, preserving every other settings key verbatim. Throws when the
 * write fails so callers surface a real error rather than a pseudo-success.
 */
function mutate<T>(apply: (records: McpApiKeyRecord[]) => T): T {
  return withFileLock(settingsFile(), () => {
    const raw = readFile()
    const records = normalizeRecords(raw[FILE_KEY])
    const result = apply(records)
    writeAtomic(settingsFile(), { ...raw, [FILE_KEY]: records })
    cache = records
    return result
  })
}

// ---- Plaintext key format ----

/** The plaintext key split into its non-secret id and its secret half. */
interface ParsedKey {
  id: string
  secret: string
}

const KEY_RE = new RegExp(`^${KEY_PREFIX}_([0-9a-f]{${ID_HEX_LEN}})_([A-Za-z0-9_-]{20,})$`)

/**
 * Split a presented key into `{ id, secret }`, or `null` when it is not even
 * shaped like one of ours. A malformed key is indistinguishable from an unknown
 * one to the caller — both are simply "not authenticated".
 */
export function parseMcpApiKey(raw: string): ParsedKey | null {
  const m = typeof raw === 'string' ? KEY_RE.exec(raw.trim()) : null
  return m ? { id: m[1], secret: m[2] } : null
}

/** The public, non-secret display prefix for a key id. */
function displayPrefix(id: string): string {
  return `${KEY_PREFIX}_${id}`
}

/** Project a stored record onto the wire-safe metadata (no salt, no hash). */
function toMeta(rec: McpApiKeyRecord): McpApiKeyInfo {
  return {
    id: rec.id,
    name: rec.name,
    createdAt: rec.createdAt,
    lastUsedAt: rec.lastUsedAt,
    workspace: rec.workspace,
    tools: [...rec.tools],
    displayPrefix: displayPrefix(rec.id),
  }
}

function deriveHash(
  secret: string,
  salt: Buffer,
  params: { N: number; r: number; p: number; keylen: number },
): Promise<Buffer> {
  return new Promise((res, rej) => {
    scrypt(
      secret,
      salt,
      params.keylen,
      // `maxmem` must cover 128 * N * r; the default 32 MiB is too tight the
      // moment N or r is raised, and an under-sized budget throws rather than
      // degrading — which would turn a valid key into an auth failure.
      { N: params.N, r: params.r, p: params.p, maxmem: 256 * params.N * params.r },
      (err, out) => (err ? rej(err) : res(out)),
    )
  })
}

// ---- Public operations ----

/** Every stored key's metadata, newest first. Never carries hash material. */
export function listMcpApiKeys(): McpApiKeyInfo[] {
  return [...load()].sort((a, b) => b.createdAt - a.createdAt).map(toMeta)
}

/**
 * One workspace's keys, newest first. The console never asks for a host-wide
 * roster: a key belongs to exactly one workspace, and that workspace's settings
 * page is the only place it is administered.
 */
export function listMcpApiKeysForWorkspace(canonicalWorkspace: string): McpApiKeyInfo[] {
  const wanted = canonicalizeWorkspacePath(canonicalWorkspace)
  if (!wanted) return []
  return listMcpApiKeys().filter((k) => k.workspace === wanted)
}

/** The result of a creation: the metadata plus the ONLY appearance of the plaintext. */
export interface CreatedMcpApiKey {
  meta: McpApiKeyInfo
  /** The plaintext key. Returned once, never stored, never recoverable. */
  key: string
}

/**
 * Mint a key bound to ONE workspace: 256 bits of CSPRNG secret behind a
 * non-secret id, hashed with a fresh per-key salt. `workspace` must already be an
 * absolute path the caller has checked against the workspace registry; a path
 * that does not canonicalize throws rather than storing an unaddressable key.
 *
 * `tools` is stored as given (de-duplicated). The CALLER decides the initial
 * scope — the settings handler forces the read-only set and ignores anything the
 * client proposed, so a forged default cannot reach this far.
 */
export async function createMcpApiKey(
  name: string,
  workspace: string,
  tools: readonly string[],
  now: number,
): Promise<CreatedMcpApiKey> {
  const canonical = canonicalizeWorkspacePath(workspace)
  if (!canonical) throw new Error('external MCP key needs one absolute workspace path')
  const id = randomBytes(ID_HEX_LEN / 2).toString('hex')
  const secret = randomBytes(SECRET_BYTES).toString('base64url')
  const salt = randomBytes(16)
  const hash = await deriveHash(secret, salt, SCRYPT_PARAMS)
  const record: McpApiKeyRecord = {
    id,
    name: name.trim() || displayPrefix(id),
    createdAt: now,
    lastUsedAt: null,
    workspace: canonical,
    tools: dedupe([...tools]),
    hashVersion: HASH_VERSION,
    algo: 'scrypt',
    params: { ...SCRYPT_PARAMS },
    salt: salt.toString('base64'),
    hash: hash.toString('base64'),
  }
  mutate((records) => {
    records.push(record)
  })
  return { meta: toMeta(record), key: `${KEY_PREFIX}_${id}_${secret}` }
}

/** Fields that may be patched on one key in a single atomic write. */
export interface McpApiKeyPatch {
  name?: string
  tools?: readonly string[]
}

function findRecordInWorkspace(
  records: McpApiKeyRecord[],
  id: string,
  canonicalWorkspace: string,
): McpApiKeyRecord | undefined {
  return records.find((r) => r.id === id && r.workspace === canonicalWorkspace)
}

/**
 * Replace a key's granted tool scope. An empty array is accepted and means "this
 * key may call nothing" — it is never read as a wildcard. Names are stored
 * verbatim (de-duplicated); catalog membership is the caller's check, because
 * this layer must not know which features exist. Returns the updated metadata,
 * or `null` when the id is unknown.
 *
 * The workspace binding is deliberately NOT updatable: an address means one
 * workspace for the life of the key.
 */
export function updateMcpApiKeyTools(id: string, tools: readonly string[]): McpApiKeyInfo | null {
  return mutate((records) => {
    const rec = records.find((r) => r.id === id)
    if (!rec) return null
    rec.tools = dedupe([...tools])
    return toMeta(rec)
  })
}

/** Rename a key (display only). Returns the updated metadata, or `null` when unknown. */
export function renameMcpApiKey(id: string, name: string): McpApiKeyInfo | null {
  return mutate((records) => {
    const rec = records.find((r) => r.id === id)
    if (!rec) return null
    rec.name = name.trim() || displayPrefix(rec.id)
    return toMeta(rec)
  })
}

/**
 * Patch a key's display name and/or tool scope in ONE workspace-scoped mutation.
 * Returns the updated metadata, or `null` when the id is unknown in that workspace.
 * Catalog validation is the caller's job; this layer stores the patch as given.
 */
export function updateMcpApiKeyInWorkspace(
  id: string,
  workspace: string,
  patch: McpApiKeyPatch,
): McpApiKeyInfo | null {
  const canonical = canonicalizeWorkspacePath(workspace)
  if (!canonical) return null
  return mutate((records) => {
    const rec = findRecordInWorkspace(records, id, canonical)
    if (!rec) return null
    if (patch.name !== undefined) {
      rec.name = patch.name.trim() || displayPrefix(rec.id)
    }
    if (patch.tools !== undefined) {
      rec.tools = dedupe([...patch.tools])
    }
    return toMeta(rec)
  })
}

/** Revoke (delete) a key. Returns true when a record was actually removed. */
export function revokeMcpApiKey(id: string): boolean {
  return mutate((records) => {
    const idx = records.findIndex((r) => r.id === id)
    if (idx < 0) return false
    records.splice(idx, 1)
    return true
  })
}

/**
 * Revoke (delete) a key bound to ONE workspace. Returns true when a record was
 * actually removed; `false` when the id is unknown in that workspace.
 */
export function revokeMcpApiKeyInWorkspace(id: string, workspace: string): boolean {
  const canonical = canonicalizeWorkspacePath(workspace)
  if (!canonical) return false
  return mutate((records) => {
    const idx = records.findIndex((r) => r.id === id && r.workspace === canonical)
    if (idx < 0) return false
    records.splice(idx, 1)
    return true
  })
}

/** A successful authentication: which key answered, and what it may reach. */
export interface AuthenticatedMcpApiKey {
  id: string
  /** The canonicalized absolute path this key is bound to. */
  workspace: string
  /** The tool names this key may call. Empty ⇒ nothing. */
  tools: string[]
}

/**
 * Verify a presented plaintext key against the CURRENT on-disk records.
 *
 * Deliberately re-reads rather than trusting any "known good" memo, so a revoked
 * key fails on its very next request. A malformed key, an unknown id, an
 * unsupported hash version and a hash mismatch all return `null` — the caller
 * cannot tell them apart, so the route cannot be used to probe which ids exist.
 */
export async function verifyMcpApiKey(raw: string): Promise<AuthenticatedMcpApiKey | null> {
  const parsed = parseMcpApiKey(raw)
  if (!parsed) return null
  // Bypass the cache: another process (or our own revoke) may have rewritten the
  // file since the last read, and "revocation is immediate" is a hard requirement.
  cache = null
  const rec = load().find((r) => r.id === parsed.id)
  if (!rec) return null
  if (rec.hashVersion !== HASH_VERSION || rec.algo !== 'scrypt') {
    console.warn(
      `[c3] external MCP key ${displayPrefix(rec.id)} uses an unsupported hash scheme — rejected`,
    )
    return null
  }
  let expected: Buffer
  let actual: Buffer
  try {
    expected = Buffer.from(rec.hash, 'base64')
    actual = await deriveHash(parsed.secret, Buffer.from(rec.salt, 'base64'), rec.params)
  } catch (err) {
    console.warn(
      `[c3] external MCP key ${displayPrefix(rec.id)} failed hash derivation: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    return null
  }
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null
  return { id: rec.id, workspace: rec.workspace, tools: [...rec.tools] }
}

/**
 * How coarse the recorded "last used" instant is. Every authenticated request
 * would otherwise take the cross-process settings lock to rewrite a timestamp;
 * a display-only field does not justify that write amplification, so a use is
 * only persisted once the stored value is at least this stale.
 */
const LAST_USED_GRANULARITY_MS = 60_000

/**
 * Record a successful use. Best-effort in both directions: it skips the write
 * when the stored value is recent enough, and a failed write is logged rather
 * than allowed to turn a valid authentication into a rejection.
 */
export function touchMcpApiKey(id: string, now: number): void {
  try {
    const current = load().find((r) => r.id === id)
    if (
      current &&
      current.lastUsedAt !== null &&
      now - current.lastUsedAt < LAST_USED_GRANULARITY_MS
    )
      return
    mutate((records) => {
      const rec = records.find((r) => r.id === id)
      if (rec) rec.lastUsedAt = now
    })
  } catch (err) {
    console.warn('[c3] failed to record external MCP key usage:', err)
  }
}
