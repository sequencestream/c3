/**
 * Codex custom-model catalog generation (2026-08-08-013). codex's bundled
 * model-metadata catalog does not know third-party model ids (e.g.
 * `deepseek-v4-flash`), so every relay run of a custom model prints
 * `Model metadata for <id> not found. Defaulting to fallback metadata` and
 * assembles the model with default capabilities — context window / output
 * limits that do not match the real model, and (worse) a code-execution tool
 * surface that can make c3's mounted MCP tools report "unsupported call".
 *
 * codex registers an unknown model only through a local model catalog
 * (`config.model_catalog_json`); the top-level `model_context_window` config key
 * merely declares a window without registering the id (verified against the
 * locked 0.146.0 binary — the warning persists). This module turns the user's
 * optional capability fields into the minimal legal catalog entry and writes it
 * to a per-run temp location, mirroring image-files' write/cleanup pair.
 *
 * VERSION GATE (0.146.0): the required scaffold-field set below is the
 * serde-required snapshot of codex 0.146.0's catalog entry, discovered by
 * feeding partial entries to the locked binary and reading the `missing field`
 * errors until one parsed. A codex upgrade may add/rename required fields —
 * re-run that drill per doc/architecture/sdk-upgrade/ when upgrading. A parse
 * failure surfaces as an explicit codex startup error, never silent degradation.
 *
 * Non-goal: persistence. The file lives only for the run; {@link cleanupModelCatalogFile}
 * runs in the driver's `finally` (success, error, or abort) so nothing leaks.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The reasoning-effort set to declare. Mirrors the 0.146.0 bundled catalog's
 * union across models (verified via `codex debug models`): every level codex can
 * request (`model_reasoning_effort`) must be present for the model. c3's driver
 * never sets an effort, so this is forward-safety, not a runtime knob.
 */
const SUPPORTED_REASONING_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(
  (effort) => ({ effort, description: effort }),
)

/**
 * Conservative default for the catalog entry's `truncation_policy.limit` when no
 * `contextWindow` is configured. Kept modest so codex does not truncate above the
 * model's real window; the user should set `contextWindow` to the model's actual
 * capacity.
 */
const DEFAULT_TRUNCATION_LIMIT = 128_000

/** A written model catalog: the owning temp dir + the catalog file path. */
export interface ModelCatalogFile {
  /** The temp directory holding the catalog (removed wholesale by {@link cleanupModelCatalogFile}). */
  readonly dir: string
  /** Absolute path of the catalog JSON — the value of `config.model_catalog_json`. */
  readonly path: string
}

/**
 * Write the minimal legal catalog entry for `modelId` into a fresh temp dir and
 * return the dir + file path. Placement follows the sandbox/host split:
 *
 *  - `sandboxTmpDir` present ⇒ the arapuca allow-set rw temp dir (the catalog is
 *    read by the sandboxed codex process at startup; the host `os.tmpdir()` is
 *    outside arapuca's allow set, so a file there would fail the run).
 *  - otherwise ⇒ host `os.tmpdir()`, the same mkdtemp pattern image-files uses.
 *
 * `contextWindow` / `maxOutputTokens` map to the optional entry fields; everything
 * else is the conservative serde-required scaffold. Never returns null — the
 * caller decides whether a catalog is needed at all.
 */
export function writeModelCatalogFile(opts: {
  modelId: string
  contextWindow?: number
  maxOutputTokens?: number
  sandboxTmpDir?: string
}): ModelCatalogFile {
  const dir = opts.sandboxTmpDir
    ? mkdtempSync(join(opts.sandboxTmpDir, 'model-catalog-'))
    : mkdtempSync(join(tmpdir(), 'c3-codex-catalog-'))
  const limit = opts.contextWindow ?? DEFAULT_TRUNCATION_LIMIT
  const entry = {
    slug: opts.modelId,
    display_name: opts.modelId,
    // Optional fields ride alongside the required scaffold; a short description
    // keeps the entry self-explanatory without pulling in an external catalog.
    description: `Custom model id registered by c3 (${opts.modelId})`,
    default_reasoning_level: 'medium',
    supported_reasoning_levels: SUPPORTED_REASONING_LEVELS,
    shell_type: 'shell_command',
    visibility: 'list',
    supported_in_api: true,
    priority: 1,
    support_verbosity: true,
    truncation_policy: { mode: 'tokens', limit },
    supports_parallel_tool_calls: true,
    experimental_supported_tools: [],
    ...(opts.contextWindow !== undefined ? { context_window: opts.contextWindow } : {}),
    ...(opts.maxOutputTokens !== undefined ? { max_output_tokens: opts.maxOutputTokens } : {}),
    base_instructions:
      'You are Codex, an AI coding assistant. You and the user share one workspace; ' +
      'collaborate until their goal is genuinely handled.',
  }
  const path = join(dir, 'catalog.json')
  // Serializing a codex catalog to DISK is not a wire frame — it is the same
  // disk-persistence job as the config/infra stores, not transport serialization.
  // eslint-disable-next-line no-restricted-syntax
  writeFileSync(path, JSON.stringify({ models: [entry] }, null, 2))
  return { dir, path }
}

/**
 * Remove the temp directory created by {@link writeModelCatalogFile}. Best-effort
 * and idempotent: a `null` handle is a no-op, and an already-missing dir does not
 * throw (`force`). Safe to call exactly once per run end. In a sandboxed run the
 * directory sits inside `sandboxTmpDir`, which `launchSandbox`'s `cleanup()`
 * removes anyway — this is the belt-and-braces second half.
 */
export function cleanupModelCatalogFile(handle: ModelCatalogFile | null): void {
  if (!handle) return
  rmSync(handle.dir, { recursive: true, force: true })
}
