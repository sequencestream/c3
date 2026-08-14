/**
 * Long-lived external-MCP API key store — the credential the public `POST /mcp`
 * route authenticates with as `Authorization: Bearer c3k_…`.
 *
 * A key is an OWNED capability, not a workspace grant. Two fields are therefore
 * NOT NULL invariants of a usable record:
 *  - `ownerSubject` — whose authority the key borrows. What the key can reach is
 *    the intersection of that owner's administrator-managed workspace scope with
 *    the key's own; the key itself confers no workspace. A record without a
 *    trustworthy owner is unusable by construction, because there is no authority
 *    to intersect with and inventing one would be minting access.
 *  - `secretVersion` — which generation of the secret a live session was pinned
 *    to, so replacing a secret invalidates sessions opened under the old one
 *    rather than leaving them running against a credential that no longer exists.
 *
 * `workspaceName` survives as the record's ADMINISTERING page — which workspace
 * settings tab lists it — and is deliberately not an authorization input: page
 * context cannot confer access to the workspace whose page it is.
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
import { fromEntries, toEntries } from './config-codec.js'
import { MCP_KEY_RULES } from './config-schema.js'
import { configTx, listScopeOwners, readAllScopes, writeScope } from './config-store.js'
import { bumpPolicyEpoch } from './policy-epoch.js'
import {
  findWorkspaceByName,
  findWorkspaceByPath,
  listAllWorkspaceRows,
} from './workspace-store.js'

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
 * material.
 */
export interface McpApiKeyInfo {
  id: string
  name: string
  createdAt: number
  lastUsedAt: number | null
  /** Whose authority this key borrows. Immutable, never empty. */
  ownerSubject: string
  /** Which generation of the secret is current. Starts at 1, positive integer. */
  secretVersion: number
  /** The workspace settings page that administers this key. NOT an authorization. */
  workspaceName: string
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
  ownerSubject: string
  secretVersion: number
  workspaceName: string
  tools: string[]
  hashVersion: number
  algo: string
  params: { N: number; r: number; p: number; keylen: number }
  /** base64 random salt, unique per key. */
  salt: string
  /** base64 `scrypt(secret, salt, params)`. */
  hash: string
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

/**
 * Read every stored key record (cache-bypassing). One scope per key id, so a record
 * is addressable on its own: revoking one deletes its scope instead of rewriting the
 * whole collection, and touching `lastUsedAt` updates a single row.
 */
function readStored(): McpApiKeyRecord[] {
  const raw: unknown[] = []
  for (const [id, entries] of readAllScopes('mcpKey')) {
    raw.push({ id, ...(fromEntries(entries, MCP_KEY_RULES) as Record<string, unknown>) })
  }
  return normalizeRecords(raw)
}

/**
 * Resolve the workspace whose settings page administers a record.
 *
 * A record that names no workspace c3 still has cannot be listed, re-scoped or
 * revoked from any page, so it is dropped rather than kept as an unreachable
 * roster entry. The registry keeps deregistered rows, so this only fires when the
 * workspace was erased outright.
 */
function resolveAdministeringWorkspace(r: Record<string, unknown>): string | null {
  if (typeof r.workspaceName === 'string') return findWorkspaceByName(r.workspaceName)?.name ?? null
  if (typeof r.workspace === 'string') {
    const direct = findWorkspaceByPath(r.workspace)
    if (direct) return direct.name
    const canonical = canonicalizeWorkspacePath(r.workspace)
    return canonical
      ? (listAllWorkspaceRows().find((w) => canonicalizeWorkspacePath(w.path) === canonical)
          ?.name ?? null)
      : null
  }
  return null
}

/** A non-empty owner subject, or `null` — the NOT NULL half of an owned key. */
function readOwnerSubject(raw: unknown): string | null {
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  return trimmed.length > 0 ? trimmed : null
}

/** A positive integer secret version, or `null`. Version 0 is not a generation. */
function readSecretVersion(raw: unknown): number | null {
  const value = typeof raw === 'number' ? raw : Number(raw)
  return Number.isInteger(value) && value > 0 ? value : null
}

function normalizeRecord(raw: unknown): McpApiKeyRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const id = typeof r.id === 'string' ? r.id : ''
  const salt = typeof r.salt === 'string' ? r.salt : ''
  const hash = typeof r.hash === 'string' ? r.hash : ''
  if (!id || !salt || !hash) return null
  // No owner ⇒ there is no authority to intersect with, and picking one would be
  // minting access nobody granted. No secret version ⇒ a session could never be
  // told apart from one opened before a rotation. Either way the record is not a
  // usable key; it is dropped, i.e. revoked. Said out loud, because from the
  // administrator's side this is a revocation they did not ask for.
  const ownerSubject = readOwnerSubject(r.ownerSubject)
  const secretVersion = readSecretVersion(r.secretVersion)
  if (!ownerSubject || !secretVersion) {
    console.warn(
      `[c3] external MCP key ${displayPrefix(id)} has no owner or secret version — revoked. ` +
        'Create a new key and re-point the client to POST /mcp with a bearer token.',
    )
    return null
  }
  const workspace = resolveAdministeringWorkspace(r)
  if (!workspace) {
    console.warn(
      `[c3] external MCP key ${displayPrefix(id)} names no workspace that still exists — revoked.`,
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
    ownerSubject,
    secretVersion,
    workspaceName: workspace,
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
  cache = readStored()
  return cache
}

/**
 * Read-modify-write the key collection in one transaction with a fresh read. Records
 * the caller dropped have their scope deleted; the rest are rewritten. Throws when the
 * write fails so callers surface a real error rather than a pseudo-success.
 */
function mutate<T>(apply: (records: McpApiKeyRecord[]) => T): T {
  return configTx(() => {
    const records = readStored()
    const before = new Set(records.map((r) => r.id))
    const result = apply(records)
    for (const record of records) {
      const { id, ...fields } = record
      writeScope({ kind: 'mcpKey', owner: id }, toEntries(fields, MCP_KEY_RULES))
      before.delete(id)
    }
    for (const id of before) writeScope({ kind: 'mcpKey', owner: id }, [])
    cache = records
    return result
  })
}

/** Ids of every stored key (diagnostics; the records themselves go through {@link load}). */
export function listMcpApiKeyIds(): string[] {
  return listScopeOwners('mcpKey')
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
    ownerSubject: rec.ownerSubject,
    secretVersion: rec.secretVersion,
    workspaceName: rec.workspaceName,
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
export function listMcpApiKeysForWorkspace(workspaceName: string): McpApiKeyInfo[] {
  return listMcpApiKeys().filter((k) => k.workspaceName === workspaceName)
}

/** The result of a creation: the metadata plus the ONLY appearance of the plaintext. */
export interface CreatedMcpApiKey {
  meta: McpApiKeyInfo
  /** The plaintext key. Returned once, never stored, never recoverable. */
  key: string
}

/**
 * Mint an OWNED key: 256 bits of CSPRNG secret behind a non-secret id, hashed
 * with a fresh per-key salt, starting at secret version 1.
 *
 * `ownerSubject` is checked here and not only at the call site, so a bypassed
 * store cannot produce the one record shape the authorization gate has no way to
 * evaluate. `workspaceName` only decides which settings page administers the key
 * and must name a workspace the registry knows; it grants nothing.
 *
 * `tools` is stored as given (de-duplicated). The CALLER decides the initial
 * scope — the settings handler forces the read-only set and ignores anything the
 * client proposed, so a forged default cannot reach this far.
 */
export async function createMcpApiKey(
  name: string,
  workspaceName: string,
  ownerSubject: string,
  tools: readonly string[],
  now: number,
): Promise<CreatedMcpApiKey> {
  const workspace = findWorkspaceByName(workspaceName)
  if (!workspace) throw new Error('external MCP key needs one known workspace name')
  const owner = readOwnerSubject(ownerSubject)
  if (!owner) throw new Error('external MCP key needs a non-empty owner subject')
  const id = randomBytes(ID_HEX_LEN / 2).toString('hex')
  const secret = randomBytes(SECRET_BYTES).toString('base64url')
  const salt = randomBytes(16)
  const hash = await deriveHash(secret, salt, SCRYPT_PARAMS)
  const record: McpApiKeyRecord = {
    id,
    name: name.trim() || displayPrefix(id),
    createdAt: now,
    lastUsedAt: null,
    ownerSubject: owner,
    secretVersion: 1,
    workspaceName: workspace.name,
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
  return records.find((r) => r.id === id && r.workspaceName === canonicalWorkspace)
}

/**
 * Replace a key's granted tool scope. An empty array is accepted and means "this
 * key may call nothing" — it is never read as a wildcard. Names are stored
 * verbatim (de-duplicated); catalog membership is the caller's check, because
 * this layer must not know which features exist. Returns the updated metadata,
 * or `null` when the id is unknown.
 *
 * A tool grant is authorization, so the epoch advances in the SAME transaction:
 * a live session pinned to the old epoch stops being usable at the instant the
 * new scope becomes readable, not whenever a teardown happens to succeed.
 *
 * Owner, secret version and administering workspace are deliberately NOT
 * updatable here — reassigning an owner would silently re-aim a credential
 * someone else holds.
 */
export function updateMcpApiKeyTools(id: string, tools: readonly string[]): McpApiKeyInfo | null {
  return mutate((records) => {
    const rec = records.find((r) => r.id === id)
    if (!rec) return null
    rec.tools = dedupe([...tools])
    bumpPolicyEpoch()
    return toMeta(rec)
  })
}

/**
 * Rotate a key's secret in place: a fresh secret, a fresh salt, and the next
 * version, all in the transaction that replaces the hash. Returns the new
 * plaintext (its only appearance) plus the updated metadata, or `null` when the
 * id is unknown.
 *
 * Rotation does not bump the policy epoch — no authority changed. The version
 * itself is the invalidation signal: sessions pinned to the previous generation
 * fail their tuple comparison on the next request.
 */
export async function replaceMcpApiKeySecret(id: string): Promise<CreatedMcpApiKey | null> {
  const current = load().find((r) => r.id === id)
  if (!current) return null
  const secret = randomBytes(SECRET_BYTES).toString('base64url')
  const salt = randomBytes(16)
  const hash = await deriveHash(secret, salt, SCRYPT_PARAMS)
  const meta = mutate((records) => {
    // Re-find inside the transaction: the record may have been revoked between the
    // read above and the derivation, and reviving it would resurrect a dead key.
    const rec = records.find((r) => r.id === id)
    if (!rec) return null
    rec.secretVersion += 1
    rec.hashVersion = HASH_VERSION
    rec.algo = 'scrypt'
    rec.params = { ...SCRYPT_PARAMS }
    rec.salt = salt.toString('base64')
    rec.hash = hash.toString('base64')
    return toMeta(rec)
  })
  return meta ? { meta, key: `${KEY_PREFIX}_${id}_${secret}` } : null
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
 *
 * Only the tool scope advances the epoch. A rename carries no authority, and
 * evicting every external session because someone fixed a typo would make the
 * invalidation signal too noisy to trust.
 */
export function updateMcpApiKeyInWorkspace(
  id: string,
  workspaceName: string,
  patch: McpApiKeyPatch,
): McpApiKeyInfo | null {
  return mutate((records) => {
    const rec = findRecordInWorkspace(records, id, workspaceName)
    if (!rec) return null
    if (patch.name !== undefined) {
      rec.name = patch.name.trim() || displayPrefix(rec.id)
    }
    if (patch.tools !== undefined) {
      rec.tools = dedupe([...patch.tools])
      bumpPolicyEpoch()
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
export function revokeMcpApiKeyInWorkspace(id: string, workspaceName: string): boolean {
  return mutate((records) => {
    const idx = records.findIndex((r) => r.id === id && r.workspaceName === workspaceName)
    if (idx < 0) return false
    records.splice(idx, 1)
    return true
  })
}

/**
 * A successful authentication: which key answered, whose authority it borrows,
 * and which secret generation answered. It carries NO workspace — what the key
 * may reach is decided by intersecting its owner's scope with the workspace the
 * caller selected, which is the authorization layer's job, not the store's.
 */
export interface AuthenticatedMcpApiKey {
  id: string
  /** Whose administrator-managed scope limits this key. Never empty. */
  ownerSubject: string
  /** The generation of the secret that verified. Positive. */
  secretVersion: number
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
  return {
    id: rec.id,
    ownerSubject: rec.ownerSubject,
    secretVersion: rec.secretVersion,
    tools: [...rec.tools],
  }
}

/**
 * Delete every stored key scope that fails the owner / secret-version
 * invariants — the records written before keys became owned capabilities.
 *
 * They are revoked, not repaired. There is no record of who created them, so
 * assigning them to the administrator would hand a live credential authority its
 * holder was never granted; keeping their old single-workspace binding would keep
 * exactly the model this replaced. Returns the ids it removed so the caller can
 * report them.
 *
 * Idempotent by construction rather than by a migration marker: after this
 * change no path can create an ownerless record, so a second pass finds nothing.
 * Running it on every boot also covers a database hand-edited between runs.
 */
export function revokeUnownedMcpApiKeys(): string[] {
  const removed: string[] = []
  configTx(() => {
    for (const [id, entries] of readAllScopes('mcpKey')) {
      const fields = fromEntries(entries, MCP_KEY_RULES) as Record<string, unknown>
      if (readOwnerSubject(fields.ownerSubject) && readSecretVersion(fields.secretVersion)) continue
      writeScope({ kind: 'mcpKey', owner: id }, [])
      removed.push(id)
    }
  })
  if (removed.length > 0) {
    cache = null
    console.warn(
      `[c3] revoked ${removed.length} external MCP key(s) without an owner or secret version: ` +
        `${removed.map(displayPrefix).join(', ')}. Create new keys and re-point the clients.`,
    )
  }
  return removed
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
