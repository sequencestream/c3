/**
 * The authorization-policy epoch — ONE global counter that answers "has any
 * authorization input changed since this session was pinned?".
 *
 * It lives in `system_configs` rather than in memory because the answer must
 * survive a restart: an external MCP session id is client-held, and a process
 * that came back with a zeroed counter would accept a tuple it should refuse.
 *
 * Deliberately GLOBAL, not per-subject. A narrower counter would need every
 * mutation site to classify *whose* authority it touched, and a mis-classified
 * mutation is a session that keeps privileges it lost. One counter makes the
 * freshness boundary auditable at the cost of disconnecting unrelated external
 * clients after an unrelated policy edit — they re-initialize and continue.
 *
 * What bumps it: workspace ACL writes, account-roster/admin changes, workspace
 * registry changes (they widen an effective `all` scope), and per-key tool
 * authorization changes. What does NOT: display names and last-used timestamps —
 * they carry no authority, and bumping on them would evict every session on a
 * rename.
 *
 * {@link bumpPolicyEpoch} is written to be called INSIDE the caller's
 * transaction: `configTx` is re-entrant, so the bump and the policy row it
 * describes commit together or not at all. A rolled-back mutation therefore
 * never publishes an epoch, and no session is revoked by a write that failed.
 */
import { POLICY_EPOCH_KEY } from './config-schema.js'
import { configTx, readKey, writeScope } from './config-store.js'

/** The epoch a database with no stored counter reports. */
const INITIAL_EPOCH = 0

/**
 * The current epoch. An absent, unparsable or negative row reads as
 * {@link INITIAL_EPOCH} — the value a fresh database has — so a corrupt row can
 * only ever make sessions look STALE (the next bump exceeds it), never fresh.
 */
export function readPolicyEpoch(): number {
  const row = readKey({ kind: 'system' }, POLICY_EPOCH_KEY)
  const parsed = row?.value == null ? NaN : Number(row.value)
  return Number.isFinite(parsed) && parsed > INITIAL_EPOCH ? Math.floor(parsed) : INITIAL_EPOCH
}

/**
 * Advance the epoch by one and return the new value. Joins the caller's
 * transaction when there is one, so "the policy changed" and "the world can
 * observe it changed" are the same commit.
 *
 * Patching (`replace: false`) is essential: the system scope also holds every
 * `SystemSettings` field, and a replacing write here would delete all of them.
 */
export function bumpPolicyEpoch(): number {
  return configTx(() => {
    const next = readPolicyEpoch() + 1
    writeScope(
      { kind: 'system' },
      [{ key: POLICY_EPOCH_KEY, value: String(next), type: 'number' }],
      { replace: false },
    )
    return next
  })
}
