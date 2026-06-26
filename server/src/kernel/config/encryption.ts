/**
 * At-rest encryption for agent secrets (apiKey). Obfuscation-grade only: the goal
 * is to keep upstream model keys out of a plaintext settings.json so an accidental
 * leak (misdirected file, backup, shared machine, logs) doesn't directly hand over
 * the key. It is NOT a defense against someone who has the c3 binary — the combined
 * key is embedded and statically extractable by design (accepted trade-off).
 *
 * Wire format of an encrypted secret:
 *   `c3secretvN:` + base64url(IV ‖ ciphertext ‖ authTag)
 *     - `c3secretvN:` — literal prefix carrying the key version (`v1` today).
 *     - IV  — 12 random bytes (fresh per encryption ⇒ same plaintext, different ciphertext).
 *     - ciphertext — AES-256-GCM output.
 *     - authTag — 16-byte GCM tag (tamper / wrong-key detection).
 *
 * Multi-version contract: the prefix names the key version so future rotations can
 * add `v2`, `v3`, … each with its own embedded key. `encryptSecret` always writes
 * the latest version; `decryptSecret` dispatches by the stored version. A
 * `c3secret`-prefixed token whose version we don't recognize is an ERROR (never
 * treated as plaintext). A value WITHOUT the `c3secret` prefix is legacy plaintext
 * and is returned verbatim (lazy migration: it gets encrypted on the next save).
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { SystemSettings, AgentConfig } from '@ccc/shared/protocol'

/** Literal token namespace. Any stored value starting with this is a c3 secret. */
const SECRET_NAMESPACE = 'c3secret'
/** AES-GCM IV length in bytes (96-bit nonce — the GCM standard). */
const IV_LEN = 12
/** AES-GCM authentication tag length in bytes (128-bit). */
const TAG_LEN = 16

/**
 * Build the v1 combined key (32 bytes for AES-256-GCM). The key material is
 * assembled at runtime by XOR-folding several compile-time constant shards, so the
 * full key never appears as one contiguous literal in the binary. This raises the
 * bar on static extraction; it does not make extraction impossible (see file doc).
 */
function buildKeyV1(): Buffer {
  // Three 32-byte shards. XOR-folded into the effective key; spread across the
  // module so no single shard is the key. Obfuscation budget only.
  const shardA = Buffer.from(
    '7b1c4af93e62d50819a7c3f4e0b29d6c54871af2db390e6c25a7f10934bd8e72',
    'hex',
  )
  const shardB = Buffer.from(
    '2f9a08e1c47b36d5a01e9f23748cb6d0193ae7f25c0d8b41ef6273a9c108d54b',
    'hex',
  )
  const shardC = Buffer.from(
    'c4e371a6082f9bd34e57c10ab9f6234d7a8e0c5193b27f6a04ec8d3915ba62c08',
    'hex',
  )
  const key = Buffer.alloc(32)
  for (let i = 0; i < 32; i++) key[i] = shardA[i] ^ shardB[i] ^ shardC[i]
  return key
}

/** Per-version embedded keys. New versions append here; old versions stay for decrypt. */
const KEYS: Record<string, Buffer> = {
  v1: buildKeyV1(),
}

/** The version `encryptSecret` writes with — always the latest. */
const CURRENT_VERSION = 'v1'

/**
 * Encrypt a plaintext secret. An empty string is returned verbatim (`''`) — empty
 * apiKey means "use the vendor CLI's own config" (system mode) and must not gain a
 * prefix. A non-empty secret becomes `c3secret<version>:` + base64url(IV‖ct‖tag),
 * always with the current version key and a fresh random IV.
 */
export function encryptSecret(plain: string): string {
  if (plain === '') return ''
  const key = KEYS[CURRENT_VERSION]
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  const body = Buffer.concat([iv, ciphertext, tag]).toString('base64url')
  return `${SECRET_NAMESPACE}${CURRENT_VERSION}:${body}`
}

/**
 * Decrypt a stored secret back to plaintext.
 * - No `c3secret` prefix ⇒ legacy plaintext: returned verbatim (also covers `''`).
 * - `c3secret<version>:` with a KNOWN version ⇒ GCM-decrypt; a failed tag (tamper
 *   or wrong key) THROWS — never returns a wrong plaintext silently.
 * - `c3secret`-prefixed but UNKNOWN/malformed version ⇒ THROWS (not treated as plaintext).
 */
export function decryptSecret(stored: string): string {
  if (!stored.startsWith(SECRET_NAMESPACE)) return stored // legacy plaintext passthrough
  const sep = stored.indexOf(':')
  if (sep < 0) throw new Error('malformed c3secret token: missing version separator')
  const version = stored.slice(SECRET_NAMESPACE.length, sep)
  const key = KEYS[version]
  if (!key) throw new Error(`unknown c3secret key version: ${version || '(empty)'}`)
  const body = Buffer.from(stored.slice(sep + 1), 'base64url')
  if (body.length < IV_LEN + TAG_LEN) throw new Error('malformed c3secret token: body too short')
  const iv = body.subarray(0, IV_LEN)
  const tag = body.subarray(body.length - TAG_LEN)
  const ciphertext = body.subarray(IV_LEN, body.length - TAG_LEN)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  // `final()` throws if the GCM tag doesn't verify — propagate, never swallow.
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

/**
 * Return a copy of `s` with every agent's non-empty `apiKey` encrypted (the
 * disk-write step). Empty apiKeys are left untouched (no prefix). Does NOT mutate
 * the input — the in-memory cache must keep plaintext.
 */
export function encryptAgentApiKeys(s: SystemSettings): SystemSettings {
  const agents = s.agents.map((a): AgentConfig => {
    const apiKey = a.config.apiKey
    if (!apiKey) return a
    return { ...a, config: { ...a.config, apiKey: encryptSecret(apiKey) } } as AgentConfig
  })
  return { ...s, agents }
}

/**
 * Decrypt every agent's `apiKey` in-place on a raw (pre-normalize) settings record
 * read from disk — the disk-read step, run before `normalize`/`migrateAgentCandidate`
 * consume the record. Handles both new-shape (`agent.config.apiKey`) and legacy-flat
 * (`agent.apiKey` at top level, always plaintext ⇒ passthrough). Legacy plaintext
 * survives untouched and is upgraded to ciphertext on the next save (lazy migration).
 */
export function decryptAgentApiKeys(raw: Partial<SystemSettings>): void {
  const agents = (raw as { agents?: unknown }).agents
  if (!Array.isArray(agents)) return
  for (const a of agents) {
    if (!a || typeof a !== 'object') continue
    const rec = a as Record<string, unknown>
    const configSrc =
      rec.config && typeof rec.config === 'object' ? (rec.config as Record<string, unknown>) : rec
    const apiKey = configSrc.apiKey
    if (typeof apiKey === 'string' && apiKey !== '') {
      configSrc.apiKey = decryptSecret(apiKey)
    }
  }
}
