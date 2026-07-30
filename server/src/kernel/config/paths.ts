/**
 * Where the on-disk configuration lives. A leaf module: it resolves paths and
 * nothing else, so every store that persists into the c3 config dir can import it
 * without pulling in the settings shape (and without an import cycle).
 *
 * Resolution order for the config dir: an explicit `--settings <path>` override
 * (its parent dir), then `C3_DIR`, then `~/.c3`.
 */
import { homedir } from 'node:os'
import { join, dirname, resolve } from 'node:path'

/**
 * Explicit settings-file path override (CLI `--settings <path>`), set once at
 * startup before any load. When set, it is the exact settings.json path and its
 * directory also holds `state.json` — so the whole c3 config dir is relocated.
 * Lets an isolated launch (e.g. e2e) point at its own auth-free settings without
 * touching the real `~/.c3`. Mirrors the `C3_DIR` override already honored by
 * the db layer (kernel/infra/db.ts).
 */
let settingsPathOverride: string | null = null

/**
 * Set the settings.json path used for all subsequent loads/saves. Must be called
 * before the first settings load (the cli's `start` action does this).
 */
export function setSettingsPath(path: string): void {
  settingsPathOverride = resolve(path)
}

/**
 * The resolved c3 home directory (honoring `--settings` / `C3_DIR` / default
 * `~/.c3`). Exposed so other domains anchor their on-disk data under the same
 * dir — notably intent worktrees, which must live somewhere the Docker daemon
 * can bind-mount (on macOS Docker Desktop that excludes `$TMPDIR`/`/var/folders`
 * but always includes the user's HOME). See features/intents/worktree.ts.
 */
export function c3HomeDir(): string {
  if (settingsPathOverride) return dirname(settingsPathOverride)
  if (process.env.C3_DIR) return resolve(process.env.C3_DIR)
  return join(homedir(), '.c3')
}

/** The settings.json file every settings-file store reads and writes. */
export function settingsFile(): string {
  return settingsPathOverride ?? join(c3HomeDir(), 'settings.json')
}

/** The session→agent binding state file (a sibling of settings.json). */
export function stateFile(): string {
  return join(c3HomeDir(), 'state.json')
}
