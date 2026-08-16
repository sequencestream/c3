/**
 * Codex custom-model catalog tests (2026-08-08-013). The driver's relay branch
 * registers the CLI-launched third-party model in a local catalog
 * (`config.model_catalog_json`) so codex stops falling back to default metadata
 * for ids it does not know. These tests pin the generated entry shape + the
 * sandbox/host placement rule + the write→cleanup lifecycle.
 */
import { describe, it, expect } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeModelCatalogFile, cleanupModelCatalogFile } from './model-catalog.js'

interface CatalogEntry {
  slug: string
  display_name: string
  context_window?: number
  max_output_tokens?: number
  truncation_policy: { mode: string; limit: number }
  supported_reasoning_levels: Array<{ effort: string; description: string }>
  default_reasoning_level: string
  shell_type: string
  visibility: string
  supported_in_api: boolean
  priority: number
  support_verbosity: boolean
  supports_parallel_tool_calls: boolean
  experimental_supported_tools: unknown[]
  base_instructions: string
}

function readEntry(handle: { path: string }): CatalogEntry {
  const catalog = JSON.parse(readFileSync(handle.path, 'utf8')) as { models: CatalogEntry[] }
  return catalog.models[0]
}

describe('writeModelCatalogFile', () => {
  it('writes a parseable catalog whose slug is the model id and capabilities are mapped', () => {
    const handle = writeModelCatalogFile({
      modelId: 'deepseek-v4-flash',
      contextWindow: 65536,
      maxOutputTokens: 8192,
    })
    try {
      const entry = readEntry(handle)
      // Slug must equal the CLI model id — that is the exact key codex resolves.
      expect(entry.slug).toBe('deepseek-v4-flash')
      expect(entry.display_name).toBe('deepseek-v4-flash')
      expect(entry.context_window).toBe(65536)
      expect(entry.max_output_tokens).toBe(8192)
      // The serde-required scaffold that lets codex 0.147.0 parse the entry.
      expect(entry.shell_type).toBe('shell_command')
      expect(entry.visibility).toBe('list')
      expect(entry.supported_in_api).toBe(true)
      expect(entry.priority).toBe(1)
      expect(entry.support_verbosity).toBe(true)
      expect(entry.supports_parallel_tool_calls).toBe(true)
      expect(Array.isArray(entry.experimental_supported_tools)).toBe(true)
      expect(typeof entry.base_instructions).toBe('string')
      expect(entry.base_instructions.length).toBeGreaterThan(0)
      expect(entry.default_reasoning_level).toBe('medium')
    } finally {
      cleanupModelCatalogFile(handle)
    }
  })

  it('declares the full reasoning-effort union codex can request', () => {
    const handle = writeModelCatalogFile({ modelId: 'm' })
    try {
      const entry = readEntry(handle)
      const efforts = entry.supported_reasoning_levels.map((l) => l.effort)
      for (const level of ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']) {
        expect(efforts).toContain(level)
      }
    } finally {
      cleanupModelCatalogFile(handle)
    }
  })

  it('ties the truncation limit to the configured context window', () => {
    const handle = writeModelCatalogFile({ modelId: 'm', contextWindow: 131072 })
    try {
      expect(readEntry(handle).truncation_policy).toEqual({ mode: 'tokens', limit: 131072 })
    } finally {
      cleanupModelCatalogFile(handle)
    }
  })

  it('omits capability fields and uses the conservative truncation limit when unset', () => {
    const handle = writeModelCatalogFile({ modelId: 'm2' })
    try {
      const entry = readEntry(handle)
      expect(entry.context_window).toBeUndefined()
      expect(entry.max_output_tokens).toBeUndefined()
      expect(entry.truncation_policy).toEqual({ mode: 'tokens', limit: 128000 })
    } finally {
      cleanupModelCatalogFile(handle)
    }
  })

  it('places the catalog under sandboxTmpDir when provided (arapuca allow set)', () => {
    const sandboxTmpDir = mkdtempSync(join(tmpdir(), 'c3-sb-cat-'))
    const handle = writeModelCatalogFile({ modelId: 'm3', sandboxTmpDir })
    try {
      expect(handle.path.startsWith(sandboxTmpDir)).toBe(true)
      expect(handle.path.includes('model-catalog-')).toBe(true)
      expect(existsSync(handle.path)).toBe(true)
    } finally {
      cleanupModelCatalogFile(handle)
      rmSync(sandboxTmpDir, { recursive: true, force: true })
    }
  })

  it('host runs place the catalog under os.tmpdir()', () => {
    const handle = writeModelCatalogFile({ modelId: 'm4' })
    try {
      expect(handle.path.startsWith(tmpdir())).toBe(true)
      expect(handle.path.includes('c3-codex-catalog-')).toBe(true)
    } finally {
      cleanupModelCatalogFile(handle)
    }
  })
})

describe('cleanupModelCatalogFile', () => {
  it('removes the written dir and is a no-op for a null handle', () => {
    const handle = writeModelCatalogFile({ modelId: 'm5' })
    expect(existsSync(handle.path)).toBe(true)
    cleanupModelCatalogFile(handle)
    expect(existsSync(handle.path)).toBe(false)
    // Idempotent on an already-removed dir, and null-safe.
    expect(() => cleanupModelCatalogFile(handle)).not.toThrow()
    expect(() => cleanupModelCatalogFile(null)).not.toThrow()
  })
})
