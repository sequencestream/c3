/**
 * Where c3's on-disk data lives. A leaf module: it resolves paths and nothing else,
 * so every store that persists into the c3 home can import it without pulling in the
 * settings shape (and without an import cycle).
 *
 * Configuration itself is no longer a file — it lives in `c3.db`
 * (kernel/config/config-store.ts). What remains here is the *home directory* that
 * holds the db and everything anchored beside it (logs, intent worktrees, the sandbox
 * distribution), plus the paths of the legacy JSON files the one-shot import reads.
 *
 * Resolution order for the home dir: the `--db <path>` file's directory, then the
 * deprecated `--settings <path>` override's directory, then `C3_DIR`, then the
 * directory of a `C3_DB_PATH` file, then `~/.c3`.
 */
import { homedir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { dbPath, hasDbPathOverride } from '../infra/db.js'

/**
 * Deprecated settings-file path override (CLI `--settings <path>`). It no longer
 * decides where configuration is stored — that is the db's job — but it still names
 * the legacy `settings.json` to import and, when no `--db` is given, relocates the
 * home dir the way it always did, so an existing service unit keeps working.
 */
let settingsPathOverride: string | null = null

/**
 * Set the legacy settings.json path. Must be called before the first settings load
 * (the cli's `start` action does this).
 */
export function setSettingsPath(path: string): void {
  settingsPathOverride = resolve(path)
}

/** Whether `--settings` was given (the import path differs from the default home). */
export function hasSettingsPathOverride(): boolean {
  return settingsPathOverride !== null
}

/**
 * The resolved c3 home directory. Exposed so other domains anchor their on-disk data
 * under the same dir — notably intent worktrees, which must live somewhere the Docker
 * daemon can bind-mount (on macOS Docker Desktop that excludes `$TMPDIR`/`/var/folders`
 * but always includes the user's HOME). See features/intents/worktree.ts.
 */
export function c3HomeDir(): string {
  // An explicit `--db` wins over everything: it names the instance.
  if (hasDbPathOverride()) {
    const db = dbPath()
    if (db !== ':memory:') return dirname(db)
  }
  if (settingsPathOverride) return dirname(settingsPathOverride)
  if (process.env.C3_DIR) return resolve(process.env.C3_DIR)
  // Otherwise follow wherever the db resolved to (`C3_DB_PATH`, or the default),
  // so the home and the database can never end up in two different places.
  const db = dbPath()
  if (db !== ':memory:') return dirname(db)
  return join(homedir(), '.c3')
}

/**
 * The legacy `settings.json`, read once by the import and never written again.
 * Kept as a function (not a constant) because `--settings` may relocate it.
 */
export function legacySettingsFile(): string {
  return settingsPathOverride ?? join(c3HomeDir(), 'settings.json')
}

/** The legacy session→agent binding state file (a sibling of settings.json). */
export function legacyStateFile(): string {
  return join(c3HomeDir(), 'state.json')
}
